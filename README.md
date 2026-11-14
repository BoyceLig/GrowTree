<div align="center">

<img src="docs/growtree-logo.png" width="140" alt="成长树 GrowTree"/>

# 🌳 成长树 · GrowTree

**让好习惯，像小树一样慢慢长大。**

</div>

> 一个面向家庭的自托管积分管理系统 —— 让孩子在完成任务、赚取积分、兑换奖励的过程中，学会规划与成长。

**怎么玩**：孩子完成日常任务，或家长发布的临时任务 → 获得积分 → 用积分在商店兑换商品或现金；
所有申请由家长审核把关。数据全部保存在本机（SQLite 单文件），**不上传任何云端**。

> 🍴 **这是二次开发版，不是上游原版。**
> 本项目在 [风雨潇潇的成长树](https://gitee.com/wdcasc/growtree) 基础上继续开发，
> 风雨潇潇的版本又源自 [piggy-bank（基耶杰）](https://github.com/ASH-C776/piggy-bank)。
> **镜像仓库里的 `wdcasc/growtree` 是风雨潇潇的原版，装上去没有本项目的新功能**，
> 安装请走「[从源码构建](#快速开始从源码构建)」。

[功能特性](#功能特性) · [本版新增](#本版新增与上游的差别) · [界面预览](#界面预览) · [快速开始](#快速开始从源码构建) · [交流反馈](#交流与反馈飞书群) · [常见问题](#常见问题) · [更新日志](#更新日志)

---

## ⚠️ 先认清版本：三代血缘

| 层级 | 项目 | 地址 | 说明 |
|---|---|---|---|
| 原作 | piggy-bank（存钱罐）· 基耶杰 | <https://github.com/ASH-C776/piggy-bank> | MIT 许可，最早的家庭积分系统，本系列的起点 |
| 第二层 | 成长树 GrowTree · 风雨潇潇 | <https://gitee.com/wdcasc/growtree> | 在 piggy-bank 上大改：改名「成长树」、重做界面、加小程序 / 安卓 / 飞牛包 |
| **第三层** | **GrowTree 二次开发版（本仓库）** | <https://github.com/BoyceLig/GrowTree> | 在风雨潇潇版上继续加功能：日历、成长日记、悄悄话、背包、心愿单、多家长账号…… |

**这两处都是风雨潇潇的原版，装错就变回「他的版本」**：

- 阿里云镜像 `crpi-q6m49k4ufbvik9l5.cn-hangzhou.personal.cr.aliyuncs.com/wdcasc/growtree`
  （`deploy/compose/docker-compose.yml`、`安装说明-给用户.md` 里用的就是它）
- App 内 **「立即升级」** 按钮（默认也是去上面那个仓库查版本、拉镜像）

所以本仓库只推荐一种装法：**下载源码 → 自己构建**。构建出来的镜像是本地的
`growtree:latest`，功能才是本仓库这一套。

---

## 功能特性

### 👨‍👩‍👧 家长端

| 模块 | 说明 |
|---|---|
| **总览** | 今日加分 / 扣分 / 操作次数、家庭积分排行，树洞信箱、悄悄话、审核都在这一页 |
| **任务** | 临时任务（分类、积分奖励、截止时间）+ 周期任务（每天 / 每周，可「多天只完成一次」）；有效期可选长期或指定日期区间 |
| **积分** | 设置日常加分 / 扣分项目（可限制每日次数），一键为孩子加减分 |
| **审核** | 任务完成、商品 / 现金兑换、心愿单集中审批，审核记录自动保留 |
| **商城** | 商品分类、库存，实物与道具两类，可上下架 |
| **背包** | 网格化查看孩子物品，区分「孩子用的 / 家长送的 / 家长拿走的」，附操作历史 |
| **成长** | 身高体重记录 + 中国儿童生长标准百分位曲线；支持多孩子按年龄对齐对比 |
| **日记** | 成长日记：图文 / 视频混排，图片并排自适应、拖拽重排、拖边调占比（飞书式） |
| **日历** | 双端日历：日程按参与人归属（家长看全部，孩子看自己 + 兄弟姐妹）；家长可设重复「特殊日」（每周几 / 每月几号 / 每年几号），当天积分获得翻倍或消耗减半 |
| **记录** | 全部积分流水，按天分组、可按时间段统计（从总览「今日加分 / 扣分」卡片进入） |
| **账号** | 多家长账号：主家长可添加子家长，家长与孩子两个身份可在同一浏览器并行登录 |

### 🧒 孩子端

| 模块 | 说明 |
|---|---|
| **主页** | 当前积分余额、生肖头像、等级进度、今日积分、最近记录 |
| **任务** | 领取任务、提交完成，等待家长审核 |
| **商城** | 用积分兑换商品或申请兑换现金，道具直接进背包 |
| **成长 / 日记** | 看自己的成长曲线和自己的成长日记 |
| **日历** | 自己的日程 + 兄弟姐妹的日程 |
| **小心思** | 主页上的三块：树洞信箱（家庭留言墙）、悄悄话（和家长一对一私聊）、心愿单（许愿 → 家长审核） |
| **背包** | 自己拥有的道具、已使用的、被家长拿走的（含理由与返还积分） |

### ✨ 其他

- 家长用 **账号 + 密码** 登录；孩子用 **账号 + PIN 码** 登录（无需记密码）
- 内置 **12 生肖头像**，响应式设计，手机 / 平板 / 电脑通用
- 积分换现金比例可自定义（默认 10 积分 = 1 元，家长端商城页可改）
- WebSocket 实时更新（家长审核数、孩子的留言即时刷新）
- 图片 / 视频上传，内容按哈希去重，不重复占空间
- 提供 **Android 客户端** 打包脚本（Capacitor）与 **飞牛 fnOS fpk 应用包** 打包脚本
- **一键升级**：本版请先别用，原因见 [升级到本仓库新版本](#升级到本仓库新版本)

---

## 本版新增（与上游的差别）

上游（风雨潇潇版）已经把家庭积分的主流程做完了，本项目在它之上补的是「家庭协作 + 记录」这一层：

| 新增 | 一句话说明 |
|---|---|
| **日历与特殊日** | 双端月 / 日视图，日程按参与人组织；特殊日可让当天积分获得翻倍、消耗减半 |
| **成长日记** | 图文 + 视频混排的富文本日记，图片并排自适应、拖拽重排、拖边调占比 |
| **树洞信箱** | 家庭留言墙，家长和孩子都能放一句话进来 |
| **悄悄话** | 家长 ⇄ 孩子一对一私密会话，与树洞信箱是两套独立数据 |
| **心愿单** | 孩子许愿 → 家长审核 → 通过后自动上架成商城里可兑换的商品 |
| **背包** | 道具入包、使用、赠送、被家长拿走（保留理由与返还积分）+ 操作历史 |
| **审核中心** | 任务、兑换、心愿待办集中一处处理，审核记录合并展示 |
| **多家长账号** | 主家长 / 子家长分权限，家长与孩子双身份并行登录，家长资料完善 |
| **周期任务增强** | 每天 / 每周，可选「多天只完成一次」，有效期可选长期或指定区间 |
| **本地开发体验** | `npm run dev` 一键起前后端，自动用独立的 `data-dev` 库，不碰正式数据 |

---

## 界面预览

**孩子端**

<p align="center">
  <img src="docs/screenshots/02-child-home.jpg" width="250" alt="孩子端 · 首页">
  &nbsp;&nbsp;
  <img src="docs/screenshots/01-child-shop.jpg" width="250" alt="孩子端 · 商城">
</p>

**更多界面**

<p align="center">
  <img src="docs/screenshots/03-preview.jpg" width="250" alt="界面预览">
  &nbsp;&nbsp;
  <img src="docs/screenshots/04-preview.jpg" width="250" alt="界面预览">
  <br><br>
  <img src="docs/screenshots/05-preview.jpg" width="250" alt="界面预览">
  &nbsp;&nbsp;
  <img src="docs/screenshots/06-preview.jpg" width="250" alt="界面预览">
</p>

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + Vite + Pinia + Vue Router（富文本用 Tiptap） |
| 后端 | Fastify + better-sqlite3 |
| 数据库 | SQLite（单文件，零配置） |
| 部署 | Docker / Docker Compose |

---

## 快速开始（从源码构建）

### 0. 准备

- Docker 20+ 和 `docker compose` v2（`docker compose version` 能打印版本即可）
- 机器建议 2 核 4G 以上；构建期临时占用约 2～3 GB 磁盘
- 首次构建要联网拉 npm 包，`Dockerfile` 已内置 `registry.npmmirror.com` 加速

### 1. 拿源码（认准这个地址）

```bash
git clone https://github.com/BoyceLig/GrowTree.git
cd GrowTree
```

也可以在 GitHub 页面点 **Code → Download ZIP** 解压使用。
**不要**用 `gitee.com/wdcasc/growtree` —— 那是上游原版，构建出来没有本版功能。

### 2. 一条命令构建并启动（推荐）

```bash
bash scripts/docker-build.sh
```

这条命令会做四件事：

1. 读根目录 `VERSION` 当版本号（如 `20261106-2`）
2. `docker build` —— **在容器内**装依赖、打包前端（`vue-tsc` 类型检查 + `vite build`）、编译后端，所以本地不需要先 `npm install` / `npm run build`
3. 打成两个 tag：`growtree:20261106-2`（回滚用）和 `growtree:latest`（compose 默认用）
4. `docker compose up -d` 启动，并探活 `http://127.0.0.1:3000/`

Windows 下用 Git Bash 执行；没装 bash 就用等价的两条：

```bash
docker build --build-arg VERSION=$(cat VERSION) -t growtree:latest .
docker compose up -d
```

> 可选：`bash scripts/docker-build.sh --save` 额外导出 `growtree-image-<版本>.tar.gz`，
> 拷到别的机器 `docker load` 就能跑，不用在 NAS 上编译；`--no-up` 只构建不启动。

### 3. 打开

```
http://<这台机器或 NAS 的 IP>:3000
```

### 4. 改密码（强烈建议）

在仓库根目录新建 `.env`（和 `docker-compose.yml` 同目录）：

```dotenv
PIGGY_PORT=3000
ADMIN_PASSWORD=改成你的强密码
JWT_SECRET=改成一串随机字符串
```

然后 `docker compose up -d` 让它生效。

### 备选：不用 compose，纯 docker 命令

```bash
# 先构建（也可以先 npm install && npm run build，本机有 Node 20+ 时）
docker build -t growtree:latest .

docker run -d \
  --name growtree \
  --restart unless-stopped \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=你的强密码 \
  -e JWT_SECRET=你的随机密钥 \
  growtree:latest
```

镜像名必须是本地 `growtree:latest`。写成 `crpi-xxx.../wdcasc/growtree` 就又装成上游版了。

### 本地开发（改代码，不构建镜像）

```bash
npm install
npm run dev
```

- 前端 <http://localhost:5173>（改前端文件保存即热更新）
- 后端 <http://localhost:3001>（改后端 `.ts` 保存自动重启）
- 开发库落在 `data-dev/`，**不碰正式 `data/`**

更细的说明见 [2026-11-12/local-dev/outputs/本地开发上手指南.md](./2026-11-12/local-dev/outputs/本地开发上手指南.md)（含端口、踩坑、换 Node 版本后 `better-sqlite3` 报错的处理）。

### 打包其他形态

| 形态 | 怎么打 |
|---|---|
| Android APK | Windows 双击 `一键打包APK.bat`；版本号取自根目录 `VERSION` |
| 飞牛 fnOS fpk | `bash scripts/build-fndepot.sh` |

### 升级到本仓库新版本

```bash
git pull
bash scripts/docker-build.sh
```

数据在 `./data`，重新构建不会动它。

> ⚠️ **别点 App 里的「立即升级」，也别 `docker compose pull`。**
> 「立即升级」默认去 `wdcasc/growtree` 查版本、拉镜像，一升级就把你的部署**换成了风雨潇潇的原版**，
> 日历、日记、悄悄话、背包这些功能会一起消失（数据还在，但功能不在了）。
>
> 如果你把自己的构建推到了私有镜像仓库，可以设 `PIGGY_UPDATE_REGISTRY`、`PIGGY_UPDATE_REPO`
> 两个环境变量让「立即升级」指向自己的仓库，见 [环境变量](#环境变量)。

---

## 首次登录

系统首次启动时会自动创建管理员账号：

| 项目 | 默认值 |
|---|---|
| 用户名 | `admin` |
| 密码 | `admin123` |

> ⚠️ **请登录后在右上角「账号管理」里立即改掉默认密码**。
> 默认密码是公开的，不改会有安全风险。

登录后按顺序做这几件事：

1. 右上角 **账号管理** → 改掉 `admin` 的密码；需要两位家长一起管，就在同一个面板里新增「子家长」
2. 还是 **账号管理** → 添加孩子账号，设置孩子的 **PIN 码**
3. 在 **积分** 里检查 / 调整默认的加分、扣分项目
4. 在 **商城** 里添加可兑换的商品（顺手建几个分类）
5. 在 **任务** 里发布任务，或在 **日历** 里加日程 / 特殊日
6. 孩子用自己的账号 + PIN 登录，就能开始种树了

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口（容器内） |
| `PIGGY_PORT` | `3000` | 宿主机映射端口（compose 用） |
| `DATA_DIR` | `/app/data` | 数据目录（SQLite 数据库 + 上传文件） |
| `ADMIN_USERNAME` | `admin` | 首次初始化时创建的管理员用户名 |
| `ADMIN_PASSWORD` | `admin123` | 首次初始化时创建的管理员密码 |
| `JWT_SECRET` | `please-change-this-secret-in-production` | 登录令牌签名密钥，**务必修改** |
| `PIGGY_VERSION` | 由 `VERSION` 注入 | 当前版本号，「关于」页展示用 |
| `PIGGY_UPDATE_REGISTRY` | 上游阿里云 ACR | 升级检查用的镜像仓库地址（**改这个才能安全用一键升级**） |
| `PIGGY_UPDATE_REPO` | `wdcasc/growtree` | 升级检查用的仓库名，指向自己的仓库 |
| `WATCHTOWER_URL` | `http://watchtower:8080` | 一键升级执行器地址，不填则降级为「复制命令自己执行」 |

> ℹ️ `ADMIN_USERNAME` / `ADMIN_PASSWORD` **仅在数据库为空（首次启动）时生效**。
> 数据库里已有家长账号时，这两个变量不会覆盖它。

---

## 数据存储与备份

所有数据都在 `data/` 目录：

```
data/
├── money-jar.db         # 主数据库（文件名沿用旧版，从旧版升级无需迁移）
├── money-jar.db-wal     # 预写日志
├── money-jar.db-shm     # 共享内存
└── uploads/             # 上传的图片、视频、头像
```

**备份**：直接复制整个 `data/` 目录（连同 `-wal`、`-shm` 一起复制）。
**恢复**：把备份的 `data/` 放回原处，重启容器。

> ⚠️ 不要单独删除 `data/`，否则所有账号、积分、日记、照片都会丢。

---

## 项目结构

```
GrowTree/
├── Dockerfile                    # 多阶段构建：容器内装依赖 + 打包前端 + 编译后端
├── docker-compose.yml            # 本地镜像启动（本仓库用这个）
├── VERSION                       # 版本号唯一真源
├── scripts/                      # 构建 / 部署 / 打包脚本
│   ├── docker-build.sh           # 一键构建 + 启动 + 探活
│   ├── push-acr.sh               # 推送到自己的镜像仓库
│   └── build-fndepot.sh          # 飞牛 fpk 打包
├── deploy/
│   ├── compose/                  # ⚠️ 上游原版 compose（拉 wdcasc 镜像），本仓库别用
│   └── fpk/ fndepot/             # 飞牛 fnOS 打包模板，脚本会用到
├── server/                       # 后端
│   └── src/
│       ├── index.ts              # 入口
│       ├── auth.ts               # 鉴权（JWT + bcrypt）
│       ├── ws.ts                 # WebSocket
│       ├── update.ts             # 版本检查 / 一键升级
│       ├── db/                   # 初始化、迁移、schema.sql
│       └── routes/               # 接口路由：任务、积分、商城、审核、成长、
│                                 # 日记、日历、信箱、悄悄话、心愿、背包、家长…
└── web/                          # 前端
    └── src/
        ├── api/                  # 接口封装
        ├── components/           # 通用组件（含 calendar/、diary 编辑器扩展）
        ├── router/               # 路由（家长端 / 孩子端两套）
        ├── stores/               # Pinia 状态
        ├── utils/                # 工具（图片布局、上传等）
        └── views/
            ├── Login.vue
            ├── parent/           # 家长端页面
            └── child/            # 孩子端页面
```

---

## 常用命令

```bash
# 构建 + 启动（改代码后重新执行）
bash scripts/docker-build.sh

# 停止 / 重启 / 看日志
docker compose stop
docker compose restart
docker compose logs -f

# 停止并删除容器（数据保留）
docker compose down

# 回滚到某个旧版本（镜像 tag 还在本地）
PIGGY_VERSION=20261106-2 docker compose up -d

# 本地开发
npm run dev
```

---

## 交流与反馈（飞书群）

**功能建议、Bug 反馈、安装求助，都欢迎进群说。**

<p align="center">
  <img src="docs/feishu-group.png" width="320" alt="成长树 · 功能建议与 Bug 反馈飞书群二维码">
</p>

<p align="center">用飞书扫码进群即可；二维码失效了就到仓库提 Issue，或在 Issues 里留言要新码。</p>

提 Bug 时麻烦带上这几样，定位会快很多：

1. 「关于成长树」页里的**版本号**（如 `20261106-2`）
2. 设备与浏览器（如 iPhone 15 / Safari、群晖 DS220+ / Docker）
3. 复现步骤：点了什么 → 期望看到什么 → 实际看到了什么
4. 有报错的话，截图 + `docker compose logs --tail 100` 的输出

> 想提新功能也可以直接在群里说，收进 [docs/待开发功能清单.md](./docs/待开发功能清单.md) 后会定期排期。

---

## 常见问题

### 1. 装完了，功能跟说明对不上（没有日历 / 日记 / 悄悄话）

装成上游原版了。检查镜像名：

```bash
docker ps --format '{{.Names}}\t{{.Image}}'
```

`growtree:latest` 才是本仓库构建出来的；出现 `crpi-.../wdcasc/growtree` 就是风雨潇潇的原版镜像，
按 [快速开始](#快速开始从源码构建) 重新构建并 `docker compose up -d`。

### 2. 构建失败，提示找不到文件

确认在**仓库根目录**（有 `Dockerfile`、`docker-compose.yml`、`server/`、`web/`）执行命令。
`Dockerfile` 会在容器内编译前端，**不需要**本地先跑 `npm run build` 生成 `web/dist`。

### 3. 端口被占用

```bash
PIGGY_PORT=3100 bash scripts/docker-build.sh     # 换宿主机端口
```

或改 `docker-compose.yml` 里的 `"${PIGGY_PORT:-3000}:3000"`。

### 4. 构建时网络超时（国内环境）

`Dockerfile` 已内置 npmmirror 与 Alpine 中科大源；仍失败通常是网络抖动，重新执行一次构建即可。
NAS 上构建慢可以先在快的机器上 `bash scripts/docker-build.sh --save`，再把镜像包拷过去 `docker load`。

### 5. 本地开发报 `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED`

换了 Node 大版本，`better-sqlite3` 的原生二进制对不上：

```bash
npm rebuild better-sqlite3
# 若报 gyp 编译错误（没装 VS C++ 编译器），直接删掉重装：
rm -rf node_modules/better-sqlite3 && npm install
```

### 6. 忘记密码

- **子家长忘了**：主家长在「账号管理」里直接改他的密码即可
- **孩子忘了 PIN**：家长在「账号管理」里重置
- **主家长自己忘了**：`ADMIN_PASSWORD` 只在数据库为空时生效，没有其它找回入口。
  只能先备份 `data/`，删掉 `data/money-jar.db` 重新初始化（**会清空数据**）。
  所以务必定时备份 `data/`。

### 7. 能在外网访问吗？

默认只监听局域网。需要外网就上**内网穿透**或**反向代理 + HTTPS**，
**不要**把 3000 端口直接暴露到公网。

---

## 安全建议

1. **务必修改默认密码** `admin123`
2. **务必修改 `JWT_SECRET`**，用随机字符串
3. 孩子的 PIN 码不要过于简单
4. 定期备份 `data/` 目录
5. 不要把服务直接暴露到公网

---

## 更新日志

最近一次发版的版本号是 **20261106-2**（2026-11-06），完整历史见 [CHANGELOG.md](./CHANGELOG.md)。
本仓库自建分支以来的主要变化如下（其中一部分还在开发中，尚未单独发版）：

- **多家长账号**：主 / 子家长分权限，家长与孩子双身份并行登录，家长资料可完善
- **成长日记**：飞书式图文 / 视频混排，图片并排自适应、拖拽重排、拖边调占比，视频不再限大小
- **日历与特殊日**：双端日程按参与人组织；家长可设重复特殊日，当天积分获得翻倍或消耗减半
- **背包升级**：网格卡片 + 三组分区，拿走不再删除（保留理由与返还积分），家长端可查操作历史
- **悄悄话 / 树洞信箱 / 心愿单**：家庭内部沟通与许愿审核闭环
- **审核中心合并**：任务、兑换、心愿在一个面板处理，审核记录合并展示
- **本地开发**：`npm run dev` 起前后端，自动使用独立 `data-dev` 库，不碰正式数据
- 数据文件名保持 `money-jar.db` 不变，从上游 / 存钱罐升级**无需迁移数据**

> 注：CHANGELOG 里 `20261016` 之前的条目多数来自上游，其中带小程序、运营后台、拉新签到等内容
> 属于上游云端版，**本自建版没有这些功能**，以本文件「功能特性」一节为准。

---

## 版本号规则

**版本号 = 发布日期**：`YYYYMMDD`（如 `20261106`）；同一天第 2 版起追加 `-序号`
（`20261106-2`、`20261106-3`……第 1 版不带后缀）。

仓库根目录的 **`VERSION` 文件是唯一真源**，改版本号只需改这一个文件：

| 位置 | 怎么取版本号 |
| --- | --- |
| Docker 镜像 tag / compose | `scripts/docker-build.sh` 读 `VERSION`；`PIGGY_VERSION` 注入容器 |
| 网页「关于成长树」页 | 后端 `GET /api/about` 返回容器内的 `PIGGY_VERSION` |
| 安卓 APK | `web/android/app/build.gradle` 直接读 `../../VERSION`；`versionCode = YYYYMMDD × 10 + 序号` |
| 飞牛 fpk / fndepot 包 | `scripts/build-fndepot.sh` 优先读 `VERSION`，读不到才退回 `deploy/fpk/.../manifest` |
| 三个 `package.json` | npm 要求 semver，用等价写法 `YYYY.MM.DD-序号`（如 `2026.11.6-2`） |

---

## 许可证

本项目沿用上游的 **BSL 1.1（Business Source License 1.1）** —— **不是传统开源协议**，
版权署名见 [NOTICE](./NOTICE)（含上游原始版权声明）：

| 你是谁 | 能不能免费用 |
|---|---|
| 个人 / 家庭（自托管） | ✅ 永久免费，可复制、修改、分发修改版 |
| 公司 / 组织 / 商业服务 | ❌ 生产环境使用需先购买商业授权 |

- **2029-10-09 起**，本版本将自动转为 **GPL-3.0-or-later** 开源，届时按 GPL 条款自由使用
- 完整条款见 [LICENSE](./LICENSE)，第三方版权与字体说明见 [NOTICE](./NOTICE)
- 商业授权与定制开发：按 LICENSE 条款联系版权方（原作者微信 `wdcasc`），或进飞书群询问

### 致谢上游

本项目的血缘一共三层，从上到下越来越新 —— **本项目是根据「风雨潇潇」那一版二次开发的，
而风雨潇潇那一版又是根据 piggy-bank（基耶杰）开发的**：

```
① piggy-bank（存钱罐）· 基耶杰 · MIT
   https://github.com/ASH-C776/piggy-bank
        │
        │  风雨潇潇在原作基础上改名「成长树」、重做界面、扩展功能
        ▼
② 成长树 GrowTree · 风雨潇潇 · BSL 1.1
   https://gitee.com/wdcasc/growtree
        │
        │  ← 本项目在这里接手，继续加功能
        ▼
③ GrowTree 二次开发版（本仓库）
   https://github.com/BoyceLig/GrowTree
```

| 层 | 作者 | 贡献 | 许可 |
|---|---|---|---|
| ① 原作 | 基耶杰 | 家庭积分系统的雏形：积分项、任务、商城、审核 | MIT |
| ② 二层 | 风雨潇潇 | 更名「成长树」、全新界面、一键升级、安卓 / 飞牛包等 | BSL 1.1 |
| ③ 本仓库 | 本项目维护者 | 日历与特殊日、成长日记、树洞信箱、悄悄话、心愿单、背包、多家长账号 | 沿用 BSL 1.1 |

依 MIT 许可证要求，[NOTICE](./NOTICE) 中保留了 piggy-bank 的原始版权声明；
风雨潇潇版的 BSL 1.1 署名同样保留在 NOTICE / LICENSE 里。
感谢两位前作者，让这个项目有得改、有得长 —— 想支持他们，也欢迎去上面的原始仓库点个 Star。
