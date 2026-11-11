import { ref, watch, type Ref } from 'vue';

/** 商城显示样式：列表（一行一件）或网格（卡片平铺） */
export type ShopView = 'list' | 'grid';

const STORAGE_PREFIX = 'piggy-shop-view';

/**
 * 商城显示样式偏好（家长端 / 孩子端各存一份，互不干扰）。
 *
 * 为什么抽成 composable：两端商城页都要这个开关，读缓存、写缓存、默认值三件事
 * 必须一致；各自写一份迟早会出现「一边默认列表、一边默认网格」这种不一致。
 * 默认列表 —— 和改动前的观感一致，不会让用户一升级就觉得页面变了。
 */
export function useShopView(scope: 'parent' | 'child'): { view: Ref<ShopView> } {
  const key = `${STORAGE_PREFIX}:${scope}`;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(key);
  } catch {
    /* 隐私模式 / 禁用存储：退化成默认值，不弹错 */
  }
  const view = ref<ShopView>(saved === 'grid' ? 'grid' : 'list');

  watch(view, (v) => {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* 同上：写失败也不影响本次会话内的切换 */
    }
  });

  return { view };
}
