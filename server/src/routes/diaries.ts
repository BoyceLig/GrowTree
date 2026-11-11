import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { pushToUser, pushToParents } from '../ws.js';

// ─────────────────────────────────────────────────────────────────────────────
// 成长日记（家长写，孩子看）
//
// 与 growth_records 分开的原因见 schema.sql：曲线记的是「量出来的数」，
// 日记记的是「发生的事」，后者允许同一天写多篇、可以没有数字、带图片视频。
//
// 筛选三个维度（对应家长端页面上的三个控件）：
//   孩子 —— child_id（家长可传，不传=全部孩子合并；孩子端一律强制为自己）
//   时间 —— from / to，比较的是 diary_date（家长手填的发生日期），不是 created_at
//   关键字 —— q，匹配标题或正文
// ─────────────────────────────────────────────────────────────────────────────

/** 附件只能是本站上传出来的路径：不接受外链，避免页面里出现家长填的任意 URL。
 *  允许一层子目录（/uploads/f<家庭id>/<文件名>）—— 上传收编会按家庭归档，
 *  旧正则只认单层文件名，把多租户布局下所有新上传的合法附件全拒了。
 *  负向先行断言拦掉 ..，防止路径穿越。 */
const MEDIA_URL = /^\/uploads\/(?!.*\.\.)[\w./-]+$/;

const mediaSchema = z
  .array(
    z.object({
      type: z.enum(['image', 'video']),
      url: z.string().regex(MEDIA_URL, '附件路径非法'),
    })
  )
  .max(9, '一篇日记最多 9 个附件');

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD');

const createSchema = z.object({
  user_id: z.number().int().positive().optional(),
  diary_date: dateStr,
  title: z.string().trim().max(60, '标题最多 60 字').nullable().optional(),
  content: z.string().trim().max(2000, '正文最多 2000 字').nullable().optional(),
  media: mediaSchema.optional(),
});

const updateSchema = z.object({
  diary_date: dateStr.optional(),
  title: z.string().trim().max(60).nullable().optional(),
  content: z.string().trim().max(2000).nullable().optional(),
  media: mediaSchema.optional(),
});

interface DiaryRow {
  id: number;
  user_id: number;
  diary_date: string;
  title: string | null;
  content: string | null;
  media: string | null;
  created_by: number | null;
  created_at: number;
  updated_at: number | null;
  child_name: string | null;
  child_avatar: string | null;
  creator_name: string | null;
  /** 'parent' = 家长写的，'child' = 孩子自己写的（created_by 就是孩子本人） */
  author_role: 'parent' | 'child';
}

/** media 列存的是 JSON 文本；历史/手改数据坏掉时退化为空数组，不让整页 500 */
function parseMedia(raw: string | null): Array<{ type: 'image' | 'video'; url: string }> {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (m) => m && (m.type === 'image' || m.type === 'video') && typeof m.url === 'string' && MEDIA_URL.test(m.url)
    );
  } catch {
    return [];
  }
}

function toDiary(r: DiaryRow) {
  return {
    id: r.id,
    user_id: r.user_id,
    child_name: r.child_name,
    child_avatar: r.child_avatar,
    diary_date: r.diary_date,
    title: r.title,
    content: r.content,
    media: parseMedia(r.media),
    creator_name: r.creator_name,
    author_role: r.author_role,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * 「谁写的」不用单独存列：孩子自己写的时候 created_by 就是孩子本人，
 * 家长代写的时候 created_by 是家长。一个 CASE 就能判断，
 * 再加一列 author_role 只会多一个可能与事实不一致的字段。
 */
const SELECT_BASE = `
  SELECT d.*, u.name AS child_name, u.avatar AS child_avatar, p.name AS creator_name,
         CASE WHEN d.created_by = d.user_id THEN 'child' ELSE 'parent' END AS author_role
  FROM growth_diaries d
  LEFT JOIN users u ON u.id = d.user_id
  LEFT JOIN users p ON p.id = d.created_by
`;

/** LIKE 的通配符要转义，否则家长搜一个 "%" 就会命中全部日记 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function registerDiaryRoutes(app: FastifyInstance) {
  // 列表 / 筛选（家长看任意孩子，孩子只看自己）
  app.get('/growth/diaries', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const q = req.query as Record<string, string | undefined>;
    const db = getDb();

    const where: string[] = [];
    const params: Array<string | number> = [];

    if (req.user.role === 'child') {
      // 家长可以按孩子关掉「成长日记可见」。关掉之后**家长写的**一条都不下发 ——
      // 不能只是前端把区域藏起来：孩子端拿着自己的 token 直接打这个接口，
      // 照样能拿到全部日记，那这个开关就只是块遮羞布。
      const me = db
        .prepare("SELECT diary_visible FROM users WHERE id = ? AND role = 'child'")
        .get(req.user.sub) as { diary_visible: number } | undefined;
      const gateOpen = !me || me.diary_visible !== 0;

      where.push('d.user_id = ?');
      params.push(req.user.sub);

      if (req.user.act !== undefined) {
        // 家长「切到孩子视角」→ 这个 token 的 sub 是孩子、act 是家长。
        // 这种会话一律看不到孩子自己写的日记：那是孩子的私人日记本，
        // 家长代看只能看到「家长写给孩子看的那部分」。
        if (!gateOpen) return { diaries: [], visible: false, actAs: true };
        where.push('d.created_by <> d.user_id');
      } else if (!gateOpen) {
        // 家长关掉可见：孩子仍然看得见自己写的，只是看不到家长写的
        where.push('d.created_by = d.user_id');
      }

      // ?source=parent|child —— 孩子端「只看家长写的 / 只看自己写的」筛选
      if (q.source === 'child') where.push('d.created_by = d.user_id');
      else if (q.source === 'parent') where.push('d.created_by <> d.user_id');
    } else if (q.child_id) {
      const cid = Number(q.child_id);
      if (!Number.isInteger(cid) || cid <= 0) return reply.code(400).send({ error: 'invalid_input' });
      where.push('d.user_id = ?');
      params.push(cid);
    }

    // 家长视角也看不到孩子自己写的日记（2026-10-17 用户要求）。
    // 需求原话只说「切到孩子视角时看不到」，但孩子的日记本本来就是私密的 ——
    // 只在 act-as 那一路挡住，家长在自己视角里照样能翻到，等于没挡。
    // 所以两边一致：孩子写的只属于孩子，家长能看到的是「家长写给孩子看的那部分」。
    if (req.user.role !== 'child') {
      where.push('d.created_by <> d.user_id');
    }

    if (q.from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from)) return reply.code(400).send({ error: 'invalid_input' });
      where.push('d.diary_date >= ?');
      params.push(q.from);
    }
    if (q.to) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q.to)) return reply.code(400).send({ error: 'invalid_input' });
      where.push('d.diary_date <= ?');
      params.push(q.to);
    }
    if (q.q && q.q.trim()) {
      const like = `%${escapeLike(q.q.trim())}%`;
      where.push("(d.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }

    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);
    const sql = `${SELECT_BASE}${where.length ? ' WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.diary_date DESC, d.id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit) as DiaryRow[];

    return { diaries: rows.map(toDiary), visible: true };
  });

  // 写一篇（家长 → 指定孩子；孩子 → 只能写自己的）
  app.post('/growth/diaries', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.issues[0]?.message });
    }
    const isChild = req.user.role === 'child';

    // 家长切到孩子视角时不能「以孩子名义」写日记：
    // 那条日记会被认成孩子写的，家长自己反而看不到（孩子日记不对家长开放），
    // 结果就是一个把自己绕进去的坑。想写就切回家长视角。
    if (isChild && req.user.act !== undefined) {
      return reply.code(403).send({ error: 'act_as_readonly', message: '切回家长视角才能写日记' });
    }

    const user_id = isChild ? req.user.sub : parsed.data.user_id;
    if (!user_id) return reply.code(400).send({ error: 'invalid_input', message: '请选择孩子' });
    const { diary_date, title, content, media } = parsed.data;
    const db = getDb();

    const child = db
      .prepare("SELECT id FROM users WHERE id = ? AND role = 'child'")
      .get(user_id) as { id: number } | undefined;
    if (!child) return reply.code(404).send({ error: 'not_found' });

    const text = content?.trim() || null;
    const head = title?.trim() || null;
    const files = media ?? [];
    // 允许「只发一张照片」：正文、标题、附件不能三者皆空，否则时间轴上会出现一条空白卡片
    if (!text && !head && files.length === 0) {
      return reply.code(400).send({ error: 'empty_diary', message: '写点什么，或者传张照片吧' });
    }

    const res = db
      .prepare(
        `INSERT INTO growth_diaries (user_id, diary_date, title, content, media, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(user_id, diary_date, head, text, files.length ? JSON.stringify(files) : null, req.user!.sub);
    const id = Number(res.lastInsertRowid);

    const row = db.prepare(`${SELECT_BASE} WHERE d.id = ?`).get(id) as DiaryRow;
    notify(user_id, 'created', id);
    return { ok: true, diary: toDiary(row) };
  });

  // 编辑（家长改任意一篇；孩子只能改自己写的）
  app.patch('/growth/diaries/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const id = Number((req.params as any).id);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.issues[0]?.message });
    }
    const db = getDb();
    const row = db.prepare('SELECT user_id, created_by FROM growth_diaries WHERE id = ?').get(id) as
      | { user_id: number; created_by: number | null }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // 孩子只能动自己写的那几篇：家长写给他看的内容不允许被改（记录的所有权在写的人手里）。
    // act-as 的 token 也要挡（role 是 child 但背后是家长在翻看）——
    // 家长连看都看不到孩子的日记，自然也不该能改它。
    if (req.user.role === 'child' && (req.user.act !== undefined || row.created_by !== req.user.sub || row.user_id !== req.user.sub)) {
      return reply.code(403).send({ error: 'forbidden', message: '只能修改自己写的日记' });
    }

    const d = parsed.data;
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (d.diary_date !== undefined) { sets.push('diary_date = ?'); params.push(d.diary_date); }
    if (d.title !== undefined) { sets.push('title = ?'); params.push(d.title?.trim() || null); }
    if (d.content !== undefined) { sets.push('content = ?'); params.push(d.content?.trim() || null); }
    if (d.media !== undefined) {
      sets.push('media = ?');
      params.push(d.media.length ? JSON.stringify(d.media) : null);
    }
    if (!sets.length) return { ok: true };

    sets.push('updated_at = unixepoch()');
    params.push(id);
    db.prepare(`UPDATE growth_diaries SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare(`${SELECT_BASE} WHERE d.id = ?`).get(id) as DiaryRow;
    notify(row.user_id, 'updated', id);
    return { ok: true, diary: toDiary(updated) };
  });

  // 删除（家长删任意一篇；孩子只能删自己写的）
  app.delete('/growth/diaries/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const id = Number((req.params as any).id);
    const db = getDb();
    const row = db.prepare('SELECT user_id, created_by FROM growth_diaries WHERE id = ?').get(id) as
      | { user_id: number; created_by: number | null }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (req.user.role === 'child' && (req.user.act !== undefined || row.created_by !== req.user.sub || row.user_id !== req.user.sub)) {
      return reply.code(403).send({ error: 'forbidden', message: '只能删除自己写的日记' });
    }

    db.prepare('DELETE FROM growth_diaries WHERE id = ?').run(id);
    // 附件文件留在 uploads/ 下不删：可能被其它日记/商品共用，
    // 孤儿文件的代价（一点磁盘）远小于误删别人在用的图。
    notify(row.user_id, 'deleted', id);
    return { ok: true };
  });
}

/** 日记有变动（新建/编辑/删除）→ 该孩子与所有家长都静默重拉。
 *  额外带上 visible：孩子端被家长关掉可见时不该再弹「爸爸妈妈写了一篇新日记」——
 *  弹了等于告诉孩子"有你看不到的东西"，开关的意义就没了。 */
function notify(childId: number, action: 'created' | 'updated' | 'deleted', diaryId: number): void {
  const db = getDb();
  const me = db
    .prepare("SELECT diary_visible FROM users WHERE id = ? AND role = 'child'")
    .get(childId) as { diary_visible: number } | undefined;
  const visible = !me || me.diary_visible !== 0;
  // 孩子自己写的那几篇对家长不可见，也就不该推给家长 ——
  // 推过去只会变成一个「有新日记」的红点，点开却什么都没有。
  const row = db.prepare('SELECT user_id, created_by FROM growth_diaries WHERE id = ?').get(diaryId) as
    | { user_id: number; created_by: number | null }
    | undefined;
  const byChild = !row || row.created_by === row.user_id;
  const msg = { type: 'diary_changed', action, childId, diaryId, visible, byChild };
  pushToUser(childId, msg);
  if (!byChild) pushToParents(msg);
}
