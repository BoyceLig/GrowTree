# 小程序虚拟支付接入设计（方案 A2 · 分品道具直购）

> 版本 v2.6.2 · 2026-11-05 · 状态：**空间扩容、虚拟支付参数层、孩子名额年限包、多年制+等值折算+年数折扣均已上线（`20261104-5`）；虚拟支付下单 / 发货 / 退款推送链路已全量落码并通过本地 74 项模拟验收，总闸仍默认关闭，待 MP 后台 6 件道具发布后真机验证**  
> v2.6.2（2026-11-05 18:5x，按 MP 后台 3 张截图定环境与分步）：用户已把 6 件道具价格改成元（29.90 / 51.90 / 69.90 / 85.90 / 99.90 / 0.01），消息推送页（URL / Token / 明文 / JSON）与后台参数均已核对无误。**`vp_env` 定 `0 · 现网`**：官方明确沙箱只适合开发版 / 体验版的开发者工具内调试、真机预览会被 `PAYMENT_ILLEGAL_IN_SANDBOX` 拦截，iOS 不支持沙箱且 `-15011` 规定现网版本 env 只能为 0；`vp_env` 还决定用哪把 AppKey，切换易漏改导致 `-15006`。新增 §16.5 F「环境选择与上线分步」；修正 E 段三处口径：**真机最小单是 1GB × 1 年 = ¥9.90**（0.01 元是道具单价，订单恒 ≥ 990 分，不存在 ¥1 测试单）、**iOS 必须正式版真机**（本项目当前仍是体验版 `WX_MP_STATE=trial`，Apple 路径暂时测不了）、道具发布后等 **10–30 分钟**同步。`admin/index.html` 环境下拉补 hint，验收台待办 5 → 6 条。  
> v2 变更（用户 14:48 拍板）：孩子名额与存储空间**分开建道具** —— 孩子名额按 1–5 年建 5 件固定价道具，存储空间建 1 件 1 分单位道具。原 v1「全站 1 件 `manalong_unit` 包打天下」作废，差异见 §13。  
> v2.1（20:58）：空间道具名去「点数」；新增 §15 空间扩容付费体验方案。  
> v2.2（21:05 用户拍板并落码）：基础容量确认 **500MB**；只读宽限 **15 → 90 天**；空间道具定名（名称见 v2.2.2 定稿）；**100G 档保留上架**；6 档包价改为后台可填；名额年限 **1–3 → 1–5 年**；新付费页保持**底部弹窗**；道具暂不创建，虚拟支付参数做到后台可填即生效。详见 §15 / §16。  
> v2.2.1（22:29）：空间道具名先去掉品牌前缀；最终定名见下行。道具 ID `storage_unit`、1 分单价、后台参数与已落码逻辑一律不变；MP 后台尚未创建道具，直接按最终名填即可，不涉及改名成本。  
> v2.2.2（22:33 用户改定）：空间道具名最终定为「**存储空间扩容包**」—— 加回「存储」限定，用途一眼可辨，Apple 弹窗显示「存储空间扩容包 ¥142.90」。道具 ID / 1 分单价 / 后台参数 / 已落码逻辑全部不变。  
> v2.3（22:53 用户拍板）：孩子名额 1 年基础价 **19.9 → 29.9 元**，改用「**激进版 5 档年限包**」29.9 / 51.9 / 69.9 / 85.9 / 99.9 元；V3 微信支付与虚拟支付**共用同一张 `platform_config` 价目表**；**一次只能买 1 个名额**（`maxQty=1` / `buyQuantity=1`）；后台 5 档只读展示（固定价道具发布后不可改）。详见 §17。  
> v2.3 发版（23:30）：随 `20261104-4` 上线（云端镜像 + 小程序体验版）。线上新 6 档包价、5 档名额价、`pool_grace_days=90`、`help_seed_version=7` 均按 DEFAULTS 自动补齐，帮助文章 33 篇无重复；MP 后台 6 件道具仍未创建，下单/发货链路当时未接（**此状态已被 v2.6 取代：链路代码已全量落码，仅剩道具发布与真机验证**）。  
> v2.4（2026-11-05 用户拍板）：存储空间改「**一年制 + 等值折算**」——只卖 1 年、**标价即实付**（应付 = 目标档整包价，升档不再出现补差总价）；旧池剩余时间不折钱、按 `P(cur)/P(target)` **等值折算成天数**叠加在新到期（付款日 + 1 年）之后；纯续费折算率 1:1 与旧顺延规则逐秒一致。取消年数 chips 与 `extend`/`expandOnly` 语义。详见 §15.9。半截池脏数据修复（`activePoolUnits` 对 <1GB 残留到期日返回无池）一并落码。  
> v2.5（2026-11-05 用户反悔一年制，拍板回「**多年制 + 等值折算 + 年数递减折扣**」）：空间恢复 1–5 年可选；**应付 = `P(target) × years × disc(years)`**（1 年不打折、2 年 9.2 折 / 3 年 8.5 折 / 4 年 8.0 折 / 5 年 7.5 折，后台按「折」可调，取自「在名额的基础上力度稍微减减」）；折算改为**向上取整到天**（不足 1 天按 1 天送，每单最多让利不到 1 天）；新到期 = `now + years×365 天 + carryDays`。折扣**不参与折算率**（折算恒用 1 年价，折扣锁进池子价值）。详见 §15.9。  
> v2.6（2026-11-05 夜，用户拍板「道具还没建，先落代码」）：§16.4 八项中的 1–7 全部落码 —— DB 迁移、provider 分流、发货 / 退款 / iOS 退款问询推送、查单与 scheduler 兜底、公开路径白名单、`sessionKeyOfUser()`、端上 virtual 分支与静默重登。`server/scripts/virtualpay-test.mjs` 本地模拟验收 **74/74 PASS**（可重复运行）。iOS 退款问询按「已发货且未回收权益 → 拦截(1)，其余放行(0)」实现；后台主动退款对虚拟支付单硬拦（款不在 V3 商户号，iOS 只能走 App Store），等 `xpay_refund_notify` 自动收权益。**总闸 `pay_virtual_enabled` 仍默认关闭，MP 后台 6 件道具未创建，真机小额付款未验证。**  
> v2.6.1（2026-11-05 18:2x，按 MP 后台 4 张实测截图核对）：修复两处上线隐患 —— ① MP【开发管理 → 消息推送】全局只有一个 URL / 一个 Token，合规回调与虚拟支付发货推送共用；`/api/wx/msg-push` 原先只处理 `wxa_media_check`，`xpay_*` 会被静默吞掉（权益只能靠 5 分钟查单补发）。现按 `Event` 前缀分发到 `handleVirtualPayNotify()`，两个入口共用 `vp_events` 幂等流水，JSON / XML 都收。② 官方推送字段是 `WeChatPayInfo.MchOrderNo` / `GoodsInfo.*` 嵌套结构，新增 `flattenVpNotify()` 摊平 + 「单价 × 数量」还原实付 + `OrderType=7` 识别 Apple 单。验收补 J0–J7 → **74/74 PASS**，合规 70/70、租户 168/168 无回归。另新增 §16.5 MP 后台配置清单（道具价格单位、Token / AES、两个开关）。
> 适用：商业版 `server/src/ext/`、`miniprogram/`、`admin/`、`deploy-cloud/.env`  
> 依据：微信开放文档《虚拟支付：企业、个体户》及 `wx.requestVirtualPayment` 接口规则（2026-09-14 版）

---

## 0. 一句话结论

**不发行代币。** MP 后台建 **6 件道具**：孩子名额 1–5 年各 1 件固定价道具（`child_1y` … `child_5y`，5 档年限整包价（1 年 29.9 元起，5 年 99.9 元，见 §17）），存储空间 1 件 **1 分单位道具** `storage_unit`（名称「存储空间扩容包」），把空间的动态金额拆成「1 分 × N 份」。一次 `wx.requestVirtualPayment` 完成支付，发货推送复用现有 `applyPaidOrder()` 发权益。

```
孩子名额 → productId = child_Ny, goodsPrice = slotPackPriceCents(N) 分, buyQuantity = 1
存储空间 → productId = storage_unit, goodsPrice = 1 分, buyQuantity = 应付分数
                          ↓
        一次支付 → xpay_goods_deliver_notify → applyPaidOrder()
```

「一次付完、不剩余」是**结构上的必然**，不是靠补偿逻辑保证的。相比 v1，孩子名额有了真实商品名（Apple 弹窗显示「孩子名额1年 ¥29.90」），消除了「通用点数被所有加购共用」的描述风险；`buyQuantity` 上限风险也只剩空间这一条路径。

---

## 1. 现状与接入边界

### 1.1 现有链路（V3，保留给存量单）

| 环节       | 文件 / 函数                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------- |
| 计价       | `server/src/ext/payments.ts` → `quote(familyId, kind, qty, years, childId, extend)`                 |
| 落单       | `payments.ts` → `createOrder()`，写 `orders`，`provider='wxpay'`（mock 时 `'mock'`、`兑换码` 时 `'redeem'`）   |
| 下单/查单/回调 | `server/src/ext/routes/pay.ts` → `POST /pay/orders`、`POST /pay/orders/:id/query`、`POST /pay/notify` |
| 入账       | `payments.ts` → `applyPaidOrder(orderId, transactionId)`（条件 UPDATE，天然幂等）                            |
| 退款       | `payments.ts` → `refundOrder()`（V3 `refundPayment()` + 权益回收事务）                                      |
| 端上       | `miniprogram/src/utils/pool-pay.ts` → `executePay(orderId, payParams)`                              |
| 三个下单入口   | `subpkg-pay/pages/buy.vue`（付旧单）、`components/SlotBuySheet.vue`、`components/StorageBuySheet.vue`      |

### 1.2 必须记住的三条边界

1. **独立商户号**：虚拟支付用的是 MP 后台新开的二级商户号（`OfferId` + 现网 `AppKey`），和现有 `WXPAY_MCHID` / APIv3 证书**完全不通用**，不能混用、不能互相查单。
2. **全端切换，不是只切 iOS**：`wx.requestVirtualPayment` 按设备自动路由 —— Android / 鸿蒙 / Windows → 微信支付，iOS → Apple 支付。所以打开开关后**新单全端走虚拟支付**，V3 只保留「存量订单退款 + 未切前的老单」。
3. **iOS 未开通时不能出现购买入口**：项目已有 `pay_ios_enabled`（默认 `0`）与端上 `blocked = isIOS && !iosEnabled`，这套机制保留，虚拟支付真机验证通过后才打开。

### 1.3 硬约束（写进代码注释）

| 约束           | 值                                                                    | 代码落点                                                         |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| 道具单价必须与后台一致  | 孩子名额 `goodsPrice = slotPackPriceCents(years)` 分；空间 `goodsPrice=1` 分  | `payments.ts` 的 5 档价目表（V3 / 虚拟支付共用）+ `virtualpay.ts` 的 ID 映射 |
| 动态金额不能直接传    | **只限空间**：`buyQuantity = amountCents`；孩子名额固定 `buyQuantity=1`          | `buildPayData()`                                             |
| iOS 单笔最低     | 1 元 = 100 分                                                          | `quote()` 兜底 `Math.max(100, amount)`                         |
| `outTradeNo` | 8–32 位、不以 `_` 开头、**每次拉起支付必须换新**                                      | `newPayOrderNo()`                                            |
| 双签名          | `paySig` 用 AppKey、`signature` 用 `session_key`                        | `signPayData()`                                              |
| iOS 用户条件     | iOS ≥15、微信 ≥8.0.68、大陆 App Store 账号                                   | 端上 `checkIosVersion()`                                       |
| 费率           | 非 iOS 1%（腾讯技术服务费，阶段性优惠）；iOS 12%（Apple 佣金）                            | 定价决策，见 §11                                                   |
| 结算           | 非 iOS T+3 冻结；iOS Apple 45–60 天                                       | 财务对账                                                         |
| 退款           | 非 iOS 可主动退；**iOS 只有用户能在 App Store 申请**，开发者无主动退款权限                    | 后台订单页禁用按钮                                                    |
| 发货依据         | 以 `xpay_goods_deliver_notify` 为准 + `query_order` 兜底；前端 `success` 不作数 | §8                                                           |

---

## 2. 数据库改造

### 2.1 `orders` 增列

在 `server/src/ext/migrate.ts` 的 `addOrderColumns()`（约 line 711 的 `orderCols` 数组）追加：

```js
['pay_order_no', 'TEXT'],            // 本次拉起支付实际用的单号（重试会换），不 UNIQUE：只在本次有效
['vp_wx_order_id', 'TEXT'],         // 平台单号 wx_order_id，对账/客服用
['vp_channel', "TEXT NOT NULL DEFAULT ''"], // 'wxpay' | 'apple'，发货推送里回带
```

⚠️ 顺序问题（项目里踩过）：`orders` 有表重建型迁移，**新列必须放在重建之后**的 `ALTER` 循环里，和 `refund_at / added_qty` 同一批。

`provider` 列无 CHECK 约束（`TEXT NOT NULL DEFAULT 'mock'`），直接多一个取值 `'virtual'`，**不需要改表约束**。`status` 的 CHECK 也不变（仍是 `pending/paid/canceled/failed`，退款用 `refund_at > 0` 表示）。

### 2.2 新表 `vp_events`（推送审计 + 重放防护）

```sql
CREATE TABLE IF NOT EXISTS vp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,              -- xpay_goods_deliver_notify / xpay_refund_notify / ...
  wx_order_id TEXT,                  -- 平台单号，作为幂等键
  out_trade_no TEXT,
  order_id INTEGER,
  payload TEXT NOT NULL,             -- 原始推送正文（原文，不格式化）
  result TEXT NOT NULL DEFAULT '',   -- applied / ignored / error:xxx
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vp_events_dedup
  ON vp_events(event, wx_order_id) WHERE wx_order_id IS NOT NULL AND wx_order_id <> '';
CREATE INDEX IF NOT EXISTS idx_vp_events_order ON vp_events(order_id);
```

**为什么保留原文**：微信推送只给一次、本地复现不了；线上对不上的推送要靠原文回放。项目里 `/pay/notify` 也是同样的习惯（原始字节单独留一份）。

---

## 3. 配置与凭证

### 3.1 `platform_config` 新增键

> ✅ **已落码，见 §16**。2026-11-04 21:05 用户要求「参数在后台填好即可用」，  
> 实际实现的是 10 个键（含 4 个密钥类），不是早期草案里的 3 个：  
> `pay_virtual_enabled` / `vp_offer_id` / `vp_app_key` / `vp_sandbox_app_key` /  
> `vp_env` / `vp_storage_product_id` / `vp_notify_token` / `vp_aes_key` /  
> `vp_notify_url` / `vp_min_cents`。

要点（与早期草案的差别）：

- **没有 `vp_unit_cents`**：A2 下空间道具固定 1 分，金额由 `quote()` 算（配置在 6 档容量包键），`VP_GOODS` 只存道具 ID；孩子名额的 5 档价目表放在 `platform_config`。
- **`vp_min_cents` 是「拒绝」不是「抬价」**：金额低于它就抛 `vp_amount_too_small` / `storage_expand_need_renew`，绝不默默多收钱（2026-11-04 15:20 已定）。
- **密钥类键 GET 回掩码**：`adminPlatformConfig()` 把已配置值替换成 `'******'`，PATCH 传掩码视为不修改，审计日志同步脱敏。
- 校验分支覆盖全部 10 键：开关 `'0'/'1'`、URL 必须 https、ID 只许字母数字 `-`/`_`、密钥长度 ≤ 512。

已有的 `pay_ios_enabled` 继续用（含义不变），后台 `#c-pay-ios` 开关文案改成「开放（虚拟支付已验证通过后才打开）」。

### 3.2 环境变量（只放 `deploy-cloud/.env`，不进版本库）

沿用 `wxpay.ts` 的 `env(key)` 约定：

```
VP_ENABLED=1                 # 服务端总闸，缺它所有虚拟支付接口直接 503
VP_OFFER_ID=...                # MP → 虚拟支付 → 基本配置
VP_APP_KEY=...                 # 现网 AppKey（支付签名，只放服务端）
VP_SANDBOX_APP_KEY=...         # 可选；iOS 不支持沙箱，安卓联调用
VP_ENV=0                       # 0 现网 / 1 沙箱
VP_STORAGE_PRODUCT_ID=storage_unit  # 空间 1 分单位道具；孩子名额 5 个 ID 在 VP_GOODS，价格读 platform_config 的 5 档价目表（与 V3 共用）
VP_NOTIFY_TOKEN=...            # MP → 发货推送配置里填的校验 Token
VP_AES_KEY=                    # 安全模式的 43 位加解密密钥；明文模式留空
VP_NOTIFY_URL=https://czs-api.wodeweishenghuo.cn/api/pay/vp/notify
```

> ⚠️ **2026-11-04 v2.2 起这些只是「回落通道」**（见 §16）。首选在管理后台  
> 「平台参数 → 虚拟支付（小程序）」里填：存 `platform_config`、密钥不回显、  
> 改完即时生效、不用重启容器。后台某键留空时才读同名环境变量。  
> `VP_ENABLED` / `VP_ENV` 也各有后台对应键（`pay_virtual_enabled` / `vp_env`）。  
> `deploy-cloud/env.example` 与 `docker-compose.yml` 已补齐全部键名。

⚠️ `VP_APP_KEY` 等价于 APIv3 密钥，绝不写进 `platform_config`（后台配置接口会返回给管理端）、绝不进镜像。`deploy-cloud/env.example` 里只加键名和说明，不填值。

### 3.3 MP 后台（人工，一次性）

| 位置           | 操作                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| 支付与交易 → 虚拟支付 | 开通、二级商户进件、扫码签约（审核 1–7 工作日）                                                                                      |
| 基本配置         | 记下 `OfferId`、现网 `AppKey`；配置**小程序简称**；打开「是否启用苹果 IAP 支付」                                                          |
| 道具管理         | 建 **6 件**（见下表），道具图统一 200×200 PNG/JPG、<200KB；`start_upload_goods` → `start_publish_goods` 逐件发布；**发布后等约 10 分钟生效** |
| 发货订阅         | 推送 URL 填 `VP_NOTIFY_URL`，选明文模式（先不上 AES，降低联调复杂度），配置 `VP_NOTIFY_TOKEN`                                            |

**6 件道具定稿（价格列是 MP 后台要填的值，单位「元」；代码 `goodsPrice` 用「分」）**

| # | 道具 ID          | 道具名称    | 后台价格（元） | 代码 `goodsPrice`（分） | 用途                          |
| - | -------------- | ------- | ------- | ------------------ | --------------------------- |
| 1 | `child_1y`     | 孩子名额1年  | 29.90   | 2990               | 名额 1 年（基础价）                 |
| 2 | `child_2y`     | 孩子名额2年  | 51.90   | 5190               | 名额 2 年（省 7.9）               |
| 3 | `child_3y`     | 孩子名额3年  | 69.90   | 6990               | 名额 3 年（省 19.8）              |
| 4 | `child_4y`     | 孩子名额4年  | 85.90   | 8590               | 名额 4 年（省 33.7）              |
| 5 | `child_5y`     | 孩子名额5年  | 99.90   |                    | 名额 5 年（省 49.6）              |
| 6 | `storage_unit` | 存储空间扩容包 | 0.01    | 1                  | 空间动态金额，`buyQuantity = 应付分数` |

道具一旦发布**价格不能再改**：`goodsPrice` 与后台不一致会报 `-15013`。⚠️ A2 下孩子名额是固定价道具，**改整包价要把 5 件全部换新 ID 重建并下架旧的**（不能改价、也不能靠重新同步）；只有空间仍能靠「改 `quote()` 单价 + `buyQuantity`」调价。

⚠️ 填表时四个容易出错的点（2026-11-04 核对）：

1. **单位不同**：后台表单「道具价格」填 **元**（29.90 / 0.01），代码里 `goodsPrice` 是 **分**（2990 / 1）。提交前看一眼输入框旁的单位提示；已发布的 `0.01` 那件可对照后台列表显示值反推。
2. **名称不许有特殊字符**：表单只允许中文/字母/数字/`-`/`_`，「·」「空格」「¥」都不要用 —— 所以写 `孩子名额1年`，**不要**写「孩子名额·1年」。
3. **道具名称用户可见**：Apple 支付弹窗展示「{道具名} + 总金额」。孩子名额用真实商品名；空间道具名定为「**存储空间扩容包**」（2026-11-04 22:33 用户最终定名 —— 加回「存储」限定，用途一眼可辨，Apple 弹窗显示「存储空间扩容包 ¥142.90」；「包」仍表明是虚拟商品单位，比「点数」直观）。⚠️ 名字不带品牌、也不暗示「单位」，**MP 后台备注必须写清**：「虚拟道具，定量购买存储空间扩容容量，1 份 = 0.01 元，按应付金额拆份」，避免审核质疑「1 分钱卖空间」。全站文案仍禁用「代币 / 充值 / 余额」。名字一旦发布不可改，真要改只能新开 `storage_unit_v2`。
4. **道具 ID 重复时接口会「假成功」**：`start_upload_goods` 对已存在的 ID 返回成功但不更新价格；改价必须去后台单独确认。ID 提交后不能改，改了要同步改 `VP_GOODS` / `VP_STORAGE_PRODUCT_ID`。

---

## 4. 服务端改造（逐文件）

### 4.1 新增 `server/src/ext/virtualpay.ts`

职责：凭证、双签名、`/xpay/*` 服务端调用、`payData` 生成、查单。不碰数据库、不碰业务。

```ts
import { createHmac } from 'node:crypto';

const env = (k: string) => (process.env[k] || '').trim();
export const vpEnabled = () => env('VP_ENABLED') === '1';

export interface VpConfig {
  offerId: string; appKey: string;
  env: 0 | 1; notifyToken: string; aesKey: string;
}
export function vpConfig(): VpConfig {
  return {
    offerId: env('VP_OFFER_ID'),
    appKey:  (env('VP_ENV') === '1' ? env('VP_SANDBOX_APP_KEY') : env('VP_APP_KEY')),
    env: env('VP_ENV') === '1' ? 1 : 0,
    notifyToken: env('VP_NOTIFY_TOKEN'),
    aesKey: env('VP_AES_KEY'),
  };
}
export function vpConfigured(): boolean {
  const c = vpConfig();
  return vpEnabled() && !!c.offerId && !!c.appKey;
}

/**
 * MP 后台 6 件道具的 **ID 映射**（价格不在这里）。
 * ⚠️ 必须与后台「道具管理」逐件一致：道具发布后价格不可改、ID 不能改。
 *    1 年基础价 29.9 元一旦要调，只能「新建一套 v2 ID + 改价目表 + 灰度」。
 */
export const VP_GOODS = {
  // 只存 ID：价格统一读 payments.ts 的 slotPackPriceCents(years)（与 V3 共用）
  childSlot: {
    1: { productId: 'child_1y' },
    2: { productId: 'child_2y' },
    3: { productId: 'child_3y' },
    4: { productId: 'child_4y' },
    5: { productId: 'child_5y' },
  },
  storageUnitPriceCents: 1,
} as const;

/** 支付签名：C 端固定 uri = requestVirtualPayment；服务端 API 用各自路径 */
export function paySig(uri: string, body: string, appKey: string): string {
  return createHmac('sha256', appKey).update(uri + '&' + body).digest('hex');
}
/** 用户态签名：密钥是该用户当前有效的 session_key */
export function userSig(body: string, sessionKey: string): string {
  return createHmac('sha256', sessionKey).update(body).digest('hex');
}

/**
 * 生成 signData。⚠️ 必须由服务端一次性生成 JSON 字符串，前端**原样透传**。
 * A2：按商品类型选道具 —— 孩子名额走固定价道具（buyQuantity=1），
 * 空间走 1 分单位道具（buyQuantity=应付分数）。
 */
export function buildPayData(o: {
  kind: 'child_slot' | 'storage';
  years: number;                 // child_slot 时 1–5
  amountCents: number;           // quote() 算出的应付金额（分）
  outTradeNo: string; attach: string; sessionKey: string;
}): Record<string, unknown> {
  const c = vpConfig();
  let productId: string, goodsPrice: number, buyQuantity: number;
  if (o.kind === 'child_slot') {
    const g = VP_GOODS.childSlot[o.years as 1 | 2 | 3 | 4 | 5];
    if (!g) throw new Error(`不支持的名额年限 ${o.years}`);
    // quote() 与 MP 道具价格漂移时宁可报错，也不要发出金额对不上的单
    if (o.amountCents !== g.priceCents) throw new Error('vp_price_mismatch');
    productId = g.productId; goodsPrice = slotPackPriceCents(o.years); buyQuantity = 1;
  } else {
    productId = VP_GOODS.storageUnit.productId;
    goodsPrice = VP_GOODS.storageUnit.priceCents;
    buyQuantity = Math.ceil(o.amountCents / goodsPrice);
  }
  const signData = JSON.stringify({
    offerId: c.offerId,
    buyQuantity,
    env: c.env,
    currencyType: 'CNY',
    productId,
    goodsPrice,
    outTradeNo: o.outTradeNo,
    attach: o.attach,
  });
  return {
    signData,
    mode: 'short_series_goods',
    paySig: paySig('requestVirtualPayment', signData, c.appKey),
    signature: userSig(signData, o.sessionKey),
  };
}

/** 服务端 /xpay/* 调用：body 必须与实际发出的字节逐字节一致 */
export async function vpCall<T = Record<string, unknown>>(
  uri: string, body: Record<string, unknown>
): Promise<T> {
  const c = vpConfig();
  const raw = JSON.stringify(body);
  const r = await fetch('https://api.weixin.qq.com' + uri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pay-Sig': paySig(uri, raw, c.appKey),   // 头名以官方服务端 API 文档为准
      'X-User-Sig': userSig(raw, body.session_key as string || ''),
    },
    body: raw,
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`vp_http_${r.status}`);
  return r.json() as Promise<T>;
}

/** 兜底查单：返回「已支付 / 已发货」都算钱到了，只认一个状态会漏单 */
export async function vpQueryOrder(outTradeNo: string, openid: string) {
  return vpCall('/xpay/query_order', {
    offer_id: vpConfig().offerId, openid, out_trade_no: outTradeNo,
    env: vpConfig().env,
  });
}
```


> ⚠️ `/xpay/*` 的**签名传递方式**（header 名还是 body 字段）、请求体字段（`offer_id` vs `offerId`）以官方服务端 API 文档为准；上面是骨架，接入时先用「原始请求日志」对齐一次。不变的是：`paySig` 用 `uri + '&' + post_body` 原文算，C 端 `uri` 固定 `requestVirtualPayment`，服务端 API 用各自路径。项目里 `wxpay.ts` 的注释已经把「签名串逐字节一致」这个坑写得很清楚，照抄那套纪律即可。
>
> 2026-11-04 补充（社区实操）：服务端 `/xpay/*` 的 `pay_sig` 与 `access_token` 更可能是 **query 参数**（形如 `/xpay/query_order?pay_sig=...&access_token=...`），不是 header；`access_token` 用 `WX_APPID` / `WX_SECRET` 换取。项目 `ext/wx.ts` 已导出带进程内缓存的 `getAccessToken()`，**直接复用即可，不需要新增凭证环境变量**。另外「没付钱的单在平台侧不存在」，`query_order` 返回订单不存在要降级成普通日志，别当错误刷屏。
>
> 配套在 `virtualpay.ts` 里再放两个小工具，供 §4.2 的推送处理用：
>
> - `insertVpEvent(event, wxOrderId, raw)` / `markVpEvent(wxOrderId, result)` —— 写 `vp_events`，插入撞 UNIQUE 就返回 false（表示重放）；
> - `parseVpNotify(raw, cfg)` —— 校验 query 签名、安全模式时用 `VP_AES_KEY` 解密、统一返回 camel/Pascal 两种键都兼容的对象。

### 4.2 新增 `server/src/ext/routes/virtualpay.ts`

注册 3 条路由（在 `ext/routes/index.ts` 的 `registerExtRoutes()` 里 `registerVirtualPayRoutes(api)`）：

| 方法 / 路径                         | 鉴权  | 作用                            |
| ------------------------------- | --- | ----------------------------- |
| `GET /pay/vp/notify`            | 免鉴权 | MP 后台配 URL 时的校验，原样回 `echostr` |
| `POST /pay/vp/notify`           | 免鉴权 | 发货 / 退款 / iOS 退款问询推送          |
| `POST /pay/orders/:id/vp-retry` | 家长  | 重新拉起支付时换发新 `outTradeNo` 并重新签名 |

**GET 校验**（公众号同款）：

```ts
const { timestamp = '', nonce = '', signature = '', echostr = '' } = req.query;
const s = createHash('sha1')
  .update([vpConfig().notifyToken, timestamp, nonce].sort().join(''))
  .digest('hex');
if (s !== signature) return reply.code(403).send('forbidden');
return reply.type('text/plain').send(echostr);
```

**POST 发货推送**（核心，约 60 行）：

```ts
scope.post('/pay/vp/notify', async (req, reply) => {
  const raw = (req as RawBodyRequest).rawBody;         // 和 /pay/notify 一样注册独立 buffer parser
  // ① 校验 query 里的 signature（同上），失败 403
  // ② 安全模式时先用 VP_AES_KEY 解密正文；明文模式直接 JSON.parse(raw)
  const body = parseVpNotify(raw, vpConfig());
  const event = String(body.Event ?? body.event ?? '');

  // ③ 无论认不认识，先落 vp_events 留原文（重复推送靠 UNIQUE 去重）
  const wxOrderId = String(body.WxOrderId ?? body.wx_order_id ?? '');
  if (!insertVpEvent(event, wxOrderId, raw.toString('utf8'))) {
    return replyXmlOk();                               // 已处理过，直接回成功
  }

  if (event === 'xpay_goods_deliver_notify') {
    const attach = String(body.Attach ?? '');          // 下单时放的是 order.id
    const actual = Number(body.ActualPrice ?? body.GoodsInfo?.ActualPrice ?? 0);
    const outTradeNo = String(body.OutTradeNo ?? '');
    const order = orderById(Number(attach)) ?? orderByOutTradeNo(outTradeNo);
    if (!order) { req.log.error({ attach, outTradeNo }, '[vp] 推送找不到订单'); return replyXmlOk(); }
    // ⚠️ 防篡改：平台实收金额必须等于订单金额（单位都是分）
    if (actual && actual !== order.amount_cents) {
      req.log.error({ orderId: order.id, expect: order.amount_cents, got: actual }, '[vp] 金额不一致');
      return reply.code(409).send('amount mismatch');
    }
    if (order.provider !== 'virtual') {
      req.log.error({ orderId: order.id }, '[vp] 推送命中了非虚拟支付订单');
      return replyXmlOk();
    }
    const r = applyPaidOrder(order.id, wxOrderId || null);   // 复用现有幂等入账
    markVpEvent(wxOrderId, r.already ? 'ignored' : 'applied');
    return replyXmlOk();                                     // <xml><ErrCode>0</ErrCode></xml>
  }

  if (event === 'xpay_refund_notify') { /* 见 §4.4 */ return replyXmlOk(); }
  if (event === 'xpay_subscribe_ios_refund_query_notify') { /* 见 §4.4 */ return replyIosRefund(body); }

  // 不认识的 Event 一律回成功，否则微信重推 15 次
  return replyXmlOk();
});
```

响应格式：

```
XML 推送 → <xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>
JSON 推送 → {"ErrCode":0,"ErrMsg":"success"}
```

**iOS 退款问询**（3 秒内必须应答，超时平台按「不确定」交给 Apple 处理）：

```ts
function replyIosRefund(body: Record<string, unknown>) {
  return {
    result_code: 1,                       // 1 = 拦截/拒绝退款（本项目「名额不支持退款」）
    result_info: '虚拟权益已即时到账并使用',
    evidence: `order=${String(body.attach ?? body.attach ?? '')}`, // 必填，用于退款审计
  };
}
```

> 策略需产品拍板：一律拦截可能被 Apple 判定不友好；建议按「已发货且权益未被回收」返回 1，其余返回 0。

### 4.3 修改 `server/src/ext/payments.ts`

1. **`OrderRow` 接口**加 `pay_order_no`、`vp_wx_order_id`、`vp_channel`。
2. **`quote()`**（line 236）末尾统一兜底，两个分支的 `amountCents` 都过一遍；另外**名额年限放开到 1–5 年**（用户 14:48 拍板）：`SPECS.child_slot.maxYears` 由 `3` 改 `5`，`validateYears()`、三个下单入口的年限选择器与 `VP_GOODS.childSlot` 同步改成 1–5：
   ```ts
   const minCents = getPlatformConfigNumber('vp_min_cents') || 100;
   const finalCents = Math.max(Math.round(amount), minCents);
   ```
   ⚠️ 空间按天折算必然产生小数分（line 360 已经 `Math.round`，所以只需下限兜底）。**iOS 上低于 100 分直接失败**，所有计价路径（含补差、折扣）都要过同一个工具函数，不能在某一支漏掉。
3. **`createOrder()`**（line 483）：
   - `provider` 取值：
     ```ts
     const useVirtual = getPlatformConfigFlag('pay_virtual_enabled') && vpConfigured();
     const provider = PAY_MOCK ? 'mock' : useVirtual ? 'virtual' : 'wxpay';
     ```
   - `INSERT` 加 `pay_order_no = out_trade_no`（首次拉起沿用业务单号）、`vp_channel=''`。
   - `pay_ios_enabled` 的 iOS 拦截**保留**（`createOrder` line 499–504）：虚拟支付没开通前 iOS 依然不能下单。
4. **新增 `newPayOrderNo(orderId)`**：
   ```ts
   // 虚拟支付同一个 outTradeNo 第二次拉起会被 -15002 拒；业务单号不变，支付单号每次换
   export function rotatePayOrderNo(orderId: number): string {
     const no = `GT${Date.now().toString(36).toUpperCase()}R${randomBytes(3).toString('hex').toUpperCase()}`;
     getRawDb().prepare('UPDATE orders SET pay_order_no = ? WHERE id = ? AND status = ?').run(no, orderId, 'pending');
     return no;
   }
   ```
   （长度 8–32、不以 `_` 开头 ✅）
5. **`publicOrder()`**（line 923）注释补 `virtual`；**`adminOrders()`** 的 `provider` 列展示四种值。
6. **`applyPaidOrder()` 不改** —— 这是这次改造最大的省力点：条件 UPDATE + `applyEntitlement()` 已经幂等，虚拟支付推送、V3 回调、mock、0 元单四条路共用同一套入账。

### 4.4 修改 `server/src/ext/routes/pay.ts`

| 路由                           | 改动                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /pay/orders`           | V3 那段 `jsapiPrepay` 用 `order.provider === 'virtual'` 分流：虚拟支付**不调微信下单**，改为取 `sessionKeyOfUser()` → `buildPayData()` → 返回 `{ order, payParams: { virtual: ... } }` |
| `POST /pay/orders/:id/pay`   | 同上；且**先调 `rotatePayOrderNo()`** 换新支付单号再签名（V3 分支保持复用 `prepay_id` 不变）                                                                                              |
| `POST /pay/orders/:id/query` | 按 `order.provider` 分流：`virtual` → `vpQueryOrder(order.pay_order_no, openid)`，状态 `已支付待发货 / 发货中 / 已发货` 都算到账 → `applyPaidOrder()`；V3 分支原样保留                         |
| `POST /pay/notify`           | 不动（存量 V3 单的回调仍要走）                                                                                                                                                |
| `GET /admin/pay/status`      | 增加 `virtual: { configured, offerId, productId, env }`（不返回 AppKey）                                                                                                |

**`sessionKeyOfUser(userId)`** 新增在 `ext/wx.ts`：

```ts
export function sessionKeyOfUser(userId: number): { openid: string; sessionKey: string } | null {
  const row = getRawDb().prepare(
    `SELECT openid, session_key, last_login_at
       FROM wx_accounts WHERE user_id = ? AND appid = ?`
  ).get(userId, currentAppId()) as { openid: string; session_key: string | null; last_login_at: number | null } | undefined;
  if (!row?.session_key) return null;
  // 微信 session_key 会失效：超过 3 天没重新登录就要求端上重登
  if (!row.last_login_at || Math.floor(Date.now() / 1000) - row.last_login_at > 3 * 86400) return null;
  return { openid: row.openid, sessionKey: row.session_key };
}
```

取不到时返回稳定错误码 `vp_session_expired`，端上静默 `auth.login()` 重登后自动重试一次（见 §6.3）。

### 4.5 修改 `server/src/ext/hooks.ts`

两个白名单都加 `/api/pay/vp/notify`：

- `EXT_PUBLIC_PATHS`（line 85）—— 推送来自微信服务器，无登录态；
- `MAINTENANCE_ALLOW_WRITE`（line 292）—— 维护期间钱已经收了，回调不能被挡在门外。

原因与 `/api/pay/notify` 完全相同，注释照抄一份即可。

### 4.6 新增 `server/src/ext/vp-scheduler.ts`

复用 `ext/notify.ts` 的 scheduler 模式，每 5 分钟扫一次：

```sql
SELECT id, pay_order_no, user_id FROM orders
 WHERE provider = 'virtual' AND status = 'pending'
   AND created_at > unixepoch() - 1800
```

对每张单调 `vpQueryOrder()`；状态为已支付/发货中/已发货 → `applyPaidOrder()` 补发权益。这是推送丢失时的**唯一兜底**，不能省。

### 4.7 修改 `admin/index.html`

1. 平台参数页（`#c-pay` 附近，约 line 3360）：把 `#c-pay-ios` 的说明改成「虚拟支付已验证通过后打开」；新增 `pay_virtual_enabled` 下拉（默认关闭），保存时带进 `PATCH /admin/config` 的 body。
2. `/admin/pay/status` 的返回值在页面上显示「虚拟支付：已配置 / 未配置 + OfferId 尾号」，让运营能自查。
3. 订单页 `provider` 列显示 `wxpay / virtual / mock / redeem`；**退款按钮对 `provider='virtual' 且 vp_channel='apple'` 的单禁用**，提示「iOS 订单需由用户在 App Store 申请退款」。
4. 退款实现：`refundOrder()` 拆成「渠道退款」+「本地记账与权益回收」两部分，抽出
   ```ts
   export function applyRefundLocal(orderId: number, refundId: string, reason: string, wxStatus: string)
   ```
   （即现 `refundOrder()` line 877–919 的事务），V3 与 `/xpay/refund_order` 共用；收到 `xpay_refund_notify` 时也调它收回权益。Android 虚拟支付单走 `/xpay/refund_order`（启动退款任务 → `query_order` 轮询到「退款完成」才算最终成功）。

---

## 5. 小程序端改造

### 5.1 `miniprogram/src/utils/pool-pay.ts`

`PoolPayParams` 加一个分支：

```ts
virtual?: {
  signData: string;      // 服务端原样透传，禁止前端重新拼
  paySig: string;
  signature: string;
  mode: 'short_series_goods';
};
```

`executePay()` 在 `pp.free` / `pp.mock` 之后、V3 之前插一条：

```ts
if (pp.virtual) {
  if (!checkIosVersion()) return { kind: 'failed', message: '请将微信更新至最新版后再支付' };
  try {
    await requestVirtualPayment(pp.virtual);   // 见下
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    return msg.includes('cancel') ? { kind: 'canceled' } : { kind: 'failed', message: msg || '支付未完成' };
  }
  return (await confirmPaid(orderId)) ? { kind: 'paid' } : { kind: 'pending' };
}
```

**`requestVirtualPayment` 封装**（注意本项目 `wx` 全局类型被广告声明覆盖成 `WxAdFactory`，见 `utils/share.ts` 的同款坑，不能直接写 `wx.requestVirtualPayment`；uni 的类型定义里也可能没有这个 API）：

```ts
interface VpApi {
  requestVirtualPayment?: (o: Record<string, unknown> & {
    success?: () => void;
    fail?: (e: { errMsg?: string }) => void;
  }) => void;
}
function vpApi(): VpApi | undefined {
  return (globalThis as unknown as { wx?: VpApi }).wx;
}
function requestVirtualPayment(p: NonNullable<PoolPayParams['virtual']>): Promise<void> {
  return new Promise((resolve, reject) => {
    const api = vpApi();
    if (!api?.requestVirtualPayment) { reject(new Error('当前微信版本不支持虚拟支付')); return; }
    api.requestVirtualPayment({
      ...p,
      success: () => resolve(),
      fail: (e) => reject(new Error(e?.errMsg || '支付未完成')),
    });
  });
}
```

`checkIosVersion()`：iOS 时 `wx.getSystemInfoSync().version` 与 `[8,0,68]` 逐位比较，低于则 `showModal` 提示并返回 false；非 iOS 直接 true。

### 5.2 三个下单入口

`subpkg-pay/pages/buy.vue`、`components/SlotBuySheet.vue`、`components/StorageBuySheet.vue`：

- 下单 body 里的 `platform`（`isIOS.value ? 'ios' : undefined`）**保持不变**，`productList()` 返回的 `iosEnabled` / 新增的 `virtualEnabled` 决定入口显隐；
- 三个入口都走 `executePay()`，自动分流，不用各写一遍；
- 文案：把「支付 ¥X」在 iOS 虚拟支付单上保持原样（**不能出现「微信支付」「外部购买」等字样**），「名额不支持退款」改成「购买后权益即时生效；如需退款请按平台规则申请」（见 §11.3）。


### 5.3 `session_key` 过期的静默重登

`api.post('/pay/orders')` 返回 `vp_session_expired` 时，`pool-pay.ts` 里：

```ts
await useAuthStore().login();     // 内部已有 uni.login() → /wx/login（stores/auth.ts line 234/253）
// 然后重放一次原下单请求，仅一次，仍失败才报错
```

服务端 `linkWxAccount()` 会用新 code 换到的 `session_key` upsert 进 `wx_accounts`，下次签名就能取到。

---

## 6. 完整时序

```
家长点「支付 ¥29.90」（孩子名额 1 年）
  → POST /pay/orders（platform=ios）
  → createOrder()：quote() 查 5 档价目表算价 2990 分 → 过 vp_min_cents 兜底 → 落单 provider='virtual'
  → 服务端 sessionKeyOfUser() → buildPayData() 按 kind/years 选道具
      signData = {offerId, buyQuantity:1, env:0, currencyType:'CNY',
                  productId:'child_1y', goodsPrice:2990, outTradeNo, attach:order.id}
  （空间单则是 productId:'storage_unit', goodsPrice:1, buyQuantity:应付分数）
      paySig     = HMAC(AppKey, 'requestVirtualPayment&' + signData)
      signature  = HMAC(session_key, signData)
  → 前端 wx.requestVirtualPayment({...payData, mode:'short_series_goods'})
  → 平台按设备路由：安卓→微信支付 / iOS→Apple 支付（弹窗显示总金额）
  → success 回调（只作提示，不作数）
  → 前端 confirmPaid(orderId) 打 /pay/orders/:id/query
        ├─ 主路径：平台推 xpay_goods_deliver_notify 已入账 → 返回 paid:true
        └─ 兜底：query 里服务端调 /xpay/query_order 查到已支付 → 当场 applyPaidOrder()
  → 页面显示「购买成功」，权益已在 applyPaidOrder() 里加上
```

异常路径：

| 场景                   | 兜底                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| 用户付完钱就退出，推送丢失        | `vp-scheduler.ts` 每 5 分钟扫 pending 单，`query_order` 补发                                               |
| 推送重放 15 次            | `vp_events` UNIQUE 去重 + `applyPaidOrder()` 条件 UPDATE，重复回 `already:true`                            |
| 用户取消支付               | `fail` 里 `cancel` → `canceled`，不报错；订单仍在列表里可「立即支付」                                                  |
| 重新拉起支付               | `rotatePayOrderNo()` 换新单号重新签名（V3 的 `prepay_id` 复用逻辑不变）                                             |
| iOS 用户从 App Store 退款 | `xpay_subscribe_ios_refund_query_notify` 3 秒内应答 → `xpay_refund_notify` → `applyRefundLocal()` 收回权益 |

---

## 7. 幂等与对账

| 路径               | 幂等依据                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| 发货推送             | `vp_events(event, wx_order_id)` UNIQUE + `applyPaidOrder()` 的 `WHERE status='pending'` 条件 UPDATE |
| 定时查单             | 同样调 `applyPaidOrder()`，与推送并发时只有一方 changes=1                                                      |
| 前端 `confirmPaid` | 服务端 `if (order.status === 'paid') return paid:true, justApplied:false`                           |
| 退款推送             | `refund_at > 0` 条件更新（现 `refundOrder()` 已有）                                                       |
| 金额防篡改            | 推送 `ActualPrice`（分）与 `orders.amount_cents` 比对，不一致回 409 让平台重试并留 error 日志                          |

对账：后台交易订单页（MP 后台，按「普通支付 / Apple 支付」渠道切换）与本地 `orders` 用 `vp_wx_order_id` / `out_trade_no` 对照；`adminOrders()` 的收入汇总只算 `status='paid'`，「待支付」单独计数，口径不变。

---

## 8. 灰度与回滚

三道闸，任何一道关掉都不影响线上：

| 开关                      | 位置                      | 关掉的效果                           |
| ----------------------- | ----------------------- | ------------------------------- |
| `VP_ENABLED=0`          | 服务器 `.env`              | 所有虚拟支付接口 503，新单回到 V3            |
| `pay_virtual_enabled=0` | `platform_config`（后台可改） | 新单 `provider='wxpay'`，虚拟支付代码不执行 |
| `pay_ios_enabled=0`     | 已有，后台可改                 | iOS 隐藏购买入口（审核期保持关闭）             |

建议灰度顺序：

1. 只开 `VP_ENABLED` + 后台状态自查 → 用安卓 ¥1 真单跑通「下单 → 支付 → 发货 → 查单 → 退款」全链路；
2. 再开 `pay_virtual_enabled` 对**安卓**灰度（观察 1–2 天，对账无差异）；
3. 打开 `pay_ios_enabled`，iOS 真机 ¥1 单验证 Apple 支付弹窗、退款问询；
4. 全量。存量 V3 单的退款链路永久保留。

⚠️ 测试单 180 天内退掉：平台会退还手续费，且不算进实际经营收入。

---

## 9. 验收清单

**本地（不花钱）**

- [ ] `npm run build --prefix server` + `vue-tsc --noEmit` 通过
- [ ] `WX_PAY_MOCK=1` 下 `provider='mock'` 链路完全不变（回归）
- [ ] `buildPayData()` 的 signData 序列化与 `paySig/signature` 用官方示例串比对一致
- [ ] 模拟 `xpay_goods_deliver_notify` 重放两次：第二次 `already:true`，权益只加一次
- [ ] 金额不一致的伪造推送回 409 且不留权益
- [ ] `quote()` 所有分支（名额/空间、只扩容/扩容并续期）金额都 ≥ `vp_min_cents`

**真机小额（必须）**

- [ ] 安卓 ¥1：支付成功 → 推送入账 → `query_order` 兜底可用 → 后台账单金额一致
- [ ] iOS ¥1：微信版本校验、Apple 支付弹窗显示的金额、侧边按钮确认流程
- [ ] **Apple 支付弹窗里显示的是总金额还是「1 分 × 100 件」**（决定 UI 是否要改）
- [ ] **`buyQuantity` 上限（仅空间路径）**：用 100GB×9.9 元 = 99000 分的报价试一次；孩子名额 `buyQuantity=1` 无此风险
- [ ] 6 件道具的 `productId` / `goodsPrice` 与 MP 后台**逐件比对一致**（尤其 `child_1y` = 2990 分，不是 29.9 分）
- [ ] iOS 退款问询推送能在 3 秒内应答（日志里能看到）
- [ ] 测试单在 180 天内全额退掉

**上线前**

- [ ] MP 后台 **6 件道具**全部已发布到现网（`child_1y`…`child_5y`、`storage_unit`；发布后等 10 分钟），且 `storage_unit` 名称为「存储空间扩容包」、备注已写明「虚拟道具，定量购买存储空间扩容容量，1 份 = 0.01 元，按应付金额拆份」
- [ ] 小程序简称已配置、苹果 IAP 支付开关已打开
- [ ] 发货推送 URL 的 GET 校验通过（能保存住）
- [ ] iOS 端不能出现任何「微信支付 / 外部购买」引导
- [ ] 「名额不支持退款」文案已按 Apple 规则调整

---

## 10. 待拍板（产品/运营决策，不阻塞上面的代码）

| # | 决策               | 建议                                                                                                                                                            |
| - | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | 空间定价与小额单         | ✅ **已定**（2026-11-04）：累进阶梯单价 9.9 / 3.9 / 2.4 / 1.5（1–5 / 6–20 / 21–50 / 51–100 GB），100GB = 255 元/年；「只扩容不续期」补差 < 1 元时改为拒绝并引导「扩容并续 1 年」，**不做金额兜底**（避免多收钱）。详见 §14 |
| 2 | 12% Apple 佣金     | 同一件道具双端同价，不能只在 iOS 涨价；要么自己吃，要么全端调价（29.9 → 33 之类）                                                                                                              |
| 3 | 退款文案与策略          | iOS 用户仍可从 App Store 申请退款，开发者无主动退款权；「不支持退款」要改成中性表述，并决定 iOS 退款问询返回 0 还是 1                                                                                       |
| 4 | `buyQuantity` 上限 | 真机测出来再定；不够就把通用道具从 1 分改成 1 角/1 元，并把金额取整                                                                                                                        |
| 5 | 名额年限             | ✅ **已拍板 1–5 年**（2026-11-04 14:48）。`SPECS.child_slot.maxYears` 由 3 改 5，同步改 `validateYears()`、三个下单入口年限选择器与 `VP_GOODS.childSlot`                                 |
| 6 | 空间付费体验           | ✅ **方案已定并落码**（§15，2026-11-04 21:05）。基础容量确认 **500MB**（`free_storage_bytes` 不动）；宽限 **90 天**后台可调；100G 档上架；6 档包价后台可填；弹层保持 BottomSheet                             |
| 7 | 到期提醒             | 端上 30 天标红已生效（`POOL_REMIND_SECONDS` 7→30 天）；**订阅消息「到期前 30 / 7 天各一条」尚未落码**，需先配场景模板                                                                              |

---

## 11. 风险登记

| 风险                                | 影响                                                          | 缓解                                                                                                              |
| --------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `buyQuantity` 数量上限（**仅空间**）       | 大额空间单拉不起支付；孩子名额 `buyQuantity=1` 不受影响                        | §9 真机验证；备好把空间单位道具改成 1 角/1 元的方案                                                                                  |
| Apple 弹窗显示「1 分 × N 件」             | 观感差、可能被审核质疑                                                 | §9 真机确认；若真的显示份数，把空间单位道具改成 1 角/1 元并金额取整（道具名保持「存储空间扩容包」不变，只换 ID + `VP_GOODS`）                                     |
| `session_key` 失效                  | 签名失败，报错码难懂                                                  | `last_login_at` 3 天检查 + 端上静默重登重试一次                                                                              |
| 双签名 / signData 序列化                | 90010 类签名错误，排查慢                                             | 服务端一次生成原样透传；所有 `/xpay/*` 请求把「请求行 + 头 + 正文原文」完整落日志                                                               |
| `mode` 是否参与签名                     | 官方文档未明示                                                     | 真机验证；若报错再调整                                                                                                     |
| iOS 退款问询 3 秒超时                    | Apple 自行决定退款                                                | 内存里直接按订单号查，不打外网、不查库事务                                                                                           |
| 双通道并存期对账                          | 收入口径混乱                                                      | `provider` 四值区分；V3 与虚拟支付各自对账，汇总只按 `status='paid'`                                                               |
| 备案未完成                             | 虚拟支付开通/iOS 支付可能受阻                                           | 与小程序备案同步推进（当前备案状态也影响好友转发）                                                                                       |
| 孩子名额改成固定价道具后**调价要重建 5 件道具**       | 道具价格发布后不可改、ID 重复同步会「假成功」；29.9 → 33 元时 5 件全要换新 ID 并下架旧的      | 单价尽量一次定死；`platform_config` 的 5 档价目表为唯一价格真源，改价走「新建 v2 道具 + 改映射表 + 灰度」                                            |
| 空间仍用 1 分单位道具，弹窗显示「存储空间扩容包 ¥99.00」 | 名称是用途描述而非典型虚拟商品名（已用「存储」限定收窄语义）；且真机未确认弹窗展示的是总金额还是「1 分 × N 件」 | MP 后台备注写明「虚拟道具，定量购买存储空间扩容容量，1 份 = 0.01 元，按应付金额拆份」（名称不带品牌，备注更要写清）；§9 真机确认弹窗展示形式；若展示份数不好看，再考虑把单位道具改成 1 角/1 元并金额取整 |

---

## 12. 文件清单速查

**新增（✅ v2.6 全部落码）**

```
server/src/ext/virtualpay.ts          ✅ 参数读取/状态/双签名/payData/xpayUrl（§16）+ vpCall/查单/事件流水/验签解析
server/src/ext/routes/virtualpay.ts  ✅ GET+POST /pay/vp/notify、vp-retry、VP_MOCK 模拟通道
server/src/ext/vp-scheduler.ts        ✅ 5 分钟查单补发货
server/scripts/virtualpay-test.mjs    ✅ 74 项本地模拟回归（可重复运行）
docs/虚拟支付接入设计-方案A.md         本文件
```

**修改**

```
server/src/ext/migrate.ts             orders 三列 + vp_events 表
server/src/ext/platform.ts            3 个配置键 + setPlatformConfig 校验
server/src/ext/payments.ts            OrderRow / quote 兜底 / createOrder provider / rotatePayOrderNo / publicOrder / refundOrder 拆分
server/src/ext/routes/pay.ts           下单·重付·查单三处分流 + /admin/pay/status
server/src/ext/routes/index.ts        注册 registerVirtualPayRoutes
server/src/ext/hooks.ts               两个白名单加 /api/pay/vp/notify
server/src/ext/wx.ts                  sessionKeyOfUser()
admin/index.html                      开关 / 状态 / 订单页 provider 与退款按钮
miniprogram/src/utils/pool-pay.ts     virtual 分支 / iOS 版本校验 / 静默重登
miniprogram/src/components/SlotBuySheet.vue       文案
miniprogram/src/components/StorageBuySheet.vue    文案
miniprogram/src/subpkg-pay/pages/buy.vue          文案
deploy-cloud/env.example              VP_* 键名说明（不填值）
```

**不动**

```
server/src/ext/wxpay.ts               V3 存量链路
server/src/ext/routes/redeem.ts        兑换码 0 元单
orders.status / applyPaidOrder()       四条入账路径共用
```

---

## 13. v1 → v2 变更记录（2026-11-04 14:48 用户拍板）

| 项                  | v1（作废）                          | v2（现行）                                                                                   |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| 道具数量               | 1 件 `manalong_unit`（1 分通用）      | **6 件**：`child_1y`…`child_5y` + `storage_unit`                                           |
| 孩子名额               | 也用 1 分道具 × 1990 份               | 固定价道具，`buyQuantity=1`（一次只买 1 个），`goodsPrice` = 年限包整包价 29.9 / 51.9 / 69.9 / 85.9 / 99.9 元 |
| 存储空间               | 同上                              | 1 分单位道具，`buyQuantity=应付分数`                                                               |
| 名额年限               | 待拍板（当时 `maxYears=3`）            | **1–5 年**，同步改 `SPECS` / `validateYears()` / 年限选择器                                        |
| Apple 弹窗           | 所有加购都显示「满伴成长树加购点数 ¥X」（描述不符风险）     | 孩子名额显示真实商品名；空间显示「存储空间扩容包 ¥X」（v2.2.2 定名）                                                  |
| `buyQuantity` 上限风险 | 全站都有                            | **只剩空间**（孩子名额恒为 1）                                                                       |
| 价格真源               | `platform_config.vp_unit_cents` | `platform_config` 的 5 档名额包 + 6 档容量包键（V3 / 虚拟支付共用），`VP_GOODS` 只存 ID                       |
| 调价                 | 改 `quote()` 单价即可                | 孩子名额改价需**重建 5 件道具**；空间仍可改 `quote()`                                                      |

**不变**：双签名、发货推送 + `vp_events` 幂等、`applyPaidOrder()` 入账、`/xpay/query_order` 兜底、`vp-scheduler`、三道灰度闸、端上 `pool-pay.ts` 的 virtual 分支、退款/iOS 规则。§4.2 / §4.4~§4.7 / §5 / §7 / §8 全部照旧。

---

## 14. 存储空间定价（2026-11-04 定稿）

### 14.1 累进阶梯单价

单位：元 / GB / 年。**分段累进**（不是整档单价），保证「买越多单价越低」且总额单调递增（不会出现 6GB 比 5GB 还便宜）。

| 容量段       | 单价                  |
| --------- | ------------------- |
| 1–5 GB    | **9.9**（保持不变，保小额毛利） |
| 6–20 GB   | 3.9                 |
| 21–50 GB  | 2.4                 |
| 51–100 GB | 1.5                 |

### 14.2 实际年费

| 目标容量   | 现价（9.9 线性） | 定稿后     | 降幅   |
| ------ | ---------- | ------- | ---- |
| 1 GB   | 9.9        | 9.9     | —    |
| 5 GB   | 49.5       | 49.5    | —    |
| 10 GB  | 99         | **69**  | −30% |
| 20 GB  | 198        | **108** | −45% |
| 50 GB  | 495        | **180** | −64% |
| 100 GB | 990        | **255** | −74% |

对标：iCloud 200G ≈ 252 元/年 —— 100G 255 元与之持平，50G 180 元约为其 7 折。

> 毛利说明：卖的是**配额**不是实际用量。用户买 100G 通常只用 10–20G，按真实占用算成本仍是 80%+ 毛利；只有「买满用满」的重度用户会拉低毛利，而那类用户 LTV 最高，值得补贴。

### 14.3 实现（只改一个函数）

```ts
/** 累进价格函数 P(gb)：单位「分」。curGb 与 target 都走它，账目天然闭合 */
export function storagePriceCents(gb: number): number {
  const g = Math.max(0, Math.floor(gb));
  const t1 = Math.min(g, 5) * 990;
  const t2 = Math.max(0, Math.min(g, 20) - 5) * 390;
  const t3 = Math.max(0, Math.min(g, 50) - 20) * 240;
  const t4 = Math.max(0, g - 50) * 150;
  return t1 + t2 + t3 + t4;
}

// quote() 里替换原来的固定 unitCents：
const baseCents = extend ? storagePriceCents(curGb) : 0;
const addCents  = Math.round(
  (storagePriceCents(target) - storagePriceCents(curGb))
  * (remainDays + (extend ? 365 : 0)) / 365
);
```

`P(target) − P(curGb)` 就是新增那一段的累进价，与现有边际计价逻辑完全兼容，**不需要推翻 2026-10-21 的改造**。

### 14.4 iOS 最低 1 元的处理（不做金额兜底）

只有「只扩容不续期」会算出 < 1 元。**不抬价，改为拒绝并引导**：

```ts
if (!extend && amount < 100) {
  throw new AuthError(
    'storage_expand_need_renew',
    '剩余空间期太短，单独扩容金额不足 1 元，请选择「扩容并续费 1 年」',
    400
  );
}
```

配套：`PoolQuote` 增加 `expandOnlyAvailable: boolean`，端上据此置灰「只扩容」选项；`buildPayData()` 保留 `< 100 → throw vp_amount_too_small` 作为最后防御，**绝不默默抬价**。

### 14.5 注意

- 空间走 1 分单位道具 `storage_unit`、`buyQuantity = 应付分数`，所以**调价不需要动 MP 后台道具**（与孩子名额相反，后者改价要重建 5 件）。
- 免费额度保持 500MB（`free_storage_bytes`）。
- 若后续想更激进，可直接切备选阶梯 **9.9 / 2.9 / 1.9 / 1.2**（100GB = 210 元/年），只改 `storagePriceCents()` 里四个常量。

> ⚠️ **§14 的 4 段累进单价已被 §15 的「6 档容量包价目表」取代**（2026-11-04 21:05 用户要求「后台可以设置存储包的价格」）。  
> 默认包价由旧阶梯换算而来，线上表现一致：1G 9.9 / 5G 49.5 / 10G 69 / 20G 108 / 50G 180 / 100G 255 元/年。  
> 4 个 `price_storage_gb*_cents` 键仍留在 `PLATFORM_CONFIG_DEFAULTS` 里只为兼容老库与回滚，**新代码和后台界面都不再读写**。


## 15. 空间扩容付费体验（2026-11-04 晚 · **已落码，未发版**）

### 15.1 心智模型与已确认前提

> **付费空间 = 一个有到期日的容量包。选个档位，付款，全家共享；没到期可以加大，快到期可以续。**

用户全程只回答两个问题：**「要多大」「用多久」**。`both / renew / expand` 三档从「让用户选」改成「由系统推导」。

用户 21:05 确认与补充：

| 项 | 定稿 |
|---|---|
| 基础容量 | **500MB**（用户写的「500G」是笔误，`free_storage_bytes` 不动），含兑换码永久加量，不计入付费容量 |
| 到期宽限 | **90 天**只读不删（原 15 天），后台 `pool_grace_days` 可调 1–365 |
| 道具名 | **存储空间扩容包** |
| 100G 档 | **上架**（不砍档） |
| 包价 | **后台可逐档设置**「整包一年的总价」 |
| 名额年限 | **1–5 年**（原 1–3） |
| 付费页形式 | **保持底部弹窗 BottomSheet** |
| 其余 | 按方案建议（到期提醒口径、80% 预警、上传失败引导、只升不降、不做多年折扣） |

### 15.2 界面（一个底部弹层，两套 chips）

```
空间续费 · 扩容                            [全家共用]
现在 5GB，用到 2027年6月10日（还剩 218 天）
另有基础容量（含兑换码加量），永久有效，不计入付费容量
┌ 已按你的空间情况选好，直接支付即可；想改再改 ┐
扩容到  [1GB 置灰][5GB 现有][10GB ¥69/年][20GB ¥108/年 ✓][50GB ¥180/年][100GB ¥255/年]
续      [1 年 ✓][2 年][3 年][4 年][5 年]
明细    原有 5GB 续 1 年                  ¥49.50
        新增 15GB（按剩余 218 天折算）   ¥93.40
        应付                            ¥142.90
[            支付 ¥142.90             ]
到期前 30 天会提醒续费；到期后 90 天内数据只读、不会删除
```

- chips 上的价格来自 `GET /pay/products` 新增的 `packs[]`，**端上一次乘法都不做**，后台改价即时生效
- 低于当前档置灰（只升不降）；档位不变 = 纯续费，档位变大 = 扩容并续
- 底部承诺文案由 `graceDays` 下发，与服务端 `pool_grace_days` 同源
- 保持 `BottomSheet` + `v-model:visible` / `@done` 契约，父页 `me/index.vue` 不用改

### 15.3 智能默认（打开即预选，直接可点支付）

| 状态 | 默认预选 |
|---|---|
| 没买过 / 池子已过期 | 最小档 1GB + 1 年 |
| 剩余 < 90 天 | 保持当前档（非档位容量取第一个放得下的档）+ 续 1 年 |
| 池子有效且不着急到期 | 升到下一个更大的档 + 续 1 年 |

用户手动改过之后 `autoPicked=false`；池子数据晚于弹层到达时会重算一次预选。

### 15.4 与用户 8 条规则的对应

| # | 规则 | 落点 |
|---|---|---|
| — | 基础容量（含兑换码）不计入扩容 | 双池分离 + 现状行单独展示 |
| 1 | 界面一看就明白、一键付费 | 智能预选 + 单一支付按钮 |
| 2 | 空间不足可扩容 | 智能默认升级档 + 总览「空间已满」提示条直达弹层 |
| 3 | 未用完到期可续期 | 剩余 < 90 天默认续费 |
| 4 | 扩容过中途不足可再扩 | 任意时刻 chips 可上调档位 |
| 5 | 最小 1 年、最长 5 年 | 年数 chips 1–5，`maxYears=5` |
| 6 | 空间越大越便宜 | 包价表本身递减的每 GB 单价，chip 上直接标年费 |
| 7 | 固定扩容包 | 1 / 5 / 10 / 20 / 50 / 100 GB 六档，**100G 也上** |
| 8 | 方便对接虚拟支付 | 1 分单位道具，见 15.6 |

### 15.5 计价（后台可配的包价表）

配置键（单位：分/包/年，后台按「元」输入）：

| 档位 | 配置键 | 默认 | 年费 |
|---|---|---|---|
| 1GB | `price_pack_1g_cents` | 990 | 9.9 元 |
| 5GB | `price_pack_5g_cents` | 4950 | 49.5 元 |
| 10GB | `price_pack_10g_cents` | 6900 | 69 元 |
| 20GB | `price_pack_20g_cents` | 10800 | 108 元 |
| 50GB | `price_pack_50g_cents` | 18000 | 180 元 |
| 100GB | `price_pack_100g_cents` | 25500 | 255 元 |

- `storagePriceCents(gb)` 改为**按档位查表 + 档间线性插值**：历史用户自由填过 3GB / 7GB 这类非档位容量，插值保证 P 单调递增、`P(target) − P(curGb)` 不为负，2026-10-21 的边际计价与账目闭合原样成立
- **服务端不强制 qty 必须是 6 档之一**（兼容老客户端 / 历史容量），6 档是端上的 UI 约束
- 多年：`baseCents = P(curGb) × N`；`addCents = [P(target)−P(curGb)] × (remainDays + N×365)/365`；`mergePool(..., N, now)`
- `PATCH /api/admin/config` 在**写库之前**校验 6 档严格递增（否则会出现「买大包更便宜」的套利）
- v1 **不做多年折扣**
- `extend=false`（老「只扩容」档）保留兼容，金额下限改读 `vp_min_cents`，绝不抬价

### 15.6 虚拟支付对接

维持 1 分单位道具 `storage_unit`，`buyQuantity = 应付分数`。6 档 × 5 年 = 30 件固定价道具不现实，且金额随剩余天数变化 —— 只有单位道具能覆盖任意金额。孩子名额走 5 件固定价道具（年限 1–5，价格读 5 档价目表；一次只能买 1 个名额，`buyQuantity=1` 恒成立），两条链路互不干扰。参数配置见 §16。

### 15.7 容易漏掉的（按重要性）与落地状态

| # | 项 | 状态 |
|---|---|---|
| 1 | 到期提醒：端上 30 天标红 | ✅ `POOL_REMIND_SECONDS` 7→30 天 |
| 1b | 订阅消息「到期前 30 / 7 天各一条」 | ⏳ 未落码，需先配场景模板与额度 |
| 2 | 80% 用量预警 | ✅ 家长总览新增暖色提示条，点击直达容量包弹层 |
| 3 | 上传失败引导 | ✅ 「空间已满 / 已到期」提示条改指底部弹层（含 90 天只读话术） |
| 4 | 不支持降档 | ✅ 低于当前档的 chip 置灰 |
| 5 | 宽限期文案与代码一致 | ✅ 90 天；`pool_grace_days` 同时驱动 `familyPool()` 与文案 |
| 6 | Apple 弹窗道具名 | ✅ 「存储空间扩容包」；MP 后台备注要求见 §3.3 |
| 7 | 100G 档 | ✅ 保留，255 元/年对标 iCloud 200G |
| 8 | 剩余天数折算要写出来 | ✅ 明细行标「按剩余 N 天折算」 |
| 9 | iOS 1 元下限 | ✅ `vp_min_cents` 兜底 + `storage_expand_need_renew` 防御保留 |
| 10 | 基础容量与付费池分开显示 | ✅ 弹层现状行明确「永久有效，不计入付费容量」 |
| 11 | 帮助中心文案同步 | ✅ `help-seed.ts` SEED_VERSION 4→5，修订「在哪里买」「怎么算钱」「到期会怎样」 |

### 15.8 实际改造清单（已完成）

| 端 | 文件 | 改动 |
|---|---|---|
| server | `ext/platform.ts` | 6 个包价键 + `pool_grace_days` + 10 个虚拟支付键；新增校验分支、`VP_SECRET_KEYS`、`adminPlatformConfig()` 掩码 |
| server | `ext/payments.ts` | `STORAGE_TIERS` / `STORAGE_PACK_KEYS` / 插值版 `storagePriceCents()`；`SPECS` 两项 `maxYears=5`；quote 多年公式；`productList()` 下发 `packs[]`/`graceDays` |
| server | `ext/pool.ts` | `poolGraceSeconds()`；`familyPool()` 新增 `storageInGrace` / `storageGraceLeftDays`，宽限期内容量仍计入 |
| server | `ext/storage.ts` | `assertCanStore()` 把只读闸门提到容量判断之前（修掉「容量够就放行」漏口），话术带剩余宽限天数 |
| server | `ext/quota.ts` | `QuotaError.detail` 加 `graceLeftDays` |
| server | `ext/routes/admin.ts` | GET 密钥打码、PATCH 掩码跳过、包价递增预校验、审计日志脱敏、新增 `/admin/pay/vp/status` 自检 |
| server | `ext/virtualpay.ts` | **新增**：参数读取 / 状态 / 双签名 / `buildPayData()` / `xpayUrl()` |
| server | `ext/routes/pay.ts` | 无需改动（`productList()` 多返回字段自动透传） |
| 小程序 | `components/StorageBuySheet.vue` | 整体重写为 6 档 × 1–5 年 chips + 智能预选，仍是 BottomSheet |
| 小程序 | `components/SlotBuySheet.vue` | `maxYears` 兜底 3→5 |
| 小程序 | `pages/parent/home.vue` | 80% 预警条 + 两条提示条改指 `?open=storage` |
| 小程序 | `pages/me/index.vue` | `onLoad` 支持 `open=storage` 直接弹层 |
| 后台 | `admin/index.html`、`subpkg-admin/config.vue` | 6 档包价 + 宽限天数 + 虚拟支付参数表单（见 §16） |
| 部署 | `deploy-cloud/env.example`、`docker-compose.yml` | 补齐 `VP_*` 键名与回落通道 |
| 文档 | `ext/help-seed.ts` | SEED_VERSION 5，购买/到期说明整体同步 |

**验收**：`npm run build --prefix server` 与 `npx vue-tsc --noEmit` 均通过（2026-11-04 21:0x）。未发版。

### 15.9 多年制 + 等值折算 + 年数递减折扣（v2.5 · 2026-11-05 定稿 · **已随 `20261104-5` 上线**）

> 演进：v2.2 时代「6 档包价 × 1–5 年边际计价」出现「5G 一年 49.5、扩到 5G 却要 80.5」的补差价观感 → v2.4 一年制 + 等值折算（标价即实付）→ 用户反悔「一年制限制太多」，改回 1–5 年可选，保留等值折算，叠加**按年数的递减折扣**（折扣梯度取自「在名额的基础上，力度稍微减减」）。

**模型**（v2.5 定稿，替换 §15.5 旧多年公式与 v2.4 一年制）：

- `SPECS.storage_gb.maxYears=5`，`validateYears` 收 1–5 年
- **应付 = `round(P(target) × years × bp / 10000)`**，`bp = storageDiscountBp(years)`
- 年数折扣 5 键 `storage_disc_{1..5}y_bp`（万分比，10000 = 不打折），出厂 10000 / 9200 / 8500 / 8000 / 7500；后台按「折」填（9.2 → 9200），PC 与小程序端后台都有输入；PATCH **写库前**校验 0 < bp ≤ 10000 且**逐年严格递减**（`storageDiscountBp` 读取侧再兜底单调化 + 1 年硬编码 10000）
- 旧池剩余时间**等值折算成天数（向上取整）**：
  `carryDays = ceil(remainSeconds × P(curGb) / P(target) ÷ 86400)`（不足 1 天按 1 天送，每单最多让利不到 1 天；quote 与 apply 共用 `storageCarryDaysOf()`）
  新到期 = `now + years×365 天 + carryDays×86400`（`mergePoolBySeconds(curGb, 0, addGb, years*YEAR + carryDays*86400, now)`）
- 纯续费（target = cur）：折算率 1:1，到期 = 旧到期 + 年限 + ceil 余数，比旧逐秒顺延**最多多送 1 天**（用户已接受）
- **折扣不参与折算率**：折算恒用 1 年价 P(cur)/P(target)。折扣买入的池子下次升级仍按原价价值折出去 —— 折扣被「锁进」池子价值，无新增套利洞
- **账目闭合恒等式**（任意档位 × 年数成立）：买后池子账面价值 − 买前账面价值 = `P(target) × years ≥ 应付`，差额 = 折扣让利；只升不降 + 折算等值 ⇒ 无 0 元购路径
- 场景数字：1GB 买 2 年（¥17.23）用剩 565 天升 5GB×1 年 → 折算 ceil(565×0.2) = 113 天、付 ¥49.50、到期 = today + 478 天；2GB 剩 381 天升 5GB×1 年 → 付 ¥49.50、到期 = 付款日 + 1 年 + 153 天

**界面**（StorageBuySheet）：容量 chips + **年数 chips 回归**（1–5 年，2 年起 chip 标折扣如「2 年 9.2 折」，数据来自 `/pay/products` 新增的 `yearDiscounts[]`，端上零计算）；明细两行——「X GB × N 年（9.2 折） ¥91.08」+「现有剩余 N 天折算 +M 天」；到期日展示。

**接口变化**：`PoolQuote` 加 `storageDiscBp`（v2.4 的 `storageCarryDays` 语义改为「向上取整后的折算天数」）；`/pay/products` 加 `yearDiscounts[5]`；`extend` 参数保留兼容但被忽略（3 分钟订单 TTL 不存在跨版本单）。`applyEntitlement` 到账时按当前池子用同源公式重算（`order.term_years` 年限 + 并发 max 兜底）。iOS 1 元下限：应付恒 ≥ 9.9 元不触发引导，`vp_min_cents` 兜底在 VP 层保留。

**半截池修复（随本版一起发）**：`activePoolUnits()` 对 `paid_storage_bytes` 不足 1GB 但到期日残留的脏池返回 `{0,0}`（2026-11-04 线上案例：11MB 残池让首购报价折算出「剩余 351 天」多收钱）；线上已 SQL 止血清零，本版代码防复发；前端明细行加 `v-if` 兜底。

**帮助中心**：SEED_VERSION 7→8，修订「在哪里买、怎么买」「中途加购、续费怎么算钱」两篇（多年制口径，v8 未上线直接改 DEFAULT 不 bump 9）；后台双端价格 hint 改多年制措辞 + 5 个折扣输入。


---

## 16. 虚拟支付参数后台化（2026-11-04 用户要求「填了参数就能用」）

### 16.1 设计原则

- **后台是首选真源**，环境变量是回落通道：`platform_config` 有值用后台，空值或掩码回落 `VP_*` 环境变量。灰度 / 应急两条路都能跑。
- **道具先不创建**：参数留空 + `pay_virtual_enabled=0` 时，现有微信支付 V3 链路完全不受影响。
- **密钥可填不可读**：4 个密钥类键存明文（用于签名），但 GET 一律回 `'******'`，PATCH 传掩码视为「不修改」，审计日志也脱敏，输入框用 password 且 value 恒空。

### 16.2 配置键

| 键                       | 默认             | 说明                          |
| ----------------------- | -------------- | --------------------------- |
| `pay_virtual_enabled`   | `0`            | 总闸                          |
| `vp_offer_id`           | 空              | OfferId                     |
| `vp_app_key`            | 空              | **密钥** 现网 AppKey            |
| `vp_sandbox_app_key`    | 空              | **密钥** 沙箱 AppKey（iOS 不支持沙箱） |
| `vp_env`                | `0`            | 0 现网 / 1 沙箱                 |
| `vp_storage_product_id` | `storage_unit` | 空间 1 分单位道具 ID               |
| `vp_notify_token`       | 空              | **密钥** 发货推送 Token           |
| `vp_aes_key`            | 空              | **密钥** 安全模式 AES 密钥；明文模式留空   |
| `vp_notify_url`         | 空              | 发货推送 URL（必须 https）          |
| `vp_min_cents`          | `100`          | iOS 最低支付金额（分），低于它拒绝、不抬价     |

PC 后台「平台参数 → 虚拟支付（小程序）」与小程序端后台「平台参数」**两张界面都能填**，顶部有「未启用 / 参数不全（缺：X）/ 已就绪」状态行。PC 后台是 diff-only 提交，小程序端是全量提交（敏感字段留空时不进 body）。

### 16.3 服务端读取

`ext/virtualpay.ts` 提供 `vpConfig()` / `vpEnabled()` / `vpMissing()` / `vpConfigured()` / `assertVpReady()` / `VP_GOODS` / `paySig()` / `userSig()` / `buildPayData()` / `xpayUrl()`。`/xpay/*` 的 `pay_sig` 与 `access_token` 走 query，`access_token` 复用 `ext/wx.ts` 的 `getAccessToken()`。后台自检：`GET /api/admin/pay/vp/status`（不回显密钥）。

### 16.4 下单 / 发货链路落地状态（v2.6.1 · 2026-11-05）

代码已全量落码，`server/scripts/virtualpay-test.mjs` 本地模拟验收 **74/74 PASS**（前置会复位总闸并清空推送流水，可重复运行）。

| # | 项                                                                                 | 状态                |
| - | --------------------------------------------------------------------------------- | ----------------- |
| 1 | `migrate.ts`：`orders` 三列 + `vp_events` 表（含老单回填）                                   | ✅                 |
| 2 | `routes/pay.ts`：下单 / 重付 / 查单三处分流 + `/admin/pay/status` 展示 provider                | ✅                 |
| 3 | `routes/virtualpay.ts`：`GET+POST /pay/vp/notify` 发货 / 退款 / iOS 退款问询推送、验签、幂等、金额防篡改 | ✅                 |
| 4 | `vp-scheduler.ts`：5 分钟查单补发货                                                       | ✅                 |
| 5 | `hooks.ts`：公开路径与维护期白名单加 `/api/pay/vp/notify`                                      | ✅                 |
| 6 | `wx.ts`：`sessionKeyOfUser()`（生产会话超 3 天要求端上重登）                                     | ✅                 |
| 7 | `pool-pay.ts`：virtual 分支 / iOS 版本校验 / `vp_session_expired` 静默重登                   | ✅                 |
| 8 | 真机验证：`buyQuantity` 上限（99000 分）、Apple 弹窗展示形式、iOS ¥1 小额单、发货推送 GET 校验                | ⏳ 等 MP 后台 6 件道具发布 |

额外落地的两点（不在原八项清单里）：

- **后台主动退款硬拦**：`refundOrder()` 对 `provider='virtual'` 直接返回 `vp_refund_not_supported`，因为款不在 V3 商户号；iOS 更只能由 App Store 退。平台退款推送 `xpay_refund_notify` 走 `applyRefundLocal()` 收权益。后台订单页状态列显示渠道，操作列显示「平台退款」而非按钮。
- **业务单号 / 支付单号分离**：`out_trade_no` 永不改变（客服对账用），`pay_order_no` 在每次重付时由 `rotatePayOrderNo()` 换发，避免同一 `outTradeNo` 二次拉起被平台 `-15002` 拒绝。后台订单页在商户订单号下补显支付单号。

⚠️ 参数齐全 ≠ 道具已发布：`vpConfigured()` 只校验本地参数，不校验平台侧。  
⚠️ 总闸 `pay_virtual_enabled` 出厂为 `0`；打开后是**全端切换**（Android/鸿蒙/Windows 走微信虚拟支付、iOS 走 Apple 支付），V3 存量单的下单 / 回调 / 退款链路保留不变。  
⚠️ `VP_MOCK=1` 只用于本地验收，不发外网 `/xpay/*`、自动补齐参数、注册 `/admin/pay/vp/mock-*`；**生产绝不能开**。

### 16.5 MP 后台配置清单（2026-11-05 按后台实际截图核对）

**A｜道具价格：单位最容易填错**

MP 后台道具列表表头是「**价格(元)**」，而代码 `signData.goodsPrice` 是「**分**」。两边必须一致，且**道具发布后价格不可改，改价只能重建道具**。

| 道具 ID | 代码 `goodsPrice`（分） | MP 后台应填（元） |
| --- | --- | --- |
| `child_1y` | 2990 | **29.90** |
| `child_2y` | 5190 | **51.90** |
| `child_3y` | 6990 | **69.90** |
| `child_4y` | 8590 | **85.90** |
| `child_5y` | 9990 | **99.90** |
| `storage_unit` | 1 | **0.01** |

⚠️ 曾把分的数值直接填进「元」字段（2990 元 / 1 元），等于放大 100 倍。趁「未发布」务必逐个编辑。若 MP 后台不允许填 `0.01`，要回到 §15 重新设计单位道具，**不能**擅自改成 1 元 —— `buyQuantity = 应付分数`，1 元单价会让 9.9 元的包变成 990 元。

**B｜消息推送（开发管理 → 消息推送，全局唯一）**

虚拟支付【开发版本】底部「发货推送配置 → 前往配置」跳的就是这个页面，它和 UGC 内容安全回调**共用同一个 URL、同一个 Token**。

| 项 | 值 | 说明 |
| --- | --- | --- |
| URL | `https://czs-api.wodeweishenghuo.cn/api/wx/msg-push` | **不要**改成 `/api/pay/vp/notify`，否则合规的 `wxa_media_check` 回调无处可去 |
| Token | 与后台 `wx_msg_token` 一致 | 后台 `vp_notify_token` 填**同一个值**；MP 后台只有这一个 Token 字段，不用再填第二次 |
| 消息加密方式 | **明文模式** | 本服务未实现 AES 消息体解密，改成安全模式推送会全部解析失败 |
| 数据格式 | JSON（保持现状） | 官方文档说发货推送默认 XML，服务端 `parseVpNotify()` 两种都吃、按请求格式回应答 |
| EncodingAESKey | 微信随机生成，**不用填进后台** | 明文模式不生效；后台 `vp_aes_key` 留空 |
| 发货推送 URL（后台字段） | 仅作记录 | `routes/content-security.ts` 按 `Event` 前缀把 `xpay_*` 分发给 `handleVirtualPayNotify()`；`/api/pay/vp/notify` 作为独立入口保留。两个入口共用 `vp_events` 幂等流水 |

**C｜虚拟支付 → 基本配置 的两个开关**

| 开关 | 建议 | 原因 |
| --- | --- | --- |
| 是否启用平台路径 | **保持关闭** | 官方口径该路径用于「订阅消息和发现页等推荐场景」，需另配平台规范路径，与道具直购无关；提示明确写「请完成开发后再启用，勿频繁变更」 |
| 是否启用苹果 IAP 支付 | 安卓真机跑通后再开 | iOS 必需，但前置条件多：先在「账号设置 → 基本信息」配**小程序简称**（Apple display name）；iOS ≥ 15.0、微信 ≥ 8.0.68、必须现网 `env=0`（沙箱不支持）、单笔 ≥ 1 元。社区反馈该开关**开启后可能无法关闭**，Apple 抽成 12%（安卓 1%）。开之前把 `pay_ios_enabled`（V3 的 iOS 开关）关掉，避免两套支付并存 |

**D｜后台平台参数**

`pay_virtual_enabled=0`（真机验证后再灰度开）· `vp_offer_id=1450694373` · `vp_app_key` 取 MP「查看现网AppKey」（复制后检查首尾空格）· `vp_sandbox_app_key` 仅 `env=1` 时用 · `vp_env=0` · `vp_notify_token` = 消息推送 Token · `vp_aes_key` 留空 · `vp_notify_url` 建议填实际消息推送 URL · `vp_min_cents=100`。

**E｜上线前检查**

1. 6 件道具状态从「未发布」变成**已发布**（开发版本只在沙箱有效）；发布后等 **10–30 分钟**同步，期间下单会被 `COIN_OR_PRODUCT_ID_CREATED_IN_RECENTLY` / `-15014` 拒绝。
2. 生产确认未开 `VP_MOCK` / `WX_MOCK`；消息推送配置有约 10 分钟缓存。
3. 真机小额：最小真实订单是 **1GB × 1 年 = ¥9.90**。`storage_unit` 的 0.01 元是**单价**，`buyQuantity = 应付分数`，订单金额恒 ≥ 990 分；`vp_min_cents=100` 只是兜底，实际不会触发，所以**没有 ¥1 的测试单**。另验 Apple 弹窗道具名与金额、`buyQuantity` 上限（99000 分）、发货推送 GET 校验、iOS 退款问询 3 秒应答；测试单 180 天内退掉。
4. **iOS 必须正式版真机**：开发者工具与体验版跑不了 Apple IAP，需微信 ≥ 8.0.68、iOS ≥ 15、国区 Apple ID、单笔 ≥ 1 元、已配小程序简称。本项目小程序当前仍是体验版（`WX_MP_STATE=trial`），这一步等正式发布后再做。
5. **首单务必核对 `vp_events.raw`**：微信真实推送字段可能是 `WeChatPayInfo.MchOrderNo` / `GoodsInfo.ProductId` / `GoodsInfo.Quantity`（官方文档），也可能是 JSON 或 XML；服务端已按候选键摊平兼容，但金额单位要实测确认。

**F｜环境选择与上线分步（2026-11-05 按 MP 后台截图核对）**

**结论：`vp_env` 选 `0 · 现网`，不选沙箱。**

官方《使用 AI 工具快速接入小程序虚拟支付》给出的环境限制：沙箱只适用开发版 / 体验版，且**真机预览下会被 `PAYMENT_ILLEGAL_IN_SANDBOX` 拦截**，仅适合开发者工具内调试；现网适用全版本，`-15011` 明确「现网版本的 env 只能是 0，不能填 1」，**iOS 不支持沙箱**。本项目 `vp_env` 同时决定 `signData.env` 和用哪个 AppKey（`sandbox ? vp_sandbox_app_key : vp_app_key`），切沙箱要换一整套密钥，切回时漏改就是 `-15006` 签名错误。真正的安全阀不是 env，而是「总闸关闭 + 代码未发版 + 道具未发布」，现在选现网不会产生任何真实订单。

| 阶段 | 操作 | 前置 / 注意 |
| --- | --- | --- |
| A 现在（可独立做） | 环境保持 `0 · 现网`；消息推送页一字不改；`vp_aes_key` 留空；`vp_notify_url` 建议改成 `https://czs-api.wodeweishenghuo.cn/api/wx/msg-push` | **不要点批量发布、不要开总闸** |
| B 发版 | 用户认可后先确认版本号 + CHANGELOG 草稿 → 三构建 → 体验版上传 → 镜像 → 线上 health 验版本 | 线上 `20261104-6` 尚无虚拟支付代码，现在开闸也不会有单 |
| C 发版后 | 勾选 6 件道具点「批量发布」→ 等 10–30 分钟 → 短时间打开总闸 → 安卓真机用 ¥9.90 档验证 → 测完关回总闸 | 总闸是**全端切换**，没有按用户灰度，挑低峰时段 |
| D 后置 | 小程序正式发布 + 配小程序简称 + 开苹果 IAP + 关 `pay_ios_enabled` → iOS 真机验证 | 体验版 / 开发者工具无法测 Apple |

---

## 17. 孩子名额年限包定价（2026-11-04 22:53 用户拍板 · **已随 `20261104-4` 上线**）

用户三条决策：**用激进版折扣**；**V3 微信支付与虚拟支付统一成同一张 5 档价目表**；**一次只能买 1 个名额**。其余按建议：后台只读展示、端上把优惠做可见、校验前置、帮助中心同步。

### 17.1 价目表（1 个名额，连买 N 年的整包总价）

| 年限  | 总价    | 折合每年  | 折扣     | 比按年买省 | `platform_config` 键（分）       | MP 后台填（元） | `goodsPrice`（分） |
| --- | ----- | ----- | ------ | ----- | ---------------------------- | --------- | --------------- |
| 1 年 | ¥29.9 | 29.90 | —      | —     | `price_slot_1y_cents` = 2990 | 29.90     | 2990            |
| 2 年 | ¥51.9 | 25.95 | 8.68 折 | 7.9   | `price_slot_2y_cents` = 5190 | 51.90     | 5190            |
| 3 年 | ¥69.9 | 23.30 | 7.79 折 | 19.8  | `price_slot_3y_cents` = 6990 | 69.90     | 6990            |
| 4 年 | ¥85.9 | 21.48 | 7.18 折 | 33.7  | `price_slot_4y_cents` = 8590 | 85.90     | 8590            |
| 5 年 | ¥99.9 | 19.98 | 6.68 折 | 49.6  | `price_slot_5y_cents` = 9990 | 99.90     | 9990            |

选它的理由：5 年折合 19.98 元/年 ≈ 原来的 19.9 元/年，可以打「**长期用不涨价**」；1 年从 19.9 提到 29.9（+50%），整包价仍高于旧线性价（旧 5 年 = 99.5 元，新 5 年 = 99.9 元），优惠没有吃掉调价。总价严格递增，边际增量 29.9 → 22.0 → 18.0 → 16.0 → 14.0 单调不增，**拆单买不会更便宜**。

### 17.2 与旧实现的差异

| 项             | 旧（v2.2.2）                                                       | 新（v2.3）                                                                |
| ------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 名额金额          | `年单价 × qty × years`（V3），`1990 × years`（虚拟支付，两套价）                | `slotPackPriceCents(years)`，V3 与虚拟支付**共用一张表**                          |
| 一次买几个         | `maxQty=5`                                                      | **`maxQty=1`**：一次只买 1 个名额，需要多个分次买（每张券可各选时长）                            |
| `buyQuantity` | 恒 1，但 qty 可 >1 → 会少收钱                                           | 恒 1，且 qty 恒 1，**账目闭合**                                                 |
| 价格真源          | `platform_config.price_child_slot_cents`（V3） + `VP_GOODS`（虚拟支付） | `platform_config.price_slot_{1..5}y_cents`；`VP_GOODS` 只存 5 个 productId |
| 后台            | 可编辑「孩子名额单价（元/个/年）」                                              | **5 档只读展示**：固定价道具发布后不可改，改价必须重建 5 件 MP 道具（否则 `-15013`）                  |
| 端上            | 「¥单价 × 1 个 × N 年」                                               | chips 标每档总价 + 「最划算」，明细写「折合每年」「比按年买省」                                   |

`price_child_slot_cents` 保留在 `platform.ts` 只为兼容老库 / 回滚，**代码与后台界面都不再读写**。`PoolQuote.unitCents` 保留为「1 年基础价」快照，仅用于订单存档与下架判断，不参与乘算。

### 17.3 落码清单

- `platform.ts`：5 个新键（默认 2990/5190/6990/8590/9990）+ 值域校验；旧键降级为兼容。
- `payments.ts`：`SLOT_YEARS` / `SLOT_PACK_KEYS` / `slotPackPriceCents()`；`SPECS.child_slot.maxQty=1`；`quote()` 两个名额分支改查表；`productList()` 新增 `slotPacks[]`（totalCents / yearlyCents / savedCents，端上零计算）。
- `virtualpay.ts`：`VP_GOODS.childSlot` 只留 ID，`goodsPrice = slotPackPriceCents(o.years)`，`buyQuantity=1`；`amountCents` 与道具价不一致直接抛 `vp_price_mismatch`。
- `routes/admin.ts`：PATCH 写库**前**校验 5 档「总价严格递增 + 边际增量不增」（`setPlatformConfig` 不在事务里，放后面会留半套价）。
- `admin/index.html` / `subpkg-admin/pages/config.vue`：单输入改 5 档只读价目表，不再提交旧键。
- `SlotBuySheet.vue`：chips 显示总价与「最划算」，明细显示折合每年 / 省多少；`qty=1` 本就已写死。
- `help-seed.ts`：`SEED_VERSION` 6 → 7，修订「在哪里买」「怎么算钱」两篇。

### 17.4 仍需留意

- 后台 5 档**只读**：真要调价必须「新建 5 件 v2 道具 + 改 `SLOT_PACK_KEYS` 默认值 + 灰度」，不能只在后台改数字。
- 多年优惠单沿用现有「名额不支持退款」规则（端上 hint 与帮助中心 v7 已写明），不引入按未使用时长折算的新退款口径。
- 线上 `price_child_slot_cents` 的历史值不再生效；新 5 键按 DEFAULTS 自动补齐，**不需要手工迁移**。
- `vp_min_cents`（iOS 最低 1 元）对名额无影响：最低档 29.9 元远高于 1 元。
