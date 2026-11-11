import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';
import { contributionRuleText } from './contribution.js';

/** 「按天分页」一次返回多少天的记录（积分流水页的「更多」按钮每次展开这么多天） */
const DAY_PAGE_SIZE = 50;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 每条流水附带的本地日期（SQLite 'localtime' 取服务端时区，Docker 里固定 Asia/Shanghai，
 *  与家长浏览器一致；分页、分组、汇总三处必须用同一个口径，不然天对不上） */
const DAY_EXPR = `date(pl.created_at, 'unixepoch', 'localtime')`;

/**
 * 「家庭贡献值」不进积分流水（2026-11-02 用户要求）。
 *
 * ── 为什么 ────────────────────────────────────────────────────────────
 *   家庭贡献值（routes/contribution.ts，source='contribution'）是**另一笔账**：
 *   它记在孩子名下、只增不减，家长拿家庭积分去兑换不会动它，也永远不参与
 *   孩子自己的积分余额（awardContribution 从不碰 users.total_points）。
 *   但它确实写在 point_logs 里，所以只要流水查询不过滤，孩子端「积分流水」
 *   和家长端「孩子积分流水」里就会混进一行「家庭贡献值：完成任务 +5」——
 *   看着像积分，其实一分钱都花不了。
 *
 * ── 规矩 ──────────────────────────────────────────────────────────────
 *   贡献值只在两个地方出现，别的地方一律 `source <> 'contribution'`：
 *     · 孩子端首页 → 家庭贡献值 → /point-logs/me?source=contribution
 *     · 家长端 签到 → 家庭积分明细 → 选孩子 → /signin/points?userId=<孩子>
 *   同一个口径也要用在**合计**上（dashboard 的今日加减分、历史累计），
 *   否则「今日 +15」而流水只加得出 +10，家长会当成算错。
 */
const NOT_CONTRIB = "pl.source <> 'contribution'";

export function registerPointLogsRoutes(app: FastifyInstance) {
  // 贡献值「规则说明」（2026-11-04）：孩子端「家庭贡献值」详情页右上角
  // 「规则」按钮弹出的底部弹窗用。后台填了自定义文案就用后台的，
  // 没填按当前参数自动生成（见 contribution.ts → contributionRuleText）。
  // 登录即可读（家长孩子都要能看，不含任何隐私数据）。
  app.get('/point-logs/contribution-rule', async () => {
    return { text: contributionRuleText() };
  });

  // 家长查所有记录
  app.get('/point-logs', { preHandler: requireParent }, async (req) => {
    const db = getDb();
    const userId = (req.query as any)?.userId ? Number((req.query as any).userId) : null;
    const limit = Math.min(Number((req.query as any)?.limit ?? 50), 200);
    const offset = Number((req.query as any)?.offset ?? 0);

    const sql = `SELECT pl.*, u.name as user_name, creator.name as creator_name
         FROM point_logs pl
         JOIN users u ON pl.user_id = u.id
         LEFT JOIN users creator ON pl.created_by = creator.id
         WHERE ${NOT_CONTRIB}${userId ? ' AND pl.user_id = ?' : ''}
         ORDER BY pl.created_at DESC, pl.id DESC
         LIMIT ? OFFSET ?`;

    const rows = userId
      ? db.prepare(sql).all(userId, limit, offset)
      : db.prepare(sql).all(limit, offset);

    return { logs: rows };
  });

  // 小孩查自己记录
  //
  // ?source=contribution → 只看家庭贡献值（2026-10-28 用户要求：孩子首页点
  //   「家庭贡献值」进来的就是这个）。source 走白名单正则，不是拼进 SQL 的裸串。
  //   不传 source = 「我的积分流水」，按上面 NOT_CONTRIB 的口径**不含**贡献值。
  //
  // total = 该筛选下**全部**记录的合计。必须服务端算：logs 是 LIMIT 截断的，
  //   端上自己 SUM 只能算出「最近这 100 条」，历史累计会少算。
  app.get('/point-logs/me', async (req) => {
    const db = getDb();
    const limit = Math.min(Number((req.query as any)?.limit ?? 50), 200);
    const offset = Number((req.query as any)?.offset ?? 0);
    const rawSource = (req.query as any)?.source;
    const source =
      typeof rawSource === 'string' && /^[a-z_]{1,24}$/.test(rawSource) ? rawSource : null;

    const where = source
      ? 'WHERE pl.user_id = ? AND pl.source = ?'
      : `WHERE pl.user_id = ? AND ${NOT_CONTRIB}`;
    const who: (number | string)[] = source ? [req.user!.sub, source] : [req.user!.sub];

    const totalRow = db
      .prepare(`SELECT COALESCE(SUM(delta), 0) AS total FROM point_logs pl ${where}`)
      .get(...who) as { total: number } | undefined;

    const logs = db.prepare(`
      SELECT pl.*, creator.name as creator_name
      FROM point_logs pl
      LEFT JOIN users creator ON pl.created_by = creator.id
      ${where}
      ORDER BY pl.created_at DESC, pl.id DESC
      LIMIT ? OFFSET ?
    `).all(...who, limit, offset);

    return { logs, total: totalRow?.total ?? 0 };
  });

  // 家长：按天分页的流水（积分流水页）
  //   一页 = 50 **天**（不是 50 条）：返回这 50 天里去重后的日期列表与区间内的全部记录，
  //   前端按天分组展示、并在每天标题里算出每个孩子当天加/减了多少分。
  app.get('/point-logs/by-day', { preHandler: requireParent }, async (req) => {
    const db = getDb();
    const q = req.query as Record<string, string | undefined>;
    const userId = q?.userId ? Number(q.userId) : null;
    const page = Math.max(0, Math.floor(Number(q?.page ?? 0)));

    // 时间段筛选（家长端「总览 → 积分卡片 → 流水页」上的那两个日期框）。
    // 比较的是本地日期，和 DAY_EXPR 同一个口径，否则边界那天会差一天。
    let from = DATE_RE.test(String(q?.from ?? '')) ? String(q.from) : null;
    let to = DATE_RE.test(String(q?.to ?? '')) ? String(q.to) : null;
    if (from && to && from > to) {
      const t = from; from = to; to = t; // 填反了自动对调
    }

    // 家庭贡献值不进积分流水（见文件头 NOT_CONTRIB）—— 这里连「哪些天有流水」
    // 都不算它，否则会冒出一条「有记录但列表里什么都没有」的空日期。
    const conds: string[] = [NOT_CONTRIB];
    const condParams: (string | number)[] = [];
    if (userId) { conds.push('pl.user_id = ?'); condParams.push(userId); }
    if (from) { conds.push(`${DAY_EXPR} >= ?`); condParams.push(from); }
    if (to) { conds.push(`${DAY_EXPR} <= ?`); condParams.push(to); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    // 一共有多少个「有流水」的日子：用来算还有没有下一页
    const totalRow = db.prepare(`
      SELECT COUNT(DISTINCT ${DAY_EXPR}) AS c FROM point_logs pl ${where}
    `).get(...condParams) as { c: number };

    const dayRows = db.prepare(`
      SELECT DISTINCT ${DAY_EXPR} AS day
      FROM point_logs pl ${where}
      ORDER BY day DESC
      LIMIT ? OFFSET ?
    `).all(...condParams, DAY_PAGE_SIZE, page * DAY_PAGE_SIZE) as { day: string }[];
    const days = dayRows.map((r) => r.day);

    // 取这一页日期区间（新→旧连续）里的全部记录
    let logs: any[] = [];
    if (days.length > 0) {
      const newest = days[0];
      const oldest = days[days.length - 1];
      const sql = `
        SELECT pl.*, ${DAY_EXPR} AS day, u.name as user_name, creator.name as creator_name
        FROM point_logs pl
        JOIN users u ON pl.user_id = u.id
        LEFT JOIN users creator ON pl.created_by = creator.id
        WHERE ${DAY_EXPR} BETWEEN ? AND ?
          AND ${NOT_CONTRIB}
          ${userId ? 'AND pl.user_id = ?' : ''}
        ORDER BY pl.created_at DESC, pl.id DESC
      `;
      logs = userId
        ? db.prepare(sql).all(oldest, newest, userId)
        : db.prepare(sql).all(oldest, newest);
    }

    return {
      days,
      logs,
      page,
      hasMore: (page + 1) * DAY_PAGE_SIZE < totalRow.c,
      totalDays: totalRow.c,
      from,
      to,
    };
  });

  // 家长：时间段汇总 —— 每个孩子在 [from, to]（本地日期，含边界）里加了多少、扣了多少。
  // from/to 都不传 = 全部历史。
  app.get('/point-logs/summary', { preHandler: requireParent }, async (req) => {
    const db = getDb();
    const userId = (req.query as any)?.userId ? Number((req.query as any).userId) : null;
    const rawFrom = typeof (req.query as any)?.from === 'string' ? (req.query as any).from : '';
    const rawTo = typeof (req.query as any)?.to === 'string' ? (req.query as any).to : '';
    const from = DATE_RE.test(rawFrom) ? rawFrom : null;
    let to = DATE_RE.test(rawTo) ? rawTo : null;
    let from2 = from;
    if (from2 && to && from2 > to) {
      const t = from2; from2 = to; to = t; // 填反了自动对调
    }

    const conds: string[] = [NOT_CONTRIB];
    const params: (string | number)[] = [];
    if (userId) { conds.push('pl.user_id = ?'); params.push(userId); }
    if (from2) { conds.push(`${DAY_EXPR} >= ?`); params.push(from2); }
    if (to) { conds.push(`${DAY_EXPR} <= ?`); params.push(to); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const summary = db.prepare(`
      SELECT pl.user_id,
        u.name AS user_name,
        u.avatar AS user_avatar,
        COALESCE(SUM(CASE WHEN pl.delta > 0 THEN pl.delta ELSE 0 END), 0) AS gain,
        COALESCE(SUM(CASE WHEN pl.delta < 0 THEN pl.delta ELSE 0 END), 0) AS loss,
        COUNT(*) AS count
      FROM point_logs pl
      JOIN users u ON u.id = pl.user_id
      ${where}
      GROUP BY pl.user_id
      ORDER BY (gain - loss) DESC, pl.user_id ASC
    `).all(...params);

    return { summary, from: from2, to };
  });
}
