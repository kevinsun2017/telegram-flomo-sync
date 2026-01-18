export const config = {
  runtime: 'edge',
};

// 辅助函数：SHA1 签名
async function sha1(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export default async function handler(req) {
  // 1. 验证请求方式
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 2. 环境变量解构 (直接信任配置正确)
  const {
    TG_BOT_TOKEN,
    CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET
  } = process.env;

  // 兼容 FLOMO_API 或 FLOMO_TOKEN 两个变量名
  const FLOMO_API = process.env.FLOMO_API || process.env.FLOMO_TOKEN;

  // 详细调试日志 (只显示前4位，防止泄漏)
  console.log('Env Check:', {
    TG_BOT_TOKEN: TG_BOT_TOKEN ? (TG_BOT_TOKEN.substring(0,4) + '...') : 'MISSING',
    FLOMO_API: FLOMO_API ? (FLOMO_API.substring(0,4) + '...') : 'MISSING',
    CLOUD_NAME: CLOUDINARY_CLOUD_NAME ? 'SET' : 'MISSING'
  });

  // 简单检查 URL 是否存在
  if (!FLOMO_API || !FLOMO_API.startsWith('http')) {
      console.error('Error: Invalid FLOMO_API URL', FLOMO_API);
      return new Response('Config Error: FLOMO_API missing', { status: 200 });
  }

  try {
    const data = await req.json();
    const message = data.message;
    if (!message) return new Response('OK', { status: 200 });

    // 3. 提取内容 (保留原格式)
    // Telegram 文本在 .text，带图时文本在 .caption
    let content = message.text || message.caption || '';
    
    // 如果没有内容且没有图片，直接返回
    if (!content && (!message.photo || message.photo.length === 0)) {
       return new Response('Empty Content', { status: 200 });
    }

    // 给内容加个小尾巴
    if (content) content += '\n\n#Telegram';
    else content = '#Telegram图片';

    // 4. 处理图片 (Cloudinary -> image_urls)
    const imageUrls = [];
    if (message.photo && message.photo.length > 0) {
      // 获取最大分辨率图片
      const hdPhoto = message.photo.at(-1);
      
      // A. 获取 Telegram 文件路径
      const fileRes = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${hdPhoto.file_id}`);
      const fileData = await fileRes.json();
      const tgFileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${fileData.result.file_path}`;

      // B. 上传到 Cloudinary
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const paramsToSign = `timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
      const signature = await sha1(paramsToSign);

      const formData = new FormData();
      formData.append('file', tgFileUrl);
      formData.append('api_key', CLOUDINARY_API_KEY);
      formData.append('timestamp', timestamp);
      formData.append('signature', signature);

      const uploadRes = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
        { method: 'POST', body: formData }
      );
      const uploadData = await uploadRes.json();

      if (uploadData.secure_url) {
        imageUrls.push(uploadData.secure_url);
      }
    }

    // 5. 发送到 Flomo
    const payload = {
      content: content,
      image_urls: imageUrls.length > 0 ? encodeURIComponent(JSON.stringify(imageUrls)) : undefined
    };

    const flomoRes = await fetch(FLOMO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!flomoRes.ok) {
      throw new Error(`Flomo status: ${flomoRes.status}`);
    }

    // 6. 成功回执 (Telegram)
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: message.chat.id,
        text: '✅ 已同步到 Flomo',
        reply_to_message_id: message.message_id,
        disable_notification: true
      })
    });

    return new Response('Success', { status: 200 });

  } catch (err) {
    console.error(err);
    // 出错也不要让 Telegram 重试，直接返回 200，但可以在 logs 里看错误
    return new Response(`Error: ${err.message}`, { status: 200 });
  }
}
