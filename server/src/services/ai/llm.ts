/**
 * OpenAI 兼容 /chat/completions 客户端（零依赖 fetch 实现）。
 *
 * 逻辑移植自 xiaoman 的 core-llm/OpenAiCompatibleClient + ModelProbe（Kotlin）：
 *   - 408/409/429/5xx 与网络错误按指数退避重试，尊重 Retry-After；
 *   - 报错信息永不包含 API Key（redact）；
 *   - 图片以 data URL 形式放进 content 数组（多模态识别导入的核心通道）；
 *   - probe() 给设置界面的「测试连接」按钮用：一次真实往返，
 *     且能区分「接口坏了 / 模型不识图 / 图片被拒」三种完全不同的失败。
 */

export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type LlmToolCall = { id: string; name: string; argumentsJson: string };

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LlmContentPart[] | null;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
};

export type LlmToolSpec = {
  name: string;
  description: string;
  /** JSON Schema 对象 */
  parameters: Record<string, unknown>;
};

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number | null;
  maxTokens?: number | null;
};

export type LlmResult = {
  text: string;
  toolCalls: LlmToolCall[];
  finishReason: string | null;
};

export class LlmError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'LlmError';
    this.statusCode = statusCode;
  }
}

function redact(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

function errorDetail(body: string): string {
  try {
    const root = JSON.parse(body);
    const msg = root?.error?.message ?? root?.error ?? root?.message ?? body;
    return String(msg).slice(0, 500) || '<空响应体>';
  } catch {
    return body.slice(0, 500) || '<空响应体>';
  }
}

function encodeMessage(msg: LlmMessage, apiKey: string): Record<string, unknown> {
  const out: Record<string, unknown> = { role: msg.role };
  if (Array.isArray(msg.content)) {
    out.content = msg.content.map((part) =>
      part.type === 'image_url' ? { type: 'image_url', image_url: part.image_url } : part
    );
  } else {
    out.content = msg.content;
  }
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    out.tool_calls = msg.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.argumentsJson },
    }));
    if (out.content === null) out.content = null;
  }
  if (msg.role === 'tool') {
    out.tool_call_id = msg.toolCallId ?? '';
  }
  void apiKey;
  return out;
}

function isRetryable(code: number): boolean {
  return code === 408 || code === 409 || code === 429 || (code >= 500 && code <= 599);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type LlmCallOptions = {
  tools?: LlmToolSpec[];
  timeoutSeconds?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  /** 流式输出：边生成边回调；不传 = 一次性返回（探针/判断类请求用） */
  stream?: boolean;
  /** 正文增量（流式时逐段回调） */
  onDelta?: (text: string) => void;
  /** 思考增量（火山方舟 reasoning_content 等；仅用于「思考中」状态提示） */
  onReasoning?: (text: string) => void;
};

export async function callLlm(
  config: LlmConfig,
  messages: LlmMessage[],
  opts: LlmCallOptions = {}
): Promise<LlmResult> {
  const apiKey = (config.apiKey ?? '').trim();
  let base = (config.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (base.toLowerCase().endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutSeconds = opts.timeoutSeconds ?? 120;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map((m) => encodeMessage(m, config.apiKey)),
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (config.temperature != null) body.temperature = config.temperature;
  if (config.maxTokens != null) body.max_tokens = config.maxTokens;
  if (opts.stream) body.stream = true;

  let attempt = 0;
  // 重试循环：网络错误与可重试状态码退避后重来；其余直接抛错
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(timeoutSeconds * 1000),
      });
    } catch (e) {
      // 外部主动中止（引导打断当前回答）：不重试，原样抛给调用方决定下一步
      if (opts.signal?.aborted) throw e;
      if (attempt < maxRetries && (e as Error)?.name !== 'TimeoutError') {
        await sleep(500 * 2 ** attempt++);
        continue;
      }
      throw new LlmError(redact(`请求模型接口失败：${(e as Error)?.message ?? e}`, apiKey));
    }

    if (res.ok) {
      const contentType = String(res.headers.get('content-type') ?? '').toLowerCase();
      // 流式：SSE 逐段解析；个别兼容端点忽略 stream 仍然回 JSON，就退回普通解析
      if (opts.stream && res.body && contentType.includes('text/event-stream')) {
        return readSseResponse(res, opts);
      }
      let root: any;
      try {
        root = await res.json();
      } catch {
        throw new LlmError('模型响应不是合法 JSON');
      }
      const choice = root?.choices?.[0];
      if (!choice) throw new LlmError('模型响应缺少 choices');
      const message = choice.message ?? {};
      const toolCalls: LlmToolCall[] = (message.tool_calls ?? []).map((c: any) => ({
        id: String(c.id ?? ''),
        name: String(c.function?.name ?? ''),
        argumentsJson: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
      }));
      const content = message.content;
      // content 可能是字符串，也可能是分段数组（少数兼容端点）
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((p: any) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : '')).join('')
          : '';
      return { text, toolCalls, finishReason: choice.finish_reason ?? null };
    }

    const errBody = await res.text().catch(() => '');
    if (attempt < maxRetries && isRetryable(res.status)) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 500 * 2 ** attempt++);
      attempt++;
      continue;
    }
    throw new LlmError(redact(`HTTP ${res.status}：${errorDetail(errBody)}`, apiKey), res.status);
  }
}

/** 解析 OpenAI 兼容的 SSE 流：正文/思考增量实时回调；tool_calls 是分片下发的，按 index 累积完整后交给 agent */
async function readSseResponse(res: Response, opts: LlmCallOptions): Promise<LlmResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason: string | null = null;
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(':')) continue; // 空行 / 心跳注释
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // 半包或非标准帧，跳过
        }
        if (json?.error) throw new LlmError(String(json.error?.message ?? JSON.stringify(json.error)));
        const choice = json?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          opts.onDelta?.(delta.content);
        }
        const reasoning =
          typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string'
              ? delta.reasoning
              : '';
        if (reasoning) opts.onReasoning?.(reasoning);
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = Number(tc?.index ?? toolCalls.size);
            const cur = toolCalls.get(idx) ?? { id: '', name: '', args: '' };
            if (tc?.id) cur.id = String(tc.id);
            if (tc?.function?.name) cur.name += String(tc.function.name);
            if (tc?.function?.arguments) cur.args += String(tc.function.arguments);
            toolCalls.set(idx, cur);
          }
        }
        if (choice.finish_reason) finishReason = String(choice.finish_reason);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已释放 */
    }
  }
  return {
    text,
    toolCalls: [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id, name: v.name, argumentsJson: v.args })),
    finishReason,
  };
}

/* ============================================================================
 * 测试连接（移植 ModelProbe）
 * ========================================================================== */

/** 识图探针：白底黑字，含中文「满伴」、英文「MANALONG」、数字「2026」三行文字（需能读到全部三类才算识图成功） */
const PROBE_IMAGE_DATA_URL =
  'data:image/png;base64,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';

export type ProbeReport = {
  ok: boolean;
  detail: string;
  /** true = 接口和 Key 都正常，但模型不接受图片输入 */
  visionRejected: boolean;
  /** 识图能力结论：true/false = 已确定；缺省 = 没测出来（网络/接口故障），调用方应按未知处理 */
  visionOk?: boolean;
  millis: number;
};

function looksLikeNoVision(providerMessage: string): boolean {
  const text = providerMessage.toLowerCase();
  const mentionsImage = ['image', 'vision', '图片', '图像', '视觉'].some((k) => text.includes(k));
  const denies = ['not support', 'unsupported', 'does not support', '不支持', '无法识别', 'cannot process'].some((k) =>
    text.includes(k)
  );
  return mentionsImage && denies;
}

/** 探针图里写着三行字：中文「满伴」、英文 MANALONG、数字 2026。
 *  模型要真的读到这三类内容才算识图成功 —— 只回答「白底黑字」「一张图」这种描述不算。 */
function readProbeImage(answer: string): boolean {
  const flat = answer.toLowerCase().replace(/\s+/g, '');
  const hasChinese = /[\u4e00-\u9fff]/.test(answer);
  return hasChinese && flat.includes('manalong') && flat.includes('2026');
}

/** 「测试连接」：不重试（连通性测试要秒级返回），识图探测可区分三种失败 */
export async function probeModel(cfgRaw: LlmConfig, withImage: boolean, signal?: AbortSignal): Promise<ProbeReport> {
  const cfg: LlmConfig = {
    baseUrl: (cfgRaw.baseUrl ?? '').trim(),
    apiKey: (cfgRaw.apiKey ?? '').trim(),
    model: (cfgRaw.model ?? '').trim(),
    temperature: cfgRaw.temperature,
    maxTokens: cfgRaw.maxTokens,
  };
  if (!cfg.baseUrl) return { ok: false, detail: '还没有填 Base URL', visionRejected: false, millis: 0 };
  if (!cfg.model) return { ok: false, detail: '还没有填模型名称', visionRejected: false, millis: 0 };
  const started = Date.now();
  const noRetry = { timeoutSeconds: 35, maxRetries: 0, signal };
  const messages: LlmMessage[] = withImage
    ? [
        {
          role: 'user',
          content: [
            { type: 'text', text: '逐行读出图片里的文字，原样输出，不要解释、不要补充' },
            { type: 'image_url', image_url: { url: PROBE_IMAGE_DATA_URL } },
          ],
        },
      ]
    : [{ role: 'user', content: '只回复两个字：连通' }];
  try {
    const reply = await callLlm(cfg, messages, noRetry);
    const millis = Date.now() - started;
    if (withImage) {
      // 界面只回「识图成功 / 识图失败」，对错由后台比对图里的中文 / 英文 / 数字
      const passed = readProbeImage(reply.text);
      return { ok: passed, detail: passed ? '识图成功' : '识图失败', visionRejected: false, visionOk: passed, millis };
    }
    const answer = reply.text.trim().replace(/\n/g, ' ').slice(0, 40) || '<空>';
    return { ok: true, detail: `连通 · ${millis}ms · 回复：${answer}`, visionRejected: false, millis };
  } catch (e) {
    const err = e as LlmError;
    const millis = Date.now() - started;
    if (withImage && err.statusCode && err.statusCode >= 400 && err.statusCode <= 499) {
      // 图片被拒：再用纯文本问一次，区分「接口坏」和「模型不识图」
      try {
        await callLlm(cfg, [{ role: 'user', content: '只回复两个字：连通' }], noRetry);
      } catch {
        return { ok: false, detail: err.message, visionRejected: false, millis };
      }
      const provider = err.message;
      if (looksLikeNoVision(provider)) {
        return {
          ok: false,
          detail: `接口和 Key 都没问题，但 ${cfg.model} 不接受图片输入（HTTP ${err.statusCode}）。识图导入需要换支持视觉理解的模型。`,
          visionRejected: true,
          visionOk: false,
          millis,
        };
      }
      return { ok: false, detail: `接口和 Key 都没问题，但图片请求被拒（HTTP ${err.statusCode}：${provider}）`, visionRejected: false, visionOk: false, millis };
    }
    return { ok: false, detail: err.message ?? String(e), visionRejected: false, millis };
  }
}

/* ============================================================================
 * 模型列表（移植 ModelCatalog：GET {baseUrl}/models，给设置界面的「拉取模型列表」按钮）
 * ========================================================================== */

export type ModelCatalogResult = {
  ids: string[];
  /** 每个模型官方声明的能力徽标（官方没描述的就没有） */
  entries: { id: string; badges: string[] }[];
  /** 退役/下线类被隐藏的数量 */
  retired: number;
  /** 非聊天模型（embedding/画图/语音等）或不符合能力要求被隐藏的数量 */
  unusable: number;
};

const RETIRED_HINTS = ['retir', 'deprecat', 'offline', 'archiv', 'eol', 'sunset', 'disable'];
const NON_CHAT_HINTS = [
  'embed', 'rerank', 'seedream', 'seedance', 'seed3d', 'hitem3d', 'hyper3d',
  'tts', 'asr', 'whisper', 'translation', 'ocr',
];

type CatalogEntry = { id: string; status?: string; chat: boolean | null; image: boolean | null; created: number; badges: string[] };

/** 能力徽标固定顺序：不同厂商字段顺序不同，界面按这个顺序稳定展示 */
const BADGE_ORDER = ['识图', '推理', '音频输入', '视频输入', '图片生成', '视频生成', '语音输出', '工具调用', '联网搜索', 'JSON 输出', '缓存', '文件', '批量'];

/** 把 "text+image->text" / ["image","text"] 这类声明拆成小写词元 */
function splitTokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => splitTokens(v));
  if (typeof value !== 'string') return [];
  return value
    .toLowerCase()
    .split(/[\s,+>|/:;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** supports_vision / supports-function-calling → vision / function_calling */
function normalizeFlag(token: string): string {
  return token
    .toLowerCase()
    .replace(/^supports?[_-]/, '')
    .replace(/-/g, '_')
    .trim();
}

/** 各家能力字段用的词不统一，这里做一张「词元 → 徽标」的映射表；不认识的词直接忽略 */
const FLAG_TO_BADGE: Record<string, string> = {
  tool: '工具调用',
  tools: '工具调用',
  tool_choice: '工具调用',
  tool_use: '工具调用',
  function_call: '工具调用',
  function_calling: '工具调用',
  web_search: '联网搜索',
  web_search_options: '联网搜索',
  search: '联网搜索',
  response_format: 'JSON 输出',
  response_schema: 'JSON 输出',
  json_mode: 'JSON 输出',
  json_object: 'JSON 输出',
  json_schema: 'JSON 输出',
  structured_output: 'JSON 输出',
  structured_outputs: 'JSON 输出',
  cache: '缓存',
  cache_control: '缓存',
  prefix_cache: '缓存',
  session_cache: '缓存',
  prompt_cache: '缓存',
  batch: '批量',
  batch_chat: '批量',
  file: '文件',
  files: '文件',
  file_input: '文件',
  file_upload: '文件',
  vision: '识图',
  image: '识图',
  image_input: '识图',
  image_url: '识图',
  audio: '音频输入',
  audio_input: '音频输入',
  audio_url: '音频输入',
  video: '视频输入',
  video_input: '视频输入',
  video_url: '视频输入',
  image_generation: '图片生成',
  video_generation: '视频生成',
  audio_output: '语音输出',
  reasoning: '推理',
  reasoning_effort: '推理',
  thinking: '推理',
};

/** 收集输入/输出模态声明：火山方舟 modalities、OpenRouter architecture、部分网关的 input/output */
function gatherModalities(obj: Record<string, unknown>): { inputs: Set<string>; outputs: Set<string> } {
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  const push = (set: Set<string>, value: unknown) => {
    for (const token of splitTokens(value)) set.add(token);
  };
  for (const holder of [obj, obj.modalities, obj.architecture, obj.model_info, obj.capabilities]) {
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue;
    const h = holder as Record<string, unknown>;
    push(inputs, h.input_modalities ?? h.input_modality ?? h.input);
    push(outputs, h.output_modalities ?? h.output_modality ?? h.output);
  }
  // OpenRouter 的 architecture.modality 写成 "text+image->text"
  const modality = (obj.architecture as Record<string, unknown> | undefined)?.modality ?? obj.modality;
  if (typeof modality === 'string' && modality.includes('->')) {
    const [inputPart, outputPart] = modality.split('->');
    push(inputs, inputPart);
    push(outputs, outputPart);
  }
  return { inputs, outputs };
}

/** 收集能力开关词元：supported_parameters / capabilities / features / model_info / 顶层 supports_* */
function gatherFlagTokens(obj: Record<string, unknown>): Set<string> {
  const flags = new Set<string>();
  const addArray = (value: unknown) => {
    for (const token of splitTokens(value)) flags.add(normalizeFlag(token));
  };
  const addTruthyKeys = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === true) flags.add(normalizeFlag(key));
    }
  };
  for (const key of ['supported_parameters', 'parameters', 'capabilities', 'features', 'model_info', 'api_supported', 'tags', 'type']) {
    addArray(obj[key]);
    addTruthyKeys(obj[key]);
  }
  // 再挖一层：features.tools.function_calling、features.cache.prefix_cache、api_supported.files …
  for (const key of ['features', 'capabilities', 'model_info', 'api_supported', 'modalities']) {
    const holder = obj[key];
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue;
    for (const child of Object.values(holder as Record<string, unknown>)) {
      if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
      addTruthyKeys(child);
    }
  }
  // 顶层布尔（部分网关直接给 supports_vision: true）
  addTruthyKeys(obj);
  return flags;
}

/** 从 /models 条目里提取官方声明的能力徽标；官方没写的字段一律不造谣 */
function extractBadges(obj: Record<string, unknown>): string[] {
  const { inputs, outputs } = gatherModalities(obj);
  const found = new Set<string>();
  for (const token of inputs) {
    if (token === 'image' || token === 'image_url') found.add('识图');
    else if (token === 'audio' || token === 'audio_url') found.add('音频输入');
    else if (token === 'video' || token === 'video_url') found.add('视频输入');
  }
  for (const token of outputs) {
    if (token === 'image') found.add('图片生成');
    else if (token === 'video') found.add('视频生成');
    else if (token === 'audio') found.add('语音输出');
  }
  for (const token of gatherFlagTokens(obj)) {
    const badge = FLAG_TO_BADGE[token];
    if (badge) found.add(badge);
  }
  // 部分网关把推理能力写成 capabilities.reasoning_effort: ["low","medium","high"]
  const caps = obj.capabilities as Record<string, unknown> | undefined;
  const effort = caps?.reasoning_effort ?? obj.reasoning_effort;
  if ((Array.isArray(effort) && effort.length > 0) || effort === true) found.add('推理');
  if (caps?.reasoning === true || caps?.thinking === true) found.add('推理');
  return BADGE_ORDER.filter((badge) => found.has(badge));
}

function entryToId(element: unknown): { id: string; obj: Record<string, unknown> | null } | null {
  if (typeof element === 'string' && element.trim()) return { id: element.trim(), obj: null };
  if (element && typeof element === 'object') {
    const obj = element as Record<string, unknown>;
    for (const key of ['id', 'name', 'model']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return { id: v.trim(), obj };
    }
  }
  return null;
}

/** 解析 /models 响应：火山方舟式的能力描述会被过滤，什么都不描述的端点（Ollama/vLLM）原样放行 */
export function parseModelCatalog(body: string, needImage: boolean): ModelCatalogResult {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    throw new LlmError(`返回的不是 JSON：${body.slice(0, 120)}`);
  }
  let elements: unknown[];
  if (Array.isArray(root)) {
    elements = root;
  } else if (root && typeof root === 'object') {
    const obj = root as Record<string, unknown>;
    const data = (obj.data ?? obj.models) as unknown[] | undefined;
    if (!Array.isArray(data)) {
      const errMsg =
        (obj.error as any)?.message ?? (typeof obj.error === 'string' ? obj.error : null) ?? (obj as any).message;
      throw new LlmError(String(errMsg ?? `返回里没有模型列表：${body.slice(0, 120)}`));
    }
    elements = data;
  } else {
    throw new LlmError(`返回里没有模型列表：${body.slice(0, 120)}`);
  }

  const seen = new Set<string>();
  const parsed: CatalogEntry[] = [];
  for (const element of elements) {
    const hit = entryToId(element);
    if (!hit || seen.has(hit.id)) continue;
    seen.add(hit.id);
    const obj = hit.obj;
    if (!obj) {
      parsed.push({ id: hit.id, chat: null, image: null, created: 0, badges: [] });
      continue;
    }
    // 火山方舟式能力描述：api_supported / modalities（OpenRouter 是 architecture.input_modalities）
    const apiSupported = obj.api_supported as Record<string, unknown> | undefined;
    const chatFlag = apiSupported ? apiSupported['chat/completions'] === true : null;
    const { inputs, outputs } = gatherModalities(obj);
    const chat = apiSupported ? chatFlag : outputs.size ? outputs.has('text') : null;
    const badges = extractBadges(obj);
    // 有的厂商只在能力字段里声明识图（supports_vision / capabilities:['vision']），没给模态列表
    const image = inputs.size ? inputs.has('image') : badges.includes('识图') ? true : null;
    const status = typeof obj.status === 'string' ? obj.status : undefined;
    const created = typeof obj.created === 'number' ? obj.created : 0;
    parsed.push({ id: hit.id, status, chat, image, created, badges });
  }

  // 至少一个模型描述了视觉能力 ⇒ 端点会描述这东西，沉默的条目按「不识图」处理；
  // 什么都不描述的端点（vLLM/Ollama）绝不能把整张列表过滤光。
  const describesVision = parsed.some((e) => e.image !== null);
  let retired = 0;
  let unusable = 0;
  const kept: CatalogEntry[] = [];
  for (const entry of parsed) {
    const statusLower = (entry.status ?? '').toLowerCase();
    const retiredModel = RETIRED_HINTS.some((h) => statusLower.includes(h));
    const readsImages = describesVision ? entry.image === true : entry.image !== false;
    const looksLikeNonChat =
      entry.chat === null && NON_CHAT_HINTS.some((h) => entry.id.toLowerCase().includes(h));
    if (retiredModel) retired++;
    else if (entry.chat === false || looksLikeNonChat) unusable++;
    else if (needImage && !readsImages) unusable++;
    else kept.push(entry);
  }
  kept.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  return { ids: kept.map((e) => e.id), entries: kept.map((e) => ({ id: e.id, badges: e.badges })), retired, unusable };
}

/** 拉取模型列表。错误信息永不包含 API Key。（对齐 xiaoman ModelCatalog：Key/URL 先 trim，拼接前去尾部斜杠） */
export async function listModels(baseUrl: string, apiKey: string, needImage = false): Promise<ModelCatalogResult> {
  const key = (apiKey ?? '').trim();
  let base = (baseUrl ?? '').trim().replace(/\/+$/, '');
  // 常见误填：把带动作段的地址粘进来（chat/completions、responses 等）—— 剪掉动作段，只留站点前缀
  const ACTION_SEGMENTS = ['/chat/completions', '/responses', '/completions', '/embeddings'];
  for (;;) {
    const lower = base.toLowerCase();
    const hit = ACTION_SEGMENTS.find((s) => lower.endsWith(s));
    if (!hit) break;
    base = base.slice(0, base.length - hit.length).replace(/\/+$/, '');
  }
  if (!base) throw new LlmError('Base URL 为空');
  let res: Response;
  try {
    res = await fetch(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}`, Accept: 'application/json' } : { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new LlmError(redact(`无法连接 ${base}/models：${(e as Error)?.message ?? e}`, key));
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    throw new LlmError(redact(`HTTP ${res.status}：${errorDetail(body)}`, key), res.status);
  }
  return parseModelCatalog(body, needImage);
}