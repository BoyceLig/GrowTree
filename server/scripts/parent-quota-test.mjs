/**
 * 家庭家长人数上限回归（2026-11-06：「家长账号最多 6 个，包括创建人」）
 *
 * 跑法（在 server 目录）：
 *   node scripts/parent-quota-test.mjs
 *
 * 自己起一个临时后端（独立 DATA_DIR + 随机端口），跑完杀进程、删临时目录，
 * 不碰验收库（3920）也不碰线上。
 *
 * ── 覆盖什么 ──────────────────────────────────────────────────────────
 *   1. 创建人算 1 个，能一路加到第 6 位
 *   2. 第 7 位被 409 parent_quota_reached 拦住，文案带上限数字
 *   3. 满员时连「生成邀请码」都被提前拦（不给创建者发出用不了的码）
 *   4. 硬拦确实落在 family_members 上：移除一位家长后名额立刻释放
 *      （users 里那个账号还在，但不再计入，这是按成员表计数的关键理由）
 *   5. 后台 PATCH /admin/config 改 max_parents 即时生效；0 / 51 被值域校验拒
 *   6. 另一个家庭不受影响（按 family_id 隔离，不是全局上限）
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import Database from 'better-sqlite3';

const SERVER_DIR = path.resolve(import.meta.dirname, '..');
const ROOT_DIR = path.resolve(SERVER_DIR, '..');

let BASE = '';
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

async function makeFamily(code, familyName, parentName) {
  const login = await call('POST', '/wx/login', { body: { code } });
  if (!login.json?.ticket) throw new Error(`登录失败：${JSON.stringify(login.json)}`);
  const reg = await call('POST', '/wx/register-family', {
    body: { ticket: login.json.ticket, familyName, parentName, avatar: '🐯' },
  });
  if (!reg.json?.token) throw new Error(`建家庭失败：${JSON.stringify(reg.json)}`);
  return reg.json;
}

/** 用一个全新微信身份 + 家长邀请码加入家庭 */
async function joinParent(loginCode, inviteCode, parentName) {
  const login = await call('POST', '/wx/login', { body: { code: loginCode } });
  if (!login.json?.ticket) throw new Error(`登录失败：${JSON.stringify(login.json)}`);
  return call('POST', '/wx/join-family', {
    body: { ticket: login.json.ticket, code: inviteCode, parentName },
  });
}

/** 直接数库里的「在册家长」：family_members JOIN users，与服务端同一口径 */
function parentRows(db, familyId) {
  return db
    .prepare(
      `SELECT m.user_id AS id, m.role AS memberRole
         FROM family_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.family_id = ? AND u.role = 'parent'
        ORDER BY m.user_id`
    )
    .all(familyId);
}

async function main() {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'gt-parent-quota-'));
  const adminPassword = 'parent-quota-admin';
  const child = spawn(process.execPath, [path.join(SERVER_DIR, 'dist', 'index.js')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      JWT_SECRET: 'parent-quota-test-only',
      WX_MOCK: '1',
      WX_PAY_MOCK: '1',
      PIGGY_SKIP_BOOTSTRAP: '1',
      ADMIN_PASSWORD: adminPassword,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => (log += b));
  child.stderr.on('data', (b) => (log += b));

  let db = null;
  try {
    console.log(`临时后端：${BASE}（DATA_DIR=${dataDir}）`);
    await waitHealthy(BASE);
    const dbFile = readdirSync(dataDir).find((f) => f.endsWith('.db'));
    if (!dbFile) throw new Error(`DATA_DIR 里没有 db：${readdirSync(dataDir)}`);
    db = new Database(path.join(dataDir, dbFile), { readonly: true });

    // ── 建家庭：创建人算第 1 位 ─────────────────────────────────────
    section('A 创建人计入名额');
    const sess = await makeFamily('pq-owner', '配额甲家', '甲创建人');
    const ownerToken = sess.token;
    const familyId = Number(
      db.prepare("SELECT family_id FROM users WHERE role = 'parent' ORDER BY id LIMIT 1").get()
        ?.family_id ?? 0
    );
    check('家庭 id 可取', familyId > 0, `familyId=${familyId}`);
    check('初始只有 1 位家长', parentRows(db, familyId).length === 1);

    const invite = await call('POST', '/family/invites', {
      token: ownerToken,
      body: { maxUses: 20 },
    });
    check('生成家长邀请码', invite.status === 200 && !!invite.json?.code, JSON.stringify(invite.json));
    const inviteCode = invite.json?.code;
    if (!inviteCode) throw new Error('拿不到邀请码，后续用例无法进行');

    // ── 加到第 6 位 ────────────────────────────────────────────────
    section('B 一路加到第 6 位');
    const joinedIds = [];
    for (let i = 2; i <= 6; i += 1) {
      const r = await joinParent(`pq-p${i}`, inviteCode, `甲家长${i}`);
      check(`第 ${i} 位家长加入成功`, r.status === 200 && !!r.json?.token, `status=${r.status}`);
      if (r.json?.user?.id) joinedIds.push(r.json.user.id);
    }
    check('在册家长恰好 6 位', parentRows(db, familyId).length === 6,
      `实际 ${parentRows(db, familyId).length}`);

    // ── 第 7 位必须被拦 ────────────────────────────────────────────
    section('C 第 7 位硬拦');
    const seventh = await joinParent('pq-p7', inviteCode, '甲家长7');
    check('返回 409', seventh.status === 409, `status=${seventh.status}`);
    check('错误码 parent_quota_reached', seventh.json?.error === 'parent_quota_reached',
      JSON.stringify(seventh.json));
    check('文案含「最多 6 位家长（含创建人）」',
      String(seventh.json?.message ?? '').includes('最多 6 位家长（含创建人）'),
      String(seventh.json?.message ?? ''));
    check('库里仍是 6 位（没写进半个账号）', parentRows(db, familyId).length === 6);

    const inviteWhenFull = await call('POST', '/family/invites', {
      token: ownerToken,
      body: { maxUses: 1 },
    });
    check('满员时不再发邀请码（提前拦）',
      inviteWhenFull.status === 409 && inviteWhenFull.json?.error === 'parent_quota_reached',
      `status=${inviteWhenFull.status} ${JSON.stringify(inviteWhenFull.json)}`);

    // ── 移除一位 → 名额释放（users 行残留但不再计入）──────────────────
    section('D 移除家长后释放名额');
    const removable = parentRows(db, familyId).find((r) => r.memberRole !== 'owner');
    check('找到一位非创建人家长', !!removable, JSON.stringify(removable));
    if (removable) {
      const del = await call('DELETE', `/family/members/${removable.id}`, { token: ownerToken });
      check('移除成功', del.status === 200, `status=${del.status}`);
      check('在册家长变 5 位', parentRows(db, familyId).length === 5,
        `实际 ${parentRows(db, familyId).length}`);
      const stillInUsers = db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE id = ? AND role = 'parent'")
        .get(removable.id)?.n ?? 0;
      check('users 里账号仍残留（正是不能用 users 计数的原因）', stillInUsers === 1);
      const back = await joinParent('pq-p8', inviteCode, '甲家长8');
      check('名额释放后可以补进第 6 位', back.status === 200, `status=${back.status}`);
      check('在册家长回到 6 位', parentRows(db, familyId).length === 6);
      const again = await joinParent('pq-p9', inviteCode, '甲家长9');
      check('补满后第 7 位仍被拦', again.status === 409, `status=${again.status}`);
    }

    // ── 后台可配 + 值域校验 ─────────────────────────────────────────
    section('E 后台 max_parents 可配');
    const adminLogin = await call('POST', '/admin/login', {
      body: { username: 'admin', password: adminPassword },
    });
    check('后台登录成功', adminLogin.status === 200 && !!adminLogin.json?.token,
      `status=${adminLogin.status}`);
    const adminToken = adminLogin.json?.token;
    if (adminToken) {
      check('默认值是 6',
        (await call('GET', '/admin/config', { token: adminToken })).json?.config?.max_parents === '6');
      const to7 = await call('PATCH', '/admin/config', {
        token: adminToken,
        body: { max_parents: '7' },
      });
      check('改成 7 成功', to7.status === 200, `status=${to7.status}`);
      const added = await joinParent('pq-p10', inviteCode, '甲家长10');
      check('改完立刻能加第 7 位（缓存已失效）', added.status === 200, `status=${added.status}`);
      check('在册家长 7 位', parentRows(db, familyId).length === 7);

      const bad0 = await call('PATCH', '/admin/config', {
        token: adminToken, body: { max_parents: '0' },
      });
      check('max_parents=0 被拒（避免「填 0 反而锁死 6」歧义）', bad0.status === 400,
        `status=${bad0.status}`);
      const bad51 = await call('PATCH', '/admin/config', {
        token: adminToken, body: { max_parents: '51' },
      });
      check('max_parents=51 被拒', bad51.status === 400, `status=${bad51.status}`);
      check('配置仍是 7（非法值没写进库）',
        (await call('GET', '/admin/config', { token: adminToken })).json?.config?.max_parents === '7');
    }

    // ── 隔离：另一个家庭不受影响 ────────────────────────────────────
    section('F 上限按家庭隔离');
    const sessB = await makeFamily('pq-owner-b', '配额乙家', '乙创建人');
    const inviteB = await call('POST', '/family/invites', {
      token: sessB.token, body: { maxUses: 3 },
    });
    check('乙家只有 1 位家长，仍能生成邀请码', inviteB.status === 200,
      `status=${inviteB.status} ${JSON.stringify(inviteB.json)}`);
    if (inviteB.json?.code) {
      const joinB = await joinParent('pq-b2', inviteB.json.code, '乙家长2');
      check('乙家能正常加第 2 位', joinB.status === 200, `status=${joinB.status}`);
    }
  } catch (e) {
    console.error('\n测试异常中止：', e);
    failures += 1;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (log.trim()) console.log('\n--- 后端日志（末尾）---\n' + log.split('\n').slice(-15).join('\n'));
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nPARENT-QUOTA ${checks - failures}/${checks} PASS`);
  if (failures) process.exitCode = 1;
}

main();
