import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';
import { pushToParents, pushToUser, pushToAll } from '../ws.js';
import { currentPeriod, type RecurringTaskRow } from './recurring-tasks.js';

// ─────────────────────────────────────────────────────────────────────────────
// 许愿单：孩子许愿 → 家长通过申请（定礼物 + 天数 + 考核标准）→ 孩子确认开启
//         → 每天把任务做够 → 孩子点「领取」直接到手（不用家长再审核）
//
// 状态机（wish_items.status）：
//   pending     等家长处理。孩子自己写的愿望在这里等家长完善；
//               孩子点了「不同意」也会退回这里，家长改完再通过一次。
//   confirming  家长已通过申请，等孩子确认（卡片上会写明要完成多少天、每天几项）
//   active      孩子已确认，开始累计
//   completed   天数够了，等孩子点「领取礼物」
//   claimed     已领取（兑换记录里直接是多了一条「已完成」的许愿礼物，无需审核）
//   cancelled   撤销
//
// ── 「一天算不算成功」────────────────────────────────────────────────────
//   考核的是孩子当天的**必做任务**：某个任务的这一期正好在今天到期（截止日在今天）。
//   截止日在未来（单次任务给了几天期限、每月任务还没到号）的任务，今天不做也不算缺勤。
//   一天的成功条件：
//     · mode='all'   → 当天必做的全部做完（当天没有必做任务 → 不算缺勤）
//     · mode='count' → 当天至少做完 daily_count 项（不足 N 项时全做完即可）
//   进度不落库：实时数 recurring_claims 里审核通过的记录，家长晚审核也不会丢进度。
// ─────────────────────────────────────────────────────────────────────────────

const PHOTO_RE = /^\/uploads\/(?!.*\.\.)[\w./-]+\.(png|jpe?g|gif|webp)$/;
const photoSchema = z.union([z.literal(''), z.string().regex(PHOTO_RE)]);

const createSchema = z.object({
  product_id: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(30).optional(),
  description: z.string().trim().max(200).optional(),
  photo: photoSchema.optional(),
});

const configureSchema = z.object({
  /** 礼物的名字 / 描述 / 展示图：家长可以全部改掉孩子写的内容 */
  name: z.string().trim().min(1).max(30).optional(),
  description: z.string().trim().max(200).optional(),
  photo: photoSchema.optional(),
  /** 需要多少个成功日 */
  days: z.number().int().min(1).max(365),
  /** 是否要求连续 */
  consecutive: z.boolean().default(false),
  /** 每天的考核标准：全部完成 / 至少 N 项 */
  mode: z.enum(['all', 'count']).default('all'),
  daily_count: z.number().int().min(1).max(99).default(1),
  /**
   * 孩子自己写的商品：是否同时加入商城。
   * true = 建一个普通商品（可标价、可归分类）；false = 建许愿专用商品（进「许愿单」隐藏分类）
   */
  add_to_shop: z.boolean().default(false),
  cost: z.number().int().min(1).max(99999).default(100),
  category_id: z.number().int().positive().nullable().optional(),
});

const CATEGORY_NAME = '许愿单';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 这个孩子身上的（已启用的）周期任务 */
function assignedTasks(childId: number): RecurringTaskRow[] {
  const rows = getDb().prepare('SELECT * FROM recurring_tasks WHERE enabled = 1').all() as RecurringTaskRow[];
  return rows.filter((t) => {
    if (!t.child_ids) return true;
    try { return (JSON.parse(t.child_ids) as number[]).includes(childId); } catch { return true; }
  });
}

/**
 * 某一天「必须做完」的任务：这一期正好在今天到期。
 *   · 每天任务 / 当天轮到的每周任务 → 今天到期
 *   · 每月任务 → 只有到号那天必做，其它日子可以先做也可以不做
 *   · 单次任务 → 只有截止日那天必做；没设截止日（due_at = null）则永不逼今天做
 */
function requiredOn(tasks: RecurringTaskRow[], day: Date): Map<number, string> {
  const need = new Map<number, string>();
  const key = dateStr(day);
  for (const t of tasks) {
    const p = currentPeriod(t, day);
    if (!p || p.due_at == null) continue;
    if (dateStr(new Date(p.due_at * 1000)) !== key) continue;
    need.set(t.id, p.period_key);
  }
  return need;
}

export interface WishProgress {
  /** 成功（打卡成功）的天数 */
  done: number;
  /** 需要多少天 */
  required: number;
  percent: number;
  /** 最长连续成功天数 */
  streak: number;
  /** 今天算不算成功（该做的做够了） */
  todayDone: boolean;
  /** 今天必做几项 / 已完成几项 / 至少要做几项（mode=count 时小于必做数） */
  todayTotal: number;
  todayOk: number;
  todayNeed: number;
  mode: 'all' | 'count';
  dailyCount: number;
  consecutive: boolean;
  met: boolean;
}

/** 一天要做够几项：'all' 就是全做；'count' 是至少 N 项（N 超过必做数时等于全做） */
function needCountOf(total: number, mode: 'all' | 'count', dailyCount: number): number {
  if (total === 0) return 0;
  return mode === 'count' ? Math.min(Math.max(1, dailyCount), total) : total;
}

/**
 * 打卡进度。
 *   done   从「孩子确认开启」那天到今天，一共有多少天达标
 *   streak 其中最长的一段连续达标（连续模式按它判定）
 * 判定：连续模式看 streak，累计模式看 done。
 *
 * notBefore：规则变更日（unix 秒）。家长在商城改了商品的许愿考核标准后，
 *   变更日之后的天数按**新规则**逐天判定；修改前已完成的天数不重判、不丢失 ——
 *   它们在改规则那天用旧规则算好、冻结进 carriedDays。
 * carriedDays：改规则时已挣到的天数（旧规则下的 done/streak）。
 *   最终 done = carriedDays + 变更日起按新规则达标的天数；
 *   连续模式下 carriedDays 作为开头的一段连续（改规则接着做就延续）。
 * asOfAt：判定窗口的右边界（unix 秒，默认 null = 今天）。结转计算传「变更日
 *   前一天」——旧规则只结算到昨天，新规则从变更日当天起算，每天恰好归属
 *   一个规则，改规则当天不会被新旧两套规则重复计数。
 *
 * ⚠️ 还没开始（activated_at 为空，比如「等孩子确认」阶段）也要算出**今天要做什么**——
 *    孩子得先看到「要完成几天、每天几项」才会点同意。
 */
export function progressOf(
  childId: number,
  days: number,
  consecutive: boolean,
  mode: 'all' | 'count',
  dailyCount: number,
  activatedAt: number | null,
  notBeforeAt: number | null = null,
  carriedDays = 0,
  asOfAt: number | null = null
): WishProgress {
  const todayRaw = asOfAt ? new Date(asOfAt * 1000) : new Date();
  const todayDay = new Date(todayRaw.getFullYear(), todayRaw.getMonth(), todayRaw.getDate());
  const tasks = assignedTasks(childId);

  // 审核通过的领取记录一次性取出来（task_id → 期次），后面按天比对
  const approved = new Set<string>();
  if (tasks.length > 0) {
    const ph = tasks.map(() => '?').join(',');
    const rows = getDb().prepare(`
      SELECT task_id, period_key FROM recurring_claims
      WHERE user_id = ? AND status = 'approved' AND task_id IN (${ph})
    `).all(childId, ...tasks.map((t) => t.id)) as { task_id: number; period_key: string }[];
    for (const r of rows) approved.add(`${r.task_id}|${r.period_key}`);
  }

  const todayRequired = requiredOn(tasks, todayDay);
  let todayOk = 0;
  for (const [tid, key] of todayRequired) {
    if (approved.has(`${tid}|${key}`)) todayOk++;
  }

  // ⚠️ base 也要带上 carriedDays：二次改规则同日的场景里，窗口（上次变更日..
  //    本次变更日前一天）可能为空提前返回 —— 已结转的天不能在这个分支里丢掉。
  const base: WishProgress = {
    done: Math.min(carriedDays, 999),
    required: days,
    percent: Math.min(100, Math.round((Math.min(carriedDays, days) / days) * 100)),
    streak: carriedDays,
    todayDone: false,
    todayTotal: todayRequired.size,
    todayOk,
    todayNeed: needCountOf(todayRequired.size, mode, dailyCount),
    mode,
    dailyCount,
    consecutive,
    met: carriedDays >= days,
  };

  if (!activatedAt) return base;
  const startRaw = new Date(activatedAt * 1000);
  let start = new Date(startRaw.getFullYear(), startRaw.getMonth(), startRaw.getDate());
  // 规则变更日：改过规则的（进行中）心愿从这里重新起算，修改前的天数不追溯
  if (notBeforeAt) {
    const rbRaw = new Date(notBeforeAt * 1000);
    const ruleDay = new Date(rbRaw.getFullYear(), rbRaw.getMonth(), rbRaw.getDate());
    if (ruleDay.getTime() > start.getTime()) start = ruleDay;
  }
  if (start.getTime() > todayDay.getTime()) return base;

  // 上限一年：避免家长把天数设得很大时逐天算太久（多出来的天数也没有意义）
  const totalDays = Math.min(400, Math.round((todayDay.getTime() - start.getTime()) / 86400000) + 1);

  let done = carriedDays;
  let best = carriedDays;
  let run = carriedDays;
  let todayDone = false;

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const need = requiredOn(tasks, d);
    let okCount = 0;
    for (const [tid, key] of need) {
      if (approved.has(`${tid}|${key}`)) okCount++;
    }
    // 这天没有必做的事 → 不算缺勤
    const ok = need.size === 0 || okCount >= needCountOf(need.size, mode, dailyCount);
    if (ok) {
      done++;
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
    if (i === totalDays - 1) todayDone = ok;
  }

  const reached = consecutive ? best : done;
  return {
    ...base,
    done: Math.min(done, 999),
    percent: Math.min(100, Math.round((Math.min(reached, days) / days) * 100)),
    streak: best,
    todayDone,
    met: reached >= days,
  };
}

/** 孩子手上「还没结束」的心愿：同一时间只能有这一个（完成后才能许下一个） */
function openWishOf(childId: number): { id: number; name: string; status: string } | undefined {
  return getDb().prepare(`
    SELECT id, name, status FROM wish_items
    WHERE child_id = ? AND status IN ('pending', 'confirming', 'active', 'completed')
    ORDER BY id DESC LIMIT 1
  `).get(childId) as { id: number; name: string; status: string } | undefined;
}

export function registerWishItemsRoutes(app: FastifyInstance) {
  // 列表：孩子看自己的；家长看全家的（带孩子信息，前端按孩子分组滑动）
  app.get('/wish-items', async (req) => {
    const db = getDb();
    const me = req.user!;
    const rows = db.prepare(`
      SELECT w.*, u.name AS child_name, u.avatar AS child_avatar,
        p.name AS product_name, p.cost AS product_cost,
        COALESCE(NULLIF(p.icon, ''), pc.icon, 'gift') AS image
      FROM wish_items w
      JOIN users u ON u.id = w.child_id
      LEFT JOIN products p ON p.id = w.product_id
      LEFT JOIN product_categories pc ON pc.id = p.category_id
      ${me.role === 'parent' ? '' : 'WHERE w.child_id = ?'}
      ORDER BY w.created_at DESC
    `).all(...(me.role === 'parent' ? [] : [me.sub])) as any[];

    const items = rows.map((w) => {
      const progress = progressOf(
        w.child_id, w.days_required, w.require_consecutive === 1,
        (w.mode === 'count' ? 'count' : 'all'), w.daily_count ?? 0, w.activated_at ?? null,
        w.rule_changed_at ?? null, w.carried_days ?? 0
      );
      // 懒同步：天数够了就进入「可领取」，孩子下次刷新就能看到按钮
      if (w.status === 'active' && progress.met) {
        db.prepare("UPDATE wish_items SET status = 'completed' WHERE id = ? AND status = 'active'").run(w.id);
        w.status = 'completed';
      }
      return { ...w, progress, met: progress.met };
    });
    return { items };
  });

  // 孩子：可以许愿的商品 —— 家长在商品上勾了「加入许愿单」的那些。
  //
  // 两种商品都在里面：
  //   · 商城商品（wish_only=0）：一直可许愿，换到了下次还能再许（零食/玩具这类）；
  //   · 「许愿单」分类里的商品（wish_only=1）：商城看不到它，但孩子应该能在许愿单里挑到。
  //     它只出现一次 —— 一旦挂到某个心愿上，就是那个孩子的礼物了，别的孩子不该再来挑。
  app.get('/wish-items/eligible-products', async () => {
    const rows = getDb().prepare(`
      SELECT p.id, p.name, p.cost, p.wish_days, p.wish_consecutive, p.wish_daily_count,
        COALESCE(NULLIF(p.icon, ''), c.icon, 'gift') AS image, c.name AS category_name
      FROM products p
      LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE p.status = 'active' AND p.wish_enabled = 1
        AND (
          p.wish_only = 0
          OR NOT EXISTS (SELECT 1 FROM wish_items w WHERE w.product_id = p.id)
        )
      ORDER BY p.created_at DESC
    `).all();
    return { products: rows };
  });

  // 孩子：许下心愿。二选一：选商城商品（product_id）或自己写（name + 可选描述/图片）
  //
  // 选商城商品 = 天数/标准都是家长发布商品时定好的 → 孩子确认后**直接开始**（不用家长再审）；
  // 自己写 = 等家长通过申请（补价格/分类、定天数）→ 孩子再确认一次才真正开始。
  app.post('/wish-items', async (req, reply) => {
    if (req.user!.role === 'parent') return reply.code(403).send({ error: 'child_only' });
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { product_id, name, description, photo } = parsed.data;

    const db = getDb();
    const childId = req.user!.sub;

    // 一个孩子同时只做一件事：手上的心愿没结束，不能开新的
    const open = openWishOf(childId);
    if (open) return reply.code(409).send({ error: 'wish_in_progress', id: open.id, name: open.name, status: open.status });

    let finalName = name?.trim() ?? '';
    let finalPhoto = photo ?? '';
    let productId: number | null = null;
    let days = 7;
    let consecutive = false;
    let mode: 'all' | 'count' = 'all';
    let dailyCount = 0;

    if (product_id) {
      const p = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'active'").get(product_id) as any;
      if (!p) return reply.code(404).send({ error: 'product_not_found' });
      if (p.wish_enabled !== 1) return reply.code(400).send({ error: 'wish_not_allowed' });
      // 「许愿单」分类里的礼物是一次性的：一旦挂到某个心愿上就是那个孩子的了，
      // 别人不能再许（与 GET /wish-items/eligible-products 的过滤口径保持一致）。
      // 商城里的普通商品不受这条限制 —— 换到了下次还能许。
      if (p.wish_only === 1) {
        const taken = db.prepare('SELECT id FROM wish_items WHERE product_id = ? LIMIT 1').get(p.id) as
          | { id: number }
          | undefined;
        if (taken) return reply.code(409).send({ error: 'wish_taken' });
      }
      productId = p.id;
      finalName = p.name;
      finalPhoto = p.icon ?? '';
      days = p.wish_days ?? 7;
      consecutive = p.wish_consecutive === 1;
      dailyCount = p.wish_daily_count ?? 0;
      mode = dailyCount > 0 ? 'count' : 'all';
    } else if (!finalName) {
      return reply.code(400).send({ error: 'name_required' });
    }

    // 同一个心愿没完成前不能重复许（避免刷一堆一模一样的卡片）
    const dup = db.prepare(`
      SELECT id FROM wish_items
      WHERE child_id = ? AND status IN ('pending', 'confirming', 'active', 'completed') AND name = ?
    `).get(childId, finalName) as { id: number } | undefined;
    if (dup) return reply.code(409).send({ error: 'duplicate_wish', id: dup.id });

    const started = productId != null;
    const r = db.prepare(`
      INSERT INTO wish_items (child_id, product_id, name, description, photo,
        days_required, require_consecutive, mode, daily_count, status, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      childId, productId, finalName, description ?? null, finalPhoto,
      days, consecutive ? 1 : 0, mode, dailyCount,
      started ? 'active' : 'pending',
      started ? Math.floor(Date.now() / 1000) : null
    );
    const id = Number(r.lastInsertRowid);

    if (!started) {
      pushToParents({
        type: 'new_wish',
        wishId: id,
        childId,
        childName: (db.prepare('SELECT name FROM users WHERE id = ?').get(childId) as any)?.name,
        wishName: finalName,
      });
    }
    return { id, started };
  });

  // 家长：通过申请（改礼物信息 → 定天数 + 考核标准 → 交给孩子确认）
  app.patch('/wish-items/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const parsed = configureSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const cfg = parsed.data;
    const db = getDb();

    const wish = db.prepare('SELECT * FROM wish_items WHERE id = ?').get(id) as any;
    if (!wish) return reply.code(404).send({ error: 'not_found' });
    // pending = 第一次通过申请；confirming = 孩子点了「不同意」，家长改完再通过一次
    if (wish.status !== 'pending' && wish.status !== 'confirming') {
      return reply.code(409).send({ error: 'already_started' });
    }

    // 心愿来自商城商品（product_id 有值）时，商品本身在商城已经存在，
    // 这里的改名/换图只作用于这张心愿卡，不去改家长发布的那件商品。
    const fromShop = wish.product_id != null;

    const name = (cfg.name?.trim() || wish.name).slice(0, 30);
    const description = cfg.description !== undefined ? cfg.description.trim() || null : wish.description ?? null;
    const photo = cfg.photo !== undefined ? cfg.photo : (wish.photo ?? '');
    const dailyCount = cfg.mode === 'count' ? cfg.daily_count : 0;

    try {
      let newProductId: number | null = wish.product_id ?? null;
      const txn = db.transaction(() => {
        // ① 孩子自己写的商品 → 现在才建商品（名字/图片/价格/分类都用家长改过的）
        if (!fromShop) {
          let catId: number | null = null;
          let wishOnly = 0;
          if (cfg.add_to_shop) {
            // 家长选了分类就用它；没选就留空（商城里的「未分类」）
            if (cfg.category_id) {
              const found = db.prepare('SELECT id FROM product_categories WHERE id = ?').get(cfg.category_id);
              if (found) catId = cfg.category_id;
            }
          } else {
            // 「许愿单」分类：隐藏，孩子端商城筛选条和商品列表都看不到
            catId = ensureWishCategory();
            wishOnly = 1;
          }
          const pr = db.prepare(`
            INSERT INTO products (name, cost, stock, icon, category_id, wish_enabled, wish_days, wish_consecutive, wish_daily_count, wish_only, status)
            VALUES (?, ?, -1, ?, ?, 1, ?, ?, ?, ?, 'active')
          `).run(name, cfg.cost, photo, catId, cfg.days, cfg.consecutive ? 1 : 0, dailyCount, wishOnly);
          newProductId = Number(pr.lastInsertRowid);
        }

        db.prepare(`
          UPDATE wish_items
          SET product_id = ?, name = ?, description = ?, photo = ?,
              days_required = ?, require_consecutive = ?, mode = ?, daily_count = ?,
              status = 'confirming', activated_at = NULL, rule_changed_at = NULL, carried_days = 0
          WHERE id = ?
        `).run(newProductId, name, description, photo, cfg.days, cfg.consecutive ? 1 : 0,
          cfg.mode, dailyCount, id);
      });
      txn();

      pushToUser(wish.child_id, { type: 'wish_confirm', wishId: id, wishName: name });
      pushToAll({ type: 'products_changed', action: 'wish_configured' });
      return { ok: true, productId: newProductId };
    } catch (e: any) {
      req.log.error(e);
      return reply.code(500).send({ error: 'configure_failed' });
    }
  });

  // 孩子：同意开启 / 不同意退回家长
  app.post('/wish-items/:id/confirm', async (req, reply) => {
    if (req.user!.role === 'parent') return reply.code(403).send({ error: 'child_only' });
    const id = Number((req.params as any).id);
    const db = getDb();
    const childId = req.user!.sub;
    const wish = db.prepare('SELECT * FROM wish_items WHERE id = ? AND child_id = ?').get(id, childId) as any;
    if (!wish) return reply.code(404).send({ error: 'not_found' });
    if (wish.status !== 'confirming') return reply.code(409).send({ error: 'not_waiting_confirm' });

    const open = openWishOf(childId);
    if (open && open.id !== id) {
      return reply.code(409).send({ error: 'wish_in_progress', id: open.id, name: open.name, status: open.status });
    }

    db.prepare("UPDATE wish_items SET status = 'active', activated_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), id);
    pushToParents({ type: 'wish_accepted', wishId: id, childId, wishName: wish.name });
    return { ok: true };
  });

  // 孩子：不同意 → 退回给家长改
  app.post('/wish-items/:id/decline', async (req, reply) => {
    if (req.user!.role === 'parent') return reply.code(403).send({ error: 'child_only' });
    const id = Number((req.params as any).id);
    const db = getDb();
    const wish = db.prepare('SELECT * FROM wish_items WHERE id = ? AND child_id = ?').get(id, req.user!.sub) as any;
    if (!wish) return reply.code(404).send({ error: 'not_found' });
    if (wish.status !== 'confirming') return reply.code(409).send({ error: 'not_waiting_confirm' });

    db.prepare("UPDATE wish_items SET status = 'pending', activated_at = NULL WHERE id = ?").run(id);
    pushToParents({ type: 'wish_declined', wishId: id, childId: wish.child_id, wishName: wish.name });
    return { ok: true };
  });

  // 孩子：放弃「进行中」的心愿（2026-10-19 用户要求：孩子端左滑 → 放弃）
  //
  // ── 为什么置为 cancelled 而不是 DELETE ────────────────────────────
  //   ① 家长那边要能看出「这个心愿是孩子自己放弃的」，不是系统丢了；
  //   ② 打卡进度是按天实时算出来的（不落库），但「哪天开始做的」只有
  //      activated_at 记着 —— 删了这条，孩子事后说「我明明做够了」就无从核对。
  //   ③ 删掉之后 openWishOf 也会放开（cancelled 不在进行中集合里），
  //      所以功能上等价，但留证据更好。
  //
  // ── 只允许 active ────────────────────────────────────────────────
  //   pending/confirming 的出口是「不同意」（退回家长改），completed 是「领取」，
  //   都已存在。这里只补「已经开始了、但孩子不想做了」这一种情况。
  app.post('/wish-items/:id/abandon', async (req, reply) => {
    if (req.user!.role === 'parent') return reply.code(403).send({ error: 'child_only' });
    const id = Number((req.params as any).id);
    const db = getDb();
    const wish = db.prepare('SELECT * FROM wish_items WHERE id = ? AND child_id = ?').get(id, req.user!.sub) as any;
    if (!wish) return reply.code(404).send({ error: 'not_found' });
    if (wish.status !== 'active') return reply.code(409).send({ error: 'not_active' });

    // 带 status 条件的 UPDATE：连点两下时第二次 changes=0，不会覆盖别的新状态
    const r = db.prepare("UPDATE wish_items SET status = 'cancelled' WHERE id = ? AND status = 'active'").run(id);
    if (r.changes === 0) return reply.code(409).send({ error: 'not_active' });

    pushToParents({ type: 'wish_abandoned', wishId: id, childId: wish.child_id, wishName: wish.name });
    return { ok: true };
  });

  // 孩子：领取礼物（达标后）→ 直接到手，不再走家长审核
  app.post('/wish-items/:id/claim', async (req, reply) => {
    if (req.user!.role === 'parent') return reply.code(403).send({ error: 'child_only' });
    const id = Number((req.params as any).id);
    const db = getDb();
    const wish = db.prepare('SELECT * FROM wish_items WHERE id = ? AND child_id = ?').get(id, req.user!.sub) as any;
    if (!wish) return reply.code(404).send({ error: 'not_found' });
    if (!wish.product_id) return reply.code(409).send({ error: 'not_configured' });
    if (wish.status === 'claimed') return reply.code(409).send({ error: 'already_claimed' });

    const progress = progressOf(
      wish.child_id, wish.days_required, wish.require_consecutive === 1,
      (wish.mode === 'count' ? 'count' : 'all'), wish.daily_count ?? 0, wish.activated_at ?? null,
      wish.rule_changed_at ?? null, wish.carried_days ?? 0
    );
    if (!progress.met) return reply.code(409).send({ error: 'not_completed' });

    let exchangeId = 0;
    try {
      const txn = db.transaction(() => {
        // 0 积分、状态直接 approved：礼物是每天把任务做够挣来的，家长不需要再点一次通过，
        // 但「兑换记录」里照样留一条，孩子能在商城页看到自己拿到过什么。
        const now = Math.floor(Date.now() / 1000);
        const r = db.prepare(`
          INSERT INTO exchange_requests (user_id, type, product_id, points, amount, quantity, wish_id, status, reviewed_at)
          VALUES (?, 'product', ?, 0, 0, 1, ?, 'approved', ?)
        `).run(wish.child_id, wish.product_id, id, now);
        exchangeId = Number(r.lastInsertRowid);
        db.prepare('UPDATE wish_items SET status = ?, exchange_id = ?, claimed_at = ? WHERE id = ?')
          .run('claimed', exchangeId, now, id);
        db.prepare(`
          INSERT INTO point_logs (user_id, delta, source, ref_id, note, created_by, created_at)
          VALUES (?, 0, 'exchange', ?, ?, NULL, ?)
        `).run(wish.child_id, exchangeId, `许愿礼物：${wish.name}`, now);
        // 库存照样要减（不限库存的 -1 不动）
        db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ? AND stock >= 1').run(wish.product_id);
      });
      txn();
    } catch (e: any) {
      req.log.error(e);
      return reply.code(500).send({ error: 'claim_failed' });
    }

    pushToParents({
      type: 'wish_claimed',
      wishId: id,
      requestId: exchangeId,
      userId: wish.child_id,
      userName: (db.prepare('SELECT name FROM users WHERE id = ?').get(wish.child_id) as any)?.name,
      wishName: wish.name,
    });
    return { ok: true, exchangeId };
  });

  // 撤销：孩子只能撤还没开始做的（pending / confirming）；家长可以删任何一条
  app.delete('/wish-items/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const me = req.user!;
    const db = getDb();
    if (me.role === 'parent') {
      const r = db.prepare('DELETE FROM wish_items WHERE id = ?').run(id);
      if (r.changes === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    }
    const r = db.prepare(
      "DELETE FROM wish_items WHERE id = ? AND child_id = ? AND status IN ('pending', 'confirming')"
    ).run(id, me.sub);
    if (r.changes === 0) return reply.code(409).send({ error: 'not_cancellable' });
    return { ok: true };
  });
}

/**
 * 「许愿单」隐藏分类：不存在就建一个，返回 id（不进孩子端商城）。
 * 家长端商品编辑器也要能选它（选了就等于「只给许愿单领取」），
 * 所以分类列表接口也会调用一次，保证这个分类永远存在。
 */
export function ensureWishCategory(): number {
  const db = getDb();
  const found = db.prepare('SELECT id FROM product_categories WHERE name = ? AND hidden = 1').get(CATEGORY_NAME) as { id: number } | undefined;
  if (found) return found.id;
  const sort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM product_categories').get() as { n: number };
  const cr = db.prepare('INSERT INTO product_categories (name, icon, color, sort_order, hidden) VALUES (?, ?, ?, ?, 1)')
    .run(CATEGORY_NAME, 'gift', '#e8b4c8', sort.n);
  return Number(cr.lastInsertRowid);
}
