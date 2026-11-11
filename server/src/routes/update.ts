import type { FastifyInstance } from 'fastify';
import { requireParent } from '../middleware.js';
import { getVersionStatus, triggerUpdate } from '../update.js';
import { fetchRemoteChangelog } from '../changelog.js';

export function registerUpdateRoutes(app: FastifyInstance) {
  /**
   * 检测是否有新版本。家长端 Layout 挂载时调一次。
   * ?force=1 可绕开 10 分钟缓存（手动点「检查更新」时用）。
   */
  app.get('/update/status', { preHandler: requireParent }, async (req) => {
    const force = (req.query as any)?.force === '1' || (req.query as any)?.force === 'true';
    return await getVersionStatus({ force });
  });

  /**
   * 新版更新内容。提示条上点「查看更新」时调。
   *
   * 新版本的说明还没进当前运行的镜像，只能去代码仓库读最新的 CHANGELOG.md
   * （公开仓库，匿名可读）。拉不到时会退回镜像里已有的记录并置 ok=false，
   * 前端据此提示"这还不是新版本的说明"，而不是白屏。
   */
  app.get('/update/changelog', { preHandler: requireParent }, async (req) => {
    const q = (req.query as any) || {};
    const force = q.force === '1' || q.force === 'true';
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 3, 1), 10);
    return await fetchRemoteChangelog({ force, limit });
  });

  /** 家长点「立即升级」→ 通知 Watchtower 拉新镜像并重建容器 */
  app.post('/update/apply', { preHandler: requireParent }, async () => {
    return await triggerUpdate();
  });
}
