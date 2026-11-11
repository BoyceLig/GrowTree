import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';
import { pushToParents, pushToUser, pushToAll } from '../ws.js';
import { awardContribution } from './contribution.js';
import { snapshotCompletion, emitCompletionTransitions } from '../review-notify.js';

// ─────────────────────────────────────────────────────────────────────────────
// 周期性任务：家长创建（每日 / 每周若干天 / 每月第 N 天），孩子自己「领取」，
// 完成后提交申请，家长审核通过后加积分。
//
// 「期」的划分：
//   daily   → 每天一期，period_key = 当天日期 YYYY-MM-DD
//   weekly  → 每个选中的星期几各是一期，period_key = 那一天的日期 YYYY-MM-DD
//   weekly + weekly_once=1 → 整周算一期（2026-10-24 用户要求「多天只完成一次」），
//             period_key = 本周一日期；只有选中的星期几才有期次（非选中日 = null，
//             「今天没有这一期」），选中的那天里任领一次
//   monthly → 每月一期，period_key = YYYY-MM，截止 = 本月 month_day 号的 due_time
// 不预生成实例，领取时才落库 —— 空期次（没人领）不占存储，也不需要后台定时器。
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAY_TEXT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时区日期字符串 YYYY-MM-DD（不要用 toISOString，那是 UTC） */
function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO 星期几：周一=1 … 周日=7 */
function isoWeekday(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

/** 本周一 0 点（ISO 周，周一起算）。weekly_once 的期次 key 与截止日都从它推 */
function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** "HH:MM" → {h,m}；非法/为空按 23:59（当天结束前）处理 */
function parseDueTime(t: string | null | undefined): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? '');
  if (!m) return { h: 23, m: 59 };
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

/** 某天的 due_time 时刻对应的 unix 秒 */
function dueAtOfDay(d: Date, hm: { h: number; m: number }): number {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hm.h, hm.m, 0, 0);
  return Math.floor(x.getTime() / 1000);
}

export interface RecurringTaskRow {
  id: number;
  name: string;
  description: string | null;
  points: number;
  freq_type: 'daily' | 'weekly' | 'monthly';
  /** 1 = 单次任务（发布时不选重复频率）：一生只有一期，做完不再出现 */
  once_only: number;
  /** 1 = 每周多天只完成一次（2026-10-24 用户要求）：选中的星期几合起来算一期，
   *  孩子哪一天做完都算，一周只领一次。仅 freq_type='weekly' 有意义 */
  weekly_once: number;
  weekdays: string | null;
  month_day: number | null;
  due_time: string | null;
  child_ids: string | null;
  valid_from: string | null;
  valid_to: string | null;
  enabled: number;
  created_at: number;
}

export interface PeriodInfo {
  period_key: string;
  /** 本期最后完成时间 unix 秒；单次任务不设有效期结束日时为 null（= 不过期） */
  due_at: number | null;
  /** 当前时刻是否还能领取（未过 due_at） */
  claimable: boolean;
}

/** 单次任务唯一的期次 key：直接写成中文，审核中心/记录行直接展示，不必两端各自翻译 */
export const ONCE_PERIOD_KEY = '单次任务';

/** 记录的「完成日」：取领取时快照下来的期次截止时间所在的本地日期。
 *  —— 归日按任务期次算，家长晚审核不会把完成日挪到审核那天（晚审只影响何时加分）。
 *  due_at 缺失的老记录退回领取日期 claimed_at。
 *  preferClaimedAt：单次任务没有「期次」概念（可以隔几天才做），改成按**领取那天**归日。 */
export function claimPeriodDate(
  c: { due_at?: number | null; claimed_at?: number | null },
  preferClaimedAt = false
): string | null {
  const ts = (preferClaimedAt ? c.claimed_at ?? c.due_at : c.due_at ?? c.claimed_at) ?? null;
  if (!ts) return null;
  return dateStr(new Date(ts * 1000));
}

// ── 计时 ────────────────────────────────────────────────────────────────────
// 孩子领取任务后可以按「开始计时」，暂停时不计入有效用时，停止/提交时定稿。
// 状态机（都存在 recurring_claims 的 timer_* 列上，不需要额外的表）：
//   idle   没开始                      accum=0    started=null paused=null total=null
//   running 计时中                      started!=null, paused=null
//   paused  暂停中（有效用时冻结）        started=null, paused!=null
//   stopped 已定稿（停止/提交时写下 total）
// 有效用时 = accum + (running ? now - started : 0)；暂停用时 = pausedAccum + (paused ? now - paused : 0)

export type TimerState = 'idle' | 'running' | 'paused' | 'stopped';

export interface TimerInfo {
  state: TimerState;
  /** 有效用时毫秒（不含暂停） */
  used_ms: number;
  /** 暂停用时毫秒 */
  paused_ms: number;
}

export function timerInfo(c: any, nowMs: number = Date.now()): TimerInfo {
  const accum = Number(c?.timer_accum_ms ?? 0);
  const pausedAccum = Number(c?.timer_paused_ms ?? 0);
  const startedAt = c?.timer_started_at ?? null;
  const pausedAt = c?.timer_paused_at ?? null;
  const total = c?.timer_total_ms ?? null;

  if (total !== null && total !== undefined) {
    return { state: 'stopped', used_ms: Number(total), paused_ms: pausedAccum };
  }
  if (startedAt) {
    return { state: 'running', used_ms: accum + Math.max(0, nowMs - startedAt * 1000), paused_ms: pausedAccum };
  }
  if (pausedAt) {
    return { state: 'paused', used_ms: accum, paused_ms: pausedAccum + Math.max(0, nowMs - pausedAt * 1000) };
  }
  if (accum > 0 || pausedAccum > 0) {
    // 兼容：没写 total 但已经计过时（历史数据/异常中断）→ 按已累计的当结果
    return { state: 'stopped', used_ms: accum, paused_ms: pausedAccum };
  }
  return { state: 'idle', used_ms: 0, paused_ms: 0 };
}

/** 有效时间段判断：今天是否落在 [valid_from, valid_to] 内（含边界；NULL 表示不限） */
export function withinValidRange(task: RecurringTaskRow, now: Date = new Date()): boolean {
  const today = dateStr(now);
  if (task.valid_from && today < task.valid_from) return false;
  if (task.valid_to && today > task.valid_to) return false;
  return true;
}

/** 计算任务「当前期次」；每周任务今天不是选定日时返回 null；不在有效期内也返回 null */
export function currentPeriod(task: RecurringTaskRow, now: Date = new Date()): PeriodInfo | null {
  // 不在有效时间段内 → 没有当前期次
  if (!withinValidRange(task, now)) return null;

  const hm = parseDueTime(task.due_time);

  // 单次任务：一生只有一期（key 固定），
  //   · 设了结束日期 → 截止 = 结束日当天 due_time，过了就作废；
  //   · 没设结束日期 → 不失效（due_at = null），领了慢慢做，什么时候提交都行。
  if (task.once_only) {
    if (!task.valid_to) return { period_key: ONCE_PERIOD_KEY, due_at: null, claimable: true };
    // valid_to 是日期字符串，转成本地 Date 再取当天 due_time
    const [y, m, d] = task.valid_to.split('-').map(Number);
    const due = dueAtOfDay(new Date(y, (m ?? 1) - 1, d ?? 1), hm);
    return { period_key: ONCE_PERIOD_KEY, due_at: due, claimable: now.getTime() / 1000 <= due };
  }

  if (task.freq_type === 'daily') {
    return { period_key: dateStr(now), due_at: dueAtOfDay(now, hm), claimable: now.getTime() / 1000 <= dueAtOfDay(now, hm) };
  }
  if (task.freq_type === 'weekly') {
    let weekdays: number[] = [];
    try { weekdays = JSON.parse(task.weekdays ?? '[]'); } catch { /* skip */ }
    if (!weekdays.length) return null;

    // 多天只完成一次（weekly_once）：整周算一期。期次 key 用本周一日期，
    // 截止 = 选中的最后一个星期几的 due_time。
    // 今天**不是选中的星期几 → 返回 null（=「今天没有这一期」），两端按「今天不用做」
    // 处理：家长端三个标签都不出现、孩子端列表隐藏。2026-11-02 用户反馈：周一不该
    // 把「还没到周五」的任务显示成「超时没领」——任选一天的窗口是选中的那几天，
    // 没到窗口就是没到，不是超时。今天是选中日但已过截止（如自定义了较早的
    // due_time）→ 正常返回 claimable=false，显示「本期已过」。
    if (task.weekly_once === 1) {
      if (!weekdays.includes(isoWeekday(now))) return null;
      const monday = startOfWeek(now);
      const lastDay = new Date(monday);
      lastDay.setDate(lastDay.getDate() + Math.max(...weekdays) - 1);
      const due = dueAtOfDay(lastDay, hm);
      return { period_key: dateStr(monday), due_at: due, claimable: now.getTime() / 1000 <= due };
    }

    if (!weekdays.includes(isoWeekday(now))) return null;
    const due = dueAtOfDay(now, hm);
    return { period_key: dateStr(now), due_at: due, claimable: now.getTime() / 1000 <= due };
  }
  // monthly：本月 month_day 号的 due_time；过点后本期不可领取（下月自动新一期）
  const monthDay = task.month_day ?? 1;
  const due = dueAtOfDay(new Date(now.getFullYear(), now.getMonth(), monthDay), hm);
  return {
    period_key: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
    due_at: due,
    claimable: now.getTime() / 1000 <= due,
  };
}

/** 前端展示用的频率文案，统一在服务端算，避免两端各写一份 */
export function freqText(task: RecurringTaskRow): string {
  if (task.once_only) return '单次';
  if (task.freq_type === 'daily') return '每天';
  if (task.freq_type === 'weekly') {
    let weekdays: number[] = [];
    try { weekdays = JSON.parse(task.weekdays ?? '[]'); } catch { /* skip */ }
    weekdays.sort((a, b) => a - b);
    const days = weekdays.map((w) => WEEKDAY_TEXT[w] ?? w).join('、');
    // 多天只完成一次：文案要说清「哪一天做都行」，否则家长看到「每周五、六、日」
    // 会以为每天都有一条（2026-10-24 用户要求）
    return task.weekly_once === 1 ? `${days}任选一天` : `每周${days}`;
  }
  return `每月${task.month_day ?? 1}号`;
}

/** 有效时间段的展示文案；两段都不设则为 null */
export function validText(task: { valid_from?: string | null; valid_to?: string | null }): string | null {
  const from = task.valid_from;
  const to = task.valid_to;
  if (!from && !to) return null;
  if (from && to) return `${from} 至 ${to}`;
  if (from) return `${from} 起`;
  return `截至 ${to}`;
}

// ── 校验 ────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const upsertSchema = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(200).nullable().optional(),
  points: z.number().int().positive(),
  /** 单次任务：不选重复频率时前端传 true（freq_type 仅作占位，语义以本字段为准） */
  once_only: z.boolean().optional(),
  freq_type: z.enum(['daily', 'weekly', 'monthly']).optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).nullable().optional(),
  /** 每周多天只完成一次（2026-10-24 用户要求）：仅 weekly 有意义，其它频率忽略 */
  weekly_once: z.boolean().optional(),
  month_day: z.number().int().min(1).max(28).nullable().optional(), // 1-28，避开 2 月缺号
  due_time: z.string().regex(/^([01]?\d|2[0-3]):([0-5]\d)$/).nullable().optional(),
  child_ids: z.array(z.number().int().positive()).nullable().optional(), // 空/NULL = 所有小孩
  valid_from: z.string().regex(DATE_RE).nullable().optional(), // 生效起始日 YYYY-MM-DD
  valid_to: z.string().regex(DATE_RE).nullable().optional(),   // 生效结束日 YYYY-MM-DD
  enabled: z.boolean().optional(),
});

const updateSchema = upsertSchema.partial();

// ── 路由 ────────────────────────────────────────────────────────────────────

export function registerRecurringTasksRoutes(app: FastifyInstance) {
  // 家长：创建周期任务
  app.post('/recurring-tasks', { preHandler: requireParent }, async (req, reply) => {
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    const { name, description, points, freq_type, weekdays, month_day, due_time, child_ids, valid_from, valid_to, once_only, weekly_once } = parsed.data;
    const isOnce = once_only === true;
    // 单次任务没有重复频率，freq_type 只是占位（DB 的 CHECK 约束不允许空）
    const freqType = isOnce ? 'daily' : freq_type ?? 'daily';
    // 多天只完成一次只对每周任务有意义，其它频率一律按 0 落库
    const weeklyOnce = !isOnce && freqType === 'weekly' && weekly_once === true ? 1 : 0;

    if (!isOnce && freqType === 'weekly' && (!weekdays || weekdays.length === 0)) {
      return reply.code(400).send({ error: 'weekdays_required' });
    }
    if (!isOnce && freqType === 'monthly' && !month_day) {
      return reply.code(400).send({ error: 'month_day_required' });
    }
    if (valid_from && valid_to && valid_from > valid_to) {
      return reply.code(400).send({ error: 'invalid_valid_range' });
    }

    // 校验所选小孩存在且都是孩子角色
    if (child_ids && child_ids.length > 0) {
      const db0 = getDb();
      const placeholders = child_ids.map(() => '?').join(',');
      const found = db0.prepare(`SELECT id FROM users WHERE id IN (${placeholders}) AND role = 'child'`).all(...child_ids) as any[];
      if (found.length !== new Set(child_ids).size) {
        return reply.code(400).send({ error: 'invalid_children' });
      }
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO recurring_tasks (name, description, points, freq_type, once_only, weekly_once, weekdays, month_day, due_time, child_ids, valid_from, valid_to, enabled, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      name,
      description ?? null,
      points,
      freqType,
      isOnce ? 1 : 0,
      weeklyOnce,
      !isOnce && freqType === 'weekly' ? JSON.stringify([...new Set(weekdays ?? [])].sort()) : null,
      !isOnce && freqType === 'monthly' ? month_day ?? null : null,
      due_time ?? null,
      child_ids && child_ids.length > 0 ? JSON.stringify([...new Set(child_ids)]) : null,
      valid_from ?? null,
      valid_to ?? null,
      req.user!.sub
    );

    // 任务本身变了 → 两端（孩子端 + 其它家长端）静默重拉，保证「可领取」标签实时
    pushToAll({ type: 'recurring_tasks_changed', action: 'created' });

    return { ok: true };
  });

  // 家长：周期任务列表（含当前期次信息与待审核数）
  app.get('/recurring-tasks', { preHandler: requireParent }, async () => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM recurring_tasks ORDER BY created_at DESC').all() as RecurringTaskRow[];
    const now = new Date();

    const tasks = rows.map((t) => {
      const period = currentPeriod(t, now);
      const pending = db.prepare(`
        SELECT COUNT(*) as c FROM recurring_claims WHERE task_id = ? AND status = 'pending'
      `).get(t.id) as { c: number };
      // 领取记录（含孩子信息）：家长端「已领取 / 已完成」分类展示用
      const claims = db.prepare(`
        SELECT rc.id, rc.user_id, rc.period_key, rc.status, rc.due_at,
          rc.claimed_at, rc.submitted_at, rc.reviewed_at,
          rc.timer_accum_ms, rc.timer_started_at, rc.timer_paused_ms, rc.timer_paused_at, rc.timer_total_ms,
          u.name as user_name, u.avatar as user_avatar
        FROM recurring_claims rc
        JOIN users u ON u.id = rc.user_id
        WHERE rc.task_id = ?
        ORDER BY rc.claimed_at DESC
        LIMIT 200
      `).all(t.id) as any[];
      // 附上完成日（期次归属日）：家长端「已完成」标签按它归日，而不是审核时间
      for (const c of claims) {
        c.period_date = claimPeriodDate(c, t.once_only === 1);
        // 用时（家长端在每条记录后面显示「用了多久 + 暂停多久」）
        c.timer = timerInfo(c);
      }
      // 指定小孩的名字列表（NULL = 全部小孩）
      let child_ids: number[] | null = null;
      try { child_ids = t.child_ids ? JSON.parse(t.child_ids) : null; } catch { child_ids = null; }
      let child_names: string[] | null = null;
      if (child_ids && child_ids.length > 0) {
        const placeholders = child_ids.map(() => '?').join(',');
        child_names = (db.prepare(`SELECT name FROM users WHERE id IN (${placeholders})`).all(...child_ids) as any[]).map((u) => u.name);
      }
      return {
        ...t,
        freq_text: freqText(t),
        valid_text: validText(t),
        in_range: withinValidRange(t, now),
        current_period: period,
        pending_count: pending.c,
        child_names,
        claims,
      };
    });

    return { tasks };
  });

  // 家长：编辑周期任务
  app.patch('/recurring-tasks/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const data = parsed.data;

    if (data.freq_type === 'weekly' && data.once_only !== true && data.weekdays !== undefined && (!data.weekdays || data.weekdays.length === 0)) {
      return reply.code(400).send({ error: 'weekdays_required' });
    }

    const db = getDb();
    const task = db.prepare('SELECT * FROM recurring_tasks WHERE id = ?').get(id) as RecurringTaskRow | undefined;
    if (!task) return reply.code(404).send({ error: 'not_found' });

    // 单次任务：显式传了以传入值为准，没传就沿用原值
    const isOnce = data.once_only === undefined ? task.once_only === 1 : data.once_only === true;
    const freqType = isOnce ? 'daily' : data.freq_type ?? task.freq_type;
    const weekdays = isOnce
      ? null
      : data.weekdays !== undefined
        ? freqType === 'weekly' ? JSON.stringify([...new Set(data.weekdays ?? [])].sort()) : null
        : task.weekdays;
    const monthDay = isOnce
      ? null
      : data.month_day !== undefined
        ? freqType === 'monthly' ? data.month_day : null
        : task.month_day;
    // 多天只完成一次：显式传了以传入值为准，没传沿用原值；只对每周任务有效
    // （改成别的频率 / 单次时一律落 0，否则切频率再切回来会莫名带着开启态）
    const weeklyOnce =
      !isOnce && freqType === 'weekly'
        ? data.weekly_once !== undefined
          ? data.weekly_once === true
          : task.weekly_once === 1
        : false;
    // 有效期：显式传 null 表示清除，未传表示保持原值
    const validFrom = data.valid_from !== undefined ? data.valid_from : task.valid_from;
    const validTo = data.valid_to !== undefined ? data.valid_to : task.valid_to;
    if (validFrom && validTo && validFrom > validTo) {
      return reply.code(400).send({ error: 'invalid_valid_range' });
    }

    db.prepare(`
      UPDATE recurring_tasks SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        points = COALESCE(?, points),
        freq_type = ?,
        once_only = ?,
        weekly_once = ?,
        weekdays = ?,
        month_day = ?,
        due_time = COALESCE(?, due_time),
        child_ids = ?,
        valid_from = ?,
        valid_to = ?,
        enabled = COALESCE(?, enabled),
        is_preset = 0
      WHERE id = ?
    `).run(
      data.name ?? null,
      data.description ?? null,
      data.points ?? null,
      freqType,
      isOnce ? 1 : 0,
      weeklyOnce ? 1 : 0,
      weekdays,
      monthDay,
      data.due_time ?? null,
      data.child_ids !== undefined
        ? (data.child_ids && data.child_ids.length > 0 ? JSON.stringify([...new Set(data.child_ids)]) : null)
        : task.child_ids,
      validFrom ?? null,
      validTo ?? null,
      data.enabled === undefined ? null : data.enabled ? 1 : 0,
      id
    );

    // 编辑 / 启停 / 改有效期 → 两端静默重拉
    // （is_preset 一并清 0：模板预置的任务一经家长编辑就按「自己发的」算，
    //   「任务发布」积分任务的进度由此 +1，见 ext/routes/signin-tasks.ts）
    pushToAll({ type: 'recurring_tasks_changed', action: 'updated' });

    return { ok: true };
  });

  // 家长：删除周期任务（连同领取记录级联删除）
  app.delete('/recurring-tasks/:id', { preHandler: requireParent }, async (req) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    // 删之前先记下受影响的孩子（任务没了，孩子端对应标签要立刻消失）
    const affected = db.prepare('SELECT DISTINCT user_id FROM recurring_claims WHERE task_id = ?').all(id) as any[];
    db.prepare('DELETE FROM recurring_tasks WHERE id = ?').run(id);
    for (const row of affected) {
      pushToUser(row.user_id, { type: 'recurring_claims_cleared', taskId: id });
    }
    pushToAll({ type: 'recurring_tasks_changed', action: 'deleted' });
    return { ok: true };
  });

  // 家长：只删除某周期任务的领取/完成记录（任务本身保留，孩子端可重新领取）
  app.delete('/recurring-tasks/:id/claims', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const task = db.prepare('SELECT id, name FROM recurring_tasks WHERE id = ?').get(id) as any;
    if (!task) return reply.code(404).send({ error: 'not_found' });

    // 记录受影响的孩子，删完后逐个推送刷新
    const affected = db.prepare('SELECT DISTINCT user_id FROM recurring_claims WHERE task_id = ?').all(id) as any[];
    db.prepare('DELETE FROM recurring_claims WHERE task_id = ?').run(id);
    for (const row of affected) {
      pushToUser(row.user_id, { type: 'recurring_claims_cleared', taskId: id, taskName: task.name });
    }
    pushToParents({ type: 'recurring_claims_cleared', taskId: id, taskName: task.name });
    return { ok: true };
  });

  // 家长：删除单条领取/完成记录（已完成标签下按孩子单独删除用）
  app.delete('/recurring-tasks/claims/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const claim = db.prepare('SELECT id, task_id, user_id, period_key FROM recurring_claims WHERE id = ?').get(id) as any;
    if (!claim) return reply.code(404).send({ error: 'not_found' });
    db.prepare('DELETE FROM recurring_claims WHERE id = ?').run(id);
    pushToUser(claim.user_id, { type: 'recurring_claims_cleared', taskId: claim.task_id });
    pushToParents({ type: 'recurring_claims_cleared', taskId: claim.task_id });
    return { ok: true };
  });

  // 孩子端：保存「我的任务」自定义顺序（可领取标签下拖拽排序）
  app.post('/recurring-tasks/reorder', async (req, reply) => {
    if (req.user!.role !== 'child') return reply.code(403).send({ error: 'forbidden' });
    const parsed = z.object({ ids: z.array(z.number().int().positive()).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const uid = req.user!.sub;
    const ids = parsed.data.ids;
    if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'duplicate_ids' });

    const db = getDb();
    // 只接受「这个孩子当前可见的全部任务」的一个排列：数量、去重、存在性都要对得上。
    // 家长刚发布/停用/删除过任务时，孩子端手里的顺序就过期了 → 409，前端重拉后重排。
    const rows = db.prepare('SELECT * FROM recurring_tasks WHERE enabled = 1').all() as RecurringTaskRow[];
    const mine = rows
      .filter((t) => {
        if (!t.child_ids) return true;
        try { return (JSON.parse(t.child_ids) as number[]).includes(uid); } catch { return true; }
      })
      .map((t) => t.id);
    if (ids.length !== mine.length || !ids.every((id) => mine.includes(id))) {
      return reply.code(409).send({ error: 'stale_list' });
    }

    const txn = db.transaction(() => {
      db.prepare('DELETE FROM child_task_orders WHERE user_id = ?').run(uid);
      const ins = db.prepare('INSERT INTO child_task_orders (user_id, task_id, sort_order) VALUES (?, ?, ?)');
      ids.forEach((id, idx) => ins.run(uid, id, idx));
    });
    txn();
    return { ok: true };
  });

  // 孩子端：可领取的周期任务列表（含本期我的领取状态）
  app.get('/recurring-tasks/available', async (req) => {
    const db = getDb();
    const uid = req.user!.sub;
    const role = req.user!.role;
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);

    let rows = db.prepare('SELECT * FROM recurring_tasks WHERE enabled = 1').all() as RecurringTaskRow[];

    // 只看得到指定给自己的任务（child_ids 为空 = 所有小孩可见）
    if (role === 'child') {
      rows = rows.filter((t) => {
        if (!t.child_ids) return true;
        try { return (JSON.parse(t.child_ids) as number[]).includes(uid); } catch { return true; }
      });
    }

    // 这个孩子自己拖出来的顺序优先；没排过的（含家长刚发布的新任务）按创建时间排在后面。
    // 家长端拿到的是同一份 rows，但家长不传 role='child'，所以家长端始终按发布顺序。
    const orderMap = new Map<number, number>();
    if (role === 'child') {
      const orderRows = db
        .prepare('SELECT task_id, sort_order FROM child_task_orders WHERE user_id = ?')
        .all(uid) as { task_id: number; sort_order: number }[];
      for (const r of orderRows) orderMap.set(r.task_id, r.sort_order);
    }
    if (orderMap.size > 0) {
      rows = [...rows].sort((a, b) => {
        const oa = orderMap.get(a.id);
        const ob = orderMap.get(b.id);
        if (oa === undefined && ob === undefined) return (a.created_at ?? 0) - (b.created_at ?? 0) || a.id - b.id;
        if (oa === undefined) return 1;
        if (ob === undefined) return -1;
        return oa - ob;
      });
    } else {
      rows = [...rows].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.id - b.id);
    }

    const tasks = rows.map((t) => {
      const period = currentPeriod(t, now);
      let my_claim: any = null;
      if (period) {
        my_claim = db.prepare(`
          SELECT id, status, due_at, reason, submitted_at, claimed_at,
            timer_accum_ms, timer_started_at, timer_paused_ms, timer_paused_at, timer_total_ms
          FROM recurring_claims
          WHERE task_id = ? AND user_id = ? AND period_key = ?
        `).get(t.id, uid, period.period_key) ?? null;
        if (my_claim) {
          my_claim.period_date = claimPeriodDate(my_claim, t.once_only === 1);
          my_claim.timer = timerInfo(my_claim);
        }
      }
      // 我在该任务下的全部完成记录（孩子端「已完成」标签：当天直接展示、更早的放「更多」）
      const my_history = db.prepare(`
        SELECT id, period_key, reviewed_at, due_at, claimed_at,
          timer_accum_ms, timer_started_at, timer_paused_ms, timer_paused_at, timer_total_ms
        FROM recurring_claims
        WHERE task_id = ? AND user_id = ? AND status = 'approved'
        ORDER BY reviewed_at DESC
      `).all(t.id, uid) as any[];
      // 完成日按期次归属日算（家长晚审核不改完成日）
      for (const h of my_history) {
        h.period_date = claimPeriodDate(h, t.once_only === 1);
        h.timer = timerInfo(h);
      }
      // 已领取但过了截止还没提交 / 被拒后过了截止没再提交 → 本期已超时（不能再提交）
      if (
        my_claim &&
        (my_claim.status === 'claimed' || my_claim.status === 'rejected') &&
        my_claim.due_at &&
        nowSec > my_claim.due_at
      ) {
        my_claim.expired = true;
      }
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        points: t.points,
        freq_type: t.freq_type,
        once_only: t.once_only,
        freq_text: freqText(t),
        due_time: t.due_time,
        valid_from: t.valid_from,
        valid_to: t.valid_to,
        valid_text: validText(t),
        in_range: withinValidRange(t, now),
        current_period: period,
        my_claim,
        my_history,
      };
    });

    return { tasks, is_child: role === 'child' };
  });

  // 孩子端：领取本期任务
  app.post('/recurring-tasks/:id/claim', async (req, reply) => {
    if (req.user!.role !== 'child') return reply.code(403).send({ error: 'forbidden' });
    const id = Number((req.params as any).id);
    const db = getDb();
    const uid = req.user!.sub;
    const now = new Date();

    const task = db.prepare('SELECT * FROM recurring_tasks WHERE id = ? AND enabled = 1').get(id) as RecurringTaskRow | undefined;
    if (!task) return reply.code(404).send({ error: 'not_found' });

    if (!withinValidRange(task, now)) return reply.code(409).send({ error: 'out_of_valid_range' });

    const period = currentPeriod(task, now);
    if (!period) return reply.code(409).send({ error: 'not_scheduled_today' });
    // 多天只完成一次：今天不是选中的星期几 → 今天还不能领。
    // 「哪一天做都可以」指的是**选中的那几天**，不是一周里任意一天，
    // 所以这里单独拦一道，报 not_scheduled_today 而不是笼统的 period_overdue。
    if (task.freq_type === 'weekly' && task.weekly_once === 1) {
      let weekdays: number[] = [];
      try { weekdays = JSON.parse(task.weekdays ?? '[]'); } catch { /* skip */ }
      if (!weekdays.includes(isoWeekday(now))) {
        return reply.code(409).send({ error: 'not_scheduled_today' });
      }
    }
    if (!period.claimable) return reply.code(409).send({ error: 'period_overdue' });

    const existing = db.prepare(`
      SELECT id FROM recurring_claims WHERE task_id = ? AND user_id = ? AND period_key = ?
    `).get(id, uid, period.period_key);
    if (existing) return reply.code(409).send({ error: 'already_claimed' });

    db.prepare(`
      INSERT INTO recurring_claims (task_id, user_id, period_key, due_at)
      VALUES (?, ?, ?, ?)
    `).run(id, uid, period.period_key, period.due_at);

    const child = db.prepare('SELECT name FROM users WHERE id = ?').get(uid) as any;
    pushToParents({ type: 'recurring_claim_submitted', taskId: id, userId: uid, userName: child?.name, taskName: task.name });

    return { ok: true, due_at: period.due_at };
  });

  // 孩子端：提交完成申请（claimed → pending；rejected 可重新提交，但都要在期次截止前）
  app.post('/recurring-tasks/claims/:id/submit', async (req, reply) => {
    if (req.user!.role !== 'child') return reply.code(403).send({ error: 'forbidden' });
    const id = Number((req.params as any).id);
    const db = getDb();
    const uid = req.user!.sub;
    const nowSec = Math.floor(Date.now() / 1000);

    const claim = db.prepare('SELECT * FROM recurring_claims WHERE id = ? AND user_id = ?').get(id, uid) as any;
    if (!claim) return reply.code(404).send({ error: 'not_found' });
    if (claim.status === 'pending') return reply.code(409).send({ error: 'already_pending' });
    if (claim.status === 'approved') return reply.code(409).send({ error: 'already_approved' });
    // 领取后提交、被拒后重新提交，都必须在本期截止时间之前（due_at 是领取时快照的期次截止）
    if ((claim.status === 'claimed' || claim.status === 'rejected') && claim.due_at && nowSec > claim.due_at) {
      return reply.code(409).send({ error: 'period_overdue' });
    }

    // 提交前的完成度快照：之后用来判断这次提交有没有「凑齐当天/本周/本月」
    const preCompletion = snapshotCompletion(uid);

    // 提交即结束计时：把正在跑的一段结算掉并定稿总用时（家长端看到的用时就取它）
    const timer = timerInfo(claim);
    const timerTotal = timer.state === 'idle' ? null : timer.used_ms;
    db.prepare(`
      UPDATE recurring_claims SET status = 'pending', submitted_at = ?, reason = NULL,
        timer_accum_ms = ?, timer_started_at = NULL,
        timer_paused_ms = ?, timer_paused_at = NULL,
        timer_total_ms = ?
      WHERE id = ?
    `).run(nowSec, timer.state === 'idle' ? 0 : timer.used_ms, timer.state === 'idle' ? 0 : timer.paused_ms, timerTotal, id);

    const task = db.prepare('SELECT name FROM recurring_tasks WHERE id = ?').get(claim.task_id) as any;
    const child = db.prepare('SELECT name, family_id FROM users WHERE id = ?').get(uid) as any;
    pushToParents({ type: 'recurring_claim_submitted', taskId: claim.task_id, userId: uid, userName: child?.name, taskName: task?.name });

    // 订阅消息（2026-10-27 改版）：task_review 不再逐条即时提醒，
    // 改成每天 9 点的待审汇总（见 ext/notify-jobs.ts runReviewDigest）——
    // 家长一上午收 N 条「待审核」只会把它变成噪音，汇总一条刚刚好。

    // 集中提醒：当天全部必做交齐 → 提醒一次；全家本周/本月必做交齐 → 周报/月报提醒
    emitCompletionTransitions(uid, preCompletion, snapshotCompletion(uid));

    return { ok: true };
  });

  // 孩子端：计时（开始 / 暂停 / 继续 / 停止）—— 只能操作自己那条领取记录
  //   start：开始或从暂停继续（暂停的那段结算进「暂停用时」）
  //   pause：暂停（这一段的运行时长结算进「有效用时」，暂停期间不再计时）
  //   stop ：结束并定稿总用时（提交时后端会自动做同样的事）
  app.post('/recurring-tasks/claims/:id/timer/:action', async (req, reply) => {
    if (req.user!.role !== 'child') return reply.code(403).send({ error: 'forbidden' });
    const id = Number((req.params as any).id);
    const action = String((req.params as any).action);
    if (action !== 'start' && action !== 'pause' && action !== 'stop') {
      return reply.code(404).send({ error: 'not_found' });
    }

    const db = getDb();
    const uid = req.user!.sub;
    const claim = db.prepare('SELECT * FROM recurring_claims WHERE id = ? AND user_id = ?').get(id, uid) as any;
    if (!claim) return reply.code(404).send({ error: 'not_found' });
    if (claim.status === 'pending') return reply.code(409).send({ error: 'already_submitted' });
    if (claim.status === 'approved') return reply.code(409).send({ error: 'already_approved' });

    const nowSec = Math.floor(Date.now() / 1000);
    const t = timerInfo(claim);
    let accum = Number(claim.timer_accum_ms ?? 0);
    let pausedAccum = Number(claim.timer_paused_ms ?? 0);
    let startedAt: number | null = claim.timer_started_at ?? null;
    let pausedAt: number | null = claim.timer_paused_at ?? null;
    let total: number | null = claim.timer_total_ms ?? null;

    if (action === 'start') {
      if (total !== null) return reply.code(409).send({ error: 'timer_finished' });
      if (startedAt) return reply.code(409).send({ error: 'timer_running' });
      if (pausedAt) {
        pausedAccum = t.paused_ms;   // 暂停这段到此为止
        pausedAt = null;
      }
      startedAt = nowSec;
    } else if (action === 'pause') {
      if (total !== null) return reply.code(409).send({ error: 'timer_finished' });
      if (!startedAt) return reply.code(409).send({ error: 'timer_not_running' });
      accum = t.used_ms;
      startedAt = null;
      pausedAt = nowSec;
    } else {
      if (total !== null) return reply.code(409).send({ error: 'timer_finished' });
      accum = t.used_ms;
      pausedAccum = t.paused_ms;
      startedAt = null;
      pausedAt = null;
      total = accum;
    }

    db.prepare(`
      UPDATE recurring_claims SET
        timer_accum_ms = ?, timer_started_at = ?, timer_paused_ms = ?, timer_paused_at = ?, timer_total_ms = ?
      WHERE id = ?
    `).run(accum, startedAt, pausedAccum, pausedAt, total, id);

    const after = db.prepare('SELECT * FROM recurring_claims WHERE id = ?').get(id) as any;
    return { ok: true, timer: timerInfo(after) };
  });

  // 家长端：周期任务完成申请列表（审核中心用）
  app.get('/recurring-tasks/claims', { preHandler: requireParent }, async (req) => {
    const db = getDb();
    const status = (req.query as any)?.status ?? 'pending';

    const rows = db.prepare(`
      SELECT rc.id, rc.task_id, rc.user_id, rc.period_key, rc.due_at, rc.status, rc.reason,
        rc.claimed_at, rc.submitted_at, rc.reviewed_at,
        rc.timer_accum_ms, rc.timer_started_at, rc.timer_paused_ms, rc.timer_paused_at, rc.timer_total_ms,
        t.name as task_name, t.points as task_points, t.freq_type as task_freq_type,
        u.name as user_name, u.avatar as user_avatar
      FROM recurring_claims rc
      JOIN recurring_tasks t ON t.id = rc.task_id
      JOIN users u ON u.id = rc.user_id
      WHERE rc.status = ?
      ORDER BY rc.submitted_at DESC, rc.claimed_at DESC
    `).all(status) as any[];

    // 审核时也能看到「这个任务孩子做了多久」（含暂停多久）
    for (const r of rows) r.timer = timerInfo(r);

    return { completions: rows };
  });

  // 家长端：通过 → 加积分
  app.post('/recurring-tasks/claims/:id/approve', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();

    const claim = db.prepare(`
      SELECT rc.*, t.name as task_name, t.points as task_points
      FROM recurring_claims rc
      JOIN recurring_tasks t ON t.id = rc.task_id
      WHERE rc.id = ?
    `).get(id) as any;
    if (!claim) return reply.code(404).send({ error: 'not_found' });
    if (claim.status !== 'pending') return reply.code(409).send({ error: 'already_reviewed' });

    const now = Math.floor(Date.now() / 1000);
    // 加分的「时间」记孩子**提交申请**的时间（submitted_at），不是家长审核的时间。
    // 家长隔天/隔几天才审，这笔分仍算在提交那天；老记录万一没有 submitted_at 就退回领取时间。
    const awardedAt = claim.submitted_at ?? claim.claimed_at ?? now;
    const txn = db.transaction(() => {
      db.prepare('UPDATE users SET total_points = total_points + ? WHERE id = ?').run(claim.task_points, claim.user_id);
      // source 复用 'adhoc'（point_logs 的 CHECK 约束不重建表没法扩），备注里标明是周期任务
      db.prepare(`
        INSERT INTO point_logs (user_id, delta, source, ref_id, note, created_by, created_at)
        VALUES (?, ?, 'adhoc', ?, ?, ?, ?)
      `).run(claim.user_id, claim.task_points, claim.task_id, `周期任务：${claim.task_name}（${claim.period_key}）`, req.user!.sub, awardedAt);
      // 家庭贡献值（晒娃时刻）：当天首次过审 +每日分，攒满 7 天再 +连续奖励
      awardContribution(db, claim.user_id, awardedAt, req.user!.sub);
      db.prepare(`
        UPDATE recurring_claims SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?
      `).run(req.user!.sub, now, id);
    });
    txn();

    const newBalance = (db.prepare('SELECT total_points FROM users WHERE id = ?').get(claim.user_id) as any).total_points;
    pushToUser(claim.user_id, { type: 'recurring_review', claimId: id, status: 'approved', points: claim.task_points });
    // 其它家长端（多设备/多家长）也要把「已完成」标签刷新到最新
    pushToParents({ type: 'recurring_review', claimId: id, status: 'approved', points: claim.task_points });

    return { ok: true, newBalance, delta: claim.task_points };
  });

  // 家长端：拒绝（孩子可重新提交，直到本期截止）
  app.post('/recurring-tasks/claims/:id/reject', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const reason = (req.body as any)?.reason ?? '';
    const db = getDb();

    const claim = db.prepare(`
      SELECT rc.*, t.name as task_name
      FROM recurring_claims rc
      JOIN recurring_tasks t ON t.id = rc.task_id
      WHERE rc.id = ?
    `).get(id) as any;
    if (!claim) return reply.code(404).send({ error: 'not_found' });
    if (claim.status !== 'pending') return reply.code(409).send({ error: 'already_reviewed' });

    db.prepare(`
      UPDATE recurring_claims SET status = 'rejected', reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?
    `).run(reason || null, req.user!.sub, Math.floor(Date.now() / 1000), id);

    pushToUser(claim.user_id, { type: 'recurring_review', claimId: id, status: 'rejected', reason });
    pushToParents({ type: 'recurring_review', claimId: id, status: 'rejected', reason });

    return { ok: true };
  });
}
