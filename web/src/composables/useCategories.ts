import { api } from '@/api/client';
import { categories, setCategories, type ProductCategory } from '@/utils/categories';

// ─────────────────────────────────────────────────────────────────────────────
// 分类数据的网络层：全站只有一份注册表（utils/categories.ts 里的 categories），
// 这里负责把它拉满。登录后的 Layout 预热一次，商城页/分类管理弹窗按需刷新。
// ─────────────────────────────────────────────────────────────────────────────

let inflight: Promise<ProductCategory[]> | null = null;

/** 拉取分类列表并写入全局注册表；失败静默（保持上一次结果，不打断页面） */
export async function loadCategories(): Promise<ProductCategory[]> {
  try {
    const res = await api.get<{ categories: ProductCategory[] }>('/product-categories');
    setCategories(res.categories ?? []);
    return categories.value;
  } catch {
    return categories.value;
  }
}

/**
 * 首次调用才真正发请求（并发调用共享同一个 Promise）。
 * 用于「进游戏就该有分类」的预热场景，不需要每次进页面都打接口。
 */
export function ensureCategories(): Promise<ProductCategory[]> {
  if (categories.value.length > 0) return Promise.resolve(categories.value);
  if (!inflight) {
    inflight = loadCategories().finally(() => { inflight = null; });
  }
  return inflight;
}

export function useCategories() {
  return { categories, loadCategories, ensureCategories };
}
