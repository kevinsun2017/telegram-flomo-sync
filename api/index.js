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
 * 获取图片公网链接：优先 Cloudinary，失败降级 Telegram 临时链接
 */
async function getImageUrl(fileId) {
  let tgUrl = '';
  try {
    console.debug('开始处理 file_id:', fileId);

    const fileRes = await axios.get(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
      { timeout: 5000 }
    );
    const path = fileRes.data.result.file_path;

    if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(path)) {
      console.debug('非图片格式，跳过:', path);
      return '';
    }

    tgUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`;
    console.debug('TG 文件路径:', path);

    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_UPLOAD_PRESET) {
      console.debug('Cloudinary 未配置，使用 TG 临时链接');
      return tgUrl;
    }

    console.debug('开始下载图片流...');
    const imgStream = await axios.get(tgUrl, {
      responseType: 'stream',
      timeout: 6000
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
      timeout: 8000
    });
    console.debug('Cloudinary 上传完成');

    const url = res.data.secure_url;
    if (url) {
      console.info('Cloudinary 成功:', url.slice(0, 60) + '...');
      return url;
    }
    throw new Error('无 secure_url');
  } catch (e) {
    console.error('图片处理失败:', e.message);
    if (tgUrl) {
      console.warn('Cloudinary 失败，降级使用 Telegram 临时链接');
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
    await axios.post(process.env.FLOMO_WEBHOOK_URL, { content }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 6000
    });
    console.info('flomo 同步成功');
  } catch (e) {
    console.error('flomo 同步失败:', e.message);
  }
}

/**
 * 处理单条消息（非多图）
 */
async function handleSingle(chatId, content, photos, processingMsgId) {
  let urls = [];
  if (photos?.length) {
    const selected = photos.slice(-MAX_IMAGES);
    for (const p of selected) {
      const u = await getImageUrl(p.file_id);
      if (u) urls.push(u);
    }
  }

  let final = content || '';
  if (urls.length) {
    const sec = urls.map((u, i) => `![图片 ${i+1}](${u})`).join('\n\n');
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
  const chatId = ctx.chat?.id || ctx.from?.id;

  // 立即发送“正在处理”反馈
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

    if (!groupId || !photos.length) {
      await handleSingle(chatId, text, photos, processingMsg?.message_id);
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
        processingMsgId: processingMsg?.message_id
      });
    }

    const cache = mediaGroupCache.get(groupId);

    if (text && !cache.content) cache.content = text;

    clearTimeout(cache.timer);

    if (photos.length && cache.urls.length < MAX_IMAGES) {
      const u = await getImageUrl(photos[photos.length-1].file_id);
      if (u) cache.urls.push(u);
    }

    cache.timer = setTimeout(async () => {
      let final = cache.content ? `${cache.content}\n\n` : '';
      if (cache.urls.length) {
        final += cache.urls.map((u,i)=>`![图片 ${i+1}](${u})`).join('\n\n');
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

      mediaGroupCache.delete(groupId);
    }, DEBOUNCE_TIME);

  } catch (err) {
    console.error('处理异常:', err);
    if (processingMsg?.message_id) {
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
};

/**
 * Vercel Serverless 入口
 */
module.exports = async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    if (process.env.VERCEL_ENV && !process.env.WEBHOOK_SET) {
      const url = `https://${req.headers.host}/api`;
      await bot.telegram.setWebhook(url, { secret_token: secret });
      console.info('Webhook 已自动设置:', url);
      process.env.WEBHOOK_SET = 'true';
    }

    await bot.handleUpdate(req.body, res);
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