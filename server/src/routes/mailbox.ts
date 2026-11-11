import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';
import { pushToUser, pushToParents } from '../ws.js';

// ─────────────────────────────────────────────────────────────────────────────
// 树洞信箱（家长 ⇄ 孩子 互相留言）
//
// 一条对话线 = (孩子, 家长) 这一对，两个字段各管一头：
//   child_id  —— 这条对话属于哪个孩子（家长有多个孩子时，各自的消息互不可见；
//                树洞是私密的，这也是它存在消息行上的原因，而不是"家庭一条大群聊"）
//   parent_id —— 对面是哪个家长（2026-10-20 用户要求：孩子可以选「这话说给谁听」）
//
// parent_id IS NULL 是一个**有语义的真值**，不是缺失数据：
//   · 本列上线前的历史消息（那时还没有"哪个家长"这个概念）
//   · 孩子在「席位到期」页点「提醒爸爸妈妈」发的那句求助（确实是想让全家看到）
//   两端都把它当作"每位家长都能看"，未读数则按 sender 归属，
//   否则同一条会在这家两位家长名下各算一次未读。
//
// 已读分两个方向存储（read_by_child / read_by_parent），因为一条消息对
// "发的人"天然就是已读的，需要跟踪的只有"收的人"；但两端都可能开着页面，
// 所以不能共用一个 read 字段。
// ─────────────────────────────────────────────────────────────────────────────

const sendSchema = z.object({
  child_id: z.number().int().positive().optional(),
  /** 孩子专用：这句话说给哪位家长听。不传 = 发给全家（旧版客户端 / 到期页求助） */
  parent_id: z.number().int().positive().optional(),
  content: z.string().trim().min(1, '说点什么吧').max(500, '最多 500 字'),
});

interface ThreadRow {
  peer_id: number;
  peer_name: string;
  peer_avatar: string | null;
  last_content: string | null;
  last_at: number | null;
  last_sender_role: 'parent' | 'child' | null;
  unread: number;
}

interface MessageRow {
  id: number;
  child_id: number;
  parent_id: number | null;
  sender_id: number;
  sender_role: 'parent' | 'child';
  content: string;
  read_by_child: number;
  read_by_parent: number;
  created_at: number;
  sender_name: string | null;
}

function toMessage(m: MessageRow) {
  return {
    id: m.id,
    child_id: m.child_id,
    parent_id: m.parent_id,
    sender_id: m.sender_id,
    sender_role: m.sender_role,
    sender_name: m.sender_name,
    content: m.content,
    created_at: m.created_at,
  };
}

/** 这套 SQL 里重复出现三次的「全家可见」条件，写成一个常量免得漏一处 */
const BROADCAST = 'parent_id IS NULL';

export function registerMailboxRoutes(app: FastifyInstance) {
  // 会话摘要
  //
  // 两端列的**是不同的人**，同一个接口两种形态：
  //   孩子 → 家里每一位家长（头像 + 名字 + 未读），点谁就跟谁说话
  //   家长 → 家里每一个孩子（和以前一样）
  // 只多了一个 parent_id 维度，两边的 SQL 形状一致：都是「对面那个人 + 我和他的最后一条 + 未读数」。
  app.get('/mailbox/threads', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const db = getDb();
    const isChild = req.user.role === 'child';
    const me = req.user.sub;

    // 未读只数「对方发给我、我还没看」的：孩子数家长发的，家长数孩子发的
    const sql = isChild
      ? `SELECT u.id AS peer_id, u.name AS peer_name, u.avatar AS peer_avatar,
                m.content AS last_content, m.created_at AS last_at, m.sender_role AS last_sender_role,
                (SELECT COUNT(*) FROM mailbox_messages x
                  WHERE x.child_id = ? AND x.read_by_child = 0 AND x.sender_role = 'parent'
                    AND (x.parent_id = u.id OR (x.${BROADCAST} AND x.sender_id = u.id))) AS unread
           FROM users u
           LEFT JOIN mailbox_messages m
             ON m.id = (SELECT MAX(y.id) FROM mailbox_messages y
                         WHERE y.child_id = ? AND (y.parent_id = u.id OR y.${BROADCAST}))
          WHERE u.role = 'parent'
          ORDER BY u.id ASC`
      : `SELECT u.id AS peer_id, u.name AS peer_name, u.avatar AS peer_avatar,
                m.content AS last_content, m.created_at AS last_at, m.sender_role AS last_sender_role,
                (SELECT COUNT(*) FROM mailbox_messages x
                  WHERE x.child_id = u.id AND x.read_by_parent = 0 AND x.sender_role = 'child'
                    AND (x.parent_id = ? OR x.${BROADCAST})) AS unread
           FROM users u
           LEFT JOIN mailbox_messages m
             ON m.id = (SELECT MAX(y.id) FROM mailbox_messages y
                         WHERE y.child_id = u.id AND (y.parent_id = ? OR y.${BROADCAST}))
          WHERE u.role = 'child'
          ORDER BY u.id ASC`;

    const rows = db.prepare(sql).all(me, me) as ThreadRow[];
    const threads = rows.map((r) => ({
      peer_id: r.peer_id,
      peer_name: r.peer_name,
      peer_avatar: r.peer_avatar,
      // 自建版 web 的树洞组件（web/src/components/TreeHoleBox.vue）读的是 child_* 这三个字段。
      // 家长视角下"对面那个人"本来就是孩子，所以两者同值、直接并存；
      // 孩子视角用不到它们（web 没有孩子端），留着也不影响。
      child_id: r.peer_id,
      child_name: r.peer_name,
      child_avatar: r.peer_avatar,
      last_content: r.last_content,
      last_at: r.last_at,
      last_sender_role: r.last_sender_role,
      unread: r.unread,
    }));

    return { threads, unreadTotal: threads.reduce((s, t) => s + t.unread, 0) };
  });

  // 某条对话的消息列表（升序，老的在前）
  //
  // 读取即已读：这里不是纯查询——打开对话就代表看过了，把标记放在同一个请求里
  // 可以省掉一次往返，也不会出现「消息已显示但角标还挂着」的中间态。
  // 家长端首页只调 /threads（不动已读），所以不会出现"没点开也变成已读"。
  app.get('/mailbox/messages', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const q = req.query as Record<string, string | undefined>;
    const db = getDb();
    const isChild = req.user.role === 'child';
    const me = req.user.sub;

    // 孩子认 parent_id（和谁说话），家长认 child_id（和哪个孩子说话）
    const peerId = Number(isChild ? q.parent_id : q.child_id);
    const scoped = Number.isInteger(peerId) && peerId > 0;

    const childId = isChild ? me : peerId;
    if (!Number.isInteger(childId) || childId <= 0) {
      return reply.code(400).send({ error: 'invalid_input', message: '缺少 child_id' });
    }
    if (!isChild) {
      const ok = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'child'").get(childId);
      if (!ok) return reply.code(404).send({ error: 'not_found' });
    }
    if (isChild && scoped) {
      const ok = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'parent'").get(peerId);
      if (!ok) return reply.code(404).send({ error: 'not_found', message: '没有这位家长' });
    }

    // 一旦指定了对面是谁，就只看「我和他之间」的消息 + 发给全家的那些。
    // 没指定（旧版客户端）退回整条孩子线的老行为，不至于白屏。
    // ⚠️ 过滤值两端不一样：孩子按「选中的那位家长」，家长按「我自己」——
    //    家长的对面是孩子，用 peerId（孩子 id）去比 parent_id 会一条都读不到。
    const peerWhere = scoped ? ` AND (parent_id = ? OR ${BROADCAST})` : '';
    const peerArgs = scoped ? [isChild ? peerId : me] : [];

    // 取最新 limit 条，再翻回升序 —— 直接 ORDER BY id ASC LIMIT 会拿到最老的一批
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);
    const rows = db
      .prepare(
        `SELECT m.*, u.name AS sender_name
         FROM mailbox_messages m
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.child_id = ?${peerWhere}
         ORDER BY m.id DESC LIMIT ?`
      )
      .all(...([childId, ...peerArgs, limit] as number[])) as MessageRow[];
    rows.reverse();

    if (isChild) {
      db.prepare(
        `UPDATE mailbox_messages SET read_by_child = 1
          WHERE child_id = ? AND sender_role = 'parent' AND read_by_child = 0${peerWhere}`
      ).run(...([childId, ...peerArgs] as number[]));
    } else {
      // 家长：只把自己这一侧的对话标成已读 —— 别把「孩子写给他妈的悄悄话」也算成自己看过
      db.prepare(
        `UPDATE mailbox_messages SET read_by_parent = 1
          WHERE child_id = ? AND sender_role = 'child' AND read_by_parent = 0
            AND (parent_id = ? OR ${BROADCAST})`
      ).run(childId, me);
    }

    return { messages: rows.map(toMessage) };
  });

  // 发一条留言（两端都能发）
  app.post('/mailbox/messages', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.issues[0]?.message });
    }
    const db = getDb();
    const isChild = req.user.role === 'child';
    const childId = isChild ? req.user.sub : Number(parsed.data.child_id);
    if (!Number.isInteger(childId) || childId <= 0) {
      return reply.code(400).send({ error: 'invalid_input', message: '请选择要发给哪个小朋友' });
    }
    const child = db
      .prepare("SELECT id, family_id FROM users WHERE id = ? AND role = 'child'")
      .get(childId) as { id: number; family_id: number } | undefined;
    if (!child) return reply.code(404).send({ error: 'not_found' });

    // 收件家长：
    //   孩子发 —— 由他自己选；不选 = 发给全家（到期页那句求助就是这个用法）
    //   家长发 —— 收件人就是发件人自己：这条对话的"对面"是「我」，
    //             孩子会在"和我"的那一条线里看到它，另一位家长看不到
    let parentId: number | null = req.user.sub;
    if (isChild) {
      parentId = parsed.data.parent_id != null ? Number(parsed.data.parent_id) : null;
      if (parentId !== null) {
        const p = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'parent'").get(parentId);
        if (!p) return reply.code(404).send({ error: 'not_found', message: '没有这位家长' });
      }
    }

    // 自己发的对自己当然已读：把己方那道标记直接置 1，只有对方的留在未读
    const res = db
      .prepare(
        `INSERT INTO mailbox_messages (child_id, parent_id, sender_id, sender_role, content, read_by_child, read_by_parent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        childId,
        parentId,
        req.user.sub,
        req.user.role,
        parsed.data.content,
        isChild ? 1 : 0,
        isChild ? 0 : 1
      );
    const id = Number(res.lastInsertRowid);
    const row = db
      .prepare(
        `SELECT m.*, u.name AS sender_name FROM mailbox_messages m
         LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
      )
      .get(id) as MessageRow;

    const msg = {
      type: 'mailbox_message',
      childId,
      parentId,
      messageId: id,
      senderId: req.user.sub,
      senderRole: req.user.role,
      content: parsed.data.content,
      createdAt: row.created_at,
    };
    pushToUser(childId, msg);   // 孩子端（含其它设备）
    pushToParents(msg);         // 家长端（含其它家长/设备）

    return { ok: true, message: toMessage(row) };
  });

  // 手动标记已读（家长端「全部已读」用；孩子端打开对话时由 GET 自动标记）
  app.post('/mailbox/read', { preHandler: requireParent }, async (req, reply) => {
    const childId = Number((req.body as any)?.child_id);
    if (!Number.isInteger(childId) || childId <= 0) return reply.code(400).send({ error: 'invalid_input' });
    getDb()
      .prepare(
        `UPDATE mailbox_messages SET read_by_parent = 1
          WHERE child_id = ? AND sender_role = 'child' AND read_by_parent = 0
            AND (parent_id = ? OR ${BROADCAST})`
      )
      .run(childId, req.user!.sub);
    return { ok: true };
  });
}
