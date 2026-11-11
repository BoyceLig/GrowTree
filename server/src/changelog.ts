/**
 * 更新日志的解析与获取
 * ============================================================
 * 两个消费方：
 *   1) 「关于成长树」页 —— 读**镜像里**的 CHANGELOG.md（本项目自带的记录）
 *   2) 「更新提示条 → 查看更新」—— 读**代码仓库里**的最新 CHANGELOG.md
 *      （新版本的说明还没进当前镜像，只能从远端拿；仓库是公开的，匿名可读）
 *
 * 解析规则见 parseChangelog 的注释，改 CHANGELOG.md 标题格式时请同步这里。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './config.js';

export interface ChangeGroup {
  title: string;
  items: string[];
}

export interface ChangeVersion {
  version: string;
  date: string;
  groups: ChangeGroup[];
}

/** 去掉 markdown 的强调与行内代码标记，前端直接按纯文本渲染 */
function stripMarkdown(s: string): string {
  return s.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

/** 中日韩文字与全角标点 —— 用来判断折行拼接处要不要补空格 */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

/**
 * 折行拼接规则：中文之间**不**补空格（否则会出现「的 情况」这种断词），
 * 但中英 / 中数与英数之间**必须**补（否则「OCI 接口」会粘成「OCI接口」）。
 */
function joinWrapped(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  const tail = prev.slice(-1);
  const head = next.slice(0, 1);
  return CJK.test(tail) && CJK.test(head) ? prev + next : `${prev} ${next}`;
}

/**
 * 把 CHANGELOG.md 解析成「版本 → 分组 → 条目」三级结构。
 *
 * - 版块按二级标题切分，标题形如 「## 20261010-5（2026-10-14）」
 *   （版本号 = 发布日期 YYYYMMDD，同日第 2 版起加 -2、-3…；
 *    早期用过 2.1.0 这类语义编号，现已按发布日期折算）
 * - 版块内按三级标题分组，形如 「### 一键升级（新功能）」
 * - 条目以「- 」开头；**折行的部分继续用缩进书写**，必须并回上一条，
 *   且中文换行处不能补空格（否则会出现「的 情况」这种断词）
 * - 「1.0 – 1.1（基线）」这类范围写法同样能解析出日期为「基线」
 */
export function parseChangelog(md: string): ChangeVersion[] {
  const versions: ChangeVersion[] = [];
  // slice(1)：第一段是文件头的说明文字，不含版本号
  const blocks = md.split(/^##[ \t]+/m).slice(1);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const head = lines[0].trim();
    const matched = head.match(/^([^（(]+)[（(]([^）)]*)[）)]\s*$/);
    const version = (matched ? matched[1] : head).trim();
    const date = matched ? matched[2].trim() : '';

    const groups: ChangeGroup[] = [];
    let group: ChangeGroup | null = null;

    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line || line.startsWith('---')) continue;

      const sec = line.match(/^###[ \t]+(.*)$/);
      if (sec) {
        group = { title: stripMarkdown(sec[1]), items: [] };
        groups.push(group);
        continue;
      }

      const item = line.match(/^[-*][ \t]+(.*)$/);
      if (item) {
        if (!group) {
          group = { title: '', items: [] };
          groups.push(group);
        }
        group.items.push(stripMarkdown(item[1]));
        continue;
      }

      // 续行：原始行带前导空白，且上一条已存在 → 并回去
      if (group && group.items.length > 0 && /^[ \t]/.test(raw)) {
        const last = group.items.length - 1;
        group.items[last] = joinWrapped(group.items[last], stripMarkdown(line));
      }
    }

    // 只有分隔线、没有实际条目的版块直接丢弃
    if (groups.some((g) => g.items.length > 0)) {
      versions.push({ version, date, groups });
    }
  }

  return versions;
}

// ─────────────── 本地（镜像内）的更新日志 ───────────────

const CHANGELOG_FILE = join(projectRoot, 'CHANGELOG.md');

/** CHANGELOG 在镜像里是静态文件，读一次就够；读不到也缓存，避免每次请求都打日志 */
let localCache: ChangeVersion[] | null = null;

export function loadLocalChangelog(): ChangeVersion[] {
  if (localCache) return localCache;
  try {
    localCache = existsSync(CHANGELOG_FILE)
      ? parseChangelog(readFileSync(CHANGELOG_FILE, 'utf-8'))
      : [];
    if (localCache.length === 0) {
      console.warn(`[changelog] 未读到更新日志：${CHANGELOG_FILE}`);
    }
  } catch (err) {
    console.warn('[changelog] 解析更新日志失败：', err);
    localCache = [];
  }
  return localCache;
}

// ─────────────── 远端（代码仓库）的更新日志 ───────────────

/**
 * 远端更新日志的来源。默认指向 Gitee 公开仓库的 CHANGELOG.md：
 *   1) raw 直链（最轻量，会 302 到 CDN，fetch 自动跟随）
 *   2) 拉不到时退到 Gitee 开放 API（内容 base64 编码）
 * 自建/换源可设 PIGGY_CHANGELOG_URL 覆盖第 1 个地址。
 */
const RAW_URL =
  process.env.PIGGY_CHANGELOG_URL || 'https://gitee.com/wdcasc/growtree/raw/main/CHANGELOG.md';
const API_URL = 'https://gitee.com/api/v5/repos/wdcasc/growtree/contents/CHANGELOG.md';

const FETCH_HEADERS = { 'User-Agent': 'GrowTree-UpdateCheck', Accept: 'text/plain, */*' };

async function fetchText(url: string, timeoutMs: number, asJson = false): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: FETCH_HEADERS, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!asJson) return text;
    const json = JSON.parse(text) as { content?: string; encoding?: string };
    if (!json.content) throw new Error('返回内容为空');
    return json.encoding === 'base64'
      ? Buffer.from(json.content, 'base64').toString('utf-8')
      : json.content;
  } finally {
    clearTimeout(timer);
  }
}

export interface RemoteChangelog {
  /** 是否成功从远端拿到（false 时 versions 退回本机镜像里的记录，仅供兜底展示） */
  ok: boolean;
  /** 数据来源：远端成功为 remote，降级为 local */
  source: 'remote' | 'local';
  /** 远端日志里的最新版本号；拿不到为 null */
  latest: string | null;
  /** 最新 N 个版本（倒序） */
  versions: ChangeVersion[];
  error?: string;
}

// 远端是个公开网页，10 分钟缓存足够；失败只缓存 1 分钟，避免网络抖动把错误钉死
let remoteCache: { at: number; value: RemoteChangelog } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface RemoteChangelogOptions {
  /** 只取最新几个版本，默认 3 */
  limit?: number;
  /** 绕过缓存（用户手动点击时用） */
  force?: boolean;
  timeoutMs?: number;
}

export async function fetchRemoteChangelog(
  opts: RemoteChangelogOptions = {},
): Promise<RemoteChangelog> {
  const now = Date.now();
  if (!opts.force && remoteCache && now - remoteCache.at < CACHE_TTL_MS) {
    return remoteCache.value;
  }

  const limit = opts.limit ?? 3;
  const timeoutMs = opts.timeoutMs ?? 8000;

  let md = '';
  let error: string | undefined;
  for (const url of [RAW_URL, API_URL]) {
    try {
      md = await fetchText(url, timeoutMs, url === API_URL);
      break;
    } catch (e: any) {
      error = e?.name === 'AbortError' ? '获取超时' : e?.message || String(e);
    }
  }

  let value: RemoteChangelog;
  if (md) {
    const all = parseChangelog(md);
    value = {
      ok: all.length > 0,
      source: 'remote',
      latest: all[0]?.version ?? null,
      versions: all.slice(0, limit),
      error: all.length > 0 ? undefined : '更新日志格式无法识别',
    };
  } else {
    // 远端拉不到（断网 / 仓库不可达）→ 退回本机镜像里的记录，前端会说明"这是已安装版本的记录"
    const local = loadLocalChangelog();
    value = {
      ok: false,
      source: 'local',
      latest: local[0]?.version ?? null,
      versions: local.slice(0, limit),
      error: error || '无法连接到代码仓库',
    };
  }

  remoteCache = { at: value.ok ? now : now - CACHE_TTL_MS + 60_000, value };
  return value;
}
