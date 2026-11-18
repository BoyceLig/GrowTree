import { lookup } from 'node:dns/promises';

/**
 * 联网检索（零依赖）。
 *
 * 只做两件事：
 *   1. webSearch —— 关键词搜索，返回「标题 + 链接 + 摘要 + 来源站点」；
 *   2. webFetch  —— 打开某个网页，抽出可读正文，让模型核对原文。
 *
 * 设计取向偏保守：拿不到就报「没搜到」，绝不返回编造的占位结果。
 * 结果里始终带 URL，模型被要求在回答里注明来源，家长可以自己点开核对。
 */

export type WebHit = { title: string; url: string; snippet: string; site: string };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_CHARS = 8000;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** duckduckgo 的跳转链接还原成真实地址 */
function unwrapDdg(url: string): string {
  try {
    if (url.startsWith('//')) url = `https:${url}`;
    const u = new URL(url);
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url;
  } catch {
    return url;
  }
}

async function fetchText(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(init.headers ?? {}),
      },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: (e as Error)?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function parseDdg(html: string, limit: number): WebHit[] {
  const hits: WebHit[] = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < limit) {
    const url = unwrapDdg(decodeEntities(m[1]));
    const title = stripTags(m[2]);
    if (!url.startsWith('http') || !title) continue;
    // 摘要取这一条结果之后、下一条结果之前的第一个 snippet
    const rest = html.slice(m.index + m[0].length, m.index + m[0].length + 4000);
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(rest);
    hits.push({ title, url, snippet: snip ? stripTags(snip[1]).slice(0, 300) : '', site: siteOf(url) });
  }
  return hits;
}

function parseBing(html: string, limit: number): WebHit[] {
  const hits: WebHit[] = [];
  const blocks = html.split(/<li class="b_algo"/i).slice(1, limit + 1);
  for (const block of blocks) {
    const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = decodeEntities(link[1]);
    if (!url.startsWith('http')) continue;
    const title = stripTags(link[2]);
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    hits.push({
      title,
      url,
      snippet: p ? stripTags(p[1]).slice(0, 300) : '',
      site: siteOf(url),
    });
  }
  return hits;
}

/** 关键词搜索：先 duckduckgo，失败或空结果再试 bing；都拿不到就返回空数组 */
export async function webSearch(query: string, limit = 5): Promise<{ hits: WebHit[]; engine: string; error?: string }> {
  const q = query.trim().slice(0, 200);
  if (!q) return { hits: [], engine: '', error: '搜索词为空' };
  const encoded = encodeURIComponent(q);

  const ddg = await fetchText(`https://html.duckduckgo.com/html/?q=${encoded}&kl=cn-zh`, {
    method: 'GET',
  });
  if (ddg.ok) {
    const hits = parseDdg(ddg.body, limit);
    if (hits.length) return { hits, engine: 'DuckDuckGo' };
  }

  const bing = await fetchText(`https://www.bing.com/search?q=${encoded}&setlang=zh-CN&count=${limit}`, {
    method: 'GET',
  });
  if (bing.ok) {
    const hits = parseBing(bing.body, limit);
    if (hits.length) return { hits, engine: 'Bing' };
  }

  return {
    hits: [],
    engine: '',
    error: '搜索引擎没有返回结果（可能当前网络无法访问外部搜索，或被限流）',
  };
}

/** 拦截本机/内网地址，避免 AI 被诱导去读内网服务 */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('链接格式不对');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https 链接');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('不允许访问本机地址');
  const addrs = await lookup(host, { all: true }).catch(() => []);
  for (const { address } of addrs) {
    if (
      /^127\./.test(address) ||
      /^10\./.test(address) ||
      /^192\.168\./.test(address) ||
      /^169\.254\./.test(address) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
      address === '::1' ||
      /^f[cd][0-9a-f]{2}:/i.test(address)
    ) {
      throw new Error('不允许访问内网地址');
    }
  }
  return url;
}

export type PageDigest = { url: string; title: string; text: string; site: string };

/** 打开网页并抽取正文（截断到 8000 字，保留头部标题） */
export async function fetchPage(raw: string): Promise<PageDigest> {
  const url = await assertPublicUrl(raw.trim());
  const res = await fetchText(url.toString());
  if (!res.ok) throw new Error(res.status ? `打开网页失败（HTTP ${res.status}）` : `打开网页失败：${res.body.slice(0, 120)}`);

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(res.body);
  const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 120) : url.hostname;

  // 优先取正文容器，取不到就退化为整页去标签
  const main =
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(res.body) ??
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(res.body);
  const text = stripTags(main ? main[1] : res.body).slice(0, MAX_PAGE_CHARS);

  return { url: url.toString(), title, text, site: siteOf(url.toString()) };
}
