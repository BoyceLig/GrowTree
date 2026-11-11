import { getDb, getRawDb } from './db/index.js';
import { currentPeriod, type RecurringTaskRow } from './routes/recurring-tasks.js';
import { emitNotify, type NotifyRecipient } from './notify-hook.js';

/**
 * 周报/月报的触发判定（2026-10-26）。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────
 *   孩子每提交一项任务都会有一条「逐条提醒」（task_review，留在各路由里）。
 *   在此之外还有两种「凑齐了」的时刻，需要跨任务、跨孩子地算账：
 *     · 周报：本周该交的必做都交齐了（超时漏交与未到期的都不算）→ 推本周成长海报提醒；
 *     · 月报：同理按自然月。
 *   「必做」的口径与许愿单全勤一致（wish-items.ts requiredOn）：
 *   这一期正好在今天到期，才算当天必做；周/月范围则逐天累计。
 *
 * ── 周/月报的「完成」口径（2026-10-26 用户拍板）─────────────────────
 *   统计期内每个「任务 × 孩子」单位只有两种下场：
 *     · 已完成：期内交过 ≥1 次（待审或已过都算）；
 *     · 该交没交：就是今天到期、还没交 → 阻碍推送。
 *   其余一律不统计、不阻碍：
 *     · 超时未领取 / 超时未完成（截止日已过、一直没交）——漏了就是漏了，
 *       不让一笔旧账把周报永远压住；
 *     · 还没到截止日的（本周内可领但不必须现在完成的，含截止在下周/下月的）
 *       ——未来那几天没法提前交齐，不该挡今天的推送。
 *   所以触发时机 = 「今天到期的必做全部交齐」的那一刻；
 *   若始终没等到那一刻，周一 / 1 日上午的兜底照推（notify-jobs.ts）。
 *
 * ── 为什么放共享层 ────────────────────────────────────────────────
 *   判定只用业务表（getDb，租户层自动按家庭收口）和中性钩子 emitNotify，
 *   一行商业代码都不沾。ext 侧（文案、后台配置、去重后的发送）由钩子注入，
 *   自建版没注册钩子时这里全是空操作。
 *
 * ── 「跳变」语义 ─────────────────────────────────────────────────
 *   调用方在提交**前**拍一次快照、提交成功**后**再拍一次：
 *   某一档从「未全部提交」变成「全部提交」的那一次提交才触发提醒，
 *   避免第 2、3 个孩子提交时重复轰炸。
 */

interface RangeStat {
  total: number;
  submitted: number;
}

export interface CompletionSnapshot {
  week: RangeStat;
  month: RangeStat;
}

/* ── 基础小件 ────────────────────────────────────────────────────── */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function tsOf(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/**
 * 周报「统计时间」：2026.10.26~2026.11.1
 * 与微信模板 time5 的示例（2021.5.10~2021.5.16）同格式：年.月.日~年.月.日，不补零。
 */
export function rangeText(from: Date, to: Date): string {
  return `${from.getFullYear()}.${from.getMonth() + 1}.${from.getDate()}~${to.getFullYear()}.${to.getMonth() + 1}.${to.getDate()}`;
}

/**
 * 月报「统计范围」：2026-10-01 ~ 2026-10-31
 * 与微信模板 time3 的示例（2022-04-01 ~ 2022-04-30）同格式；d 传当月 1 号。
 * time 类占位符上限 24 字符，这个串正好 23 字符放得下。
 */
export function monthText(d: Date): string {
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ~ ${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
}

/** 自然周（周一为一周之始，与晒娃时刻海报同口径） */
export function weekRangeOf(now: Date = new Date()): { from: Date; to: Date } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const wd = from.getDay() === 0 ? 7 : from.getDay(); // 周日算第 7 天
  from.setDate(from.getDate() - (wd - 1));
  const to = new Date(from);
  to.setDate(to.getDate() + 6);
  return { from, to };
}

/** 自然月（1 号到月末） */
export function monthRangeOf(now: Date = new Date()): { from: Date; to: Date } {
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from, to };
}

/* ── 家庭数据的一次性取数 ────────────────────────────────────────── */

interface ChildRow {
  id: number;
  name: string;
}

function childrenOfFamily(familyId: number): ChildRow[] {
  return getDb()
    .prepare("SELECT id, name FROM users WHERE role = 'child' AND hidden = 0")
    .all() as ChildRow[];
}

function recurringTasks(): RecurringTaskRow[] {
  return getDb()
    .prepare('SELECT * FROM recurring_tasks WHERE enabled = 1')
    .all() as unknown as RecurringTaskRow[];
}

function taskChildIds(t: RecurringTaskRow, children: ChildRow[]): number[] {
  if (!t.child_ids) return children.map((c) => c.id);
  try {
    const ids = JSON.parse(t.child_ids) as number[];
    return children.filter((c) => ids.includes(c.id)).map((c) => c.id);
  } catch {
    return children.map((c) => c.id);
  }
}

/** 已提交（待审或已过）的周期任务领取：task:user:period 集合 */
function submittedClaimKeys(): Set<string> {
  const rows = getDb()
    .prepare(
      "SELECT task_id, user_id, period_key FROM recurring_claims WHERE status IN ('pending','approved')"
    )
    .all() as Array<{ task_id: number; user_id: number; period_key: string }>;
  return new Set(rows.map((r) => `${r.task_id}:${r.user_id}:${r.period_key}`));
}

/** 临时任务最新一次完成申请的状态（没有申请过 = undefined） */
function latestCompletionStatus(): Map<string, string> {
  const rows = getDb()
    .prepare(
      'SELECT task_id, user_id, status FROM task_completions ORDER BY created_at ASC'
    )
    .all() as Array<{ task_id: number; user_id: number; status: string }>;
  const map = new Map<string, string>();
  for (const r of rows) map.set(`${r.task_id}:${r.user_id}`, r.status); // 后写覆盖 = 最新
  return map;
}

/** 当天截止、还没做完的临时任务也算当天必做（active 才算，completed 的不算） */
function activeAdhocWithDeadline(): Array<{ id: number; user_id: number; deadline: number }> {
  return getDb()
    .prepare(
      "SELECT id, user_id, deadline FROM adhoc_tasks WHERE status = 'active' AND deadline IS NOT NULL"
    )
    .all() as Array<{ id: number; user_id: number; deadline: number }>;
}

/* ── 范围统计 ────────────────────────────────────────────────────── */

/**
 * 逐天扫 [from, to]，统计「必做单位」总数与已提交数。
 *
 * 单位 = (周期任务 × 孩子) 或 (临时任务)，按**任务**算而不按每天每次算。
 * 每个单位只有两种计入方式（其余一律不统计，见文件头「完成口径」）：
 *   · 已完成：统计期内交过 ≥1 次（待审或已过都算）——未来几天没法提前交，
 *     所以不能要求「每天都交齐」；
 *   · 该交没交：截止日就是今天、还没交 → 阻碍推送。
 * 超时未领取/未完成（截止日已过没交）和还没到截止日的都不统计、不阻碍：
 * 漏了的旧账不压周报，未来的任务也不挡今天的推送。
 */
function rangeStats(from: Date, to: Date, familyId: number, now: Date = new Date()): RangeStat {
  const children = childrenOfFamily(familyId);
  if (!children.length) return { total: 0, submitted: 0 };
  const tasks = recurringTasks();
  const claims = submittedClaimKeys();
  const comps = latestCompletionStatus();
  const adhocs = activeAdhocWithDeadline();
  const childIds = new Set(children.map((c) => c.id));
  const todayKey = dateKey(now);

  const done = new Set<string>();
  const outstanding = new Set<string>();
  const mark = (key: string, st: 'done' | 'outstanding'): void => {
    if (st === 'done') {
      done.add(key);
      outstanding.delete(key); // 交过一次就算完成，哪怕当天还有没交的期次
    } else if (!done.has(key)) {
      outstanding.add(key);
    }
  };

  // 临时任务：截止时刻还没过且未完成 → 未完成（阻碍）；截止时刻已过
  // （超时未完成，哪怕就是今天）或截止在未来 → 不统计
  for (const a of adhocs) {
    if (!childIds.has(a.user_id)) continue;
    const dueKey = dateKey(new Date(a.deadline * 1000));
    if (dueKey < dateKey(from) || dueKey > dateKey(to)) continue; // 不在统计期内
    const key = `adhoc:${a.id}`;
    const st = comps.get(`${a.id}:${a.user_id}`);
    if (st === 'pending' || st === 'approved') {
      mark(key, 'done');
    } else if (dueKey === todayKey && a.deadline > tsOf(now)) {
      mark(key, 'outstanding'); // 还来得及交，才算「该交没交」
    }
  }

  // 周期任务：逐天扫到期日落在统计期内的期次，只扫到今天为止——
  // 未来的期次交不了也不该挡；过期次没交 = 超时未领取（含今天到期时刻
  // 已过的，与 claimable 的 now <= due_at 同一界限），不统计
  const nowTs = tsOf(now);
  const day = new Date(from);
  for (; day <= to; day.setDate(day.getDate() + 1)) {
    const dayKey = dateKey(day);
    if (dayKey > todayKey) break;
    for (const t of tasks) {
      const p = currentPeriod(t, day);
      if (!p || p.due_at == null) continue;
      // 与许愿单全勤同口径：这一期正好在这一天到期才算这段时间的必做
      if (dateKey(new Date(p.due_at * 1000)) !== dayKey) continue;
      for (const uid of taskChildIds(t, children)) {
        const key = `${t.id}:${uid}`;
        if (claims.has(`${t.id}:${uid}:${p.period_key}`)) mark(key, 'done');
        else if (dayKey === todayKey && p.due_at > nowTs) mark(key, 'outstanding');
      }
    }
    if (dayKey === todayKey) break; // 扫到今天即可（也顺带避免跨月翻月）
  }
  return { total: done.size + outstanding.size, submitted: done.size };
}

function statOk(s: RangeStat): boolean {
  return s.total > 0 && s.submitted >= s.total;
}

/* ── 对外：快照 + 跳变触发 ───────────────────────────────────────── */

function familyIdOfChild(childId: number): number {
  const row = getDb().prepare('SELECT family_id FROM users WHERE id = ?').get(childId) as
    | { family_id: number }
    | undefined;
  return row?.family_id ?? 0;
}

function parentsOf(familyId: number): NotifyRecipient[] {
  if (!familyId) return [];
  return (
    getDb()
      .prepare("SELECT id FROM users WHERE family_id = ? AND role = 'parent'")
      .all(familyId) as Array<{ id: number }>
  ).map((r) => ({ userId: r.id, familyId }));
}

/** 提交前/后各调一次；内部自动判跳变，没有跳变就什么都不发 */
export function snapshotCompletion(childId: number, now: Date = new Date()): CompletionSnapshot {
  const familyId = familyIdOfChild(childId);
  const week = weekRangeOf(now);
  const month = monthRangeOf(now);
  return {
    week: rangeStats(week.from, week.to, familyId),
    month: rangeStats(month.from, month.to, familyId),
  };
}

/**
 * 某场景本周/本月是否已经推过（周报完成推送 与 周一兜底推送 去重共用）。
 * 查 notify_logs（平台表，走 getRawDb）：同一统计周期内有过 sent/queued 就不再推。
 */
export function reportAlreadySent(
  tkey: 'weekly_report' | 'monthly_report',
  familyId: number,
  from: Date,
  to: Date
): boolean {
  const row = getRawDb()
    .prepare(
      `SELECT 1 FROM notify_logs
        WHERE tkey = ? AND family_id = ? AND status IN ('sent','queued')
          AND created_at >= ? AND created_at < ? LIMIT 1`
    )
    .get(tkey, familyId, tsOf(from), tsOf(to) + 86400);
  return !!row;
}

/** 提交成功后调用：对比 pre/post，把出现「凑齐」跳变的档位各自推一条 */
export function emitCompletionTransitions(
  childId: number,
  pre: CompletionSnapshot,
  post: CompletionSnapshot
): void {
  try {
    const familyId = familyIdOfChild(childId);
    const parents = parentsOf(familyId);
    if (!parents.length) return;

    const week = weekRangeOf();
    const month = monthRangeOf();

    // 周报：全家本周必做全交齐（同周内只推一次，周一兜底也认这笔账）
    if (!statOk(pre.week) && statOk(post.week) && !reportAlreadySent('weekly_report', familyId, week.from, week.to)) {
      emitNotify(
        'weekly_report',
        parents,
        { kind: 'weekly', when: rangeText(week.from, week.to) },
        { page: 'pages/moments/index?tab=week&anchor=0' }
      );
    }

    // 月报：全家本月必做全交齐
    if (!statOk(pre.month) && statOk(post.month) && !reportAlreadySent('monthly_report', familyId, month.from, month.to)) {
      emitNotify(
        'monthly_report',
        parents,
        { kind: 'monthly', range: monthText(month.from) },
        { page: 'pages/moments/index?tab=month&anchor=0' }
      );
    }
  } catch (e) {
    // 与 emitNotify 同一纪律：提醒失败绝不绊倒主业务
    console.error('[review-notify] 周报/月报触发失败：', e);
  }
}
