import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';
import { pushToAll } from '../ws.js';
import { progressOf } from './wish-items.js';

// 商品图片只接受「自定义上传图片的站内路径」或空串（= 用所属分类的图标）。
// 历史数据里 icon 曾是内置图标 key，迁移时已归入 category_id，这里不再接受。
// 允许一层子目录（/uploads/f<家庭id>/...）—— 上传按家庭归档，旧正则全拒。
// 负向先行断言拦掉 ..，防止路径穿越。
const PRODUCT_IMAGE = /^\/uploads\/(?!.*\.\.)[\w./-]+\.(png|jpe?g|gif|webp)$/;
const imageSchema = z.union([z.literal(''), z.string().regex(PRODUCT_IMAGE)]);

const VARIANT_MAX = 20;

const variantSchema = z.object({
  id: z.number().int().positive().optional(), // 编辑时保留原 id（暂未用，规格一律整组替换）
  name: z.string().min(1).max(20),
  cost: z.number().int().positive(),
  stock: z.number().int().default(-1), // -1 = 不限
});

const createSchema = z.object({
  name: z.string().min(1).max(50),
  // 道具允许 0 积分（免费）；普通商品在 handler 里再强制 > 0
  cost: z.number().int().min(0),
  stock: z.number().int().default(-1), // -1 = 无限
  icon: imageSchema.default(''),       // 自定义商品图片；'' = 用分类图标
  category_id: z.number().int().positive().nullable().default(null),
  limit_days: z.number().int().min(0).default(0),   // 0 = 不限
  limit_count: z.number().int().min(0).default(0),  // 0 = 不限
  max_per_exchange: z.number().int().min(1).max(99).default(1), // 单次最多件数
  // 许愿单：是否允许孩子许愿这个商品、需要的打卡天数、是否要求连续
  wish_enabled: z.number().int().min(0).max(1).default(0),
  wish_days: z.number().int().min(1).max(365).default(7),
  wish_consecutive: z.number().int().min(0).max(1).default(0),
  /** 每天的考核标准：0 = 全部完成；>0 = 每天至少完成 N 项 */
  wish_daily_count: z.number().int().min(0).max(99).default(0),
  // 1 = 许愿专用商品（不进孩子端商城）
  wish_only: z.number().int().min(0).max(1).default(0),
  /** goods = 普通礼物（需家长审核）；prop = 道具（兑换即入背包，可免费） */
  kind: z.enum(['goods', 'prop']).default('goods'),
  prop_desc: z.string().max(200).default(''),
  variants: z.array(variantSchema).max(VARIANT_MAX).nullable().optional(), // 规格列表；空/NULL = 无规格
  status: z.enum(['active', 'inactive']).default('active'),
});

const updateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  cost: z.number().int().min(0).optional(),
  stock: z.number().int().optional(),
  icon: imageSchema.optional(),
  category_id: z.number().int().positive().nullable().optional(),
  limit_days: z.number().int().min(0).optional(),
  limit_count: z.number().int().min(0).optional(),
  max_per_exchange: z.number().int().min(1).max(99).optional(),
  wish_enabled: z.number().int().min(0).max(1).optional(),
  wish_days: z.number().int().min(1).max(365).optional(),
  wish_consecutive: z.number().int().min(0).max(1).optional(),
  wish_daily_count: z.number().int().min(0).max(99).optional(),
  wish_only: z.number().int().min(0).max(1).optional(),
  kind: z.enum(['goods', 'prop']).optional(),
  prop_desc: z.string().max(200).optional(),
  variants: z.array(variantSchema).max(VARIANT_MAX).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

/**
 * 商品展示用图片：有自定义图片就用它，否则回落到所属分类的图标，最后兜底 'gift'。
 * 前端只认这一个字段（image），不用重复实现回落逻辑。
 */
const IMAGE_EXPR = "COALESCE(NULLIF(p.icon, ''), c.icon, 'gift') AS image";

/** 商品列表查询：统一带出分类信息与解析好的展示图片 */
function productSelect(where: string, orderBy: string) {
  return `
    SELECT p.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
           c.hidden AS category_hidden,
           ${IMAGE_EXPR}
    FROM products p
    LEFT JOIN product_categories c ON c.id = p.category_id
    ${where}
    ORDER BY ${orderBy}
  `;
}

/**
 * 分类是不是「许愿单」这种隐藏分类 → 该分类下的商品只能走许愿单领取，不进孩子端商城。
 * 家长把商品放进隐藏分类（而不是勾别的开关）就该是这个效果，两边保持一致。
 */
function categoryHidden(categoryId: number | null | undefined): boolean {
  if (!categoryId) return false;
  const row = getDb().prepare('SELECT hidden FROM product_categories WHERE id = ?').get(categoryId) as
    | { hidden: number }
    | undefined;
  return row?.hidden === 1;
}

/** 某个商品的规格列表（按展示顺序） */
function variantsOf(productId: number) {
  return getDb().prepare(
    'SELECT id, name, cost, stock FROM product_variants WHERE product_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(productId) as { id: number; name: string; cost: number; stock: number }[];
}

/** 整组替换规格（编辑时用）：先删后插，简单可靠 */
function replaceVariants(productId: number, variants: { name: string; cost: number; stock: number }[] | null | undefined) {
  const db = getDb();
  if (variants === undefined) return; // 未传 = 不动
  db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(productId);
  if (!variants || variants.length === 0) return;
  const ins = db.prepare('INSERT INTO product_variants (product_id, name, cost, stock, sort_order) VALUES (?, ?, ?, ?, ?)');
  variants.forEach((v, i) => ins.run(productId, v.name.trim(), v.cost, v.stock, i));
}

// 现金兑换比例：从 DB settings 读取，默认 10 积分 = 1 元
export function getCashRate(): number {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'cash_rate'").get() as { value: string } | undefined;
  if (!row) return 10;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export function registerProductsRoutes(app: FastifyInstance) {
  // 列表（家长+小孩均可读；孩子端只看 active，且看不到许愿专用商品）
  app.get('/products', async (req) => {
    const db = getDb();
    const role = req.user!.role;
    const rows = db.prepare(
      role === 'parent'
        ? productSelect('', 'p.status DESC, p.created_at DESC')
        // 孩子端：只看 active，且看不到许愿专用商品 / 「许愿单」分类下的商品
        : productSelect(
            "WHERE p.status = 'active' AND p.wish_only = 0 AND (c.hidden IS NULL OR c.hidden = 0)",
            'p.created_at DESC'
          )
    ).all() as any[];
    const products = rows.map((p) => {
      const variants = variantsOf(p.id);
      // 有规格时：总库存 = 各规格之和（任一规格不限则整体不限），展示价格取最低价
      let total_stock = p.stock;
      let min_cost = p.cost;
      if (variants.length > 0) {
        total_stock = variants.some((v) => v.stock === -1) ? -1 : variants.reduce((s, v) => s + Math.max(0, v.stock), 0);
        min_cost = Math.min(...variants.map((v) => v.cost));
      }
      return { ...p, variants, total_stock, min_cost };
    });
    return { products };
  });

  // 获取现金兑换比例
  app.get('/products/cash-rate', async () => {
    const rate = getCashRate();
    return { rate, unit: '元', pointsPerUnit: rate };
  });

  // 家长：设置现金兑换比例
  app.put('/products/cash-rate', { preHandler: requireParent }, async (req, reply) => {
    const body = req.body as any;
    const n = Number(body?.rate);
    if (!Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: 'invalid_input' });
    const db = getDb();
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('cash_rate', ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?")
      .run(String(n), Math.floor(Date.now() / 1000), String(n), Math.floor(Date.now() / 1000));
    pushToAll({ type: 'products_changed', action: 'cash_rate' });
    return { rate: n, unit: '元', pointsPerUnit: n };
  });

  // 家长：创建商品
  app.post('/products', { preHandler: requireParent }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { name, cost, stock, icon, category_id, limit_days, limit_count, max_per_exchange, variants, status,
      wish_enabled, wish_days, wish_consecutive, wish_daily_count, wish_only, kind, prop_desc } = parsed.data;
    // 普通礼物积分必须 > 0；道具允许 0 积分（免费）
    if (kind === 'goods' && cost <= 0) {
      return reply.code(400).send({ error: 'invalid_input', detail: '礼物类商品积分必须大于 0' });
    }
    const db = getDb();
    // 放进隐藏分类（「许愿单」）= 只能许愿领取，孩子端商城不展示
    const onlyWish = categoryHidden(category_id) ? 1 : wish_only;
    // 只能许愿领取的商品如果又不允许许愿，那它两边都看不到 —— 强制打开
    const wishEnabled = onlyWish === 1 ? 1 : wish_enabled;
    const r = db.prepare(`INSERT INTO products
      (name, cost, stock, icon, category_id, limit_days, limit_count, max_per_exchange,
       wish_enabled, wish_days, wish_consecutive, wish_daily_count, wish_only, kind, prop_desc, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, cost, stock, icon, category_id, limit_days, limit_count, max_per_exchange,
        wishEnabled, wish_days, wish_consecutive, wish_daily_count, onlyWish, kind, prop_desc, status);
    const id = Number(r.lastInsertRowid);
    replaceVariants(id, variants ?? null);
    pushToAll({ type: 'products_changed', action: 'created', productId: id });
    return { id };
  });

  // 家长：编辑商品
  app.patch('/products/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const u = parsed.data;
    const db = getDb();
    // 先记下旧的许愿考核标准：有没有真的改过，决定要不要传导到进行中的心愿
    const before = db.prepare('SELECT wish_days, wish_consecutive, wish_daily_count FROM products WHERE id = ?')
      .get(id) as { wish_days: number; wish_consecutive: number; wish_daily_count: number } | undefined;
    // 当前商品类型：用于 goods/props 切换时校验 cost
    const currentKind = db.prepare('SELECT kind, cost FROM products WHERE id = ?')
      .get(id) as { kind: string; cost: number } | undefined;
    if (!currentKind) return reply.code(404).send({ error: 'not_found' });
    const nextKind = u.kind ?? currentKind.kind;
    const nextCost = u.cost ?? currentKind.cost;
    if (nextKind === 'goods' && nextCost <= 0) {
      return reply.code(400).send({ error: 'invalid_input', detail: '礼物类商品积分必须大于 0' });
    }
    // category_id 用「是否传了字段」判断而不是 COALESCE：null 是合法值（移出分类）
    const categoryGiven = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'category_id');
    // 分类决定「会不会出现在孩子端商城」：挪进隐藏分类 → 强制只能许愿领取；挪出来 → 恢复正常
    const wishOnlyNext = categoryGiven ? (categoryHidden(u.category_id ?? null) ? 1 : 0) : (u.wish_only ?? null);
    // 同上：只能许愿领取的商品必须允许许愿
    const wishEnabledNext = wishOnlyNext === 1 ? 1 : (u.wish_enabled ?? null);
    const r = db.prepare(`
      UPDATE products SET
        name = COALESCE(?, name),
        cost = COALESCE(?, cost),
        stock = COALESCE(?, stock),
        icon = COALESCE(?, icon),
        category_id = CASE WHEN ? THEN ? ELSE category_id END,
        limit_days = COALESCE(?, limit_days),
        limit_count = COALESCE(?, limit_count),
        max_per_exchange = COALESCE(?, max_per_exchange),
        wish_enabled = COALESCE(?, wish_enabled),
        wish_days = COALESCE(?, wish_days),
        wish_consecutive = COALESCE(?, wish_consecutive),
        wish_daily_count = COALESCE(?, wish_daily_count),
        wish_only = COALESCE(?, wish_only),
        kind = COALESCE(?, kind),
        prop_desc = COALESCE(?, prop_desc),
        status = COALESCE(?, status),
        is_preset = 0
      WHERE id = ?
    `).run(
      u.name ?? null, u.cost ?? null, u.stock ?? null, u.icon ?? null,
      categoryGiven ? 1 : 0, u.category_id ?? null,
      u.limit_days ?? null, u.limit_count ?? null, u.max_per_exchange ?? null,
      u.wish_enabled ?? wishEnabledNext, u.wish_days ?? null, u.wish_consecutive ?? null, u.wish_daily_count ?? null,
      wishOnlyNext,
      u.kind ?? null, u.prop_desc ?? null,
      u.status ?? null, id
    );
    if (r.changes === 0) return reply.code(404).send({ error: 'not_found' });

    // ── 许愿规则热更新（2026-11-03）────────────────────────────────────
    // 家长改了商品的许愿考核标准（天数 / 连续↔累计 / 全部完成↔每天 N 项）时，
    // 新规则传导到引用这件商品的进行中心愿（pending/confirming/active）：
    //   · 改动当天先用**旧规则**把进行中心愿已挣到的天数（累计模式看 done、
    //     连续模式看 streak）算好，冻结进 carried_days —— 已完成的天不归零；
    //   · 记下变更日（本地今天 0 点）—— 之后的天数从变更日起按新规则判定。
    //   carried 计算要带上心愿自己的 rule_changed_at / carried_days：
    //   上次结转的天 + 上次变更日起按当时规则挣的天 = 这次要冻结的全部。
    let wishRuleTouched = 0;
    if (before) {
      const nextDays = u.wish_days ?? before.wish_days;
      const nextCons = u.wish_consecutive ?? before.wish_consecutive;
      const nextDaily = u.wish_daily_count ?? before.wish_daily_count;
      if (nextDays !== before.wish_days || nextCons !== before.wish_consecutive || nextDaily !== before.wish_daily_count) {
        const n = new Date();
        const ruleStart = Math.floor(new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() / 1000);
        const nextMode = nextDaily > 0 ? 'count' : 'all';
        const wishes = db.prepare(`
          SELECT * FROM wish_items WHERE product_id = ? AND status IN ('pending', 'confirming', 'active')
        `).all(id) as any[];
        // 旧规则只结算到「昨天」（asOf = 变更日 0 点 - 1 秒）：变更日当天起由
        // 新规则判定，避免同一天被新旧两套规则各记一次。
        const asOf = ruleStart - 1;
        for (const w of wishes) {
          let carried = 0;
          if (w.status === 'active' && w.activated_at) {
            const old = progressOf(
              w.child_id, w.days_required, w.require_consecutive === 1,
              (w.mode === 'count' ? 'count' : 'all'), w.daily_count ?? 0,
              w.activated_at, w.rule_changed_at ?? null, w.carried_days ?? 0, asOf
            );
            carried = w.require_consecutive === 1 ? old.streak : old.done;
          }
          db.prepare(`
            UPDATE wish_items SET
              days_required = ?, require_consecutive = ?, mode = ?, daily_count = ?,
              rule_changed_at = ?, carried_days = ?
            WHERE id = ?
          `).run(nextDays, nextCons, nextMode, nextDaily, ruleStart, carried, w.id);
        }
        wishRuleTouched = wishes.length;
      }
    }

    // 规格整组替换（未传 variants 则保持原样）
    if (u.variants !== undefined) replaceVariants(id, u.variants);
    // is_preset 一并清 0：模板预置的商品一经家长编辑就按「自己发的」算，
    // 「商品发布」积分任务的进度由此 +1（见 ext/routes/signin-tasks.ts）
    pushToAll({ type: 'products_changed', action: 'updated', productId: id });
    if (wishRuleTouched > 0) {
      // 心愿卡的规则文案/进度条在下次拉取 wish-items 时按新快照重算，这里推一下让两端静默刷新
      pushToAll({ type: 'wish_rule_changed', productId: id });
    }
    return { ok: true, wish_rule_updated: wishRuleTouched };
  });

  // 家长：删除商品
  app.delete('/products/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const r = db.prepare('DELETE FROM products WHERE id = ?').run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'not_found' });
    pushToAll({ type: 'products_changed', action: 'deleted', productId: id });
    return { ok: true };
  });
}
