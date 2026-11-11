import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './auth.js';
import type { JwtPayload } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    // 直接复用 JwtPayload：以前这里是一份手抄的内联类型，
    // 给 token 加字段（比如 act 代看标记）时两边会悄悄对不上
    user?: JwtPayload;
  }
}

const PUBLIC_PATHS = new Set([
  '/api/auth/parent-login',
  '/api/auth/child-login',
  '/api/auth/children',
  // 探活：部署脚本与反向代理在鉴权之前就要能打它
  '/api/health',
]);

/**
 * 扩展注册的免鉴权路径（可选扩展点）。默认空集，行为与没有这个功能一样。
 *
 * 为什么要有它：扩展可能会引入自己的登录入口（那些接口在拿到 token 之前
 * 就必须可访问）。把具体路径写死在上面那个 PUBLIC_PATHS 里也能跑，
 * 但那是把扩展的设计搬进共享层 —— 而共享层是要公开发布的。
 *
 * 以 `/` 结尾的条目按**前缀**匹配（`/api/admin/` 覆盖它下面所有接口）。
 * 逐个列路径在接口一多时必然漏，而漏掉的那个就是「本该有权限校验却没有」。
 */
const EXTRA_PUBLIC_EXACT = new Set<string>();
const EXTRA_PUBLIC_PREFIX: string[] = [];

export function registerPublicPaths(paths: Iterable<string>): void {
  for (const raw of paths) {
    const p = raw.split('?')[0];
    if (p.endsWith('/')) {
      if (!EXTRA_PUBLIC_PREFIX.includes(p)) EXTRA_PUBLIC_PREFIX.push(p);
    } else {
      EXTRA_PUBLIC_EXACT.add(p);
    }
  }
}

function isExtraPublic(path: string): boolean {
  if (EXTRA_PUBLIC_EXACT.has(path)) return true;
  for (const prefix of EXTRA_PUBLIC_PREFIX) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

export function registerAuthHook(app: FastifyInstance) {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url;
    if (url === '/' || url.startsWith('/ws') || url.startsWith('/assets/') || url.startsWith('/zodiac/')) {
      return;
    }
    if (!url.startsWith('/api/')) return;

    // CORS 预检请求不带 Authorization，必须放行交给 @fastify/cors 处理，
    // 否则跨端(App WebView)所有需登录接口的预检都会被 401，表现为"登录成功但没数据"
    if (req.method === 'OPTIONS') return;

    const path = url.split('?')[0];
    if (PUBLIC_PATHS.has(path) || isExtraPublic(path)) return;

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const token = authHeader.slice(7);
    const payload = await verifyToken(token);
    if (!payload) {
      return reply.code(401).send({ error: 'invalid_token' });
    }
    req.user = payload;
  });
}

export async function requireParent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user || req.user.role !== 'parent') {
    await reply.code(403).send({ error: 'forbidden' });
  }
}

/* ============================================================================
 * 以下是可选扩展点（`registerPublicPaths` 见上方）。默认没有任何扩展在用它们，
 * 行为与不存在时完全一致。
 * ========================================================================== */

/**
 * 包装每一个路由处理器（可选扩展点）。必须在任何路由注册之前调用。
 *
 * ⚠️ 这里必须用 onRoute 在**注册期**包住 handler 本身，
 *    不能在 onRequest 钩子里做「请求级上下文」。
 *    实测过：AsyncLocalStorage.enterWith() 在 Fastify 的 onRequest 里设置之后，
 *    handler 里读不到（12 个并发请求全部拿到 undefined）。
 *    那样写出来的东西是「看起来生效、实际没生效」，比不做还危险。
 */
export function registerRouteWrapper(
  app: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrap: (handler: any) => any
): void {
  app.addHook('onRoute', (routeOptions) => {
    const handler = routeOptions.handler;
    if (typeof handler !== 'function') return;
    routeOptions.handler = wrap(handler);
  });
}

/**
 * 改写即将发出的响应数据（可选扩展点）。
 *
 * 只在 /api/ 下生效，只处理对象 / 数组 —— 字符串、Buffer、流一律原样放行。
 * 挂在 preSerialization 上而不是 onSend：onSend 拿到的已经是序列化后的字符串，
 * 还得再 parse 一遍，白白多一次开销。
 */
export function registerResponseTransform(
  app: FastifyInstance,
  transform: (payload: unknown, req: FastifyRequest) => unknown
): void {
  app.addHook('preSerialization', async (req: FastifyRequest, _reply: FastifyReply, payload: unknown) => {
    if (!req.url.startsWith('/api/')) return payload;
    if (payload === null || typeof payload !== 'object') return payload;
    return transform(payload, req);
  });
}
