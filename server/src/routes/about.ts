import type { FastifyInstance } from 'fastify';
import { requireParent } from '../middleware.js';
import { currentVersion } from '../update.js';
import { loadLocalChangelog } from '../changelog.js';

/**
 * 「关于」页数据：当前版本 + 更新日志 + 作者与许可信息。
 *
 * 版本号只有一个来源 —— 镜像构建时注入的 MANALONG_VERSION（Dockerfile 里
 * ENV MANALONG_VERSION=$VERSION）。刻意与「一键升级」用同一个值，避免出现
 * 「关于页显示 A、升级提示说 B」的割裂。
 *
 * 更新内容来自项目根目录的 CHANGELOG.md（Dockerfile 已 COPY 进镜像，
 * 且 .dockerignore 里为它开了例外），解析规则见 `src/changelog.ts`。
 * 读不到时只返回版本号，前端降级为不显示更新日志，不影响任何其它功能。
 */

const APP_META = {
  name: '满伴成长树',
  nameEn: 'ManAlong',
  author: 'BoyceLig',
  contact: 'Boyce_Lig',
  licenseName: 'BSL 1.1',
  licenseNote: '个人与家庭使用永久免费；公司、机构等商业性使用需获得作者书面授权',
  repo: 'https://github.com/BoyceLig/ManAlong',
  /** 上游致谢（BSL 1.1 / MIT 署名，显示在「关于」页最下方） */
  credit:
    '风雨潇潇（成长树 GrowTree · BSL 1.1）与基耶杰（存钱罐 Piggy Bank · MIT）—— ' +
    '本项目基于两位作者的开源作品二次开发，感谢他们开放源码，' +
    '使家庭自托管积分管理方案得以延续与定制。',
} as const;

export function registerAboutRoutes(app: FastifyInstance) {
  app.get('/about', { preHandler: requireParent }, async () => ({
    ...APP_META,
    version: currentVersion(),
    changelog: loadLocalChangelog(),
  }));
}
