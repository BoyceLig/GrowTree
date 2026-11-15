import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';
import { pushToAll, pushToParents, pushToUser } from '../ws.js';

/**
 * 心愿单（2026-11-13）
 *
 * 和 wish-items 的区别：
 *   wish-items 是「商品/任务型许愿」——孩子选商品，家长配打卡天数，做任务换礼物；
 *   这里是一张自由填写的心愿卡：想要什么、为什么、预计多少积分（选填）。
 *
 * 家长侧流程：
 *   1. 孩子提交 → pending
 *   2. 某位家长点「我来审核」→ reviewing（抢单锁，10 分钟内只有他能提交）
 *      · 另一位家长会看到「XX 审核中」，按钮不可点
 *      · 抢单后关闭弹窗 → 主动释放；超时未处理 → 自动回到 pending
 *   3. 通过 → 补充商品信息，直接创建 active 商品上架商城 → approved
 *      不通过 → 必填原因 → rejected
 *   4. 审核完成后从 pending 队列消失，只留在历史记录里，记录审核人 / 时间 / 内容
 */

const LOCK_SECONDS = 10 * 60;

const createSchema = z.object({
  title: z.string().trim().min(1, '写一下想要什么吧').max(50, '最多 50 个字'),
  reason: z.string().trim().min(1, '说一下为什么想要吧').max(500, '最多 500 个字'),
  // 选填：不填传 null / 不传都行
  estimated_points: z.number().int().min(1).max(99999).nullable().optional(),
});

const reviewSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(200).optional(),
  // 通过时补充的商品信息（前端会预填孩子写的内容）
  name: z.string().trim().min(1).max(50).optional(),
  cost: z.number().int().min(1).max(99999).optional(),
  stock: z.number().int().min(-1).max(99999).optional(),
  category_id: z.number().int().positive().nullable().optional(),
});

interface WishRequestRow {
  id: number;
  child_id: number;
  title: string;
  reason: string;
  estimated_points: number | null;
  status: 'pending' | 'reviewing' | 'approved' | 'rejected' | 'cancelled';
  reviewer_id: number | null;
  review_started_at: number | null;
  reviewed_at: number | null;
  review_note: string | null;
  product_id: number | null;
  review_payload: string | null;
  created_at: number;
  updated_at: number;
  child_name?: string;
  child_avatar?: string | null;
  reviewer_name?: string | null;
  reviewer_identity?: string | null;
  product_name?: string | null;
  product_cost?: number | null;
  product_stock?: number | null;
  category_name?: string | null;
}

function parsedPayload(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 统一的行 → 接口对象：把审核结果快照展开成前端直接可用的字段 */
function toItem(row: WishRequestRow, me: number) {
  return {
    id: row.id,
    child_id: row.child_id,
    child_name: row.child_name ?? '',
    child_avatar: row.child_avatar ?? '',
    title: row.title,
    reason: row.reason,
    estimated_points: row.estimated_points,
    status: row.status,
    reviewer_id: row.reviewer_id,
    reviewer_name: row.reviewer_name ?? null,
    reviewer_identity: row.reviewer_identity ?? null,
    review_started_at: row.review_started_at,
    reviewed_at: row.reviewed_at,
    review_note: row.review_note,
    product_id: row.product_id,
    product_name: row.product_name ?? null,
    product_cost: row.product_cost ?? null,
    product_stock: row.product_stock ?? null,
    category_name: row.category_name ?? null,
    review: parsedPayload(row.review_payload),
    created_at: row.created_at,
    locked_by_me: row.status === 'reviewing' && row.reviewer_id === me,
  };
}

const SELECT_COLUMNS = `
  w.*,
  u.name AS child_name,
  u.avatar AS child_avatar,
  COALESCE(NULLIF(r.nickname, ''), r.name) AS reviewer_name,
  CASE WHEN r.role = 'parent' THEN COALESCE(NULLIF(r.parent_identity, ''), '家长') END AS reviewer_identity,
  p.name AS product_name,
  p.cost AS product_cost,
  p.stock AS product_stock,
  c.name AS category_name
`;

const SELECT_FROM = `
  FROM wish_requests w
  JOIN users u ON u.id = w.child_id
  LEFT JOIN users r ON r.id = w.reviewer_id
  LEFT JOIN products p ON p.id = w.product_id
  LEFT JOIN product_categories c ON c.id = p.category_id
`;

export function registerWishRequestRoutes(app: FastifyInstance) {
  /** 超时未处理的抢单自动释放：家长关掉页面 / 断网也不会把心愿永远锁着 */
  function releaseStaleLocks() {
    getDb()
      .prepare(`
        UPDATE wish_requests
        SET status = 'pending', reviewer_id = NULL, review_started_at = NULL, updated_at = unixepoch()
        WHERE status = 'reviewing'
          AND COALESCE(review_started_at, 0) <= unixepoch() - ?
      `)
      .run(LOCK_SECONDS);
  }

  function one(id: number): WishRequestRow | undefined {
    return getDb()
      .prepare(`SELECT ${SELECT_COLUMNS} ${SELECT_FROM} WHERE w.id = ?`)
      .get(id) as WishRequestRow | undefined;
  }

  // 列表：家长拿待审核队列 + 审核历史；孩子拿自己的全部心愿
  app.get('/wish-requests', async (req) => {
    const db = getDb();
    const me = req.user!;

    if (me.role === 'parent') {
      releaseStaleLocks();
      const pending = db
        .prepare(`
          SELECT ${SELECT_COLUMNS} ${SELECT_FROM}
          WHERE w.status IN ('pending', 'reviewing')
          ORDER BY CASE w.status WHEN 'reviewing' THEN 0 ELSE 1 END, w.created_at ASC
        `)
        .all() as WishRequestRow[];
      const history = db
        .prepare(`
          SELECT ${SELECT_COLUMNS} ${SELECT_FROM}
          WHERE w.status IN ('approved', 'rejected')
          ORDER BY w.reviewed_at DESC, w.id DESC
          LIMIT 100
        `)
        .all() as WishRequestRow[];

      return {
        pending: pending.map((r) => toItem(r, me.sub)),
        history: history.map((r) => toItem(r, me.sub)),
      };
    }

    const items = db
      .prepare(`
        SELECT ${SELECT_COLUMNS} ${SELECT_FROM}
        WHERE w.child_id = ? AND w.status != 'cancelled'
        ORDER BY w.created_at DESC
        LIMIT 100
      `)
      .all(me.sub) as WishRequestRow[];
    return { items: items.map((r) => toItem(r, me.sub)) };
  });

  // 孩子：提交一个心愿
  app.post('/wish-requests', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    if (req.user.role !== 'child') {
      return reply.code(403).send({ error: 'child_only', message: '心愿单要由孩子来写哦' });
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.issues[0]?.message });
    }
    const { title, reason, estimated_points } = parsed.data;
    const db = getDb();
    const r = db
      .prepare('INSERT INTO wish_requests (child_id, title, reason, estimated_points) VALUES (?, ?, ?, ?)')
      .run(req.user.sub, title, reason, estimated_points ?? null);
    const id = Number(r.lastInsertRowid);

    const child = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.sub) as { name: string } | undefined;
    // 只推给家长：孩子自己刚提交，不用提醒自己
    pushToParents({
      type: 'wish_request_created',
      wishId: id,
      childId: req.user.sub,
      childName: child?.name ?? '',
      title,
    });

    return { ok: true, item: one(id) ? toItem(one(id)!, req.user.sub) : null };
  });

  // 孩子：撤回自己的心愿（已经被审核完成的不允许撤回）
  app.post('/wish-requests/:id/cancel', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    if (req.user.role !== 'child') return reply.code(403).send({ error: 'forbidden' });
    const id = Number((req.params as any).id);
    const db = getDb();
    const row = db.prepare('SELECT child_id, status FROM wish_requests WHERE id = ?').get(id) as
      | { child_id: number; status: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.child_id !== req.user.sub) return reply.code(403).send({ error: 'forbidden' });
    if (row.status !== 'pending' && row.status !== 'reviewing') {
      return reply.code(409).send({ error: 'already_reviewed', message: '这个心愿已经审核完成了，撤不回来啦' });
    }
    db.prepare("UPDATE wish_requests SET status = 'cancelled', updated_at = unixepoch() WHERE id = ?").run(id);
    pushToParents({ type: 'wish_requests_changed', wishId: id, reason: 'cancelled' });
    pushToUser(req.user.sub, { type: 'wish_requests_changed', wishId: id, reason: 'cancelled' });
    return { ok: true };
  });

  // 家长：抢单（同一时刻只有一位家长能审核）
  app.post('/wish-requests/:id/claim', { preHandler: requireParent }, async (req, reply) => {
    const me = req.user!;
    const id = Number((req.params as any).id);
    const db = getDb();
    releaseStaleLocks();

    // 条件更新是原子的：两位家长同时点，只有一位 changes=1
    const r = db
      .prepare(`
        UPDATE wish_requests
        SET status = 'reviewing', reviewer_id = ?, review_started_at = unixepoch(), updated_at = unixepoch()
        WHERE id = ?
          AND (
            status = 'pending'
            OR (status = 'reviewing' AND reviewer_id = ?)
            OR (status = 'reviewing' AND COALESCE(review_started_at, 0) <= unixepoch() - ?)
          )
      `)
      .run(me.sub, id, me.sub, LOCK_SECONDS);

    if (r.changes === 0) {
      const row = db
        .prepare(`
          SELECT w.status, w.reviewer_id,
                 COALESCE(NULLIF(u.nickname, ''), u.name) AS reviewer_name,
                 CASE WHEN u.role = 'parent' THEN COALESCE(NULLIF(u.parent_identity, ''), '家长') END AS reviewer_identity
          FROM wish_requests w LEFT JOIN users u ON u.id = w.reviewer_id
          WHERE w.id = ?
        `)
        .get(id) as
        | { status: string; reviewer_id: number | null; reviewer_name: string | null; reviewer_identity: string | null }
        | undefined;
      if (!row) return reply.code(404).send({ error: 'not_found' });
      if (row.status === 'approved' || row.status === 'rejected') {
        return reply.code(409).send({ error: 'already_reviewed', message: '这个心愿已经被审核过了' });
      }
      if (row.status === 'cancelled') {
        return reply.code(409).send({ error: 'cancelled', message: '孩子已经撤回这个心愿了' });
      }
      return reply.code(409).send({
        error: 'locked',
        message: row.reviewer_name
          ? `${row.reviewer_name}${row.reviewer_identity ? `（${row.reviewer_identity}）` : ''} 正在审核这个心愿`
          : '另一位家长正在审核这个心愿',
      });
    }

    pushToParents({ type: 'wish_requests_changed', wishId: id, reason: 'claimed', reviewerId: me.sub });
    return { ok: true, item: one(id) ? toItem(one(id)!, me.sub) : null };
  });

  // 家长：放弃审核（关掉弹窗时调用），让其他家长可以接手
  app.post('/wish-requests/:id/release', { preHandler: requireParent }, async (req, reply) => {
    const me = req.user!;
    const id = Number((req.params as any).id);
    const r = getDb()
      .prepare(`
        UPDATE wish_requests
        SET status = 'pending', reviewer_id = NULL, review_started_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND status = 'reviewing' AND reviewer_id = ?
      `)
      .run(id, me.sub);
    if (r.changes > 0) {
      pushToParents({ type: 'wish_requests_changed', wishId: id, reason: 'released' });
    }
    return { ok: true };
  });

  // 家长：提交审核结果（通过并上架 / 不通过）
  app.post('/wish-requests/:id/review', { preHandler: requireParent }, async (req, reply) => {
    const me = req.user!;
    const id = Number((req.params as any).id);
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.issues[0]?.message });
    }
    const body = parsed.data;
    const db = getDb();

    const row = db.prepare('SELECT * FROM wish_requests WHERE id = ?').get(id) as WishRequestRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.status === 'approved' || row.status === 'rejected') {
      return reply.code(409).send({ error: 'already_reviewed', message: '这个心愿已经被审核过了' });
    }
    if (row.status === 'cancelled') {
      return reply.code(409).send({ error: 'cancelled', message: '孩子已经撤回这个心愿了' });
    }
    if (row.status !== 'reviewing' || row.reviewer_id !== me.sub) {
      return reply.code(409).send({ error: 'not_claimed', message: '请先点「我来审核」接手这个心愿' });
    }
    if (!body.approve && !body.note?.trim()) {
      return reply.code(400).send({ error: 'note_required', message: '不通过时请写一下原因，孩子会看到' });
    }

    if (body.approve) {
      // ── 补充商品信息并上架商城 ──────────────────────────────────────────
      const name = body.name?.trim() || row.title;
      const cost = body.cost ?? row.estimated_points ?? 100;
      const stock = body.stock ?? -1;
      const categoryId = body.category_id ?? null;

      let categoryName: string | null = null;
      if (categoryId) {
        const cat = db.prepare('SELECT name FROM product_categories WHERE id = ?').get(categoryId) as
          | { name: string }
          | undefined;
        if (!cat) return reply.code(400).send({ error: 'invalid_category', message: '分类不存在' });
        categoryName = cat.name;
      }

      const result = db.transaction(() => {
        const ins = db
          .prepare(`
            INSERT INTO products
              (name, cost, stock, icon, category_id, limit_days, limit_count, max_per_exchange,
               wish_enabled, wish_days, wish_consecutive, wish_daily_count, wish_only, status)
            VALUES (?, ?, ?, '', ?, 0, 0, 1, 0, 7, 0, 0, 0, 'active')
          `)
          .run(name, cost, stock, categoryId);
        const productId = Number(ins.lastInsertRowid);
        const payload = JSON.stringify({
          action: 'approved',
          product: { id: productId, name, cost, stock, category_id: categoryId, category_name: categoryName },
        });
        const upd = db
          .prepare(`
            UPDATE wish_requests
            SET status = 'approved', reviewer_id = ?, reviewed_at = unixepoch(),
                review_note = ?, product_id = ?, review_payload = ?, updated_at = unixepoch()
            WHERE id = ? AND status = 'reviewing' AND reviewer_id = ?
          `)
          .run(me.sub, body.note ?? null, productId, payload, id, me.sub);
        if (upd.changes === 0) throw new Error('review_lost');
        return productId;
      })();

      pushToAll({ type: 'products_changed', action: 'created', productId: result });
      pushToParents({ type: 'wish_requests_changed', wishId: id, reason: 'reviewed' });
      pushToUser(row.child_id, {
        type: 'wish_request_reviewed',
        wishId: id,
        status: 'approved',
        title: row.title,
        productName: name,
        cost,
        note: body.note ?? null,
      });
      return { ok: true, productId: result, item: one(id) ? toItem(one(id)!, me.sub) : null };
    }

    // ── 不通过 ────────────────────────────────────────────────────────────
    const payload = JSON.stringify({ action: 'rejected' });
    const upd = db
      .prepare(`
        UPDATE wish_requests
        SET status = 'rejected', reviewer_id = ?, reviewed_at = unixepoch(),
            review_note = ?, product_id = NULL, review_payload = ?, updated_at = unixepoch()
        WHERE id = ? AND status = 'reviewing' AND reviewer_id = ?
      `)
      .run(me.sub, body.note ?? null, payload, id, me.sub);
    if (upd.changes === 0) {
      return reply.code(409).send({ error: 'not_claimed', message: '审核状态已变化，请刷新后重试' });
    }

    pushToParents({ type: 'wish_requests_changed', wishId: id, reason: 'reviewed' });
    pushToUser(row.child_id, {
      type: 'wish_request_reviewed',
      wishId: id,
      status: 'rejected',
      title: row.title,
      note: body.note ?? null,
    });
    return { ok: true, item: one(id) ? toItem(one(id)!, me.sub) : null };
  });
}
