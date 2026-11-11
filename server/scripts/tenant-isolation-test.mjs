/**
 * 多租户隔离自动化测试（商业版红线）
 *
 * 跑法（在 server 目录）：
 *   node scripts/tenant-isolation-test.mjs
 *
 * 它会自己起一个临时后端（独立 DATA_DIR + 随机端口），造两个家庭，
 * 然后逐条验证「A 家庭碰不到 B 家庭的任何东西」。跑完杀进程、删临时目录，
 * 不碰你的验收库（3920）。
 *
 * ── 为什么必须有这个脚本 ────────────────────────────────────────────
 * 多租户的隔离是靠 `getDb()` 在 SQL 层强制注入 `family_id` 实现的。
 * 这层的可怕之处在于：**注入生效时一切正常，漏注入时也一切正常**——
 * 只是默默把别人家的孩子、积分流水、照片也返回了。
 * 类型检查查不出来，页面也不报错，要等用户投诉才发现。
 * 所以隔离不能靠「小心写」，得靠每次改完跑一遍这个脚本。
 *
 * ── 覆盖的九类风险 ──────────────────────────────────────────────────
 *   1. 列表接口不串数据（children / point-items / point-logs / products / …）
 *   2. 按 id 改删别人家的资源 → 404
 *   3. 临时加减分传别人家孩子 id → 404（这条最容易漏，它是唯一按
 *      body 里的 userId 操作的接口）
 *   4. 家长切视角 / 出绑定码指向别人家孩子 → 404
 *   5. 导出包只含自己家（导出是「把全部数据打成一份文件」，泄露最致命）
 *   6. 孩子 token 调家长接口 → 403
 *   7. 推送按家庭对齐（A 收得到、B 收不到）
 *   8. 家长代看的埋点分流（act_* 与孩子真实使用互不污染）—— 这条不是越权，
 *      是「口径正确性」：同一个孩子身份有两种来源，混在一起就再也分不开
 *      「孩子真的在用」和「家长在翻手机」，运营后台的时长数字直接失真。
 *   9. 加购与支付：订单不跨家庭读/付、孩子不能下单、加权益幂等（重复
 *      支付只加一次额度）、pay_enabled 关掉后下单 403。
 *
 * ── 负向验证过（2026-10-17）────────────────────────────────────────
 * 把 dist 里 scopeSql() 改成直接 return（等于关掉注入）后重跑：
 * **10 项当场失败**——列表 4 项（孩子/项目/商品/流水全串了）+ 跨家庭改删 6 项
 * （别人的孩子和商品真的被改了、删了）。说明这个脚本抓得到真问题，
 * 不是「永远绿」的摆设。
 *
 * 另有 6 项在关掉注入后**仍然通过**，因为它们走的是 ext 层的显式校验，
 * 不依赖注入：act-as / 出绑定码（校验 child.family_id）、临时加减分
 * （按 body 的 userId 查孩子时带家庭条件）、导出（SQL 里显式 WHERE family_id）、
 * 成长记录（显式条件）。这就是纵深防御：注入管住 220+ 条手写 SQL，
 * 关键路径再单独把一道关。
 */

import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import Database from 'better-sqlite3';
import WebSocket from 'ws';

const SERVER_DIR = path.resolve(import.meta.dirname, '..');
const ROOT_DIR = path.resolve(SERVER_DIR, '..');

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function section(t) {
  console.log(`\n[${t}]`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 用测试用的 JWT_SECRET 签一个「库里不存在的人」的 token。
 * 这是「陈旧会话」的最小复现：签名完全合法，但 sub 在 users 表里查不到。
 */
function signGhostToken(sub) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({
    role: 'parent',
    name: 'ghost',
    sub: String(sub),
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const sig = createHmac('sha256', 'tenant-isolation-test-only').update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function pushJson(arr, raw) {
  try {
    arr.push(JSON.parse(String(raw)));
  } catch {
    /* 非 JSON 帧忽略 */
  }
}

/** 连一个家长端的 WebSocket（云端版要求带 token，且 sub/role 要与查询串一致） */
function connectWs(userId, token) {
  return new Promise((resolve, reject) => {
    const url = `${BASE.replace(/^http/, 'ws')}/ws?userId=${userId}&role=parent&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000);
    ws.on('open', () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

// ── 起临时后端 ──────────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitHealthy(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`后端 ${timeoutMs}ms 内没起来`);
}

// ── HTTP ────────────────────────────────────────────────────────────────
let BASE = '';
async function call(method, p, { body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api${p}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** 断言「越权访问被拦住」：404 或 403 都算拦住了（不同接口语义不同） */
function blocked(r) {
  return r.status === 404 || r.status === 403;
}

/** 在一组记录里找某个 id —— 列表接口的返回形状各页不同，这里递归找 */
function deepHasId(obj, id) {
  if (obj === null || obj === undefined) return false;
  if (Array.isArray(obj)) return obj.some((x) => deepHasId(x, id));
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if ((k === 'id' || k.endsWith('Id') || k.endsWith('_id')) && v === id) return true;
      if (deepHasId(v, id)) return true;
    }
    return false;
  }
  return false;
}

function deepHasString(obj, s) {
  return JSON.stringify(obj ?? '').includes(s);
}

// ── 造一个家庭 ──────────────────────────────────────────────────────────
async function makeFamily(code, familyName, parentName) {
  const login = await call('POST', '/wx/login', { body: { code } });
  if (!login.json?.ticket) throw new Error(`登录失败：${JSON.stringify(login.json)}`);
  const reg = await call('POST', '/wx/register-family', {
    body: { ticket: login.json.ticket, familyName, parentName, avatar: '🐯' },
  });
  if (!reg.json?.token) throw new Error(`建家庭失败：${JSON.stringify(reg.json)}`);
  // 返回整个会话：token 用来发请求，user.id 用来连 WebSocket（第 7 节要验推送）
  return reg.json;
}

async function main() {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'gt-tenant-'));
  const child = spawn(
    process.execPath,
    [path.join(SERVER_DIR, 'dist', 'index.js')],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        JWT_SECRET: 'tenant-isolation-test-only',
        WX_MOCK: '1',
        WX_PAY_MOCK: '1',
        PIGGY_SKIP_BOOTSTRAP: '1',
        ADMIN_PASSWORD: 'tenant-test-admin',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let log = '';
  child.stdout.on('data', (b) => (log += b));
  child.stderr.on('data', (b) => (log += b));

  try {
    console.log(`临时后端：${BASE}（DATA_DIR=${dataDir}）`);
    await waitHealthy(BASE);

    // ── 造两个家庭，各带自己的孩子 / 项目 / 商品 / 流水 ──────────────
    const sessA = await makeFamily('tenant-a', '甲家', '甲家长');
    const sessB = await makeFamily('tenant-b', '乙家', '乙家长');
    const tokenA = sessA.token;
    const tokenB = sessB.token;
    // 名字带唯一后缀：后面在列表里搜字符串，避免重名误判
    const tag = `T${Date.now().toString(36)}`;

    const childA = (await call('POST', '/children', {
      token: tokenA,
      body: { name: `甲娃${tag}`, pin: '1111', avatar: 'dragon', birthday: '2018-06-01', sex: 'male' },
    })).json;
    const childB = (await call('POST', '/children', {
      token: tokenB,
      body: { name: `乙娃${tag}`, pin: '2222', avatar: 'rabbit', birthday: '2019-03-15', sex: 'female' },
    })).json;
    if (!childA?.id || !childB?.id) {
      throw new Error(`建孩子失败：A=${JSON.stringify(childA)} B=${JSON.stringify(childB)}`);
    }

    const itemA = (await call('POST', '/point-items', {
      token: tokenA,
      body: { name: `甲项${tag}`, type: 'gain', points: 5, daily_limit: 1 },
    })).json;
    const itemB = (await call('POST', '/point-items', {
      token: tokenB,
      body: { name: `乙项${tag}`, type: 'gain', points: 5, daily_limit: 1 },
    })).json;

    const prodA = (await call('POST', '/products', {
      token: tokenA,
      body: { name: `甲货${tag}`, cost: 10, stock: 5 },
    })).json;
    const prodB = (await call('POST', '/products', {
      token: tokenB,
      body: { name: `乙货${tag}`, cost: 10, stock: 5 },
    })).json;

    // 各记一笔临时加减分，产生带唯一备注的积分流水
    await call('POST', '/point-items/adjust', {
      token: tokenA,
      body: { userId: childA.id, delta: 5, note: `甲流水${tag}` },
    });
    await call('POST', '/point-items/adjust', {
      token: tokenB,
      body: { userId: childB.id, delta: 7, note: `乙流水${tag}` },
    });

    // ── 1. 列表接口不串数据 ────────────────────────────────────────
    section('1. 列表接口不串数据');

    const aChildren = await call('GET', '/children', { token: tokenA });
    check('A 的孩子列表只有自己的孩子', !deepHasString(aChildren.json, `乙娃${tag}`), `HTTP ${aChildren.status}`);
    const aItems = await call('GET', '/point-items', { token: tokenA });
    check('A 的积分项目不含 B 的项目', !deepHasString(aItems.json, `乙项${tag}`), `HTTP ${aItems.status}`);
    const aProducts = await call('GET', '/products', { token: tokenA });
    check('A 的商品不含 B 的商品', !deepHasString(aProducts.json, `乙货${tag}`), `HTTP ${aProducts.status}`);
    const aLogs = await call('GET', '/point-logs', { token: tokenA });
    check('A 的积分流水不含 B 的流水', !deepHasString(aLogs.json, `乙流水${tag}`), `HTTP ${aLogs.status}`);
    check('A 能看到自己的流水（对照组，排除「两边都空」的假通过）', deepHasString(aLogs.json, `甲流水${tag}`), `HTTP ${aLogs.status}`);

    // ── 2. 按 id 越权改删 ──────────────────────────────────────────
    section('2. 按 id 改 / 删别人家的资源');

    check('PATCH 别人家孩子 → 拦住', blocked(await call('PATCH', `/children/${childB.id}`, { token: tokenA, body: { name: '被甲改了' } })));
    const delChild = await call('DELETE', `/children/${childB.id}`, { token: tokenA });
    const bChildrenAfter = await call('GET', '/children', { token: tokenB });
    check('DELETE 别人家孩子：没删掉（B 那边还在）', deepHasString(bChildrenAfter.json, `乙娃${tag}`), `HTTP ${delChild.status}`);

    check('PATCH 别人家积分项 → 拦住', blocked(await call('PATCH', `/point-items/${itemB.id}`, { token: tokenA, body: { name: '被甲改了' } })));
    // 第 30 批修正了错误码语义：别人的项目在查询阶段就查不到 → 404 item_not_found，
    // 不再和「默认项不能删」共用 400。状态码与数据两条都要断言。
    const delItem = await call('DELETE', `/point-items/${itemB.id}`, { token: tokenA });
    const bItemsAfter = await call('GET', '/point-items', { token: tokenB });
    check('DELETE 别人家积分项 → 404 item_not_found', delItem.status === 404 && delItem.json?.error === 'item_not_found', `HTTP ${delItem.status} ${delItem.json?.error ?? ''}`);
    check('DELETE 别人家积分项：没删掉（B 那边还在）', deepHasString(bItemsAfter.json, `乙项${tag}`), `HTTP ${bItemsAfter.status}`);

    // 回归：默认项目仍然必须是 400 cannot_delete_default（别把语义改宽了）。
    // 新建家庭的模板项目 is_default 是 0，只有自建版升级上来的老数据才有 is_default=1，
    // 而 API 没有写这个词的入口 —— 所以直接在库层标一条，再走接口删。
    {
      const raw = new Database(path.join(dataDir, 'money-jar.db'));
      raw.pragma('busy_timeout = 3000');
      raw.prepare('UPDATE point_items SET is_default = 1 WHERE id = ?').run(itemA.id);
      raw.close();
      const delDef = await call('DELETE', `/point-items/${itemA.id}`, { token: tokenA });
      check('删自己家的默认项 → 400 cannot_delete_default（回归）', delDef.status === 400 && delDef.json?.error === 'cannot_delete_default', `HTTP ${delDef.status} ${delDef.json?.error ?? ''}`);
    }
    const ghost = await call('DELETE', '/point-items/999999', { token: tokenA });
    check('删一个不存在的项目 → 404 item_not_found', ghost.status === 404 && ghost.json?.error === 'item_not_found', `HTTP ${ghost.status} ${ghost.json?.error ?? ''}`);

    check('PATCH 别人家商品 → 拦住', blocked(await call('PATCH', `/products/${prodB.id}`, { token: tokenA, body: { name: '被甲改了' } })));
    const delProd = await call('DELETE', `/products/${prodB.id}`, { token: tokenA });
    const bProdAfter = await call('GET', '/products', { token: tokenB });
    check('DELETE 别人家商品：没删掉（B 那边还在）', deepHasString(bProdAfter.json, `乙货${tag}`), `HTTP ${delProd.status}`);

    check('GET 别人家孩子的成长记录 → 拦住', blocked(await call('GET', `/growth/children/${childB.id}/records`, { token: tokenA })));

    // 最关键的一条：临时加减分是按 body 里的 userId 操作的
    section('3. 临时加减分不能点到别人家孩子');
    const crossAdjust = await call('POST', '/point-items/adjust', {
      token: tokenA,
      body: { userId: childB.id, delta: 100, note: `越权加分${tag}` },
    });
    check('A 给 B 家孩子加分 → 拦住', blocked(crossAdjust), `HTTP ${crossAdjust.status}`);
    // 反向确认真的没加分：B 查看自己孩子的余额
    const bDash = await call('GET', '/dashboard', { token: tokenB });
    check('B 家孩子余额没被改动', !deepHasString(bDash.json, '越权加分'), `HTTP ${bDash.status}`);

    // ── 4. 切视角 / 绑定码 ────────────────────────────────────────
    section('4. 家长切视角与绑定码');
    check('A 切到 B 家孩子视角 → 拦住', blocked(await call('POST', '/family/act-as', { token: tokenA, body: { childId: childB.id } })));
    check('A 给 B 家孩子出绑定码 → 拦住', blocked(await call('POST', '/family/child-bind-codes', { token: tokenA, body: { childId: childB.id } })));

    // ── 5. 家庭信息与导出 ────────────────────────────────────────
    section('5. 家庭信息与导出包');
    const famB = await call('GET', '/family', { token: tokenB });
    check('B 的家庭信息里没有 A 的成员', !deepHasString(famB.json, '甲家长'), `HTTP ${famB.status}`);
    // 数据导出按家庭开通（默认关，关闭时 403）：先通过后台给 A 家打开，导出断言才有意义
    const adminTok5 = (await call('POST', '/admin/login', { body: { username: 'admin', password: 'tenant-test-admin' } })).json?.token;
    const famRows5 = adminTok5 ? (await call('GET', '/admin/families?size=50', { token: adminTok5 })).json?.rows ?? [] : [];
    const famAId5 = famRows5.find((f) => f.name === '甲家')?.id;
    check('后台能找到 A 家（导出开通的前提）', !!famAId5, `HTTP ${famRows5 ? 200 : 0}`);
    if (famAId5) {
      check('后台给 A 家开通数据导出', (await call('PATCH', `/admin/families/${famAId5}`, { token: adminTok5, body: { exportEnabled: true } })).status === 200);
    }
    const expA = await call('GET', '/export', { token: tokenA });
    check('A 的导出包里没有 B 家孩子', extOk(expA) && !deepHasString(expA.json, `乙娃${tag}`), `HTTP ${expA.status}`);
    check('A 的导出包里也没有 B 家流水', extOk(expA) && !deepHasString(expA.json, `乙流水${tag}`), `HTTP ${expA.status}`);
    check('A 的导出包含自己的数据（对照组）', extOk(expA) && deepHasString(expA.json, `甲娃${tag}`), `HTTP ${expA.status}`);

    // ── 6. 角色越权 ─────────────────────────────────────────────
    section('6. 孩子 token 不能调家长接口');
    const childToken = await bindChild(childA.id, 'tenant-child-a', tokenA);
    if (!childToken) {
      check('孩子身份登录成功（后续越权断言的前提）', false, '拿不到孩子 token');
    } else {
      check('孩子 POST /children → 403', (await call('POST', '/children', { token: childToken, body: { name: 'x', pin: '9999' } })).status === 403);
      check('孩子 POST /point-items → 403', (await call('POST', '/point-items', { token: childToken, body: { name: 'x', type: 'gain', points: 1, daily_limit: 1 } })).status === 403);
      check('孩子 GET /export → 403', (await call('GET', '/export', { token: childToken })).status === 403);
      check('孩子 GET /export/attachments → 403', (await call('GET', '/export/attachments', { token: childToken })).status === 403);
      const admin = await call('GET', '/admin/overview', { token: childToken });
      check('孩子碰运营后台 → 拦住', admin.status === 401 || admin.status === 403, `HTTP ${admin.status}`);
      const fam = await call('GET', '/family', { token: childToken });
      check('孩子拿不到家庭管理接口', fam.status === 403 || fam.status === 401, `HTTP ${fam.status}`);
    }

    // ── 7. 推送按家庭对齐 ───────────────────────────────────────
    // 「两个家长同时开着积分页、一个删了另一个还在点」的根治靠的就是这条推送。
    // 这里同时验两件事：A 端收得到；**B 端收不到**（推送越界 = 把别人家的
    // 项目 id 和变更动作告诉了无关的人，和列表串数据是同一类事故）。
    section('7. 积分项目变更推送（按家庭对齐）');
    const wsA = await connectWs(sessA.user.id, tokenA);
    const wsB = await connectWs(sessB.user.id, tokenB);
    const msgsA = [];
    const msgsB = [];
    wsA.on('message', (r) => pushJson(msgsA, r));
    wsB.on('message', (r) => pushJson(msgsB, r));
    await sleep(300);

    const pushed = await call('POST', '/point-items', {
      token: tokenA,
      body: { name: `推送项${tag}`, type: 'gain', points: 1, daily_limit: 1 },
    });
    await sleep(700);

    check('A 端收到 point_items_changed', msgsA.some((m) => m.type === 'point_items_changed'), `收到 ${msgsA.length} 条`);
    check('B 端收不到 A 家的推送（按家庭对齐）', !msgsB.some((m) => m.type === 'point_items_changed'), `收到 ${msgsB.length} 条`);
    wsA.close();
    wsB.close();
    if (pushed.json?.id) await call('DELETE', `/point-items/${pushed.json.id}`, { token: tokenA });

    // ── 8. 家长代看的埋点分流 ───────────────────────────────────
    // 「家长一键切孩子视角」和「孩子自己用」用的是同一个孩子身份，
    // 埋点如果不分流，运营后台的「孩子今天用了 2 小时」里有一大半是家长在翻手机。
    // 这个数字既是产品粘性的判据、也是付费转化的判据，掺了假就没用了。
    // 判据是 JWT 里的 act（= 代看的那位家长 userId），服务端据此只累加 act_* 两列。
    section('8. 家长代看埋点与孩子真实使用分流');

    const actRes = await call('POST', '/family/act-as', { token: tokenA, body: { childId: childA.id } });
    const actToken = actRes.json?.token;
    check('act-as 拿到代看 token', !!actToken && actRes.json?.user?.id === childA.id, `HTTP ${actRes.status}`);
    if (actToken) {
      const claims = jwtClaims(actToken);
      check('代看 token 的 act = 家长 userId', claims.act === sessA.user.id, `act=${claims.act}`);
      check('代看 token 的 sub 仍是孩子', Number(claims.sub) === childA.id, `sub=${claims.sub}`);
    }

    /** 直接读库看 usage_daily（平台表，不经过租户注入） */
    const usageOf = (userId) => {
      const raw = new Database(path.join(dataDir, 'money-jar.db'));
      raw.pragma('busy_timeout = 3000');
      const row = raw
        .prepare(
          `SELECT requests, active_seconds, act_requests, act_seconds
             FROM usage_daily
            WHERE user_id = ? AND day = date('now','localtime')`
        )
        .get(userId);
      raw.close();
      return row ?? { requests: 0, active_seconds: 0, act_requests: 0, act_seconds: 0 };
    };

    if (actToken && childToken) {
      // 家长代看：3 次普通请求 + 1 次心跳（60 秒）
      // 用 /dashboard/me 而不是 /dashboard —— 后者是家长端接口，孩子身份会 403。
      // 403 也会被埋点计数，那样这个断言就成了「数错误请求」，说明不了口径对不对。
      const before = usageOf(childA.id);
      const actCalls = [];
      for (let i = 0; i < 3; i += 1) {
        actCalls.push((await call('GET', '/dashboard/me', { token: actToken })).status);
      }
      await call('POST', '/usage/heartbeat', { token: actToken, body: { seconds: 60 } });
      const after = usageOf(childA.id);
      check('代看调的接口真的通了（不是 403 充数）', actCalls.every((s) => s === 200), `HTTP ${actCalls.join(',')}`);
      check('代看的请求进 act_requests', after.act_requests - before.act_requests === 4, `${before.act_requests} → ${after.act_requests}（3 请求 + 1 心跳）`);
      check('代看不动孩子的 requests', after.requests === before.requests, `${before.requests} → ${after.requests}`);
      check('代看的心跳进 act_seconds', after.act_seconds - before.act_seconds >= 60, `${before.act_seconds} → ${after.act_seconds}`);
      check('代看不动孩子的 active_seconds', after.active_seconds === before.active_seconds, `${before.active_seconds} → ${after.active_seconds}`);

      // 对照组：孩子本人（第 6 节绑出来的 token，不带 act）真实使用 2 请求 + 45 秒心跳
      const beforeKid = usageOf(childA.id);
      const kidCalls = [];
      for (let i = 0; i < 2; i += 1) {
        kidCalls.push((await call('GET', '/dashboard/me', { token: childToken })).status);
      }
      await call('POST', '/usage/heartbeat', { token: childToken, body: { seconds: 45 } });
      const afterKid = usageOf(childA.id);
      check('孩子自己调的接口通了', kidCalls.every((s) => s === 200), `HTTP ${kidCalls.join(',')}`);
      check('孩子真实请求进 requests', afterKid.requests - beforeKid.requests === 3, `${beforeKid.requests} → ${afterKid.requests}（2 请求 + 1 心跳）`);
      check('孩子真实心跳进 active_seconds', afterKid.active_seconds - beforeKid.active_seconds >= 45, `${beforeKid.active_seconds} → ${afterKid.active_seconds}`);
      check(
        '孩子真实使用不进 act_*（两条口径互不污染）',
        afterKid.act_requests === beforeKid.act_requests && afterKid.act_seconds === beforeKid.act_seconds,
        `act ${beforeKid.act_requests}/${beforeKid.act_seconds} → ${afterKid.act_requests}/${afterKid.act_seconds}`
      );
    }

    // 运营后台要能同时看到「孩子真实使用」和「家长代看」两个数
    const adminLogin = await call('POST', '/admin/login', {
      body: { username: 'admin', password: 'tenant-test-admin' },
    });
    const adminToken = adminLogin.json?.token;
    if (adminToken) {
      const ov = await call('GET', '/admin/overview', { token: adminToken });
      const act7 = ov.json?.usage?.actSeconds7;
      check('运营后台 overview 给出 actSeconds7', typeof act7 === 'number' && act7 >= 60, `actSeconds7=${act7}`);
      check('运营后台 overview 仍保留 activeSeconds7', typeof ov.json?.usage?.activeSeconds7 === 'number', `activeSeconds7=${ov.json?.usage?.activeSeconds7}`);
    } else {
      check('后台登录成功（后续断言前提）', false, `HTTP ${adminLogin.status} ${JSON.stringify(adminLogin.json)}`);
    }

    // ── 9. 加购与支付 ───────────────────────────────────────────
    // 钱相关的接口有三条红线：
    //   ① 订单不许跨家庭读/付（订单号是递增的，不校验 family_id 就能翻别人的单）
    //   ② 孩子不能发起购买（付款必须落到成年人身上）
    //   ③ 加权益必须幂等 —— 回调重放一次就多送一个名额，这种 bug 只会表现为
    //      「额度莫名其妙多了」，没有任何报错，只能靠这里的事务 + 条件更新挡住。
    // 顺带验开关：pay_enabled=0 时下单要 403（运营关掉购买后不能留下可钻的口子）。
    section('9. 加购与支付（越权 + 幂等 + 开关）');

    const adminLogin9 = await call('POST', '/admin/login', {
      body: { username: 'admin', password: 'tenant-test-admin' },
    });
    const adminTok9 = adminLogin9.json?.token;
    check('后台登录（第 9 节前提）', !!adminTok9, `HTTP ${adminLogin9.status}`);
    if (adminTok9) {
      // 默认 pay_enabled=0，先打开，跑完越权与幂等再关掉验一次
      const en = await call('PATCH', '/admin/config', { token: adminTok9, body: { pay_enabled: 1 } });
      check('后台打开加购开关', en.status === 200, `HTTP ${en.status}`);

      if (childToken) {
        check(
          '孩子 POST /pay/orders → 403',
          (await call('POST', '/pay/orders', { token: childToken, body: { kind: 'child_slot', qty: 1 } })).status === 403
        );
      }

      const quotaOf = (familyId) => {
        const raw = new Database(path.join(dataDir, 'money-jar.db'));
        raw.pragma('busy_timeout = 3000');
        const row = raw.prepare('SELECT paid_child_slots, paid_child_expires FROM families WHERE id = ?').get(familyId);
        raw.close();
        return row ?? { paid_child_slots: 0, paid_child_expires: 0 };
      };
      // 2026-10-21 批次 W：名额从 families 上的池列改成 child_slot_credits 券表。
      // 「有多少名额」= 未退款的券数；断言一律走这里，不再看 paid_child_slots。
      const creditsOf = (familyId) => {
        const raw = new Database(path.join(dataDir, 'money-jar.db'));
        raw.pragma('busy_timeout = 3000');
        const row = raw
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN used_by_user_id IS NULL THEN 1 ELSE 0 END) AS unused,
                    COALESCE(MAX(months), 0) AS maxMonths
               FROM child_slot_credits WHERE family_id = ? AND refunded_at = 0`
          )
          .get(familyId);
        raw.close();
        return { total: row?.total ?? 0, unused: row?.unused ?? 0, maxMonths: row?.maxMonths ?? 0 };
      };
      const famAId = sessA.family?.id;

      // 2026-11-04 v2.3：名额一次只能买 1 个（maxQty=1），金额 = 1 年整包价 2990
      const ord = await call('POST', '/pay/orders', { token: tokenA, body: { kind: 'child_slot', qty: 1 } });
      const orderId = ord.json?.order?.id;
      check('家长下单成功', ord.status === 200 && !!orderId, `HTTP ${ord.status}`);
      // 金额必须服务端现算：默认 1 年包价 2990 分。客户端传什么价格都不影响这一列
      check('金额服务端现算（1 年包价 2990）', ord.json?.order?.amountCents === 2990, `amountCents=${ord.json?.order?.amountCents}`);
      check('订单带时长 termYears=1', ord.json?.order?.termYears === 1, `termYears=${ord.json?.order?.termYears}`);
      check('订单带商户订单号 outTradeNo', typeof ord.json?.order?.outTradeNo === 'string' && ord.json.order.outTradeNo.length > 5, `${ord.json?.order?.outTradeNo}`);
      check('一次买 6 个名额 → 400（单次上限 1）', (await call('POST', '/pay/orders', { token: tokenA, body: { kind: 'child_slot', qty: 6 } })).status === 400);
      check('买 6 年 → 400（超出时长上限）', (await call('POST', '/pay/orders', { token: tokenA, body: { kind: 'child_slot', qty: 1, years: 6 } })).status === 400);
      check(
        '报价接口可用且与下单口径一致',
        (await call('GET', '/pay/quote?kind=child_slot&qty=1&years=1', { token: tokenA })).json?.quote?.grossCents === 2990
      );

      if (orderId) {
        check('乙家读甲家的订单 → 404', (await call('GET', `/pay/orders/${orderId}`, { token: tokenB })).status === 404);
        check('乙家替甲家的单付款 → 404', (await call('POST', `/pay/orders/${orderId}/mock-pay`, { token: tokenB })).status === 404);

        const credBefore = creditsOf(famAId);
        const pay1 = await call('POST', `/pay/orders/${orderId}/mock-pay`, { token: tokenA });
        check('甲家支付成功', pay1.status === 200 && pay1.json?.ok === true && pay1.json?.already === false, `HTTP ${pay1.status} already=${pay1.json?.already}`);
        const credMid = creditsOf(famAId);
        const pay2 = await call('POST', `/pay/orders/${orderId}/mock-pay`, { token: tokenA });
        check('重复支付幂等（already=true）', pay2.status === 200 && pay2.json?.already === true, `HTTP ${pay2.status} already=${pay2.json?.already}`);
        const credAfter = creditsOf(famAId);
        // 方案B → 批次 W：名额进「券表」，买几张落几张（未分配、不计时）
        check('名额券 +1 且只加一次', credAfter.total - credBefore.total === 1 && credMid.total - credBefore.total === 1, `${credBefore.total} → ${credMid.total} → ${credAfter.total}`);
        check('券带时长（12 个月 = 1 年）', credAfter.maxMonths === 12, `maxMonths=${credAfter.maxMonths}`);
        // 配额接口要把券算进去：免费 1 个 + 券 1 张 = 2（家庭信息走 GET /family）
        check('孩子配额接口包含券（1 + 1 = 2）', (await call('GET', '/family', { token: tokenA })).json?.family?.childQuota?.limit === 2, `limit=${(await call('GET', '/family', { token: tokenA })).json?.family?.childQuota?.limit}`);

        // 二次购买：已有 1 张券，再买 1 个 × 2 年 → 待分配 2 张，金额无抵扣
        const q2 = (await call('GET', '/pay/quote?kind=child_slot&qty=1&years=2', { token: tokenA })).json?.quote;
        check('二次购买报价含池容量 2', q2?.poolAfter === 2, `poolAfter=${q2?.poolAfter}`);
        check('二次购买无抵扣，金额 = 2 年包价 5190', q2?.grossCents === 5190, `gross=${q2?.grossCents}`);
        const ord2 = await call('POST', '/pay/orders', { token: tokenA, body: { kind: 'child_slot', qty: 1, years: 2 } });
        check('二次下单成功', ord2.status === 200, `HTTP ${ord2.status}`);
        if (ord2.json?.order?.id) {
          await call('POST', `/pay/orders/${ord2.json.order.id}/mock-pay`, { token: tokenA });
        }
        const credAfter2 = creditsOf(famAId);
        check('券合并为 2 张', credAfter2.total === 2, `slots=${credAfter2.total}`);
        check('二次买的券带 24 个月时长', credAfter2.maxMonths === 24, `maxMonths=${credAfter2.maxMonths}`);

        // 后台视角：运营要能看到这笔单，但**看不到 family_id 这个内部列** ——
        // 全局响应清洗会把 family_id / familyId 抹掉，所以后台用的是 familyRef。
        // 这条断言同时守住两件事：订单确实进了后台；清洗没有被绕过。
        const ao = await call('GET', '/admin/orders?size=50', { token: adminTok9 });
        const arow = (ao.json?.rows || []).find((r) => r.id === orderId);
        check('后台订单列表能看到这笔单', ao.status === 200 && !!arow, `HTTP ${ao.status}`);
        check(
          '订单带家庭引用 familyRef，且没有 familyId 噪音',
          !!arow && arow.familyRef === famAId && arow.familyId === undefined,
          arow ? `familyRef=${arow.familyRef} familyId=${arow.familyId}` : '没有这一行'
        );
        check('家长 token 打后台订单接口 → 401', (await call('GET', '/admin/orders', { token: tokenA })).status === 401);
      }

      const off = await call('PATCH', '/admin/config', { token: adminTok9, body: { pay_enabled: 0 } });
      check('后台关闭加购开关', off.status === 200, `HTTP ${off.status}`);
      check('关闭加购后下单 → 403', (await call('POST', '/pay/orders', { token: tokenA, body: { kind: 'storage_gb', qty: 1 } })).status === 403);
      await call('PATCH', '/admin/config', { token: adminTok9, body: { pay_enabled: 1 } });

      /* ── 9b. 加购计价（2026-11-05 多年制 + 等值折算 + 年数折扣）────────
       *  ① 名额买过一次之后再买一个，**必须还要付钱**（无抵扣，整包价）。
       *  ② 空间「扩容到 N GB」1–5 年可选：应付 = P(target) × 年数 × 折扣，
       *     折扣 1 年不打折 / 2 年 9.2 折…；旧池剩余时间按 1 年价
       *     P(cur)/P(target) 等值折算成天数（向上取整），叠加在
       *     「付款日 + N 年」之后。纯续费折算率 1:1。 */
      section('9b. 加购计价（再买一次要付钱 / 空间多年制 + 年数折扣）');

      // 此时甲家名额池已有 2 张券。再买 1 个：无抵扣、付 1 年整包价。
      const qc = (await call('GET', '/pay/quote?kind=child_slot&qty=1&years=1', { token: tokenA })).json?.quote;
      check('名额池已有 2 张券：这次买 1 个的抵扣为 0', qc?.deductionCents === 0, `deduction=${qc?.deductionCents}`);
      check('名额池已有 2 张券：应付仍是 2990 分（不是 0）', qc?.amountCents === 2990, `amount=${qc?.amountCents}`);
      check('名额池已有 2 张券：合并后 3 个', qc?.poolAfter === 3, `poolAfter=${qc?.poolAfter}`);

      const storagePoolOf = (familyId) => {
        const raw = new Database(path.join(dataDir, 'money-jar.db'));
        raw.pragma('busy_timeout = 3000');
        const row = raw.prepare('SELECT paid_storage_bytes, paid_storage_expires FROM families WHERE id = ?').get(familyId);
        raw.close();
        return row ?? { paid_storage_bytes: 0, paid_storage_expires: 0 };
      };
      const GB_BYTES = 1024 * 1024 * 1024;
      const YEAR_SECONDS = 365 * 86400;

      check('空间池一开始是空的', storagePoolOf(famAId).paid_storage_bytes === 0);

      // 第 1 次：扩容到 1 GB。没有任何旧容量，付整包价 990 分。
      const st1 = await call('POST', '/pay/orders', { token: tokenA, body: { kind: 'storage_gb', qty: 1, years: 1 } });
      check('扩容到 1 GB 下单成功', st1.status === 200 && !!st1.json?.order?.id, `HTTP ${st1.status}`);
      check('扩容到 1 GB：应付 = 1GB 包价 990 分', st1.json?.order?.amountCents === 990, `amount=${st1.json?.order?.amountCents}`);
      if (st1.json?.order?.id) {
        await call('POST', `/pay/orders/${st1.json.order.id}/mock-pay`, { token: tokenA });
      }
      check('到账后空间池 = 1 GB', storagePoolOf(famAId).paid_storage_bytes === GB_BYTES, `bytes=${storagePoolOf(famAId).paid_storage_bytes}`);

      // 第 2 次：扩容到 2 GB × 1 年（多年制 + 等值折算 + ceil）。
      //   应付 = P(2) × 1 年 × 不打折 = 1980（1 年档恒不打折）；
      //   旧池 1GB 剩约 365 天，折算率 P(1)/P(2) = 0.5 → 折算 ceil(约182.x) 天
      //   （向上取整，不足 1 天按 1 天送）；
      //   到期 = 付款日 + 365 天 + 折算天数（不再从旧到期日顺延）。
      const sq = (await call('GET', '/pay/quote?kind=storage_gb&qty=2&years=1', { token: tokenA })).json?.quote;
      const nowSec = Math.floor(Date.now() / 1000);
      check('扩容到 2 GB×1 年：应付 = P(2) = 1980（1 年不打折）', sq?.amountCents === 1980, `amount=${sq?.amountCents}`);
      check('扩容到 2 GB×1 年：discBp = 10000', sq?.storageDiscBp === 10000, `bp=${sq?.storageDiscBp}`);
      check('扩容到 2 GB：旧池折算 182~183 天（ceil 向上取整）',
        sq?.storageCarryDays >= 182 && sq?.storageCarryDays <= 183,
        `carry=${sq?.storageCarryDays}`);
      check('扩容到 2 GB：到期 = 付款日 + 365 天 + 折算',
        Math.abs(sq?.poolExpiresAfter - (nowSec + YEAR_SECONDS + 182.5 * 86400)) < 86400,
        `after=${sq?.poolExpiresAfter}`);
      check('扩容到 2 GB：不再有「旧池抵扣」这笔', sq?.deductionCents === 0, `deduction=${sq?.deductionCents}`);
      check('扩容到 2 GB：合并后池子是 2 GB', sq?.poolAfter === 2, `poolAfter=${sq?.poolAfter}`);
      check('扩容到 2 GB：新增容量是 1 GB', sq?.addedQty === 1 && sq?.storageAddGb === 1, `addedQty=${sq?.addedQty}`);

      const st2 = await call('POST', '/pay/orders', { token: tokenA, body: { kind: 'storage_gb', qty: 2, years: 1 } });
      check('扩容到 2 GB 下单并到账', st2.status === 200, `HTTP ${st2.status}`);
      if (st2.json?.order?.id) {
        await call('POST', `/pay/orders/${st2.json.order.id}/mock-pay`, { token: tokenA });
      }
      check('到账后空间池 = 2 GB（不是相加成 3 GB）', storagePoolOf(famAId).paid_storage_bytes === 2 * GB_BYTES, `bytes=${storagePoolOf(famAId).paid_storage_bytes}`);

      // 缩小 → 拒绝。否则「扩容」会被用成退费通道。
      const shrink = await call('GET', '/pay/quote?kind=storage_gb&qty=1&years=1', { token: tokenA });
      check('缩容（2 GB → 1 GB）→ 400', shrink.status === 400, `HTTP ${shrink.status} ${shrink.json?.error}`);

      // 纯续费（容量不变、只买 1 年）：
      // 应付 = P(2) = 1980；折算率 1:1 → 到期 = 旧到期 + 365 天（与旧顺延规则一致）
      const renew1 = (await call('GET', '/pay/quote?kind=storage_gb&qty=2&years=1', { token: tokenA })).json?.quote;
      check('纯续费 1 年：应付 = P(2) = 1980', renew1?.amountCents === 1980, `amount=${renew1?.amountCents}`);
      check('纯续费 1 年：新增容量 0', renew1?.addedQty === 0, `addedQty=${renew1?.addedQty}`);
      check('纯续费 1 年：到期日在原到期日基础上顺延 365 天（折算率 1:1）',
        Math.abs(renew1?.poolExpiresAfter - (renew1?.poolExpiresBefore + YEAR_SECONDS)) <= 5,
        `delta=${(renew1?.poolExpiresAfter ?? 0) - (renew1?.poolExpiresBefore ?? 0)}`);

      // 空间多年制（2026-11-05 定稿）：years=3 合法，应付 = P(2)×3×0.85 = 5049；
      // years=6 越界 → 400 invalid_years
      const renew3 = (await call('GET', '/pay/quote?kind=storage_gb&qty=2&years=3', { token: tokenA })).json?.quote;
      check('空间多年制：2GB×3 年 = 5049（1980×3×0.85）', renew3?.amountCents === 5049,
        `amount=${renew3?.amountCents}`);
      check('空间多年制：discBp = 8500', renew3?.storageDiscBp === 8500, `bp=${renew3?.storageDiscBp}`);
      check('空间多年制：到期 = now + 3 年 + 折算',
        Math.abs(renew3?.poolExpiresAfter - (nowSec + 3 * YEAR_SECONDS + (renew3?.storageCarryDays ?? 0) * 86400)) <= 5,
        `after=${renew3?.poolExpiresAfter}`);
      const renew6 = await call('GET', '/pay/quote?kind=storage_gb&qty=2&years=6', { token: tokenA });
      check(
        '空间多年制：years=6 → 400 invalid_years',
        renew6.status === 400 && renew6.json?.error === 'invalid_years',
        `HTTP ${renew6.status} ${renew6.json?.error}`
      );

      /* ── 9c. 孩子席位（名额到期 → 那个账号不能用）──────────────────
       * 用户要求：「购买了一个孩子名额，但到期后这个孩子的账户就不能使用了」。
       * 批次 W 起到期日挂在**每个孩子自己身上**（users.slot_expires），
       * 这里直接改库把第二个孩子的到期拨到过去，验三件事：
       *   · 家长端能拿到「被锁的是谁」；
       *   · 被锁那个孩子的 token 打业务接口 → 403 child_seat_locked；
       *   · 同一个孩子仍然能读 /status/limits（否则他连原因都看不到）。 */
      section('9c. 孩子席位（名额到期 → 账号锁定）');

      const secondChild = (await call('POST', '/children', {
        token: tokenA,
        body: { name: `甲娃二号${tag}`, pin: '3333', avatar: 'rabbit', birthday: '2020-01-01', sex: 'female' },
      })).json;
      check('再建一个孩子（名额够）', !!secondChild?.id, JSON.stringify(secondChild).slice(0, 80));

      const expireNow = Math.floor(Date.now() / 1000) - 60;
      {
        const raw = new Database(path.join(dataDir, 'money-jar.db'));
        raw.pragma('busy_timeout = 3000');
        raw
          .prepare("UPDATE users SET slot_expires = ? WHERE id = ? AND role = 'child'")
          .run(expireNow, secondChild.id);
        raw.close();
      }

      const lim = (await call('GET', '/status/limits', { token: tokenA })).json;
      check('家长端看得到有孩子名额到期', lim?.seat?.paidExpired === true, `paidExpired=${lim?.seat?.paidExpired}`);
      check('家长端看得到被锁的孩子（到期那个）', Array.isArray(lim?.seat?.lockedChildIds) && lim.seat.lockedChildIds.length >= 1, `locked=${JSON.stringify(lim?.seat?.lockedChildIds)}`);
      check('第一个孩子没有被锁（免费名额永久）', Array.isArray(lim?.seat?.lockedChildIds) && !lim.seat.lockedChildIds.includes(childA.id), `locked=${JSON.stringify(lim?.seat?.lockedChildIds)}`);
      check('第二个孩子被锁', Array.isArray(lim?.seat?.lockedChildIds) && lim.seat.lockedChildIds.includes(secondChild?.id), `locked=${JSON.stringify(lim?.seat?.lockedChildIds)}`);

      const lockedToken = await bindChild(secondChild.id, 'tenant-child-a2', tokenA);
      if (lockedToken) {
        const blockedDash = await call('GET', '/dashboard/me', { token: lockedToken });
        check('被锁孩子的业务接口 → 403 child_seat_locked', blockedDash.status === 403 && blockedDash.json?.error === 'child_seat_locked', `HTTP ${blockedDash.status} ${blockedDash.json?.error}`);
        const stillCan = await call('GET', '/status/limits', { token: lockedToken });
        check('被锁孩子仍能读 /status/limits（要能看见原因）', stillCan.status === 200 && stillCan.json?.me?.locked === true, `HTTP ${stillCan.status} locked=${stillCan.json?.me?.locked}`);
        const remind = await call('POST', '/mailbox/messages', { token: lockedToken, body: { content: '我的账号到期了' } });
        check('被锁孩子仍能发树洞留言（提醒家长）', remind.status === 200, `HTTP ${remind.status}`);
        // 第一个孩子没被锁 → 照常能用
        const okChild = await call('GET', '/dashboard/me', { token: childToken });
        check('没被锁的孩子照常能用', okChild.status === 200, `HTTP ${okChild.status}`);
      } else {
        check('被锁孩子能拿到 token（第 9c 节前提）', false);
      }

      // 还原第 2 个孩子的到期日：第 12 节还要给它续费
      {
        const raw = new Database(path.join(dataDir, 'money-jar.db'));
        raw.pragma('busy_timeout = 3000');
        raw
          .prepare("UPDATE users SET slot_expires = 0 WHERE id = ? AND role = 'child'")
          .run(secondChild.id);
        raw.close();
      }
      check(
        '还原第 2 个孩子的到期日（后续章节依赖）',
        ((await call('GET', '/status/limits', { token: tokenA })).json?.seat?.lockedChildIds ?? []).length === 0
      );


      // ── 10. 陈旧会话：签名合法但库里没这个人 ───────────────────────
      // 场景：换过 JWT_SECRET 之前的旧 token、数据回滚后客户端还留着 token、
      // 账号被运营删除。这时**必须**是 401（重新登录），不能是 500 ——
      // 500 会连带把 TenantScopeError / runWithTenant 这些实现细节
      // 写进响应体（2026-10-17 在开发者工具里真实遇到过）。
      section('10. 陈旧会话（token 有效但用户不存在）');
      const ghost = signGhostToken(999999);
      const ghostRes = await call('GET', '/auth/me', { token: ghost });
      check('陈旧 token 访问 /auth/me → 401 而不是 500', ghostRes.status === 401, `HTTP ${ghostRes.status}`);
      check('错误码是 session_stale', ghostRes.json?.error === 'session_stale', `error=${ghostRes.json?.error}`);
      check(
        '响应体不泄露内部实现',
        !JSON.stringify(ghostRes.json ?? {}).includes('TenantScope'),
        '未出现 TenantScopeError'
      );
      const ghost2 = await call('GET', '/children', { token: ghost });
      check('陈旧 token 访问业务接口 → 401', ghost2.status === 401, `HTTP ${ghost2.status}`);

      // ── 11. 兑换码（2026-10-21 批次 AA 改版）────────────────────────
      // 兑换码从「名额+空间合并码」拆成两类单项码，且名额时长码必须绑到孩子。
      // 这里守七件事：
      //   ① 一个码只能兑一次，重复兑换不重复发权益；
      //   ② 孩子不能兑、不能看预览（家庭资产变动只能由家长发起）；
      //   ③ 名额时长码必须指定目标（newChildName / childId），按码面时长顺延；
      //   ④ 名额永久码 = 基础配额 +1（不走券）；空间永久码 = 基础存储配额加大；
      //   ⑤ 空间 1 年码按字节并进付费池，从现有到期日顺延；
      //   ⑥ 兑换落 0 元单（orders.redeem_label），用户订单中心与后台都可见；
      //   ⑦ 生成参数校验挡在入口（无 kind / 超量 / 超时长 / 单位混填一律 400）。
      section('11. 兑换码（批次 AA：单项码 + 绑孩子 + 双记录）');

      // 直接读库的工具：家庭基础配额 / 存储基础配额 / 孩子到期日 / 某孩子的有效券
      const famOf = (familyId) => {
        const raw = new Database(path.join(dataDir, 'money-jar.db'));
        raw.pragma('busy_timeout = 3000');
        const row = raw
          .prepare('SELECT child_quota, storage_quota_bytes, paid_storage_bytes, paid_storage_expires FROM families WHERE id = ?')
          .get(familyId);
        raw.close();
        return row ?? {};
      };
      const childExpiryOf = (userId) => {
        const raw = new Database(path.join(dataDir, 'money-jar.db'));
        raw.pragma('busy_timeout = 3000');
        const row = raw.prepare('SELECT slot_expires FROM users WHERE id = ?').get(userId);
        raw.close();
        return row?.slot_expires ?? 0;
      };
      const freeChildOf = (familyId) => {
        const raw = new Database(path.join(dataDir, 'money-jar.db'));
        raw.pragma('busy_timeout = 3000');
        const row = raw
          .prepare("SELECT id FROM users WHERE family_id = ? AND role = 'child' AND COALESCE(slot_expires, 0) = 0 ORDER BY id LIMIT 1")
          .get(familyId);
        raw.close();
        return row?.id ?? 0;
      };
      const YEAR = 365 * 86400;
      const MB = 1024 * 1024;

      const genC = await call('POST', '/admin/redeem-codes', {
        token: adminTok9,
        body: { count: 2, kind: 'child_slot', childMonths: 12 },
      });
      const codesC = genC.json?.codes || [];
      check('后台生成名额时长码 ×2（1 年）', genC.status === 200 && codesC.length === 2, `codes=${codesC.join(',')}`);
      check(
        '码是 12 位、去掉了易混字符（0O1I）',
        codesC.length > 0 && codesC.every((c) => /^[A-HJ-NP-Z2-9]{12}$/.test(c)),
        codesC[0]
      );

      const genD = await call('POST', '/admin/redeem-codes', {
        token: adminTok9,
        body: { count: 1, kind: 'child_slot', childDays: 7 },
      });
      const codeD = genD.json?.codes?.[0];
      const genP = await call('POST', '/admin/redeem-codes', {
        token: adminTok9,
        body: { count: 1, kind: 'child_slot', childPermanent: true },
      });
      const codeP = genP.json?.codes?.[0];
      const genG = await call('POST', '/admin/redeem-codes', {
        token: adminTok9,
        body: { count: 1, kind: 'storage', storageGb: 5 },
      });
      const codeG = genG.json?.codes?.[0];
      const genM = await call('POST', '/admin/redeem-codes', {
        token: adminTok9,
        body: { count: 1, kind: 'storage', storageMb: 512, storagePermanent: true },
      });
      const codeM = genM.json?.codes?.[0];
      check('生成天数码 / 永久码 / 空间 GB 码 / 空间 MB 永久码', !!codeD && !!codeP && !!codeG && !!codeM, `D=${codeD} P=${codeP} G=${codeG} M=${codeM}`);

      // 生成参数校验
      check(
        '缺 kind → 400',
        (await call('POST', '/admin/redeem-codes', { token: adminTok9, body: { count: 1, childMonths: 12 } })).status === 400
      );
      check(
        '一次超过 500 个 → 400',
        (await call('POST', '/admin/redeem-codes', {
          token: adminTok9,
          body: { count: 501, kind: 'child_slot', childMonths: 12 },
        })).status === 400
      );
      check(
        '月时长超 60 → 400',
        (await call('POST', '/admin/redeem-codes', { token: adminTok9, body: { count: 1, kind: 'child_slot', childMonths: 61 } })).status === 400
      );
      check(
        '天数超 365 → 400',
        (await call('POST', '/admin/redeem-codes', { token: adminTok9, body: { count: 1, kind: 'child_slot', childDays: 366 } })).status === 400
      );
      check(
        '永久 + 时长同时填 → 400',
        (await call('POST', '/admin/redeem-codes', {
          token: adminTok9,
          body: { count: 1, kind: 'child_slot', childPermanent: true, childMonths: 12 },
        })).status === 400
      );
      check(
        'GB 与 MB 混填 → 400',
        (await call('POST', '/admin/redeem-codes', {
          token: adminTok9,
          body: { count: 1, kind: 'storage', storageGb: 5, storageMb: 512 },
        })).status === 400
      );

      const list = await call('GET', '/admin/redeem-codes?size=10', { token: adminTok9 });
      const lrow = (list.json?.rows || []).find((r) => r.code === codesC[0]);
      check('后台列表能看到刚生成的码（带 kind，1 个名额）', list.status === 200 && lrow?.kind === 'child_slot' && lrow?.childSlots === 1, `kind=${lrow?.kind}`);
      check('新码状态是 unused，且没有家庭引用', lrow?.status === 'unused' && lrow?.familyRef === null, `status=${lrow?.status}`);

      const pv = await call('GET', `/redeem/preview?code=${codesC[0]}`, { token: tokenA });
      check(
        '预览返回名额码内容（kind=child_slot，12 个月）',
        pv.json?.result?.valid === true &&
          pv.json?.result?.grant?.kind === 'child_slot' &&
          pv.json?.result?.grant?.childMonths === 12,
        JSON.stringify(pv.json?.result?.grant ?? null)
      );
      const lowCode = String(codesC[0]).toLowerCase();
      const tolerant = await call(
        'GET',
        `/redeem/preview?code=${lowCode.slice(0, 4)}-${lowCode.slice(4, 8)}-${lowCode.slice(8)}`,
        { token: tokenA }
      );
      check('小写 + 连字符也能识别（手抄容错）', tolerant.json?.result?.valid === true, `code=${tolerant.json?.result?.code}`);
      check('预览不消耗：兑换前状态仍是 unused', (await call('GET', '/admin/redeem-codes?size=10', { token: adminTok9 })).json?.summary?.used === 0);

      if (childToken) {
        check('孩子兑码 → 403', (await call('POST', '/redeem', { token: childToken, body: { code: codesC[0] } })).status === 403);
        check('孩子看预览 → 403', (await call('GET', `/redeem/preview?code=${codesC[0]}`, { token: childToken })).status === 403);
      }

      // ── 名额时长码：必须绑孩子 ──
      check(
        '名额时长码不带目标 → 400 redeem_need_target',
        (await call('POST', '/redeem', { token: tokenA, body: { code: codesC[0] } })).json?.error === 'redeem_need_target'
      );
      const freeChildA = freeChildOf(famAId);
      if (freeChildA) {
        check(
          '时长码兑给免费（永久）孩子 → 400 child_slot_free',
          (await call('POST', '/redeem', { token: tokenA, body: { code: codesC[0], childId: freeChildA } })).json?.error === 'child_slot_free'
        );
      }

      // 新建孩子：到期日严格按码面时长（1 年）从现在起算，并发一张已分配的券
      const creditsA0 = creditsOf(famAId).total;
      const rdNew = await call('POST', '/redeem', {
        token: tokenA,
        body: { code: codesC[0], newChildName: '兑换娃' },
      });
      const newKidId = rdNew.json?.appliedTo?.childId ?? 0;
      check('名额码 + 新建孩子兑换成功', rdNew.status === 200 && rdNew.json?.appliedTo?.type === 'new_child' && newKidId > 0, JSON.stringify(rdNew.json?.appliedTo ?? null));
      const newKidExp = childExpiryOf(newKidId);
      check(
        '新孩子到期日 ≈ 现在 + 365 天（码面 1 年）',
        Math.abs(newKidExp - Math.floor(Date.now() / 1000) - YEAR) < 120,
        `slot_expires=${newKidExp}`
      );
      check('兑换发了一张已分配的券（删除孩子配额会跟着减）', creditsOf(famAId).total - creditsA0 === 1, `${creditsA0} → ${creditsOf(famAId).total}`);

      // 天数码续期给这个新孩子：到期日 +7 天，券数不变（已有有效券，只顺延）
      const expBeforeD = childExpiryOf(newKidId);
      const rdD = await call('POST', '/redeem', { token: tokenA, body: { code: codeD, childId: newKidId } });
      check('7 天码兑给现有孩子成功', rdD.status === 200 && rdD.json?.appliedTo?.type === 'child', `HTTP ${rdD.status}`);
      check(
        '到期日 +7 天（按日顺延）',
        Math.abs(childExpiryOf(newKidId) - (expBeforeD + 7 * 86400)) < 5,
        `${expBeforeD} → ${childExpiryOf(newKidId)}`
      );
      check('续期不重复发券', creditsOf(famAId).total === creditsA0 + 1, `slots=${creditsOf(famAId).total}`);

      // 名额永久码：基础配额 +1，不需要选孩子
      const quotaA0 = famOf(famAId).child_quota ?? 0;
      const rdP = await call('POST', '/redeem', { token: tokenA, body: { code: codeP } });
      check('名额永久码兑换成功（不用选孩子）', rdP.status === 200 && rdP.json?.appliedTo?.type === 'quota', `HTTP ${rdP.status}`);
      check('基础配额 +1', (famOf(famAId).child_quota ?? 0) - quotaA0 === 1, `${quotaA0} → ${famOf(famAId).child_quota}`);
      // 测试库的后续断言按原配额写：测完把配额还原，避免污染第 12 节以后的席位数字
      {
        const raw = new Database(path.join(dataDir, 'money-jar.db'));
        raw.pragma('busy_timeout = 3000');
        raw.prepare('UPDATE families SET child_quota = ? WHERE id = ?').run(quotaA0, famAId);
        raw.close();
      }

      // 空间扩容码：按字节并池；到期日跟随用户现有空间（不延长），没买过才从现在起算一年
      const poolA0 = famOf(famAId);
      const gbBefore = (poolA0.paid_storage_bytes ?? 0) / GB_BYTES;
      const expBeforeG = poolA0.paid_storage_expires ?? 0;
      const rdG = await call('POST', '/redeem', { token: tokenA, body: { code: codeG } });
      check('空间 5 GB 码兑换成功', rdG.status === 200 && rdG.json?.appliedTo?.type === 'storage', `HTTP ${rdG.status}`);
      const poolA1 = famOf(famAId);
      check('空间池 +5 GB（按字节合并）', Math.abs((poolA1.paid_storage_bytes ?? 0) / GB_BYTES - (gbBefore + 5)) < 1e-6, `${gbBefore} → ${(poolA1.paid_storage_bytes ?? 0) / GB_BYTES}`);
      check(
        '扩容码到期日跟随现有空间（有池不变，无池从现在 + 1 年）',
        Math.abs((poolA1.paid_storage_expires ?? 0) - (expBeforeG > Math.floor(Date.now() / 1000) ? expBeforeG : Math.floor(Date.now() / 1000) + YEAR)) < 5,
        `${expBeforeG} → ${poolA1.paid_storage_expires}`
      );

      // 空间永久码：基础存储配额直接加大
      const sqA0 = poolA1.storage_quota_bytes ?? 0;
      const rdM = await call('POST', '/redeem', { token: tokenA, body: { code: codeM } });
      check('空间 MB 永久码兑换成功', rdM.status === 200 && rdM.json?.appliedTo?.type === 'storage_quota', `HTTP ${rdM.status}`);
      check('基础存储配额 +512 MB', (famOf(famAId).storage_quota_bytes ?? 0) - sqA0 === 512 * MB, `${sqA0} → ${famOf(famAId).storage_quota_bytes}`);

      // ── 双记录：用户订单中心 + 后台列表 ──
      const myOrders = (await call('GET', '/pay/orders?limit=50', { token: tokenA })).json?.orders || [];
      const rdOrders = myOrders.filter((o) => o.provider === 'redeem');
      check('订单中心能看到 4 条兑换记录（ redeem 单）', rdOrders.length >= 4, `redeemOrders=${rdOrders.length}`);
      check(
        '兑换单带人话说明 redeemLabel（新建/续期/配额/空间）',
        rdOrders.some((o) => (o.redeemLabel || '').includes('新建孩子')) &&
          rdOrders.some((o) => (o.redeemLabel || '').includes('续期')) &&
          rdOrders.some((o) => (o.redeemLabel || '').includes('永久')) &&
          rdOrders.some((o) => (o.redeemLabel || '').includes('扩容空间')),
        rdOrders.map((o) => o.redeemLabel).join(' | ')
      );
      const usedRows = (await call('GET', '/admin/redeem-codes?size=20&status=used', { token: adminTok9 })).json?.rows || [];
      check(
        '后台已兑换列表带 familyRef 与孩子名（且没有 familyId 噪音）',
        usedRows.every((r) => typeof r.familyRef === 'number' && r.familyId === undefined) &&
          usedRows.some((r) => !!r.childName),
        usedRows.map((r) => `${r.code}:${r.familyRef}:${r.childName ?? '-'}`).join(' ')
      );

      check(
        '重复兑换同一个码 → 409 redeem_used',
        (await call('POST', '/redeem', { token: tokenA, body: { code: codesC[0] } })).json?.error === 'redeem_used'
      );
      check(
        '不存在的码 → 404',
        (await call('POST', '/redeem', { token: tokenA, body: { code: 'ZZZZZZZZZZZZ' } })).json?.error === 'redeem_not_found'
      );

      // 乙家兑自己的码：只动乙家（这里同时验证「已用过的码谁也兑不了」）
      const famBId = sessB.family?.id;
      const creditsB0 = creditsOf(famBId).total;
      check(
        '乙家兑甲家已用掉的码 → 409',
        (await call('POST', '/redeem', { token: tokenB, body: { code: codesC[0] } })).json?.error === 'redeem_used'
      );
      const rdB = await call('POST', '/redeem', { token: tokenB, body: { code: codesC[1], newChildName: '乙家娃' } });
      check('乙家兑自己的名额码成功', rdB.status === 200, `HTTP ${rdB.status}`);
      check('乙家券 +1（在自己家）', creditsOf(famBId).total - creditsB0 === 1, `${creditsB0} → ${creditsOf(famBId).total}`);
      check('甲家券未被乙家的兑换影响', creditsOf(famAId).total === creditsA0 + 1, `slots=${creditsOf(famAId).total}`);
    }

    // ── 12. 名额券（2026-10-21 批次 W：名额按孩子计费）──────────────
    // 名额从「全家共享池」改成「券 + 每个孩子各一条到期日」之后，
    // 多了两个跨家庭攻击面，必须在这里钉死：
    //   ① 续费对象 childId 是 body 里传的 —— 指到别人家的孩子必须 404；
    //   ② 券按 family_id 落行，甲买的券绝不能给乙家加名额。
    // 顺带覆盖用户拍板的核心行为：买券不计时，**添加孩子那一刻**才起算。
    section('12. 名额券（按孩子计费，childId 指不到别人家）');

    check(
      '打开购买总开关',
      (await call('PATCH', '/admin/config', { token: adminTok9, body: { pay_enabled: '1' } })).status === 200
    );

    const poolA0 = (await call('GET', '/pay/pool', { token: tokenA })).json?.pool;
    const poolB0 = (await call('GET', '/pay/pool', { token: tokenB })).json?.pool;

    const ordW = await call('POST', '/pay/orders', { token: tokenA, body: { kind: 'child_slot', qty: 1, years: 1 } });
    check('甲下单买名额', ordW.status === 200, `HTTP ${ordW.status} ${ordW.json?.error ?? ''}`);
    const payW = await call('POST', `/pay/orders/${ordW.json?.order?.id}/mock-pay`, { token: tokenA, body: {} });
    check('甲 mock 支付到账', payW.status === 200, `HTTP ${payW.status}`);

    const poolA1 = (await call('GET', '/pay/pool', { token: tokenA })).json?.pool;
    check(
      '甲的待分配券 +1',
      poolA1?.slots?.unused === (poolA0?.slots?.unused ?? 0) + 1 && poolA1?.slots?.total === (poolA0?.slots?.total ?? 0) + 1,
      `${JSON.stringify(poolA0?.slots)} → ${JSON.stringify(poolA1?.slots)}`
    );
    const poolB1 = (await call('GET', '/pay/pool', { token: tokenB })).json?.pool;
    check('乙家一张券都没多', poolB1?.slots?.total === (poolB0?.slots?.total ?? 0), `${poolB0?.slots?.total} → ${poolB1?.slots?.total}`);

    // 跨家庭：childId 指到乙家的孩子，报价与下单都必须 404
    const xq = await call('GET', `/pay/quote?kind=child_slot&qty=1&years=1&childId=${childB.id}`, { token: tokenA });
    check('报价拿别人家孩子 → 404 child_not_found', xq.status === 404 && xq.json?.error === 'child_not_found', `HTTP ${xq.status}`);
    const xo = await call('POST', '/pay/orders', {
      token: tokenA,
      body: { kind: 'child_slot', qty: 1, years: 1, childId: childB.id },
    });
    check('给别人家孩子下单 → 404', xo.status === 404 && xo.json?.error === 'child_not_found', `HTTP ${xo.status}`);

    // 甲用券加第 2 个孩子：到期日 = 添加那一刻 + 券时长（不是付款时间）
    // 「先买先用」：加孩子消耗**最早买的**那张未用券。前面第 9/11 节已积累
    // 多张不同时长的券（12 / 24 个月、兑换码券），这里在加孩子**之前**查券表
    // 算期望时长 —— 消耗之后再看就变成「下一张」了。
    const rawA = new Database(path.join(dataDir, 'money-jar.db'));
    rawA.pragma('busy_timeout = 3000');
    const earliest = rawA
      .prepare(
        `SELECT months, COALESCE(days, 0) AS days FROM child_slot_credits
          WHERE family_id = ? AND used_by_user_id IS NULL AND refunded_at = 0
          ORDER BY id ASC LIMIT 1`
      )
      .get(sessA.family?.id);
    rawA.close();
    const MONTH_SEC = Math.round((365 * 86400) / 12);
    const expectSec = (earliest?.months ?? 0) * MONTH_SEC + (earliest?.days ?? 0) * 86400;
    const kid2 = await call('POST', '/children', {
      token: tokenA,
      body: { name: `甲二娃${tag}`, pin: `9${Date.now() % 1000}`.padStart(4, '0'), avatar: 'dragon', birthday: '2020-01-01', sex: 'male' },
    });
    check('甲用券加第 2 个孩子', kid2.status === 200, `HTTP ${kid2.status} ${kid2.json?.error ?? ''}`);
    const kidsA = (await call('GET', '/family', { token: tokenA })).json.children;
    const k2 = kidsA.find((c) => c.id === kid2.json?.id);
    const tAdd = Math.floor(Date.now() / 1000);
    check(
      '券已消耗：第 2 个孩子的到期日 = 添加日 + 最早那张券的时长',
      k2?.slotExpires > 0 && Math.abs(k2.slotExpires - (tAdd + expectSec)) < 3 * 86400,
      `slotExpires=${k2?.slotExpires} 期望≈${tAdd + expectSec}（券 ${earliest?.months} 个月）`
    );
    const freeKid = kidsA.find((c) => c.id === childA.id);
    check('免费名额的孩子不带到期日（slotExpires=0）', freeKid?.slotExpires === 0, `slotExpires=${freeKid?.slotExpires}`);

    // 给自己家的付费孩子续费：到期日在原日期上累加，不消耗券
    const rq = await call('GET', `/pay/quote?kind=child_slot&qty=1&years=1&childId=${k2.id}`, { token: tokenA });
    check('给自己家付费孩子报价成功', rq.status === 200, `HTTP ${rq.status} ${rq.json?.error ?? ''}`);
    const ro = await call('POST', '/pay/orders', {
      token: tokenA,
      body: { kind: 'child_slot', qty: 1, years: 1, childId: k2.id },
    });
    check('给自己家孩子续费下单', ro.status === 200, `HTTP ${ro.status}`);
    const rp = ro.status === 200 ? await call('POST', `/pay/orders/${ro.json.order.id}/mock-pay`, { token: tokenA, body: {} }) : null;
    check('续费 mock 支付到账', rp?.status === 200, `HTTP ${rp?.status}`);
    const k2b = ((await call('GET', '/family', { token: tokenA })).json.children || []).find((c) => c.id === k2.id);
    check(
      '续费后到期日 ≈ 原来 + 1 年（累加）',
      k2b?.slotExpires > 0 && Math.abs(k2b.slotExpires - (k2.slotExpires + 365 * 86400)) < 3 * 86400,
      `${k2?.slotExpires} → ${k2b?.slotExpires}`
    );
    const poolA2 = (await call('GET', '/pay/pool', { token: tokenA })).json?.pool;
    check('续费不消耗券（待分配数不变）', poolA2?.slots?.unused === poolA1?.slots?.unused - 1, `unused=${poolA1?.slots?.unused} → ${poolA2?.slots?.unused}`);
    const quotaB1 = (await call('GET', '/pay/pool', { token: tokenB })).json?.pool;
    check('乙家始终没有多出券', quotaB1?.slots?.total === poolB0?.slots?.total, `${poolB0?.slots?.total} → ${quotaB1?.slots?.total}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了，是临时目录 */
    }
  }

  console.log(`\n${failures === 0 ? '全部通过' : `失败 ${failures} 项`}（共 ${checks} 项）`);
  if (failures > 0) {
    console.log('\n—— 后端日志尾部 ——');
    console.log(log.split('\n').slice(-40).join('\n'));
  }
  process.exit(failures === 0 ? 0 : 1);
}

function extOk(r) {
  return r.status === 200 && r.json && typeof r.json === 'object';
}

/** 解出 JWT 的 payload（不验签，只用来断言 claims 内容） */
function jwtClaims(token) {
  const part = String(token).split('.')[1] ?? '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

/** 把一个新的微信身份绑成某个孩子，返回孩子 token */
async function bindChild(childId, code, parentToken) {
  const bc = await call('POST', '/family/child-bind-codes', { token: parentToken, body: { childId } });
  if (!bc.json?.code) return null;
  const login = await call('POST', '/wx/login', { body: { code } });
  if (!login.json?.ticket) return null;
  const bound = await call('POST', '/wx/bind-child', {
    body: { ticket: login.json.ticket, code: bc.json.code },
  });
  return bound.json?.token ?? null;
}

main().catch((e) => {
  console.error('脚本自身出错：', e);
  process.exit(2);
});
