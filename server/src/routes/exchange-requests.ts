import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';
import { getCashRate } from './products.js';
import { pushToUser, pushToParents, pushToAll } from '../ws.js';
import { dayEffectFor, effectSuffix, effectInfo, todayLocal } from '../services/dayEffect.js';

const createProductExchangeSchema = z.object({
  type: z.literal('product'),
  productId: z.number().int().positive(),
  variantId: z.number().int().positive().nullable().optional(), // 有规格的商品必填
  quantity: z.number().int().min(1).max(99).default(1), // 兑换件数
});

const createCashExchangeSchema = z.object({
  type: z.literal('cash'),
  points: z.number().int().positive(),
});

const rejectSchema = z.object({
  reason: z.string().min(1).max(100),
});

export function registerExchangeRequestsRoutes(app: FastifyInstance) {
  // 小孩：提交兑换申请
  app.post('/exchange-requests', async (req, reply) => {
    const uid = req.user!.sub;
    const body = req.body as any;

    if (body?.type === 'product') {
      const parsed = createProductExchangeSchema.safeParse(body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const { productId, variantId, quantity } = parsed.data;

      const db = getDb();
      // 事务：校验商品+规格+库存+积分余额，写入申请
      let prodResult: any;
      // 道具类商品：跳过家长审核，直接入背包（不写 exchange_requests，除非 cost > 0 仍走审核）
      // 免费道具 / 扣 0 分：不入流水，只改库存
      try {
        const txn = db.transaction(() => {
          const product = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'active'").get(productId) as any;
          if (!product) throw new Error('product_not_found');
          if (product.wish_only === 1) throw new Error('wish_only_product');

          // 规格
          const variants = db.prepare(
            'SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order ASC, id ASC'
          ).all(productId) as any[];
          let variant: any = null;
          if (variants.length > 0) {
            if (!variantId) throw new Error('variant_required');
            variant = variants.find((v) => v.id === variantId);
            if (!variant) throw new Error('variant_not_found');
          }

          const unitCost = variant ? variant.cost : product.cost;
          const stockLeft = variant ? variant.stock : product.stock;
          if (stockLeft !== -1 && stockLeft <= 0) throw new Error('out_of_stock');

          const maxPer = Math.max(1, product.max_per_exchange ?? 1);
          if (quantity > maxPer) throw new Error('exceeds_per_exchange');

          // 限兑校验（道具也要遵守：避免孩子刷自己的背包）
          if ((product.limit_count ?? 0) > 0 && (product.limit_days ?? 0) > 0) {
            const since = Math.floor(Date.now() / 1000) - product.limit_days * 86400;
            // 道具限兑需要同时查 exchange_requests（已审核）和 backpack_items（赠送/使用均不增加次数，
            // 孩子自己兑才计入限兑）—— 我们这里只统计 exchange_requests 里的 product 兑换就够了
            const { c } = db.prepare(`
              SELECT COUNT(*) as c FROM exchange_requests
              WHERE user_id = ? AND product_id = ? AND status IN ('pending', 'approved')
                AND created_at > ?
            `).get(uid, productId, since) as { c: number };
            if (c >= product.limit_count) throw new Error('limit_reached');
          }

          const totalCost = unitCost * quantity;
          if (stockLeft !== -1 && stockLeft < quantity) throw new Error('out_of_stock');

          const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as any;
          if (totalCost > 0 && user.total_points < totalCost) throw new Error('insufficient_points');

          // ── 道具类商品：直接入背包 ──────────────────────────────────
          if (product.kind === 'prop') {
            // 特殊日：消耗按当天倍率折减（道具兑换即扣，按今天算）
            const effect = dayEffectFor(uid, todayLocal());
            const finalCost = totalCost > 0 && effect.spendMult !== 1
              ? Math.max(1, Math.round(totalCost * effect.spendMult))
              : totalCost;
            const effectNote = totalCost > 0 && effect.spendMult !== 1 ? effectSuffix(effect, 'spend') : '';
            if (totalCost > 0) {
              db.prepare('UPDATE users SET total_points = total_points - ? WHERE id = ?').run(finalCost, uid);
              db.prepare(`
                INSERT INTO point_logs (user_id, delta, source, ref_id, note, created_by)
                VALUES (?, ?, 'exchange', ?, ?, ?)
              `).run(uid, -finalCost, null, `兑换道具：${product.name}${variant ? `（${variant.name}）` : ''}${effectNote}`, uid);
            }
            // 减库存
            if (variant ? variant.stock !== -1 : product.stock !== -1) {
              const stmt = variant
                ? db.prepare('UPDATE product_variants SET stock = stock - ? WHERE id = ? AND stock >= ?')
                : db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
              stmt.run(quantity, variant ? variant.id : productId, quantity);
            }
            const now = Math.floor(Date.now() / 1000);
            const ins = db.prepare(`INSERT INTO backpack_items
              (child_id, product_id, name, icon, description, cost, status, acquired_at, source)
              VALUES (?, ?, ?, ?, ?, ?, 'unused', ?, 'exchange')`);
            // 商品图片快照
            const { icon } = db.prepare(`SELECT COALESCE(NULLIF(p.icon, ''), c.icon, 'gift') AS icon
              FROM products p LEFT JOIN product_categories c ON c.id = p.category_id WHERE p.id = ?`)
              .get(productId) as { icon: string };
            for (let i = 0; i < quantity; i++) {
              ins.run(uid, productId, product.name, icon, product.prop_desc ?? '', unitCost, now);
            }
            // 背包操作记录：孩子兑换入包（家长端「操作历史」可见）
            db.prepare(`INSERT INTO backpack_logs
              (child_id, action, item_name, icon, quantity, detail, refund_points, actor_role, actor_label, created_at)
              VALUES (?, 'exchange', ?, ?, ?, '', 0, 'child', ?, ?)`)
              .run(uid, product.name, icon, quantity, user.nickname || user.name, now);
            prodResult = {
              id: null, // 道具不走 exchange_requests，没有申请 id
              isProp: true,
              points: finalCost,
              quantity,
              productName: product.name,
              newBalance: (db.prepare('SELECT total_points FROM users WHERE id = ?').get(uid) as any).total_points,
            };
            return;
          }

          // ── 普通礼物：走审核 ────────────────────────────────────────
          const r = db.prepare(`
            INSERT INTO exchange_requests (user_id, type, product_id, variant_id, variant_name, points, amount, quantity, status)
            VALUES (?, 'product', ?, ?, ?, ?, 0, ?, 'pending')
          `).run(uid, productId, variant ? variant.id : null, variant ? variant.name : null, totalCost, quantity);
          prodResult = {
            id: Number(r.lastInsertRowid),
            isProp: false,
            points: totalCost,
            quantity,
            productName: product.name,
            product_id: productId,
          };
        });
        txn();

        if (prodResult.isProp) {
          // 道具直接入背包：静默刷新 + 推给家长「已入背包」
          pushToUser(uid, {
            type: 'prop_exchanged',
            itemName: prodResult.productName,
            quantity: prodResult.quantity,
            points: prodResult.points,
            newBalance: prodResult.newBalance,
          });
          pushToAll({ type: 'backpack_changed', childId: uid });
          pushToAll({ type: 'products_changed', action: 'stock', productId });
          if (prodResult.points > 0) {
            pushToAll({ type: 'points_changed', userId: uid, delta: -prodResult.points, newBalance: prodResult.newBalance });
          }
          return prodResult;
        }

        // 礼物申请推送给家长
        pushToParents({
          type: 'new_exchange_request',
          requestId: prodResult.id,
          userId: uid,
          userName: (db.prepare('SELECT name FROM users WHERE id = ?').get(uid) as any)?.name,
          exchangeType: 'product',
          productId: prodResult.product_id,
          productName: prodResult.productName,
          points: prodResult.points,
        });
        return prodResult;
      } catch (e: any) {
        const msg = e.message;
        if (msg === 'product_not_found') return reply.code(404).send({ error: msg });
        if (msg === 'wish_only_product') return reply.code(400).send({ error: msg, detail: '这是许愿礼物，要通过许愿单领取' });
        if (msg === 'variant_not_found') return reply.code(404).send({ error: msg });
        if (msg === 'variant_required') return reply.code(400).send({ error: msg, detail: '请先选择商品规格' });
        if (msg === 'out_of_stock') return reply.code(409).send({ error: msg });
        if (msg === 'insufficient_points') return reply.code(409).send({ error: msg });
        if (msg === 'limit_reached') return reply.code(409).send({ error: msg });
        if (msg === 'exceeds_per_exchange') return reply.code(400).send({ error: msg, detail: `每次最多兑换件数超限` });
        throw e;
      }
    }

    if (body?.type === 'cash') {
      const parsed = createCashExchangeSchema.safeParse(body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const cashPoints: number = parsed.data.points;
      const cashRate = getCashRate();
      if (cashPoints % cashRate !== 0) return reply.code(400).send({ error: 'invalid_input', detail: `积分必须是 ${cashRate} 的倍数` });
      const amount = cashPoints / cashRate;

      const db = getDb();
      let cashResult: any;
      try {
        const txn = db.transaction(() => {
          const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as any;
          if (user.total_points < cashPoints) throw new Error('insufficient_points');
          const r = db.prepare(`
            INSERT INTO exchange_requests (user_id, type, points, amount, status)
            VALUES (?, 'cash', ?, ?, 'pending')
          `).run(uid, cashPoints, amount);
          cashResult = { id: Number(r.lastInsertRowid), points: cashPoints, amount };
        });
        txn();
        // 推送给所有家长：现金兑换申请
        pushToParents({
          type: 'new_exchange_request',
          requestId: cashResult.id,
          userId: uid,
          userName: (db.prepare('SELECT name FROM users WHERE id = ?').get(uid) as any)?.name,
          exchangeType: 'cash',
          amount: cashResult.amount,
          points: cashResult.points,
        });
        return cashResult;
      } catch (e: any) {
        if (e.message === 'insufficient_points') return reply.code(409).send({ error: e.message });
        throw e;
      }
    }

    return reply.code(400).send({ error: 'invalid_type' });
  });

  // 小孩：查看自己的兑换记录
  app.get('/exchange-requests/mine', async (req) => {
    const db = getDb();
    const uid = req.user!.sub;
    const list = db.prepare(`
      SELECT e.*,
        CASE
          WHEN p.name IS NULL THEN NULL
          WHEN e.variant_name IS NOT NULL THEN p.name || ' · ' || e.variant_name
          ELSE p.name
        END as product_name,
        COALESCE(NULLIF(p.icon, ''), pc.icon, 'gift') as product_icon
      FROM exchange_requests e
      LEFT JOIN products p ON p.id = e.product_id
      LEFT JOIN product_categories pc ON pc.id = p.category_id
      WHERE e.user_id = ?
      ORDER BY e.created_at DESC
    `).all(uid);
    return { requests: list };
  });

  // 家长：审核列表（按状态过滤）
  app.get('/exchange-requests', { preHandler: requireParent }, async (req) => {
    const db = getDb();
    const status = (req.query as any)?.status ?? 'pending';
    const list = db.prepare(`
      SELECT e.*, u.name as user_name, u.avatar as user_avatar,
        CASE
          WHEN p.name IS NULL THEN NULL
          WHEN e.variant_name IS NOT NULL THEN p.name || ' · ' || e.variant_name
          ELSE p.name
        END as product_name,
        COALESCE(NULLIF(p.icon, ''), pc.icon, 'gift') as product_icon
      FROM exchange_requests e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN products p ON p.id = e.product_id
      LEFT JOIN product_categories pc ON pc.id = p.category_id
      WHERE e.status = ?
      ORDER BY e.created_at DESC
    `).all(status);
    return { requests: list };
  });

  // 家长：通过审核
  app.post('/exchange-requests/:id/approve', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();

    try {
      let newBalance: number | null = null;
      let finalCost = 0;
      let dayEffectInfo: { name: string; emoji: string; mult: number } | null = null;
      const txn = db.transaction(() => {
        const req0 = db.prepare('SELECT * FROM exchange_requests WHERE id = ?').get(id) as any;
        if (!req0) throw new Error('not_found');
        if (req0.status !== 'pending') throw new Error('already_reviewed');

        // 特殊日：消耗按当天倍率折减（兑换在过审扣分时结算）
        const effect = dayEffectFor(req0.user_id, todayLocal());
        finalCost = req0.points > 0 && effect.spendMult !== 1
          ? Math.max(1, Math.round(req0.points * effect.spendMult))
          : req0.points;
        const effectNote = req0.points > 0 && effect.spendMult !== 1 ? effectSuffix(effect, 'spend') : '';
        dayEffectInfo = effectInfo(effect, 'spend');

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req0.user_id) as any;
        if (user.total_points < finalCost) throw new Error('insufficient_points');

        // 扣积分（折后价）
        db.prepare('UPDATE users SET total_points = total_points - ? WHERE id = ?').run(finalCost, req0.user_id);
        // 流水里写哪个名字：许愿礼物优先用「心愿卡上的名字」（家长可能改过），
        // 商城兑换还是用商品名 —— 两边指的是同一样东西，但名字未必一样。
        const giftName = (() => {
          if (req0.wish_id) {
            const w = db.prepare('SELECT name FROM wish_items WHERE id = ?').get(req0.wish_id) as any;
            if (w?.name) return w.name;
          }
          return (db.prepare('SELECT name FROM products WHERE id = ?').get(req0.product_id) as any)?.name ?? '已删除';
        })();
        // 写流水
        db.prepare(`
          INSERT INTO point_logs (user_id, delta, source, ref_id, note, created_by)
          VALUES (?, ?, 'exchange', ?, ?, ?)
        `).run(
          req0.user_id, -finalCost, req0.id,
          req0.type === 'cash'
            ? `兑换现金 ${req0.amount}元${effectNote}`
            : `${req0.wish_id ? '许愿礼物：' : '兑换商品：'}${giftName}${req0.variant_name ? `（${req0.variant_name}）` : ''}${effectNote}`,
          req.user!.sub,
        );
        // 更新申请状态
        db.prepare('UPDATE exchange_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
          .run('approved', req.user!.sub, Math.floor(Date.now() / 1000), id);
        // 减库存（按兑换件数）：有规格扣规格库存，无规格扣商品库存
        if (req0.type === 'product' && req0.product_id) {
          const qty = Math.max(1, req0.quantity ?? 1);
          if (req0.variant_id) {
            db.prepare('UPDATE product_variants SET stock = stock - ? WHERE id = ? AND stock >= ?').run(qty, req0.variant_id, qty);
          } else {
            db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(qty, req0.product_id, qty);
          }
        }

        newBalance = (db.prepare('SELECT total_points FROM users WHERE id = ?').get(req0.user_id) as any).total_points;
      });
      txn();
      // 推送给小孩：审核通过
      const req0After = db.prepare('SELECT * FROM exchange_requests WHERE id = ?').get(id) as any;
      pushToUser(req0After.user_id, {
        type: 'exchange_reviewed',
        requestId: id,
        status: 'approved',
        exchangeType: req0After.type,
        points: finalCost,
        dayEffect: dayEffectInfo,
        amount: req0After.amount,
        productName: req0After.type === 'product'
          ? `${(db.prepare('SELECT name FROM products WHERE id = ?').get(req0After.product_id) as any)?.name ?? ''}${req0After.variant_name ? `（${req0After.variant_name}）` : ''}`
          : null,
        newBalance,
      });
      // 通过后库存变了 → 两端商城页静默重拉（孩子端立刻看到最新库存）
      pushToAll({ type: 'products_changed', action: 'stock', productId: req0After.product_id ?? null });
      return { ok: true, newBalance };
    } catch (e: any) {
      const msg = e.message;
      if (msg === 'not_found') return reply.code(404).send({ error: msg });
      if (msg === 'already_reviewed') return reply.code(409).send({ error: msg });
      if (msg === 'insufficient_points') return reply.code(409).send({ error: msg });
      throw e;
    }
  });

  // 家长：拒绝审核
  app.post('/exchange-requests/:id/reject', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const db = getDb();
    const r = db.prepare(`
      UPDATE exchange_requests
      SET status = 'rejected', reason = ?, reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(parsed.data.reason, req.user!.sub, Math.floor(Date.now() / 1000), id);
    if (r.changes === 0) return reply.code(409).send({ error: 'already_reviewed' });
    // 推送给小孩：审核拒绝
    const req0 = db.prepare('SELECT * FROM exchange_requests WHERE id = ?').get(id) as any;
    pushToUser(req0.user_id, {
      type: 'exchange_reviewed',
      requestId: id,
      status: 'rejected',
      exchangeType: req0.type,
      points: req0.points,
      amount: req0.amount,
      reason: parsed.data.reason,
      productName: req0.type === 'product'
        ? `${(db.prepare('SELECT name FROM products WHERE id = ?').get(req0.product_id) as any)?.name ?? ''}${req0.variant_name ? `（${req0.variant_name}）` : ''}`
        : null,
    });
    return { ok: true };
  });
}
