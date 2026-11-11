/**
 * UGC 内容安全回归验收（2026-11-05 · 70 项）
 *
 * 跑法（服务必须从仓库根目录启动，findSchemaPath 依赖 cwd）：
 *   PORT=3920 DATA_DIR=/tmp/gt-sec/data WX_MOCK=1 WX_PAY_MOCK=1 \
 *     ADMIN_PASSWORD=test123 JWT_SECRET=local node server/dist/index.js
 *   GT_TEST_BASE=http://127.0.0.1:3920 GT_TEST_DATA_DIR=/tmp/gt-sec/data \
 *     node server/scripts/content-security-test.mjs
 *
 * 覆盖：平台开关与值域校验 / 密钥掩码与审计脱敏 / 微信消息推送验签 /
 *       全局 preHandler 文本规则表 / 人工队列与通过·下架·重审 /
 *       违规文本替换（含 feedback 双表与跨家庭隔离）/ 图片静态闸门与微信回源签名 /
 *       视频人工巡查 / media_check_async 异步回调 / 五个策略开关组合。
 *
 * WX_MOCK 下用文本标记词模拟微信判定：
 *   模拟违规 → risky，模拟待审 → review，模拟检测失败 → 接口异常。
 */
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const BASE = process.env.GT_TEST_BASE || 'http://127.0.0.1:3920';
const DATA_DIR = process.env.GT_TEST_DATA_DIR || '/tmp/gt-sec/data';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(path.join(DATA_DIR, 'money-jar.db'));

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + '  ' + extra); }
}

async function req(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { j = {}; }
  return { status: r.status, j };
}
async function raw(method, path) {
  const r = await fetch(BASE + path, { method });
  return { status: r.status, text: await r.text() };
}
async function newFamily(tag) {
  const lg = await req('POST', '/api/wx/login', { code: 'sec-' + tag + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) });
  const reg = await req('POST', '/api/wx/register-family', {
    ticket: lg.j.ticket, familyName: '安全验收' + tag, parentName: '家长' + tag,
  });
  const row = db.prepare("SELECT family_id FROM users WHERE role='parent' ORDER BY id DESC LIMIT 1").get();
  return { token: reg.j.token, fid: row.family_id };
}
const cfg = () => Object.fromEntries(db.prepare('SELECT key, value FROM platform_config').all().map(r => [r.key, r.value]));
const checks = (sql = '', ...args) => db.prepare('SELECT * FROM content_checks ' + sql + ' ORDER BY id DESC').all(...args);
const one = (id) => db.prepare('SELECT * FROM content_checks WHERE id = ?').get(id);
function sign(token, ts, nonce) {
  return createHash('sha1').update([token, ts, nonce].sort().join('')).digest('hex');
}

// 1×1 透明 PNG + 一个假的 mp4 头（上传只校验 data URL 格式，不校验编解码）
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6Q8GQAAAABJRU5ErkJggg==';
const VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=';

(async () => {
  // ── A. 后台登录与配置 ────────────────────────────────────────────
  const adm = await req('POST', '/api/admin/login', { username: 'admin', password: 'test123' });
  ok('A1 admin 登录', adm.status === 200 && !!adm.j.token, 'status=' + adm.status);
  const AT = adm.j.token;

  const c0 = await req('GET', '/api/admin/config', undefined, AT);
  ok('A2 出厂默认总闸开启', c0.status === 200 && c0.j.config.content_sec_enabled === '1',
    'enabled=' + c0.j.config?.content_sec_enabled);
  ok('A3 五个开关默认值正确',
    c0.j.config.content_sec_block_risky === '1' &&
    c0.j.config.content_sec_review_queue === '1' &&
    c0.j.config.content_sec_hold_pending === '0' &&
    c0.j.config.content_sec_fail_closed === '0',
    JSON.stringify([c0.j.config.content_sec_block_risky, c0.j.config.content_sec_review_queue,
      c0.j.config.content_sec_hold_pending, c0.j.config.content_sec_fail_closed]));

  const st0 = await req('GET', '/api/admin/content/status', undefined, AT);
  ok('A4 状态卡 enabled/mock=true', st0.status === 200 && st0.j.enabled === true && st0.j.mock === true,
    JSON.stringify([st0.j.enabled, st0.j.mock]));
  ok('A5 状态卡计数与库内一致',
    st0.j.pending === db.prepare("SELECT COUNT(*) c FROM content_checks WHERE status='pending'").get().c &&
    st0.j.removed === db.prepare("SELECT COUNT(*) c FROM content_checks WHERE status='removed'").get().c &&
    st0.j.risky === db.prepare("SELECT COUNT(*) c FROM content_checks WHERE status='risky'").get().c,
    JSON.stringify([st0.j.pending, st0.j.removed, st0.j.risky]));

  const bad1 = await req('PATCH', '/api/admin/config', { content_sec_public_base_url: 'http://bad.example/' }, AT);
  ok('A6 公网基址拒绝 http', bad1.status === 400, 'status=' + bad1.status);
  const bad2 = await req('PATCH', '/api/admin/config', { content_sec_public_base_url: 'https://a.example/' }, AT);
  ok('A7 公网基址拒绝尾斜杠', bad2.status === 400, 'status=' + bad2.status);
  const bad3 = await req('PATCH', '/api/admin/config', { content_sec_enabled: '2' }, AT);
  ok('A8 布尔开关拒绝非 0/1', bad3.status === 400, 'status=' + bad3.status);

  const BASEURL = 'https://czs-api.wodeweishenghuo.cn';
  const good = await req('PATCH', '/api/admin/config', { content_sec_public_base_url: BASEURL }, AT);
  ok('A9 公网基址写入成功', good.status === 200 && cfg().content_sec_public_base_url === BASEURL,
    'db=' + cfg().content_sec_public_base_url);
  const st1 = await req('GET', '/api/admin/content/status', undefined, AT);
  ok('A10 回调 URL 拼对', st1.j.callbackUrl === BASEURL + '/api/wx/msg-push', st1.j.callbackUrl);

  const TOKEN = 'gt-sec-test-token-9527';
  await req('PATCH', '/api/admin/config', { wx_msg_token: TOKEN }, AT);
  const masked = await req('GET', '/api/admin/config', undefined, AT);
  ok('A11 wx_msg_token 落库明文、GET 只回掩码',
    cfg().wx_msg_token === TOKEN && masked.j.config.wx_msg_token === '******',
    'get=' + masked.j.config.wx_msg_token);
  await req('PATCH', '/api/admin/config', { wx_msg_token: '******', content_sec_enabled: '1' }, AT);
  ok('A12 PATCH 传掩码不覆盖真值', cfg().wx_msg_token === TOKEN, 'db=' + cfg().wx_msg_token);
  const audit = db.prepare("SELECT detail FROM admin_logs WHERE action='update_platform_config' ORDER BY id DESC LIMIT 1").get();
  ok('A13 审计日志密钥脱敏', !!audit && !String(audit.detail).includes(TOKEN));

  // ── B. 微信消息推送验签 ──────────────────────────────────────────
  const ts = String(Math.floor(Date.now() / 1000)), nonce = 'nb9527';
  const sg = sign(TOKEN, ts, nonce);
  const verify = await raw('GET', `/api/wx/msg-push?signature=${sg}&timestamp=${ts}&nonce=${nonce}&echostr=hello-wx`);
  ok('B1 GET 服务器地址校验返回 echostr', verify.status === 200 && verify.text === 'hello-wx',
    verify.status + ' ' + verify.text);
  const badSig = await raw('GET', `/api/wx/msg-push?signature=deadbeef&timestamp=${ts}&nonce=${nonce}&echostr=hello-wx`);
  ok('B2 错误签名 GET 403', badSig.status === 403, 'status=' + badSig.status);
  const badPost = await req('POST', `/api/wx/msg-push?signature=deadbeef&timestamp=${ts}&nonce=${nonce}`, { Event: 'wxa_media_check' });
  ok('B3 错误签名 POST 403', badPost.status === 403, 'status=' + badPost.status);
  const beforeNoop = checks().length;
  const noop = await req('POST', `/api/wx/msg-push?signature=${sg}&timestamp=${ts}&nonce=${nonce}`, { Event: 'other' });
  ok('B4 非检测事件回 success 且不记流水', noop.status === 200 && checks().length === beforeNoop,
    'status=' + noop.status + ' rows+' + (checks().length - beforeNoop));

  // ── C. 文本检测（规则表 / 拦截 / 放行）────────────────────────────
  const A = await newFamily('A');
  ok('C1 家长会话建立成功', !!A.token && A.fid > 0, 'fid=' + A.fid);

  const fbOk = await req('POST', '/api/feedback', { content: '这是一条很正常的反馈内容' }, A.token);
  ok('C2 正常文本放行', fbOk.status === 200 && fbOk.j.ok === true, 'status=' + fbOk.status);
  let rows = checks();
  ok('C3 正常文本记 pass 流水', rows.length >= 1 && rows[0].status === 'pass' &&
    rows[0].biz_type === '文本·问题反馈' && rows[0].family_id === A.fid,
    JSON.stringify([rows[0]?.status, rows[0]?.biz_type, rows[0]?.family_id]));

  const fbRisky = await req('POST', '/api/feedback', { content: '模拟违规：这段内容不该发布' }, A.token);
  ok('C4 违规文本 400 content_risky',
    fbRisky.status === 400 && fbRisky.j.error === 'content_risky', 'status=' + fbRisky.status);
  ok('C5 违规文本没写进业务表',
    db.prepare('SELECT COUNT(*) c FROM feedback WHERE content = ?').get('模拟违规：这段内容不该发布').c === 0);
  const riskyRow = checks()[0];
  ok('C6 违规流水 status=risky / scene=2 / kind=text',
    riskyRow.status === 'risky' && riskyRow.scene === 2 && riskyRow.kind === 'text' &&
    riskyRow.suggest === 'risky' && riskyRow.biz_table === 'feedback',
    JSON.stringify([riskyRow.status, riskyRow.scene, riskyRow.kind, riskyRow.biz_table]));

  const fbReview = await req('POST', '/api/feedback', { content: '模拟待审：机器拿不准的一段话' }, A.token);
  ok('C7 review 文本先发后巡（200）', fbReview.status === 200, 'status=' + fbReview.status);
  const reviewRow = checks()[0];
  ok('C8 review 流水进人工队列 status=pending',
    reviewRow.status === 'pending' && reviewRow.suggest === 'review', reviewRow.status);

  const famBad = await req('PATCH', '/api/family', { name: '模拟违规家庭名' }, A.token);
  const famRow = checks()[0];
  ok('C9 用户资料类（家庭名）也走检测 scene=1',
    famBad.status === 400 && famRow.scene === 1 && famRow.biz_type.indexOf('用户资料') === 0,
    'status=' + famBad.status + ' scene=' + famRow.scene);

  // 规则表覆盖：另一个 POST 入口（商品分类名）也要被全局钩子抓到
  const catBad = await req('POST', '/api/product-categories', { name: '模拟违规分类', icon: 'gift' }, A.token);
  const catRow = checks()[0];
  ok('C10 商品分类名命中规则表',
    catRow.biz_type === '文本·商品分类名' && catRow.status === 'risky',
    catRow.biz_type + '/' + catRow.status + ' http=' + catBad.status);

  // 后台自产内容不送检
  const beforeAdmin = checks().length;
  await req('POST', '/api/admin/login-wall', { content: '模拟违规但这是运营自产' }, AT);
  ok('C11 运营后台自产内容不进 UGC 检测', checks().length === beforeAdmin,
    'rows=' + checks().length + ' before=' + beforeAdmin);

  const disabled = await req('PATCH', '/api/admin/config', { content_sec_enabled: '0' }, AT);
  const fbOff = await req('POST', '/api/feedback', { content: '模拟违规但总闸已关' }, A.token);
  const stOff = await req('GET', '/api/admin/content/status', undefined, AT);
  ok('C12 总闸关闭时不做检测不记流水',
    disabled.status === 200 && fbOff.status === 200 && stOff.j.enabled === false &&
    checks().length === beforeAdmin,
    'http=' + fbOff.status + ' rows=' + checks().length);
  await req('PATCH', '/api/admin/config', { content_sec_enabled: '1' }, AT);

  // ── D. 人工审核队列与处置 ────────────────────────────────────────
  const todo = await req('GET', '/api/admin/content-checks?status=todo&size=100', undefined, AT);
  ok('D1 待处置队列含 pending/risky',
    todo.status === 200 && todo.j.rows.some(r => r.status === 'pending') &&
    todo.j.rows.some(r => r.status === 'risky'), 'total=' + todo.j.total);
  ok('D2 后台响应抹掉 family_id、改叫 familyRef',
    todo.j.rows.every(r => !('family_id' in r) && 'familyRef' in r));
  const all = await req('GET', '/api/admin/content-checks?status=all&size=100', undefined, AT);
  ok('D3 全部流水条数 ≥ 待处置', all.j.total >= todo.j.total,
    all.j.total + ' >= ' + todo.j.total);
  const search = await req('GET', '/api/admin/content-checks?status=all&q=' + encodeURIComponent('模拟待审'), undefined, AT);
  ok('D4 按内容搜索命中', search.j.total >= 1, 'total=' + search.j.total);
  const noAuth = await req('GET', '/api/admin/content-checks');
  ok('D5 未登录后台 401', noAuth.status === 401, 'status=' + noAuth.status);

  const badAct = await req('POST', `/api/admin/content-checks/${riskyRow.id}/review`, { action: 'delete' }, AT);
  ok('D6 非法处置动作 400', badAct.status === 400, 'status=' + badAct.status);
  const nf = await req('POST', '/api/admin/content-checks/999999/review', { action: 'approve' }, AT);
  ok('D7 不存在的流水 404', nf.status === 404, 'status=' + nf.status);

  const ap = await req('POST', `/api/admin/content-checks/${riskyRow.id}/review`, { action: 'approve', note: '复核后放行' }, AT);
  ok('D8 人工通过 → pass', ap.status === 200 && one(riskyRow.id).status === 'pass' &&
    one(riskyRow.id).review_note === '复核后放行', one(riskyRow.id).status);
  const rm = await req('POST', `/api/admin/content-checks/${reviewRow.id}/review`, { action: 'remove' }, AT);
  ok('D9 人工下架 → removed + redacted=true', rm.status === 200 &&
    one(reviewRow.id).status === 'removed' && rm.j.redacted === true,
    'status=' + one(reviewRow.id).status + ' redacted=' + rm.j.redacted);

  // ── E. 违规文本替换（feedback 双表）──────────────────────────────
  const fbThread = await req('GET', '/api/feedback', undefined, A.token);
  const thread = fbThread.j.threads.find(t => t.content === '[内容已下架]');
  ok('E1 反馈主表正文被替换成占位文案', !!thread,
    'contents=' + JSON.stringify(fbThread.j.threads.map(t => t.content)));
  ok('E2 feedback_messages 首条消息同步替换（双写修复）',
    !!thread && thread.messages.length > 0 && thread.messages[0].content === '[内容已下架]',
    'msg=' + (thread?.messages?.[0]?.content ?? 'none'));

  // 跨家庭隔离：两家写一模一样的文字，只下架 A 家，B 家必须原样保留
  const B = await newFamily('B');
  const sameText = '模拟待审：跨家庭隔离校验-' + Date.now();
  await req('POST', '/api/feedback', { content: sameText }, B.token);
  const bRow = checks()[0];
  ok('E3 B 家同文本独立成一条流水', bRow.family_id === B.fid && bRow.status === 'pending',
    'fid=' + bRow.family_id);
  await req('POST', '/api/feedback', { content: sameText }, A.token);
  const aRow = checks()[0];
  const rmA = await req('POST', `/api/admin/content-checks/${aRow.id}/review`, { action: 'remove' }, AT);
  ok('E4 下架 A 家同文本 → removed + redacted',
    rmA.status === 200 && rmA.j.redacted === true && one(aRow.id).status === 'removed',
    'redacted=' + rmA.j.redacted);
  const bLeft = db.prepare('SELECT COUNT(*) c FROM feedback_messages WHERE content = ?').get(sameText).c;
  ok('E5 处置不跨家庭污染（B 家原文保留）', bLeft === 1, 'left=' + bLeft);

  const reopened = await req('POST', `/api/admin/content-checks/${reviewRow.id}/review`, { action: 'reopen' }, AT);
  ok('E6 重新待审 → pending', reopened.status === 200 && one(reviewRow.id).status === 'pending',
    one(reviewRow.id).status);

  // ── F. 图片上传 + 静态文件闸门 ───────────────────────────────────
  const up = await req('POST', '/api/upload/image', { data: PNG }, A.token);
  ok('F1 图片上传成功', up.status === 200 && /^\/uploads\/.+\.png$/.test(up.j.url || ''), up.j.url);
  const imgUrl = up.j.url;
  const imgRow = checks()[0];
  ok('F2 图片登记检测流水（kind=image / media_url 一致）',
    imgRow.kind === 'image' && imgRow.media_url === imgUrl && imgRow.status === 'pass',
    JSON.stringify([imgRow.kind, imgRow.media_url, imgRow.status]));
  const g1 = await raw('GET', imgUrl);
  ok('F3 正常图片可访问', g1.status === 200, 'status=' + g1.status);

  const rmImg = await req('POST', `/api/admin/content-checks/${imgRow.id}/review`, { action: 'remove' }, AT);
  ok('F4 人工下架图片 → removed', rmImg.status === 200 && one(imgRow.id).status === 'removed');
  const g2 = await raw('GET', imgUrl);
  const wxsec = createHmac('sha256', TOKEN).update(imgUrl).digest('hex').slice(0, 24);
  const g2sig = await raw('GET', imgUrl + '?wxsec=' + wxsec);
  ok('F5 下架后 /uploads 返回 404', g2.status === 404, 'status=' + g2.status);
  ok('F5b 已下架内容带有效签名也不能绕过', g2sig.status === 404, 'status=' + g2sig.status);
  await req('POST', `/api/admin/content-checks/${imgRow.id}/review`, { action: 'approve' }, AT);
  const g3 = await raw('GET', imgUrl);
  ok('F6 通过后又可访问', g3.status === 200, 'status=' + g3.status);

  await req('POST', `/api/admin/content-checks/${imgRow.id}/review`, { action: 'reopen' }, AT);
  await req('PATCH', '/api/admin/config', { content_sec_hold_pending: '1' }, AT);
  const g4 = await raw('GET', imgUrl);
  ok('F7 先审后发：pending 图片不可访问', g4.status === 404, 'status=' + g4.status);
  const g4wx = await raw('GET', imgUrl + '?wxsec=' + wxsec);
  const g4bad = await raw('GET', imgUrl + '?wxsec=deadbeef');
  ok('F7b 微信回源下载带有效签名放行', g4wx.status === 200, 'status=' + g4wx.status);
  ok('F7c 伪造签名仍被挡', g4bad.status === 404, 'status=' + g4bad.status);
  await req('PATCH', '/api/admin/config', { content_sec_hold_pending: '0' }, AT);
  const g5 = await raw('GET', imgUrl);
  ok('F8 关掉先审后发后放行', g5.status === 200, 'status=' + g5.status);

  // ── G. 视频人工巡查（微信无检测接口）────────────────────────────
  const vid = await req('POST', '/api/upload/media', { data: VIDEO }, A.token);
  ok('G1 视频上传成功', vid.status === 200 && vid.j.type === 'video', JSON.stringify(vid.j));
  const vidRow = checks()[0];
  ok('G2 视频全部进人工巡查队列',
    vidRow.kind === 'video' && vidRow.status === 'pending' &&
    String(vidRow.note).indexOf('微信暂无视频内容安全接口') >= 0,
    JSON.stringify([vidRow.kind, vidRow.status, vidRow.note]));
  ok('G3 视频流水带 media_url', vidRow.media_url === vid.j.url, vidRow.media_url);

  // ── H. media_check_async 异步回调 ───────────────────────────────
  const TRACE = 'trace-accept-0001';
  db.prepare('UPDATE content_checks SET trace_id = ?, status = ? WHERE id = ?').run(TRACE, 'pending', imgRow.id);
  const cb = await req('POST', `/api/wx/msg-push?signature=${sg}&timestamp=${ts}&nonce=${nonce}`, {
    Event: 'wxa_media_check', trace_id: TRACE, errcode: 0,
    result: { suggest: 'risky', label: 20001 },
  });
  ok('H1 risky 回调返回 success', cb.status === 200 && cb.j !== undefined, 'status=' + cb.status);
  ok('H2 回调按 trace_id 落地自动下架', one(imgRow.id).status === 'removed' &&
    String(one(imgRow.id).note).indexOf('微信判定违规') >= 0, one(imgRow.id).status);
  const g6 = await raw('GET', imgUrl);
  ok('H3 自动下架后图片 404', g6.status === 404, 'status=' + g6.status);

  const beforeUnknown = checks().length;
  const unknownTrace = 'trace-not-exist-' + Date.now();
  await req('POST', `/api/wx/msg-push?signature=${sg}&timestamp=${ts}&nonce=${nonce}`, {
    Event: 'wxa_media_check', trace_id: unknownTrace, result: { suggest: 'pass' },
  });
  ok('H4 未知 trace_id 回调留一条待审（不静默丢）',
    checks().length === beforeUnknown + 1 && checks()[0].status === 'pending' &&
    String(checks()[0].note).indexOf('未匹配') >= 0,
    'rows+' + (checks().length - beforeUnknown));

  const TRACE2 = 'trace-accept-0002';
  db.prepare('UPDATE content_checks SET trace_id = ?, status = ? WHERE id = ?').run(TRACE2, 'pending', vidRow.id);
  await req('POST', `/api/wx/msg-push?signature=${sg}&timestamp=${ts}&nonce=${nonce}`, {
    Event: 'wxa_media_check', trace_id: TRACE2, errcode: 40001, errmsg: 'invalid media',
  });
  ok('H5 回调 errcode → check_failed 待巡查',
    one(vidRow.id).status === 'check_failed' &&
    String(one(vidRow.id).note).indexOf('微信回调失败') >= 0,
    one(vidRow.id).status);

  // ── I. 开关组合 ─────────────────────────────────────────────────
  await req('PATCH', '/api/admin/config', { content_sec_block_risky: '0' }, AT);
  const fbNoBlock = await req('POST', '/api/feedback', { content: '模拟违规但不拦截' }, A.token);
  ok('I1 关掉违规拦截后内容可发、仍记 risky 流水',
    fbNoBlock.status === 200 && checks()[0].status === 'risky',
    'http=' + fbNoBlock.status + ' status=' + checks()[0].status);
  await req('PATCH', '/api/admin/config', { content_sec_block_risky: '1' }, AT);

  await req('PATCH', '/api/admin/config', { content_sec_review_queue: '0' }, AT);
  await req('POST', '/api/feedback', { content: '模拟待审但不进队列' }, A.token);
  ok('I2 关掉人工队列后 review 记 pass', checks()[0].status === 'pass', checks()[0].status);
  await req('PATCH', '/api/admin/config', { content_sec_review_queue: '1' }, AT);

  // 模拟微信接口超时/报错：默认放行并进人工队列，打开 fail_closed 才拒绝发布
  const f1 = await req('POST', '/api/feedback', { content: '模拟检测失败：默认放行' }, A.token);
  ok('I5 检测失败默认放行并记 check_failed 待巡查',
    f1.status === 200 && checks()[0].status === 'check_failed' &&
    String(checks()[0].note).indexOf('待人工巡查') >= 0,
    'http=' + f1.status + ' status=' + checks()[0].status);
  await req('PATCH', '/api/admin/config', { content_sec_fail_closed: '1' }, AT);
  const f2 = await req('POST', '/api/feedback', { content: '模拟检测失败：严格拦截' }, A.token);
  ok('I6 fail_closed=1 时拒绝发布（503）',
    f2.status === 503 && f2.j.error === 'content_check_unavailable',
    'http=' + f2.status + ' err=' + f2.j.error);
  ok('I7 fail_closed 拦截时同样留流水', checks()[0].status === 'check_failed', checks()[0].status);
  await req('PATCH', '/api/admin/config', { content_sec_fail_closed: '0' }, AT);

  const stEnd = await req('GET', '/api/admin/content/status', undefined, AT);
  ok('I3 状态卡汇总与库内一致',
    stEnd.j.removed === db.prepare("SELECT COUNT(*) c FROM content_checks WHERE status='removed'").get().c &&
    stEnd.j.pending === db.prepare("SELECT COUNT(*) c FROM content_checks WHERE status='pending'").get().c,
    JSON.stringify([stEnd.j.removed, stEnd.j.pending]));
  ok('I4 回调 Token 状态显示已配置', stEnd.j.pushTokenConfigured === true);

  // ── J. 收尾：恢复出厂默认，方便测试页继续点 ─────────────────────
  await req('PATCH', '/api/admin/config', { content_sec_hold_pending: '0' }, AT);
  console.log('\n============================================');
  console.log(`CONTENT-SECURITY ${pass}/${pass + fail} PASS`);
  console.log('============================================');
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exitCode = 1; });
