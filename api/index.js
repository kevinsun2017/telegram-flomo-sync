// api/index.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
 
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
 
// 配置常量
const MAX_IMAGES = 9;
const DEBOUNCE_TIME = 2000;           // 多图聚合等待时间
const MAX_CONTENT = 4500;             // flomo 安全阈值
const mediaGroupCache = new Map();    // 多图聚合缓存
const REQUEST_TIMEOUTS = {
  TELEGRAM_API: 5000,
  IMAGE_DOWNLOAD: 6000,
  CLOUDINARY_UPLOAD: 8000,
  FLOMO_API: 6000
};
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;
 
// 定时清理过期缓存，防止内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of mediaGroupCache) {
    if (now - item.createdAt > 60000) { // 60秒过期
      mediaGroupCache.delete(id);
      console.debug(`过期缓存清理: ${id}`);
    }
  }
}, 60000);
 
/**
 * 带重试机制的 axios 请求
 */
async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios(url, {
        ...options,
        timeout: options.timeout || REQUEST_TIMEOUTS.IMAGE_DOWNLOAD
      });
    } catch (error) {
      if (i === retries) throw error;
      console.warn(`请求失败，${RETRY_DELAY}ms后重试 (${i + 1}/${retries}):`, error.message);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (i + 1)));
    }
  }
  // 确保函数总是有返回值
  throw new Error('所有重试都失败');
}
 
/**
 * 获取图片公网链接：优先 Cloudinary，失败降级 Telegram 临时链接
 */
async function getImageUrl(fileId) {
  let tgUrl = '';
  try {
    console.debug('开始处理 file_id:', fileId);
 
    const fileRes = await fetchWithRetry(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
      { timeout: REQUEST_TIMEOUTS.TELEGRAM_API }
    );
    const path = fileRes.data.result.file_path;
 
    if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(path)) {
      console.debug('非图片格式，跳过:', path);
      return '';
    }
 
    tgUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`;
    console.debug('TG 文件路径:', path);
 
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_UPLOAD_PRESET) {
      console.error('❌ Cloudinary 环境变量缺失:', {
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET
      });
      return tgUrl;
    }
 
    console.debug('开始下载图片流...');
    const imgStream = await fetchWithRetry(tgUrl, {
      responseType: 'stream',
      timeout: REQUEST_TIMEOUTS.IMAGE_DOWNLOAD
    });
    console.debug('图片流下载完成');
 
    const uploadUrl = `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`;
 
    const form = new FormData();
    form.append('file', imgStream.data);
    form.append('upload_preset', process.env.CLOUDINARY_UPLOAD_PRESET);
    form.append('resource_type', 'image');
 
    console.debug('开始上传 Cloudinary...');
    const res = await axios.post(uploadUrl, form, {
      headers: { ...form.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: REQUEST_TIMEOUTS.CLOUDINARY_UPLOAD
    });
    console.debug('Cloudinary Uploaded');
 
    const url = res.data.secure_url;
    if (url) {
      console.info('✅ Cloudinary Uploaded:', url);
      return url;
    }
    throw new Error('无 secure_url');
  } catch (e) {
    console.error('❌ 图片处理失败:', {
      error: e.message,
      stack: e.stack,
      fileId: fileId,
      timestamp: new Date().toISOString(),
      cloudinaryAttempt: true
    });
    if (tgUrl) {
      console.warn('⚠️ Cloudinary failed, falling back to Telegram temporary link:', tgUrl);
      return tgUrl;
    }
    return '';
  }
}
 
/**
 * 同步到 flomo
 */
async function syncToFlomo(content) {
  if (!process.env.FLOMO_WEBHOOK_URL) {
    console.error('FLOMO_WEBHOOK_URL 未配置，跳过同步');
    return;
  }
  if (!content?.trim()) return;
 
  if (content.length > MAX_CONTENT) {
    content = content.substring(0, MAX_CONTENT) + '\n...（内容过长，已截断）';
  }
 
  try {
    await fetchWithRetry(process.env.FLOMO_WEBHOOK_URL, {
      method: 'POST',
      data: { content },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUTS.FLOMO_API
    });
    console.info('✅ flomo 同步成功:', content.slice(0, 100) + '...');
  } catch (e) {
    console.error('flomo 同步失败:', {
      error: e.message,
      stack: e.stack,
      contentLength: content.length,
      timestamp: new Date().toISOString()
    });
  }
}
 
/**
 * 处理单条消息（非多图）
 */
async function handleSingle(chatId, content, photos, processingMsgId) {
  let urls = [];
  if (photos?.length) {
    const selected = photos.slice(-MAX_IMAGES);
    // 并行处理图片 URL 获取
    const urlPromises = selected.map(async (p) => {
      const u = await getImageUrl(p.file_id);
      return u;
    });
    const results = await Promise.all(urlPromises);
    urls = results.filter(u => u);
  }
 
  let final = content || '';
  if (urls.length) {
    const sec = urls.map((u, i) => `图片${i+1}：${u}`).join('\n\n');
    final = final ? `${final}\n\n${sec}` : sec;
  }
 
  await syncToFlomo(final);
 
  // 更新处理中消息为成功
  if (processingMsgId) {
    try {
      await bot.telegram.editMessageText(
        chatId,
        processingMsgId,
        null,
        '✅ 已同步到 flomo'
      );
    } catch (e) {
      console.debug('更新处理中消息失败:', e.message);
      await bot.telegram.sendMessage(chatId, '✅ 已同步到 flomo');
    }
  }
}
 
/**
 * 主消息处理
 */
bot.on(['message', 'edited_message'], async (ctx) => {
  const chatId = (ctx.chat && ctx.chat.id) || (ctx.from && ctx.from.id);
  
  // 立即发送"正在处理"反馈
  let processingMsg;
  try {
    processingMsg = await ctx.reply('📥 正在处理...');
  } catch (e) {
    console.debug('发送处理中提示失败:', e.message);
  }
 
  try {
    const msg = ctx.message || ctx.editedMessage;
    if (!msg) return;
 
    const text = (msg.text || msg.caption || '').trim();
    const groupId = msg.media_group_id;
    const photos = msg.photo || [];
 
    console.debug(`消息 - group:${groupId||'无'}, text:${text.slice(0,30)}...`);
 
    // 检查空消息
    if (!text && (!photos || !photos.length)) {
      if (processingMsg && processingMsg.message_id) {
        try {
          await bot.telegram.deleteMessage(chatId, processingMsg.message_id);
        } catch (e) {
          console.debug('删除处理中消息失败:', e.message);
        }
      }
      return;
    }
 
    if (!groupId || !photos.length) {
      await handleSingle(chatId, text, photos, processingMsg && processingMsg.message_id);
      return;
    }
 
    // 多图聚合
    if (!mediaGroupCache.has(groupId)) {
      mediaGroupCache.set(groupId, {
        content: text,
        urls: [],
        timer: null,
        chatId,
        createdAt: Date.now(),
        processingMsgId: processingMsg && processingMsg.message_id
      });
    }
 
    const cache = mediaGroupCache.get(groupId);
 
    if (text && !cache.content) cache.content = text;
 
    if (cache.timer) {
      clearTimeout(cache.timer);
      cache.timer = null;
    }
 
    if (photos.length && cache.urls.length < MAX_IMAGES) {
      const u = await getImageUrl(photos[photos.length-1].file_id);
      if (u) cache.urls.push(u);
    }
 
    cache.timer = setTimeout(async () => {
      try {
        let final = cache.content ? `${cache.content}\n\n` : '';
        if (cache.urls.length) {
          final += cache.urls.map((u,i)=>`图片${i+1}：${u}`).join('\n\n');
        }
 
        await syncToFlomo(final);
 
        // 更新处理中消息
        if (cache.processingMsgId) {
          try {
            await bot.telegram.editMessageText(
              cache.chatId,
              cache.processingMsgId,
              null,
              `✅ 多图聚合同步完成（${cache.urls.length} 张）`
            );
          } catch (e) {
            console.debug('聚合更新失败:', e.message);
            await bot.telegram.sendMessage(
              cache.chatId,
              `✅ 多图聚合同步完成（${cache.urls.length} 张）`
            );
          }
        }
      } catch (err) {
        console.error('处理聚合消息失败:', err);
      } finally {
        mediaGroupCache.delete(groupId);
      }
    }, DEBOUNCE_TIME);
 
  } catch (err) {
    console.error('处理异常:', {
      error: err.message,
      stack: err.stack,
      chatId,
      timestamp: new Date().toISOString()
    });
    if (processingMsg && processingMsg.message_id) {
      try {
        await bot.telegram.editMessageText(
          chatId,
          processingMsg.message_id,
          null,
          '❌ 处理失败，请稍后重试'
        );
      } catch (e) {
        await bot.telegram.sendMessage(chatId, '❌ 处理失败，请稍后重试');
      }
    }
  }
});
 
/**
 * Vercel Serverless 入口
 */
module.exports = async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
 
  // 🔍 调试：打印 secret 对比信息
  if (req.method === 'POST') {
    console.log('🔍 [DEBUG] 请求头中的 secret:', req.headers['x-telegram-bot-api-secret-token']);
    console.log('🔍 [DEBUG] Vercel 配置的 secret:', secret);
  }
 
  try {
    // 仅对 POST 请求进行 secret 验证
    if (req.method === 'POST') {
      // 补充：非空判断，避免环境变量未配置导致的误判
      if (!secret) {
        console.error('❌ 错误：TELEGRAM_WEBHOOK_SECRET 环境变量未配置');
        return res.status(500).json({ error: 'Server Configuration Error' });
      }
      // 权限验证：比对 Telegram 携带的令牌与环境变量中的 secret
      if (req.headers['x-telegram-bot-api-secret-token'] !== secret) {
        console.error('❌ 权限验证失败:', {
          received: req.headers['x-telegram-bot-api-secret-token'],
          expected: secret
        });
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
 
    if (process.env.VERCEL_ENV && !global.webhookSet) {
      const url = `https://${req.headers.host}/api`;
      await bot.telegram.setWebhook(url, { secret_token: secret });
      console.info('Webhook 已自动设置:', url);
      global.webhookSet = true;
    }
 
    if (req.method === 'POST' && req.body) {
      await bot.handleUpdate(req.body, res);
    } else {
      // 静态资源（如 favicon.ico）请求直接返回正常响应，避免 403/500
      res.status(200).end();
    }
  } catch (err) {
    console.error('Webhook 错误:', err);
    res.status(500).json({ error: 'Internal Error' });
  }
};
 
if (!process.env.VERCEL) {
  bot.launch().then(() => console.log('本地 Bot 启动'));
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}