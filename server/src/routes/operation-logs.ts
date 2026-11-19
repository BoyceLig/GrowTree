import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';

/**
 * 操作历史查询（2026-11-16）。只有两个入口：
 *   GET /operation-logs —— 家长分页拉时间线
 * 没有任何写路径：operation_logs 是 append-only 的审计表，见 services/audit.ts。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 每条记录的本地日期（YYYY-MM-DD，服务端时区）——与 point-logs.ts 同一口径，
 *  前端按天分组必须用这个字段，不能自己用浏览器时区算，否则跨天记录会归错组 */
const DAY_EXPR = `date(o.created_at, 'unixepoch', 'localtime')`;

/** 账号类细粒度 module：写入端保留「孩子 / 登录 / 系统」便于追溯，展示层统一归到「账号」 */
const ACCOUNT_MODULES = ['账号', '孩子', '登录', '系统'] as const;

/** 查询时把账号类 module 归一（历史记录同样生效）：时间线、筛选、总数都按「账号」口径 */
const MODULE_IN = ACCOUNT_MODULES.map((m) => `'${m}'`).join(', ');
const MODULE_EXPR = `CASE WHEN o.module IN (${MODULE_IN}) THEN '账号' ELSE o.module END`;

/** 可筛选的模块：顺序即前端按钮顺序；账号类已合并，只留「账号」一档 */
const MODULES = [
  '积分', '任务', '审核', '商城', '背包', '心愿',
  '成长', '日记', '日历', '信箱', '悄悄话', '账号', 'AI', '其他',
];

/** 家长操作人选项：标签与网页其它地方一致用「昵称（身份）」；主家长排在前面 */
function parentActors(db: ReturnType<typeof getDb>): Array<{ id: number; label: string }> {
  const rows = db.prepare(`
    SELECT id, COALESCE(NULLIF(nickname, ''), name) AS name, parent_identity
    FROM users WHERE role = 'parent'
    ORDER BY is_primary DESC, id ASC
  `).all() as Array<{ id: number; name: string; parent_identity: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    label: r.parent_identity && r.parent_identity !== r.name ? `${r.name}（${r.parent_identity}）` : r.name,
  }));
}

export function registerOperationLogsRoutes(app: FastifyInstance) {
  app.get('/operation-logs', { preHandler: requireParent }, async (req, reply) => {
    const db = getDb();
    const query = req.query as Record<string, string | undefined>;

    // 范围精确到天：from/to 都是闭区间，天边界由 SQLite localtime 统一算
    const from = query?.from ?? '';
    const to = query?.to ?? '';
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return reply.code(400).send({ error: 'invalid_input', message: '日期格式须为 YYYY-MM-DD' });
    }
    if (from > to) {
      return reply.code(400).send({ error: 'invalid_input', message: '开始日期不能晚于结束日期' });
    }

    const limit = Math.min(Math.max(Number(query?.limit ?? 50), 1), 200);
    const offset = Math.max(Number(query?.offset ?? 0), 0);

    // module 为空 = 全部；非空只筛该模块（前端只用 MODULES 里的值，SQL 仍按参数绑定）
    const module = (query?.module ?? '').trim();
    const conds = [`${DAY_EXPR} >= ?`, `${DAY_EXPR} <= ?`];
    const args: (string | number)[] = [from, to];
    if (module) {
      conds.push(`${MODULE_EXPR} = ?`);
      args.push(module);
    }
    // 操作人：具体家长（actorId）优先；否则按角色筛（role=parent / child）
    const role = (query?.role ?? '').trim();
    const actorId = Number(query?.actorId ?? 0) || 0;
    if (actorId > 0) {
      conds.push('o.actor_id = ?');
      args.push(actorId);
    } else if (role === 'parent' || role === 'child') {
      conds.push('o.actor_role = ?');
      args.push(role);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const rows = db.prepare(`
      SELECT o.id, o.actor_id, o.actor_role, o.actor_name,
             ${MODULE_EXPR} AS module, o.action, o.detail, o.method, o.path,
             o.created_at, ${DAY_EXPR} AS day
      FROM operation_logs o
      ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset);

    // hasMore：再往后取一条看还有没有，前端靠它决定要不要显示「加载更多」
    const more = db.prepare(`
      SELECT 1 FROM operation_logs o ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 1 OFFSET ?
    `).get(...args, offset + limit);

    // 范围内总条数（分页提示用，一次 COUNT 不贵）
    const { total } = db.prepare(
      `SELECT COUNT(*) AS total FROM operation_logs o ${where}`
    ).get(...args) as { total: number };

    return { logs: rows, hasMore: !!more, total, from, to, modules: MODULES, actors: parentActors(db) };
  });
}
