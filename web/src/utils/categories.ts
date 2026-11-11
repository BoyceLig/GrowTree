import { ref, type Ref } from 'vue';

// ─────────────────────────────────────────────────────────────────────────────
// 商品分类：家长可以自己增删改（名称 + 图标），所以分类不再是写死的常量，
// 而是从服务端拉下来的动态列表 —— 这里同时充当一份「全局可读的注册表」，
// 供 CategoryIcon 解析配色 / 语义名，避免每个组件各拉一次接口。
//
// 两套「图标」概念要分清：
//   · BUILTIN_ICONS —— 8 个内置手绘 SVG（key 与后端 icon 域一致），做分类图标的候选项
//   · 分类自己的 icon 字段 —— 取内置 key 或自定义上传图片路径，与商品图片同构，
//     这样「商品没传图片 → 用分类图标」在前端是同一套渲染，不需要分支
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductCategory {
  id: number;
  name: string;
  /** 内置图标 key（snack/toy/…）或自定义上传图片路径 /uploads/xxx.png */
  icon: string;
  /** 图标圆形底渐晕的主色 #RRGGBB */
  color: string;
  sort_order?: number;
  product_count?: number;
}

export interface BuiltinIcon {
  key: string;
  label: string;
  color: string;
}

/** 8 个内置图标样式（新建分类时的候选图标 + 老数据的默认分类） */
export const BUILTIN_ICONS: BuiltinIcon[] = [
  { key: 'snack', label: '零食', color: '#ff9bb0' },
  { key: 'toy', label: '玩具', color: '#84c5ff' },
  { key: 'activity', label: '活动', color: '#ffb454' },
  { key: 'game', label: '游戏', color: '#7ed4b9' },
  { key: 'study', label: '学习', color: '#b39ddb' },
  { key: 'privilege', label: '特权', color: '#ffd166' },
  { key: 'food', label: '美食', color: '#ffab91' },
  { key: 'gift', label: '礼盒', color: '#e8b4c8' },
];

/** 分类图标可选配色（与内置图标同一套色，自定义上传图片时手动挑一个） */
export const CATEGORY_COLORS: string[] = BUILTIN_ICONS.map((i) => i.color);

export const DEFAULT_CATEGORY_COLOR = '#e8b4c8';

export function isImageIcon(icon?: string | null): boolean {
  return !!icon && /^(\/uploads\/|data:image\/|https?:\/\/)/.test(icon);
}

export function builtinIcon(key?: string | null): BuiltinIcon | undefined {
  return BUILTIN_ICONS.find((i) => i.key === key);
}

// ── 动态分类注册表 ────────────────────────────────────────────────────────────

/** 当前分类列表（登录后由 Layout 预热，商城页 / 分类管理弹窗共用同一份） */
export const categories: Ref<ProductCategory[]> = ref<ProductCategory[]>([]);

export function setCategories(list: ProductCategory[]): void {
  categories.value = Array.isArray(list) ? list : [];
}

/** 按 id 找分类 */
export function categoryById(id?: number | null): ProductCategory | undefined {
  if (id == null) return undefined;
  return categories.value.find((c) => c.id === id);
}

// ── 图标视觉解析（CategoryIcon 唯一入口）─────────────────────────────────────

/** 用哪个内置 SVG：非内置值（自定义图片 / 未知）统一退回礼盒 */
export function iconGlyph(icon?: string | null): string {
  return builtinIcon(icon)?.key ?? 'gift';
}

/**
 * 图标配色：优先匹配「哪个分类用的就是这个图标」，其次内置定义，最后兜底。
 * 商品图片是自定义上传的独立文件时匹配不到分类，会走兜底色 —— 无所谓，
 * 那种情况下 <img> 已经铺满整个圆，底色看不见。
 */
export function iconColor(icon?: string | null): string {
  const cat = categories.value.find((c) => c.icon === icon);
  if (cat) return cat.color;
  return builtinIcon(icon)?.color ?? DEFAULT_CATEGORY_COLOR;
}

/** 图标的语义名（title / 无障碍用）：分类名 > 内置名 > 泛称 */
export function iconLabel(icon?: string | null): string {
  const cat = categories.value.find((c) => c.icon === icon);
  if (cat) return cat.name;
  return builtinIcon(icon)?.label ?? '商品图片';
}
