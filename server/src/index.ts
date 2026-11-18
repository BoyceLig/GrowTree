import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { Server } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { config, ensureDataDir } from './config.js';
import { initDb } from './db/index.js';
import { registerAuthHook } from './middleware.js';
import { initWs } from './ws.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerParentRoutes } from './routes/parents.js';
import { registerChildrenRoutes } from './routes/children.js';
import { registerPointItemsRoutes } from './routes/point-items.js';
import { registerPointLogsRoutes } from './routes/point-logs.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerAdhocTasksRoutes } from './routes/adhoc-tasks.js';
import { registerRecurringTasksRoutes } from './routes/recurring-tasks.js';
import { registerProductsRoutes } from './routes/products.js';
import { registerProductCategoriesRoutes } from './routes/product-categories.js';
import { registerExchangeRequestsRoutes } from './routes/exchange-requests.js';
import { registerBackpackRoutes } from './routes/backpacks.js';
import { registerWishItemsRoutes } from './routes/wish-items.js';
import { registerWishRequestRoutes } from './routes/wish-requests.js';
import { registerGrowthRoutes } from './routes/growth.js';
import { registerDiaryRoutes } from './routes/diaries.js';
import { registerMailboxRoutes } from './routes/mailbox.js';
import { registerUploadRoutes, sweepOrphanUploads } from './routes/upload.js';
import { registerUpdateRoutes } from './routes/update.js';
import { registerAboutRoutes } from './routes/about.js';
import { registerHealthRoutes } from './routes/health.js';

/**
 * 可选扩展模块的接口形状。
 * 四个阶段按顺序被调用，全部可选：
 *   beforeInit → 初始化数据库之前（设置环境开关等）
 *   migrate    → 基础 schema 与通用迁移之后，拿原始句柄做扩展自己的表结构/数据
 *   hooks      → 建好 app、注册任何路由之前（挂请求级钩子）
 *   routes     → 路由注册阶段的最后一步
 */
type Extension = {
  beforeInit?: () => void;
  migrate?: (db: unknown) => void;
  hooks?: (app: unknown) => void;
  routes?: (api: unknown) => void;
};

/**
 * 加载可选扩展模块（约定放在编译产物同级的 ext/ 目录，存在就挂载）。
 *
 * ⚠️ 必须用**运行时探测**而不是静态 import：扩展目录在某些发布形态里不存在，
 * 静态 import 会让那份代码直接编译失败。探测不到就当没有扩展，四个阶段全部跳过。
 */
function loadExtension(): Extension | null {
  const entry = path.join(__dirname, 'ext', 'index.js');
  if (!existsSync(entry)) {
    console.log('[ext] 未加载扩展模块');
    return null;
  }
  console.log('[ext] 已加载扩展模块');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(entry) as Extension;
}

async function main() {
  const ext = loadExtension();
  // 必须早于 initDb：扩展常需要在这里设置环境开关
  ext?.beforeInit?.();

  ensureDataDir();
  const db = initDb(config.dataDir);

  // 扩展迁移在基础 schema 与通用迁移之后跑，拿到的是未经装饰的原始句柄
  ext?.migrate?.(db);

  const app = Fastify({ logger: process.env.NODE_ENV !== 'production' });
  const httpServer = app.server as unknown as Server;

  registerAuthHook(app);
  // 必须在任何路由注册之前：它靠 onRoute 包裹每个 handler
  ext?.hooks?.(app);

  await app.register(cors, {
    // 允许移动端 App（WebView 来源）访问 API；家庭内网工具，反射任意来源以兼容不同 WebView scheme
    origin: true,
  });

  // 日记媒体走 multipart 流式上传（视频几十上百 MB，base64 会卡死浏览器主线程）
  await app.register(multipart, {
    limits: {
      fileSize: 512 * 1024 * 1024,
      files: 1,
      fields: 4,
    },
  });

  await app.register(async (api) => {
    registerHealthRoutes(api);
    registerAuthRoutes(api);
    registerParentRoutes(api);
    registerChildrenRoutes(api);
    registerPointItemsRoutes(api);
    registerPointLogsRoutes(api);
    registerDashboardRoutes(api);
    registerAdhocTasksRoutes(api);
    registerRecurringTasksRoutes(api);
    registerProductsRoutes(api);
    registerProductCategoriesRoutes(api);
    registerExchangeRequestsRoutes(api);
    registerBackpackRoutes(api);
    registerWishItemsRoutes(api);
    registerWishRequestRoutes(api);
    registerGrowthRoutes(api);
    registerDiaryRoutes(api);
    registerMailboxRoutes(api);
    registerUploadRoutes(api);
    registerUpdateRoutes(api);
    registerAboutRoutes(api);
    ext?.routes?.(api);
  }, { prefix: '/api' });

  // 商品自定义图片：从数据目录的 uploads/ 下静态服务（Docker 挂 data 卷即持久化）
  mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
  await app.register(fastifyStatic, {
    root: path.join(config.dataDir, 'uploads'),
    prefix: '/uploads/',
    decorateReply: false, // 第二次注册 @fastify/static 不能再装饰 reply.sendFile
  });

  if (existsSync(config.webDist)) {
    // 必须保持 wildcard 默认为 true：通配路由在请求时实时从磁盘读取文件，
    // vite 重新构建后的新 hash 文件无需重启即可服务。
    // 不能用 wildcard:false——该模式仅在启动时 glob 一次文件并注册路由，
    // 构建后的新文件会 404 并回退到 index.html，导致 JS 以 text/html 返回、浏览器白屏。
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      // ── 缓存策略 ────────────────────────────────────────────────────────
      // 此前没配 setHeaders，所有静态资源都落到默认的 `public, max-age=0`：
      // 每次导航、每个资源都要发一次条件请求换 304。局域网 RTT 极小无感，
      // 但 4G 远端访问（App 里填了远端服务器）时几十个并发 revalidate 会明显拖慢首屏。
      // 三档策略的依据是"文件名里有没有内容指纹"：
      setHeaders(res, filePath) {
        // 用相对 root 的路径判断，而不是绝对路径的 includes —— 否则项目路径里
        // 一旦出现 assets/fonts 这样的目录名就会误判。
        const rel = path.relative(config.webDist, filePath).replace(/\\/g, '/');

        if (rel.endsWith('.html')) {
          // index.html 是唯一"名字不变但内容会变"的入口文件，必须每次校验。
          // 一旦给它长缓存：发版后用户拿到旧 html，里面引用的旧 hash chunk
          // 已在服务器上被删除 → 404 → 白屏（本项目踩过一次，极难定位）。
          res.setHeader('Cache-Control', 'no-cache');
        } else if (rel.startsWith('assets/')) {
          // vite 产出的文件名内嵌内容 hash：内容一变文件名就变，可放心永久缓存。
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (rel.startsWith('fonts/')) {
          // 字体是手动放在 public/ 里的，文件名稳定、不带 hash，而单个就有 838KB。
          // 给 7 天并靠 ETag 兜底：既避免重复下载，换字体后也能在一周内自然更新。
          res.setHeader('Cache-Control', 'public, max-age=604800');
        }
        // 其余（图标等）不设，保持框架默认行为。
      },
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url === '/ws') {
        return reply.code(404).send({ error: 'not_found' });
      }
      // 静态资源（js/css/图片/字体等）找不到时必须返回 404，
      // 绝不能兜底成 index.html——否则浏览器会把 HTML 当 JS/CSS 解析，
      // 报 SyntaxError 导致整站白屏，且极难定位。
      const pathname = req.url.split('?')[0];
      if (/\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|json|txt)$/i.test(pathname)) {
        return reply.code(404).send({ error: 'asset_not_found', path: pathname });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      message: 'Money Jar API',
      hint: '前端未构建，请先运行 npm run build --workspace web',
    }));
  }

  initWs(httpServer);

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`🪙 Money Jar running on http://0.0.0.0:${config.port}`);
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }

  // 孤儿上传文件清扫：启动后延迟 1 分钟跑一次，之后每天一次。
  // 覆盖「上传了但没保存进任何数据」的文件（草稿丢弃、编辑中删掉后没保存），
  // 只删无人引用且超过保留期（3 天）的，不会误伤正在用的图片/视频。
  const sweep = () => {
    try {
      sweepOrphanUploads();
    } catch (e: any) {
      console.warn('[uploads] 清扫孤儿文件失败:', e?.message || e);
    }
  };
  setTimeout(sweep, 60_000).unref?.();
  setInterval(sweep, 24 * 3600 * 1000).unref?.();
}

main();
