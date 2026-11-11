# 成长树 · Docker 镜像版交付说明

> 目标：**不再每次都在 NAS 上跑 `docker compose up -d --build` 硬编译**。
> 改成「构建一次镜像 → 打版本 tag → 之后一律用本地镜像启动」，
> 需要迁移到别的机器时把镜像导出成一个文件，`docker load` 进去即可，完全不用编译。

---

## 0. 这次新增了什么

| 文件 | 作用 |
|---|---|
| `VERSION` | 当前版本号（如 `20261009`），镜像 tag 的默认来源 |
| `scripts/docker-build.sh` | **一键构建**：build → 打双 tag（版本号 + latest）→ 可选导出镜像包 → 启动并探活 |
| `scripts/docker-load.sh` | 导入镜像包（`.tar` / `.tar.gz`）并启动，自动识别版本 tag |
| `scripts/docker-up.sh` | 按版本号启动 / 切版本 / **回滚**（只跑本地镜像，绝不编译） |
| `Dockerfile` | 加 `VERSION` 构建参数 + OCI 标签 + 健康检查（node 自带 fetch，不装 curl） |
| `docker-compose.yml` | `image: growtree:${PIGGY_VERSION:-latest}` + 保留 build 兜底 + 健康检查 + 日志轮转 |
| `.dockerignore` | 剔除 `web/src`、`docs`、`scripts`、备份数据等，构建上下文更小更快 |

镜像命名规则：`growtree:<版本号>`（如 `growtree:20261010`），同时再打一个 `growtree:latest` 供 compose 默认使用。

---

## 0.5 一键升级（2026-10-10 新增）

### 用户侧长什么样

家长登录后，只要仓库里出现了比当前更高的版本号，顶栏下方会自动浮出一条
**「🌳 发现新版本 v20261010 ｜ 立即升级」**。点一下 → 后端通知同 compose 内的
watchtower → 拉新镜像 → 重建容器 → 前端轮询到新版本起来后自动刷新。全程数据在
`data/` 卷里，不受影响。

也可以用「设置 → 版本更新 → 检查更新」手动触发（绕过 10 分钟缓存）。

### 整条链路

```
浏览器 ──GET /api/update/status──► growtree 后端
                                     │ ① 匿名查 ACR 的 OCI tags 接口（无需任何密钥）
                                     │    比对 process.env.PIGGY_VERSION 与最大版本 tag
                                     ▼
                                  hasUpdate / canAutoUpdate / manualCommand

点「立即升级」 ──POST /api/update/apply──► 后端
                                     │ ② 先 1.5s 快速探活（GET /，无副作用路径）
                                     │ ③ POST http://watchtower:8080/v1/update（Bearer token）
                                     ▼
                                 watchtower ── 拉镜像 + 停旧容器 + 重建（只动带标签的那个）
```

关键设计取舍：

| 决定 | 原因 |
|---|---|
| 查版本走**匿名** OCI 接口 | 仓库是公开的，客户端不需要任何账号密码；也不依赖 GitHub / Gitee |
| realm / service **动态解析**自 `WWW-Authenticate` | 阿里云换域名也不会失效；同时兼容不要求鉴权的自建 registry |
| watchtower 用 `WATCHTOWER_LABEL_ENABLE=true` + 容器标签 | **只监控 growtree 自己**，绝不碰用户 NAS 上的其它服务 |
| 开 HTTP API 后**不**加 `--http-api-periodic-polls` | 该模式下定时轮询默认关闭，不点按钮不会有任何自动动作 |
| apply 超时给到 **120 秒** | watchtower 的 `/v1/update` 是同步接口，NAS 上停容器+重建实测 31 秒；给 15 秒会误报失败 |
| 前端点完 **3 秒就开始轮询**，不傻等 apply 返回 | 升级会重启本容器，飞行中的 HTTP 请求会被掐断 —— 这不是失败，是成功的典型现象 |
| 探活用 `GET /` 而不是 `/v1/update` | 必须用**无副作用**的路径，否则探活本身就会触发一次更新 |

### 升版本时维护者要做什么

```bash
printf '20261011' > VERSION
npm run build --workspace web && npm run build --workspace server
bash scripts/docker-build.sh --no-up                 # 出 arm64 + amd64 两个镜像
VERSION=20261011 bash scripts/push-acr.sh crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com/wdcasc/growtree
```

推送完 `:20261011` 与 `:latest` 就完事 —— **用户端下次打开页面就会自己看到升级提示**。

### watchtower 为什么要自己搬运一份

watchtower 官方镜像在 Docker Hub 上，国内（尤其 NAS 环境）拉不动。
`scripts/push-watchtower.sh` 会把维护中的 `nickfedor/watchtower` 按 manifest 摘要
分架构拉下来，再推到同一个阿里云仓库，用户 `docker compose up -d` 时国内可直连。

> 许可提醒：watchtower 是 **Apache-2.0**，此处属于**原样再分发**，
> 不受本项目 BSL 1.1 约束，署名见 `NOTICE` 第 4 节。

---

## 1. 首次构建（在 NAS 上，一条命令）

```bash
cd /volume1/Docker_data/growtree/src
cp -r data data-backup-$(date +%Y%m%d)              # 先备份数据，养成习惯
tar xzf /volume1/Docker_data/growtree/growtree-update-20261009.tar.gz -C /volume1/Docker_data/growtree/src
cd /volume1/Docker_data/growtree/src && bash scripts/docker-build.sh
```

脚本会依次做：检查 `web/dist` 完整 → `docker build`（打两个 tag）→ `docker compose up -d` → 轮询探活到 200 才退出。
第一次构建要下载依赖、编译 native 模块，**约 3～10 分钟**（Dockerfile 里已换中科大 apk 源 + npmmirror，比默认源快很多）。

常用参数：

```bash
bash scripts/docker-build.sh --save      # 构建后额外导出 growtree-image-<版本>.tar.gz
bash scripts/docker-build.sh --no-up     # 只构建镜像，不启动容器
PIGGY_VERSION=20261009 bash scripts/docker-build.sh   # 手动指定版本号
```

---

## 2. 日常更新（以后都走这条）

拿到新的源码包后：

```bash
cd /volume1/Docker_data/growtree/src
cp -r data data-backup-$(date +%Y%m%d)
tar xzf /volume1/Docker_data/growtree/growtree-update-<新日期>.tar.gz -C /volume1/Docker_data/growtree/src
bash scripts/docker-build.sh
```

因为 npm 依赖层没变，第二次起构建通常只要 **1～2 分钟**（前端 dist 是本地复用、镜像内不重编）。
新镜像构建完直接替换容器，旧版本镜像仍在本地，随时可回滚。

---

## 3. 导出镜像 + 换机器免编译部署

适合：把成长树搬到另一台 NAS / 给别人装 / 网络很差的机器。

**A 机器导出：**

```bash
bash scripts/docker-build.sh --save
# 产物：/volume1/Docker_data/growtree/growtree-image-20261009.tar.gz（约 200～400 MB）
```

**B 机器导入（不需要源码、不需要编译、不联网也行）：**

```bash
tar xzf growtree-update-20261009.tar.gz -C /volume1/Docker_data/growtree/src   # 只要 docker-compose.yml + scripts
cd /volume1/Docker_data/growtree/src
bash scripts/docker-load.sh /volume1/Docker_data/growtree/growtree-image-20261009.tar.gz
```

脚本会自动从 `Loaded image: growtree:20261009` 里认出版本号，把它设为运行版本并启动。
（只想要 compose 文件也行，手工 `docker load -i 镜像包 && docker compose up -d` 同样生效。）

---

## 4. 回滚

程序回滚一条命令，**数据不动**（数据库迁移都是加列加表，旧版本一般也能读）：

```bash
docker images growtree                 # 看看本地有哪些版本
bash scripts/docker-up.sh 20261008       # 切回上一个版本
```

等价写法：`PIGGY_VERSION=20261008 docker compose up -d`

> 注意：回滚只回程序。如果新版本做过「结构破坏性」变更（本项目目前没有），才需要连 `data` 一起从备份恢复。

---

## 5. 数据与镜像的日常维护

```bash
cd /volume1/Docker_data/growtree/src

docker compose logs --tail 100 -f        # 看日志
docker ps                                # 看状态（healthy 表示健康检查通过）
cp -r data data-backup-$(date +%Y%m%d)   # 备份数据（数据库 + 上传的图片都在这）
docker image prune -f                    # 清理 <none> 悬空镜像，省空间
docker image rm growtree:20260927      # 删掉确定不要的旧版本
```

建议只保留最近 2～3 个版本镜像，够回滚即可。

---

## 6. 常见问题

**Q：怎么确认跑的是镜像而不是现场编译的？**
`docker ps` 里 IMAGE 列显示 `growtree:20261009` 就是镜像；启动耗时几秒（而不是几分钟）也说明没编译。

**Q：`docker compose up -d` 会不会又编译一遍？**
不会。compose 只有在**本地找不到 `growtree:<版本>` 镜像时**才走 build。日常更新请用 `scripts/docker-build.sh`（它先 build 再 up），或 `docker-up.sh`（直接用已有镜像）。

**Q：健康检查一直 unhealthy？**
容器里跑的是 `fetch('http://127.0.0.1:3000/')`。若改过 `PORT` 环境变量，compose 里的 `PORT: 3000` 要同步改；数据目录挂载不上导致服务没起来也会 unhealthy，先看 `docker compose logs`。

**Q：端口 3000 被占用？**
`PIGGY_PORT=3100 bash scripts/docker-up.sh`，之后访问 `http://NAS的IP:3100`。

**Q：构建卡在下载？**
Dockerfile 已把 apk 源换成中科大、npm 换成 npmmirror。仍失败就重跑一次脚本（构建缓存会保留已完成的层）。

**Q：为什么不在我电脑上直接把镜像做好？**
做镜像必须有 Docker 运行环境，开发机上没有（docker / podman / colima 都没装），所以镜像只能在你 NAS 上出——脚本已经把这件事压成一条命令了。

---

## 7. 本地（Mac）构建实战笔记（2026-10-09 实测）

- 本机原本没 Docker，装 **OrbStack**（`https://orbstack.dev/download/stable/latest/arm64`）即可，
  无需交互：挂载 dmg → 拷进 `/Applications` → `open -a OrbStack` 后 docker 直接就绪，
  命令行需要 `export PATH="$HOME/.orbstack/bin:$PATH"`
- **buildx 被系统限制时会报** `failed to update builder last activity time: ... operation not permitted`
  → 改用传统 builder：`DOCKER_BUILDKIT=0 docker build ...`（本项目可正常构建）
- **docker.io 拉不动**（Bad Gateway）→ 手动用国内镜像站拉基础镜像再打同名 tag（见《发布指南-手把手.md》第 1 步）
- 导出：`docker save growtree:<版本> | gzip -1 > growtree-image-<版本>.tar.gz`（本次 63MB）
- 验证：导入后 `docker run -p 3101:3000` 起容器，访问首页出现「成长树 · GrowTree」、
  健康检查 `healthy` 即为成功
- **架构**：本机出的是 arm64；x86 NAS 请在 NAS 本机构建，或走 GitHub Actions 出 amd64
