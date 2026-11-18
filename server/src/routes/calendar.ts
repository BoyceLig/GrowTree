import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireParent } from '../middleware.js';
import { pushToAll } from '../ws.js';
import { ruleHits, todayLocal } from '../services/dayEffect.js';

/**
 * 日历与日程（2026-11-14，2026-11-16 改版）
 * 单家庭模式：users 即全家。权限见 docs/日历与特殊日功能方案.md §4/§4.1：
 *   - 公开（public）：所有人可见（家长 + 孩子）
 *   - 私有（private）：全体家长可见；创建者与参与的孩子看完整，
 *     其他孩子只拿到一张「私有日程」占位（保留日期/时间，隐藏标题/参与人/备注）
 *   - 家长可改删任何日程；孩子只能改删自己创建的
 *   - 日程可跨天：event_date = 开始日期，end_date = 结束日期（缺省=同一天）
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const YEARLY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && todayLocal(d) === s;
}

interface FamilyMember {
  id: number;
  name: string;
  nickname: string | null;
  avatar: string | null;
  role: 'parent' | 'child';
  parent_identity: string | null;
}

function familyMembers(): { parents: FamilyMember[]; children: FamilyMember[] } {
  const db = getDb();
  const parents = db.prepare(
    "SELECT id, name, nickname, avatar, role, parent_identity FROM users WHERE role = 'parent' ORDER BY is_primary DESC, id ASC"
  ).all() as any[];
  const children = db.prepare(
    "SELECT id, name, nickname, avatar, role, parent_identity FROM users WHERE role = 'child' AND hidden = 0 ORDER BY id ASC"
  ).all() as any[];
  return { parents, children };
}

/** 把启用的特殊日展开到 [from, to] 区间（本地日期逐日匹配，家庭规模下运算量可忽略） */
function expandSpecialDays(from: string, to: string, childId: number | null): any[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM special_days WHERE enabled = 1').all() as any[];
  const out: any[] = [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return out;
  const cursor = new Date(start);
  while (cursor <= end) {
    const ds = todayLocal(cursor);
    for (const rule of rows) {
      if (!ruleHits(rule, ds)) continue;
      if (rule.scope === 'custom') {
        if (childId != null) {
          // 孩子端：只下发指定给自己的特殊日
          const hit = db.prepare('SELECT 1 FROM special_day_targets WHERE special_day_id = ? AND user_id = ?')
            .get(rule.id, childId);
          if (!hit) continue;
        }
        // 家长端（childId == null）：全部可见，包括指定孩子的
      }
      out.push({
        id: rule.id,
        name: rule.name,
        emoji: rule.emoji,
        date: ds,
        effect_kind: rule.effect_kind,
        effect_value: rule.effect_value,
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** 组装区间内的日程（含参与人），并按查看者角色做可见性过滤 / 私有脱敏 */
function listEvents(viewer: { sub: number; role: string }, from: string, to: string): any[] {
  const db = getDb();
  // 跨天日程：只要与 [from,to] 有交集就返回
  const events = db.prepare(`
    SELECT e.*, u.name AS creator_name, u.nickname AS creator_nickname
    FROM calendar_events e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.event_date <= ? AND COALESCE(e.end_date, e.event_date) >= ?
    ORDER BY e.event_date ASC, e.is_all_day DESC, e.start_time ASC, e.id ASC
  `).all(to, from) as any[];
  if (events.length === 0) return [];

  const ids = events.map((e) => e.id);
  const placeholders = ids.map(() => '?').join(',');
  const parts = db.prepare(`
    SELECT p.event_id, u.id, u.name, u.nickname, u.avatar, u.role, u.parent_identity
    FROM calendar_event_participants p
    JOIN users u ON u.id = p.user_id
    WHERE p.event_id IN (${placeholders})
    ORDER BY u.role ASC, u.id ASC
  `).all(...ids) as any[];

  const byEvent = new Map<number, FamilyMember[]>();
  for (const p of parts) {
    const arr = byEvent.get(p.event_id) ?? [];
    arr.push({ id: p.id, name: p.name, nickname: p.nickname, avatar: p.avatar, role: p.role, parent_identity: p.parent_identity });
    byEvent.set(p.event_id, arr);
  }

  return events.map((e) => {
    const participants = byEvent.get(e.id) ?? [];
    // 孩子看私有日程：不是创建者、也不是参与人 → 只给占位卡
    const redacted = viewer.role !== 'parent'
      && e.visibility === 'private'
      && e.created_by !== viewer.sub
      && !participants.some((p) => p.id === viewer.sub);

    if (redacted) {
      return {
        id: e.id,
        title: '私有日程',
        event_date: e.event_date,
        end_date: e.end_date ?? e.event_date,
        is_all_day: !!e.is_all_day,
        start_time: e.start_time,
        end_time: e.end_time,
        note: '',
        visibility: 'private',
        created_by: null,
        creator_name: null,
        creator_nickname: null,
        participants: [],
        redacted: true,
      };
    }

    return {
      ...e,
      end_date: e.end_date ?? e.event_date,
      is_all_day: !!e.is_all_day,
      participants,
      redacted: false,
    };
  });
}

export function registerCalendarRoutes(app: FastifyInstance) {
  // ── 日历区间数据（双端） ────────────────────────────────────────────────
  app.get('/calendar', async (req, reply) => {
    const q = req.query as any;
    const from = String(q.from ?? '');
    const to = String(q.to ?? '');
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || !isRealDate(from) || !isRealDate(to) || from > to) {
      return reply.code(400).send({ error: 'invalid_range' });
    }
    const viewer = { sub: req.user!.sub, role: req.user!.role as string };
    return {
      events: listEvents(viewer, from, to),
      specialDays: expandSpecialDays(from, to, viewer.role === 'child' ? viewer.sub : null),
      family: familyMembers(),
      today: todayLocal(),
    };
  });

  // ── 日程 CRUD ──────────────────────────────────────────────────────────
  const eventSchema = z.object({
    title: z.string().min(1).max(50),
    event_date: z.string().regex(DATE_RE),
    /** 结束日期；不填 = 与开始同一天。跨天日程用它 */
    end_date: z.string().regex(DATE_RE).nullable().optional(),
    is_all_day: z.boolean().default(true),
    start_time: z.string().regex(TIME_RE).nullable().optional(),
    end_time: z.string().regex(TIME_RE).nullable().optional(),
    note: z.string().max(200).default(''),
    participant_ids: z.array(z.number().int().positive()).min(1).max(20),
    visibility: z.enum(['public', 'private']).default('public'),
  });

  function validateEventBody(body: any, viewerRole: string, viewerId: number) {
    if (!isRealDate(body.event_date)) return 'invalid_date';
    const endDate = body.end_date || body.event_date;
    if (!isRealDate(endDate)) return 'invalid_date';
    if (endDate < body.event_date) return 'end_before_start';
    body.end_date = endDate;

    if (!body.is_all_day) {
      if (!body.start_time || !body.end_time) return 'time_required';
      // 同一天时结束时刻必须晚于开始；跨天则允许 22:00 → 02:00 这种写法
      if (endDate === body.event_date && body.end_time <= body.start_time) return 'end_before_start';
    }
    // 参与人必须真实存在；去重
    const unique = [...new Set(body.participant_ids as number[])];
    const db = getDb();
    const placeholders = unique.map(() => '?').join(',');
    const found = db.prepare(`SELECT id, role FROM users WHERE id IN (${placeholders})`).all(...unique) as any[];
    if (found.length !== unique.length) return 'participant_not_found';

    // 先落去重结果，再按角色改写（顺序反了会把「孩子私有锁自己」覆盖回去）
    body.participant_ids = unique;

    if (viewerRole !== 'parent' && body.visibility === 'private') {
      // 孩子建私有日程：参与人锁为自己（父母全可见，兄弟姐妹只看到占位卡）
      body.participant_ids = [viewerId];
    }
    return null;
  }

  function insertParticipants(eventId: number, ids: number[]) {
    const db = getDb();
    const ins = db.prepare('INSERT OR IGNORE INTO calendar_event_participants (event_id, user_id) VALUES (?, ?)');
    for (const uid of ids) ins.run(eventId, uid);
  }

  app.post('/calendar/events', async (req, reply) => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    const body = parsed.data as any;
    const err = validateEventBody(body, req.user!.role, req.user!.sub);
    if (err) return reply.code(400).send({ error: err });

    const db = getDb();
    const r = db.prepare(`
      INSERT INTO calendar_events (title, event_date, end_date, is_all_day, start_time, end_time, note, visibility, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.title,
      body.event_date,
      body.end_date,
      body.is_all_day ? 1 : 0,
      body.is_all_day ? null : body.start_time,
      body.is_all_day ? null : body.end_time,
      body.note,
      body.visibility,
      req.user!.sub,
    );
    const eventId = Number(r.lastInsertRowid);
    insertParticipants(eventId, body.participant_ids);
    pushToAll({ type: 'calendar_changed', action: 'create', eventId });
    return { ok: true, id: eventId };
  });

  app.patch('/calendar/events/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    const body = parsed.data as any;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as any;
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (req.user!.role !== 'parent' && existing.created_by !== req.user!.sub) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const err = validateEventBody(body, req.user!.role, req.user!.sub);
    if (err) return reply.code(400).send({ error: err });

    db.prepare(`
      UPDATE calendar_events
      SET title = ?, event_date = ?, end_date = ?, is_all_day = ?, start_time = ?, end_time = ?, note = ?, visibility = ?, updated_at = ?
      WHERE id = ?
    `).run(
      body.title,
      body.event_date,
      body.end_date,
      body.is_all_day ? 1 : 0,
      body.is_all_day ? null : body.start_time,
      body.is_all_day ? null : body.end_time,
      body.note,
      body.visibility,
      Math.floor(Date.now() / 1000),
      id,
    );
    db.prepare('DELETE FROM calendar_event_participants WHERE event_id = ?').run(id);
    insertParticipants(id, body.participant_ids);
    pushToAll({ type: 'calendar_changed', action: 'update', eventId: id });
    return { ok: true };
  });

  app.delete('/calendar/events/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as any;
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (req.user!.role !== 'parent' && existing.created_by !== req.user!.sub) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
    pushToAll({ type: 'calendar_changed', action: 'delete', eventId: id });
    return { ok: true };
  });

  // ── 特殊日 CRUD（家长专属） ────────────────────────────────────────────
  const specialDaySchema = z.object({
    name: z.string().min(1).max(30),
    emoji: z.string().max(8).default('🎉'),
    rule_type: z.enum(['once', 'weekly', 'monthly', 'yearly']),
    once_date: z.string().regex(DATE_RE).nullable().optional(),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).nullable().optional(),
    month_days: z.array(z.number().int().min(1).max(31)).max(31).nullable().optional(),
    yearly_md: z.string().regex(YEARLY_RE).nullable().optional(),
    range_start: z.string().regex(DATE_RE).nullable().optional(),
    range_end: z.string().regex(DATE_RE).nullable().optional(),
    scope: z.enum(['all', 'custom']).default('all'),
    target_ids: z.array(z.number().int().positive()).max(20).optional(),
    effect_kind: z.enum(['earn', 'spend']).nullable().optional(),
    effect_value: z.number().optional(),
    enabled: z.boolean().default(true),
  });

  function validateSpecialDay(body: any) {
    switch (body.rule_type) {
      case 'once':
        if (!body.once_date || !isRealDate(body.once_date)) return 'invalid_once_date';
        break;
      case 'weekly':
        if (!body.weekdays || body.weekdays.length === 0) return 'weekdays_required';
        break;
      case 'monthly':
        if (!body.month_days || body.month_days.length === 0) return 'month_days_required';
        break;
      case 'yearly':
        if (!body.yearly_md) return 'yearly_required';
        break;
    }
    if (body.range_start && body.range_end && body.range_start > body.range_end) return 'invalid_range';
    if (body.effect_kind) {
      const v = Number(body.effect_value);
      if (!Number.isFinite(v)) return 'effect_value_required';
      if (body.effect_kind === 'earn' && (v <= 1 || v > 3)) return 'invalid_effect_value';
      if (body.effect_kind === 'spend' && (v <= 0 || v >= 1)) return 'invalid_effect_value';
    } else {
      body.effect_kind = null;
      body.effect_value = null;
    }
    const db = getDb();
    if (body.scope === 'custom') {
      if (!body.target_ids || body.target_ids.length === 0) return 'targets_required';
      const placeholders = body.target_ids.map(() => '?').join(',');
      const found = db.prepare(`SELECT id, role, hidden FROM users WHERE id IN (${placeholders})`).all(...body.target_ids) as any[];
      if (found.length !== new Set(body.target_ids).size) return 'target_not_found';
      if (found.some((u) => u.role !== 'child')) return 'target_must_be_child';
    } else {
      body.target_ids = [];
    }
    return null;
  }

  function writeTargets(specialDayId: number, ids: number[]) {
    const db = getDb();
    db.prepare('DELETE FROM special_day_targets WHERE special_day_id = ?').run(specialDayId);
    const ins = db.prepare('INSERT OR IGNORE INTO special_day_targets (special_day_id, user_id) VALUES (?, ?)');
    for (const uid of [...new Set(ids)]) ins.run(specialDayId, uid);
  }

  function rowToPayload(row: any) {
    return {
      id: row.id,
      name: row.name,
      emoji: row.emoji,
      rule_type: row.rule_type,
      once_date: row.once_date,
      weekdays: row.weekdays ? JSON.parse(row.weekdays) : [],
      month_days: row.month_days ? JSON.parse(row.month_days) : [],
      yearly_md: row.yearly_md,
      range_start: row.range_start,
      range_end: row.range_end,
      scope: row.scope,
      target_ids: [] as number[],
      target_names: [] as string[],
      effect_kind: row.effect_kind,
      effect_value: row.effect_value,
      enabled: !!row.enabled,
    };
  }

  app.get('/special-days', { preHandler: requireParent }, async () => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM special_days ORDER BY enabled DESC, id ASC').all() as any[];
    const targets = db.prepare(`
      SELECT t.special_day_id, t.user_id, u.name, u.avatar
      FROM special_day_targets t JOIN users u ON u.id = t.user_id
    `).all() as any[];
    return {
      specialDays: rows.map((r) => {
        const p = rowToPayload(r);
        p.target_ids = targets.filter((t) => t.special_day_id === r.id).map((t) => t.user_id);
        p.target_names = targets.filter((t) => t.special_day_id === r.id).map((t) => (t as any).name);
        return p;
      }),
    };
  });

  app.post('/special-days', { preHandler: requireParent }, async (req, reply) => {
    const parsed = specialDaySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    const body = parsed.data as any;
    const err = validateSpecialDay(body);
    if (err) return reply.code(400).send({ error: err });

    const db = getDb();
    const r = db.prepare(`
      INSERT INTO special_days
        (name, emoji, rule_type, once_date, weekdays, month_days, yearly_md, range_start, range_end, scope, effect_kind, effect_value, enabled, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.name,
      body.emoji || '🎉',
      body.rule_type,
      body.once_date ?? null,
      body.weekdays ? JSON.stringify(body.weekdays) : null,
      body.month_days ? JSON.stringify(body.month_days) : null,
      body.yearly_md ?? null,
      body.range_start ?? null,
      body.range_end ?? null,
      body.scope,
      body.effect_kind,
      body.effect_value,
      body.enabled ? 1 : 0,
      req.user!.sub,
    );
    writeTargets(Number(r.lastInsertRowid), body.target_ids ?? []);
    pushToAll({ type: 'special_days_changed', action: 'create' });
    return { ok: true, id: Number(r.lastInsertRowid) };
  });

  app.patch('/special-days/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const parsed = specialDaySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    const body = parsed.data as any;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM special_days WHERE id = ?').get(id) as any;
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const err = validateSpecialDay(body);
    if (err) return reply.code(400).send({ error: err });

    db.prepare(`
      UPDATE special_days
      SET name = ?, emoji = ?, rule_type = ?, once_date = ?, weekdays = ?, month_days = ?, yearly_md = ?,
          range_start = ?, range_end = ?, scope = ?, effect_kind = ?, effect_value = ?, enabled = ?
      WHERE id = ?
    `).run(
      body.name,
      body.emoji || '🎉',
      body.rule_type,
      body.once_date ?? null,
      body.weekdays ? JSON.stringify(body.weekdays) : null,
      body.month_days ? JSON.stringify(body.month_days) : null,
      body.yearly_md ?? null,
      body.range_start ?? null,
      body.range_end ?? null,
      body.scope,
      body.effect_kind,
      body.effect_value,
      body.enabled ? 1 : 0,
      id,
    );
    writeTargets(id, body.target_ids ?? []);
    pushToAll({ type: 'special_days_changed', action: 'update', specialDayId: id });
    return { ok: true };
  });

  app.delete('/special-days/:id', { preHandler: requireParent }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM special_days WHERE id = ?').get(id) as any;
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    db.prepare('DELETE FROM special_days WHERE id = ?').run(id);
    pushToAll({ type: 'special_days_changed', action: 'delete', specialDayId: id });
    return { ok: true };
  });
}
