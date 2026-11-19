import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';
import { pushToUser, pushToAll } from '../ws.js';
import { dayEffectFor, effectSuffix, todayLocal } from '../services/dayEffect.js';

/** 商品展示图片（用于快照） */
const IMAGE_EXPR = "COALESCE(NULLIF(p.icon, ''), c.icon, 'gift') AS image";

function iconOfProduct(productId: number): string {
  const row = getDb().prepare(`
    SELECT ${IMAGE_EXPR}
    FROM products p
    LEFT JOIN product_categories c ON c.id = p.category_id
    WHERE p.id = ?
  `).get(productId) as { image: string } | undefined;
  return row?.image ?? 'gift';
}

/** 家长身份展示：昵称（身份），昵称空退回 name */
function parentLabel(parentId: number): string {
  const u = getDb().prepare('SELECT name, nickname, parent_identity FROM users WHERE id = ?')
    .get(parentId) as { name: string; nickname: string | null; parent_identity: string | null } | undefined;
  if (!u) return '';
  const label = u.nickname || u.name;
  const identity = u.parent_identity ? `（${u.parent_identity}）` : '';
  return `${label}${identity}`;
}

/** 孩子展示名：昵称优先，退回 name */
function childLabel(childId: number): string {
  const u = getDb().prepare('SELECT name, nickname FROM users WHERE id = ?')
    .get(childId) as { name: string; nickname: string | null } | undefined;
  if (!u) return '';
  return u.nickname || u.name;
}

/**
 * 追加一条背包操作记录（家长端「操作历史」数据源）。
 * 物品名/图标用快照，之后背包行怎么变都不影响历史展示。
 */
function logBackpack(entry: {
  childId: number;
  action: 'gift' | 'exchange' | 'use' | 'take';
  itemName: string;
  icon?: string;
  quantity?: number;
  detail?: string;
  refundPoints?: number;
  actorRole: 'parent' | 'child';
  actorLabel: string;
}) {
  getDb().prepare(`
    INSERT INTO backpack_logs
      (child_id, action, item_name, icon, quantity, detail, refund_points, actor_role, actor_label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.childId,
    entry.action,
    entry.itemName,
    entry.icon ?? '',
    entry.quantity ?? 1,
    entry.detail ?? '',
    entry.refundPoints ?? 0,
    entry.actorRole,
    entry.actorLabel,
    Math.floor(Date.now() / 1000),
  );
}

/** 背包列表公共查询：未使用 → 已使用 → 已被拿走，组内按获得时间倒序 */
const LIST_SQL = `
  SELECT id, product_id, name, icon, description, cost, status, acquired_at, used_at, use_note,
         source, taken_at, take_reason, take_refund
  FROM backpack_items
  WHERE child_id = ?
  ORDER BY
    CASE WHEN taken_at IS NOT NULL THEN 2
         WHEN status = 'used' THEN 1
         ELSE 0 END,
    acquired_at DESC, id DESC
`;

export type GiftBackpackInput = {
  childId: number;
  productId: number;
  quantity: number;
  reason: string;
  createdBy: number;
};

export type GiftBackpackResult =
  | { ok: true; childId: number; productId: number; productName: string; quantity: number }
  | { ok: false; error: 'child_not_found' | 'product_not_found' | 'variant_required' };

/**
 * 家长直接赠送商品到孩子背包：不扣积分、不减库存、不走兑换流程。
 * 路由与 AI 工具共用这一份逻辑，保证界面和对话里的赠送行为一致。
 */
export function giftBackpackItem(input: GiftBackpackInput): GiftBackpackResult {
  const { childId, productId, quantity, reason, createdBy } = input;
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND status = ?')
    .get(productId, 'active') as any;
  if (!product) return { ok: false, error: 'product_not_found' };
  const child = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?')
    .get(childId, 'child') as any;
  if (!child) return { ok: false, error: 'child_not_found' };
  // 有规格的商品必须选规格；赠送时不做规格选择，先拒绝并引导去兑换
  const variants = db.prepare('SELECT id FROM product_variants WHERE product_id = ?').all(productId) as any[];
  if (variants.length > 0) return { ok: false, error: 'variant_required' };

  const icon = iconOfProduct(productId);
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(`INSERT INTO backpack_items
    (child_id, product_id, name, icon, description, cost, status, acquired_at, source)
    VALUES (?, ?, ?, ?, ?, ?, 'unused', ?, 'gift')`);
  const txn = db.transaction(() => {
    for (let i = 0; i < quantity; i++) {
      ins.run(childId, productId, product.name, icon, product.prop_desc ?? '', product.cost, now);
    }
  });
  txn();

  // 推给孩子：{昵称（身份）} 送了你一个 {物品}（×数量），理由：{xxx}，已放入你的背包
  pushToUser(childId, {
    type: 'backpack_gifted',
    parentId: createdBy,
    parentLabel: parentLabel(createdBy),
    itemName: product.name,
    quantity,
    reason,
  });
  pushToAll({ type: 'backpack_changed', childId, productId });
  return { ok: true, childId, productId, productName: product.name, quantity };
}

export function registerBackpackRoutes(app: FastifyInstance) {
  // ── 孩子端：查看自己的背包 ─────────────────────────────────────────────
  app.get('/backpack', async (req) => {
    const uid = req.user!.sub;
    const rows = getDb().prepare(LIST_SQL).all(uid);
    return { items: rows };
  });

  // ── 孩子端：使用一个道具 ──────────────────────────────────────────────
  app.post('/backpack/:id/use', async (req, reply) => {
    const id = Number((req.params as any).id);
    const body = req.body as any;
    const useNote = (body?.note ?? '').toString().trim().slice(0, 200);
    const db = getDb();
    const txn = db.transaction(() => {
      const row = db.prepare('SELECT * FROM backpack_items WHERE id = ? AND child_id = ?')
        .get(id, req.user!.sub) as any;
      if (!row) throw new Error('not_found');
      if (row.status !== 'unused' || row.taken_at) throw new Error('already_used');
      db.prepare('UPDATE backpack_items SET status = ?, used_at = ?, use_note = ? WHERE id = ?')
        .run('used', Math.floor(Date.now() / 1000), useNote, id);
      logBackpack({
        childId: req.user!.sub,
        action: 'use',
        itemName: row.name,
        icon: row.icon,
        detail: useNote,
        actorRole: 'child',
        actorLabel: childLabel(req.user!.sub),
      });
    });
    try {
      txn();
      return { ok: true };
    } catch (e: any) {
      if (e.message === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (e.message === 'already_used') return reply.code(409).send({ error: 'already_used' });
      throw e;
    }
  });

  // ── 家长端：查看指定孩子的背包 ─────────────────────────────────────────
  app.get('/backpack/child/:childId', { preHandler: requireParent }, async (req, reply) => {
    const childId = Number((req.params as any).childId);
    const db = getDb();
    const child = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(childId) as any;
    if (!child || child.role !== 'child') return reply.code(404).send({ error: 'not_found' });
    const rows = db.prepare(LIST_SQL).all(childId);
    return { child, items: rows };
  });

  // ── 家长端：背包操作历史（最近 100 条，倒序） ──────────────────────────
  app.get('/backpack/logs', { preHandler: requireParent }, async (req) => {
    const childId = Number((req.query as any).childId);
    const logs = getDb().prepare(`
      SELECT id, action, item_name, icon, quantity, detail, refund_points, actor_role, actor_label, created_at
      FROM backpack_logs
      WHERE child_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `).all(childId);
    return { logs };
  });

  // ── 家长：直接赠送一个商品到孩子背包（不走兑换流程、不扣积分、不减库存）─
  const giftSchema = z.object({
    childId: z.number().int().positive(),
    productId: z.number().int().positive(),
    quantity: z.number().int().min(1).max(20).default(1),
    reason: z.string().min(1).max(200),
  });
  app.post('/backpack/gift', { preHandler: requireParent }, async (req, reply) => {
    const parsed = giftSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { childId, productId, quantity, reason } = parsed.data;
    const result = giftBackpackItem({
      childId,
      productId,
      quantity,
      reason,
      createdBy: req.user!.sub,
    });
    if (!result.ok) {
      if (result.error === 'variant_required') {
        return reply.code(400).send({ error: result.error, detail: '带规格的商品暂不支持直接赠送，请先兑换' });
      }
      return reply.code(404).send({ error: result.error });
    }
    return { ok: true, childId: result.childId, productId: result.productId, quantity: result.quantity };
  });

  // ── 家长：从孩子背包拿走一个道具（返还积分 + 填写理由） ────────────────
  // 2026-11-14：不再 DELETE，行保留并标记 taken_at，孩子端/家长端都能看到
  // 「已被拿走」的物品和理由；操作写入 backpack_logs 供家长端回看。
  const takeSchema = z.object({
    reason: z.string().min(1).max(200),
    /** 返还给孩子的积分；不传则按道具快照 cost 返还（免费道具默认 0） */
    refundPoints: z.number().int().min(0).optional(),
  });
  app.post('/backpack/:id/take', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const parsed = takeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { reason, refundPoints: explicitRefund } = parsed.data;

    const db = getDb();
    const item = db.prepare('SELECT * FROM backpack_items WHERE id = ?').get(id) as any;
    if (!item) return reply.code(404).send({ error: 'not_found' });
    if (item.taken_at) return reply.code(409).send({ error: 'already_taken' });
    const rawRefund = explicitRefund ?? Math.max(0, Number(item.cost) || 0);
    // 返还属「获得」语义：特殊日按当天获得倍率放大（D1）
    const effect = rawRefund > 0 ? dayEffectFor(item.child_id, todayLocal()) : null;
    const useEffect = !!effect && effect.earnMult !== 1;
    const refund = useEffect && effect ? Math.round(rawRefund * effect.earnMult) : rawRefund;
    const effectNote = useEffect && effect ? effectSuffix(effect, 'earn') : '';

    let newBalance = 0;
    const label = parentLabel(req.user!.sub);
    const txn = db.transaction(() => {
      db.prepare('UPDATE backpack_items SET taken_at = ?, take_reason = ?, take_refund = ? WHERE id = ?')
        .run(Math.floor(Date.now() / 1000), reason, refund, id);
      if (refund > 0) {
        db.prepare('UPDATE users SET total_points = total_points + ? WHERE id = ?').run(refund, item.child_id);
        db.prepare(`INSERT INTO point_logs
          (user_id, delta, source, note, created_by)
          VALUES (?, ?, 'adjust', ?, ?)`)
          .run(item.child_id, refund, `返还：拿走背包道具「${item.name}」 - ${reason}${effectNote}`, req.user!.sub);
        const u = db.prepare('SELECT total_points FROM users WHERE id = ?').get(item.child_id) as any;
        newBalance = u.total_points;
      }
      logBackpack({
        childId: item.child_id,
        action: 'take',
        itemName: item.name,
        icon: item.icon,
        quantity: 1,
        detail: reason,
        refundPoints: refund,
        actorRole: 'parent',
        actorLabel: label,
      });
    });
    txn();

    pushToUser(item.child_id, {
      type: 'backpack_taken',
      parentId: req.user!.sub,
      parentLabel: label,
      itemName: item.name,
      refundPoints: refund,
      reason,
      newBalance,
    });
    pushToAll({ type: 'backpack_changed', childId: item.child_id });
    if (refund > 0) {
      pushToAll({ type: 'points_changed', userId: item.child_id, delta: refund, newBalance });
    }
    return { ok: true, refundPoints: refund, newBalance };
  });
}
