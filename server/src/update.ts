/**
 * 版本检测 + 一键升级 —— 纯阿里云 ACR 方案
 * ============================================================
 * 整条链路只有两件事，阿里云一个人全包：
 *   1) 查版本：匿名访问 ACR 的 OCI tags 接口，拿到镜像最新版本号
 *      （仓库是公开的 → 不需要任何账号密码，不需要 Gitee / GitHub）
 *   2) 拉新镜像：用户点「升级」→ 通知同 compose 里的 Watchtower 去 pull + 重建容器
 *      （Watchtower 镜像同样托管在同一个 ACR 仓库里，国内可直连）
 *
 * 两个环境变量的作用：
 *   MANALONG_VERSION   当前运行的版本号（Dockerfile 里 ENV MANALONG_VERSION=$VERSION 注入）
 *   WATCHTOWER_URL  Watchtower 的 HTTP API 地址，默认 http://watchtower:8080
 *                   （compose 里没加 watchtower 服务时，探测失败 → 前端自动降级为
 *                    "给命令让用户自己执行"，不会白屏、不会报错）
 */

const DEFAULT_REGISTRY = 'crpi-q6m49k4ufbvik9l5.cn-hangzhou.personal.cr.aliyuncs.com';
const DEFAULT_REPO = 'wdcasc/growtree';

/** 版本号形如 20261009 或 20261009-2（同日多次发版）。其余 tag（latest、-arm64 等）全部忽略。 */
const VERSION_RE = /^(\d{8})(?:-(\d+))?$/;

export interface VersionInfo {
  /** 当前容器运行的版本 */
  current: string;
  /** 仓库里的最新版本；查询失败时为 null */
  latest: string | null;
  /** 是否有新版可升级 */
  hasUpdate: boolean;
  /** 是否具备"一键升级"能力（compose 里带了 watchtower 且能连通） */
  canAutoUpdate: boolean;
  /** 查不到或不能自动升级时，给用户手动执行的命令 */
  manualCommand: string;
  /** 查询本身是否成功（网络等原因失败时为 false，前端不弹提示条） */
  ok: boolean;
  /** 最近一次检测时间（unix 秒） */
  checkedAt: number;
  error?: string;
}

function registryHost(): string {
  return process.env.MANALONG_UPDATE_REGISTRY || DEFAULT_REGISTRY;
}
/** 默认 https；本地/内网自建 registry 可设 MANALONG_UPDATE_SCHEME=http */
function registryScheme(): string {
  return process.env.MANALONG_UPDATE_SCHEME || 'https';
}
function registryBase(): string {
  return `${registryScheme()}://${registryHost()}`;
}
function repoName(): string {
  return process.env.MANALONG_UPDATE_REPO || DEFAULT_REPO;
}
export function currentVersion(): string {
  return process.env.MANALONG_VERSION || 'dev';
}

/** 把 20261009 / 20261009-2 拆成可比较的数字对 */
function parseVersion(v: string): [number, number] | null {
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  return [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0];
}

/** 在 tag 列表里挑出最大的日期版本 */
export function pickLatestTag(tags: string[]): string | null {
  let best: string | null = null;
  let bestKey: [number, number] = [-1, -1];
  for (const t of tags) {
    const key = parseVersion(t);
    if (!key) continue;
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = t;
      bestKey = key;
    }
  }
  return best;
}

/**
 * 匿名访问 ACR 列出版本。
 * OCI Distribution 规定的三步：
 *   1. GET /v2/            → 401，响应头 WWW-Authenticate 里带 realm + service
 *   2. GET realm?scope=... → 换一个匿名 Bearer token（公开仓库拿得到）
 *   3. GET /v2/<repo>/tags/list（带 token）→ { tags: [...] }
 * realm / service 是动态解析的，不写死，避免阿里云改域名后失效。
 *
 * 若该 registry 不要求鉴权（内网自建 registry 常见），/v2/ 直接 200 且没有
 * WWW-Authenticate —— 这时跳过第 2 步直接列 tags。
 */
async function fetchRemoteTags(timeoutMs = 8000): Promise<string[]> {
  const base = registryBase();
  const repo = repoName();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // 1) 拿挑战头
    const probe = await fetch(`${base}/v2/`, { signal: ctl.signal });
    const wwwAuth = probe.headers.get('www-authenticate') || '';
    const realm = /realm="([^"]+)"/.exec(wwwAuth)?.[1];
    const service = /service="([^"]+)"/.exec(wwwAuth)?.[1];

    // 2) 换匿名 token（仅在 registry 要求鉴权时）
    let token = '';
    if (realm) {
      const tokenUrl = new URL(realm);
      if (service) tokenUrl.searchParams.set('service', service);
      tokenUrl.searchParams.set('scope', `repository:${repo}:pull`);
      const tokenRes = await fetch(tokenUrl, { signal: ctl.signal });
      if (!tokenRes.ok) throw new Error(`获取 token 失败 HTTP ${tokenRes.status}`);
      const tokenJson = (await tokenRes.json()) as { token?: string; access_token?: string };
      token = tokenJson.token || tokenJson.access_token || '';
      if (!token) throw new Error('token 为空');
    } else if (!probe.ok) {
      throw new Error(`registry 探测失败 HTTP ${probe.status}`);
    }

    // 3) 列 tags
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const listRes = await fetch(`${base}/v2/${repo}/tags/list`, { headers, signal: ctl.signal });
    if (!listRes.ok) throw new Error(`列版本失败 HTTP ${listRes.status}`);
    const listJson = (await listRes.json()) as { tags?: string[] | null };
    return listJson.tags || [];
  } finally {
    clearTimeout(timer);
  }
}

/** 探测同 compose 里的 watchtower 是否活着 */
async function watchtowerAlive(timeoutMs = 1500): Promise<boolean> {
  const base = watchtowerUrl();
  if (!base) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // 只要 HTTP 端口能应答（哪怕 404）就说明 watchtower 容器活着：
    // 容器不在时，服务名解析失败/连接被拒 → fetch 直接抛错。
    // 特意用 GET / 这种没有任何路由副作用的路径，绝不能拿能触发更新的接口来探活。
    await fetch(`${base}/`, { signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function watchtowerUrl(): string {
  const url = process.env.WATCHTOWER_URL;
  if (!url) return '';
  return url.replace(/\/+$/, '');
}

const MANUAL_COMMAND = 'docker compose pull manalong && docker compose up -d manalong';

// ── 10 分钟内存缓存：镜像仓库经公网访问，别每次打开页面都打一遍 ──
let cache: { at: number; value: VersionInfo } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface StatusOptions { force?: boolean }

export async function getVersionStatus(opts: StatusOptions = {}): Promise<VersionInfo> {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const current = currentVersion();
  const base = { current, manualCommand: MANUAL_COMMAND, checkedAt: Math.floor(now / 1000) };

  let latest: string | null = null;
  let ok = false;
  let error: string | undefined;
  try {
    const tags = await fetchRemoteTags();
    latest = pickLatestTag(tags);
    ok = true;
  } catch (e: any) {
    error = e?.name === 'AbortError' ? '查询超时' : (e?.message || String(e));
  }

  const curKey = parseVersion(current);
  const latKey = latest ? parseVersion(latest) : null;
  const hasUpdate = !!(curKey && latKey && (latKey[0] > curKey[0] || (latKey[0] === curKey[0] && latKey[1] > curKey[1])));

  const canAutoUpdate = ok && hasUpdate ? await watchtowerAlive() : false;

  const value: VersionInfo = { ...base, latest, hasUpdate, canAutoUpdate, ok, error };

  // 查询失败时只缓存 1 分钟，成功了才缓存 10 分钟，避免网络抖动把错误钉死
  cache = { at: ok ? now : now - CACHE_TTL_MS + 60_000, value };
  return value;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  /** 自动升级不可用时，给前端的命令 */
  manualCommand?: string;
}

/** watchtower `POST /v1/update` 应答体里的本次扫描结果 */
interface UpdateSummary {
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
}

/** 调 Watchtower 执行一次立即更新（只作用于带 watchtower.enable=true 标签的容器） */
export async function triggerUpdate(): Promise<ApplyResult> {
  const base = watchtowerUrl();
  if (!base) {
    return { ok: false, message: '当前部署未启用一键升级', manualCommand: MANUAL_COMMAND };
  }
  const token = process.env.WATCHTOWER_TOKEN || '';

  // 先快速探活：连不上就立刻降级成"给命令自己执行"，不让用户对着转圈干等
  if (!(await watchtowerAlive())) {
    return { ok: false, message: '找不到升级服务（可能未启动）', manualCommand: MANUAL_COMMAND };
  }

  const ctl = new AbortController();
  // ⚠️ watchtower 的 /v1/update 是**同步**接口：它会一直等到把容器停稳、重建、
  // 启动完才返回。NAS 磁盘慢的时候 30~60 秒很常见（实测 31 秒），
  // 早先给 15 秒会在升级其实已经成功的情况下误报"无响应"，故给足 120 秒。
  const timer = setTimeout(() => ctl.abort(), 120_000);
  try {
    const res = await fetch(`${base}/v1/update`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ctl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: '升级服务鉴权失败（WATCHTOWER_TOKEN 不匹配）', manualCommand: MANUAL_COMMAND };
    }
    if (!res.ok) {
      return { ok: false, message: `升级服务返回 HTTP ${res.status}`, manualCommand: MANUAL_COMMAND };
    }

    // ⚠️ watchtower 的应答体里带着本次扫描结果，而它**扫不到容器时同样返回 200**：
    //    {"summary":{"scanned":0,"updated":0,...}}
    // 若照单全收当成"已开始升级"，前端会白等 5 分钟才超时，日志里也翻不出线索
    // （真实案例：容器缺 com.centurylinklabs.watchtower.enable 标签）。
    // 所以这里读一次响应体，把这类"假成功"翻译成人话。
    const raw = await res.text();
    let summary: UpdateSummary | null = null;
    try {
      summary = (JSON.parse(raw) as { summary?: UpdateSummary }).summary ?? null;
    } catch {
      // 非 JSON 应答（不同版本 watchtower 可能返回纯文本），不做判断，按成功处理
    }
    if (summary) {
      console.log(
        `[update] watchtower 扫描结果：scanned=${summary.scanned} updated=${summary.updated}` +
          ` skipped=${summary.skipped} failed=${summary.failed}`,
      );
    } else {
      console.log(`[update] watchtower 应答（HTTP ${res.status}）：${raw.slice(0, 200)}`);
    }

    if (summary && summary.scanned === 0) {
      return {
        ok: false,
        message:
          '升级服务没有找到可升级的容器（通常是容器缺少 watchtower 标签），请执行下面的命令手动升级',
        manualCommand: MANUAL_COMMAND,
      };
    }
    if (summary && summary.failed > 0) {
      return {
        ok: false,
        message: '升级执行失败（可能是拉取镜像超时或磁盘不足），请执行下面的命令手动升级',
        manualCommand: MANUAL_COMMAND,
      };
    }
    if (summary && summary.updated === 0) {
      // 扫到了容器，但 watchtower 判断"没有新镜像可拉"，于是几毫秒就返回 200。
      // 真实案例：云端 latest 标签没跟上版本 tag（发版时 latest 没更新），
      // 用户点升级「看着成功、版本没变」。这种只能提示用户重试/手动执行。
      return {
        ok: false,
        message:
          '升级服务没有拉取到新镜像（通常是云端 latest 标签尚未更新），请过几分钟再试，或执行下面的命令手动升级',
        manualCommand: MANUAL_COMMAND,
      };
    }

    // 清掉检测缓存，让升级完成后的下一次检测立刻反映新版本
    cache = null;
    return { ok: true, message: '已开始升级' };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      // 请求已经送出去了，只是对方还在忙（正在停旧容器/拉新镜像）。
      // 这不能算失败 —— 升级十有八九正在跑，交给前端轮询去确认最终结果。
      cache = null;
      return { ok: true, message: '升级已下发，正在执行（耗时较长属正常）' };
    }
    return { ok: false, message: '无法连接升级服务', manualCommand: MANUAL_COMMAND };
  } finally {
    clearTimeout(timer);
  }
}
