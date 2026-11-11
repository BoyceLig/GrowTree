import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';
import { pushToAll } from '../ws.js';
import { ensureWishCategory } from './wish-items.js';

// ─────────────────────────────────────────────────────────────────────────────
// 商品分类：家长可创建 / 改名 / 换图标 / 删除，两端商城页按分类筛选商品。
// icon 与 products.icon 同构 —— 内置图标 key 或自定义上传图片路径，
// 这样「商品没单独传图片 → 用分类图标」这条回落规则在前端是同一套渲染逻辑。
// ─────────────────────────────────────────────────────────────────────────────

const ICON_KEYS = ['snack', 'toy', 'activity', 'game', 'study', 'privilege', 'food', 'gift'] as const;
const UPLOAD_PATH = /^\/uploads\/[\w.-]+\.(png|jpe?g|gif|webp)$/;
const COLOR_HEX = /^#[0-9a-fA-F]{6}$/;

const iconSchema = z.union([z.enum(ICON_KEYS), z.string().regex(UPLOAD_PATH)]);

const createSchema = z.object({
  name: z.string().trim().min(1).max(12),
  icon: iconSchema.default('gift'),
  color: z.string().regex(COLOR_HEX).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(12).optional(),
  icon: iconSchema.optional(),
  color: z.string().regex(COLOR_HEX).optional(),
});

// 拖拽排序：把「当前全部分类的一个排列」整组传上来，按下标重写 sort_order
const reorderSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
});

function listCategories(includeHidden = true) {
  return getDb().prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
    FROM product_categories c
    ${includeHidden ? '' : 'WHERE c.hidden = 0'}
    ORDER BY c.sort_order ASC, c.id ASC
  `).all();
}

export function registerProductCategoriesRoutes(app: FastifyInstance) {
  // 列表（家长 + 小孩都可读：商城筛选条要用）
  // 孩子端看不到 hidden 分类（「许愿单」分类及其商品不进孩子端商城）
  app.get('/product-categories', async (req) => {
    // 家长端要能选「许愿单」分类发布商品 —— 这个分类是按需自动建的，
    // 不清一次的话新家庭在商品编辑器里根本选不到它。
    if (req.user!.role === 'parent') ensureWishCategory();
    return { categories: listCategories(req.user!.role === 'parent') };
  });

  // 家长：新建分类
  app.post('/product-categories', { preHandler: requireParent }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { name, icon, color } = parsed.data;
    const db = getDb();
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM product_categories').get() as { n: number };
    const r = db.prepare(
      'INSERT INTO product_categories (name, icon, color, sort_order) VALUES (?, ?, ?, ?)'
    ).run(name, icon, color ?? '#e8b4c8', next.n);
    pushToAll({ type: 'products_changed', action: 'category_created' });
    return { id: Number(r.lastInsertRowid), categories: listCategories() };
  });

  // 家长：拖拽排序（排序结果决定两端商城筛选条里的先后）
  // 用 POST 而不是 PATCH /:id，是为了不和上面的单条修改抢同一条路径。
  app.post('/product-categories/reorder', { preHandler: requireParent }, async (req, reply) => {
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const ids = parsed.data.ids;
    const db = getDb();
    const existing = new Set(
      (db.prepare('SELECT id FROM product_categories').all() as { id: number }[]).map((r) => r.id)
    );
    // 只接受「恰好是全部分类的一个排列」：多一个少一个都拒绝。
    // 否则另一个家长刚删/加过分类时，会把陈旧列表的顺序写进去，出现重叠的 sort_order。
    const valid = ids.length === existing.size && new Set(ids).size === ids.length
      && ids.every((id) => existing.has(id));
    if (!valid) {
      return reply.code(409).send({ error: 'stale_list', categories: listCategories() });
    }
    db.transaction(() => {
      const upd = db.prepare('UPDATE product_categories SET sort_order = ? WHERE id = ?');
      ids.forEach((id, i) => upd.run(i, id));
    })();
    pushToAll({ type: 'products_changed', action: 'category_reordered' });
    return { ok: true, categories: listCategories() };
  });

  // 家长：修改分类名称 / 图标 / 配色
  app.patch('/product-categories/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const u = parsed.data;
    const r = getDb().prepare(`
      UPDATE product_categories SET
        name = COALESCE(?, name),
        icon = COALESCE(?, icon),
        color = COALESCE(?, color)
      WHERE id = ?
    `).run(u.name ?? null, u.icon ?? null, u.color ?? null, id);
    if (r.changes === 0) return reply.code(404).send({ error: 'not_found' });
    pushToAll({ type: 'products_changed', action: 'category_updated' });
    return { ok: true, categories: listCategories() };
  });

  // 家长：删除分类 —— 分类下的商品不删，只解除归属（之后显示为「未分类」）
  app.delete('/product-categories/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const exists = db.prepare('SELECT id, hidden FROM product_categories WHERE id = ?').get(id) as
      | { id: number; hidden: number }
      | undefined;
    if (!exists) return reply.code(404).send({ error: 'not_found' });
    // 「许愿单」是系统分类：删掉之后许愿礼物会变成「未分类」商品跑进孩子端商城
    if (exists.hidden === 1) return reply.code(400).send({ error: 'category_locked' });
    db.transaction(() => {
      // 显式解绑：ALTER TABLE 加的外键约束在个别老库上未必生效，不能只依赖 ON DELETE SET NULL
      db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(id);
      db.prepare('DELETE FROM product_categories WHERE id = ?').run(id);
    })();
    pushToAll({ type: 'products_changed', action: 'category_deleted' });
    return { ok: true, categories: listCategories() };
  });
}
