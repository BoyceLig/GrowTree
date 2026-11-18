// ─────────────────────────────────────────────────────────────────────────────
// 上传前压缩图片：把手机原图（动辄 4000px、好几 MB）缩到展示所需的分辨率。
//
// 头像 / 商品图 / 分类图标在页面上只占几十到几百像素，保留原图没有意义；
// 统一在浏览器里缩到长边上限再编码，体积通常只剩几十到几百 KB，
// 既让「不限大小」的上传不至于把服务器内存打爆，看起来也不会糊。
//
// GIF 不动：canvas 编码会把动图压成一张静图，动画直接丢了。
// ─────────────────────────────────────────────────────────────────────────────

export interface CompressOptions {
  /** 长边上限（px）：超过才缩放；头像 512、商品图/分类图标 1024、日记大图 1600 */
  maxEdge: number;
  /** 编码质量 0~1，默认 0.85 */
  quality?: number;
  /** 体积目标（字节）：编码后仍大于它就在质量上再降一档，默认 600KB */
  maxBytes?: number;
}

type Drawable = ImageBitmap | HTMLImageElement;

function loadImage(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  // 老浏览器兜底：用 <img> 解码（注意手动回收 objectURL）
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('读取图片失败'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/** 浏览器是否支持编码 WebP（支持透明通道，比 PNG 小得多） */
function canEncodeWebp(canvas: HTMLCanvasElement): boolean {
  try {
    return canvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

/** 抽样检查画布是否有透明像素：有透明就保留 alpha 通道，否则用 JPEG 更小 */
function hasAlpha(canvas: HTMLCanvasElement): boolean {
  // 缩到 32×32 再一次性读像素，避免对大图反复 getImageData
  const small = document.createElement('canvas');
  small.width = 32;
  small.height = 32;
  const sctx = small.getContext('2d');
  if (!sctx) return false;
  sctx.drawImage(canvas, 0, 0, 32, 32);
  const data = sctx.getImageData(0, 0, 32, 32).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

function renameExt(name: string, mime: string): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  const base = name.replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}.${ext}`;
}

/**
 * 压缩图片并按需缩放。任何一步失败都退回原文件 —— 上传本身不该因为压缩而失败。
 */
export async function compressImage(file: File, opts: CompressOptions): Promise<File> {
  if (file.type === 'image/gif') return file;

  const { maxEdge, quality: initQuality = 0.85, maxBytes = 600 * 1024 } = opts;
  let drawable: Drawable | null = null;
  try {
    drawable = await loadImage(file);
    const srcW = drawable.width;
    const srcH = drawable.height;
    if (!srcW || !srcH) return file;

    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    // 尺寸没超、体积也不大，直接传原图，省一次重编码
    if (scale >= 1 && file.size <= maxBytes) return file;

    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(drawable, 0, 0, w, h);

    // PNG/WebP 可能有透明背景；JPEG 源图没有 alpha，直接走 JPEG
    const keepAlpha = /^image\/(png|webp)$/.test(file.type) && hasAlpha(canvas);
    let type = 'image/jpeg';
    if (keepAlpha) type = canEncodeWebp(canvas) ? 'image/webp' : 'image/png';

    let quality = initQuality;
    let blob = await canvasToBlob(canvas, type, quality);
    // 体积还是偏大（照片细节多）就降质量再编一次；PNG 不吃 quality 参数，跳过
    if (type !== 'image/png') {
      while (blob && blob.size > maxBytes && quality > 0.55) {
        quality = Number((quality - 0.1).toFixed(2));
        blob = await canvasToBlob(canvas, type, quality);
      }
    }
    if (!blob) return file;

    // 压缩反而更大就别费劲了（小图常见）
    if (blob.size >= file.size && scale >= 1) return file;

    return new File([blob], renameExt(file.name, blob.type || type), {
      type: blob.type || type,
      lastModified: Date.now(),
    });
  } catch {
    return file;
  } finally {
    if (typeof ImageBitmap !== 'undefined' && drawable instanceof ImageBitmap) drawable.close();
  }
}