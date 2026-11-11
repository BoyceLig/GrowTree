/**
 * 小程序虚拟支付下单 / 发货链路回归验收（2026-11-05）
 *
 * 跑法（服务必须从仓库根目录启动，findSchemaPath 依赖 cwd）：
 *   PORT=3956 DATA_DIR=/tmp/gt-vp/data WX_MOCK=1 WX_PAY_MOCK=1 VP_MOCK=1 \
 *     ADMIN_PASSWORD=test123 JWT_SECRET=local node server/dist/index.js
 *   GT_TEST_BASE=http://127.0.0.1:3956 GT_TEST_DATA_DIR=/tmp/gt-vp/data \
 *     node server/scripts/virtualpay-test.mjs
 *
 * ⚠️ VP_MOCK=1 只在本地验收用：/xpay/* 不发外网，参数自动补齐，
 *    后台接口可把一张单标记成「平台已支付」。生产绝不能设。
 *    总闸 pay_virtual_enabled 不受它影响，脚本显式开关，才能同时验证
 *    「开关关闭 → 完全走 V3/mock」这条回归。
 *
 * 覆盖：三道闸 / 双签名与 signData / 固定价道具与 1 分单位道具 /
 *       发货推送 JSON+XML 验签·重放·金额防篡改 / 换号重签 /
 *       查单与 scheduler 兜底 / iOS 退款问询 / 退款推送回收权益 /
 *       buyQuantity 上限与最低金额 / 后台状态不回密钥。
 */
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const BASE = process.env.GT_TEST_BASE || 'http://127.0.0.1:3956';
const DATA_DIR = process.env.GT_TEST_DATA_DIR || '/tmp/gt-vp/data';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(path.join(DATA_DIR, 'money-jar.db'));

const NOTIFY_TOKEN = process.env.GT_TEST_VP_TOKEN || 'mock-notify-token';
const APP_KEY = process.env.GT_TEST_VP_APPKEY || 'mock-app-key';
const SESSION_KEY = process.env.GT_TEST_SESSION_KEY || 'mock-session-key';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + '  ' + extra); }
}

async function req(method, p, body, token) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { j = {}; }
  return { status: r.status, j, text: JSON.stringify(j) };
}

async function raw(method, p, body, contentType = 'application/json', token) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': contentType, ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body,
  });
  return { status: r.status, text: await r.text() };
}

function signatureOf(ts, nonce, token = NOTIFY_TOKEN) {
  return createHash('sha1').update([token, ts, nonce].sort().join('')).digest('hex');
}
/** 每次生成一对新的 timestamp/nonce，避免被 vp_events 的 UNIQUE 误判成重放 */
function pushUrl(extra = {}, token = NOTIFY_TOKEN) {
  const ts = String(Date.now() + Math.floor(Math.random() * 1000));
  const nonce = 'n' + Math.random().toString(36).slice(2, 10);
  const q = new URLSearchParams({
    signature: signatureOf(ts, nonce, token), timestamp: ts, nonce, ...extra,
  });
  return '/api/pay/vp/notify?' + q.toString();
}
function pushBody(o) {
  return {
    Event: o.event || 'xpay_goods_deliver_notify',
    WxOrderId: o.wx,
    OutTradeNo: o.out || '',
    Attach: String(o.attach ?? ''),
    ActualPrice: o.actual,
    Channel: o.channel || 'wxpay',
  };
}
function pushXml(o) {
  const b = pushBody(o);
  return '<xml>' + Object.entries(b)
    .map(([k, v]) => `<${k}><![CDATA[${String(v)}]]></${k}>`)
    .join('') + '</xml>';
}

async function newFamily(tag) {
  const lg = await req('POST', '/api/wx/login', {
    code: 'vp-' + tag + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
  });
  const reg = await req('POST', '/api/wx/register-family', {
    ticket: lg.j.ticket, familyName: '虚拟支付验收' + tag, parentName: '家长' + tag,
  });
  const row = db.prepare("SELECT family_id FROM users WHERE role='parent' ORDER BY id DESC LIMIT 1").get();
  return { token: reg.j.token, fid: row.family_id };
}

const cfg = () => Object.fromEntries(
  db.prepare('SELECT key, value FROM platform_config').all().map((r) => [r.key, r.value])
);
const orderOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const eventsOf = (wx) => db.prepare('SELECT * FROM vp_events WHERE wx_order_id = ?').all(wx);
const slotCredits = (orderId) =>
  db.prepare('SELECT COUNT(*) c FROM child_slot_credits WHERE order_id = ?').get(orderId).c;
const storageOf = (fid) =>
  Number(db.prepare('SELECT paid_storage_bytes b FROM families WHERE id = ?').get(fid)?.b ?? 0);
const storageExpiresOf = (fid) =>
  Number(db.prepare('SELECT paid_storage_expires e FROM families WHERE id = ?').get(fid)?.e ?? 0);
const setEnabled = (v, AT) => req('PATCH', '/api/admin/config', { pay_virtual_enabled: v }, AT);
const place = (token, kind, qty, years) =>
  req('POST', '/api/pay/orders', { kind, qty, years }, token);
const sdOf = (r) => {
  try { return JSON.parse(r.j.payParams.virtual.signData); } catch { return {}; }
};

(async () => {
  // ── A. 前置：迁移 / 默认关闭 / 自检 ────────────────────────────────
  const adm = await req('POST', '/api/admin/login', { username: 'admin', password: 'test123' });
  ok('A1 admin 登录', adm.status === 200 && !!adm.j.token, 'status=' + adm.status);
  const AT = adm.j.token;

  // 可重复运行：先把开关复位到出厂默认，同时打开购买功能（默认 pay_enabled=0）
  await req('PATCH', '/api/admin/config',
    { pay_virtual_enabled: '0', pay_enabled: '1' }, AT);
  ok('A2 复位后总闸关闭', cfg().pay_virtual_enabled === '0', 'value=' + cfg().pay_virtual_enabled);
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((r) => r.name);
  ok('A3 orders 三列已迁移',
    ['pay_order_no', 'vp_wx_order_id', 'vp_channel'].every((c) => cols.includes(c)));
  ok('A4 vp_events 表已建',
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vp_events'").get());
  const st0 = await req('GET', '/api/admin/pay/status', undefined, AT);
  ok('A5 自检默认未启用', st0.status === 200 && st0.j.virtual?.enabled === false &&
    st0.j.virtual?.configured === false, JSON.stringify(st0.j.virtual));
  const ms = await req('GET', '/api/admin/pay/vp/mock-state', undefined, AT);
  ok('A6 VP_MOCK 模拟通道已注册', ms.status === 200 && ms.j.ok === true, 'status=' + ms.status);
  ok('A7 购买功能已打开', cfg().pay_enabled === '1');
  await req('POST', '/api/admin/pay/vp/mock-clear', {}, AT);
  // 可重复运行的关键：D/G 段用固定 WxOrderId，上一轮流水留着会被 UNIQUE 判成重放
  // 而直接回 success。清掉本地验收库的推送流水，不影响同轮内 D6 的幂等验证。
  db.prepare('DELETE FROM vp_events').run();

  // ── B. 开关关闭：V3 / mock 链路完全不变 ────────────────────────────
  const A = await newFamily('A');
  const p0 = await req('GET', '/api/pay/products', undefined, A.token);
  ok('B1 products.virtualEnabled=false', p0.status === 200 && p0.j.virtualEnabled === false,
    'value=' + p0.j.virtualEnabled);
  const m1 = await place(A.token, 'child_slot', 1, 1);
  ok('B2 下单 provider=mock', m1.status === 200 && m1.j.order?.provider === 'mock' &&
    !m1.j.payParams?.virtual, 'provider=' + m1.j.order?.provider + ' ' + m1.text.slice(0, 180));
  const mp = await req('POST', `/api/pay/orders/${m1.j.order.id}/mock-pay`, {}, A.token);
  ok('B3 mock-pay 正常入账', mp.status === 200 && orderOf(m1.j.order.id).status === 'paid');
  // 留一张「未入账的 V3/mock 单」给 D15：验证虚拟支付推送绝不能给它发货
  const M = await newFamily('M');
  const m2 = await place(M.token, 'child_slot', 1, 1);

  // ── C. 打开总闸：虚拟支付下单与双签名 ──────────────────────────────
  ok('C1 打开总闸', (await setEnabled('1', AT)).status === 200);
  ok('C1b 开关已写库', cfg().pay_virtual_enabled === '1', 'value=' + cfg().pay_virtual_enabled);
  const p1 = await req('GET', '/api/pay/products', undefined, A.token);
  ok('C2 products.virtualEnabled=true', p1.j.virtualEnabled === true);

  const V1 = await newFamily('V1');
  const v1 = await place(V1.token, 'child_slot', 1, 1);
  ok('C3 下单 provider=virtual', v1.status === 200 && v1.j.order?.provider === 'virtual' &&
    !!v1.j.payParams?.virtual, 'provider=' + v1.j.order?.provider + ' status=' + v1.status);
  const ov1 = orderOf(v1.j.order.id);
  const sd1 = sdOf(v1);
  ok('C4 名额固定价道具 child_1y / 2990 分 / 数量 1',
    sd1.productId === 'child_1y' && sd1.goodsPrice === 2990 && sd1.buyQuantity === 1,
    JSON.stringify([sd1.productId, sd1.goodsPrice, sd1.buyQuantity]));
  ok('C5 signData 基础字段齐全',
    !!sd1.offerId && sd1.env === 0 && sd1.currencyType === 'CNY' &&
    sd1.outTradeNo === ov1.pay_order_no && sd1.attach === String(ov1.id),
    JSON.stringify([sd1.offerId, sd1.env, sd1.outTradeNo, sd1.attach]));
  ok('C6 paySig = HMAC(AppKey, requestVirtualPayment&signData)',
    v1.j.payParams.virtual.paySig ===
      createHmac('sha256', APP_KEY).update('requestVirtualPayment&' + v1.j.payParams.virtual.signData).digest('hex'));
  ok('C7 signature = HMAC(session_key, signData)',
    v1.j.payParams.virtual.signature ===
      createHmac('sha256', SESSION_KEY).update(v1.j.payParams.virtual.signData).digest('hex'));
  ok('C8 首次 pay_order_no = out_trade_no', ov1.pay_order_no === ov1.out_trade_no);
  ok('C9 mode = short_series_goods', v1.j.payParams.virtual.mode === 'short_series_goods');

  const V2 = await newFamily('V2');
  const v2 = await place(V2.token, 'storage_gb', 1, 1);
  const ov2 = orderOf(v2.j.order.id);
  const sd2 = sdOf(v2);
  ok('C10 空间走 1 分单位道具，buyQuantity = 应付分数',
    v2.status === 200 && sd2.productId === 'storage_unit' && sd2.goodsPrice === 1 &&
    sd2.buyQuantity === ov2.amount_cents,
    JSON.stringify([sd2.productId, sd2.goodsPrice, sd2.buyQuantity, ov2.amount_cents]));
  ok('C11 空间金额不低于最低支付额', ov2.amount_cents >= 100, 'amount=' + ov2.amount_cents);

  const V5 = await newFamily('V5');
  const v5 = await place(V5.token, 'child_slot', 1, 5);
  ok('C12 5 年名额映射到 child_5y / 9990 分',
    sdOf(v5).productId === 'child_5y' && sdOf(v5).goodsPrice === 9990,
    JSON.stringify([sdOf(v5).productId, sdOf(v5).goodsPrice]));
  const bad = await place(V5.token, 'child_slot', 1, 6);
  ok('C13 不支持 6 年', bad.status === 400 && bad.j.error === 'invalid_years',
    'status=' + bad.status + ' ' + bad.j.error);

  // ── D. 发货推送：验签 / 幂等 / 金额防篡改 / XML ────────────────────
  const g = await raw('GET', pushUrl({ echostr: 'hello-vp' }));
  ok('D1 GET 校验回 echostr', g.status === 200 && g.text === 'hello-vp',
    'status=' + g.status + ' body=' + g.text);
  const gBad = await raw('GET', '/api/pay/vp/notify?signature=x&timestamp=1&nonce=2&echostr=hi');
  ok('D2 GET 错签名 403', gBad.status === 403);
  const pBad = await raw('POST', '/api/pay/vp/notify?signature=x&timestamp=1&nonce=2', JSON.stringify({}));
  ok('D3 POST 错签名 403', pBad.status === 403);

  const wx1 = 'WX-DELIVER-1';
  const b1 = pushBody({ wx: wx1, out: ov1.pay_order_no, attach: ov1.id, actual: ov1.amount_cents });
  const d1 = await raw('POST', pushUrl(), JSON.stringify(b1));
  ok('D4 JSON 发货推送入账', d1.status === 200 && orderOf(ov1.id).status === 'paid' &&
    Number(orderOf(ov1.id).applied_at) > 0, 'status=' + d1.status);
  ok('D5 权益只发一次', slotCredits(ov1.id) === 1, 'credits=' + slotCredits(ov1.id));
  const d2 = await raw('POST', pushUrl(), JSON.stringify(b1));
  ok('D6 重放不重复发权益', d2.status === 200 && slotCredits(ov1.id) === 1 &&
    eventsOf(wx1).length === 1, 'events=' + eventsOf(wx1).length);
  ok('D7 平台单号与渠道落库',
    orderOf(ov1.id).vp_wx_order_id === wx1 && orderOf(ov1.id).vp_channel === 'wxpay',
    JSON.stringify([orderOf(ov1.id).vp_wx_order_id, orderOf(ov1.id).vp_channel]));

  const V3 = await newFamily('V3');
  const v3 = await place(V3.token, 'child_slot', 1, 1);
  const ov3 = orderOf(v3.j.order.id);
  const wx3 = 'WX-MISMATCH-1';
  const badAmount = pushBody({ wx: wx3, out: ov3.pay_order_no, attach: ov3.id, actual: ov3.amount_cents + 1 });
  const d3 = await raw('POST', pushUrl(), JSON.stringify(badAmount));
  ok('D8 金额不一致回 409 且不入账', d3.status === 409 && orderOf(ov3.id).status === 'pending',
    'status=' + d3.status);
  ok('D9 失败流水已撤销，允许重推', eventsOf(wx3).length === 0, 'events=' + eventsOf(wx3).length);
  const fixed = pushBody({ wx: wx3, out: ov3.pay_order_no, attach: ov3.id, actual: ov3.amount_cents });
  const d4 = await raw('POST', pushUrl(), JSON.stringify(fixed));
  ok('D10 修正后重推成功入账', d4.status === 200 && orderOf(ov3.id).status === 'paid');

  const V4 = await newFamily('V4');
  const v4 = await place(V4.token, 'storage_gb', 1, 1);
  const ov4 = orderOf(v4.j.order.id);
  const before4 = storageOf(V4.fid);
  const wx4 = 'WX-XML-1';
  const dx = await raw('POST', pushUrl(),
    pushXml({ wx: wx4, out: ov4.pay_order_no, attach: ov4.id, actual: ov4.amount_cents, channel: 'apple' }),
    'application/xml');
  ok('D11 XML 推送回 XML 且入账', dx.status === 200 && dx.text.includes('<ErrCode>0</ErrCode>') &&
    orderOf(ov4.id).status === 'paid', 'status=' + dx.status + ' body=' + dx.text.slice(0, 60));
  ok('D12 XML 推送记录 apple 渠道', orderOf(ov4.id).vp_channel === 'apple',
    'channel=' + orderOf(ov4.id).vp_channel);
  ok('D13 空间权益已发放', storageOf(V4.fid) > before4,
    before4 + ' → ' + storageOf(V4.fid));

  const wxUnknown = 'WX-UNKNOWN-1';
  const du = await raw('POST', pushUrl(), JSON.stringify({
    Event: 'xpay_some_future_event', WxOrderId: wxUnknown,
  }));
  ok('D14 未知事件回成功', du.status === 200 && du.text.includes('success'));

  // 把推送打向一张 pending 的 mock 单：绝不能给它发货，也不能写渠道信息
  const om2 = orderOf(m2.j.order.id);
  const wxWrong = 'WX-WRONG-PROVIDER-' + Date.now(); // 唯一号，避免重复运行时被误判成重放
  const dMock = await raw('POST', pushUrl(), JSON.stringify(
    pushBody({ wx: wxWrong, out: om2.pay_order_no || om2.out_trade_no, attach: om2.id, actual: om2.amount_cents })
  ));
  const om2b = orderOf(om2.id);
  ok('D15 非虚拟支付单被忽略',
    m2.status === 200 && om2.provider === 'mock' && om2.status === 'pending' &&
    dMock.status === 200 && om2b.status === 'pending' && slotCredits(om2.id) === 0 &&
    !om2b.vp_wx_order_id &&
    eventsOf(wxWrong).some((e) => e.result === 'wrong_provider'),
    'provider=' + om2.provider + ' status=' + om2b.status +
    ' credits=' + slotCredits(om2.id) + ' result=' + eventsOf(wxWrong).map((e) => e.result).join(','));

  // ── E. 重付换号重签 ───────────────────────────────────────────────
  const E1 = await newFamily('E');
  const e1 = await place(E1.token, 'child_slot', 1, 1);
  const oe1 = orderOf(e1.j.order.id);
  const payAgain = await req('POST', `/api/pay/orders/${oe1.id}/pay`, {}, E1.token);
  const oe1b = orderOf(oe1.id);
  ok('E1 /pay 重付换发新支付单号', payAgain.status === 200 &&
    payAgain.j.payParams?.virtual && oe1b.pay_order_no !== oe1.pay_order_no,
    oe1.pay_order_no + ' → ' + oe1b.pay_order_no);
  ok('E2 业务单号不变', oe1b.out_trade_no === oe1.out_trade_no);
  ok('E3 新 signData 用新支付单号', sdOf(payAgain).outTradeNo === oe1b.pay_order_no);
  const retry = await req('POST', `/api/pay/orders/${oe1.id}/vp-retry`, {}, E1.token);
  const oe1c = orderOf(oe1.id);
  ok('E4 vp-retry 再次换号', retry.status === 200 &&
    oe1c.pay_order_no !== oe1b.pay_order_no && sdOf(retry).outTradeNo === oe1c.pay_order_no,
    oe1b.pay_order_no + ' → ' + oe1c.pay_order_no);

  // ── F. 查单兜底与 scheduler 补发货 ────────────────────────────────
  const F1 = await newFamily('F1');
  const f1 = await place(F1.token, 'child_slot', 1, 1);
  const of1 = orderOf(f1.j.order.id);
  const mpaid = await req('POST', '/api/admin/pay/vp/mock-paid',
    { payOrderNo: of1.pay_order_no }, AT);
  ok('F1 模拟平台标记已支付', mpaid.status === 200 && mpaid.j.paid.includes(of1.pay_order_no));
  const q1 = await req('POST', `/api/pay/orders/${of1.id}/query`, {}, F1.token);
  ok('F2 查单兜底当场入账', q1.status === 200 && q1.j.paid === true &&
    orderOf(of1.id).status === 'paid', JSON.stringify([q1.j.paid, orderOf(of1.id).status]));

  const F2 = await newFamily('F2');
  const f2 = await place(F2.token, 'child_slot', 1, 1);
  const of2 = orderOf(f2.j.order.id);
  await req('POST', '/api/admin/pay/vp/mock-paid', { payOrderNo: of2.pay_order_no }, AT);
  const tick = await req('POST', '/api/admin/pay/vp/mock-tick', {}, AT);
  ok('F3 scheduler tick 补发货', tick.status === 200 && Number(tick.j.applied) >= 1 &&
    orderOf(of2.id).status === 'paid', JSON.stringify([tick.j.scanned, tick.j.applied]));
  await req('POST', '/api/admin/pay/vp/mock-clear', {}, AT);
  const F3 = await newFamily('F3');
  const f3 = await place(F3.token, 'child_slot', 1, 1);
  const q3 = await req('POST', `/api/pay/orders/${f3.j.order.id}/query`, {}, F3.token);
  ok('F4 未支付单查单返回 paid=false', q3.status === 200 && q3.j.paid === false);

  // ── G. iOS 退款问询（按权益状态）与退款推送 ────────────────────────
  const ios1 = await raw('POST', pushUrl(), JSON.stringify({
    Event: 'xpay_subscribe_ios_refund_query_notify', WxOrderId: 'WX-IOS-1',
    Attach: String(ov1.id), OutTradeNo: ov1.out_trade_no,
  }));
  let iosj = {}; try { iosj = JSON.parse(ios1.text); } catch { /* 忽略 */ }
  ok('G1 已发货且未退款 → 拦截(1)', iosj.result_code === 1 && String(iosj.evidence).includes(String(ov1.id)),
    JSON.stringify(iosj));
  const ios2 = await raw('POST', pushUrl(), JSON.stringify({
    Event: 'xpay_subscribe_ios_refund_query_notify', WxOrderId: 'WX-IOS-2',
    Attach: String(of2.id), OutTradeNo: of2.out_trade_no,
  }));
  // of2 已由 scheduler 补发货，所以也是「已发货」；另造一张真正 pending 的单
  const G0 = await newFamily('G0');
  const g0 = await place(G0.token, 'child_slot', 1, 1);
  const ios3 = await raw('POST', pushUrl(), JSON.stringify({
    Event: 'xpay_subscribe_ios_refund_query_notify', WxOrderId: 'WX-IOS-3',
    Attach: String(g0.j.order.id), OutTradeNo: g0.j.order.outTradeNo,
  }));
  let iosj3 = {}; try { iosj3 = JSON.parse(ios3.text); } catch { /* 忽略 */ }
  ok('G2 未发货 → 放行(0)', iosj3.result_code === 0, JSON.stringify(iosj3));
  ok('G3 退款问询 3 秒内有应答', ios1.status === 200 && ios3.status === 200);
  const iosXml = await raw('POST', pushUrl(), pushXml({
    event: 'xpay_subscribe_ios_refund_query_notify', wx: 'WX-IOS-XML',
    out: ov1.out_trade_no, attach: ov1.id, actual: 0,
  }), 'application/xml');
  ok('G4 XML 问询回 XML', iosXml.status === 200 && iosXml.text.includes('<result_code>'),
    iosXml.text.slice(0, 90));

  const beforeRefund = storageOf(V4.fid);
  const rf = await raw('POST', pushUrl(), JSON.stringify({
    Event: 'xpay_refund_notify', WxOrderId: 'WX-REFUND-1', RefundId: 'RF-1',
    Attach: String(ov4.id), OutTradeNo: ov4.out_trade_no,
  }));
  const afterRefund = storageOf(V4.fid);
  ok('G5 退款推送收回权益', rf.status === 200 && Number(orderOf(ov4.id).refund_at) > 0 &&
    afterRefund < beforeRefund, beforeRefund + ' → ' + afterRefund);
  const rf2 = await raw('POST', pushUrl(), JSON.stringify({
    Event: 'xpay_refund_notify', WxOrderId: 'WX-REFUND-2', RefundId: 'RF-2',
    Attach: String(ov4.id), OutTradeNo: ov4.out_trade_no,
  }));
  ok('G6 重复退款推送只生效一次', rf2.status === 200 && storageOf(V4.fid) === afterRefund);
  const ios4 = await raw('POST', pushUrl(), JSON.stringify({
    Event: 'xpay_subscribe_ios_refund_query_notify', WxOrderId: 'WX-IOS-4',
    Attach: String(ov4.id), OutTradeNo: ov4.out_trade_no,
  }));
  let iosj4 = {}; try { iosj4 = JSON.parse(ios4.text); } catch { /* 忽略 */ }
  ok('G7 已退款 → 放行(0)', iosj4.result_code === 0, JSON.stringify(iosj4));
  // 虚拟支付的款不在 V3 商户号里，后台主动退款必须硬拦，且不能动权益
  const rVp = await req('POST', `/api/admin/orders/${ov1.id}/refund`, {}, AT);
  ok('G8 虚拟支付单后台主动退款被硬拦',
    rVp.status === 409 && rVp.j.error === 'vp_refund_not_supported' &&
    Number(orderOf(ov1.id).refund_at) === 0,
    'status=' + rVp.status + ' error=' + rVp.j.error);

  // ── H. 金额边界：最低支付额与 buyQuantity 上限 ─────────────────────
  ok('H1 临时把 1GB 包价改成 50 分',
    (await req('PATCH', '/api/admin/config', { price_pack_1g_cents: '50' }, AT)).status === 200);
  const H1 = await newFamily('H1');
  const h1 = await place(H1.token, 'storage_gb', 1, 1);
  ok('H2 低于最低支付额直接拒绝', h1.status === 400 && h1.j.error === 'vp_amount_too_small',
    'status=' + h1.status + ' ' + h1.j.error);
  ok('H3 恢复 1GB 包价',
    (await req('PATCH', '/api/admin/config', { price_pack_1g_cents: '990' }, AT)).status === 200);
  ok('H4 临时把 100GB 包价改到超限',
    (await req('PATCH', '/api/admin/config', { price_pack_100g_cents: '999999' }, AT)).status === 200);
  const H2 = await newFamily('H2');
  const h2 = await place(H2.token, 'storage_gb', 100, 1);
  ok('H5 buyQuantity 超上限被拒绝', h2.status === 400 && h2.j.error === 'vp_quantity_too_large',
    'status=' + h2.status + ' ' + h2.j.error);
  ok('H6 恢复 100GB 包价',
    (await req('PATCH', '/api/admin/config', { price_pack_100g_cents: '25500' }, AT)).status === 200);

  // ── J. 统一消息推送入口（MP 后台的真实配置）────────────────────────
  // MP 后台【开发管理 → 消息推送】全局只有一个 URL / 一个 Token：合规的异步
  // 检测结果和虚拟支付发货推送都会打到 /api/wx/msg-push。这条不测，上线后
  // 发货推送会被静默吞掉，只剩 5 分钟一次的查单兜底。
  const WX_TOKEN = 'test-wx-push-token';
  const patchWx = await req('PATCH', '/api/admin/config', { wx_msg_token: WX_TOKEN }, AT);
  ok('J0 消息推送 Token 可写入', patchWx.status === 200 && cfg().wx_msg_token === WX_TOKEN,
    'status=' + patchWx.status + ' value=' + cfg().wx_msg_token);
  const wxPushUrl = (extra = {}) => {
    const ts = String(Date.now() + Math.floor(Math.random() * 1000));
    const nonce = 'j' + Math.random().toString(36).slice(2, 10);
    const q = new URLSearchParams({
      signature: signatureOf(ts, nonce, WX_TOKEN), timestamp: ts, nonce, ...extra,
    });
    return '/api/wx/msg-push?' + q.toString();
  };
  const jGet = await raw('GET', wxPushUrl({ echostr: 'hello-unified' }));
  ok('J1 统一入口 GET 校验回 echostr', jGet.status === 200 && jGet.text === 'hello-unified',
    'status=' + jGet.status + ' body=' + jGet.text);
  const jBad = await raw('GET', '/api/wx/msg-push?signature=x&timestamp=1&nonce=2&echostr=hi');
  ok('J2 统一入口错签名 403', jBad.status === 403);

  // 官方字段：平台单号在 WeChatPayInfo.MchOrderNo，道具在 GoodsInfo 下
  const J1 = await newFamily('J1');
  const j1 = await place(J1.token, 'child_slot', 1, 1);
  const oj1 = orderOf(j1.j.order.id);
  const jwx = 'WX-UNIFIED-' + Date.now();
  const jBody = {
    Event: 'xpay_goods_deliver_notify',
    OpenId: 'openid-j1',
    OutTradeNo: oj1.pay_order_no,
    WeChatPayInfo: { MchOrderNo: jwx },
    GoodsInfo: { ProductId: 'child_1y', Quantity: 1, GoodsPrice: oj1.amount_cents },
  };
  const jp = await raw('POST', wxPushUrl(), JSON.stringify(jBody));
  ok('J3 统一入口官方嵌套 JSON 推送入账',
    jp.status === 200 && orderOf(oj1.id).status === 'paid' && slotCredits(oj1.id) === 1,
    'status=' + jp.status + ' order=' + orderOf(oj1.id).status + ' credits=' + slotCredits(oj1.id));
  ok('J4 平台单号从 MchOrderNo 落库', orderOf(oj1.id).vp_wx_order_id === jwx,
    'vp_wx_order_id=' + orderOf(oj1.id).vp_wx_order_id);
  const jp2 = await raw('POST', wxPushUrl(), JSON.stringify(jBody));
  ok('J5 统一入口重放不重复发权益',
    jp2.status === 200 && slotCredits(oj1.id) === 1 && eventsOf(jwx).length === 1,
    'credits=' + slotCredits(oj1.id) + ' events=' + eventsOf(jwx).length);

  // 官方文档说发货推送默认 XML（MP 后台数据格式也可能选 JSON），两种都要吃下
  const J2 = await newFamily('J2');
  const j2 = await place(J2.token, 'child_slot', 1, 1);
  const oj2 = orderOf(j2.j.order.id);
  const jwx2 = 'WX-UNIFIED-XML-' + Date.now();
  const jXml = '<xml>' +
    '<Event><![CDATA[xpay_goods_deliver_notify]]></Event>' +
    `<OutTradeNo><![CDATA[${oj2.pay_order_no}]]></OutTradeNo>` +
    `<WeChatPayInfo><MchOrderNo><![CDATA[${jwx2}]]></MchOrderNo></WeChatPayInfo>` +
    `<GoodsInfo><ProductId><![CDATA[child_1y]]></ProductId><Quantity>1</Quantity>` +
    `<GoodsPrice>${oj2.amount_cents}</GoodsPrice></GoodsInfo>` +
    '</xml>';
  const jpx = await raw('POST', wxPushUrl(), jXml, 'application/xml');
  ok('J6 统一入口官方 XML 嵌套推送入账',
    jpx.status === 200 && orderOf(oj2.id).status === 'paid' &&
    orderOf(oj2.id).vp_wx_order_id === jwx2,
    'status=' + jpx.status + ' body=' + jpx.text.slice(0, 80));

  const jOther = await raw('POST', wxPushUrl(), JSON.stringify({ Event: 'some_other_event' }));
  ok('J7 非 xpay 事件仍回合规 success', jOther.status === 200 && jOther.text === 'success',
    'status=' + jOther.status + ' body=' + jOther.text.slice(0, 60));

  // ── I. 关闸回滚 + 后台不回密钥 ─────────────────────────────────────
  const stEnd = await req('GET', '/api/admin/pay/status', undefined, AT);
  ok('I1 后台状态不回 AppKey / notifyToken',
    !('appKey' in (stEnd.j.virtual || {})) && !('notifyToken' in (stEnd.j.virtual || {})) &&
    !stEnd.text.includes(APP_KEY), JSON.stringify(stEnd.j.virtual));
  ok('I2 关闭总闸', (await setEnabled('0', AT)).status === 200);
  const I1 = await newFamily('I');
  const i1 = await place(I1.token, 'child_slot', 1, 1);
  ok('I3 关闸后新单回 mock（虚拟支付代码不执行）',
    i1.status === 200 && i1.j.order?.provider === 'mock' && !i1.j.payParams?.virtual,
    'provider=' + i1.j.order?.provider);
  const stFinal = await req('GET', '/api/admin/pay/status', undefined, AT);
  ok('I4 最终总闸关闭', stFinal.j.virtual?.enabled === false);
  ok('I5 恢复默认价格', cfg().price_pack_1g_cents === '990' && cfg().price_pack_100g_cents === '25500');

  // ── K. 下单前刷新 session_key（2026-11-05 真机 -15005 的根本修复）────
  //     端上带一份刚 wx.login() 出来的 wxCode，服务端现场 code2session 换 key，
  //     并校验 openid 属于当前用户，绝不能拿别人的微信身份签名。
  await setEnabled('1', AT);
  const K = await newFamily('K');
  const k1 = await req('POST', '/api/pay/orders',
    { kind: 'child_slot', qty: 1, years: 1, wxCode: 'vp-stranger-' + Date.now() }, K.token);
  ok('K1 陌生 wxCode 被身份闸门拒绝',
    k1.status === 409 && k1.j?.error === 'vp_session_expired',
    'status=' + k1.status + ' body=' + JSON.stringify(k1.j));

  // WX_MOCK 下 code2session 由 code 派生 openid，故复用注册时的同一个 code 即匹配
  const kCode = 'vp-K-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const kl = await req('POST', '/api/wx/login', { code: kCode });
  const kr = await req('POST', '/api/wx/register-family', {
    ticket: kl.j.ticket, familyName: '虚拟支付验收K2', parentName: '家长K2',
  });
  const k2 = await req('POST', '/api/pay/orders',
    { kind: 'child_slot', qty: 1, years: 1, wxCode: kCode }, kr.j.token);
  const sdK2 = sdOf(k2);
  ok('K2 携带匹配 wxCode 正常下单并签名',
    k2.status === 200 && k2.j.order?.provider === 'virtual' &&
    !!k2.j.payParams?.virtual?.signature && sdK2.productId === 'child_1y',
    'status=' + k2.status + ' sig=' + String(k2.j.payParams?.virtual?.signature || '').slice(0, 12));
  const expectSig = createHmac('sha256', SESSION_KEY)
    .update(String(k2.j.payParams?.virtual?.signData || '')).digest('hex');
  ok('K3 刷新后 signature 仍与 session_key 绑定',
    k2.j.payParams?.virtual?.signature === expectSig);
  const k3 = await req('POST', `/api/pay/orders/${k2.j.order.id}/pay`, { wxCode: kCode }, kr.j.token);
  ok('K4 重付路径同样接受 wxCode 且换发单号',
    k3.status === 200 && !!k3.j.payParams?.virtual?.signature &&
    sdOf(k3).outTradeNo !== sdK2.outTradeNo,
    'status=' + k3.status);
  // ── L. 微信真机首单的真实推送形状（2026-11-05 20:1x 安卓实测）──────
  //     实测是 JSON：实付在 GoodsInfo.ActualPrice（分）、订单 id 在 GoodsInfo.Attach、
  //     平台单号在 WeChatPayInfo.MchOrderNo，且没有 Channel / OrderType 字段。
  const L = await newFamily('L');
  const l1 = await place(L.token, 'child_slot', 1, 1);
  const ol1 = orderOf(l1.j.order.id);
  const lwx = 'VPO-REAL-' + Date.now();
  const realBody = {
    ToUserName: 'gh_test', FromUserName: 'openid-test',
    CreateTime: Math.floor(Date.now() / 1000), MsgType: 'event',
    Event: 'xpay_goods_deliver_notify', OpenId: 'openid-test',
    OutTradeNo: ol1.pay_order_no || ol1.out_trade_no,
    WeChatPayInfo: { MchOrderNo: lwx, TransactionId: 'TX-' + lwx, PaidTime: Math.floor(Date.now() / 1000) },
    Env: 0,
    GoodsInfo: {
      ProductId: 'child_1y', Quantity: 1, OrigPrice: ol1.amount_cents,
      ActualPrice: ol1.amount_cents, Attach: String(ol1.id),
    },
    RetryTimes: 0,
  };
  const lp = await raw('POST', wxPushUrl(), JSON.stringify(realBody));
  ok('L1 真机实测字段形状正常入账',
    lp.status === 200 && orderOf(ol1.id).status === 'paid' && slotCredits(ol1.id) === 1 &&
    eventsOf(lwx).some((e) => e.result === 'applied'),
    'status=' + lp.status);

  // ── L2. 安卓真机退款推送（xpay_refund_notify）+ 续期型空间退款 ───────
  //     实测退款推送既没有 Attach 也没有 OutTradeNo，只有
  //     WxOrderId / MchOrderId / WxRefundId / MchRefundId / RefundFee。
  const R = await newFamily('L2');
  const r1 = await place(R.token, 'storage_gb', 1, 1);
  const or1 = orderOf(r1.j.order.id);
  const rwx1 = 'VPO-L2-' + Date.now() + '-A';
  const deliver1 = await raw('POST', wxPushUrl(), JSON.stringify(
    pushBody({ wx: rwx1, out: or1.pay_order_no, attach: or1.id, actual: or1.amount_cents })
  ));
  ok('L2-0 首单发货入账', deliver1.status === 200 && orderOf(or1.id).status === 'paid',
    'status=' + deliver1.status);
  const r2 = await place(R.token, 'storage_gb', 1, 1);
  const or2 = orderOf(r2.j.order.id);
  const rwx2 = 'VPO-L2-' + Date.now() + '-B';
  await raw('POST', wxPushUrl(), JSON.stringify(
    pushBody({ wx: rwx2, out: or2.pay_order_no, attach: or2.id, actual: or2.amount_cents })
  ));
  const bytesBefore = storageOf(R.fid);
  const expiresBefore = storageExpiresOf(R.fid);
  ok('L2-0b 两笔 1GB×1年叠成同容量续期', bytesBefore === 1073741824 &&
    Number(orderOf(or2.id).added_qty) === 0 && expiresBefore > 0,
    'bytes=' + bytesBefore + ' added2=' + orderOf(or2.id).added_qty);
  const refundBody = {
    ToUserName: 'gh_test', FromUserName: 'openid-test',
    CreateTime: Math.floor(Date.now() / 1000), MsgType: 'event',
    Event: 'xpay_refund_notify', OpenId: 'openid-test',
    WxOrderId: rwx1,
    MchOrderId: or1.out_trade_no,
    WxRefundId: 'VPR-L2-A', MchRefundId: 'VPR-L2-A-M',
    RefundFee: or1.amount_cents, RetCode: 0, RetMsg: 'ok', RetryTimes: 0,
  };
  const rp = await raw('POST', wxPushUrl(), JSON.stringify(refundBody));
  const bytesAfter = storageOf(R.fid);
  const expiresAfter = storageExpiresOf(R.fid);
  ok('L2-1 真机退款字段能找到订单并记账',
    rp.status === 200 && Number(orderOf(or1.id).refund_at) > 0 &&
    eventsOf(rwx1).some((e) => e.event === 'xpay_refund_notify' && e.result === 'refunded'),
    'status=' + rp.status + ' refund_at=' + orderOf(or1.id).refund_at);
  ok('L2-2 同单号发货流水不被退款事件串改',
    eventsOf(rwx1).some((e) => e.event === 'xpay_goods_deliver_notify' && e.result === 'applied'));
  ok('L2-3 续期型空间退款保留容量', bytesAfter === bytesBefore,
    bytesBefore + ' → ' + bytesAfter);
  ok('L2-4 续期型空间退款回退到期',
    expiresAfter > 0 && expiresAfter < expiresBefore &&
    expiresBefore - expiresAfter > 300 * 86400,
    expiresBefore + ' → ' + expiresAfter);
  const replay = await raw('POST', wxPushUrl(), JSON.stringify(refundBody));
  ok('L2-5 退款重放幂等', replay.status === 200 &&
    storageOf(R.fid) === bytesAfter && storageExpiresOf(R.fid) === expiresAfter);

  // 金额不符的部分退款：只记流水、不收权益
  const r3 = await place(R.token, 'child_slot', 1, 1);
  const or3 = orderOf(r3.j.order.id);
  const rwx3 = 'VPO-L2-' + Date.now() + '-C';
  await raw('POST', wxPushUrl(), JSON.stringify(
    pushBody({ wx: rwx3, out: or3.pay_order_no, attach: or3.id, actual: or3.amount_cents })
  ));
  const partRefund = await raw('POST', wxPushUrl(), JSON.stringify({
    Event: 'xpay_refund_notify', WxOrderId: rwx3, MchOrderId: or3.out_trade_no,
    WxRefundId: 'VPR-L2-C', RefundFee: Math.floor(or3.amount_cents / 2), RetCode: 0,
  }));
  ok('L2-6 部分退款金额不符只记异常不收权益',
    partRefund.status === 200 && Number(orderOf(or3.id).refund_at) === 0 &&
    slotCredits(or3.id) === 1 &&
    eventsOf(rwx3).some((e) => e.result === 'refund_amount_mismatch'));

  // 连 MchOrderId 都不给，只靠平台单号反查 orders.vp_wx_order_id
  const r4 = await place(R.token, 'child_slot', 1, 1);
  const or4 = orderOf(r4.j.order.id);
  const rwx4 = 'VPO-L2-' + Date.now() + '-D';
  await raw('POST', wxPushUrl(), JSON.stringify(
    pushBody({ wx: rwx4, out: or4.pay_order_no, attach: or4.id, actual: or4.amount_cents })
  ));
  const wxOnly = await raw('POST', wxPushUrl(), JSON.stringify({
    Event: 'xpay_refund_notify', WxOrderId: rwx4,
    WxRefundId: 'VPR-L2-D', RefundFee: or4.amount_cents, RetCode: 0,
  }));
  ok('L2-7 仅平台单号也能反查订单退款',
    wxOnly.status === 200 && Number(orderOf(or4.id).refund_at) > 0,
    'refund_at=' + orderOf(or4.id).refund_at);

  // 名额续费单退款：到期日必须回退对应时长（12 个月 = 365 天）
  const r5 = await newFamily('L3');
  const chRes = await req('POST', '/api/children',
    { name: '退款娃', avatar: 'rat', birthday: '2020-01-01', sex: 'male' }, r5.token);
  const childId = Number(chRes.j?.id ?? 0);
  // 续费单只对付费名额开放（免费孩子会被 child_slot_free 拦），
  // 先把这个孩子置成「已付费 1 年」的前置状态。
  if (childId > 0) {
    db.prepare('UPDATE users SET slot_expires = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) + 365 * 86400, childId);
  }
  const r5o = await req('POST', '/api/pay/orders',
    { kind: 'child_slot', qty: 1, years: 1, childId }, r5.token);
  const or5 = r5o.j?.order?.id ? orderOf(r5o.j.order.id) : null;
  const slotExpiresOf = () =>
    Number(db.prepare('SELECT slot_expires FROM users WHERE id = ?').get(childId)?.slot_expires ?? 0);
  if (or5) {
    const rwx5 = 'VPO-L2-' + Date.now() + '-E';
    await raw('POST', wxPushUrl(), JSON.stringify(
      pushBody({ wx: rwx5, out: or5.pay_order_no, attach: or5.id, actual: or5.amount_cents })
    ));
    const exp5 = slotExpiresOf();
    const refund5 = await raw('POST', wxPushUrl(), JSON.stringify({
      Event: 'xpay_refund_notify', WxOrderId: rwx5, MchOrderId: or5.out_trade_no,
      WxRefundId: 'VPR-L2-E', RefundFee: or5.amount_cents, RetCode: 0,
    }));
    const exp5b = slotExpiresOf();
    ok('L2-8 名额续费单退款回退对应时长',
      refund5.status === 200 && Number(orderOf(or5.id).refund_at) > 0 &&
      exp5 > 0 && exp5 - exp5b >= 360 * 86400,
      exp5 + ' → ' + exp5b);
  } else {
    ok('L2-8 名额续费单退款回退对应时长', false,
      '下单失败 status=' + r5o.status + ' err=' + JSON.stringify(r5o.j));
  }

  await setEnabled('0', AT);
  const stK = await req('GET', '/api/admin/pay/status', undefined, AT);
  ok('K5 验收结束总闸关闭', stK.j.virtual?.enabled === false);

  db.close();
  console.log('\nVIRTUAL-PAY ' + pass + '/' + (pass + fail) + ' PASS');
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('验收脚本异常：', e);
  db.close();
  process.exit(1);
});
