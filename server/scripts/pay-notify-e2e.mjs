/**
 * 回调端到端测试：用自签 RSA 密钥冒充「微信支付平台」，把一个真实结构的
 * TRANSACTION.SUCCESS 通知 POST 给 /api/pay/notify，验证：
 *   ① 验签通过 → 200 SUCCESS
 *   ② 订单置 paid，权益入池
 *   ③ 重放同一个通知 → 仍然 200 SUCCESS，但**不重复发权益**（幂等）
 *   ④ 金额被篡改 → 409，且订单不动
 *   ⑤ 请求体被篡改 → 验签失败 401
 * 用法：node scripts/pay-notify-e2e.mjs <baseUrl> <dataDir> <privKeyPath> <apiV3Key>
 */
import { execFileSync } from 'node:child_process';
import { createCipheriv, createSign, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const [base, dataDir, keyPath, apiV3Key] = process.argv.slice(2);
if (!base || !dataDir || !keyPath || !apiV3Key) {
  console.error('用法：node scripts/pay-notify-e2e.mjs <baseUrl> <dataDir> <privKeyPath> <apiV3Key>');
  process.exit(2);
}

/** 一次请求同时拿到 body 与状态码（分两次发会把「重放」测成两次首达） */
function request(method, url, body, headers = {}) {
  const args = ['-s', '-w', '\n%{http_code}', '-X', method, url];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body !== undefined) {
    args.push('-H', 'Content-Type: application/json', '-d', body);
  }
  const out = execFileSync('curl', ['--noproxy', '*', ...args], { encoding: 'utf8' });
  const idx = out.lastIndexOf('\n');
  const text = out.slice(0, idx);
  const status = Number(out.slice(idx + 1));
  let json = null;
  try { json = JSON.parse(text); } catch { /* 可能不是 JSON */ }
  return { status, json, text };
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
}

/* 1. 建一个家庭（真接口），拿到 family_id 与 user_id */
const lr = request('POST', `${base}/api/wx/login`, JSON.stringify({ code: 'notify-e2e-' + Date.now() })).json;
const fam = request(
  'POST',
  `${base}/api/wx/register-family`,
  JSON.stringify({ ticket: lr.ticket, familyName: '回调测试家', parentName: '甲' })
).json;
const token = fam.token;
console.log('家庭已建，userId =', fam.user?.id);

const dbPath = `${dataDir}/money-jar.db`;
const db = new Database(dbPath);
const row = db.prepare('SELECT id, family_id FROM users WHERE id = ?').get(fam.user.id);
const familyId = row.family_id;

/* 2. 直接插一张 pending 单（绕开微信下单，只测回调） */
const outTradeNo = 'GTE2E' + Date.now();
const amount = 1900;
const now = Math.floor(Date.now() / 1000);
db.prepare(
  `INSERT INTO orders (family_id, user_id, kind, qty, amount_cents, status, provider, out_trade_no,
                       created_at, expires_at, term_years, unit_price_cents, deduction_cents, entitlement_expires)
   VALUES (?, ?, 'child_slot', 1, ?, 'pending', 'wxpay', ?, ?, ?, 1, 1900, 0, 0)`
).run(familyId, fam.user.id, amount, outTradeNo, now, now + 900);
const orderId = db.prepare('SELECT id FROM orders WHERE out_trade_no = ?').get(outTradeNo).id;
console.log('已插入待支付单 #' + orderId, outTradeNo);

/* 3. 构造一个与微信同构的通知体 */
function gcmEncrypt(key, nonce, plain, aad) {
  const c = createCipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), Buffer.from(nonce, 'utf8'));
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([enc, c.getAuthTag()]).toString('base64');
}

const priv = readFileSync(keyPath, 'utf8');

function buildNotify(total) {
  const resource = {
    mchid: '1487081842',
    appid: 'wx64ade06c5b942e68',
    out_trade_no: outTradeNo,
    transaction_id: '42000E2E' + Math.floor(Math.random() * 1e9),
    trade_state: 'SUCCESS',
    amount: { total, payer_total: total, currency: 'CNY' },
  };
  const nonce = randomBytes(6).toString('hex');
  const aad = 'transaction';
  const body = JSON.stringify({
    id: 'EV-E2E-' + Date.now(),
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      ciphertext: gcmEncrypt(apiV3Key, nonce, JSON.stringify(resource), aad),
      nonce,
      associated_data: aad,
    },
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const n = randomBytes(16).toString('hex');
  const signer = createSign('RSA-SHA256');
  signer.update(`${ts}\n${n}\n${body}\n`);
  return {
    body,
    headers: {
      'Wechatpay-Timestamp': ts,
      'Wechatpay-Nonce': n,
      'Wechatpay-Serial': 'PUB_KEY_ID_E2E',
      'Wechatpay-Signature': signer.sign(priv, 'base64'),
    },
  };
}

function poolOf() {
  return request('GET', `${base}/api/pay/pool`, undefined, { Authorization: `Bearer ${token}` }).json.pool;
}

/* 4. 正常回调 */
const n1 = buildNotify(amount);
const r1 = request('POST', `${base}/api/pay/notify`, n1.body, n1.headers);
ok('正常回调 HTTP 200', r1.status === 200, r1.status);
ok('回 SUCCESS', r1.json?.code === 'SUCCESS', JSON.stringify(r1.json));
const o1 = db.prepare('SELECT status, transaction_id, applied_at FROM orders WHERE id = ?').get(orderId);
ok('订单置为 paid', o1.status === 'paid', o1.status);
ok('记下了 transaction_id', !!o1.transaction_id);
ok('applied_at 已写', !!o1.applied_at);
const p1 = poolOf();
ok('名额池 +1', p1.child.slots === 1, p1.child.slots);

/* 5. 重放：不能重复发权益 */
const r2 = request('POST', `${base}/api/pay/notify`, n1.body, n1.headers);
ok('重放仍是 200', r2.status === 200, r2.status);
const p2 = poolOf();
ok('重放没有再加名额', p2.child.slots === 1, p2.child.slots);

/* 6. 金额被篡改 */
const n2 = buildNotify(1);
const r3 = request('POST', `${base}/api/pay/notify`, n2.body, n2.headers);
ok('金额不一致 → 409', r3.status === 409, r3.status);
const p3 = poolOf();
ok('金额不一致时不动权益', p3.child.slots === 1, p3.child.slots);

/* 7. 请求体被篡改（签名对不上） */
const n3 = buildNotify(amount);
const tampered = n3.body.replace('TRANSACTION.SUCCESS', 'TRANSACTION.FAILED');
const r4 = request('POST', `${base}/api/pay/notify`, tampered, n3.headers);
ok('篡改请求体 → 401', r4.status === 401, r4.status);

db.close();
console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail === 0 ? 0 : 1);
