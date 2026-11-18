import { serverBaseOrigin } from '@/utils/server';

/**
 * 从 /uploads/ 地址里取出磁盘文件名（可能是 `f12/xxx.mp4` 这种一层子目录的历史归档）。
 * 非上传文件（blob: 预览、外链）返回 null。
 */
function diskNameFromUrl(url: string): string | null {
  if (!url) return null;
  const path = url.split('?')[0].split('#')[0];
  const m = /\/uploads\/((?:[\w.-]+\/)?[\w.-]+)$/.exec(path);
  return m ? m[1] : null;
}

/**
 * 下载媒体，并还原成用户上传时的文件名。
 *
 * 磁盘上的名字是随机 ID（`lq2x9f-a1b2c3.mp4`），直接点链接会存成这个名字。
 * 这里统一走 /api/uploads/:name/download：服务端把原始文件名写进
 * Content-Disposition，浏览器保存下来的就是上传时的名字（中文、空格、括号都保留）。
 *
 * @param url 节点里的 src / data-src
 * @param originalName 上传时的原始文件名（节点的 data-name）
 */
export function downloadMedia(url: string, originalName?: string | null): void {
  if (!url) return;
  const anchor = document.createElement('a');
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  const diskName = diskNameFromUrl(url);
  if (!diskName) {
    // blob: 本地预览 / 站外链接：只能按浏览器默认行为下载
    anchor.href = url;
    if (originalName) anchor.download = originalName;
  } else {
    const origin = serverBaseOrigin();
    const base = `${origin}/api/uploads/${diskName
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')}/download`;
    anchor.href = originalName ? `${base}?as=${encodeURIComponent(originalName)}` : base;
    // 同源时 download 属性生效；跨源（手机 App 连远端服务器）会被忽略，
    // 由服务端 Content-Disposition 保证文件名正确。
    anchor.download = originalName || diskName;
  }

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
