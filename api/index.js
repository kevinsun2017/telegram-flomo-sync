// api/index.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// 配置常量
const DEBOUNCE_TIME = 2000;           // 多图聚合等待时间 (仍保留此常量，以防万一或作为参考，但不再用于图片聚合)
const MAX_CONTENT = 4500;             // flomo 安全阈值
const REQUEST_TIMEOUTS = {
  TELEGRAM_API: 5000,
  FLOMO_API: 6000
};
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;

/**
 * 带重试机制的 axios 请求
 */
async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios(url, {
        ...options,
        timeout: options.timeout || REQUEST_TIMEOUTS.FLOMO_API // 使用 FLOMO_API 超时作为通用默认
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
 * 同步到 flomo
 */
async function syncToFlomo(content) {
  if (!process.env.FLOMO_WEBHOOK_URL) {
    console.error('❌ FLOMO_WEBHOOK_URL 未配置，跳过同步');
    return;
  }
  if (!content || !content.trim()) { // 检查 content 是否为空
    console.info('ℹ️  无内容，跳过Flomo同步');
    return;
  }

  let processedContent = content;
  if (processedContent.length > MAX_CONTENT) {
    processedContent = processedContent.substring(0, MAX_CONTENT) + '\n...（内容过长，已截断）';
  }

  // 增加标签 #telegram
  processedContent += '\n#telegram'; 

  const payload = {
    content: processedContent
  };

  try {
    await fetchWithRetry(process.env.FLOMO_WEBHOOK_URL, {
      method: 'POST',
      data: payload,
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUTS.FLOMO_API
    });
    console.info('✅ Flomo 同步成功:', processedContent.slice(0, 100) + '...');
  } catch (e) {
    console.error('❌ Flomo 同步失败:', {
      error: e.message,
      stack: e.stack,
      contentLength: processedContent.length,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * 处理单条消息（仅文字）
 */
async function handleSingle(chatId, content, processingMsgId) { // 移除 photos 参数
  let final = content || '';
  
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
    // 移除图片相关变量和逻辑
    // const groupId = msg.media_group_id;
    // const photos = msg.photo || [];

    console.debug(`消息: text:${text.slice(0,30)}...`);

    // 检查空消息 (不再检查 photos)
    if (!text) { // 简化空消息检查
      if (processingMsg && processingMsg.message_id) {
        try {
          await bot.telegram.deleteMessage(chatId, processingMsg.message_id);
        } catch (e) {
          console.debug('删除处理中消息失败:', e.message);
        }
      }
      return;
    }
    
    // 直接处理单条消息，不再区分多图聚合
    await handleSingle(chatId, text, processingMsg && processingMsg.message_id);
    
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