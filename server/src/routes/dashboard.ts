import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';

/**
 * 本地时区「今天 00:00:00」的 unix 秒。
 * 不要用 toISOString().slice(0,10) 拼日期 —— 那是 UTC 日期，在 GMT+8 的 0~8 点
 * 会取到「昨天」，导致统计窗口整体前移一天、把昨天的数据算进「今日」。
 */
function localDayStart(): number {
  const n = new Date();
  return Math.floor(new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() / 1000);
}

/** 待审核按孩子的聚合行（三类查询共用同一形状） */
interface PendingGroup {
  user_id: number;
  user_name: string;
  user_avatar: string | null;
  /** 这个孩子在这一类里有多少条待审 */
  c: number;
  /** 这一类里最早一条的提交时间 */
  oldest: number;
}

export function registerDashboardRoutes(app: FastifyInstance) {
  // 家长总览：所有小孩卡片 + 今日得分
  app.get('/dashboard', { preHandler: requireParent }, async () => {
    const db = getDb();

    // 今日加分/扣分统计（排除兑换消耗，只算积分项的加减分）
    //
    // ⚠️ 还要排除 source='contribution'（2026-11-02 用户要求）：家庭贡献值是另一笔账，
    //    只在「孩子首页 → 家庭贡献值」/「签到 → 家庭积分明细」里出现，不进积分流水，
    //    也就不该进「今日得分」—— 否则孩子今天做了 2 项任务，卡片显示 +30 而流水只有
    //    +20（多出来的是每项 +5 的贡献值），家长会当成算错。
    const todayStart = localDayStart();
    const todayEnd = todayStart + 86400;

    const children = db.prepare(`
      SELECT id, name, avatar, total_points,
        (SELECT COALESCE(SUM(pl.delta), 0) FROM point_logs pl
         WHERE pl.user_id = u.id AND pl.delta > 0
           AND pl.source <> 'contribution'
           AND pl.created_at >= ? AND pl.created_at < ?) as today_points
      FROM users u
      WHERE role = 'child' AND hidden = 0
      ORDER BY total_points DESC, id ASC
    `).all(todayStart, todayEnd);
    const summary = db.prepare(`
      SELECT
        SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) as gain,
        SUM(CASE WHEN delta < 0 AND source != 'exchange' THEN delta ELSE 0 END) as loss,
        SUM(CASE WHEN source != 'exchange' THEN 1 ELSE 0 END) as count
      FROM point_logs
      WHERE created_at >= ? AND created_at < ?
        AND source <> 'contribution'
    `).get(todayStart, todayEnd) as { gain: number | null; loss: number | null; count: number | null };

    /* ── 待审核：计数 + 摘要（2026-10-18 方案 A「审核状态灯条」要用）────────
     * 灯条上要写「小红想兑换恐龙蛋」「最早的一条等了 3 小时」，所以除了三个总数，
     * 还得知道「是谁、等多久、最新两条叫什么」。
     *
     * ⚠️ 这里**不能**写成三段 UNION ALL 拼一条时间线 —— 多租户层（ext/tenant.ts）
     *    不支持 UNION，会在 prepare 时直接抛 TenantScopeError。所以按类型各查一次，
     *    在 JS 里合并：类型之间本来就是「并集 + 按时间排序」，代码里做更直白。
     * ⚠️ 也不能图省事改用 getRawDb() —— 那会把别的家庭的待办一起算进来。
     *
     * 每类两条查询：GROUP BY 孩子（头像叠放 + 每人几条 + 各自最早时间）、
     * 最新 2 条（摘要文案，标签在 SQL 里拼好，页面直接念）。 */
    const exchangeGroups = db.prepare(`
      SELECT x.user_id, u.name AS user_name, u.avatar AS user_avatar,
        COUNT(*) AS c, MIN(x.created_at) AS oldest
      FROM exchange_requests x
      JOIN users u ON u.id = x.user_id
      WHERE x.status = 'pending'
      GROUP BY x.user_id
    `).all() as PendingGroup[];
    const taskGroups = db.prepare(`
      SELECT t.user_id, u.name AS user_name, u.avatar AS user_avatar,
        COUNT(*) AS c, MIN(t.created_at) AS oldest
      FROM task_completions t
      JOIN users u ON u.id = t.user_id
      WHERE t.status = 'pending'
      GROUP BY t.user_id
    `).all() as PendingGroup[];
    // 周期任务的时间键用 submitted_at（提交了才算「等审核」），没提交过退回 claimed_at —— 与 review.ts 一致
    const recurringGroups = db.prepare(`
      SELECT r.user_id, u.name AS user_name, u.avatar AS user_avatar,
        COUNT(*) AS c, MIN(COALESCE(r.submitted_at, r.claimed_at)) AS oldest
      FROM recurring_claims r
      JOIN users u ON u.id = r.user_id
      WHERE r.status = 'pending'
      GROUP BY r.user_id
    `).all() as PendingGroup[];

    // 最新两条（摘要文案用）
    const latestRows = [
      db.prepare(`
        SELECT 'exchange' AS kind, x.user_id, x.created_at, u.name AS user_name,
          CASE WHEN x.type = 'cash' THEN '想兑换现金' ELSE '想兑换' || COALESCE(p.name, '商品') END AS label
        FROM exchange_requests x
        LEFT JOIN products p ON p.id = x.product_id
        JOIN users u ON u.id = x.user_id
        WHERE x.status = 'pending'
        ORDER BY x.created_at DESC LIMIT 2
      `).all(),
      db.prepare(`
        SELECT 'task' AS kind, t.user_id, t.created_at, u.name AS user_name,
          '完成了' || COALESCE(a.name, '任务') AS label
        FROM task_completions t
        LEFT JOIN adhoc_tasks a ON a.id = t.task_id
        JOIN users u ON u.id = t.user_id
        WHERE t.status = 'pending'
        ORDER BY t.created_at DESC LIMIT 2
      `).all(),
      db.prepare(`
        SELECT 'recurring' AS kind, r.user_id, COALESCE(r.submitted_at, r.claimed_at) AS created_at,
          u.name AS user_name, '完成了' || COALESCE(rt.name, '周期任务') AS label
        FROM recurring_claims r
        LEFT JOIN recurring_tasks rt ON rt.id = r.task_id
        JOIN users u ON u.id = r.user_id
        WHERE r.status = 'pending'
        ORDER BY created_at DESC LIMIT 2
      `).all(),
    ].flat() as Array<{ kind: string; user_id: number; created_at: number; user_name: string; label: string }>;
    // 跨类型按时间倒序，取最新两条
    latestRows.sort((a, b) => b.created_at - a.created_at);

    const sumOf = (rows: PendingGroup[]) => rows.reduce((n, g) => n + g.c, 0);
    const pendingExchangeCount = sumOf(exchangeGroups);
    const pendingTaskCount = sumOf(taskGroups);
    const pendingRecurringCount = sumOf(recurringGroups);

    // 按孩子合并三个类型的分组：同一个人可能既有兑换又有任务
    const byChildMap = new Map<number, { userId: number; name: string; avatar: string | null; count: number; oldestAt: number }>();
    for (const g of [...exchangeGroups, ...taskGroups, ...recurringGroups]) {
      const hit = byChildMap.get(g.user_id);
      if (hit) {
        hit.count += g.c;
        if (g.oldest < hit.oldestAt) hit.oldestAt = g.oldest;
      } else {
        byChildMap.set(g.user_id, {
          userId: g.user_id, name: g.user_name, avatar: g.user_avatar,
          count: g.c, oldestAt: g.oldest,
        });
      }
    }
    // 条数多的排前面；同数按「等得久的」排前面 —— 头像叠放时左边那个最有代表性
    const pendingByChild = [...byChildMap.values()].sort(
      (a, b) => b.count - a.count || a.oldestAt - b.oldestAt
    );

    return {
      children,
      todaySummary: {
        gain: summary.gain ?? 0,
        loss: summary.loss ?? 0,
        count: summary.count ?? 0,
      },
      pendingReview: {
        exchange: pendingExchangeCount,
        tasks: pendingTaskCount,
        recurring: pendingRecurringCount,
        total: pendingExchangeCount + pendingTaskCount + pendingRecurringCount,
        // 灯条摘要只用最新两条（再多写不下），最新在前
        latest: latestRows.slice(0, 2).map((r) => ({
          userId: r.user_id,
          userName: r.user_name,
          kind: r.kind,
          label: r.label,
        })),
        byChild: pendingByChild,
        // 最早那条的提交时间（「等了多久」用）；一条待办都没有时为 null
        oldestAt: pendingByChild.length > 0
          ? pendingByChild.reduce((min, c) => (c.oldestAt < min ? c.oldestAt : min), pendingByChild[0].oldestAt)
          : null,
      },
    };
  });

  // 小孩端总览：自己的积分 + 今日统计 + 历史累计 + 头像
  app.get('/dashboard/me', async (req) => {
    const db = getDb();
    const todayStart = localDayStart();
    const todayEnd = todayStart + 86400;

    const me = db.prepare(`
      SELECT id, name, avatar, sex, total_points as totalPoints
      FROM users u WHERE id = ?
    `).get(req.user!.sub) as any;

    if (!me) return { error: 'not_found' };

    // 今日加分/扣分/兑换
    //   source = 'contribution' 在这里同样要排除（2026-11-02）：贡献值不算孩子的积分，
    //   它有自己的累计（见下方 contributionTotal）。
    const todayStats = db.prepare(`
      SELECT
        SUM(CASE WHEN delta > 0 AND source != 'exchange' THEN delta ELSE 0 END) as todayGain,
        SUM(CASE WHEN delta < 0 AND source != 'exchange' THEN delta ELSE 0 END) as todayLoss,
        SUM(CASE WHEN source = 'exchange' THEN delta ELSE 0 END) as todayExchange
      FROM point_logs
      WHERE user_id = ? AND created_at >= ? AND created_at < ?
        AND source <> 'contribution'
    `).get(req.user!.sub, todayStart, todayEnd) as any;

    // 历史累计加分/扣分/兑换（同样不含贡献值，这样「累计加分 - 累计扣分 - 累计兑换」
    // 才对得上 users.total_points；以前含贡献值时，累计加分会比真实余额大出一截）
    const totalStats = db.prepare(`
      SELECT
        SUM(CASE WHEN delta > 0 AND source != 'exchange' THEN delta ELSE 0 END) as totalGain,
        SUM(CASE WHEN delta < 0 AND source != 'exchange' THEN delta ELSE 0 END) as totalLoss,
        SUM(CASE WHEN source = 'exchange' THEN delta ELSE 0 END) as totalExchange
      FROM point_logs WHERE user_id = ? AND source <> 'contribution'
    `).get(req.user!.sub) as any;

    /**
     * 家庭贡献值累计（2026-10-28 用户要求：孩子首页单独一列显示）。
     *
     * ⚠️ 只算 source='contribution' 的行：兑换走的是 source='exchange' 的**独立一行**，
     *    从不改动已有行，所以这里的累计天然不会被家长的兑换冲掉 ——
     *    「贡献值是历史累计、不因兑换而减少」在数据层就成立，不需要额外维护字段。
     * ⚠️ 必须由服务端聚合：端上拿到的流水是 LIMIT 截断的，自己 SUM 会漏算。
     */
    const contribRow = db
      .prepare(
        "SELECT COALESCE(SUM(delta), 0) AS total FROM point_logs WHERE user_id = ? AND source = 'contribution'"
      )
      .get(req.user!.sub) as { total: number } | undefined;

    return {
      id: me.id,
      name: me.name,
      avatar: me.avatar,
      // 孩子端主题（男孩蓝色/女孩粉色）靠它决定，孩子档案里没填就是 null
      sex: me.sex ?? null,
      totalPoints: me.totalPoints,
      contributionTotal: contribRow?.total ?? 0,
      todayGain: todayStats?.todayGain ?? 0,
      todayLoss: todayStats?.todayLoss ?? 0,
      todayExchange: todayStats?.todayExchange ?? 0,
      totalGain: totalStats?.totalGain ?? 0,
      totalLoss: totalStats?.totalLoss ?? 0,
      totalExchange: totalStats?.totalExchange ?? 0,
    };
  });
}
