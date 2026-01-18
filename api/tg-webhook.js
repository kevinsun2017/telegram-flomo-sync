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
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] === Request Started ===`);

  // 1. 验证请求方式
  if (req.method !== 'POST') {
    console.warn(`[${timestamp}] Method Not Allowed: ${req.method}`);
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
  console.log(`[${timestamp}] Env Check:`, {
    TG_BOT_TOKEN: TG_BOT_TOKEN ? (TG_BOT_TOKEN.substring(0,4) + '...') : 'MISSING',
    FLOMO_API: FLOMO_API ? (FLOMO_API.substring(0, FLOMO_API.length > 8 ? 8 : FLOMO_API.length) + '...') : 'MISSING',
    CLOUD_NAME: CLOUDINARY_CLOUD_NAME ? 'SET' : 'MISSING'
  });


  // 简单检查 URL 是否存在
  if (!FLOMO_API || !FLOMO_API.startsWith('http')) {
      console.error(`[${timestamp}] Config Error: FLOMO_API missing or invalid URL format.`);
      return new Response('Config Error: FLOMO_API missing or invalid', { status: 200 }); // 返回200，Telegram不重试
  }

  try {
    const data = await req.json();
    console.log(`[${timestamp}] Received Payload:`, JSON.stringify(data, null, 2));

    const message = data.message;
    if (!message) {
        console.log(`[${timestamp}] No message in payload, returning OK.`);
        return new Response('OK', { status: 200 });
    }

    // 3. 提取内容 (保留原格式)
    let content = message.text || message.caption || '';
    
    // 如果没有内容且没有图片，直接返回
    if (!content && (!message.photo || message.photo.length === 0)) {
       console.log(`[${timestamp}] No content or photo to sync, returning OK.`);
       return new Response('No content to sync', { status: 200 });
    }

    // 给内容加个小尾巴
    if (content) content += '\n\n#Telegram';
    else content = '#Telegram图片';

    // 4. 处理图片 (Cloudinary -> Markdown 嵌入 Content)
    const imageUrls = [];
    if (message.photo && message.photo.length > 0) {
      console.log(`[${timestamp}] Photo detected, starting Cloudinary upload.`);
      // 获取最大分辨率图片
      const hdPhoto = message.photo.at(-1);
      
      // A. 获取 Telegram 文件路径
      const fileRes = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${hdPhoto.file_id}`);
      const fileData = await fileRes.json();
      
      if (!fileData.ok) {
          console.error(`[${timestamp}] Telegram getFile failed:`, fileData);
          throw new Error('Failed to get file path from Telegram');
      }
      const tgFileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${fileData.result.file_path}`;
      console.log(`[${timestamp}] Telegram File URL: ${tgFileUrl.substring(0, 50)}...`);

      // B. 上传到 Cloudinary
      const timestampCloudinary = Math.floor(Date.now() / 1000).toString();
      const paramsToSign = `timestamp=${timestampCloudinary}${CLOUDINARY_API_SECRET}`;
      const signature = await sha1(paramsToSign);
      console.log(`[${timestamp}] Cloudinary Signature generated.`);

      const formData = new FormData();
      formData.append('file', tgFileUrl);
      formData.append('api_key', CLOUDINARY_API_KEY);
      formData.append('timestamp', timestampCloudinary);
      formData.append('signature', signature);

      const uploadRes = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
        { method: 'POST', body: formData }
      );
      const uploadData = await uploadRes.json();

      if (uploadData.secure_url) {
        imageUrls.push(uploadData.secure_url);
        console.log(`[${timestamp}] Cloudinary Upload Success: ${uploadData.secure_url.substring(0, 50)}...`);
      } else {
        console.error(`[${timestamp}] Cloudinary Upload Failed:`, uploadData);
        throw new Error(`Cloudinary upload failed: ${JSON.stringify(uploadData)}`);
      }
    } 

    // 5. 发送到 Flomo (图片以 Markdown 格式嵌入 content)
    if (imageUrls.length > 0) {
      imageUrls.forEach(url => {
        content += `\n![图片](${url})`; // 转换为 Markdown 图片格式
      });
    }
    console.log(`[${timestamp}] Sending to Flomo. Final Content: ${content.substring(0, 100)}...`);

    const payload = {
      content: content
    };

    const flomoRes = await fetch(FLOMO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!flomoRes.ok) {
      const flomoErrorText = await flomoRes.text();
      console.error(`[${timestamp}] Flomo API Error: Status ${flomoRes.status}, Response: ${flomoErrorText}`);
      throw new Error(`Flomo API rejected: ${flomoRes.status}`);
    }
    console.log(`[${timestamp}] Flomo Sync Success.`);

    // 6. 成功回执 (Telegram)
    console.log(`[${timestamp}] Sending Telegram success reply.`);
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
    console.log(`[${timestamp}] Telegram reply sent.`);

    return new Response('Success', { status: 200 });

  } catch (err) {
    console.error(`[${timestamp}] Main Handler Error:`, err.message, err.stack);
    return new Response(`Error: ${err.message}`, { status: 200 });
  }
}
