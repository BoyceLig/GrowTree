import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * 自定义供应商的图标解析：拿用户填的 Base URL 去找站点图标。
 *
 * 顺序：
 *   1. 打开站点首页，解析 <link rel="icon|shortcut icon|apple-touch-icon">（质量最好，常是 SVG/大 PNG）；
 *   2. 退回站点根目录 /favicon.ico；
 *   3. api.xxx.com 这类子域拿不到时，再试一次父域（deepseek.com）。
 *
 * 安全（SSRF 防护）：只允许 http/https、每次跳转都重新校验域名解析结果，
 * 拒绝回环/内网/链路本地地址，限制跳转次数、响应体积与超时。
 * 结果按 origin 缓存 24 小时，避免每次打开设置页都去抓。
 */

const MAX_ICON_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 6000;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 200;
const MAX_REDIRECTS = 3;

type CacheEntry = { dataUrl: string; at: number };
const cache = new Map<string, CacheEntry>();

export type ProviderIcon = { dataUrl: string; origin: string; from: string };

function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v.includes(':')) {
    if (v === '::1' || v === '::') return true;
    if (/^f[cd]/.test(v)) return true; // fc00::/7 唯一本地地址
    if (/^fe[89ab]/.test(v)) return true; // fe80::/10 链路本地
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  const parts = v.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** 域名/IP 必须是公网可路由地址，避免被拿来探测内网 */
async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https 地址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('地址无效');
  if (host === 'localhost' || /\.(local|internal|lan|home|localhost)$/i.test(host)) {
    throw new Error('不允许访问内网地址');
  }
  const ips = isIP(host)
    ? [host]
    : (await lookup(host, { all: true, verbatim: true }).catch(() => [])).map((r) => r.address);
  if (!ips.length) throw new Error('域名解析失败');
  if (ips.some((ip) => isPrivateIp(ip))) throw new Error('不允许访问内网地址');
}

/** 手动跟随重定向，每一跳都重新做一次公网校验 */
async function safeFetch(url: URL, accept: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(current);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'ManAlong-AI-Settings/1.0', Accept: accept },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('重定向缺少 Location');
      current = new URL(loc, current);
      continue;
    }
    return res;
  }
  throw new Error('重定向次数过多');
}

async function readLimited(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new Error('响应过大');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error('响应过大');
  return buf;
}

/** 按文件头判断图片类型；HTML（很多站点会把 /favicon.ico 回退成首页）一律不要 */
function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  const head = buf.subarray(0, 512).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

/** 从首页 HTML 里按优先级收集 icon 链接（apple-touch-icon 通常分辨率最高） */
function collectIconHrefs(html: string, base: URL): string[] {
  const preferred: string[] = [];
  const normal: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = (/\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '').toLowerCase();
    if (!rel.includes('icon')) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      const abs = new URL(href, base).toString();
      (rel.includes('apple-touch') ? preferred : normal).push(abs);
    } catch {
      /* 相对路径解析失败就跳过 */
    }
  }
  return [...preferred, ...normal];
}

async function fetchImage(url: URL): Promise<string | null> {
  try {
    const res = await safeFetch(url, 'image/*,*/*;q=0.8');
    if (!res.ok) return null;
    const buf = await readLimited(res, MAX_ICON_BYTES);
    const mime = sniffImage(buf);
    if (!mime) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** 一个站点找图标的完整流程：首页 link → /favicon.ico */
async function resolveSiteIcon(site: URL): Promise<{ dataUrl: string; from: string } | null> {
  const html = await (async () => {
    try {
      const res = await safeFetch(new URL('/', site), 'text/html,*/*;q=0.8');
      if (!res.ok) return '';
      const buf = await readLimited(res, MAX_HTML_BYTES);
      const type = String(res.headers.get('content-type') ?? '').toLowerCase();
      if (type && !type.includes('html')) return '';
      return buf.toString('utf8');
    } catch {
      return '';
    }
  })();

  if (html) {
    for (const href of collectIconHrefs(html, site).slice(0, 4)) {
      const dataUrl = await fetchImage(new URL(href));
      if (dataUrl) return { dataUrl, from: href };
    }
  }

  const ico = await fetchImage(new URL('/favicon.ico', site));
  return ico ? { dataUrl: ico, from: new URL('/favicon.ico', site).toString() } : null;
}

/** api.deepseek.com → deepseek.com 之类的父域候选，api 子域通常不带图标 */
function parentDomain(host: string): string | null {
  const m = /^(?:api|open|chat|console|platform|www)\.([a-z0-9-]+\.[a-z0-9.-]+)$/i.exec(host);
  if (!m) return null;
  const candidate = m[1];
  // 只接受「域名.顶级域」，避免把 api.cn 这类二级域名当父域
  return candidate.includes('.') ? candidate : null;
}

function cacheSet(origin: string, dataUrl: string): void {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(origin, { dataUrl, at: Date.now() });
}

/** 给自定义供应商找头像；拿不到返回 null（界面回退成名称首字） */
export async function resolveProviderIcon(rawBaseUrl: string): Promise<ProviderIcon | null> {
  const raw = rawBaseUrl.trim();
  if (!raw) return null;
  let base: URL;
  try {
    base = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('Base URL 不是合法地址');
  }
  const origin = base.origin;
  // 先校验一次目标本身：内网/回环地址直接拒绝（给出明确错误，而不是「没找到图标」）
  await assertPublic(base);
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.at < TTL_MS) return { dataUrl: cached.dataUrl, origin, from: 'cache' };

  const sites = [base];
  const parent = parentDomain(base.hostname);
  if (parent) sites.push(new URL(`${base.protocol}//${parent}`));

  for (const site of sites) {
    const icon = await resolveSiteIcon(site);
    if (icon) {
      cacheSet(origin, icon.dataUrl);
      return { dataUrl: icon.dataUrl, origin, from: icon.from };
    }
  }
  return null;
}