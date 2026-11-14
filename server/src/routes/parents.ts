import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { hashPassword } from '../auth.js';
import { requirePrimaryParent } from '../middleware.js';

const identitySchema = z.string().trim().min(1).max(20);

// 主账号新建子家长：只收账号 / 密码 / 身份。昵称和头像由服务端写默认值，
// 之后子家长登录后自己改。
const createParentSchema = z.object({
  name: z.string().trim().min(1).max(30),
  password: z.string().min(6).max(64),
  identity: identitySchema,
});

// 主账号修改子家长：只允许账号 / 密码；昵称、头像属于子家长自己的资料。
const updateParentSchema = z.object({
  name: z.string().trim().min(1).max(30).optional(),
  password: z.string().min(6).max(64).optional(),
});

// 身份是自由文本（内置 20 个称谓 + 自定义）。默认昵称直接用身份，
// 头像按常见女性/男性称谓给一个生肖默认图，自定义称谓回退到小龙。
const FEMALE_IDENTITIES = new Set([
  '妈妈', '奶奶', '姥姥', '外婆', '伯母', '婶婶', '姑姑', '舅妈', '姨姨', '干妈', '阿姨',
]);
const DEFAULT_AVATAR = { female: 'rabbit', male: 'dragon' } as const;

function defaultAvatar(identity: string): string {
  return FEMALE_IDENTITIES.has(identity) ? DEFAULT_AVATAR.female : DEFAULT_AVATAR.male;
}

/** 家长对外的安全字段：永远不返回 password_hash */
function safeParent(row: any) {
  return {
    id: row.id,
    name: row.name,
    nickname: row.nickname || row.name,
    avatar: row.avatar ?? null,
    identity: row.parent_identity ?? null,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at ?? null,
  };
}

export function registerParentRoutes(app: FastifyInstance) {
  /** 家长账号列表（只有主账号能看） */
  app.get('/parents', { preHandler: requirePrimaryParent }, async () => {
    const rows = getDb().prepare(
      `SELECT id, name, nickname, avatar, parent_identity, is_primary, created_at
       FROM users WHERE role = 'parent'
       ORDER BY is_primary DESC, id ASC`
    ).all() as any[];
    return { parents: rows.map(safeParent) };
  });

  /** 新建子家长（只有主账号能做） */
  app.post('/parents', { preHandler: requirePrimaryParent }, async (req, reply) => {
    const parsed = createParentSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { name, password, identity } = parsed.data;
    const db = getDb();

    const exists = db.prepare("SELECT id FROM users WHERE role = 'parent' AND name = ?").get(name);
    if (exists) return reply.code(409).send({ error: 'name_taken' });

    const hash = await hashPassword(password);
    const result = db.prepare(
      `INSERT INTO users (name, role, password_hash, avatar, nickname, parent_identity, is_primary, total_points)
       VALUES (?, 'parent', ?, ?, ?, ?, 0, 0)`
    ).run(name, hash, defaultAvatar(identity), identity, identity);

    const created = db.prepare(
      `SELECT id, name, nickname, avatar, parent_identity, is_primary, created_at
       FROM users WHERE id = ?`
    ).get(result.lastInsertRowid) as any;
    return { parent: safeParent(created) };
  });

  /** 修改子家长的账号 / 密码（只有主账号能做；主账号自己不能走这里） */
  app.patch('/parents/:id', { preHandler: requirePrimaryParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_id' });

    const parsed = updateParentSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { name, password } = parsed.data;
    if (name === undefined && password === undefined) {
      return reply.code(400).send({ error: 'no_fields' });
    }

    const db = getDb();
    const target = db.prepare(
      "SELECT id, is_primary FROM users WHERE id = ? AND role = 'parent'"
    ).get(id) as { id: number; is_primary: number } | undefined;
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.is_primary) return reply.code(403).send({ error: 'primary_readonly' });

    if (name !== undefined) {
      const exists = db.prepare(
        "SELECT id FROM users WHERE role = 'parent' AND name = ? AND id != ?"
      ).get(name, id);
      if (exists) return reply.code(409).send({ error: 'name_taken' });
    }

    const fields: string[] = [];
    const values: any[] = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (password !== undefined) {
      fields.push('password_hash = ?');
      values.push(await hashPassword(password));
    }
    values.push(id);
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare(
      `SELECT id, name, nickname, avatar, parent_identity, is_primary, created_at
       FROM users WHERE id = ?`
    ).get(id) as any;
    return { parent: safeParent(updated) };
  });
}
