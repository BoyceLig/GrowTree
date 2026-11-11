<div align="center">

<img src="docs/growtree-logo.png" width="140" alt="成长树 GrowTree"/>

# 🌳 成长树 · GrowTree

**让好习惯，像小树一样慢慢长大。**

</div>

> 一个面向家庭的自托管积分管理系统 —— 让孩子在完成任务、赚取积分、兑换奖励的过程中，学会规划与成长。

**怎么玩**：孩子完成日常任务，或家长发布的临时任务 → 获得积分 → 用积分在商店兑换商品或现金；
所有申请由家长审核把关。数据全部保存在本机（SQLite 单文件），**不上传任何云端**。

[功能特性](#功能特性) · [界面预览](#界面预览) · [快速开始](#快速开始docker-部署) · [常见问题](#常见问题) · [更新日志](#更新日志)

---

## 功能特性

### 👨‍👩‍👧 家长端
| 模块 | 说明 |
|---|---|
| **总览** | 查看所有孩子的积分、今日积分变化、待审核数量 |
| **积分** | 设置日常加分/扣分项目（可限制每日次数），一键为孩子加减分 |
| **任务** | 发布临时任务（含分类、积分奖励、截止时间） |
| **审核** | 审批孩子提交的任务完成申请、商品/现金兑换申请 |
| **商店** | 管理可兑换的商品（名称、所需积分、库存） |
| **记录** | 查看全部积分流水明细与操作人 |
| **成长** | 记录身高体重，成长曲线对照中国儿童生长标准看百分位；支持多孩子按年龄对齐对比 |

### 🧒 孩子端
| 模块 | 说明 |
|---|---|
| **首页** | 查看自己的积分余额、生肖头像、等级进度 |
| **任务** | 领取任务、提交完成，等待家长审核 |
| **商店** | 用积分兑换商品，或申请兑换现金 |

### ✨ 其他
- 家长用 **账号 + 密码** 登录；孩子用 **账号 + PIN 码** 登录（无需记密码）
- 内置 **12 生肖头像**
- 响应式设计，手机 / 平板 / 电脑均可使用
- 支持积分兑换比例自定义（如 10 积分 = 1 元）
- 支持 WebSocket 实时更新（家长端审核数即时刷新）
- **一键升级**：发布新版本后，用户端自动出现「发现新版本」提示条，点一下就完成升级
- 提供 **飞牛 fnOS fpk 应用包**：应用中心手动安装，数据由系统托管、升级不丢
- 提供 **Android 客户端**（Capacitor 打包），手机原生体验

---

## 界面预览

**孩子端**

<p align="center">
  <img src="docs/screenshots/02-child-home.jpg" width="250" alt="孩子端 · 首页">
  &nbsp;&nbsp;
  <img src="docs/screenshots/01-child-shop.jpg" width="250" alt="孩子端 · 商店">
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
| 前端 | Vue 3 + Vite + Pinia + Vue Router |
| 后端 | Fastify + better-sqlite3 |
| 数据库 | SQLite（单文件，零配置） |
| 部署 | Docker / Docker Compose |

---

## 快速开始（Docker 部署）

### 方式一：直接用云端镜像（给使用者，推荐）

什么都不用编译，两条命令跑起来：

```bash
cp deploy/compose/.env.example .env   # 改一下 ADMIN_PASSWORD / JWT_SECRET
docker compose -f deploy/compose/docker-compose.yml up -d
```

镜像在阿里云容器镜像服务上公开托管，**x86（amd64）和 ARM64 机型自动匹配**，国内直连。
这套 compose 里还带了一个 `watchtower` 小容器 —— 以后你发布新版本，
用户端会**自动弹出「发现新版本」提示条，点一下就能升级**，全程不用碰命令行。

详细说明见 [安装说明-给用户.md](./安装说明-给用户.md)。

### 方式二：本地源码构建（给维护者）

```bash
# 一条命令：构建带版本号的镜像 + 启动 + 探活
bash scripts/docker-build.sh
# 可选：同时导出镜像包（拷到别的机器 docker load 即用，免编译）
bash scripts/docker-build.sh --save
```

发布到镜像仓库（双架构合并）：

```bash
# 版本号取仓库根目录 VERSION（规则：发布日期 YYYYMMDD，同日第 2 版起加 -2、-3…）
bash scripts/push-acr.sh crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com/wdcasc/growtree
```

### 方式三：Docker Compose（源码构建）

```bash
# 首次（本地没有镜像时）构建并启动
docker compose up -d --build

# 之后日常启动（镜像已存在，不会重新编译）
docker compose up -d
```

启动后浏览器访问：

```
http://<你的NAS或服务器IP>:3000
```

### 方式四：Docker 命令（最简，无一键升级）

```bash
docker run -d \
  --name growtree \
  --restart unless-stopped \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=你的强密码 \
  -e JWT_SECRET=你的随机密钥 \
  crpi-q6m49k4ufbvik9l5.cn-hangzhou.personal.cr.aliyuncs.com/wdcasc/growtree:latest
```

这种方式没有 watchtower，App 发现新版后会提示手动执行 `docker pull` + 重建容器。

### 方式五：本地开发

```bash
# 安装依赖
npm install

# 同时启动前后端（开发模式）
npm run dev
# 前端: http://localhost:5173
# 后端: http://localhost:3000
```

---

## 首次登录

系统首次启动时会自动创建管理员账号：

| 项目 | 默认值 |
|---|---|
| 用户名 | `admin` |
| 密码 | `admin123` |

> ⚠️ **请登录后立即修改密码**（家长端 → 设置）。
> 默认密码是公开的，不改会有安全风险。

登录后：
1. 在 **家长端** 添加孩子账号，设置孩子的 **PIN 码**
2. 在 **积分** 里检查/调整默认的加分、扣分项目
3. 在 **商店** 里添加可兑换的商品
4. 在 **任务** 里发布任务
5. 孩子即可用自己的账号 + PIN 登录使用

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口 |
| `DATA_DIR` | `/app/data` | 数据目录（SQLite 数据库存放位置） |
| `ADMIN_USERNAME` | `admin` | 首次初始化时创建的管理员用户名 |
| `ADMIN_PASSWORD` | `admin123` | 首次初始化时创建的管理员密码 |
| `JWT_SECRET` | `please-change-this-secret` | 登录令牌签名密钥，**务必修改** |

> ℹ️ `ADMIN_USERNAME` / `ADMIN_PASSWORD` **仅在数据库为空（首次启动）时生效**。
> 如果数据库中已存在家长账号，这两个变量不会覆盖已有账号。

### 修改配置

推荐用 `.env` 文件（`docker-compose.yml` 同目录）：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=改成你的强密码
JWT_SECRET=改成一串随机字符串
```

然后重新执行 `docker compose up -d`。

---

## 数据存储与备份

所有数据保存在 `data/` 目录下的 SQLite 数据库：

```
data/
├── money-jar.db         # 主数据库
├── money-jar.db-wal     # 预写日志
└── money-jar.db-shm     # 共享内存
```

**备份**：直接复制整个 `data/` 目录即可（建议连同 `-wal`、`-shm` 一起复制）。

**恢复**：把备份的 `data/` 目录放回原位，重启容器。

> ⚠️ 不要单独删除 `data/` 目录，否则所有账号和积分记录都会丢失。

---

## 项目结构

```
growtree-server/
├── Dockerfile
├── docker-compose.yml
├── package.json                  # 工作区根配置
├── server/                       # 后端
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # 入口
│       ├── config.ts             # 配置
│       ├── auth.ts               # 鉴权（JWT + bcrypt）
│       ├── middleware.ts
│       ├── ws.ts                 # WebSocket
│       ├── db/
│       │   ├── index.ts          # 数据库初始化与迁移
│       │   └── schema.sql        # 表结构
│       └── routes/               # 接口路由
└── web/                          # 前端
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    ├── dist/                     # 预构建产物（Docker 部署直接使用）
    └── src/
        ├── main.ts
        ├── App.vue
        ├── api/                  # 接口封装
        ├── components/           # 通用组件
        ├── router/               # 路由
        ├── stores/               # Pinia 状态
        ├── styles/
        ├── utils/
        └── views/
            ├── Login.vue
            ├── parent/           # 家长端页面
            └── child/            # 孩子端页面
```

---

## 常用命令

```bash
# 启动 / 停止 / 重启
docker compose up -d
docker compose stop
docker compose restart

# 重新构建（代码更新后）
docker compose up -d --build

# 停止并删除容器（数据保留）
docker compose down

# 查看日志
docker compose logs -f
```

---

## 常见问题

### 1. 构建失败，提示找不到文件

确认在**包含 `docker-compose.yml` 的目录**下执行命令，且该目录下有 `Dockerfile`、`server/`、`web/`。

> 仓库只含源码、不含构建产物 `web/dist/`，自行构建镜像前先在根目录执行一次
> `npm install` 和 `npm run build`（生成 `web/dist` 与 `server/dist`）再 `docker build`。

### 2. 端口被占用

修改 `docker-compose.yml`：

```yaml
ports:
  - "3100:3000"      # 把左边的 3000 改成其它端口
```

保存后执行 `docker compose up -d --build`，再访问新端口。

### 3. 构建时网络超时（国内环境）

`Dockerfile` 已内置国内镜像源配置（`registry.npmmirror.com`），正常情况下无需处理。
若仍失败，通常是网络波动，重新执行一次构建即可。

### 4. 忘记密码

删除 `data/money-jar.db` 会重置所有数据（**慎用**）。
`ADMIN_USERNAME` / `ADMIN_PASSWORD` 环境变量只在数据库为空时生效。

### 5. 能在外网访问吗？

默认只监听局域网。若要外网访问，建议使用 **内网穿透** 或 **反向代理 + HTTPS**，
**不要**直接把 3000 端口暴露到公网。

---

## 安全建议

1. **务必修改默认密码** `admin123`
2. **务必修改 `JWT_SECRET`**，使用随机字符串
3. 孩子的 PIN 码不要设置得过于简单
4. 定期备份 `data/` 目录
5. 不要将服务直接暴露到公网

---

## 更新日志

完整变更记录见 [CHANGELOG.md](./CHANGELOG.md)。当前版本 **20261016**（2026-10-16）：

- **加分按提交时间记账**（20261016）：家长审核通过后，加分记在孩子**提交申请**的那一天，
  不再算在审核那天；隔几天补审也不会记错日期，积分流水按天分组与首页「今日获得」同步按提交日归位
  （兑换扣分保持不变，仍按审核通过那天）
- **升级诊断**（20261015-1）：升级出问题时弹窗直接说明具体原因（云端镜像未同步 / 容器缺少升级标记 /
  拉取失败），并给出可复制的命令；「几秒就提示完成其实没升级」的假成功会被识别并如实提示
- **安装说明**（20261015-1）：新增「点了升级没反应怎么查」，含日志判断方法与急救命令
- **查看更新**（20261015）：更新提示条新增「查看更新」，点一下就能看新版本改了什么；
  新版本的说明还没进当前镜像，是从代码仓库公开读取的，拉不到时降级显示已安装版本的记录
- **任务排序**（20261015）：孩子端改为「点两下换位置」，比长按拖拽更好按，不会再乱跳
- **版本号统一**（20261015）：版本号全部改用发布日期（如 `20261015`），网页、安卓、飞牛包三处一致
- **超时任务展示**（20261010-5）：当天仍可见并标「已超时」但不能领/交，跨天整体收走
- **积分流水**（20261010-5）：按天分组带每人当天加/减分合计、可选时间段统计、「更多」每次翻 50 天
- **一键升级**（20261010）：应用内自动发现新版本（匿名查阿里云镜像仓库版本列表）+ 点击即升级
  （compose 内置 watchtower 执行拉取重建），无 watchtower 时优雅降级为可复制的命令；
  watchtower 以标签限定**只监控本应用**，且不点按钮不会有任何自动动作
- **关于页**（20261010-2）：版本号 + 更新内容 + 作者与许可一页看全
- **品牌升级**（20261009）：项目更名为「成长树 GrowTree」，全新 LOGO 与应用图标（网页/安卓/飞牛端全套替换）
- **Docker 镜像版交付**（20261009）：新增 `scripts/docker-build.sh` 等一键脚本，构建带版本号镜像、导出/导入镜像包、一条命令回滚
- **许可证变更**：MIT → **BSL 1.1**（个人/家庭永久免费，公司商用需购买授权；2029-10-09 起自动转 GPL-3.0 开源）
- 数据文件名保持 `money-jar.db` 不变，从存钱罐/旧版升级**无需迁移数据**

---

## 版本号规则

**版本号 = 发布日期**：`YYYYMMDD`（如 `20261010`）；同一天发布第 2 版起追加 `-序号`
（`20261010-2`、`20261010-3`……第 1 版不带后缀）。这样用户看到的版本号本身就带时间信息，
不会出现「版本 2.3.0 是几号发的」这种要对 CHANGELOG 的情况。

仓库根目录的 **`VERSION` 文件是唯一真源**，各处都从它取；改版本号只需改这一个文件
（`node_modules` 之外没有第二处需要同步）：

| 位置 | 怎么取版本号 |
| --- | --- |
| Docker 镜像 tag / compose | `scripts/docker-build.sh` 读 `VERSION`；`PIGGY_VERSION` 环境变量注入容器 |
| 网页「关于成长树」页 | 后端 `GET /api/about` 返回容器内的 `PIGGY_VERSION` |
| 安卓 APK | `web/android/app/build.gradle` 直接读 `../../VERSION`；`versionCode = YYYYMMDD × 10 + 序号` |
| 飞牛 fpk / fndepot 包 | `scripts/build-fndepot.sh` 优先读 `VERSION`，读不到才退回 `deploy/fpk/.../manifest` |
| 三个 `package.json` | npm 要求 semver，用等价写法 `YYYY.MM.DD-序号`（如 `2026.10.10-5`） |

---

## 许可证

本项目采用 **BSL 1.1（Business Source License 1.1）** 发布 —— **不是传统开源协议**：

| 你是谁 | 能不能免费用 |
|---|---|
| 个人 / 家庭（自托管） | ✅ 永久免费，可复制、修改、分发修改版 |
| 公司 / 组织 / 商业服务 | ❌ 生产环境使用需先购买商业授权 |

- **2029-10-09 起**，本版本将自动转为 **GPL-3.0-or-later** 开源，届时按 GPL 条款自由使用
- 完整条款见 [LICENSE](./LICENSE)，第三方版权与字体说明见 [NOTICE](./NOTICE)
- 商业授权与定制开发联系：**微信：wdcasc**

### 致谢上游

本项目基于开源项目 [piggy-bank（基耶杰）](https://github.com/ASH-C776/piggy-bank)（MIT）发展而来，
依 MIT 许可证要求在 [NOTICE](./NOTICE) 中保留其原始版权声明，感谢优秀的前作。
