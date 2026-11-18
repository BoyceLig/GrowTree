import { getDb } from '../../db/index.js';

/**
 * AI 设置的持久化：全部塞进 settings 这张 KV 表（见 db/schema.sql），
 * 不为 AI 单独建配置表 —— 配置项是「一坨整体 JSON」，KV 正合适。
 *
 * 两个 key：
 *   ai_api  模型供应商（智谱 / DeepSeek / 火山方舟 / MiniMax / 自定义），
 *           每个供应商自带 baseUrl + apiKey + 模型名，聊天与识图各有一个开关，
 *           两种用途各自最多只有一个供应商开启；
 *   ai_mcp  MCP 服务器配置（标准 mcpServers 形状，兼容社区通用格式）
 * （技能已改为目录制：<DATA_DIR>/skills/<文件夹>/SKILL.md，见 services/ai/skills.ts）
 *
 * 读取侧全部「坏数据当默认值」：JSON 解析失败不抛错，返回缺省配置，
 * AI 功能没配置就不可用，绝不能因为配置坏了把整个服务端拖死。
 */

/** 供应商类型：决定默认 baseUrl 与显示名，自定义类型由用户全填 */
export type AiProviderKind = 'zhipu' | 'deepseek' | 'ark' | 'minimax' | 'custom';

/** 一个供应商 = 一套可用的接口配置（聊天与识图可分别开关，互不影响） */
export type AiProvider = {
  /** 稳定 id，前端生成；同名/非法 id 读取时会自动纠正 */
  id: string;
  kind: AiProviderKind;
  /** 显示名，如「智谱 API」「工作用 DeepSeek」 */
  name: string;
  /** OpenAI 兼容 base url，如 https://open.bigmodel.cn/api/paas/v4 */
  baseUrl: string;
  apiKey: string;
  /** 聊天模型名 */
  model: string;
  /** 可选：图片识别模型；留空 = 沿用聊天模型 */
  visionModel: string;
  /** 聊天模型开关：全局最多一个为 true */
  chatEnabled: boolean;
  /** 图片识别开关：全局最多一个为 true，与聊天开关独立 */
  visionEnabled: boolean;
};

/** ai_api 里真正落盘的结构 */
export type AiApiSettings = {
  providers: AiProvider[];
  temperature: number | null;
  maxTokens: number | null;
  /** 上下文窗口（tokens）；留空 = 不按窗口裁剪历史 */
  contextWindow: number | null;
};

/** 解析后的「当前启用供应商」扁平视图：给 llm / agent / 聊天页判断可用性用 */
export type ResolvedAiApi = {
  baseUrl: string;
  apiKey: string;
  /** 聊天模型 */
  chatModel: string;
  /** 图片识别模型（留空 = chatModel） */
  visionModel: string;
  temperature: number | null;
  maxTokens: number | null;
  /** 上下文窗口（tokens），留空 = 不限制 */
  contextWindow: number | null;
  providerId: string;
  providerName: string;
};

export const DEFAULT_AI_API: AiApiSettings = { providers: [], temperature: null, maxTokens: null, contextWindow: null };

export const AI_PROVIDER_KINDS: AiProviderKind[] = ['zhipu', 'deepseek', 'ark', 'minimax', 'custom'];

export const AI_PROVIDER_KIND_LABEL: Record<AiProviderKind, string> = {
  zhipu: '智谱 API',
  deepseek: 'DeepSeek API',
  ark: '火山方舟 API',
  minimax: 'MiniMax API',
  custom: '自定义供应商',
};

/** 一个 MCP 服务器的连接配置。url（HTTP 传输）与 command（stdio 传输）二选一 */
export type McpServerEntry = {
  title?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  /** 写操作确认策略：writes=疑似写操作需确认 / all=每次调用都要确认 / none=不确认 */
  confirm?: 'writes' | 'all' | 'none';
  /** 只暴露这些工具（缺省=全部） */
  tools?: string[];
  timeoutSeconds?: number;
};

function readKey<T>(key: string, fallback: T, validate: (v: unknown) => T): T {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    return validate(JSON.parse(row.value));
  } catch {
    return fallback;
  }
}

function writeKey(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
    )
    .run(key, JSON.stringify(value));
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asKind(v: unknown): AiProviderKind {
  return AI_PROVIDER_KINDS.includes(v as AiProviderKind) ? (v as AiProviderKind) : 'custom';
}

/** 聊天与识图各自只允许一个供应商开启（两个开关互不影响） */
function normalizeSwitches(providers: AiProvider[]): AiProvider[] {
  let chatPicked = false;
  let visionPicked = false;
  for (const p of providers) {
    if (p.chatEnabled && !chatPicked) chatPicked = true;
    else p.chatEnabled = false;
    if (p.visionEnabled && !visionPicked) visionPicked = true;
    else p.visionEnabled = false;
  }
  return providers;
}

function parseProviders(raw: unknown): AiProvider[] {
  if (!Array.isArray(raw)) return [];
  const out: AiProvider[] = [];
  const used = new Set<string>();
  for (const item of raw) {
    if (out.length >= 20) break; // 供应商数量上限，防止脏数据撑爆界面
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const kind = asKind(r.kind);
    let id = asString(r.id).trim();
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || used.has(id)) {
      let n = out.length + 1;
      id = `${kind}-${n}`;
      while (used.has(id)) id = `${kind}-${++n}`;
    }
    used.add(id);
    // 老配置只有一个 enabled：迁移成「聊天 + 识图都开」，之后由用户按需拆开
    const legacyEnabled = r.enabled !== false;
    out.push({
      id,
      kind,
      name: asString(r.name).trim() || AI_PROVIDER_KIND_LABEL[kind],
      baseUrl: asString(r.baseUrl).trim(),
      apiKey: asString(r.apiKey).trim(),
      model: asString(r.model).trim(),
      visionModel: asString(r.visionModel).trim(),
      chatEnabled: typeof r.chatEnabled === 'boolean' ? r.chatEnabled : legacyEnabled,
      visionEnabled: typeof r.visionEnabled === 'boolean' ? r.visionEnabled : legacyEnabled,
    });
  }
  return normalizeSwitches(out);
}

/** 旧版单套配置（baseUrl/apiKey/chatModel/visionModel）→ 一个供应商（按域名猜厂商） */
function migrateLegacyProviders(r: Record<string, unknown>): AiProvider[] {
  const baseUrl = asString(r.baseUrl).trim();
  const apiKey = asString(r.apiKey).trim();
  const model = asString(r.chatModel).trim() || asString(r.visionModel).trim();
  if (!baseUrl && !apiKey && !model) return [];
  const kind = guessKindByBaseUrl(baseUrl);
  return [
    {
      id: 'custom-1',
      kind,
      name: AI_PROVIDER_KIND_LABEL[kind],
      baseUrl,
      apiKey,
      model,
      visionModel: '',
      chatEnabled: true,
      visionEnabled: true,
    },
  ];
}

/** 老配置没存厂商类型：按 baseUrl 域名认出常见厂商，认不出就当自定义 */
function guessKindByBaseUrl(baseUrl: string): AiProviderKind {
  const url = baseUrl.toLowerCase();
  if (url.includes('bigmodel.cn')) return 'zhipu';
  if (url.includes('deepseek.com')) return 'deepseek';
  if (url.includes('volces.com') || url.includes('ark.cn-beijing')) return 'ark';
  if (url.includes('minimax')) return 'minimax';
  return 'custom';
}

export function getAiApiSettings(): AiApiSettings {
  return readKey<AiApiSettings>('ai_api', { ...DEFAULT_AI_API, providers: [] }, (raw) => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_AI_API, providers: [] };
    const r = raw as Record<string, unknown>;
    const providers = Array.isArray(r.providers) ? parseProviders(r.providers) : migrateLegacyProviders(r);
    return {
      providers,
      temperature: numOrNull(r.temperature),
      maxTokens: numOrNull(r.maxTokens),
      contextWindow: numOrNull(r.contextWindow),
    };
  });
}

export function setAiApiSettings(cfg: AiApiSettings): void {
  writeKey('ai_api', {
    providers: normalizeSwitches(
      cfg.providers.map((p) => ({
        ...p,
        name: p.name.trim(),
        baseUrl: p.baseUrl.trim(),
        apiKey: p.apiKey.trim(),
        model: p.model.trim(),
        visionModel: p.visionModel.trim(),
      }))
    ),
    temperature: numOrNull(cfg.temperature),
    maxTokens: numOrNull(cfg.maxTokens),
    contextWindow: numOrNull(cfg.contextWindow),
  });
}

/** 当前启用的聊天供应商（没有就返回 undefined，等价于「AI 未配置」） */
export function getActiveAiProvider(): AiProvider | undefined {
  return getAiApiSettings().providers.find((p) => p.chatEnabled);
}

/** 当前启用的识图供应商；没单独开启识图时回落到聊天供应商（沿用其识图模型或聊天模型） */
export function getActiveVisionProvider(): AiProvider | undefined {
  const providers = getAiApiSettings().providers;
  return providers.find((p) => p.visionEnabled) ?? providers.find((p) => p.chatEnabled);
}

export function findAiProvider(id: string): AiProvider | undefined {
  return getAiApiSettings().providers.find((p) => p.id === id);
}

/** 扁平视图：llm / agent 只关心「用哪个地址、哪个 Key、哪个模型」 */
export function getAiApi(): ResolvedAiApi {
  const cfg = getAiApiSettings();
  const p = cfg.providers.find((x) => x.chatEnabled);
  return {
    baseUrl: p?.baseUrl ?? '',
    apiKey: p?.apiKey ?? '',
    chatModel: p?.model ?? '',
    visionModel: p?.visionModel ?? '',
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    contextWindow: cfg.contextWindow,
    providerId: p?.id ?? '',
    providerName: p?.name ?? '',
  };
}

/** 识图调用的接口配置：识图供应商优先，没开识图就用聊天供应商 */
export type ResolvedVisionApi = {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string;
  providerName: string;
};

export function getAiVisionApi(): ResolvedVisionApi {
  const p = getActiveVisionProvider();
  return {
    baseUrl: p?.baseUrl ?? '',
    apiKey: p?.apiKey ?? '',
    model: p?.visionModel || p?.model || '',
    providerId: p?.id ?? '',
    providerName: p?.name ?? '',
  };
}

export function getAiMcp(): Record<string, McpServerEntry> {
  return readKey<Record<string, McpServerEntry>>('ai_mcp', {}, (raw) => {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, McpServerEntry> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      out[name] = {
        title: asString(v.title) || name,
        url: typeof v.url === 'string' && v.url.trim() ? v.url.trim() : undefined,
        headers: (v.headers && typeof v.headers === 'object' ? v.headers : {}) as Record<string, string>,
        command: asString(v.command).trim() || undefined,
        args: Array.isArray(v.args) ? v.args.map((a) => asString(a)) : [],
        env: (v.env && typeof v.env === 'object' ? v.env : {}) as Record<string, string>,
        enabled: v.enabled !== false,
        confirm: v.confirm === 'all' || v.confirm === 'none' ? v.confirm : 'writes',
        tools: Array.isArray(v.tools) ? v.tools.map((t) => asString(t)) : undefined,
        timeoutSeconds: typeof v.timeoutSeconds === 'number' && v.timeoutSeconds > 0 ? v.timeoutSeconds : 30,
      };
      // url 与 command 必须二选一，两个都没有的服务器丢弃
      if (!out[name].url && !out[name].command) delete out[name];
    }
    return out;
  });
}

export function setAiMcp(servers: Record<string, McpServerEntry>): void {
  writeKey('ai_mcp', servers ?? {});
}

/** API key 是否已配置（给聊天页判断「AI 是否可用」用，不回传 key 本身） */
export function getAiReadiness(): { configured: boolean; chatModel: string; providerName: string } {
  const p = getActiveAiProvider();
  return {
    configured: Boolean(p && p.baseUrl && p.apiKey && p.model),
    chatModel: p?.model ?? '',
    providerName: p?.name ?? '',
  };
}