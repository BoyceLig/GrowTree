import type { FastifyInstance } from 'fastify';
import { currentVersion } from '../update.js';

/**
 * 探活接口（无需鉴权，见 middleware.ts 的 PUBLIC_PATHS）。
 *
 * 专门给部署脚本和反向代理用：
 *   · 容器刚起来时判断服务是否就绪（docker-compose healthcheck 也可用）
 *   · **返回 version**，部署脚本据此确认「真的换成新版本了」——
 *     只看 200 是不保险的：旧容器还没停干净时也能返回 200，
 *     会出现「部署成功但版本没变」的假成功
 *
 * 只暴露版本号和运行时长，不含任何业务数据，公开无风险。
 */
export function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({
    ok: true,
    version: currentVersion(),
    uptime: Math.floor(process.uptime()),
  }));
}
