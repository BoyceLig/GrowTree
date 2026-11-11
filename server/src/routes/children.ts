import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { isValidPin } from '../auth.js';
import { requireParent } from '../middleware.js';
import { pushToUser, pushToParents } from '../ws.js';

const ZODIAC = ['rat', 'ox', 'tiger', 'rabbit', 'dragon', 'snake', 'horse', 'goat', 'monkey', 'rooster', 'dog', 'pig'];

// 生日：YYYY-MM-DD，允许为空（未填写时生长曲线降级为不显示百分位）
const birthdaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '生日格式须为 YYYY-MM-DD')
  .nullable()
  .optional();

const sexSchema = z.enum(['male', 'female']).nullable().optional();

// 新增时生日/性别必填：生长曲线的百分位完全依赖这两项，事后补录容易忘。
// 编辑时保持 nullable —— 允许把填错的生日清空重填。
const createChildSchema = z.object({
  name: z.string().min(1).max(20),
  pin: z.string().refine(isValidPin, 'PIN必须是4-6位数字'),
  avatar: z.enum(ZODIAC as [string, ...string[]]),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '生日格式须为 YYYY-MM-DD'),
  sex: z.enum(['male', 'female']),
});

const updateChildSchema = z.object({
  name: z.string().min(1).max(20).optional(),
  pin: z.string().refine(isValidPin).optional(),
  avatar: z.enum(ZODIAC as [string, ...string[]]).optional(),
  birthday: birthdaySchema,
  sex: sexSchema,
  /** 成长日记对该孩子的可见性（家长按孩子单独控制） */
  diary_visible: z.boolean().optional(),
  /** 从家长端各页面隐藏/恢复这个孩子（「我的 → 孩子」管理里的隐藏按钮） */
  hidden: z.boolean().optional(),
});

export function registerChildrenRoutes(app: FastifyInstance) {
  // 列出所有小孩（家长）
  //
  // 默认**不含**被隐藏的孩子：隐藏的语义是「家长端各页面都不再出现他/她」，
  // 所以把它做在数据出口上，而不是让每个页面各自记得过滤 —— 那种写法
  // 迟早会漏掉一页，家长就会看到「明明隐藏了还在」。
  // 「我的 → 孩子」那段要管理隐藏的孩子，带 ?include_hidden=1 单独取。
  //
  // ── 排序规则（2026-10-20 用户要求）──────────────────────────────
  //   这一份列表喂的是各页顶部的「孩子筛选 chips」：积分页、任务页、成长页、
  //   流水页、我的页。筛选是一个**位置记忆**场景 —— 家长第二次点的时候
  //   手要落在同一个位置，所以顺序必须是「先添加的在最前」，而不是按积分。
  //   按积分排的问题是：孩子今天被加了 10 分，明天整排 chips 就换位，
  //   点「老二」结果点到了「老大」。
  //   要按积分排的只有首页那张「孩子们」排行卡，它走 /dashboard 自己的
  //   ORDER BY total_points DESC —— 那里排名本身就是信息。
  //   id 升序 == 创建顺序（AUTOINCREMENT，家庭内连续）。
  app.get('/children', { preHandler: requireParent }, async (req) => {
    const db = getDb();
    const includeHidden = String((req.query as { include_hidden?: unknown })?.include_hidden ?? '') === '1';
    const children = db.prepare(
      `SELECT id, name, avatar, total_points, birthday, sex, diary_visible, hidden, created_at
       FROM users WHERE role = 'child'${includeHidden ? '' : ' AND hidden = 0'}
       ORDER BY id ASC`
    ).all();
    return { children };
  });

  // 创建小孩（家长）
  app.post('/children', { preHandler: requireParent }, async (req, reply) => {
    const parsed = createChildSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    const { name, pin, avatar, birthday, sex } = parsed.data;

    const db = getDb();
    // 检查 PIN 唯一性
    const exists = db.prepare('SELECT id FROM users WHERE pin = ? AND role = ?').get(pin, 'child');
    if (exists) return reply.code(409).send({ error: 'pin_used' });

    const result = db.prepare(
      `INSERT INTO users (name, role, pin, avatar, birthday, sex, total_points)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).run(name, 'child', pin, avatar, birthday ?? null, sex ?? null);

    return { id: result.lastInsertRowid, name, avatar, birthday: birthday ?? null, sex: sex ?? null };
  });

  // 更新小孩
  app.patch('/children/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const parsed = updateChildSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const db = getDb();
    const current = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(id, 'child') as any;
    if (!current) return reply.code(404).send({ error: 'not_found' });

    const updates = parsed.data;
    if (updates.pin && updates.pin !== current.pin) {
      const conflict = db.prepare('SELECT id FROM users WHERE pin = ? AND id != ?').get(updates.pin, id);
      if (conflict) return reply.code(409).send({ error: 'pin_used' });
    }

    // 显式拼接 SET 子句：字段传 undefined 表示不改，传 null 表示清空
    // （原 COALESCE 写法无法把已有值清空，生日/性别需要支持清空）
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
    if (updates.pin !== undefined) { sets.push('pin = ?'); params.push(updates.pin); }
    if (updates.avatar !== undefined) { sets.push('avatar = ?'); params.push(updates.avatar); }
    if (updates.birthday !== undefined) { sets.push('birthday = ?'); params.push(updates.birthday); }
    if (updates.sex !== undefined) { sets.push('sex = ?'); params.push(updates.sex); }
    if (updates.diary_visible !== undefined) {
      sets.push('diary_visible = ?');
      params.push(updates.diary_visible ? 1 : 0);
    }
    if (updates.hidden !== undefined) {
      sets.push('hidden = ?');
      params.push(updates.hidden ? 1 : 0);
    }
    if (sets.length) {
      params.push(id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }

    // 日记可见性变了要**立刻**告诉孩子端：不能等下次刷新才消失/出现 ——
    // 家长在另一个房间按下开关，孩子手上的页面必须当场跟着变。
    if (updates.diary_visible !== undefined) {
      const msg = { type: 'diary_visibility_changed', visible: !!updates.diary_visible, childId: id };
      pushToUser(id, msg);
      pushToParents(msg);
    }

    // 隐藏/恢复也要推：家长可能在两个设备上开着不同页面，
    // 不推的话另一台得等下次手动刷新才跟上（而人会以为操作没生效）。
    if (updates.hidden !== undefined) {
      pushToParents({ type: 'child_hidden_changed', childId: id, hidden: !!updates.hidden });
    }

    return { ok: true };
  });

  // 删除小孩（事务级联清理所有关联数据）
  app.delete('/children/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();

    const current = db.prepare('SELECT id FROM users WHERE id = ? AND role = ?').get(id, 'child');
    if (!current) return reply.code(404).send({ error: 'not_found' });

    // 显式按依赖顺序删除，兼容旧库中 ALTER 添加、无 FK 约束的字段
    const cleanup = db.transaction((childId: number) => {
      // 任务完成申请（该小孩提交的，以及属于该小孩任务的）
      db.prepare(`
        DELETE FROM task_completions
        WHERE user_id = ? OR task_id IN (SELECT id FROM adhoc_tasks WHERE user_id = ?)
      `).run(childId, childId);
      // 临时任务
      db.prepare('DELETE FROM adhoc_tasks WHERE user_id = ?').run(childId);
      // 兑换申请
      db.prepare('DELETE FROM exchange_requests WHERE user_id = ?').run(childId);
      // 积分流水
      db.prepare('DELETE FROM point_logs WHERE user_id = ?').run(childId);
      // 日常完成记录
      db.prepare('DELETE FROM daily_completions WHERE user_id = ?').run(childId);
      // 该小孩的专属积分项
      db.prepare('DELETE FROM point_items WHERE owner_id = ?').run(childId);
      // 成长记录（身高体重）
      db.prepare('DELETE FROM growth_records WHERE user_id = ?').run(childId);
      // 账号本体
      db.prepare("DELETE FROM users WHERE id = ? AND role = 'child'").run(childId);
    });

    cleanup(id);
    return { ok: true };
  });
}
