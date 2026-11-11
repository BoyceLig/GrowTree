import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { requireParent } from '../middleware.js';
import { config } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// 文件上传：前端把文件读成 data URL（base64）POST 上来，
// 服务端落盘到 <DATA_DIR>/uploads/，返回 /uploads/<file> 供各处引用。
// 不引入 multipart 插件——单文件 base64 JSON 足够，且 Docker 构建依赖更少。
//
// 两个接口按「用途」分档，而不是按文件类型分：
//   /upload/image —— 商品图片、分类图标：只要图片，3MB 够用，请求体上限收紧
//   /upload/media —— 成长日记附件：图片放宽到 6MB（手机随手拍的照片动辄 4~5MB），
//                    并支持短视频（20MB）。视频单开一档是因为 base64 后体积 ×1.33，
//                    上限必须跟着放到 32MB，不能让商品图那条链路也背这个开销。
// ─────────────────────────────────────────────────────────────────────────────

/** 商品图片 / 分类图标：只收图片，3MB */
const IMAGE_ONLY_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** 日记附件：图片 6MB、视频 20MB（视频会先在前端做体积预检，这里只兜底） */
const MEDIA_EXT: Record<string, string> = {
  ...IMAGE_ONLY_EXT,
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

const MAX_IMAGE_ONLY_BYTES = 3 * 1024 * 1024;
const MAX_MEDIA_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_MEDIA_VIDEO_BYTES = 20 * 1024 * 1024;

/** 解析 data URL 的公共部分：返回 {mime, ext, buf} 或 null */
function parseDataUrl(data: unknown, allowed: Record<string, string>) {
  if (typeof data !== 'string') return null;
  // data:<mime>;base64,<payload>——mime 用宽松的 [\w.+-]+ 先取出来，再查白名单，
  // 这样非法类型会走到 unsupported_type（能给出准确错误码），而不是一律 invalid_input。
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) return null;
  const ext = allowed[m[1]];
  if (!ext) return { mime: m[1], ext: null as string | null, buf: Buffer.alloc(0) };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return null;
  return { mime: m[1], ext, buf };
}

function saveToUploads(buf: Buffer, ext: string): string {
  const dir = path.join(config.dataDir, 'uploads');
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${ext}`;
  writeFileSync(path.join(dir, name), buf);
  return `/uploads/${name}`;
}

export function registerUploadRoutes(app: FastifyInstance) {
  app.post(
    '/upload/image',
    { preHandler: requireParent, bodyLimit: 6 * 1024 * 1024 }, // base64 后体积约 +33%，放宽请求体上限
    async (req, reply) => {
      const parsed = parseDataUrl((req.body as any)?.data, IMAGE_ONLY_EXT);
      if (!parsed) return reply.code(400).send({ error: 'invalid_input' });
      if (!parsed.ext) return reply.code(400).send({ error: 'unsupported_type' });
      if (parsed.buf.length > MAX_IMAGE_ONLY_BYTES) return reply.code(413).send({ error: 'too_large' });

      return { url: saveToUploads(parsed.buf, parsed.ext) };
    }
  );

  // 成长日记附件（图片 / 短视频）：家长上传
  app.post(
    '/upload/media',
    { preHandler: requireParent, bodyLimit: 32 * 1024 * 1024 },
    async (req, reply) => {
      const parsed = parseDataUrl((req.body as any)?.data, MEDIA_EXT);
      if (!parsed) return reply.code(400).send({ error: 'invalid_input' });
      if (!parsed.ext) return reply.code(400).send({ error: 'unsupported_type' });

      const isVideo = parsed.mime.startsWith('video/');
      const limit = isVideo ? MAX_MEDIA_VIDEO_BYTES : MAX_MEDIA_IMAGE_BYTES;
      if (parsed.buf.length > limit) return reply.code(413).send({ error: 'too_large' });

      return {
        url: saveToUploads(parsed.buf, parsed.ext),
        type: isVideo ? 'video' : 'image',
      };
    }
  );
}
