export const config = {
  runtime: 'edge',
};

// 图床+同步核心逻辑
export default async function handler(req) {
  // 环境变量（Vercel里配置4个）
  const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
  const FLOMO_TOKEN = process.env.FLOMO_TOKEN;
  const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
  const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
  const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
  const FLOMO_API = 'https://flomoapp.com/iwh/xxx/api/memo';

  // 校验环境变量齐全
  if (!TG_BOT_TOKEN || !FLOMO_TOKEN || !CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return new Response('Missing Env Vars', { status: 400 });
  }

  const data = await req.json();
  const { message } = data;
  let content = '';

  // 1. 处理图片消息（转存Cloudinary）
  if (message?.photo && message.photo.length > 0) {
    try {
      // 取Telegram最高清图片
      const hdPhoto = message.photo.at(-1);
      // 第一步：获取Telegram图片临时直链
      const fileRes = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${hdPhoto.file_id}`);
      const fileData = await fileRes.json();
      const tgTempUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${fileData.result.file_path}`;

      // 第二步：Cloudinary直接拉取TG图片转存（无需本地下载）
      const cloudinaryUploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
      const uploadForm = new URLSearchParams();
      uploadForm.append('file', tgTempUrl);
      uploadForm.append('api_key', CLOUDINARY_API_KEY);
      uploadForm.append('timestamp', Math.floor(Date.now() / 1000).toString());
      // 生成签名防篡改
      const signatureStr = `file=${tgTempUrl}&timestamp=${uploadForm.get('timestamp')}${CLOUDINARY_API_SECRET}`;
      const signature = await sha1(signatureStr);
      uploadForm.append('signature', signature);

      const uploadRes = await fetch(cloudinaryUploadUrl, {
        method: 'POST',
        body: uploadForm,
        timeout: 8000 // 适配Vercel 10s超时
      });
      const uploadData = await uploadRes.json();

      // 第三步：拼接flomo可显示的图片链接+标签
      content = `![Telegram图片](${uploadData.secure_url})\n#Telegram #图片同步`;
    } catch (e) {
      return new Response('Image Upload Fail', { status: 500 });
    }
  }
  // 2. 处理文本消息（兼容原有逻辑，保留换行）
  else if (message?.text && !message.text.startsWith('/')) {
    content = message.text.replace(/\n/g, '<br>') + '\n#Telegram文本';
  }
  // 3. 过滤命令消息（/start等）
  else {
    return new Response('Skip', { status: 200 });
  }

  // 4. 同步到Flomo
  try {
    await fetch(FLOMO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, token: FLOMO_TOKEN }),
      timeout: 5000
    });
    return new Response('Sync Success', { status: 200 });
  } catch (e) {
    return new Response('Flomo Sync Fail', { status: 500 });
  }
}

// 辅助函数：生成Cloudinary所需SHA1签名（Edge环境兼容）
async function sha1(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}