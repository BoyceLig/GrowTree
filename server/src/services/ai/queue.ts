import { getDb } from '../../db/index.js';

/**
 * AI 会话消息排队（2026-11-18）
 *
 * 一个会话同一时间只跑一个回合。回合进行中家长再发消息时，消息先落到这张表，
 * 回合结束按 sort_order 依次自动执行；也可以「引导」把某条消息立刻补进当前回合。
 * 存在 SQLite 而不是前端内存：切页面 / 刷新 / 断网回来排队列表都还在。
 */

export type QueueItem = {
  id: number;
  sessionId: number;
  userId: number;
  content: string;
  attachments: any[] | null;
  createdAt: number;
  sortOrder: number;
};

type Row = {
  id: number;
  session_id: number;
  user_id: number;
  content: string;
  attachments: string | null;
  created_at: number;
  sort_order: number;
};

function toItem(r: Row): QueueItem {
  let attachments: any[] | null = null;
  try {
    attachments = r.attachments ? JSON.parse(r.attachments) : null;
  } catch {
    attachments = null;
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    userId: r.user_id,
    content: r.content,
    attachments,
    createdAt: r.created_at,
    sortOrder: r.sort_order,
  };
}

export function listQueue(sessionId: number): QueueItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM ai_queue WHERE session_id = ? ORDER BY sort_order, id')
    .all(sessionId) as Row[];
  return rows.map(toItem);
}

export function addQueueItem(sessionId: number, userId: number, content: string, attachments: any[]): QueueItem {
  const db = getDb();
  const max = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM ai_queue WHERE session_id = ?').get(sessionId) as any)?.m ?? 0;
  const info = db
    .prepare('INSERT INTO ai_queue (session_id, user_id, content, attachments, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, userId, content, attachments.length ? JSON.stringify(attachments) : null, Number(max) + 1);
  const row = db.prepare('SELECT * FROM ai_queue WHERE id = ?').get(Number(info.lastInsertRowid)) as Row;
  return toItem(row);
}

export function updateQueueItem(id: number, sessionId: number, content: string, attachments?: any[]): QueueItem | undefined {
  const db = getDb();
  if (attachments) {
    db.prepare('UPDATE ai_queue SET content = ?, attachments = ? WHERE id = ? AND session_id = ?').run(
      content,
      attachments.length ? JSON.stringify(attachments) : null,
      id,
      sessionId
    );
  } else {
    db.prepare('UPDATE ai_queue SET content = ? WHERE id = ? AND session_id = ?').run(content, id, sessionId);
  }
  const row = db.prepare('SELECT * FROM ai_queue WHERE id = ? AND session_id = ?').get(id, sessionId) as Row | undefined;
  return row ? toItem(row) : undefined;
}

export function deleteQueueItem(id: number, sessionId: number): boolean {
  return getDb().prepare('DELETE FROM ai_queue WHERE id = ? AND session_id = ?').run(id, sessionId).changes > 0;
}

export function reorderQueue(sessionId: number, ids: number[]): QueueItem[] {
  const db = getDb();
  const valid = new Set(listQueue(sessionId).map((x) => x.id));
  const txn = db.transaction(() => {
    let pos = 1;
    for (const id of ids) {
      if (!valid.has(id)) continue;
      db.prepare('UPDATE ai_queue SET sort_order = ? WHERE id = ? AND session_id = ?').run(pos++, id, sessionId);
    }
  });
  txn();
  return listQueue(sessionId);
}

/** 取出队首消息（自动执行用）；没有则返回 undefined */
export function takeNextQueueItem(sessionId: number): QueueItem | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_queue WHERE session_id = ? ORDER BY sort_order, id LIMIT 1').get(sessionId) as Row | undefined;
  if (!row) return undefined;
  db.prepare('DELETE FROM ai_queue WHERE id = ?').run(row.id);
  return toItem(row);
}

/** 插到队首（引导没赶上当前回合时，保证它下一条就被回应） */
export function prependQueueItem(sessionId: number, userId: number, content: string, attachments: any[]): QueueItem {
  const db = getDb();
  const min = (db.prepare('SELECT COALESCE(MIN(sort_order), 1) AS m FROM ai_queue WHERE session_id = ?').get(sessionId) as any)?.m ?? 1;
  const info = db
    .prepare('INSERT INTO ai_queue (session_id, user_id, content, attachments, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, userId, content, attachments.length ? JSON.stringify(attachments) : null, Number(min) - 1);
  const row = db.prepare('SELECT * FROM ai_queue WHERE id = ?').get(Number(info.lastInsertRowid)) as Row;
  return toItem(row);
}

export function clearQueue(sessionId: number): void {
  getDb().prepare('DELETE FROM ai_queue WHERE session_id = ?').run(sessionId);
}