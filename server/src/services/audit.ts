import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../db/index.js';

/**
 * 操作历史（2026-11-16）：全家庭 append-only 审计日志。
 *
 * ── 怎么记 ────────────────────────────────────────────────────────────
 * 不在每个路由里手工埋点（60+ 个写接口，漏一处就是永久盲区），而是挂一个
 * Fastify onResponse 钩子统一拦截：只记「成功的写操作」——非 GET、/api/ 下、
 * 响应状态 < 400（失败请求没有"执行"任何东西）。钩子在这里，业务路由零改动。
 *
 * 「谁执行了什么」的可读描述来自下方 ROUTE_DESCS 映射表：键是 `METHOD 路由模式`
 * （req.routeOptions.url，不带 /api 前缀），值从请求体/参数里取对象名、积分等
 * 快照拼成人话。没映射到的路由走兜底（方法 + 路径），新功能忘了登记也不会漏记。
 *
 * ── 不可变 ────────────────────────────────────────────────────────────
 * operation_logs 是 append-only 的：全项目没有 UPDATE/DELETE 它的代码路径，
 * 家长端只有查询接口。审计写入本身失败也只打 warn，绝不影响业务响应。
 */

interface OperationRow {
  actor_id: number | null;
  actor_role: string | null;
  actor_name: string;
  module: string;
  action: string;
  detail: string;
  method: string;
  path: string;
}

/** 描述函数的返回值：module/action 必填，detail 与操作人覆盖可选（登录接口用后者） */
interface DescribeResult {
  module: string;
  action: string;
  detail?: string;
  actorId?: number;
  actorRole?: string;
  actorName?: string;
}

interface DescribeCtx {
  req: FastifyRequest;
  body: any;
  params: any;
}

type DescribeFn = (ctx: DescribeCtx) => DescribeResult | null;

/** 这些请求不是"业务操作"：文件上传随所属业务记录；标记已读是噪音 */
const SKIP_PATHS = new Set(['/api/upload', '/api/upload/base64', '/api/mailbox/read']);

/** 内容太长截断：审计是时间线一行，不是聊天记录存档 */
function clip(s: unknown, max = 30): string {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 展示名快照：家长统一「昵称（身份）」，孩子用昵称/姓名；改过名/删号前查到什么就是什么 */
function displayName(id: unknown): string {
  if (!id) return '';
  const row = getDb()
    .prepare("SELECT role, COALESCE(NULLIF(nickname, ''), name) AS n, parent_identity FROM users WHERE id = ?")
    .get(Number(id)) as { role?: string; n?: string; parent_identity?: string | null } | undefined;
  if (!row) return '';
  const label = row.n ?? '';
  const identity = row.role === 'parent' ? (row.parent_identity ?? '').trim() : '';
  return identity && identity !== label ? `${label}（${identity}）` : label;
}

/** 带 #id 兜底的查名：对象已删（孩子/商品/日记…）时至少留个编号可查 */
function nameOrId(sql: string, id: unknown): string {
  try {
    const row = getDb().prepare(sql).get(Number(id)) as any;
    const n = row?.n ?? row?.name ?? row?.title ?? '';
    return n || `#${id}`;
  } catch {
    return `#${id}`;
  }
}

const CHILD_NAME = "SELECT name AS n FROM users WHERE id = ?";
const TASK_NAME = "SELECT name AS n FROM adhoc_tasks WHERE id = ?";
const RECUR_NAME = "SELECT name AS n FROM recurring_tasks WHERE id = ?";
const PRODUCT_NAME = "SELECT name AS n FROM products WHERE id = ?";
const CATEGORY_NAME = "SELECT name AS n FROM product_categories WHERE id = ?";
const ITEM_NAME = "SELECT name AS n FROM point_items WHERE id = ?";
const BACKPACK_NAME = "SELECT name AS n FROM backpack_items WHERE id = ?";
const EVENT_NAME = "SELECT title AS n FROM calendar_events WHERE id = ?";
const SPECIAL_NAME = "SELECT name AS n FROM special_days WHERE id = ?";
const WISH_NAME = "SELECT name AS n FROM wish_items WHERE id = ?";
const WISH_REQ_NAME = "SELECT title AS n FROM wish_requests WHERE id = ?";
const DIARY_NAME = "SELECT COALESCE(NULLIF(title,''),'无标题日记') AS n FROM growth_diaries WHERE id = ?";

/** 拿一条兑换申请的可读标签（商品名/规格/数量 或 现金金额），审核与驳回共用 */
function exchangeLabel(id: number): string {
  const row = getDb().prepare(`
    SELECT er.type, er.points, er.amount, er.quantity, er.variant_name, u.name AS user_name,
           COALESCE(p.name, '已删除商品') AS product_name
    FROM exchange_requests er
    LEFT JOIN products p ON er.product_id = p.id
    LEFT JOIN users u ON er.user_id = u.id
    WHERE er.id = ?
  `).get(id) as any;
  if (!row) return `#${id}`;
  const who = row.user_name ? `「${row.user_name}」` : '';
  if (row.type === 'cash') return `${who}现金兑换（${row.points}积分=${row.amount}元）`;
  const variant = row.variant_name ? `（${row.variant_name}）` : '';
  const qty = (row.quantity ?? 1) > 1 ? `×${row.quantity}` : '';
  return `${who}兑换「${row.product_name}${variant}」${qty}（${row.points}积分）`;
}

/** 临时任务完成申请 → 孩子名 + 任务名 */
function adhocCompletionLabel(id: number): string {
  const row = getDb().prepare(`
    SELECT u.name AS user_name, t.name AS task_name
    FROM task_completions tc
    LEFT JOIN users u ON tc.user_id = u.id
    LEFT JOIN adhoc_tasks t ON tc.task_id = t.id
    WHERE tc.id = ?
  `).get(id) as any;
  if (!row) return `#${id}`;
  return `「${row.user_name ?? '?'}」的任务「${row.task_name ?? '?'}」`;
}

/** 周期任务领取记录 → 孩子名 + 任务名（+期次） */
function claimLabel(id: number): string {
  const row = getDb().prepare(`
    SELECT u.name AS user_name, t.name AS task_name, c.period_key
    FROM recurring_claims c
    LEFT JOIN users u ON c.user_id = u.id
    LEFT JOIN recurring_tasks t ON c.task_id = t.id
    WHERE c.id = ?
  `).get(id) as any;
  if (!row) return `#${id}`;
  return `「${row.user_name ?? '?'}」的任务「${row.task_name ?? '?'}」（${row.period_key}）`;
}

const TIMER_WORDS: Record<string, string> = { start: '开始计时', pause: '暂停计时', stop: '结束计时' };
const FREQ_WORDS: Record<string, string> = { daily: '每天', weekly: '每周', monthly: '每月' };

/**
 * 描述映射表。键：`METHOD 路由模式`（不带 /api 前缀，与注册顺序无关）。
 * 新增写接口时在这里登记一行；漏了走兜底，不会漏记只会少点细节。
 */
const ROUTE_DESCS = new Map<string, DescribeFn>([
  // ── 登录（免鉴权接口，操作人从请求体反查） ─────────────────────────────
  ['POST /auth/parent-login', ({ body }) => {
    // 免鉴权接口没有 req.user：登录成功（2xx 才会走到这里）时用账号名反查操作人
    const row = getDb().prepare("SELECT id, COALESCE(NULLIF(nickname,''), name) AS n FROM users WHERE role='parent' AND name = ?")
      .get(String(body?.username ?? '')) as any;
    if (!row) return null;
    return { module: '登录', action: '登录家长端', actorId: row.id, actorRole: 'parent', actorName: row.n };
  }],
  ['POST /auth/child-login', ({ body }) => {
    const name = displayName(body?.userId);
    if (!name) return null;
    return { module: '登录', action: '登录孩子端', actorId: Number(body.userId), actorRole: 'child', actorName: name };
  }],

  // ── 账号 ─────────────────────────────────────────────────────────────
  ['PATCH /auth/me', ({ body }) => {
    const fields: string[] = [];
    if (body?.avatar !== undefined) fields.push('头像');
    if (body?.nickname !== undefined) fields.push('昵称');
    if (body?.identity !== undefined) fields.push('身份');
    if (body?.name !== undefined) fields.push('账号名');
    if (body?.password) fields.push('密码');
    return { module: '账号', action: '更新个人资料', detail: fields.length ? `改了：${fields.join('、')}` : '' };
  }],
  ['PATCH /auth/child/me', ({ body }) => {
    const fields: string[] = [];
    if (body?.avatar !== undefined) fields.push('头像');
    if (body?.pin) fields.push('PIN码');
    return { module: '账号', action: '更新个人资料', detail: fields.length ? `改了：${fields.join('、')}` : '' };
  }],
  ['POST /parents', ({ body }) => ({
    module: '账号', action: '添加子家长',
    detail: `「${clip(body?.name)}」${body?.identity ? `（${clip(body.identity, 10)}）` : ''}`,
  })],
  ['PATCH /parents/:id', ({ params, body }) => {
    const fields = [body?.name !== undefined && '账号名', body?.password && '密码'].filter(Boolean) as string[];
    return { module: '账号', action: '修改子家长账号', detail: `「${displayName(params?.id) || `#${params?.id}`}」${fields.join('、')}` };
  }],

  // ── 孩子管理 ────────────────────────────────────────────────────────
  ['POST /children', ({ body }) => ({
    module: '孩子', action: '添加孩子', detail: `「${clip(body?.name, 20)}」`,
  })],
  ['PATCH /children/:id', ({ params }) => ({
    module: '孩子', action: '更新孩子资料', detail: `「${displayName(params?.id) || `#${params?.id}`}」`,
  })],
  ['DELETE /children/:id', ({ params }) => ({
    module: '孩子', action: '删除孩子', detail: `「${displayName(params?.id) || `#${params?.id}`}」`,
  })],

  // ── 积分 ─────────────────────────────────────────────────────────────
  ['POST /point-items', ({ body }) => ({
    module: '积分', action: '新增积分项',
    detail: `「${clip(body?.name, 20)}」${Number(body?.points) > 0 ? '+' : ''}${body?.points ?? ''}`,
  })],
  ['PATCH /point-items/:id', ({ params }) => ({
    module: '积分', action: '修改积分项', detail: `「${nameOrId(ITEM_NAME, params?.id)}」`,
  })],
  ['DELETE /point-items/:id', ({ params }) => ({
    module: '积分', action: '删除积分项', detail: `「${nameOrId(ITEM_NAME, params?.id)}」`,
  })],
  ['POST /point-items/apply', ({ body }) => {
    const item = getDb().prepare('SELECT name, points FROM point_items WHERE id = ?').get(Number(body?.itemId)) as any;
    const pts = item?.points ?? body?.points ?? '';
    return {
      module: '积分', action: '一键加减分',
      detail: `给「${displayName(body?.userId) || `#${body?.userId}`}」完成「${item?.name ?? `#${body?.itemId}`}」${Number(pts) > 0 ? '+' : ''}${pts}分`,
    };
  }],
  ['POST /point-items/adjust', ({ body }) => {
    const delta = Number(body?.delta ?? 0);
    return {
      module: '积分', action: '手动调分',
      detail: `给「${displayName(body?.userId) || `#${body?.userId}`}」${delta > 0 ? '+' : ''}${delta}分${body?.note ? `（${clip(body.note)}）` : ''}`,
    };
  }],

  // ── 临时任务 ────────────────────────────────────────────────────────
  ['POST /adhoc-tasks', ({ body }) => {
    const assignees = (Array.isArray(body?.assigneeIds) ? body.assigneeIds : [])
      .map((id: number) => displayName(id)).filter(Boolean).join('、');
    return {
      module: '任务', action: '发布临时任务',
      detail: `「${clip(body?.name, 30)}」+${body?.points}分${assignees ? `，给：${assignees}` : ''}`,
    };
  }],
  ['PATCH /adhoc-tasks/:id', ({ params }) => ({
    module: '任务', action: '修改临时任务', detail: `「${nameOrId(TASK_NAME, params?.id)}」`,
  })],
  ['DELETE /adhoc-tasks/:id', ({ params }) => ({
    module: '任务', action: '删除临时任务', detail: `「${nameOrId(TASK_NAME, params?.id)}」`,
  })],
  ['POST /adhoc-tasks/:id/submit-completion', ({ params }) => ({
    module: '任务', action: '提交任务完成',
    detail: `「${nameOrId(TASK_NAME, params?.id)}」`,
  })],
  ['POST /adhoc-tasks/completions/:id/approve', ({ params }) => ({
    module: '审核', action: '通过任务完成申请', detail: adhocCompletionLabel(Number(params?.id)),
  })],
  ['POST /adhoc-tasks/completions/:id/reject', ({ params, body }) => ({
    module: '审核', action: '驳回任务完成申请',
    detail: `${adhocCompletionLabel(Number(params?.id))}${body?.reason ? `，理由：${clip(body.reason)}` : ''}`,
  })],

  // ── 周期任务 ────────────────────────────────────────────────────────
  ['POST /recurring-tasks', ({ body }) => {
    const freq = body?.once_only ? '单次' : FREQ_WORDS[body?.freq_type] ?? body?.freq_type ?? '';
    return { module: '任务', action: '创建周期任务', detail: `「${clip(body?.name, 30)}」+${body?.points}分（${freq}）` };
  }],
  ['PATCH /recurring-tasks/:id', ({ params }) => ({
    module: '任务', action: '修改周期任务', detail: `「${nameOrId(RECUR_NAME, params?.id)}」`,
  })],
  ['DELETE /recurring-tasks/:id', ({ params }) => ({
    module: '任务', action: '删除周期任务', detail: `「${nameOrId(RECUR_NAME, params?.id)}」`,
  })],
  ['DELETE /recurring-tasks/:id/claims', ({ params }) => ({
    module: '任务', action: '清空任务领取记录', detail: `「${nameOrId(RECUR_NAME, params?.id)}」的全部领取/完成记录`,
  })],
  ['DELETE /recurring-tasks/claims/:id', ({ params }) => ({
    module: '任务', action: '删除领取记录', detail: claimLabel(Number(params?.id)),
  })],
  ['POST /recurring-tasks/reorder', () => ({ module: '任务', action: '调整我的任务排序', detail: '' })],
  ['POST /recurring-tasks/:id/claim', ({ params }) => ({
    module: '任务', action: '领取任务', detail: `「${nameOrId(RECUR_NAME, params?.id)}」`,
  })],
  ['POST /recurring-tasks/claims/:id/submit', ({ params }) => ({
    module: '任务', action: '提交任务完成', detail: claimLabel(Number(params?.id)),
  })],
  ['POST /recurring-tasks/claims/:id/timer/:action', ({ params }) => ({
    module: '任务', action: '任务计时',
    detail: `${claimLabel(Number(params?.id))} ${TIMER_WORDS[String(params?.action)] ?? String(params?.action)}`,
  })],
  ['POST /recurring-tasks/claims/:id/approve', ({ params }) => ({
    module: '审核', action: '通过任务完成', detail: claimLabel(Number(params?.id)),
  })],
  ['POST /recurring-tasks/claims/:id/reject', ({ params, body }) => ({
    module: '审核', action: '驳回任务完成',
    detail: `${claimLabel(Number(params?.id))}${body?.reason ? `，理由：${clip(body.reason)}` : ''}`,
  })],

  // ── 商城 ─────────────────────────────────────────────────────────────
  ['PUT /products/cash-rate', ({ body }) => ({
    module: '商城', action: '修改现金兑换比例', detail: `${body?.rate}积分 = 1元`,
  })],
  ['POST /products', ({ body }) => ({
    module: '商城', action: body?.kind === 'prop' ? '上架道具' : '上架商品',
    detail: `「${clip(body?.name, 30)}」${body?.cost ?? 0}积分`,
  })],
  ['PATCH /products/:id', ({ params }) => ({
    module: '商城', action: '修改商品', detail: `「${nameOrId(PRODUCT_NAME, params?.id)}」`,
  })],
  ['DELETE /products/:id', ({ params }) => ({
    module: '商城', action: '删除商品', detail: `「${nameOrId(PRODUCT_NAME, params?.id)}」`,
  })],
  ['POST /product-categories', ({ body }) => ({
    module: '商城', action: '新建分类', detail: `「${clip(body?.name, 12)}」`,
  })],
  ['POST /product-categories/reorder', () => ({ module: '商城', action: '调整分类排序', detail: '' })],
  ['PATCH /product-categories/:id', ({ params }) => ({
    module: '商城', action: '修改分类', detail: `「${nameOrId(CATEGORY_NAME, params?.id)}」`,
  })],
  ['DELETE /product-categories/:id', ({ params }) => ({
    module: '商城', action: '删除分类', detail: `「${nameOrId(CATEGORY_NAME, params?.id)}」`,
  })],
  ['POST /exchange-requests', ({ body }) => {
    if (body?.type === 'cash') {
      return { module: '商城', action: '申请兑换现金', detail: `${body.points}积分` };
    }
    const product = nameOrId(PRODUCT_NAME, body?.productId);
    // 道具兑换不走家长审核，提交即入背包；普通礼物才是待审核的「申请兑换商品」
    const kind = (getDb().prepare('SELECT kind FROM products WHERE id = ?')
      .get(Number(body?.productId)) as { kind?: string } | undefined)?.kind;
    if (kind === 'prop') {
      return { module: '背包', action: '兑换道具入背包', detail: `「${product}」×${body?.quantity ?? 1}` };
    }
    return { module: '商城', action: '申请兑换商品', detail: `「${product}」×${body?.quantity ?? 1}` };
  }],
  ['POST /exchange-requests/:id/approve', ({ params }) => ({
    module: '审核', action: '通过兑换申请', detail: exchangeLabel(Number(params?.id)),
  })],
  ['POST /exchange-requests/:id/reject', ({ params, body }) => ({
    module: '审核', action: '驳回兑换申请',
    detail: `${exchangeLabel(Number(params?.id))}${body?.reason ? `，理由：${clip(body.reason)}` : ''}`,
  })],

  // ── 背包 ─────────────────────────────────────────────────────────────
  ['POST /backpack/:id/use', ({ params, body }) => ({
    module: '背包', action: '使用道具',
    detail: `「${nameOrId(BACKPACK_NAME, params?.id)}」${body?.note ? `，备注：${clip(body.note)}` : ''}`,
  })],
  ['POST /backpack/gift', ({ body }) => ({
    module: '背包', action: '赠送道具',
    detail: `给「${displayName(body?.childId) || `#${body?.childId}`}」赠送「${nameOrId(PRODUCT_NAME, body?.productId)}」×${body?.quantity ?? 1}${body?.reason ? `，理由：${clip(body.reason)}` : ''}`,
  })],
  ['POST /backpack/:id/take', ({ params, body }) => {
    const item = getDb().prepare('SELECT name, child_id, cost FROM backpack_items WHERE id = ?').get(Number(params?.id)) as any;
    const refund = body?.refundPoints !== undefined ? Number(body.refundPoints) : (item?.cost ?? 0);
    return {
      module: '背包', action: '拿走道具',
      detail: `拿走「${displayName(item?.child_id) || '?'}」的「${item?.name ?? `#${params?.id}`}」${refund > 0 ? `，返还${refund}积分` : ''}${body?.reason ? `，理由：${clip(body.reason)}` : ''}`,
    };
  }],

  // ── 日历 ─────────────────────────────────────────────────────────────
  ['POST /calendar/events', ({ body }) => ({
    module: '日历', action: '创建日程', detail: `「${clip(body?.title, 30)}」（${body?.event_date ?? ''}）`,
  })],
  ['PATCH /calendar/events/:id', ({ params }) => ({
    module: '日历', action: '修改日程', detail: `「${nameOrId(EVENT_NAME, params?.id)}」`,
  })],
  ['DELETE /calendar/events/:id', ({ params }) => ({
    module: '日历', action: '删除日程', detail: `「${nameOrId(EVENT_NAME, params?.id)}」`,
  })],
  ['POST /special-days', ({ body }) => ({
    module: '日历', action: '新建特殊日', detail: `${body?.emoji ?? ''}「${clip(body?.name, 20)}」`,
  })],
  ['PATCH /special-days/:id', ({ params }) => ({
    module: '日历', action: '修改特殊日', detail: `「${nameOrId(SPECIAL_NAME, params?.id)}」`,
  })],
  ['DELETE /special-days/:id', ({ params }) => ({
    module: '日历', action: '删除特殊日', detail: `「${nameOrId(SPECIAL_NAME, params?.id)}」`,
  })],

  // ── 心愿（许愿单 + 心愿单申请） ───────────────────────────────────────
  ['POST /wish-items', ({ body }) => ({
    module: '心愿', action: '许愿',
    detail: `「${clip(body?.name) || nameOrId(PRODUCT_NAME, body?.product_id) || '自定义礼物'}」`,
  })],
  ['PATCH /wish-items/:id', ({ params }) => ({
    module: '心愿', action: '完善心愿', detail: `「${nameOrId(WISH_NAME, params?.id)}」`,
  })],
  ['POST /wish-items/:id/confirm', ({ params }) => ({
    module: '心愿', action: '确认心愿开始打卡', detail: `「${nameOrId(WISH_NAME, params?.id)}」`,
  })],
  ['POST /wish-items/:id/decline', ({ params }) => ({
    module: '心愿', action: '放弃心愿确认', detail: `「${nameOrId(WISH_NAME, params?.id)}」`,
  })],
  ['POST /wish-items/:id/abandon', ({ params }) => ({
    module: '心愿', action: '放弃心愿', detail: `「${nameOrId(WISH_NAME, params?.id)}」`,
  })],
  ['POST /wish-items/:id/claim', ({ params }) => ({
    module: '心愿', action: '领取礼物', detail: `「${nameOrId(WISH_NAME, params?.id)}」`,
  })],
  ['DELETE /wish-items/:id', ({ params }) => ({
    module: '心愿', action: '删除心愿', detail: `「${nameOrId(WISH_NAME, params?.id)}」`,
  })],
  ['POST /wish-requests', ({ body }) => ({
    module: '心愿', action: '提交心愿申请', detail: `「${clip(body?.title, 30)}」`,
  })],
  ['POST /wish-requests/:id/cancel', ({ params }) => ({
    module: '心愿', action: '撤销心愿申请', detail: `「${nameOrId(WISH_REQ_NAME, params?.id)}」`,
  })],
  ['POST /wish-requests/:id/claim', ({ params }) => ({
    module: '心愿', action: '接手心愿审核', detail: `「${nameOrId(WISH_REQ_NAME, params?.id)}」`,
  })],
  ['POST /wish-requests/:id/release', ({ params }) => ({
    module: '心愿', action: '放弃心愿审核', detail: `「${nameOrId(WISH_REQ_NAME, params?.id)}」`,
  })],
  ['POST /wish-requests/:id/review', ({ params, body }) => ({
    module: '审核', action: body?.approve ? '通过心愿申请' : '驳回心愿申请',
    detail: `「${nameOrId(WISH_REQ_NAME, params?.id)}」${body?.approve ? '，已上架商城' : ''}${!body?.approve && body?.note ? `，理由：${clip(body.note)}` : ''}`,
  })],

  // ── 成长（曲线 + 日记） ───────────────────────────────────────────────
  ['PUT /growth/settings', () => ({ module: '成长', action: '修改成长记录奖励设置', detail: '' })],
  ['POST /growth/records', ({ body }) => {
    const parts = [body?.height_cm != null ? `身高${body.height_cm}cm` : '', body?.weight_kg != null ? `体重${body.weight_kg}kg` : '']
      .filter(Boolean).join('，');
    return {
      module: '成长', action: '记录身高体重',
      detail: `「${displayName(body?.user_id) || `#${body?.user_id}`}」${body?.record_date ?? ''} ${parts}`,
    };
  }],
  ['PATCH /growth/records/:id', ({ params }) => {
    const row = getDb().prepare(
      'SELECT u.name AS n, g.record_date FROM growth_records g LEFT JOIN users u ON g.user_id = u.id WHERE g.id = ?'
    ).get(Number(params?.id)) as any;
    return { module: '成长', action: '修改成长记录', detail: `「${row?.n ?? `#${params?.id}`}」${row?.record_date ?? ''}` };
  }],
  ['DELETE /growth/records/:id', ({ params }) => {
    const row = getDb().prepare(
      'SELECT u.name AS n, g.record_date FROM growth_records g LEFT JOIN users u ON g.user_id = u.id WHERE g.id = ?'
    ).get(Number(params?.id)) as any;
    return { module: '成长', action: '删除成长记录', detail: `「${row?.n ?? `#${params?.id}`}」${row?.record_date ?? ''}` };
  }],
  ['POST /growth/diaries', ({ body, req }) => {
    const target = req.user?.role === 'child' ? displayName(req.user.sub) : displayName(body?.user_id);
    return { module: '日记', action: '写成长日记', detail: `${target ? `给「${target}」` : ''}${body?.title ? `「${clip(body.title, 30)}」` : ''}` };
  }],
  ['PATCH /growth/diaries/:id', ({ params }) => ({
    module: '日记', action: '编辑成长日记', detail: `「${nameOrId(DIARY_NAME, params?.id)}」`,
  })],
  ['DELETE /growth/diaries/:id', ({ params }) => ({
    module: '日记', action: '删除成长日记', detail: `「${nameOrId(DIARY_NAME, params?.id)}」`,
  })],

  // ── 信箱 / 悄悄话 ─────────────────────────────────────────────────────
  ['POST /mailbox/messages', ({ body }) => ({
    module: '信箱', action: '树洞留言', detail: `「${clip(body?.content)}」`,
  })],
  // 悄悄话是一对一私聊：只记「发了」，内容绝不进全家庭可见的时间线
  ['POST /whispers/messages', ({ body }) => {
    const peer = body?.child_id ? displayName(body.child_id) : displayName(body?.parent_id);
    return { module: '悄悄话', action: '发送悄悄话', detail: peer ? `对方：${peer}` : '' };
  }],

  // ── 系统 ─────────────────────────────────────────────────────────────
    ['POST /update/apply', () => ({ module: '系统', action: '触发应用更新', detail: '' })],

  // ── AI 助手 ───────────────────────────────────────────────────────────
  ['POST /ai/sessions', () => ({ module: 'AI', action: '新建 AI 对话', detail: '' })],
  ['PUT /ai/sessions/:id', ({ body }) => ({
    module: 'AI', action: '重命名 AI 对话',
    detail: body?.title ? `「${String(body.title).slice(0, 30)}」` : '',
  })],
  ['DELETE /ai/sessions/:id', () => ({ module: 'AI', action: '删除 AI 对话', detail: '' })],
  ['POST /ai/sessions/:id/messages', ({ body }) => ({
    module: 'AI', action: '发送 AI 消息',
    detail: body?.agent ? 'agent 模式' : '',
  })],
  ['PUT /ai/config', () => ({ module: 'AI', action: '保存 AI 设置', detail: '' })],
  ['POST /ai/skills', ({ body }) => ({
    module: 'AI', action: '新建 AI 技能',
    detail: body?.name ? `「${String(body.name).slice(0, 30)}」` : '',
  })],
  ['PUT /ai/skills/:id', ({ body }) => ({
    module: 'AI',
    action: body?.enabled !== undefined && body?.name === undefined ? '切换 AI 技能开关' : '修改 AI 技能',
    detail: '',
  })],
  ['DELETE /ai/skills/:id', () => ({ module: 'AI', action: '删除 AI 技能', detail: '' })],
  ['POST /ai/confirm', () => ({ module: 'AI', action: '确认 AI 操作', detail: '' })],
  ['POST /ai/upload', () => ({ module: 'AI', action: '上传 AI 附件', detail: '' })],
]);

/** 没登记的路由兜底：保证「有记录」，只是描述不具体 */
function fallbackDescribe(method: string, routeUrl: string | undefined, path: string): DescribeResult {
  return { module: '其他', action: '执行了写操作', detail: routeUrl ? `${method} ${routeUrl}` : `${method} ${path}` };
}

/** 追加一条审计（同步 SQLite 写入很快；任何失败只打 warn，不影响业务响应） */
function appendOperation(row: OperationRow): void {
  try {
    getDb().prepare(`
      INSERT INTO operation_logs (actor_id, actor_role, actor_name, module, action, detail, method, path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.actor_id, row.actor_role, row.actor_name, row.module, row.action, row.detail, row.method, row.path);
  } catch (e) {
    console.warn('[audit] 写入操作历史失败:', e);
  }
}

/** AI 工具执行/Sentinel 决策直接写审计（services/ai 层用）：调用方传谁在用、干了什么 */
export function appendAuditRow(row: OperationRow): void {
  appendOperation(row);
}

export function registerAuditHook(app: FastifyInstance) {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const method = req.method.toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
      if (!req.url.startsWith('/api/')) return;
      if (reply.statusCode >= 400) return; // 失败的请求没有"执行"任何东西

      const path = req.url.split('?')[0];
      if (SKIP_PATHS.has(path)) return;

      const routeUrl = (req.routeOptions as any)?.url as string | undefined;
      // 路由注册在 /api 前缀下，routeOptions.url 实测会带上前缀；
      // 映射表统一按不带前缀的路径登记，这里归一化后再查
      const keyUrl = routeUrl?.replace(/^\/api/, '') ?? '';
      const desc = ROUTE_DESCS.get(`${method} ${keyUrl}`)?.({
        req, body: req.body as any, params: req.params as any,
      }) ?? fallbackDescribe(method, routeUrl, path);
      if (!desc) return;

      // 操作人：登录接口由描述函数从请求体反查；其余从 JWT 取，姓名落库时快照
      let actorId: number | null = desc.actorId ?? null;
      let actorRole: string | null = desc.actorRole ?? null;
      let actorName = desc.actorName ?? '';
      if (actorId === null && req.user) {
        actorId = req.user.sub;
        actorRole = req.user.role;
        actorName = displayName(req.user.sub);
      }

      appendOperation({
        actor_id: actorId,
        actor_role: actorRole,
        actor_name: actorName || (actorRole === 'system' ? '系统' : ''),
        module: desc.module,
        action: desc.action,
        detail: desc.detail ?? '',
        method,
        path,
      });
    } catch (e) {
      console.warn('[audit] 记录操作历史异常:', e);
    }
  });
}
