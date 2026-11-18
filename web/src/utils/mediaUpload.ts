import { useAuthStore } from '@/stores/auth';
import { serverBaseOrigin } from '@/utils/server';

export interface UploadResult {
  url: string;
  type: 'image' | 'video';
  /** 上传时的原始文件名（服务端清洗后回传；磁盘名永远是随机 ID） */
  name?: string;
  size?: number;
  mime?: string;
}

export interface UploadMeta {
  /** 原始文件名：压缩后的 File 名字可能变了，这里显式传上传前用户看到的名字 */
  name?: string;
  /** 像素尺寸，图片/视频都有 */
  width?: number;
  height?: number;
  /** 视频时长（秒） */
  duration?: number;
}

/**
 * 异步流式上传（图片 / 视频）。
 *
 * 用 multipart/form-data + XHR，而不是把文件 FileReader 读成 base64：
 * 大视频读成 base64 会整包进内存并阻塞主线程（页面直接卡住），
 * multipart 由浏览器流式发送，XHR 还能拿到真实上传进度。
 *
 * 原始文件名与尺寸/时长走 query 带过去，服务端存进 upload_files 表：
 * 磁盘文件名是随机 ID（防重名、防中文名/xss），下载时再按原名还原。
 */
export function uploadMedia(
  file: File,
  onProgress?: (percent: number) => void,
  meta?: UploadMeta
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const auth = useAuthStore();
    const origin = serverBaseOrigin();
    const base = (origin ? `${origin}/api` : '/api') + '/upload/media';

    const query = new URLSearchParams();
    const originalName = meta?.name || file.name || '';
    if (originalName) query.set('name', originalName);
    if (meta?.width) query.set('w', String(Math.round(meta.width)));
    if (meta?.height) query.set('h', String(Math.round(meta.height)));
    if (meta?.duration) query.set('dur', String(meta.duration));
    const qs = query.toString();

    const form = new FormData();
    form.append('file', file, originalName || 'upload');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', qs ? `${base}?${qs}` : base);
    if (auth.token) xhr.setRequestHeader('Authorization', `Bearer ${auth.token}`);

    xhr.upload.onprogress = (e) => {
      if (!onProgress) return;
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new Error('网络异常，上传失败'));
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* 忽略解析异常，走失败分支 */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.url) {
        onProgress?.(100);
        resolve(data as UploadResult);
      } else {
        const code = data?.error;
        const msg =
          code === 'unsupported_type'
            ? '文件格式不支持'
            : code === 'too_large'
              ? '文件太大，上传失败'
              : data?.message || `上传失败 (${xhr.status})`;
        reject(new Error(msg));
      }
    };
    xhr.send(form);
  });
}
