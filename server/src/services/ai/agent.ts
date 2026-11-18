import path from 'node:path';
import { readFileSync } from 'node:fs';
import { getDb } from '../../db/index.js';
import { config } from '../../config.js';
import { pushToUser } from '../../ws.js';
import { callLlm, LlmError, probeModel, type LlmMessage, type LlmToolSpec, type LlmContentPart } from './llm.js';
import { getAiApi, getAiVisionApi, getAiMcp } from './settings.js';
import { buildSkillsPromptSection, listSkills } from './skills.js';
import { builtinToolNames, builtinToolSpecs, executeBuiltinTool, executeMcp } from './tools.js';
import { parseMcpServersWithEnv, listMcpTools, type ParsedMcpEntry } from './mcp.js';
import { searchMemory } from './memory.js';
import { openQuestion, cancelSessionQuestions } from './questions.js';
import { buildFamilySnapshot } from './context.js';
import { webSearch, fetchPage } from './web.js';
import { startTurn, updateTurn, endTurn, setPlan, type TurnPhase, type PlanStep } from './turnState.js';
import { listQueue, takeNextQueueItem, prependQueueItem } from './queue.js';
import { clearTaskScope } from './sentinel.js';

/**
 * AI 对话的 agent 循环 —— 逻辑移植自 xiaoman XiaomanAgent.handle()：
 *   system(persona + 技能 + 记忆命中) + 有界历史 + 当前输入 → 最多 N 轮 tool-calls，
 *   每轮把文本增量推给前端（ai_chat_delta），工具调用明细推（ai_chat_tool），
 *   全部结束后推 ai_chat_done / ai_chat_error。
 *
 * v2（对齐 xiaoman 分层）：
 *   - 模式开关移除：工具循环常开，能不能「动手」由 Sentinel 看门；
 *   - 记忆层接入：用户消息先做中文检索，命中注入 system prompt；
 *     memory_save/memory_search 工具暴露给模型；
 *   - 经验沉淀：回合成功且执行过工具 → learnExperience 写入 howto 笔记；
 *   - 回合结束 clearTaskScope：「本次任务都允许」的放行随任务终结。
 */

const MAX_TOOL_ROUNDS = 8;
const HISTORY_LIMIT = 60;

export type AttachmentInput = { kind: 'image' | 'file'; url: string; name: string; mime: string; size: number };

/* ── 附件处理 ──────────────────────────────────────────────────────────── */

/** attachments 里的 url 形如 /uploads/xxx.png —— 还原成数据目录里的真实文件 */
function resolveUploadPath(url: string): string | null {
  const m = /^\/uploads\/([A-Za-z0-9._-]+)$/.exec(url);
  if (!m) return null;
  const filePath = path.join(config.dataDir, 'uploads', m[1]);
  const normalized = path.normalize(filePath).toLowerCase();
  if (!normalized.startsWith(path.join(config.dataDir, 'uploads').toLowerCase())) return null;
  return filePath;
}

/** 单条附件 → 内容段（图片转 data URL；文本/PDF 抽出文字）；出错返回提示文本 */
function attachmentToParts(att: { kind: string; url: string; name: string; mime: string; extracted?: string }): {
  parts: LlmContentPart[];
  text: string;
} {
  const safeName = att.name || '附件';
  if (att.kind === 'image') {
    const filePath = resolveUploadPath(att.url);
    if (!filePath) return { parts: [], text: `[附件 ${safeName}：地址无效]` };
    try {
      const buf = readFileSync(filePath);
      if (buf.length > 8 * 1024 * 1024) return { parts: [], text: `[图片 ${safeName} 超过 8MB，未读取]` };
      const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return {
        parts: [{ type: 'image_url', image_url: { url: `data:image/${mime};base64,${buf.toString('base64')}` } }],
        text: '',
      };
    } catch {
      return { parts: [], text: `[图片 ${safeName} 读取失败]` };
    }
  }
  // 文本类附件：发送时已抽取并随消息存库（att.extracted），这里直接用
  if (att.extracted) {
    return { parts: [], text: `\n\n【附件 ${safeName} 内容】\n${att.extracted.slice(0, 30000)}` };
  }
  return { parts: [], text: `[附件 ${safeName} 无法读取内容]` };
}

/** 发送消息时立即抽取文本附件内容（txt/md/csv/json/pdf），存进 attachments.extracted */
export async function extractAttachment(att: { kind: string; url: string; name: string; mime: string }): Promise<string> {
  const filePath = resolveUploadPath(att.url);
  if (!filePath) return '';
  if (att.kind === 'image') return '';
  try {
    const buf = readFileSync(filePath);
    if (/\.pdf$/i.test(att.name)) {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      const result = await parser.getText();
      await parser.destroy().catch(() => {});
      return (result.text || '').replace(/\u0000/g, '').slice(0, 30000);
    }
    return buf.toString('utf-8').slice(0, 30000);
  } catch (e) {
    return `[文件内容读取失败：${(e as Error)?.message ?? e}]`;
  }
}

/* ── 会话与消息持久化 ──────────────────────────────────────────────────── */

type AiMessageRow = {
  id: number;
  session_id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  attachments: string | null;
  meta: string | null;
  created_at: number;
};

function touchSession(sessionId: number, titleFrom?: string): void {
  const db = getDb();
  if (titleFrom) {
    db.prepare(
      `UPDATE ai_sessions SET updated_at = unixepoch(),
         title = CASE WHEN title = '新对话' AND ? != '' THEN substr(?, 1, 20) ELSE title END
       WHERE id = ?`
    ).run(titleFrom.trim(), titleFrom.trim(), sessionId);
  } else {
    db.prepare('UPDATE ai_sessions SET updated_at = unixepoch() WHERE id = ?').run(sessionId);
  }
}

function insertMessage(sessionId: number, role: 'user' | 'assistant' | 'tool', content: string, attachments?: unknown, meta?: unknown): number {
  const row = getDb()
    .prepare(
      `INSERT INTO ai_messages (session_id, role, content, attachments, meta)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(sessionId, role, content, attachments ? JSON.stringify(attachments) : null, meta ? JSON.stringify(meta) : null);
  return Number(row.lastInsertRowid);
}

/** 把 ai_messages 的尾部重放成 OpenAI 协议的 messages 数组 */
function rebuildHistory(sessionId: number): LlmMessage[] {
  const rows = (
    getDb()
      .prepare(`SELECT * FROM ai_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
      .all(sessionId, HISTORY_LIMIT) as AiMessageRow[]
  ).reverse();

  const messages: LlmMessage[] = [];
  for (const row of rows) {
    if (row.role === 'user') {
      const atts = safeParse(row.attachments) as any[] | null;
      const parts: LlmContentPart[] = [];
      let text = row.content;
      if (atts) {
        for (const att of atts) {
          const { parts: imgParts, text: fileText } = attachmentToParts(att);
          parts.push(...imgParts);
          text += fileText;
        }
      }
      messages.push({ role: 'user', content: parts.length ? [{ type: 'text', text: text || '（见附件）' }, ...parts] : text });
    } else if (row.role === 'assistant') {
      const meta = safeParse(row.meta) as any;
      const toolCalls = meta?.toolCalls;
      if (Array.isArray(toolCalls) && toolCalls.length) {
        messages.push({ role: 'assistant', content: row.content || null, toolCalls });
      } else if (row.content) {
        messages.push({ role: 'assistant', content: row.content });
      }
    } else {
      const meta = safeParse(row.meta) as any;
      messages.push({ role: 'tool', content: row.content, toolCallId: String(meta?.toolCallId ?? '') });
    }
  }
  return trimDanglingToolMessages(messages);
}

/** 粗估 token：全角字符约 1 token/字，其余约 4 字符/token（只用于按上下文窗口裁剪历史，不求精确） */
function estimateTokens(text: string): number {
  let full = 0;
  for (const ch of text) {
    if (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch)) full++;
  }
  return Math.ceil(full + (text.length - full) / 4);
}

function messageTokens(msg: LlmMessage): number {
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, part) => sum + (part.type === 'image_url' ? 1200 : estimateTokens(part.text ?? '')), 0);
  }
  return estimateTokens(msg.content ?? '') + (msg.toolCalls?.length ? 200 : 0);
}

/** 按上下文窗口预算裁剪历史：从最旧的开始丢，至少保留最后一条 */
function trimHistoryToBudget(messages: LlmMessage[], budgetTokens: number): LlmMessage[] {
  if (!budgetTokens || budgetTokens <= 0) return messages;
  let total = messages.reduce((sum, m) => sum + messageTokens(m), 0);
  if (total <= budgetTokens) return messages;
  const out = [...messages];
  while (out.length > 1 && total > budgetTokens) {
    total -= messageTokens(out.shift()!);
  }
  return trimDanglingToolMessages(out);
}

function trimDanglingToolMessages(messages: LlmMessage[]): LlmMessage[] {
  const out = [...messages];
  while (out.length && (out[0].role === 'assistant' || out[0].role === 'tool')) out.shift();
  const cleaned: LlmMessage[] = [];
  for (const msg of out) {
    if (msg.role === 'tool') {
      const prev = cleaned[cleaned.length - 1];
      if (!prev || prev.role !== 'assistant' || !prev.toolCalls?.some((c) => c.id === msg.toolCallId)) continue;
    }
    cleaned.push(msg);
  }
  return cleaned;
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ── MCP 工具装配 ──────────────────────────────────────────────────────── */

async function gatherMcpTools(): Promise<{ specs: LlmToolSpec[]; servers: ParsedMcpEntry[]; warnings: string[] }> {
  const parsed = parseMcpServersWithEnv(getAiMcp());
  const specs: LlmToolSpec[] = [];
  const warnings: string[] = [];
  for (const server of parsed.servers) {
    const tools = await listMcpTools(server.name, server.entry);
    if (!tools.ok) {
      warnings.push(`MCP「${server.name}」连接失败：${tools.error}`);
      continue;
    }
    for (const tool of tools.tools) {
      // 工具名加服务器前缀，避免多个 MCP 服务器同名工具打架；模型看到的名字一致
      specs.push({
        name: `mcp_${server.name}_${tool.name}`,
        description: `[MCP:${server.entry.title || server.name}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      });
    }
  }
  return { specs, servers: parsed.servers, warnings };
}

/** mcp_<server>_<tool> → 原始 server / tool */
function splitMcpToolName(callName: string, servers: ParsedMcpEntry[]): { server: ParsedMcpEntry; tool: string } | null {
  if (!callName.startsWith('mcp_')) return null;
  const rest = callName.slice(4);
  for (const server of servers) {
    if (rest.startsWith(`${server.name}_`)) {
      return { server, tool: rest.slice(server.name.length + 1) };
    }
  }
  return null;
}

/* ── system prompt ─────────────────────────────────────────────────────── */

/**
 * 系统提示词 = 身份 + 判定标准 + 实时事实。
 *
 * 写得长而具体是有意的：模型「像关键词匹配」通常不是模型不行，
 * 而是提示词只给了角色、没给「什么算理解对了」「什么情况下必须先问」。
 * 这里把槽位补齐顺序、指代解析规则、来源标注义务都写成硬规则。
 */
function systemPrompt(
  now: Date,
  memoryHits: { title: string; snippet: string }[],
  snapshot: string,
  userName: string
): string {
  const time = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const parts = [
    '你是「满伴」家庭积分管理系统里的 AI 助手，服务对象是家长。说话的人就是家长本人。',
    '满伴的业务：家长给孩子布置任务、审核完成、加减积分，孩子攒积分在商城兑换心愿。',
    '',
    '# 家庭实时快照（每轮刷新，属于确定事实）',
    snapshot,
    `- 当前时间：${time}；当前家长：${userName || '家长'}。`,
    '',
    '# 一、先理解，再动手（最重要）',
    '家长说话经常不完整。你的任务是把它补成一条可执行的操作，而不是按字面关键词去匹配。',
    '动手前固定走四步：识别意图 → 补齐槽位 → 检查歧义 → 执行或追问。',
    '',
    '槽位补齐规则：',
    '1. 对象：家长说「孩子 / 娃 / 他 / 她 / 老大」时，按上面的家庭快照解析。',
    '   - 只有 1 个孩子 → 直接用他的 id，不要反问「是哪个孩子」。',
    '   - 多个孩子且家长点了名 → 用快照里对应的 id；名字对不上任何孩子时用 ask_user 让家长选，不要自己挑一个。',
    '   - 多个孩子且没点名 → 用 ask_user 问「这次是给哪个孩子」。',
    '2. 数值：家长给了就用。没说且无法从上下文推断时，用 ask_user 问清楚，不要默认填 1 分或 100 分。',
    '3. 理由（note）：加减积分必须有理由。',
    '   - 家长说了理由 → 直接采用，可适度精简成一句话。',
    '   - 家长没说 → 必须用 ask_user 问一句「这次加分 / 扣分的原因是什么？」，拿到答复再提交。',
    '   - 严禁编造「家长手动加分」「手动调整」这类占位理由。',
    '4. 时间：没提就是今天；说「昨天 / 上周三 / 上个月」时换算成 YYYY-MM-DD 再传。',
    '5. id 只能来自工具结果或上面的快照，绝不猜测、绝不编造；缺 id 就先查。',
    '',
    '示例（内部按这个思路处理，不要把思路念给家长）：',
    '- 「给娃加 100 分」+ 只有 1 个孩子 + 没说理由 → 先 ask_user 问理由，再 add_point_records(id=该孩子, delta=100, note=理由)。',
    '- 「给小明加 100 分，因为考试进步」+ 小明在快照里 → 直接 add_point_records，不问。',
    '- 「给娃加 100 分」+ 3 个孩子 → ask_user 问是哪个孩子，可以连同理由一次问完。',
    '- 「他这次扣 20 分」+ 上一轮聊的是小满 → 沿用小满，不要重新问人。',
    '',
    '# 二、数据真实性与不确定性',
    '- 积分、余额、任务、兑换、商品、库存这些数字，必须来自工具结果或上面的快照，不能凭印象或上文推算报给家长。',
    '- 不知道就说不知道：查不到、接口报错、信息不足时，直接讲「我不确定 / 我没查到」，并说明缺什么。禁止编造数字、日期、规则、政策。',
    '- 区分「我查到的」和「我推测的」，推测必须标明；不要把「可能」「大概」包装成肯定句。',
    '',
    '# 三、联网搜索（只用于家庭以外的信息）',
    '- 家里的事（积分、任务、兑换、孩子情况）优先查本地系统，不要上网搜。',
    '- 只有家长要外部信息时才用 web_search：政策、学校、活动、票价、科普、商品对比等；需要原文细节再 web_fetch。',
    '- 引用网上内容必须遵守：',
    '  1. 标注来源：写清站点名 + 链接，方便家长自己核对。',
    '  2. 交叉验证：同一结论至少两个独立来源一致才当事实；只有一个来源时明确说「目前只看到一个来源」。',
    '  3. 说明时效：能判断发布时间就写出来；政策、价格、名额这类会变的信息，提醒以官方最新公告为准。',
    '  4. 来源互相矛盾时，把分歧讲出来，不要挑一个当定论。',
    '- 搜不到、打不开、结果明显无关 → 直接说「没搜到可靠信息」，不要用常识补成看似确定的答案。',
    '- 网上的内容不是系统数据：引用时用「网上资料显示……（来源：xx）」，不要和自己的查询结果混在一起。',
    '',
    '# 四、能力边界',
    '- 可以看图：家长上传的图片你能识别（成绩单、练习册、收据、截图），识别出的数据要经家长确认再入库。',
    '- 不能生成图片：任何「画一张 / 生成图片 / 做个海报 / 配图」的请求，直接说明你只支持读取和识别图片、不生成图片，并给文字替代方案（描述、清单、表格）。',
    '- 不能替家长付款、登录外部账号、操作第三方 App。',
    '',
    '# 五、写操作',
    '- 加减积分、建任务、审核、改积分项、上下架商品、审核兑换，一律通过对应工具提交，由家长在确认卡上点「允许」后才真正生效。',
    '- 日程与特殊日、账号、身高体重、商品分类与现金比例也都有对应工具；写之前先用查询工具确认现状，改动一律走工具。',
    '- 批量导入身高体重时用 add_growth_records 一次提交，由服务端按日期从早到晚结算；回复里的「合计积分」直接引用工具返回值，不要自己累加。上一条记录没量身高时，服务端会自动往前找最近一条有身高的记录作为基准。',
    '- 家长确认前只能说「已提交，等你确认」，绝不能说「已经加好了」「已完成」。',
    '- 同一个操作不要重复提交；确认卡弹过一次就等结果。',
    '',
    '# 六、工具与计划',
    '- 多步骤任务（3 步以上）先在 update_plan 里列步骤，开始 / 完成一步就更新状态。',
    '- ask_user 一次把要问的问完（最多 4 题），家长答过的不要再问。',
    '- 同一个信息不要反复查；工具报错就说清原因，不要静默重试同一调用。',
    '',
    '# 七、长期记忆',
    '- 只记「工具查不到、长期有用」的信息：家长的偏好与忌讳、说话与操作习惯、常用流程、沟通方式。',
    '- 不要记积分、余额、任务完成情况、兑换记录、孩子资料等能实时查到的数据——记了也会和真实数据对不上。',
    '- 家长提到上述长期信息时主动 memory_save；回答「上次 / 之前 / 习惯」类问题前先 memory_search。',
    '- 记忆是历史观察，可能过时，引用时注明「根据之前记录」。',
    '',
    '# 八、长流程沉淀',
    '- 一次任务步骤较多（5 步以上），或家长反复交代同一套做法时，收尾用 ask_user 问「要不要把这套流程存成技能？」；家长同意后才调用 create_skill。',
    '',
    '# 九、回答风格',
    '- 简体中文，自然亲和，能精炼就精炼；先给结论，再给必要细节。',
    '- 做完一件事给一句总结：做了什么、结果如何、下一步建议。',
    '- 不确定的事就说「不确定」，不要为了显得专业而硬答。',
    buildSkillsPromptSection(),
  ].filter(Boolean);
  if (memoryHits.length) {
    parts.push('', '## 相关记忆（来自长期记忆的检索命中，可能过时）');
    for (const hit of memoryHits) parts.push(`- 【${hit.title}】${hit.snippet}`);
  }
  return parts.join('\n');
}

/* ── 主循环 ────────────────────────────────────────────────────────────── */

/** 工具参数预览：给界面「这一步到底传了什么」用，超长截断，避免刷屏 */
function previewArgs(argsJson: string, limit = 600): string {
  const raw = (argsJson ?? '').trim();
  if (!raw) return '';
  try {
    const text = JSON.stringify(JSON.parse(raw));
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return raw.slice(0, limit);
  }
}

/** 当前这轮消息里带图片就改用「图片识别模型」（留空时 getAiApi 已回落为聊天模型） */
function messagesHaveImage(messages: LlmMessage[]): boolean {
  // 只看最新一条用户消息：历史轮次里的图片不该让后续纯文字对话一直走识图模型
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser || !Array.isArray(lastUser.content)) return false;
  return lastUser.content.some((part) => (part as { type?: string })?.type === 'image_url');
}

/** 识图能力缓存：同一接口 + 模型 10 分钟内只探测一次，避免每条带图消息都多打一次模型 */
const visionCapability = new Map<string, { ok: boolean; at: number }>();
const VISION_CACHE_TTL = 10 * 60 * 1000;

/**
 * 确认识图供应商的模型是否真的能看图。
 * 返回 true / false = 已确定；null = 探测本身失败（网络、接口故障），按未知处理，不拦。
 */
async function checkVisionSupport(
  target: { baseUrl: string; apiKey: string; model: string },
  opts: { temperature: number | null; maxTokens: number | null },
  signal: AbortSignal
): Promise<boolean | null> {
  if (!target.baseUrl || !target.apiKey || !target.model) return null;
  const key = `${target.baseUrl}|${target.model}`;
  const hit = visionCapability.get(key);
  if (hit && Date.now() - hit.at < VISION_CACHE_TTL) return hit.ok;
  const report = await probeModel(
    { ...target, temperature: opts.temperature, maxTokens: opts.maxTokens },
    true,
    signal
  );
  // 只缓存确定的结论；网络/接口故障下次还要重测
  if (typeof report.visionOk !== 'boolean') return null;
  visionCapability.set(key, { ok: report.visionOk, at: Date.now() });
  return report.visionOk;
}

const runningSessions = new Set<number>();
/** 正在进行的回合收到的「引导」：下一次调模型前作为补充消息插入 */
const activeGuidance = new Map<number, string[]>();
/** 当前回合正在等模型返回的请求：收到引导时直接打断，让模型立刻带上补充重新回答 */
const activeAbort = new Map<number, AbortController>();
/** 家长点了「停止」的回合：打断请求后保留已输出内容，按正常结束处理 */
const stopRequested = new Set<number>();

export function isSessionRunning(sessionId: number): boolean {
  return runningSessions.has(sessionId);
}

/** 把一条消息作为引导补进正在进行的回合；没有进行中的回合返回 false */
export function pushGuidance(sessionId: number, text: string): boolean {
  if (!runningSessions.has(sessionId)) return false;
  const list = activeGuidance.get(sessionId) ?? [];
  list.push(text);
  activeGuidance.set(sessionId, list);
  // 正在流式输出就把这次请求打断：半截回答丢掉，下一轮带上引导重新回答
  activeAbort.get(sessionId)?.abort();
  return true;
}

/** 家长点「停止」：立刻打断当前模型请求，已输出的半截回答会保留；没有进行中的回合返回 false */
export function stopSession(sessionId: number): boolean {
  if (!runningSessions.has(sessionId)) return false;
  stopRequested.add(sessionId);
  // 卡在问答面板时先关掉，让等待中的工具调用立刻返回
  cancelSessionQuestions(sessionId);
  activeAbort.get(sessionId)?.abort();
  return true;
}

export type TurnInput = {
  sessionId: number;
  userId: number;
  userName: string;
  text: string;
  attachments: AttachmentInput[];
};

export type TurnResult = { ok: true; userMessageId: number; taskId: string } | { ok: false; error: string };

/**
 * 把队首消息拎出来执行。回合结束时、以及「空闲时点了加入排队」时都走这里，
 * 保证消息一定先落队列再开始新回合，前端始终能看到「排队 → 开始发送」的完整过程。
 */
export function pumpQueue(sessionId: number, userId: number, userName: string): void {
  setImmediate(() => {
    if (runningSessions.has(sessionId)) return;
    const next = takeNextQueueItem(sessionId);
    if (!next) {
      pushToUser(userId, { type: 'ai_chat_queue', sessionId, items: [] });
      return;
    }
    pushToUser(userId, { type: 'ai_chat_queue', sessionId, items: listQueue(sessionId) });
    const attachments = Array.isArray(next.attachments) ? next.attachments : [];
    void runTurn({ sessionId, userId, userName, text: next.content, attachments }).then((res) => {
      if (!res.ok) {
        // 被别的回合抢先生成 / 配置缺失：放回队首，别把消息弄丢
        prependQueueItem(sessionId, userId, next.content, attachments);
        pushToUser(userId, { type: 'ai_chat_queue', sessionId, items: listQueue(sessionId) });
        return;
      }
      // 排队消息已落库开始发送：前端立刻把它从卡片换成聊天气泡，避免整段回复期间两边都看不到
      pushToUser(userId, {
        type: 'ai_chat_queue_sent',
        sessionId,
        messageId: res.userMessageId,
        text: next.content,
        attachments,
      });
    });
  });
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { sessionId, userId } = input;
  const taskId = `turn-${Date.now().toString(36)}`;
  const text = (input.text ?? '').trim();
  const attachments = Array.isArray(input.attachments) ? input.attachments.slice(0, 6) : [];
  if (!text && !attachments.length) return { ok: false, error: '消息不能为空' };
  if (runningSessions.has(sessionId)) return { ok: false, error: '上一条回复还在生成中，稍等一下' };

  const api = getAiApi();
  if (!api.baseUrl || !api.apiKey || !api.chatModel) {
    return { ok: false, error: 'AI 还没有配置好：请让主家长在右上角「AI 设置」里填写接口地址、API Key 和模型名' };
  }

  // 文本附件在入队时抽取，内容随消息存库（重放历史时无需再次读文件）
  const storedAttachments: any[] = [];
  for (const att of attachments) {
    const extracted = att.kind === 'file' ? await extractAttachment(att) : '';
    storedAttachments.push({ ...att, extracted });
  }

  const userMessageId = insertMessage(sessionId, 'user', text, storedAttachments);
  touchSession(sessionId, text);
  runningSessions.add(sessionId);

  // 异步跑循环：HTTP 请求立刻返回，前端靠 WS 事件跟进
  void runLoop({ sessionId, userId, userName: input.userName, taskId, api })
    .catch(() => {})
    .finally(() => {
      runningSessions.delete(sessionId);
      stopRequested.delete(sessionId);
      // 引导没赶上本轮调模型（模型已经在输出最终回答）：转成队首消息，保证下一条会回应它
      const leftoverGuides = activeGuidance.get(sessionId) ?? [];
      activeGuidance.delete(sessionId);
      for (const g of [...leftoverGuides].reverse()) prependQueueItem(sessionId, userId, g, []);
      if (leftoverGuides.length) {
        pushToUser(userId, { type: 'ai_chat_queue', sessionId, items: listQueue(sessionId) });
      }
      clearTaskScope(taskId); // 「本次任务都允许」的放行随回合终结
      // 队列：本回合结束后自动执行下一条（新回合结束后会再次走到这里）
      pumpQueue(sessionId, userId, input.userName);
    });
  return { ok: true, userMessageId, taskId };
}

async function runLoop(opts: {
  sessionId: number;
  userId: number;
  userName: string;
  taskId: string;
  api: ReturnType<typeof getAiApi>;
}): Promise<void> {
  const { sessionId, userId, userName, taskId, api } = opts;
  const actor = { userId, role: 'parent', name: userName };
  const emit = (type: string, payload: Record<string, unknown>) => pushToUser(userId, { type, sessionId, taskId, ...payload });
  // 状态既推 WS，也记进内存：前端切走再回来时靠 /ai/turn-state 恢复"还在跑"的状态
  const emitStatus = (phase: TurnPhase, tool?: string) => {
    updateTurn(sessionId, taskId, phase, tool);
    emit('ai_chat_status', tool ? { phase, tool } : { phase });
  };
  startTurn(sessionId, userId, taskId);

  try {
    // 工具 = 内置 + MCP；流程技能以 run_skill 形式暴露
    const gathered = await gatherMcpTools();
    const mcpServers = gathered.servers;
    const flowSkills = listSkills().skills.filter((s) => s.enabled && s.flow?.steps.length);
    const tools: LlmToolSpec[] = [
      ...builtinToolSpecs,
      ...gathered.specs,
      ...flowSkills.map((s) => ({
        name: `run_skill`,
        description: `执行技能流程「${s.name}」（${s.flow!.steps.map((x) => x.tool).join(' → ')}）`,
        parameters: {
          type: 'object',
          properties: { skill: { type: 'string', const: s.folder }, input: { type: 'string' } },
        },
      })),
    ];

    const lastUserText = getLastUserText(sessionId);
    const memoryHits = searchMemory(lastUserText, 4);
    const now = new Date();
    const system = systemPrompt(now, memoryHits, buildFamilySnapshot(now), userName);
    // 配了上下文窗口就按预算裁掉最旧的历史；要给系统提示词、工具清单和输出留出余量
    const historyBudget = api.contextWindow
      ? Math.max(1000, api.contextWindow - (api.maxTokens ?? 0) - estimateTokens(system) - 1500)
      : 0;
    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      ...trimHistoryToBudget(rebuildHistory(sessionId), historyBudget),
    ];

    // 识图走单独的供应商开关（没单独开启时回落到聊天供应商）
    const visionApi = getAiVisionApi();
    const visionTarget = {
      baseUrl: visionApi.baseUrl || api.baseUrl,
      apiKey: visionApi.apiKey || api.apiKey,
      model: visionApi.model || api.chatModel,
    };

    // 带图的回合先确认模型真的能看图。不支持时直接说清楚，
    // 否则模型会把「收不到图片」描述成「图片数据被截断」，家长会以为上传坏了。
    if (messagesHaveImage(messages)) {
      emitStatus('thinking');
      const probeCtrl = new AbortController();
      const probeTimer = setTimeout(() => probeCtrl.abort(), 40_000);
      activeAbort.set(sessionId, probeCtrl);
      let visionOk: boolean | null = null;
      try {
        visionOk = await checkVisionSupport(
          visionTarget,
          { temperature: api.temperature, maxTokens: api.maxTokens },
          probeCtrl.signal
        );
      } catch {
        visionOk = null; // 探测本身失败：按未知处理，照常发图
      } finally {
        clearTimeout(probeTimer);
        if (activeAbort.get(sessionId) === probeCtrl) activeAbort.delete(sessionId);
      }
      if (stopRequested.has(sessionId)) {
        emit('ai_chat_done', { messageId: null, stopped: true });
        return;
      }
      if (visionOk === false) {
        const modelName = visionTarget.model;
        const notice =
          `当前模型（${modelName}）看起来不支持看图，图片没能被识别。\n\n` +
          '请让主家长到右上角「AI 设置 → 图片识别模型」，换成支持视觉的模型（如豆包视觉、智谱 GLM-4V、MiniMax 等），' +
          '保存后重新发送图片即可。';
        const messageId = insertMessage(sessionId, 'assistant', notice);
        touchSession(sessionId);
        emit('ai_chat_warning', { text: '当前模型不支持看图，请到 AI 设置切换识图模型' });
        emit('ai_chat_done', { messageId });
        return;
      }
    }

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const offerTools = round < MAX_TOOL_ROUNDS;
      // 已点「停止」：不再发起新一轮模型调用（可能是在工具/问答等待期间点的）
      if (stopRequested.has(sessionId)) {
        emit('ai_chat_done', { messageId: null, stopped: true });
        return;
      }
      // 家长在生成过程中发来的「引导」：下一次调模型前补进上下文，并作为消息落库
      const guides = activeGuidance.get(sessionId);
      if (guides?.length) {
        for (const g of guides.splice(0)) {
          messages.push({ role: 'user', content: `【家长补充】${g}` });
          const guideMsgId = insertMessage(sessionId, 'user', g, undefined, { guidance: true });
          touchSession(sessionId);
          emit('ai_chat_guidance', { text: g, messageId: guideMsgId });
        }
      }
      // 每轮开始先告诉前端「在思考」：思考模式下模型可能先想几秒，界面不能干等
      emitStatus('thinking');
      let writing = false;
      /** 本轮已经流式推给前端的正文（停止时用它保留半截回答） */
      let streamed = '';
      /** 本轮模型的思考增量（火山方舟等供应商会返回 reasoning_content）：只展示，不回灌模型 */
      let reasoning = '';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      activeAbort.set(sessionId, ctrl);
      let response: Awaited<ReturnType<typeof callLlm>>;
      try {
        const wantVision = messagesHaveImage(messages);
        response = await callLlm(
          {
            baseUrl: wantVision ? visionTarget.baseUrl : api.baseUrl,
            apiKey: wantVision ? visionTarget.apiKey : api.apiKey,
            model: wantVision ? visionTarget.model : api.chatModel,
            temperature: api.temperature,
            maxTokens: api.maxTokens,
          },
          messages,
          {
            tools: offerTools ? tools : undefined,
            stream: true,
            signal: ctrl.signal,
            onDelta: (chunk) => {
              if (!writing) {
                writing = true;
                emitStatus('writing');
              }
              streamed += chunk;
              emit('ai_chat_delta', { text: chunk });
            },
            onReasoning: (chunk) => {
              reasoning += chunk;
              emit('ai_chat_reasoning', { text: chunk });
            },
          }
        );
      } catch (err) {
        // 家长点了「停止」：保住已经输出的半截回答，按正常结束处理，不弹报错
        if (stopRequested.has(sessionId)) {
          const partial = streamed.trim();
          if (partial) {
            const messageId = insertMessage(sessionId, 'assistant', partial, undefined, {
              ...(reasoning ? { reasoning } : {}),
              stopped: true,
            });
            touchSession(sessionId);
            emit('ai_chat_done', { messageId, stopped: true });
          } else {
            emit('ai_chat_done', { messageId: null, stopped: true });
          }
          return;
        }
        // 被「引导」打断：半截回答不落库，直接进入下一轮，把引导补进上下文重新回答
        if (ctrl.signal.aborted && (activeGuidance.get(sessionId)?.length ?? 0) > 0) continue;
        throw err;
      } finally {
        clearTimeout(timer);
        if (activeAbort.get(sessionId) === ctrl) activeAbort.delete(sessionId);
      }

      const text = response.text.trim();
      if (!response.toolCalls.length || !offerTools) {
        const finalText = text || (response.toolCalls.length ? '（工具调用轮次已达上限，请换个说法重试）' : '');
        if (finalText) {
          const messageId = insertMessage(
            sessionId,
            'assistant',
            finalText,
            undefined,
            reasoning ? { reasoning } : undefined
          );
          touchSession(sessionId);
          // 个别端点忽略 stream 会一次性返回：此时流里没有增量，补推一次保证界面有内容
          if (!text) emit('ai_chat_delta', { text: finalText });
          emit('ai_chat_done', { messageId });
        } else {
          emit('ai_chat_done', { messageId: null });
        }
        return;
      }

      // 中间轮的文本已经边生成边推给前端了，这里只补齐会话记录
      messages.push({ role: 'assistant', content: text || null, toolCalls: response.toolCalls });
      insertMessage(sessionId, 'assistant', text, undefined, { toolCalls: response.toolCalls, reasoning });

      for (const call of response.toolCalls) {
        let resultText: string;
        let confirmInfo: { token: string; summary: string; detail: string } | null = null;
        emitStatus('tool', call.name);

        // 计划更新：只记录 + 推给前端展示，不执行任何业务动作
        if (call.name === 'update_plan') {
          let steps: PlanStep[] = [];
          try {
            const args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
            const raw = Array.isArray(args?.steps) ? args.steps : [];
            steps = raw
              .slice(0, 12)
              .map((s: any) => ({
                title: String(s?.title ?? '').trim().slice(0, 80),
                status: (s?.status === 'done' ? 'done' : s?.status === 'in_progress' ? 'in_progress' : 'pending') as PlanStep['status'],
              }))
              .filter((s: PlanStep) => Boolean(s.title));
          } catch {
            /* 参数坏了按空处理 */
          }
          if (!steps.length) {
            resultText = 'update_plan 需要至少一条有效步骤（title + status）。';
          } else {
            setPlan(sessionId, taskId, steps);
            emit('ai_chat_plan', { steps });
            const done = steps.filter((s) => s.status === 'done').length;
            resultText = `计划已更新（${done}/${steps.length} 完成）：${steps
              .map((s) => `${s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▶' : '○'} ${s.title}`)
              .join('；')}`;
          }
          messages.push({ role: 'tool', content: resultText, toolCallId: call.id });
          insertMessage(sessionId, 'tool', resultText, undefined, {
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: previewArgs(call.argumentsJson),
          });
          emit('ai_chat_tool', {
            tool: call.name,
            summary: steps.length ? `${steps.length} 步计划` : '计划为空',
            needsConfirm: false,
            args: previewArgs(call.argumentsJson),
            result: resultText.slice(0, 2000),
          });
          continue;
        }

        // Ask Question：弹面板等家长回答（最长 10 分钟），答完把结果作为工具结果继续本轮
        if (call.name === 'ask_user') {
          let args: { questions?: unknown } = {};
          try {
            args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
          } catch {
            /* 参数坏了按空处理，下面会给出提示 */
          }
          const opened = openQuestion({ userId, sessionId, questions: args.questions });
          if (!opened) {
            resultText = 'ask_user 的 questions 为空或格式不对：请提供 1~4 个问题，每个问题一句话。';
          } else {
            emit('ai_chat_question', { token: opened.token, questions: opened.questions });
            const answers = await opened.promise;
            emit('ai_chat_question_closed', { token: opened.token, answered: Boolean(answers) });
            resultText = answers
              ? `家长在问答面板里的回答（按题目顺序）：\n${answers
                  .map((a) => `- ${a.question} → ${a.answers.length ? a.answers.join('；') : '（未回答）'}`)
                  .join('\n')}`
              : '家长没有回答（跳过或超时）。请基于已知信息继续；不确定的地方按最保守的方式处理，并说明你的假设。';
          }
          messages.push({ role: 'tool', content: resultText, toolCallId: call.id });
          insertMessage(sessionId, 'tool', resultText, undefined, {
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: previewArgs(call.argumentsJson),
          });
          emit('ai_chat_tool', {
            tool: call.name,
            summary: opened ? '已向家长提问' : '提问失败',
            needsConfirm: false,
            args: previewArgs(call.argumentsJson),
            result: resultText.slice(0, 2000),
          });
          continue;
        }

        // 联网检索：异步执行，结果里自带来源链接，模型被要求转述来源
        if (call.name === 'web_search' || call.name === 'web_fetch') {
          let args: any = {};
          try {
            args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
          } catch {
            /* 参数坏了按空处理 */
          }
          try {
            if (call.name === 'web_search') {
              const query = String(args.query ?? '').trim();
              const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 8);
              const result = await webSearch(query, limit);
              resultText = result.hits.length
                ? `搜索「${query}」（引擎 ${result.engine}，${result.hits.length} 条）：\n` +
                  result.hits
                    .map(
                      (h, i) =>
                        `${i + 1}. ${h.title}\n   来源：${h.site}\n   链接：${h.url}\n   摘要：${h.snippet || '（无摘要）'}`
                    )
                    .join('\n') +
                  '\n\n引用要求：写清站点与链接；同一结论尽量找第二个来源交叉验证；无法确认就明确说不确定。'
                : `没搜到可靠结果（${result.error ?? '没有匹配内容'}）。请如实告诉家长没查到，不要编造或用常识补全。`;
            } else {
              const page = await fetchPage(String(args.url ?? ''));
              resultText = `已读取网页：${page.title}\n来源：${page.site}\n链接：${page.url}\n\n${page.text}`;
            }
          } catch (e) {
            resultText = `联网操作失败：${(e as Error)?.message ?? e}。请如实告诉家长没查到，不要用记忆补全。`;
          }
          messages.push({ role: 'tool', content: resultText, toolCallId: call.id });
          insertMessage(sessionId, 'tool', resultText, undefined, {
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: previewArgs(call.argumentsJson),
          });
          emit('ai_chat_tool', {
            tool: call.name,
            summary: resultText.slice(0, 200),
            needsConfirm: false,
            args: previewArgs(call.argumentsJson),
            result: resultText.slice(0, 2000),
          });
          continue;
        }

        if (builtinToolNames.has(call.name)) {
          const outcome = executeBuiltinTool(call.name, call.argumentsJson, {
            userId,
            taskId,
            actor,
          });
          if (outcome.kind === 'result') {
            resultText = outcome.text;
          } else {
            confirmInfo = { token: outcome.token, summary: outcome.summary, detail: outcome.detail };
            resultText =
              '这个操作需要家长在界面上确认后才会执行。请告诉家长：' +
              outcome.summary +
              '（确认卡已生成，家长可以「允许一次」「本次任务都允许」或拒绝。等待家长操作，不要重复提交。）';
          }
        } else {
          const mcp = splitMcpToolName(call.name, mcpServers);
          if (!mcp) {
            resultText = `未知工具 ${call.name}`;
          } else {
            const outcome = await executeMcp(mcp.server.name, mcp.server.entry, mcp.tool, call.argumentsJson, {
              userId,
              taskId,
              actor,
            });
            resultText = outcome.kind === 'result' ? outcome.text : outcome.detail;
            if (outcome.kind === 'confirm') {
              confirmInfo = { token: outcome.token, summary: outcome.summary, detail: outcome.detail };
              resultText =
                `这个 MCP 工具调用（${mcp.server.name} / ${mcp.tool}）需要家长确认。请告诉家长：` +
                outcome.summary +
                '（确认卡已生成，家长可以「允许一次」「本次任务都允许」或拒绝。等待家长操作，不要重复提交。）';
            }
          }
        }

        messages.push({ role: 'tool', content: resultText, toolCallId: call.id });
        insertMessage(sessionId, 'tool', resultText, undefined, {
          toolCallId: call.id,
          toolName: call.name,
          toolArgs: previewArgs(call.argumentsJson),
          confirm: confirmInfo,
        });
        emit('ai_chat_tool', {
          tool: call.name,
          summary: confirmInfo ? confirmInfo.summary : resultText.slice(0, 200),
          needsConfirm: Boolean(confirmInfo),
          token: confirmInfo?.token,
          args: previewArgs(call.argumentsJson),
          result: resultText.slice(0, 2000),
        });
        if (confirmInfo) emit('ai_chat_confirm', confirmInfo);
      }
    }
  } catch (e) {
    const message = e instanceof LlmError ? `模型调用失败：${e.message}` : `AI 出错了：${(e as Error)?.message ?? e}`;
    insertMessage(sessionId, 'assistant', `⚠️ ${message}`);
    touchSession(sessionId);
    emit('ai_chat_error', { error: message });
  } finally {
    endTurn(sessionId, taskId);
    // 回合结束：清掉还没回答的问题单（前端可能已关闭面板/超时）
    cancelSessionQuestions(sessionId);
  }
}

function getLastUserText(sessionId: number): string {
  const row = getDb()
    .prepare(`SELECT content FROM ai_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`)
    .get(sessionId) as { content: string } | undefined;
  return row?.content ?? '';
}
