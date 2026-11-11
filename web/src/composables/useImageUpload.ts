import { ref } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';

// ─────────────────────────────────────────────────────────────────────────────
// 图片上传（读成 data URL → POST /upload/image → 返回站内 /uploads/xxx 路径）。
// 商品图片和分类图标走的是同一个接口、同一套校验，抽出来避免两处文案/上限跑偏。
// ─────────────────────────────────────────────────────────────────────────────

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const ALLOWED = /^image\/(png|jpe?g|gif|webp)$/;
const MAX_BYTES = 3 * 1024 * 1024;

export function useImageUpload() {
  const toast = useToastStore();
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
    if (file.size > MAX_BYTES) {
      return toast.warning('图片不能超过 3MB');
    }
    uploading.value = true;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      const res = await api.post<{ url: string }>('/upload/image', { data: dataUrl });
      apply(res.url);
      toast.success('图片已上传');
    } catch (e: any) {
      const err = e.payload?.error;
      if (err === 'too_large') toast.error('图片超过 3MB，请压缩后再试');
      else if (err === 'unsupported_type') toast.error('不支持的图片格式');
      else toast.error(e.message || '上传失败');
    } finally {
      uploading.value = false;
    }
  }

  return { uploading, fileInput, pickImage, onFileChange, ACCEPT };
}
