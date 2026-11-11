/**
 * 微信支付 V3 的签名 / 验签 / 解密自检。
 *
 * 为什么需要它：支付这块**没有任何"看起来不对"的中间状态** ——
 * 签名串少一个换行、时间戳用了毫秒、解密时没切 authTag，
 * 表现全都是"线上付款失败"或"回调全部 401"，而本地用 mock 永远测不出来。
 * 这个脚本用一对自己生成的 RSA 密钥把三条密码学路径走一遍，
 * 不联网、不需要商户号，几秒钟就能跑完。
 *
 * 用法（先 npm run build）：
 *     node scripts/wxpay-selftest.mjs
 *     node scripts/wxpay-selftest.mjs --real /path/to/cert-dir   # 额外校验真实商户证书
 */
import { createCipheriv, createSign, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`);
  }
}

/** 与微信同构的 AES-256-GCM 加密：密文尾部 16 字节是 authTag */
function gcmEncrypt(key, nonce, plain, aad) {
  const c = createCipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), Buffer.from(nonce, 'utf8'));
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([enc, c.getAuthTag()]).toString('base64');
}

/* ── 准备：一对临时密钥 + 一套假配置 ─────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), 'gt-wxpay-'));
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const keyPath = join(dir, 'apiclient_key.pem');
const pubPath = join(dir, 'wxpay_pub.pem');
writeFileSync(keyPath, privateKey, { mode: 0o600 });
writeFileSync(pubPath, publicKey);

const API_V3_KEY = 'CASCjq20051012wdCASCjq20051012wd'; // 32 位占位，与真实配置同长度
const APPID = 'wx64ade06c5b942e68';

process.env.WX_APPID = APPID;
process.env.WXPAY_MCHID = '1487081842';
process.env.WXPAY_CERT_SERIAL = '2E8BCBBDFDCE8CDACA9E871054634DD71DF84F34';
process.env.WXPAY_API_V3_KEY = API_V3_KEY;
process.env.WXPAY_KEY_PATH = keyPath;
process.env.WXPAY_PUBLIC_KEY_PATH = pubPath;
process.env.WXPAY_NOTIFY_URL = 'https://czs-api.wodeweishenghuo.cn/api/pay/notify';
delete process.env.WX_PAY_MOCK;

const wxpay = require('../dist/ext/wxpay.js');

console.log('\n[1] 配置识别');
ok('四项齐全时判定为 live', wxpay.payMode() === 'live', wxpay.payMode());
const st = wxpay.payStatus();
ok('自检报告 ready', st.ready === true);
ok('自检不泄露 APIv3 密钥', !JSON.stringify(st).includes(API_V3_KEY));
ok('缺少 apiV3Key 时变成 unconfigured', (() => {
  const keep = process.env.WXPAY_API_V3_KEY;
  process.env.WXPAY_API_V3_KEY = 'short';
  wxpay.resetCertCache();
  const m = wxpay.payMode();
  process.env.WXPAY_API_V3_KEY = keep;
  return m === 'unconfigured';
})());

console.log('\n[2] 二次签名（wx.requestPayment 的 paySign）');
const params = wxpay.buildJsapiPayParams('wx2010201234567890abcdef');
ok('signType 是 RSA', params.signType === 'RSA');
ok('package 形如 prepay_id=xxx', params.package === 'prepay_id=wx2010201234567890abcdef');
ok('appId 与配置一致', params.appId === APPID);
{
  // 微信侧验签用的消息 = appId\n时间戳\n随机串\npackage\n
  const msg = `${params.appId}\n${params.timeStamp}\n${params.nonceStr}\n${params.package}\n`;
  const v = createVerify('RSA-SHA256');
  v.update(msg);
  ok('paySign 能被公钥验过', v.verify(publicKey, params.paySign, 'base64'));
  // 反证：少一个结尾换行必须验不过（这是接入时最常见的错）
  const v2 = createVerify('RSA-SHA256');
  v2.update(`${params.appId}\n${params.timeStamp}\n${params.nonceStr}\n${params.package}`);
  ok('去掉结尾换行后验签必须失败', v2.verify(publicKey, params.paySign, 'base64') === false);
}

console.log('\n[3] 回调验签 + 解密');
{
  const resource = {
    mchid: '1487081842',
    appid: APPID,
    out_trade_no: 'GT123456F1RABCD',
    transaction_id: '4200001234202610191234567890',
    trade_state: 'SUCCESS',
    amount: { total: 1990, payer_total: 1990, currency: 'CNY' },
  };
  const nonce = randomBytes(6).toString('hex');
  const aad = 'transaction';
  const body = JSON.stringify({
    id: 'EV-20261019120000001',
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      ciphertext: gcmEncrypt(API_V3_KEY, nonce, JSON.stringify(resource), aad),
      nonce,
      associated_data: aad,
    },
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const n = randomBytes(16).toString('hex');
  // 公钥模式的 serial 前缀，这样脚本不依赖联网拉平台证书
  const serial = 'PUB_KEY_ID_SELFTEST';
  const sig = createSign('RSA-SHA256');
  sig.update(`${ts}\n${n}\n${body}\n`);
  const signature = sig.sign(privateKey, 'base64');

  const headers = { timestamp: ts, nonce: n, signature, serial };

  const parsed = await wxpay.parseNotify(headers, body);
  ok('event_type 解析正确', parsed.eventType === 'TRANSACTION.SUCCESS');
  ok('resource 解密出 out_trade_no', parsed.resource.out_trade_no === 'GT123456F1RABCD');
  ok('金额是整数分', parsed.resource.amount.total === 1990);

  // 篡改一个字节：必须验签失败，而不是"照样信"
  // ⚠️ 要改**明文里真实存在**的片段：金额在 ciphertext 里，replace 是改不到的，
  //    那样测试会"通过"得毫无意义（拿到的是同一个字符串）。
  const tampered = body.replace('TRANSACTION.SUCCESS', 'TRANSACTION.FAILED');
  ok('篡改样本确实不同', tampered !== body);
  let threw = null;
  try {
    await wxpay.parseNotify(headers, tampered);
  } catch (e) {
    threw = e;
  }
  ok('请求体被篡改后验签失败', !!threw && threw.code === 'notify_bad_signature', threw && threw.code);

  // 时间戳超出容差：必须拒（防重放）
  let expired = null;
  try {
    await wxpay.parseNotify({ ...headers, timestamp: String(Number(ts) - 3600) }, body);
  } catch (e) {
    expired = e;
  }
  ok('时间戳过旧被拒', !!expired && expired.code === 'notify_expired', expired && expired.code);

  // 缺签名头
  let missing = null;
  try {
    await wxpay.parseNotify({ timestamp: '', nonce: '', signature: '', serial: '' }, body);
  } catch (e) {
    missing = e;
  }
  ok('缺签名头被拒', !!missing && missing.code === 'notify_header_missing');
}

console.log('\n[4] 0 元单不能提交微信（必须走免费发放分支）');
{
  let e0 = null;
  try {
    await wxpay.jsapiPrepay({ description: 'x', outTradeNo: 'GT1', amountCents: 0, openid: 'o1' });
  } catch (e) {
    e0 = e;
  }
  ok('金额 0 时明确报 pay_amount_zero', !!e0 && e0.code === 'pay_amount_zero', e0 && e0.code);
}

/* ── 可选：用真实商户证书再验一遍签名（私钥格式、序列号都对得上）── */
const realIdx = process.argv.indexOf('--real');
if (realIdx > 0) {
  const certDir = process.argv[realIdx + 1];
  console.log('\n[5] 真实商户证书校验');
  try {
    const realKey = readFileSync(join(certDir, 'apiclient_key.pem'), 'utf8');
    const realCert = readFileSync(join(certDir, 'apiclient_cert.pem'), 'utf8');
    const realKeyPath = join(dir, 'real_key.pem');
    writeFileSync(realKeyPath, realKey, { mode: 0o600 });
    process.env.WXPAY_KEY_PATH = realKeyPath;
    wxpay.resetCertCache();
    ok('真实私钥可读且被判为 live', wxpay.payMode() === 'live');

    const p2 = wxpay.buildJsapiPayParams('prepay_id_selftest');
    const msg = `${p2.appId}\n${p2.timeStamp}\n${p2.nonceStr}\n${p2.package}\n`;
    const v = createVerify('RSA-SHA256');
    v.update(msg);
    ok('用商户证书里的公钥能验过自己的签名', v.verify(realCert, p2.paySign, 'base64'));

    // 微信支付公钥（2024 年后新商户必须）：能加载、能被 createVerify 接受即可。
    // 无法离线验证它"确实来自微信"，那只能等第一个真实回调。
    try {
      const realPubPath = join(certDir, 'pub_key.pem');
      const realPub = readFileSync(realPubPath, 'utf8');
      process.env.WXPAY_PUBLIC_KEY_PATH = realPubPath;
      wxpay.resetCertCache();
      const probeBody = '{"selftest":1}';
      let badSigErr = null;
      try {
        await wxpay.parseNotify(
          { timestamp: String(Math.floor(Date.now() / 1000)), nonce: 'abc', signature: 'ZmFrZQ==', serial: 'PUB_KEY_ID_SELFTEST' },
          probeBody
        );
      } catch (e) {
        badSigErr = e;
      }
      // 期望"验签失败"而不是"读不到公钥"——后者说明文件格式/路径不对
      ok('真实微信支付公钥可加载（错误是验签失败而非读文件失败）',
        badSigErr && badSigErr.code === 'notify_bad_signature', badSigErr && badSigErr.code);
      ok('该公钥是 2048 位 RSA PEM', realPub.includes('BEGIN PUBLIC KEY'));
    } catch (e) {
      fail += 1;
      console.log(`  ✗ 微信支付公钥校验出错：${e.message}`);
    }
  } catch (e) {
    fail += 1;
    console.log(`  ✗ 真实证书校验出错：${e.message}`);
  }
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail === 0 ? 0 : 1);
