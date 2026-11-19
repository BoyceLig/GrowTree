import path from 'node:path';
import { getDb } from '../../db/index.js';
import { appendAuditRow } from '../audit.js';

/**
 * Sentinel —— agent 的「看门层」（移植自 xiaoman core-sentinel 的精神）：
 *   模型在工具循环里提议的所有动作，真正落到满伴数据库/文件/MCP 之前都要过这一层。
 *
 * 三件事：
 *   1. 策略分流：安全策略档（允许 / 询问 / 拒绝）决定写类动作是直接放行、
 *      生成确认单、还是直接拒绝 —— 存在 ai 设置里，家长可改；
 *   2. 三选确认：确认单支持「允许一次 / 本次任务都允许 / 拒绝」；
 *      「本次任务都允许」按任务号 + 动作键放行同类动作，回合结束自动失效；
 *   3. 审计：放行 / 询问 / 拒绝 / 确认，每一次决策都写 operation_logs
 *      （module=AI，action 带「被执行的模块名」）。
 */

export type SafetyPolicy = 'alwaysAsk' | 'allowAll';

/** 动作风险分级：保留字段用于审计/展示；安全策略只有「全部询问 / 全部允许」两档 */
export type ActionRisk = 'normal' | 'high';

const KEY = 'ai_safety';
const DEFAULT_POLICY: SafetyPolicy = 'alwaysAsk';

function readPolicy(): unknown {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  } catch {
    return undefined;
  }
}

export function getSafetyPolicy(): SafetyPolicy {
  const v = readPolicy();
  // 老值迁移：ask / deny / onDemand 一律并入「全部询问」
  if (v === 'ask' || v === 'deny' || v === 'onDemand') return 'alwaysAsk';
  if (v === 'allow') return 'allowAll';
  return v === 'alwaysAsk' || v === 'allowAll' ? v : DEFAULT_POLICY;
}

export function setSafetyPolicy(mode: SafetyPolicy): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
    )
    .run(KEY, JSON.stringify(mode));
}

export function isSafetyPolicy(v: unknown): v is SafetyPolicy {
  return v === 'alwaysAsk' || v === 'allowAll';
}

/* ── 待确认动作：三选确认的登记簿 ──────────────────────────────────────── */

export type PendingChoice = 'once' | 'task' | 'deny';

export type PendingAction = {
  token: string;
  ownerUserId: number;
  taskId: string;
  /** 动作键：同类动作「本次任务都允许」的匹配依据，如 add_point_records / mcp:amap:geocode */
  actionKey: string;
  kind: string;
  payload: unknown;
  summary: string;
  /** 被执行的业务模块名，审计标签用：积分 / 任务 / 记忆 / 技能 / MCP:<服务器> */
  moduleName: string;
  createdAt: number;
};

const PENDING_TTL_MS = 15 * 60 * 1000;
const pending = new Map<string, PendingAction>();

/** 「本次任务都允许」的任务级放行表：taskId → 已放行的动作键集合 */
const taskAllowed = new Map<string, Set<string>>();

function sweepSentinel(): void {
  const now = Date.now();
  for (const [token, action] of pending) {
    if (now - action.createdAt > PENDING_TTL_MS) pending.delete(token);
  }
}

export function makeToken(): string {
  return `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 回合结束后清掉任务级放行（下次任务重新问） */
export function clearTaskScope(taskId: string): void {
  taskAllowed.delete(taskId);
}

function isTaskAllowed(taskId: string, actionKey: string): boolean {
  return taskAllowed.get(taskId)?.has(actionKey) ?? false;
}

function allowForTask(taskId: string, actionKey: string): void {
  let set = taskAllowed.get(taskId);
  if (!set) {
    set = new Set();
    taskAllowed.set(taskId, set);
  }
  set.add(actionKey);
}

/* ── 审计 ──────────────────────────────────────────────────────────────── */

export type ActorInfo = { userId: number; role: string; name: string };

function audit(actor: ActorInfo, action: string, detail: string, moduleName = 'AI'): void {
  try {
    appendAuditRow({
      actor_id: actor.userId,
      actor_role: actor.role,
      actor_name: actor.name,
      module: 'AI',
      action: `${moduleName} · ${action}`,
      detail,
      method: 'AI',
      path: '/ai/agent',
    });
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/* ── 决策入口 ──────────────────────────────────────────────────────────── */

export type SentinelVerdict =
  | { verdict: 'allow' }
  | { verdict: 'ask'; token: string; summary: string; detail: string }
  | { verdict: 'deny'; reason: string };

/**
 * 评估一个「写类/不可逆」动作（读工具与只读技能不会走到这里）：
 *   - 全部允许：放行（但仍写审计）；
 *   - 全部询问（默认）：已有任务级放行 → 放行；否则生成确认单。
 */
export function judge(opts: {
  taskId: string;
  ownerUserId: number;
  actionKey: string;
  kind: string;
  payload: unknown;
  summary: string;
  moduleName: string;
  actor: ActorInfo;
  risk?: ActionRisk;
}): SentinelVerdict {
  sweepSentinel();
  const policy = getSafetyPolicy();
  const { taskId, ownerUserId, actionKey, kind, payload, summary, moduleName, actor } = opts;

  if (policy === 'alwaysAsk' && !isTaskAllowed(taskId, actionKey)) {
    const token = makeToken();
    pending.set(token, {
      token,
      ownerUserId,
      taskId,
      actionKey,
      kind,
      payload,
      summary,
      moduleName,
      createdAt: Date.now(),
    });
    audit(actor, '请求确认（全部询问）', summary, moduleName);
    return { verdict: 'ask', token, summary, detail: summary };
  }


  audit(actor, isTaskAllowed(taskId, actionKey) ? '任务内放行' : '策略放行（全部允许）', summary, moduleName);
  return { verdict: 'allow' };
}

export function getPending(token: string, userId: number): PendingAction | undefined {
  sweepSentinel();
  const action = pending.get(token);
  return action && action.ownerUserId === userId ? action : undefined;
}

/** 列出某个家长名下还没处理的确认单（页面刷新/切页后补弹） */
export function listPendingForOwner(userId: number): PendingAction[] {
  sweepSentinel();
  return [...pending.values()]
    .filter((a) => a.ownerUserId === userId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 家长对确认单作出决定。'task' 放行后同类动作本回合内不再询问。 */
export function resolvePending(token: string, userId: number, choice: PendingChoice): PendingAction | undefined {
  const action = pending.get(token);
  if (!action || action.ownerUserId !== userId) return undefined;
  pending.delete(token);
  if (choice === 'task') allowForTask(action.taskId, action.actionKey);
  return action;
}

export function auditConfirm(actor: ActorInfo, action: PendingAction, choice: PendingChoice, resultSummary: string): void {
  const label = choice === 'task' ? '确认（本次任务都允许）' : '确认（允许一次）';
  audit(actor, label, `${action.summary}${resultSummary ? ` → ${resultSummary}` : ''}`, action.moduleName);
}

/** 防目录穿越：技能/记忆目录下的相对路径必须解析后仍在目录内 */
export function ensureInsideDir(dir: string, sub: string): string {
  const resolved = path.resolve(dir, sub);
  if (!resolved.toLowerCase().startsWith(path.resolve(dir).toLowerCase())) {
    throw new Error('路径越界');
  }
  return resolved;
}
