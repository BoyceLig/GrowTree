import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireParent, requirePrimaryParent } from '../middleware.js';
import { config } from '../config.js';
import {
  getAiApiSettings,
  setAiApiSettings,
  getAiMcp,
  setAiMcp,
  DEFAULT_AI_API,
  AI_PROVIDER_KINDS,
  AI_PROVIDER_KIND_LABEL,
  type AiProvider,
  type AiProviderKind,
  type McpServerEntry,
} from '../services/ai/settings.js';
import { probeModel, listModels } from '../services/ai/llm.js';
import { resolveProviderIcon } from '../services/ai/icons.js';
import { answerQuestion, cancelSessionQuestions, listQuestions } from '../services/ai/questions.js';
import { listTurns } from '../services/ai/turnState.js';
import { getSafetyPolicy, setSafetyPolicy, isSafetyPolicy } from '../services/ai/sentinel.js';
import { parseMcpServersWithEnv, listMcpTools, invalidateMcp } from '../services/ai/mcp.js';
import { listSkills, setSkillEnabled, deleteSkillFolder } from '../services/ai/skills.js';
import {
  listMemoryNotes,
  readMemoryMarkdown,
  writeMemoryMarkdown,
  deleteMemoryNote,
  memoryDir,
} from '../services/ai/memory.js';
import { confirmAction, rejectAction } from '../services/ai/tools.js';
import { runTurn, isSessionRunning, pushGuidance, pumpQueue, stopSession } from '../services/ai/agent.js';
import { listQueue, addQueueItem, updateQueueItem, deleteQueueItem, reorderQueue } from '../services/ai/queue.js';
import { getAiReadiness } from '../services/ai/settings.js';
import { getDb } from '../db/index.js';
import { pushToUser } from '../ws.js';
import { recordUploadFile } from './upload.js';

/**
 * AI 助手路由（挂载在 /api 下，实际前缀 /api/ai）。
 *
 * 权限边界：
 *   - 对话（会话/消息/确认/上传）：所有家长可用（requireParent），孩子端不开放；
 *   - 设置（config/probe/models/mcp-test/技能开关）：仅主家长（requirePrimaryParent），
 *     与「账号管理」同级 —— AI 的 API Key、MCP 凭据属于家庭级配置。
 *   - 技能本体是数据目录 skills/ 下的文件（<DATA_DIR>/skills/<文件夹>/SKILL.md），
 *     界面只做只读列表 + 启用开关 + 刷新；增删改直接编辑文件/挂载卷。
 */

/** 设置里 API Key 不回传完整值给前端回显：只留前 3 后 4，编辑时留空 = 保持不变 */
function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

function sessionOwned(req: FastifyRequest, sessionId: number): { id: number; title: string } | undefined {
  return getDb()
    .prepare('SELECT id, title FROM ai_sessions WHERE id = ? AND user_id = ?')
    .get(sessionId, req.user!.sub) as { id: number; title: string } | undefined;
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const DOC_EXT = new Set(['txt', 'md', 'csv', 'json', 'pdf']);
const UPLOAD_MAX = 20 * 1024 * 1024;

export function registerAiRoutes(app: FastifyInstance): void {
  /* ── 可用性 ──────────────────────────────────────────────────────────── */

  /** 聊天页的可用性检查（所有家长都能调）：AI 是否已配置好 + 当前安全策略 */
  app.get('/ai/status', { preHandler: requireParent }, async () => ({ ...getAiReadiness(), safety: getSafetyPolicy() }));

  /* ── 会话 ────────────────────────────────────────────────────────────── */

  app.get('/ai/sessions', { preHandler: requireParent }, async (req) => {
    const rows = getDb()
      .prepare(
        `SELECT id, title, created_at, updated_at FROM ai_sessions
         WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100`
      )
      .all(req.user!.sub);
    return { sessions: rows };
  });

  app.post('/ai/sessions', { preHandler: requireParent }, async (req, reply) => {
    const title = String((req.body as any)?.title ?? '新对话').trim().slice(0, 40) || '新对话';
    const row = getDb()
      .prepare('INSERT INTO ai_sessions (user_id, title) VALUES (?, ?)')
      .run(req.user!.sub, title);
    const session = getDb()
      .prepare('SELECT id, title, created_at, updated_at FROM ai_sessions WHERE id = ?')
      .get(Number(row.lastInsertRowid));
    return reply.code(201).send({ session });
  });

  /** 重命名会话（右键/菜单改名） */
  app.put('/ai/sessions/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!sessionOwned(req, id)) return reply.code(404).send({ error: 'not_found' });
    const title = String((req.body as any)?.title ?? '').trim().slice(0, 40);
    if (!title) return reply.code(400).send({ error: 'invalid_input' });
    getDb().prepare('UPDATE ai_sessions SET title = ?, updated_at = unixepoch() WHERE id = ?').run(title, id);
    return { ok: true, title };
  });

  app.delete('/ai/sessions/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    // 会话里有回合正停在问答面板：先取消，避免删完还在等回答
    if (Number.isInteger(id)) cancelSessionQuestions(id);
    const info = getDb().prepare('DELETE FROM ai_sessions WHERE id = ? AND user_id = ?').run(id, req.user!.sub);
    if (!info.changes) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.get('/ai/sessions/:id/messages', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!sessionOwned(req, id)) return reply.code(404).send({ error: 'not_found' });
    const rows = getDb()
      .prepare('SELECT * FROM ai_messages WHERE session_id = ? ORDER BY id LIMIT 500')
      .all(id) as any[];
    return {
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        attachments: r.attachments ? JSON.parse(r.attachments) : null,
        meta: r.meta ? JSON.parse(r.meta) : null,
        created_at: r.created_at,
      })),
    };
  });

  /** 发送消息：立即返回 taskId，回复通过 WS 事件（ai_chat_delta/done/error）推送 */
  app.post('/ai/sessions/:id/messages', { preHandler: requireParent, bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!sessionOwned(req, id)) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { text?: unknown; attachments?: unknown; agent?: unknown; queue?: unknown };
    const text = String(body.text ?? '').trim();
    const attachments = Array.isArray(body.attachments) ? (body.attachments as any[]) : [];
    if (!text && !attachments.length) return reply.code(400).send({ error: '消息不能为空' });

    // 回合进行中再发消息 = 默认排队（不打断当前回复）；回合结束后自动按顺序执行。
    // queue: true 表示前端点了「加入排队」：即使这一瞬间回合刚好结束，也必须先落队列，
    // 再由 pumpQueue 立刻取出执行，避免同样的操作有时排队、有时直接变成新回合。
    const wantQueue = body.queue === true;
    if (wantQueue || isSessionRunning(id)) {
      const item = addQueueItem(id, req.user!.sub, text, attachments);
      pushToUser(req.user!.sub, { type: 'ai_chat_queue', sessionId: id, items: listQueue(id) });
      if (!isSessionRunning(id)) pumpQueue(id, req.user!.sub, req.user!.name);
      return reply.code(202).send({ queued: true, item });
    }

    const result = await runTurn({
      sessionId: id,
      userId: req.user!.sub,
      userName: req.user!.name,
      text,
      attachments,
    });
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return { taskId: result.taskId, userMessageId: result.userMessageId };
  });

  /* ── 消息排队（回合进行中的补充消息） ────────────────────────────────── */

  app.get('/ai/sessions/:id/queue', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!sessionOwned(req, id)) return reply.code(404).send({ error: 'not_found' });
    return { items: listQueue(id), running: isSessionRunning(id) };
  });

  /** 编辑排队消息（前端「编辑」会把内容取回输入框；这里也支持直接改） */
  app.put('/ai/sessions/:id/queue/:itemId', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const itemId = Number((req.params as any).itemId);
    if (!sessionOwned(req, id)) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { text?: unknown; attachments?: unknown };
    const text = String(body.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: '消息不能为空' });
    const attachments = Array.isArray(body.attachments) ? (body.attachments as any[]) : undefined;
    const item = updateQueueItem(itemId, id, text, attachments);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    pushToUser(req.user!.sub, { type: 'ai_chat_queue', sessionId: id, items: listQueue(id) });
    return { item };
  });

  app.delete('/ai/sessions/:id/queue/:itemId', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const itemId = Number((req.params as any).itemId);
    if (!sessionOwned(req, id)) return reply.code(404).send({ error: 'not_found' });
    if (!deleteQueueItem(itemId, id)) return reply.code(404).send({ error: 'not_found' });
    pushToUser(req.user!.sub, { type: 'ai_chat_queue', sessionId: id, items: listQueue(id) });
    return { ok: true };
  });

  /** 拖动排序：按传入的 id 顺序重排 */
  app.put('/ai/sessions/:id/queue/order', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!sessionOwned(req, id)) return reply.code(404).send({ error: 'not_found' });
    const ids = Array.isArray((req.body as any)?.ids)
      ? ((req.body as any).ids as unknown[]).map((x) => Number(x)).filter((n) => Number.isInteger(n))
      : [];
    const items = reorderQueue(id, ids);
    pushToUser(req.user!.sub, { type: 'ai_chat_queue', sessionId: id, items });
    return { items };
  });

  /** 引导：把排队消息立刻补进正在进行的回合（下一次调模型前生效） */
  app.post('/ai/sessions/:id/queue/:itemId/guide', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const itemId = Number((req.params as any).itemId);
    if (!sessionOwned(req, id)) return reply.code(404).send({ error: 'not_found' });
    const item = listQueue(id).find((x) => x.id === itemId);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    if (!pushGuidance(id, item.content)) {
      return reply.code(409).send({ error: '当前没有进行中的回复，无法引导；可以直接等待它作为普通消息发送' });
    }
    deleteQueueItem(itemId, id);
    pushToUser(req.user!.sub, { type: 'ai_chat_queue', sessionId: id, items: listQueue(id) });
    return { ok: true };
  });

  /** 停止当前回合：立刻中断模型输出，已生成的内容保留；没有进行中的回合返回 ok: false */
  app.post('/ai/sessions/:id/stop', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!sessionOwned(req, id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: stopSession(id) };
  });

  /* ── 确认卡（写操作的第二把钥匙） ────────────────────────────────────── */

  /** 三选确认：允许一次 / 本次任务都允许 / 拒绝（Sentinel 决定动作何时真正执行） */
  app.post('/ai/confirm', { preHandler: requireParent }, async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; choice?: string };
    const token = String(body.token ?? '');
    const choice = body.choice === 'task' || body.choice === 'deny' ? body.choice : 'once';
    const result = await confirmAction(token, req.user!.sub, choice, req.user!.name);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true, detail: result.detail };
  });

  app.post('/ai/reject', { preHandler: requireParent }, async (req) => {
    const token = String((req.body as any)?.token ?? '');
    const ok = rejectAction(token, req.user!.sub);
    return { ok };
  });

  /* ── 附件上传（图片 + 文本/PDF 文档） ────────────────────────────────── */

  app.post('/ai/upload', { preHandler: requireParent, bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: 'missing_file' });
    // multipart 的 filename 可能带 RFC2047/URL 编码，先尽量还原成人话
    let originalName = String(file.filename ?? 'file');
    try {
      if (/%[0-9A-Fa-f]{2}/.test(originalName)) originalName = decodeURIComponent(originalName);
    } catch {
      /* 保留原名 */
    }
    const ext = path.extname(originalName).slice(1).toLowerCase();
    const isImage = IMAGE_EXT.has(ext);
    if (!isImage && !DOC_EXT.has(ext)) {
      return reply.code(400).send({ error: 'unsupported_type', detail: '支持的格式：图片 png/jpg/gif/webp/bmp，文档 txt/md/csv/json/pdf' });
    }
    const buf: Buffer = await file.toBuffer();
    if (!buf.length) return reply.code(400).send({ error: 'empty_file' });
    if (buf.length > UPLOAD_MAX) return reply.code(413).send({ error: 'too_large' });

    const filename = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${ext || 'bin'}`;
    writeFileSync(path.join(config.dataDir, 'uploads', filename), buf);
    // 原始文件名只存在元数据表里：磁盘名是唯一 ID，下载时再还原
    recordUploadFile({
      name: filename,
      originalName,
      mime: String(file.mimetype ?? ''),
      size: buf.length,
      kind: isImage ? 'image' : 'file',
      userId: req.user?.sub ?? null,
    });
    return reply.code(201).send({
      url: `/uploads/${filename}`,
      name: originalName,
      mime: String(file.mimetype ?? ''),
      size: buf.length,
      kind: isImage ? 'image' : 'file',
    });
  });

  /* ── 设置（仅主家长） ────────────────────────────────────────────────── */

  app.get('/ai/config', { preHandler: requirePrimaryParent }, async () => {
    const cfg = getAiApiSettings();
    return {
      // apiKey 不回传明文：只留前 3 后 4，编辑时留空 = 保持原值
      providers: cfg.providers.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey), hasKey: Boolean(p.apiKey) })),
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      contextWindow: cfg.contextWindow,
      mcp: getAiMcp(),
      safety: getSafetyPolicy(),
    };
  });

  app.put('/ai/config', { preHandler: requirePrimaryParent, bodyLimit: 256 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      providers?: Partial<AiProvider>[];
      temperature?: number | null;
      maxTokens?: number | null;
      contextWindow?: number | null;
      mcp?: Record<string, McpServerEntry>;
      safety?: unknown;
    };

    if (body.providers !== undefined) {
      const current = getAiApiSettings();
      const byId = new Map(current.providers.map((p) => [p.id, p]));
      const providers: AiProvider[] = [];
      const used = new Set<string>();
      for (const item of (body.providers ?? []).slice(0, 20)) {
        if (!item || typeof item !== 'object') continue;
        const kind: AiProviderKind = AI_PROVIDER_KINDS.includes(item.kind as AiProviderKind)
          ? (item.kind as AiProviderKind)
          : 'custom';
        let id = String(item.id ?? '').trim();
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || used.has(id)) {
          let n = providers.length + 1;
          id = `${kind}-${n}`;
          while (used.has(id)) id = `${kind}-${++n}`;
        }
        used.add(id);
        // apiKey 留空/为掩码 = 保持该供应商已保存的 Key；显式给了新值才覆盖
        const rawKey = String(item.apiKey ?? '');
        const apiKey = !rawKey || rawKey.includes('***') ? (byId.get(id)?.apiKey ?? '') : rawKey.trim();
        providers.push({
          id,
          kind,
          name: String(item.name ?? '').trim() || AI_PROVIDER_KIND_LABEL[kind],
          baseUrl: String(item.baseUrl ?? '').trim(),
          apiKey,
          model: String(item.model ?? '').trim(),
          visionModel: String(item.visionModel ?? '').trim(),
          chatEnabled: item.chatEnabled === true,
          visionEnabled: item.visionEnabled === true,
        });
      }
      // 聊天 / 识图各自只保留第一个开启的，互不影响
      let chatSeen = false;
      let visionSeen = false;
      for (const p of providers) {
        if (p.chatEnabled && !chatSeen) chatSeen = true;
        else p.chatEnabled = false;
        if (p.visionEnabled && !visionSeen) visionSeen = true;
        else p.visionEnabled = false;
      }
      setAiApiSettings({
        providers,
        temperature:
          body.temperature === undefined
            ? current.temperature
            : body.temperature === null
              ? null
              : Math.min(Math.max(Number(body.temperature), 0), 2),
        maxTokens:
          body.maxTokens === undefined
            ? current.maxTokens
            : body.maxTokens === null
              ? null
              : Math.min(Math.max(Math.floor(Number(body.maxTokens)), 1), 200000),
        contextWindow:
          body.contextWindow === undefined
            ? current.contextWindow
            : body.contextWindow === null
              ? null
              : Math.min(Math.max(Math.floor(Number(body.contextWindow)), 1000), 20000000),
      });
    }

    if (body.mcp !== undefined) {
      const { warnings } = parseMcpServersWithEnv(body.mcp ?? {});
      setAiMcp(body.mcp ?? {});
      invalidateMcp(); // 配置变了，所有缓存连接全部重连
      if (body.safety !== undefined && isSafetyPolicy(body.safety)) setSafetyPolicy(body.safety);
      return { ok: true, warnings, safety: getSafetyPolicy() };
    }

    if (body.safety !== undefined) {
      if (isSafetyPolicy(body.safety)) setSafetyPolicy(body.safety);
    }

    return { ok: true, warnings: [], safety: getSafetyPolicy() };
  });

  /** 正在进行的回合状态：切走再回 AI 页面时恢复「思考中 / 正在回答 / 正在执行工具」 */
  app.get('/ai/turn-state', { preHandler: requireParent }, async (req) => ({ turns: listTurns(req.user!.sub) }));

  /** 当前待答问题：前端刷新/重连/切页面回来时据此补弹面板（WS 事件错过也不怕） */
  app.get('/ai/questions', { preHandler: requireParent }, async (req) => {
    const rows = listQuestions(req.user!.sub).map((q) => {
      const row = getDb()
        .prepare('SELECT title FROM ai_sessions WHERE id = ? AND user_id = ?')
        .get(q.sessionId, req.user!.sub) as { title?: string } | undefined;
      return { ...q, sessionTitle: row?.title ?? '' };
    });
    return { questions: rows };
  });

  /** 回答 Ask Question 面板：answers 为空 = 跳过 */
  app.post('/ai/answer', { preHandler: requireParent }, async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; answers?: unknown };
    const token = String(body.token ?? '').trim();
    if (!token) return reply.code(400).send({ error: 'missing_token' });
    const result = answerQuestion(token, req.user!.sub, body.answers);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true };
  });

  /** 测试连接：apiKey 留空 = 用该供应商已保存的 Key 探测 */
  app.post('/ai/probe', { preHandler: requirePrimaryParent }, async (req) => {
    const body = (req.body ?? {}) as { providerId?: string; baseUrl?: string; apiKey?: string; model?: string; visionModel?: string; withImage?: boolean };
    const stored = getAiApiSettings();
    const provider = stored.providers.find((p) => body.providerId && p.id === body.providerId) ?? stored.providers.find((p) => p.chatEnabled || p.visionEnabled);
    const apiKey = body.apiKey && !body.apiKey.includes('***') ? body.apiKey : provider?.apiKey ?? '';
    const baseUrl = String(body.baseUrl ?? '').trim() || provider?.baseUrl || '';
    const model = String(body.model ?? '').trim() || provider?.model || '';
    const visionModel = String(body.visionModel ?? '').trim() || provider?.visionModel || '';
    const imageModel = visionModel || model;
    const withImage = body.withImage === true;
    const base = { baseUrl, apiKey, temperature: null, maxTokens: null };
    const imageReport = withImage ? await probeModel({ ...base, model: imageModel }, true) : null;
    let chat: boolean;
    if (imageReport && (imageReport.ok || imageReport.visionRejected)) {
      chat = true;
    } else {
      chat = (await probeModel({ ...base, model }, false)).ok;
    }
    const image = withImage ? Boolean(imageReport?.ok) : null;
    return { chat, image };
  });

  /** 模型列表：GET {baseUrl}/models（apiKey 留空 = 用该供应商已保存的 Key） */
  app.post('/ai/models', { preHandler: requirePrimaryParent }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      providerId?: string;
      baseUrl?: string;
      apiKey?: string;
      needImage?: boolean;
      mode?: 'chat' | 'vision';
    };
    const stored = getAiApiSettings();
    const provider = stored.providers.find((p) => body.providerId && p.id === body.providerId) ?? stored.providers.find((p) => p.chatEnabled || p.visionEnabled);
    const apiKey = body.apiKey && !body.apiKey.includes('***') ? body.apiKey : provider?.apiKey ?? '';
    const mode = body.mode ?? (body.needImage ? 'vision' : 'chat');
    const baseUrl = String(body.baseUrl ?? '').trim() || provider?.baseUrl || '';
    try {
      const catalog = await listModels(baseUrl, apiKey, mode === 'vision');
      return { ok: true, ...catalog };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error)?.message ?? String(e) });
    }
  });

  /** 自定义供应商图标：从 Base URL 的站点取 favicon（SSRF 防护 + 24h 缓存） */
  app.post('/ai/provider-icon', { preHandler: requirePrimaryParent }, async (req, reply) => {
    const body = (req.body ?? {}) as { baseUrl?: string };
    try {
      const icon = await resolveProviderIcon(String(body.baseUrl ?? ''));
      if (!icon) return reply.code(404).send({ ok: false, error: '这个地址没有可用的站点图标' });
      return { ok: true, ...icon };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error)?.message ?? '取图标失败' });
    }
  });

  /** MCP 连接测试：列出该服务器的工具清单（不落配置，用于编辑时验证） */
  app.post('/ai/mcp/test', { preHandler: requirePrimaryParent }, async (req) => {
    const body = (req.body ?? {}) as { name?: string; entry?: McpServerEntry };
    const name = String(body.name ?? 'test').trim() || 'test';
    const entry = body.entry;
    if (!entry || (!entry.url && !entry.command)) {
      return { ok: false, error: 'url 与 command 必须二选一' };
    }
    // 用临时名字解析，避免同名缓存连接吃掉刚改过的配置
    const parsed = parseMcpServersWithEnv({ [name]: { ...entry, enabled: true } });
    if (!parsed.servers.length) return { ok: false, error: parsed.warnings.join('；') || '配置无效' };
    invalidateMcp(name);
    const result = await listMcpTools(parsed.servers[0].name, parsed.servers[0].entry);
    return result;
  });

  /* ── 技能（目录制：<DATA_DIR>/skills/<文件夹>/SKILL.md，界面只读 + 开关 + 刷新） ── */

  app.get('/ai/skills', { preHandler: requirePrimaryParent }, async () => {
    // 每次都重新扫盘：技能文件随时可能被手工/挂载卷改过
    return listSkills();
  });

  app.post('/ai/skills/toggle', { preHandler: requirePrimaryParent }, async (req, reply) => {
    const { folder, enabled } = (req.body ?? {}) as { folder?: string; enabled?: boolean };
    if (typeof folder !== 'string' || typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_input' });
    }
    const result = setSkillEnabled(folder, enabled);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true, ...listSkills() };
  });

  /** 卸载技能：删除 <DATA_DIR>/skills/<folder>（界面上二次确认） */
  app.delete('/ai/skills/:folder', { preHandler: requirePrimaryParent }, async (req, reply) => {
    const { folder } = req.params as { folder?: string };
    if (!folder) return reply.code(400).send({ error: 'invalid_input' });
    const result = deleteSkillFolder(decodeURIComponent(folder));
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true, ...listSkills() };
  });

  /* ── 记忆（<DATA_DIR>/ai-memory/*.md，编辑器直接改原始 Markdown） ───────── */

  app.get('/ai/memories', { preHandler: requirePrimaryParent }, async () => ({
    notes: listMemoryNotes(),
    dir: memoryDir(),
  }));

  app.get('/ai/memories/:permalink', { preHandler: requirePrimaryParent }, async (req, reply) => {
    const permalink = decodeURIComponent(String((req.params as { permalink?: string }).permalink ?? ''));
    const markdown = readMemoryMarkdown(permalink);
    if (markdown === undefined) return reply.code(404).send({ error: 'not_found' });
    return { permalink, markdown };
  });

  app.put('/ai/memories/:permalink', { preHandler: requirePrimaryParent, bodyLimit: 512 * 1024 }, async (req, reply) => {
    const permalink = decodeURIComponent(String((req.params as { permalink?: string }).permalink ?? ''));
    const markdown = String(((req.body ?? {}) as { markdown?: string }).markdown ?? '');
    if (!markdown) return reply.code(400).send({ error: '内容不能为空' });
    try {
      writeMemoryMarkdown(permalink, markdown);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error)?.message ?? '保存失败' });
    }
  });

  app.delete('/ai/memories/:permalink', { preHandler: requirePrimaryParent }, async (req, reply) => {
    const permalink = decodeURIComponent(String((req.params as { permalink?: string }).permalink ?? ''));
    if (!deleteMemoryNote(permalink)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}

/** 默认配置出口（前端空态提示用） */
export { DEFAULT_AI_API };
