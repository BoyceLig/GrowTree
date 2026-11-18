import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { pushToUser } from '../ws.js';

/**
 * 悄悄话：家长与孩子之间的一对一私密会话。
 *
 * 会话边界是 (child_id, parent_id) —— 每位家长和每个孩子各有一条，
 * 只有这两个人能读写；家里其他家长看不到列表，也读不到消息。
 * 树洞信箱是家庭群聊，两者数据表分开，互不影响。
 */

const sendSchema = z.object({
  child_id: z.number().int().positive().optional(),
  parent_id: z.number().int().positive().optional(),
  content: z.string().trim().min(1, '说点什么吧').max(500, '最多 500 字'),
});

interface ThreadRow {
  peer_id: number;
  peer_name: string;
  peer_avatar: string | null;
  peer_identity: string;
  last_content: string | null;
  last_at: number | null;
  last_sender_role: 'parent' | 'child' | null;
  last_sender_name: string | null;
  last_sender_identity: string | null;
  unread: number;
}

interface MessageRow {
  id: number;
  child_id: number;
  parent_id: number;
  sender_id: number;
  sender_role: 'parent' | 'child';
  content: string;
  created_at: number;
  sender_name: string | null;
  sender_identity: string | null;
}

function toMessage(m: MessageRow) {
  return {
    id: m.id,
    child_id: m.child_id,
    parent_id: m.parent_id,
    sender_id: m.sender_id,
    sender_role: m.sender_role,
    sender_name: m.sender_name,
    sender_identity: m.sender_identity,
    content: m.content,
    created_at: m.created_at,
  };
}

export function registerWhisperRoutes(app: FastifyInstance) {
  // 会话摘要：家长看到自己的孩子，孩子看到家里每一位家长
  app.get('/whispers/threads', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const db = getDb();
    const isChild = req.user.role === 'child';
    const me = req.user.sub;

    const sql = isChild
      ? `SELECT u.id AS peer_id, COALESCE(NULLIF(u.nickname, ''), u.name) AS peer_name, u.avatar AS peer_avatar,
                COALESCE(NULLIF(u.parent_identity, ''), '家长') AS peer_identity,
                m.content AS last_content, m.created_at AS last_at, m.sender_role AS last_sender_role,
                COALESCE(NULLIF(su.nickname, ''), su.name) AS last_sender_name,
                CASE WHEN su.role = 'child' THEN '孩子'
                     ELSE COALESCE(NULLIF(su.parent_identity, ''), '家长') END AS last_sender_identity,
                (SELECT COUNT(*) FROM whisper_messages x
                  WHERE x.child_id = ? AND x.parent_id = u.id
                    AND x.read_by_child = 0 AND x.sender_role = 'parent') AS unread
           FROM users u
           LEFT JOIN whisper_messages m
             ON m.id = (SELECT MAX(y.id) FROM whisper_messages y
                         WHERE y.child_id = ? AND y.parent_id = u.id)
           LEFT JOIN users su ON su.id = m.sender_id
          WHERE u.role = 'parent'
          ORDER BY u.id ASC`
      : `SELECT u.id AS peer_id, COALESCE(NULLIF(u.nickname, ''), u.name) AS peer_name, u.avatar AS peer_avatar,
                '孩子' AS peer_identity,
                m.content AS last_content, m.created_at AS last_at, m.sender_role AS last_sender_role,
                COALESCE(NULLIF(su.nickname, ''), su.name) AS last_sender_name,
                CASE WHEN su.role = 'child' THEN '孩子'
                     ELSE COALESCE(NULLIF(su.parent_identity, ''), '家长') END AS last_sender_identity,
                (SELECT COUNT(*) FROM whisper_messages x
                  WHERE x.child_id = u.id AND x.parent_id = ?
                    AND x.read_by_parent = 0 AND x.sender_role = 'child') AS unread
           FROM users u
           LEFT JOIN whisper_messages m
             ON m.id = (SELECT MAX(y.id) FROM whisper_messages y
                         WHERE y.child_id = u.id AND y.parent_id = ?)
           LEFT JOIN users su ON su.id = m.sender_id
          WHERE u.role = 'child'
          ORDER BY u.id ASC`;

    const rows = db.prepare(sql).all(me, me) as ThreadRow[];
    const threads = rows.map((r) => ({
      peer_id: r.peer_id,
      peer_name: r.peer_name,
      peer_avatar: r.peer_avatar,
      peer_identity: r.peer_identity,
      // 前端发请求时直接带上这两个 id，不用再按角色推导
      child_id: isChild ? me : r.peer_id,
      parent_id: isChild ? r.peer_id : me,
      last_content: r.last_content,
      last_at: r.last_at,
      last_sender_role: r.last_sender_role,
      last_sender_name: r.last_sender_name,
      last_sender_identity: r.last_sender_identity,
      unread: r.unread,
    }));

    return { threads, unreadTotal: threads.reduce((s, t) => s + t.unread, 0) };
  });

  // 某条悄悄话的消息列表（升序）
  // 读取即已读：只标记当前这条 (child_id, parent_id) 会话，不影响其他家长。
  app.get('/whispers/messages', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const q = req.query as Record<string, string | undefined>;
    const db = getDb();
    const isChild = req.user.role === 'child';
    const me = req.user.sub;

    const childId = isChild ? me : Number(q.child_id);
    const parentId = isChild ? Number(q.parent_id) : me;
    if (!Number.isInteger(childId) || childId <= 0 || !Number.isInteger(parentId) || parentId <= 0) {
      return reply.code(400).send({ error: 'invalid_input', message: '缺少会话对象' });
    }

    if (isChild) {
      const ok = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'parent'").get(parentId);
      if (!ok) return reply.code(404).send({ error: 'not_found', message: '没有这位家长' });
    } else {
      const ok = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'child'").get(childId);
      if (!ok) return reply.code(404).send({ error: 'not_found' });
    }

    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);
    const rows = db
      .prepare(
        `SELECT w.*, COALESCE(NULLIF(u.nickname, ''), u.name) AS sender_name,
                CASE WHEN u.role = 'child' THEN '孩子'
                     ELSE COALESCE(NULLIF(u.parent_identity, ''), '家长') END AS sender_identity
         FROM whisper_messages w
         LEFT JOIN users u ON u.id = w.sender_id
         WHERE w.child_id = ? AND w.parent_id = ?
         ORDER BY w.id DESC LIMIT ?`
      )
      .all(childId, parentId, limit) as MessageRow[];
    rows.reverse();

    if (isChild) {
      db.prepare(
        `UPDATE whisper_messages SET read_by_child = 1
          WHERE child_id = ? AND parent_id = ? AND sender_role = 'parent' AND read_by_child = 0`
      ).run(childId, parentId);
    } else {
      db.prepare(
        `UPDATE whisper_messages SET read_by_parent = 1
          WHERE child_id = ? AND parent_id = ? AND sender_role = 'child' AND read_by_parent = 0`
      ).run(childId, parentId);
    }

    return { messages: rows.map(toMessage) };
  });

  // 发一条悄悄话（两端都能发）
  app.post('/whispers/messages', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.issues[0]?.message });
    }
    const db = getDb();
    const isChild = req.user.role === 'child';
    const me = req.user.sub;

    const childId = isChild ? me : Number(parsed.data.child_id);
    const parentId = isChild ? Number(parsed.data.parent_id) : me;
    if (!Number.isInteger(childId) || childId <= 0 || !Number.isInteger(parentId) || parentId <= 0) {
      return reply.code(400).send({ error: 'invalid_input', message: '请选择悄悄话的对象' });
    }

    if (isChild) {
      const ok = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'parent'").get(parentId);
      if (!ok) return reply.code(404).send({ error: 'not_found', message: '没有这位家长' });
    } else {
      const ok = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'child'").get(childId);
      if (!ok) return reply.code(404).send({ error: 'not_found' });
    }

    // 自己发的对自己当然已读
    const res = db
      .prepare(
        `INSERT INTO whisper_messages (child_id, parent_id, sender_id, sender_role, content, read_by_child, read_by_parent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        childId,
        parentId,
        me,
        req.user.role,
        parsed.data.content,
        isChild ? 1 : 0,
        isChild ? 0 : 1
      );
    const id = Number(res.lastInsertRowid);
    const row = db
      .prepare(
        `SELECT w.*, COALESCE(NULLIF(u.nickname, ''), u.name) AS sender_name,
                CASE WHEN u.role = 'child' THEN '孩子'
                     ELSE COALESCE(NULLIF(u.parent_identity, ''), '家长') END AS sender_identity
         FROM whisper_messages w
         LEFT JOIN users u ON u.id = w.sender_id WHERE w.id = ?`
      )
      .get(id) as MessageRow;

    // 只推给会话双方，其他家长收不到任何提示
    const msg = {
      type: 'whisper_message',
      childId,
      parentId,
      messageId: id,
      senderId: me,
      senderRole: req.user.role,
      content: parsed.data.content,
      createdAt: row.created_at,
    };
    pushToUser(childId, msg);
    pushToUser(parentId, msg);

    return { ok: true, message: toMessage(row) };
  });
}
