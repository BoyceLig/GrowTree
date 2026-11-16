![满伴成长树 ManAlong](docs/manalong-logo.png)

# 🌳 满伴成长树 · ManAlong

**让好习惯，像小树一样慢慢长大。**

面向家庭的自托管积分管理系统：孩子完成日常或临时任务赚积分，用积分在商城兑换商品或现金，
所有申请由家长审核。数据全部保存在本机（SQLite 单文件），**不上传任何云端**。

| 项目 | 信息 |
|---|---|
| 仓库 | <https://github.com/BoyceLig/ManAlong> |
| 作者 / 维护 | **BoyceLig**（微信 `Boyce_Lig`） |
| 当前版本 | `20261116`（唯一真源见根目录 [VERSION](./VERSION)） |
| 许可 | **BSL 1.1**：个人 / 家庭自托管永久免费；商业生产使用需授权（见[许可证](#许可证)） |
| 上游 | [成长树 GrowTree](https://gitee.com/wdcasc/growtree)（风雨潇潇，BSL 1.1）← [piggy-bank](https://github.com/ASH-C776/piggy-bank)（基耶杰，MIT） |

**关于名字**：**满伴成长树**是长名（文档、应用商店、安装包标题用），**满伴**是短名（图标、App 内、日常称呼用）。
「满」是积分一点点长满、日子一点点记满；「伴」是家长陪着孩子长大；「成长树」是这些记录自己长成的一棵树。
英文名 **ManAlong** = man（满）+ along（一路同行），对应 *grow up together*。

> 🍴 这是**二次开发版**，基于风雨潇潇的成长树 GrowTree 继续开发（血缘与许可衔接见[致谢上游](#致谢上游)）。
> 上游原版镜像 `wdcasc/growtree` **不含**本版功能，安装请走[从源码构建](#快速开始从源码构建)。

[功能特性](#功能特性) · [界面预览](#界面预览) · [快速开始](#快速开始从源码构建) · [常见问题](#常见问题) · [文档](#文档) · [作者与许可](#作者与联系)

***

## 功能特性

带 🆕 的为本仓库在风雨潇潇版之上新增的功能。

### 👨‍👩‍👧 家长端

| 模块 | 说明 |
|---|---|
| **总览** | 今日加分 / 扣分 / 操作次数、家庭积分排行；树洞信箱、悄悄话、审核都集中在这一页 |
| **任务** | 临时任务（分类、积分奖励、截止时间）+ 🆕 周期任务（每天 / 每周，可「多天只完成一次」；有效期可选长期或指定区间） |
| **积分** | 设置日常加分 / 扣分项目（可限制每日次数），一键为孩子加减分 |
| **审核** | 任务完成、商品 / 现金兑换、心愿单集中审批，审核记录自动保留 |
| **商城** | 商品分类、库存，实物与道具两类，可上下架 |
| **背包** | 网格化查看孩子物品，区分「孩子用的 / 家长送的 / 家长拿走的」，附操作历史 |
| **成长** | 身高体重记录 + 中国儿童生长标准百分位曲线；支持多孩子按年龄对齐对比 |
| **日记** | 图文 / 视频混排，图片并排自适应、拖拽重排、拖边调占比（飞书式） |
| **日历** 🆕 | 日程按参与人归属（家长看全部，孩子看自己 + 兄弟姐妹）；可设重复「特殊日」（每周几 / 每月几号 / 每年几号），当天积分获得翻倍或消耗减半 |
| **记录** | 全部积分流水，按天分组、可按时间段统计（从总览「今日加分 / 扣分」卡片进入） |
| **操作历史** 🆕 | 全家庭操作时间线，家长 / 孩子 / 登录都记；默认近 7 天，可选近 30 天 / 近半年或自定义区间；只增不改不删 |
| **账号** | 多家长账号：主家长可添加子家长，家长与孩子两个身份可在同一浏览器并行登录 |

### 🧒 孩子端

| 模块 | 说明 |
|---|---|
| **主页** | 当前积分余额、生肖头像、等级进度、今日积分、最近记录 |
| **任务** | 领取任务、提交完成，等待家长审核 |
| **商城** | 用积分兑换商品或申请兑换现金，道具直接进背包 |
| **成长 / 日记** | 看自己的成长曲线和自己的成长日记 |
| **日历** 🆕 | 自己的日程 + 兄弟姐妹的日程 |
| **小心思** | 树洞信箱（家庭留言墙）、悄悄话（和家长一对一私聊）、心愿单（许愿 → 家长审核 → 通过后自动上架成商品） |
| **背包** 🆕 | 自己拥有的道具、已使用的、被家长拿走的（含理由与返还积分） |

### ✨ 其他

- 家长用 **账号 + 密码** 登录；孩子用 **账号 + PIN 码** 登录（无需记密码）
- 内置 **12 生肖头像**，响应式设计，手机 / 平板 / 电脑通用
- 积分换现金比例可自定义（默认 10 积分 = 1 元，家长端商城页可改）
- WebSocket 实时更新（家长审核数、孩子的留言即时刷新）
- 图片 / 视频上传按哈希去重，不重复占空间
- 提供 **Android 客户端**（Capacitor）与 **飞牛 fnOS fpk 应用包** 打包脚本

***

## 界面预览

**孩子端 · 首页**

![孩子端 · 首页](docs/screenshots/02-child-home.jpg)

**更多界面**

![界面预览](docs/screenshots/03-preview.jpg)

***

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + Vite + Pinia + Vue Router（富文本用 Tiptap） |
| 后端 | Fastify + better-sqlite3 |
| 数据库 | SQLite（单文件，零配置） |
| 部署 | Docker / Docker Compose |

***

## 快速开始（从源码构建）

### 0. 准备

- Docker 20+ 和 `docker compose` v2（`docker compose version` 能打印版本即可）
- 机器建议 2 核 4G 以上；构建期临时占用约 2～3 GB 磁盘
- 首次构建要联网拉 npm 包，`Dockerfile` 已内置 `registry.npmmirror.com` 加速

### 1. 拿源码

```bash
git clone https://github.com/BoyceLig/ManAlong.git
cd ManAlong
```

也可以在 GitHub 页面点 **Code → Download ZIP** 解压使用。
注意别用上游地址 `gitee.com/wdcasc/growtree` —— 那是原版，构建出来没有本版功能。

### 2. 一条命令构建并启动（推荐）

```bash
bash scripts/docker-build.sh
```

脚本会：读根目录 `VERSION` 当版本号 → `docker build`（**在容器内**装依赖、`vue-tsc` 类型检查 + `vite build`、编译后端，本地无需先 `npm install`）→ 打 `manalong:20261116`（回滚用）和 `manalong:latest` 两个 tag → `docker compose up -d` 并探活 `http://127.0.0.1:3000/`。

Windows 下用 Git Bash 执行；没有 bash 就用等价的两条：

```bash
docker build --build-arg VERSION=$(cat VERSION) -t manalong:latest .
docker compose up -d
```

可选参数：`--save` 额外导出 `manalong-image-<版本>.tar.gz`（拷到别的机器 `docker load` 即可跑，不用在 NAS 上编译）；`--no-up` 只构建不启动。

### 3. 打开

```
http://<这台机器或 NAS 的 IP>:3000
```

### 4. 改密码（强烈建议）

在仓库根目录新建 `.env`（和 `docker-compose.yml` 同目录），然后 `docker compose up -d` 生效：

```
MANALONG_PORT=3000
ADMIN_PASSWORD=改成你的强密码
JWT_SECRET=改成一串随机字符串
```

### 备选：不用 compose，纯 docker 命令

```bash
docker build -t manalong:latest .

docker run -d \
  --name manalong \
  --restart unless-stopped \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=你的强密码 \
  -e JWT_SECRET=你的随机密钥 \
  manalong:latest
```

镜像名必须是本地构建的 `manalong:latest`。

### 本地开发（改代码，不构建镜像）

```bash
npm install
npm run dev
```

- 前端 <http://localhost:5173>（改前端文件保存即热更新）
- 后端 <http://localhost:3001>（改后端 `.ts` 保存自动重启）
- 开发库落在 `data-dev/`，**不碰正式的** `data/`

更细的说明（端口、踩坑、换 Node 版本后 `better-sqlite3` 报错的处理）见
[本地开发上手指南](./2026-11-12/local-dev/outputs/本地开发上手指南.md)。

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

> ⚠️ **别点 App 里的「立即升级」，也别 `docker compose pull`**：默认查询的是上游
> `wdcasc/growtree`，一升级就把部署换成了原版，日历、日记、悄悄话、背包等功能会一起消失（数据还在）。
> 若已把镜像推到自己的私有仓库，可设 `MANALONG_UPDATE_REGISTRY` / `MANALONG_UPDATE_REPO`
> 让「立即升级」指向自己的仓库，见[环境变量](#环境变量)。

***

## 首次登录

首次启动自动创建管理员账号：用户名 `admin`，密码 `admin123`。

登录后按顺序做这几件事（都在右上角 **账号管理** 和各页面里）：

1. 改掉默认密码；需要两位家长一起管，就新增「子家长」
2. 添加孩子账号，设置 **PIN 码**
3. 在 **积分** 里检查 / 调整默认加分、扣分项目
4. 在 **商城** 里添加可兑换商品（顺手建几个分类）
5. 在 **任务** 里发布任务，或在 **日历** 里加日程 / 特殊日

***

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口（容器内） |
| `MANALONG_PORT` | `3000` | 宿主机映射端口（compose 用） |
| `DATA_DIR` | `/app/data` | 数据目录（SQLite 数据库 + 上传文件） |
| `ADMIN_USERNAME` | `admin` | 首次初始化时创建的管理员用户名 |
| `ADMIN_PASSWORD` | `admin123` | 首次初始化时创建的管理员密码 |
| `JWT_SECRET` | `please-change-this-secret-in-production` | 登录令牌签名密钥，**务必修改** |
| `MANALONG_VERSION` | 由 `VERSION` 注入 | 当前版本号，「关于」页展示用 |
| `MANALONG_UPDATE_REGISTRY` | 上游阿里云 ACR | 升级检查用的镜像仓库地址（改这个才能安全用一键升级） |
| `MANALONG_UPDATE_REPO` | `wdcasc/growtree`（上游原版） | 升级检查用的仓库名；**本版必须改成你自己的仓库** |
| `WATCHTOWER_URL` | `http://watchtower:8080` | 一键升级执行器地址，不填则降级为「复制命令自己执行」 |

`ADMIN_USERNAME` / `ADMIN_PASSWORD` **仅在数据库为空（首次启动）时生效**，库里已有家长账号时不会覆盖。

***

## 数据存储与备份

```
data/
├── manalong.db            # 主数据库（旧版 money-jar.db / manban.db 首次启动会自动改名接上）
├── manalong.db-wal        # 预写日志
├── manalong.db-shm        # 共享内存
└── uploads/               # 上传的图片、视频、头像
```

- **备份**：直接复制整个 `data/` 目录（连同 `-wal`、`-shm` 一起复制）
- **恢复**：把备份的 `data/` 放回原处，重启容器

> ⚠️ 不要单独删除 `data/`，否则所有账号、积分、日记、照片都会丢。

***

## 项目结构

```
ManAlong/                         # 仓库根目录
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

***

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
MANALONG_VERSION=20261116 docker compose up -d

# 本地开发
npm run dev
```

***

## 常见问题

### 1. 装完了，功能跟说明对不上（没有 🆕 标记的那些）

多半装成了上游原版镜像。检查：

```bash
docker ps --format '{{.Names}}\t{{.Image}}'
```

`manalong:latest` 才是本仓库构建出来的；是 `crpi-.../wdcasc/growtree` 就按[快速开始](#快速开始从源码构建)重新构建并 `docker compose up -d`。

### 2. 构建失败，提示找不到文件

确认在**仓库根目录**（有 `Dockerfile`、`docker-compose.yml`、`server/`、`web/`）执行命令。
`Dockerfile` 会在容器内编译前端，**不需要**本地先跑 `npm run build` 生成 `web/dist`。

### 3. 端口被占用

```bash
MANALONG_PORT=3100 bash scripts/docker-build.sh     # 换宿主机端口
```

或改 `docker-compose.yml` 里的 `"${MANALONG_PORT:-3000}:3000"`。

### 4. 构建时网络超时（国内环境）

`Dockerfile` 已内置 npmmirror 与 Alpine 中科大源；仍失败通常是网络抖动，重新执行一次即可。
NAS 上构建慢，可先在快的机器上 `bash scripts/docker-build.sh --save`，再把镜像包拷过去 `docker load`。

### 5. 本地开发报 `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED`

换了 Node 大版本，`better-sqlite3` 的原生二进制对不上：

```bash
npm rebuild better-sqlite3
# 若报 gyp 编译错误（没装 VS C++ 编译器），直接删掉重装：
rm -rf node_modules/better-sqlite3 && npm install
```

### 6. 忘记密码

- **子家长忘了**：主家长在「账号管理」里直接改他的密码
- **孩子忘了 PIN**：家长在「账号管理」里重置
- **主家长自己忘了**：`ADMIN_PASSWORD` 只在数据库为空时生效，没有其它找回入口。
  只能先备份 `data/`，删掉 `data/manalong.db` 重新初始化（**会清空数据**），所以务必定时备份。

### 7. 能在外网访问吗？

默认只监听局域网。需要外网就上**内网穿透**或**反向代理 + HTTPS**，**不要**把 3000 端口直接暴露到公网。

***

## 安全建议

1. 改掉默认密码 `admin123`，`JWT_SECRET` 换成随机串（见[首次登录](#首次登录)与[环境变量](#环境变量)）
2. 孩子的 PIN 码不要过于简单
3. 定期备份 `data/` 目录
4. 不要把服务直接暴露到公网

***

## 更新日志与版本号

更新内容见 [CHANGELOG.md](./CHANGELOG.md)，当前版本 **20261116**（以根目录 `VERSION` 为准）。

**版本号 = 发布日期**：`YYYYMMDD`（如 `20261116`），同一天第 2 版起追加 `-序号`（`20261116-2`……）。
仓库根目录的 `VERSION` 文件是**唯一真源**，改版本号只需改这一个文件：

| 位置 | 怎么取版本号 |
|---|---|
| Docker 镜像 tag / compose | `scripts/docker-build.sh` 读 `VERSION`；`MANALONG_VERSION` 注入容器 |
| 网页「关于满伴」页 | 后端 `GET /api/about` 返回容器内的 `MANALONG_VERSION` |
| 安卓 APK | `web/android/app/build.gradle` 直接读 `../../VERSION`；`versionCode = YYYYMMDD × 10 + 序号` |
| 飞牛 fpk / fndepot 包 | `scripts/build-fndepot.sh` 优先读 `VERSION`，读不到才退回 `deploy/fpk/.../manifest` |
| 三个 `package.json` | npm 要求 semver，用等价写法 `YYYY.MM.DD-序号`（如 `2026.11.16`） |

***

## 文档

| 文档 | 用途 |
|---|---|
| [安装说明（给用户）](./安装说明-给用户.md) | 使用者视角的安装、升级与故障排查 |
| [部署教程](./满伴成长树-部署教程.md) | NAS / Docker 部署的图解步骤 |
| [发布指南（手把手）](./发布指南-手把手.md) | 维护者发版流程：镜像、GitHub Release、APK、fpk |
| [首版上线手册](./发布手册-首版上线.md) | 首版上线检查清单 |
| [文档索引](./docs/README.md) | 全部设计文档与方案 |
| [更新日志](./CHANGELOG.md) | 每个版本改了什么 |

功能建议、Bug 反馈、安装求助欢迎进飞书群，提 Bug 时请带上版本号（「关于满伴」页里可见）、
设备和浏览器、复现步骤，有报错就附 `docker compose logs --tail 100` 的输出：

![满伴成长树 · 功能建议与 Bug 反馈飞书群二维码](docs/feishu-group.png)

***

## 作者与联系

| 项 | 内容 |
|---|---|
| 作者 | **BoyceLig** |
| 微信 | `Boyce_Lig`（加好友请备注「满伴」） |
| 仓库 | <https://github.com/BoyceLig/ManAlong> |
| 反馈 | 优先提 [GitHub Issue](https://github.com/BoyceLig/ManAlong/issues)；不方便上 GitHub 也可以微信说 |

功能建议、Bug、部署问题、二次开发与商业授权，都走上面的联系方式。

***

## 许可证

本项目**沿用上游的 BSL 1.1（Business Source License 1.1）** —— **不是传统开源协议**。
版权与署名见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)（含两位上游作者的原始声明）。

| 你是谁 | 能不能免费用 |
|---|---|
| 个人 / 家庭（自托管） | ✅ 永久免费，可复制、修改、分发修改版 |
| 公司 / 组织 / 商业服务 | ❌ 生产环境使用需先购买商业授权 |

- **2029-10-09 起**，本版本自动转为 **GPL-3.0-or-later**，届时按 GPL 条款自由使用
- 第三方版权、字体与 Watchtower 说明见 [NOTICE](./NOTICE)
- 商业授权与定制开发：微信 **`Boyce_Lig`**（备注「满伴商用」），或到 [Issues](https://github.com/BoyceLig/ManAlong/issues) 留言

> BSL 1.1 要求每个修改版保留原许可与署名，所以 LICENSE / NOTICE 里同时保留了风雨潇潇（成长树 · BSL 1.1）
> 和基耶杰（piggy-bank · MIT）的版权声明。这不是遗漏，是许可证义务。

### 致谢上游

本仓库站在两位作者的肩膀上：

| 阶段 | 作品 | 作者 | 许可 | 主要贡献 |
|---|---|---|---|---|
| ① 起点 | [piggy-bank（存钱罐）](https://github.com/ASH-C776/piggy-bank) | 基耶杰 | MIT | 家庭积分 / 任务 / 兑换的雏形与前后端骨架 |
| ② 成长树 | [GrowTree](https://gitee.com/wdcasc/growtree) | 风雨潇潇 | BSL 1.1 | 更名「成长树」、界面重做、生肖头像、成长曲线、多家长账号等 |
| ③ 满伴（本仓库） | [ManAlong](https://github.com/BoyceLig/ManAlong) | BoyceLig | BSL 1.1 | 日历与特殊日、成长日记、背包、树洞 / 悄悄话 / 心愿单、周期任务、操作历史等 🆕 |

```
piggy-bank（基耶杰 · MIT）
      │  改名「成长树」、重做界面、扩展功能
      ▼
GrowTree（风雨潇潇 · BSL 1.1）
      │  ← 本仓库接手，新增 🆕 标记的功能
      ▼
ManAlong（BoyceLig · BSL 1.1）
```

**许可如何衔接**：piggy-bank 以 MIT 发布 → 保留版权与许可声明（见 NOTICE），修改版可继续分发；
成长树以 BSL 1.1 发布 → 修改版继续以 BSL 1.1 发布，保留原署名与 Change Date；
本仓库新增的代码同样落在 BSL 1.1 下：个人 / 家庭免费，商业生产环境需授权。

感谢两位前作者 —— 想支持他们，欢迎去上面的原始仓库点个 Star。