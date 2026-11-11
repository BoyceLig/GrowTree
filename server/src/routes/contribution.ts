import type Database from 'better-sqlite3';

/**
 * 家庭贡献值（晒娃时刻，2026-10-23）。
 *
 * ── 规则（2026-10-28 用户要求改版）──────────────────────────────────
 *   「孩子家庭贡献值积分，改成每完成一项加 5 分，最多 3 项，
 *    连续完成任务 7 天加 50 分（每天完成一项就算打卡成功）。」
 *   数值可在运营后台「任务管理」页改（platform_config：contribution_daily_points /
 *   contribution_daily_max / contribution_streak_days / contribution_streak_bonus），
 *   默认 5 / 3 / 7 / 50。
 *
 * ── 什么时候发 ────────────────────────────────────────────────────────
 *   挂在两条审核通过链路上（adhoc-tasks / recurring-tasks 的 approve）：
 *   该孩子「做任务那天」（提交时间，不是审核时间 —— 与积分加分同口径）
 *   每过审一项就发一笔（不超过当日上限）；「今天第一次过审」时再看
 *   「连续有任务的自然日」是否恰好攒满一轮（contribution_streak_days），
 *   是就发一次连续奖励。同一天的后续任务不改变连续天数，也不会重复发奖励。
 *
 * ── 为什么记 biz_date 而不是用 created_at ────────────────────────────
 *   家长可能隔天才审。贡献值必须记在孩子**做任务**的那天，晒娃时刻的
 *   「今日/本周/本月贡献值」才是对的。所以 point_logs 加了 biz_date 列
 *   （见 db/index.ts migratePointLogs），其它流水这一列为 NULL。
 *
 * ── 为什么经 provider 拿配置，而不直接 import ext/platform ──────────
 *   本文件在共享层（自建版也用），而 platform_config 是商业版（ext）的
 *   东西，共享层不许反向依赖。ext 启动时调用 setContributionConfigProvider
 *   把「读配置」注进来；自建版没有注册 provider，走内置默认值。
 */

export type ContributionConfigKey =
  | 'contribution_daily_points'
  | 'contribution_daily_max'
  | 'contribution_streak_days'
  | 'contribution_streak_bonus';
export type ContributionConfigProvider = (key: ContributionConfigKey) => number;

let provider: ContributionConfigProvider | null = null;

/** 自建版（无运营后台）的兜底数值；商业版会被 platform_config 覆盖 */
const FALLBACK: Record<ContributionConfigKey, number> = {
  contribution_daily_points: 5,
  contribution_daily_max: 3,
  contribution_streak_days: 7,
  contribution_streak_bonus: 50,
};

export function setContributionConfigProvider(p: ContributionConfigProvider | null): void {
  provider = p;
}

/**
 * 贡献值「规则说明」的自定义文案（运营后台可填）。
 * 与上面同款注入模式：共享层不 import ext，ext 启动时把读配置的函数注进来。
 * 空串 = 没自定义 → 按当前数值自动生成默认文案（见 contributionRuleText）。
 */
export type ContributionRuleTextProvider = () => string;

let ruleTextProvider: ContributionRuleTextProvider | null = null;

export function setContributionRuleTextProvider(p: ContributionRuleTextProvider | null): void {
  ruleTextProvider = p;
}

/**
 * 给孩子端「家庭贡献值」页用的规则说明。
 *
 * 后台没填自定义文案时**按当前参数自动生成** —— 运营改了分值/上限/天数，
 * 说明文字跟着变，不会出现「规则写着 5 分、实际发 10 分」这种自相矛盾。
 * 自定义文案原样返回（运营想怎么写就怎么写，可以换行）。
 */
export function contributionRuleText(): string {
  const custom = (ruleTextProvider ? ruleTextProvider() : '').trim();
  if (custom) return custom;

  const per = cfg('contribution_daily_points');
  const maxItems = cfg('contribution_daily_max');
  const streakDays = cfg('contribution_streak_days');
  const bonus = cfg('contribution_streak_bonus');

  // 关掉贡献值（每项 0 分）：如实说明，别给一份「看得见拿不到」的规则
  if (!per) return '家庭贡献值暂未开启。';

  const lines = [
    `1、每完成 1 项任务得 ${per} 贡献值，${maxItems > 0 ? `每天最多 ${per * maxItems} 贡献值` : '每天不限项数'}。`,
  ];
  if (streakDays > 0 && bonus > 0) {
    lines.push(`2、连续完成 ${streakDays} 天，一次奖励 ${bonus} 贡献值。`);
  }
  return lines.join('\n');
}

/** 非正数一律当作 0（= 关掉这一档），杜绝负值刷分 */
function cfg(key: ContributionConfigKey): number {
  const raw = provider ? provider(key) : FALLBACK[key];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** unix 秒 → 本地 YYYY-MM-DD。与签到 / 积分流水同口径：服务端本地时区 */
export function localDateOf(ts: number): string {
  const d = new Date(ts * 1000);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 本地日期字符串 ± n 天 */
function shiftDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  const mm = `${dt.getMonth() + 1}`.padStart(2, '0');
  const dd = `${dt.getDate()}`.padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

/**
 * 在审核通过的事务里调用：给该孩子按规则发家庭贡献值（幂等）。
 *
 * @param db          getDb()（共享层出口；商业版会自动注入 family_id）
 * @param userId      孩子用户 id
 * @param earnedAt    孩子**提交任务**的时间（unix 秒），不是审核时间
 * @param createdBy   审核的家长用户 id（流水 created_by）
 */
export function awardContribution(
  db: Database.Database,
  userId: number,
  earnedAt: number,
  createdBy: number | null,
): void {
  const daily = cfg('contribution_daily_points');
  const bonus = cfg('contribution_streak_bonus');
  if (daily <= 0 && bonus <= 0) return;

  const bizDate = localDateOf(earnedAt);
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(`
    INSERT INTO point_logs (user_id, delta, source, note, created_by, created_at, biz_date)
    VALUES (?, ?, 'contribution', ?, ?, ?, ?)
  `);

  // 今天已经发过几项。⚠️ 连续打卡的「活跃标记」就是这些记录的去重日期，
  // 所以「今天是不是第一个过审的任务」决定了连续天数会不会 +1。
  const todayCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM point_logs WHERE user_id = ? AND source = 'contribution' AND biz_date = ?",
      )
      .get(userId, bizDate) as { c: number }
  ).c;
  const firstOfDay = todayCount === 0;

  // ── 每项加分（2026-10-28 规则改版：每完成 1 项 +N，每天最多 max 项）──────
  // max = 0 视为不设上限。发满后整笔跳过（这天早计入打卡了，也不会再发奖励）。
  const maxPerDay = cfg('contribution_daily_max');
  if (daily > 0 && (maxPerDay <= 0 || todayCount < maxPerDay)) {
    ins.run(userId, daily, `家庭贡献值：完成任务 +${daily}`, createdBy, now, bizDate);
  }

  if (bonus <= 0) return;
  // 连续奖励只在「今天第一次有任务过审」时判 —— 同一天的后续任务不改变
  // 连续天数，重复判会把它再发一遍（第 2 项、第 3 项也命中「7 的倍数」）。
  if (!firstOfDay) return;
  // 连续天数：从做任务那天往前数「有贡献值记录」的连续自然日（含当天）。
  // 依赖贡献值记录当「活跃标记」—— 运营把每项分配成 0 时连续奖励无从计数，自然失效。
  const rows = db
    .prepare(
      "SELECT DISTINCT biz_date AS d FROM point_logs WHERE user_id = ? AND source = 'contribution' AND biz_date IS NOT NULL",
    )
    .all(userId) as { d: string }[];
  const dates = new Set(rows.map((r) => r.d));
  const streakDays = cfg('contribution_streak_days');
  if (streakDays <= 0) return;
  let streak = 0;
  let cur = bizDate;
  while (dates.has(cur)) {
    streak += 1;
    cur = shiftDate(cur, -1);
  }
  if (streak > 0 && streak % streakDays === 0) {
    ins.run(userId, bonus, `家庭贡献值：连续 ${streak} 天完成任务 +${bonus}`, createdBy, now, bizDate);
  }
}
