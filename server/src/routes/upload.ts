import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { requireParent } from '../middleware.js';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// 文件上传：前端把文件读成 data URL（base64）POST 上来，
// 服务端落盘到 <DATA_DIR>/uploads/，返回 /uploads/<file> 供各处引用。
// 不引入 multipart 插件——单文件 base64 JSON 足够，且 Docker 构建依赖更少。
//
// 两个接口按「用途」分档，而不是按文件类型分：
//   /upload/image —— 头像、商品图片、分类图标：只要图片，体积不设上限
//                    （前端会按用途压缩到合适分辨率），bodyLimit 放宽到 64MB 兜底，
//                    防止异常客户端把整包 base64 塞进内存。
//   /upload/media —— 成长日记附件：图片不设上限（前端同样会压缩），
//                    视频不限大小（家庭场景的原始视频动辄几十上百 MB）。
//                    代价是 base64 后体积 ×1.33 且整包进内存，请求体上限放到 512MB
//                    （约支持 380MB 的原视频），再大就 413 拒绝，避免把进程内存打爆。
// ─────────────────────────────────────────────────────────────────────────────

/** 头像 / 商品图片 / 分类图标：只收图片 */
const IMAGE_ONLY_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** 日记附件：图片不设上限（前端压缩后通常几百 KB）；视频不限制大小（受请求体上限约束） */
const MEDIA_EXT: Record<string, string> = {
  ...IMAGE_ONLY_EXT,
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** /upload/image 请求体上限：前端已压缩，这里只是防止异常请求打爆内存的安全阀 */
const MAX_IMAGE_ONLY_BODY_BYTES = 64 * 1024 * 1024;
/** /upload/media 请求体上限：base64(视频) ≈ 原始体积 ×1.33，512MB 约对应 380MB 原视频 */
const MAX_MEDIA_BODY_BYTES = 512 * 1024 * 1024;
/** multipart 流式上传的视频上限（与插件 limits 保持一致） */
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

/** 日记媒体：multipart 流式落盘（不把大视频读进内存 / base64，避免前端卡死） */
async function handleMultipartMedia(req: FastifyRequest, reply: FastifyReply) {
  let part: any;
  try {
    part = await req.file({ limits: { fileSize: MAX_VIDEO_BYTES, files: 1 } });
  } catch {
    return reply.code(413).send({ error: 'too_large' });
  }
  if (!part) return reply.code(400).send({ error: 'invalid_input' });

  const mime = String(part.mimetype || '');
  const nameExt =
    String(part.filename || '')
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/)?.[1] || '';
  const normalizedExt = nameExt === 'jpeg' ? 'jpg' : nameExt;
  const allowedFallback = ['png', 'jpg', 'gif', 'webp', 'mp4', 'webm', 'mov'];
  const ext = MEDIA_EXT[mime] || (allowedFallback.includes(normalizedExt) ? normalizedExt : null);
  if (!ext) {
    part.file.resume();
    return reply.code(400).send({ error: 'unsupported_type' });
  }

  const isVideo = mime.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext);
  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true });
  const name = newUploadName(ext);
  const full = path.join(dir, name);

  // 原始文件名：优先 query 里前端显式带上的（压缩后会换名，只有前端知道原名），
  // 其次 multipart 的 filename。尺寸/时长等元数据也走 query，避免为了拿字段去遍历 parts。
  const query = (req.query || {}) as Record<string, any>;
  const originalName = sanitizeFileName(
    decodeUploadFilename(query.name) || decodeUploadFilename(part.filename),
    name
  );
  const metaOf = (diskName: string, size: number): UploadFileMeta => ({
    name: diskName,
    originalName,
    mime,
    size,
    kind: isVideo ? 'video' : 'image',
    width: toPositiveInt(query.w),
    height: toPositiveInt(query.h),
    duration: toPositiveFloat(query.dur),
    userId: req.user?.sub ?? null,
  });
  // 图片和视频共用同一个流式上限：图片在前端已压缩，正常只有几百 KB
  const limit = MAX_VIDEO_BYTES;

  let size = 0;
  try {
    await pipeline(
      part.file,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > limit) {
            throw Object.assign(new Error('too_large'), { code: 'TOO_LARGE' });
          }
          yield chunk;
        }
      },
      createWriteStream(full)
    );
  } catch (e: any) {
    try {
      unlinkSync(full);
    } catch {
      /* 文件可能还没创建 */
    }
    if (e?.code === 'TOO_LARGE' || part.file.truncated) {
      return reply.code(413).send({ error: 'too_large' });
    }
    return reply.code(400).send({ error: 'invalid_input' });
  }

  if (part.file.truncated) {
    try {
      unlinkSync(full);
    } catch {
      /* ignore */
    }
    return reply.code(413).send({ error: 'too_large' });
  }

  // 内容去重：和已有文件完全一样就删掉新文件、复用旧路径，避免同一段视频越堆越多
  const same = await findSameUploadByHash(full, size);
  if (same) {
    try {
      unlinkSync(full);
    } catch {
      /* ignore */
    }
    // 复用旧文件时也要记一条：老文件可能是本次升级前上传的，表里还没有它的名字
    recordUploadFile(metaOf(path.basename(same), size));
    return { url: same, type: isVideo ? 'video' : 'image', name: originalName, size, mime };
  }

  recordUploadFile(metaOf(name, size));
  return { url: `/uploads/${name}`, type: isVideo ? 'video' : 'image', name: originalName, size, mime };
}

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

function uploadsDir(): string {
  return path.join(config.dataDir, 'uploads');
}

/** 生成磁盘文件名：时间戳 + 随机串 = 唯一 ID，永远不含用户原名（防重名/防路径穿越） */
function newUploadName(ext: string): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${ext}`;
}

/**
 * multipart 的 filename 取原始文件名。
 *
 * busboy 按 latin1 解析 filename 字段，中文会被拆成 U+0080–U+00FF；
 * 能无损还原成 UTF-8 就还原，否则原样返回（英文名本来就正确）。
 */
function decodeUploadFilename(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  if (/[\u0080-\u00ff]/.test(s) && !/[\u4e00-\u9fff]/.test(s)) {
    const guess = Buffer.from(s, 'latin1').toString('utf8');
    if (guess && !guess.includes('\ufffd')) return guess;
  }
  try {
    if (/%[0-9A-Fa-f]{2}/.test(s)) return decodeURIComponent(s);
  } catch {
    /* 保留原样 */
  }
  return s;
}

/** 清洗用户原始文件名：去目录、去控制字符、限制长度；不合法时返回 fallback */
function sanitizeFileName(raw: unknown, fallback = 'file'): string {
  if (typeof raw !== 'string') return fallback;
  const base = path
    .basename(raw.replace(/\\/g, '/'))
    // 控制字符会让 Content-Disposition 出错（头注入），一律去掉
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 180);
  if (!base || base === '.' || base === '..') return fallback;
  return base;
}

function toPositiveInt(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function toPositiveFloat(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** 上传文件元数据：磁盘名是 ID，原始名字和尺寸这些只存在表里 */
export interface UploadFileMeta {
  name: string;
  originalName?: string | null;
  mime?: string | null;
  size?: number | null;
  kind?: 'image' | 'video' | 'file' | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  userId?: number | null;
}

/**
 * 记录一次上传（同内容去重后可能多条记录指向同一个物理文件）。
 *
 * 冲突时保留「最先记下的原始名」——物理文件只有一份，它只能有一个默认下载名；
 * 用户在各自日记里看到的 data-name 是节点自己的，下载时通过 ?as= 传回来覆盖，
 * 所以同一份视频在不同日记里仍然能各自下载成各自的名字。
 */
export function recordUploadFile(meta: UploadFileMeta): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO upload_files (name, original_name, mime, size, kind, width, height, duration, user_id)
       VALUES (@name, @original_name, @mime, @size, @kind, @width, @height, @duration, @user_id)
       ON CONFLICT(name) DO UPDATE SET
         original_name = CASE
           WHEN upload_files.original_name = upload_files.name THEN excluded.original_name
           ELSE upload_files.original_name
         END,
         mime = COALESCE(upload_files.mime, excluded.mime),
         size = COALESCE(upload_files.size, excluded.size),
         kind = COALESCE(upload_files.kind, excluded.kind),
         width = COALESCE(upload_files.width, excluded.width),
         height = COALESCE(upload_files.height, excluded.height),
         duration = COALESCE(upload_files.duration, excluded.duration)`
    ).run({
      name: meta.name,
      original_name: sanitizeFileName(meta.originalName, meta.name),
      mime: meta.mime ?? null,
      size: meta.size ?? null,
      kind: meta.kind ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      duration: meta.duration ?? null,
      user_id: meta.userId ?? null,
    });
  } catch (e: any) {
    // 元数据只是锦上添花，写失败不能影响上传本身
    console.warn('[uploads] 记录文件元数据失败:', e?.message || e);
  }
}

/** 查上传文件元数据（下载时还原原始文件名） */
function getUploadFileMeta(name: string): Record<string, any> | null {
  try {
    return (getDb().prepare('SELECT * FROM upload_files WHERE name = ?').get(name) as any) || null;
  } catch {
    return null;
  }
}

/** 删文件时同步删记录；漏删的孤儿记录由清扫兜底，不影响正确性 */
function deleteUploadFileMeta(name: string): void {
  try {
    getDb().prepare('DELETE FROM upload_files WHERE name = ?').run(name);
  } catch {
    /* ignore */
  }
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
};

/** Content-Disposition：ASCII 兜底名 + RFC 5987 的 UTF-8 原名（中文名下载不乱码/不丢名） */
function attachmentHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * 内容完全相同的文件直接复用已有路径，避免同一张头像/商品图反复上传占空间。
 *
 * 只扫顶层文件：头像的路径规则只接受 /uploads/<file>，复用子目录里的文件
 * （成长日记按家庭归档）会通不过头像校验。
 */
function findSameUpload(buf: Buffer): string | null {
  const dir = uploadsDir();
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      if (statSync(full).size !== buf.length) continue;
      if (readFileSync(full).equals(buf)) return `/uploads/${entry.name}`;
    } catch {
      // 读不到就跳过，别让一个坏文件阻断上传
    }
  }
  return null;
}

function saveToUploads(buf: Buffer, ext: string, meta?: Omit<UploadFileMeta, 'name' | 'size'>): string {
  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true });
  const existing = findSameUpload(buf);
  if (existing) {
    recordUploadFile({ ...meta, name: path.basename(existing), size: buf.length });
    return existing;
  }
  const name = newUploadName(ext);
  writeFileSync(path.join(dir, name), buf);
  recordUploadFile({ ...meta, name, size: buf.length });
  return `/uploads/${name}`;
}

/** 文件内容哈希缓存（文件名 → sha256）：上传后文件不再变更，缓存不用失效 */
const fileHashCache = new Map<string, string>();

async function sha256OfFile(full: string): Promise<string | null> {
  const key = path.basename(full);
  const cached = fileHashCache.get(key);
  if (cached) return cached;
  try {
    const hash = createHash('sha256');
    await pipeline(createReadStream(full), hash);
    const hex = hash.digest('hex');
    fileHashCache.set(key, hex);
    return hex;
  } catch {
    return null;
  }
}

/**
 * 视频/图片走 multipart 流式落盘，落完再按内容哈希比对：
 * 完全相同的文件（同一段视频重发、换设备重传、多篇日记贴同一张图）直接复用，
 * 不重复占磁盘。只比同尺寸文件，正常情况下最多比对一两个。
 */
async function findSameUploadByHash(full: string, size: number): Promise<string | null> {
  const target = await sha256OfFile(full);
  if (!target) return null;
  const dir = uploadsDir();
  const self = path.basename(full);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === self) continue;
    const other = path.join(dir, entry.name);
    try {
      if (statSync(other).size !== size) continue;
      if ((await sha256OfFile(other)) === target) return `/uploads/${entry.name}`;
    } catch {
      // 读不到（坏文件 / 正在写入）就跳过
    }
  }
  return null;
}

/** 某个上传文件是否还被任何数据引用（头像 / 商品图 / 分类图标 / 许愿单 / 日记 / AI 附件） */
function isUploadReferenced(
  db: ReturnType<typeof getDb>,
  url: string
): boolean {
  return !!(
    db.prepare('SELECT 1 FROM users WHERE avatar = ? LIMIT 1').get(url) ||
    db.prepare('SELECT 1 FROM product_categories WHERE icon = ? LIMIT 1').get(url) ||
    db.prepare('SELECT 1 FROM products WHERE icon = ? LIMIT 1').get(url) ||
    db.prepare('SELECT 1 FROM wish_items WHERE photo = ? LIMIT 1').get(url) ||
    // 日记附件：老数据在 media JSON 里，新数据（富文本编辑器）在正文 HTML 里，两处都要看
    db
      .prepare(
        'SELECT 1 FROM growth_diaries WHERE instr(media, ?) > 0 OR instr(content, ?) > 0 LIMIT 1'
      )
      .get(url, url) ||
    db.prepare('SELECT 1 FROM ai_messages WHERE instr(attachments, ?) > 0 LIMIT 1').get(url)
  );
}

/**
 * 删除不再被任何数据引用的上传文件。
 *
 * 触发时机：换自定义头像、日记编辑/删除后清理被移除的附件。
 * 同一份文件可能被多篇日记、商品、分类、许愿单同时引用（上传按内容去重后更常见），
 * 只要还有一处引用就保留；删除失败只记日志，不影响业务。
 */
export function deleteUploadIfUnused(url: string): void {
  // 允许一层子目录（历史数据按家庭归档），但拦掉 .. 路径穿越
  if (!/^\/uploads\/(?!.*\.\.)(?:[\w.-]+\/)?[\w.-]+$/.test(url)) return;
  const db = getDb();
  if (isUploadReferenced(db, url)) return;

  const root = uploadsDir();
  const rel = url.replace(/^\/uploads\//, '');
  const full = path.join(root, rel);
  // 双保险：解析后的路径必须仍在 uploads/ 里面
  if (full !== root && !full.startsWith(root + path.sep)) return;

  try {
    unlinkSync(full);
    fileHashCache.delete(path.basename(full));
    deleteUploadFileMeta(path.basename(full));
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.warn(`[uploads] 删除旧文件失败 ${url}:`, e?.message || e);
    }
  }
}

/**
 * 清理孤儿文件（兜底）：
 * 上传了但没保存进任何数据（草稿丢弃、编辑到一半关掉、上传后立刻删除）的文件，
 * 永远等不到「日记保存」这条清理路径，只能靠这里按「无引用 + 超过保留期」扫掉。
 *
 * 保留期默认 3 天：足够覆盖「今天传了明天才写日记」这种正常节奏，也不会让孤儿越积越多。
 * 只扫顶层文件（子目录是历史归档，不动）。
 */
export function sweepOrphanUploads(maxAgeDays = 3): void {
  const dir = uploadsDir();
  if (!existsSync(dir)) return;
  const db = getDb();
  const cutoffMs = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      if (statSync(full).mtimeMs > cutoffMs) continue; // 新文件先留着（可能正在上传/还没保存）
      const url = `/uploads/${entry.name}`;
      if (isUploadReferenced(db, url)) continue;
      unlinkSync(full);
      fileHashCache.delete(entry.name);
      deleteUploadFileMeta(entry.name);
      removed++;
    } catch {
      // 单个文件失败不影响整体清扫
    }
  }
  // 记录与文件反过来对不上的（文件被手工删/迁移丢失）也一并收掉，避免下载接口查到空壳记录
  try {
    const names = new Set(
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    );
    const rows = db.prepare('SELECT name FROM upload_files').all() as { name: string }[];
    for (const row of rows) {
      if (!names.has(row.name)) deleteUploadFileMeta(row.name);
    }
  } catch {
    /* 清扫是尽力而为 */
  }
  if (removed > 0) console.log(`[uploads] 已清理 ${removed} 个无人引用的上传文件`);
}

export function registerUploadRoutes(app: FastifyInstance) {
  app.post(
    '/upload/image',
    { preHandler: requireParent, bodyLimit: MAX_IMAGE_ONLY_BODY_BYTES },
    async (req, reply) => {
      const parsed = parseDataUrl((req.body as any)?.data, IMAGE_ONLY_EXT);
      if (!parsed) return reply.code(400).send({ error: 'invalid_input' });
      if (!parsed.ext) return reply.code(400).send({ error: 'unsupported_type' });

      const body = (req.body || {}) as any;
      const originalName = sanitizeFileName(
        decodeUploadFilename(body.name),
        `image.${parsed.ext}`
      );
      const url = saveToUploads(parsed.buf, parsed.ext, {
        originalName,
        mime: parsed.mime,
        kind: 'image',
        userId: req.user?.sub ?? null,
      });
      return { url, name: originalName, size: parsed.buf.length, mime: parsed.mime };
    }
  );

  // 成长日记附件（图片 / 视频）：家长上传。
  // 优先走 multipart 流式上传；旧的 base64 JSON 保留兼容（老客户端）。
  app.post(
    '/upload/media',
    { preHandler: requireParent, bodyLimit: MAX_MEDIA_BODY_BYTES },
    async (req, reply) => {
      if (req.isMultipart()) return handleMultipartMedia(req, reply);

      const parsed = parseDataUrl((req.body as any)?.data, MEDIA_EXT);
      if (!parsed) return reply.code(400).send({ error: 'invalid_input' });
      if (!parsed.ext) return reply.code(400).send({ error: 'unsupported_type' });

      const isVideo = parsed.mime.startsWith('video/');

      const body = (req.body || {}) as any;
      const originalName = sanitizeFileName(
        decodeUploadFilename(body.name),
        `media.${parsed.ext}`
      );
      const url = saveToUploads(parsed.buf, parsed.ext, {
        originalName,
        mime: parsed.mime,
        kind: isVideo ? 'video' : 'image',
        width: toPositiveInt(body.width ?? body.w),
        height: toPositiveInt(body.height ?? body.h),
        duration: toPositiveFloat(body.duration ?? body.dur),
        userId: req.user?.sub ?? null,
      });

      return {
        url,
        name: originalName,
        type: isVideo ? 'video' : 'image',
        size: parsed.buf.length,
        mime: parsed.mime,
      };
    }
  );

  /**
   * 按原始文件名下载。
   *
   * 磁盘名是随机 ID（`lq2x9f-a1b2c3.mp4`），用户下载时不该看到这个。
   * 优先级：?as= 参数（日记节点里的 data-name，各篇日记各自的名字）> 元数据表里的 original_name > 磁盘名。
   * 与 /uploads/ 静态服务保持一致，不额外鉴权（家庭局域网部署，日记本身已按账号隔离）。
   */
  app.get('/uploads/:name/download', async (req, reply) => {
    const name = String((req.params as any)?.name || '');
    // 允许一层子目录（历史数据按家庭归档），但拦掉 .. 与更深的层级，避免路径穿越
    if (!/^[\w.-]+(?:\/[\w.-]+)?$/.test(name) || name.includes('..')) {
      return reply.code(400).send({ error: 'invalid_name' });
    }
    const root = uploadsDir();
    const full = path.join(root, name);
    if (full !== root && !full.startsWith(root + path.sep)) {
      return reply.code(400).send({ error: 'invalid_name' });
    }
    if (!existsSync(full)) return reply.code(404).send({ error: 'not_found' });

    const meta = getUploadFileMeta(name);
    const query = (req.query || {}) as Record<string, any>;
    const diskBase = path.basename(name);
    const fileName =
      sanitizeFileName(decodeUploadFilename(query.as), '') ||
      String(meta?.original_name || '') ||
      diskBase;

    const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
    reply.header('Content-Disposition', attachmentHeader(fileName));
    reply.header('Cache-Control', 'private, max-age=0');
    try {
      reply.header('Content-Length', statSync(full).size);
    } catch {
      /* 拿不到大小就交给分块传输 */
    }
    // 有的浏览器/下载器只认 Content-Type，按表里的 mime 优先，其次按扩展名兜底
    reply.type(String(meta?.mime || EXT_MIME[ext] || 'application/octet-stream'));
    return reply.send(createReadStream(full));
  });
}
