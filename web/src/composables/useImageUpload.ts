import { ref } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import { compressImage } from '@/utils/imageCompress';

// ─────────────────────────────────────────────────────────────────────────────
// 图片上传（压缩 → 读成 data URL → POST /upload/image → 返回站内 /uploads/xxx 路径）。
// 头像、商品图片、分类图标走的是同一个接口、同一套校验，抽出来避免两处文案/上限跑偏。
//
// 不再限制文件体积：手机原图动辄好几 MB，前端先按用途缩到合适分辨率
// （头像 512、商品图/分类图标 1024），再上传，服务端只保留兜底的请求体上限。
// ─────────────────────────────────────────────────────────────────────────────

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const ALLOWED = /^image\/(png|jpe?g|gif|webp)$/;

export interface ImageUploadOptions {
  /** 压缩后长边上限（px）。头像这类小图用 512，商品图/分类图标用 1024 */
  maxEdge?: number;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export function useImageUpload(options: ImageUploadOptions = {}) {
  const toast = useToastStore();
  const maxEdge = options.maxEdge ?? 1024;
  const uploading = ref(false);
  const fileInput = ref<HTMLInputElement | null>(null);

  function pickImage() {
    fileInput.value?.click();
  }

  /** apply 收到上传成功后的站内路径；调用方决定写进哪个字段 */
  async function onFileChange(e: Event, apply: (url: string) => void) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // 允许重复选同一张图
    if (!file) return;
    if (!ALLOWED.test(file.type)) {
      return toast.warning('只支持 PNG / JPG / GIF / WebP 图片');
    }
    uploading.value = true;
    try {
      // 大图在浏览器里先缩到合适分辨率，体积通常只剩几十到几百 KB
      const compressed = await compressImage(file, { maxEdge });
      const dataUrl = await readAsDataUrl(compressed);
      // name 传上传前用户看到的原始文件名：磁盘名是随机 ID，下载时按它还原
      const res = await api.post<{ url: string; name?: string }>('/upload/image', {
        data: dataUrl,
        name: file.name,
      });
      apply(res.url);
      toast.success('图片已上传');
    } catch (e: any) {
      const err = e.payload?.error;
      if (err === 'too_large') toast.error('图片太大，请换一张再试');
      else if (err === 'unsupported_type') toast.error('不支持的图片格式');
      else toast.error(e.message || '上传失败');
    } finally {
      uploading.value = false;
    }
  }

  return { uploading, fileInput, pickImage, onFileChange, ACCEPT };
}
