<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import GlassCard from '@/components/GlassCard.vue';
import EmptyState from '@/components/EmptyState.vue';
import ProductEditor from '@/components/ProductEditor.vue';
import CategoryManagerModal from '@/components/CategoryManagerModal.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import CategoryIcon from '@/components/CategoryIcon.vue';
import IconLightbox from '@/components/IconLightbox.vue';
import Modal from '@/components/Modal.vue';
import GiftModal from '@/components/GiftModal.vue';
import { useShopView } from '@/composables/useShopView';
import { useCategories } from '@/composables/useCategories';
import { useAuthStore } from '@/stores/auth';

const toast = useToastStore();
const auth = useAuthStore();

/** 显示样式：列表 / 网格（偏好存本地，下次进入沿用） */
const { view } = useShopView('parent');
const { categories, loadCategories } = useCategories();

interface Variant {
  id: number;
  name: string;
  cost: number;
  stock: number;
}

interface Product {
  id: number;
  name: string;
  cost: number;
  stock: number;
  /** goods 礼物 / prop 道具 */
  kind?: 'goods' | 'prop';
  prop_desc?: string;
  /** 自定义商品图片；'' = 没有单独上传 */
  icon: string;
  /** 后端解析好的展示图片（自定义图片 || 分类图标） */
  image: string;
  category_id: number | null;
  category_name: string | null;
  category_icon: string | null;
  category_color: string | null;
  limit_days: number;
  limit_count: number;
  max_per_exchange: number;
  status: string;
  created_at: number;
  variants?: Variant[];
  total_stock?: number;
  min_cost?: number;
}

const products = ref<Product[]>([]);
const loading = ref(true);
const editorOpen = ref(false);
const editing = ref<Product | null>(null);
const giftOpen = ref(false);
const giftProduct = ref<Product | null>(null);

// 现金兑换汇率
const cashRate = ref(10);
const rateOpen = ref(false);
const rateInput = ref(10);
const rateSaving = ref(false);

// 分类管理 + 按分类筛选
const categoryManagerOpen = ref(false);
/** 'all' = 全部；'none' = 未分类；数字 = 分类 id */
const filterCat = ref<'all' | 'none' | number>('all');

const visibleProducts = computed(() => {
  if (filterCat.value === 'all') return products.value;
  if (filterCat.value === 'none') return products.value.filter((p) => p.category_id == null);
  return products.value.filter((p) => p.category_id === filterCat.value);
});
function countOf(id: number) {
  return products.value.filter((p) => p.category_id === id).length;
}
const uncategorizedCount = computed(() => products.value.filter((p) => p.category_id == null).length);

// ─────────────────────────────────────────────────────────────────────────────
// 筛选条的横向滚动：「全部」固定不动，只有右侧分类区滚动。
// can-left / can-right 用来在边缘加渐隐，提示「这边还有内容」。
// ─────────────────────────────────────────────────────────────────────────────
const catScrollEl = ref<HTMLElement | null>(null);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);

function updateScrollHint() {
  const el = catScrollEl.value;
  if (!el) { canScrollLeft.value = false; canScrollRight.value = false; return; }
  canScrollLeft.value = el.scrollLeft > 2;
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
}

/** 桌面端把纵向滚轮转成横向滚动，省得去够滚动条（触屏本来就是横滑，不受影响） */
function onCatWheel(e: WheelEvent) {
  const el = catScrollEl.value;
  if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  if (el.scrollWidth <= el.clientWidth) return;
  e.preventDefault();
  el.scrollLeft += e.deltaY;
  updateScrollHint();
}

// 删除确认弹窗
const confirmOpen = ref(false);
const pendingDelete = ref<Product | null>(null);

// 图片放大预览
const zoomOpen = ref(false);
const zoomIcon = ref('');
const zoomName = ref('');
function syncZoom(v: boolean) {
  zoomOpen.value = v;
  if (!v) { zoomIcon.value = ''; zoomName.value = ''; }
}

// 竖三点操作菜单
const openMenuId = ref<number | null>(null);
function toggleMenu(id: number) {
  openMenuId.value = openMenuId.value === id ? null : id;
}
function closeMenu() {
  openMenuId.value = null;
}
function onDocClick() {
  closeMenu();
}
onMounted(() => document.addEventListener('click', onDocClick));
onUnmounted(() => document.removeEventListener('click', onDocClick));

/** silent = 后台静默同步（不显示加载态），用于 WebSocket 推送后的自动刷新 */
async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const [res, rate] = await Promise.all([
      api.get<{ products: Product[] }>('/products'),
      api.get<{ rate: number }>('/products/cash-rate'),
      loadCategories(),
    ]);
    products.value = res.products;
    cashRate.value = rate.rate;
    // 选中的分类被删掉了 → 退回「全部」，否则会停在空列表上
    if (typeof filterCat.value === 'number' && !categories.value.some((c) => c.id === filterCat.value)) {
      filterCat.value = 'all';
    }
  } catch {
    /* 静默同步失败不弹错，保持原列表 */
  } finally {
    if (!silent) loading.value = false;
    nextTick(updateScrollHint); // 筛选条是 v-if 渲染的，等 DOM 出来再量宽度
  }
}

function openRateEditor() {
  rateInput.value = cashRate.value;
  rateOpen.value = true;
}

async function saveRate() {
  if (!Number.isInteger(rateInput.value) || rateInput.value <= 0) {
    toast.warning('汇率必须是正整数');
    return;
  }
  rateSaving.value = true;
  try {
    await api.put('/products/cash-rate', { rate: rateInput.value });
    cashRate.value = rateInput.value;
    rateOpen.value = false;
    toast.success(`已设置 ${rateInput.value} 积分 = 1 元`);
  } catch (e: any) {
    toast.error(e.message);
  } finally {
    rateSaving.value = false;
  }
}

function openEditor(p?: Product) {
  closeMenu();
  editing.value = p ?? null;
  editorOpen.value = true;
}

/** 有规格时的价格区间文案，如 10~20；只有一档时直接显示数字 */
function priceRange(p: Product): string {
  const costs = (p.variants ?? []).map((v) => v.cost);
  if (costs.length === 0) return String(p.cost);
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  return min === max ? String(min) : `${min}~${max}`;
}

async function onSaved() {
  editorOpen.value = false;
  await load();
}

function openGift(p: Product) {
  giftProduct.value = p;
  giftOpen.value = true;
  closeMenu(); // 赠送弹窗打开时自动收起下拉菜单
}

function onGifted() {
  // 赠送成功后静默刷新（库存可能变了）
  load(true);
}

async function toggleStatus(p: Product) {
  closeMenu();
  try {
    const next = p.status === 'active' ? 'inactive' : 'active';
    await api.patch(`/products/${p.id}`, { status: next });
    toast.success(next === 'active' ? '已上架' : '已下架');
    await load();
  } catch (e: any) { toast.error(e.message); }
}

function remove(p: Product) {
  closeMenu();
  pendingDelete.value = p;
  confirmOpen.value = true;
}

async function doDelete() {
  if (!pendingDelete.value) return;
  try {
    await api.delete(`/products/${pendingDelete.value.id}`);
    toast.success('已删除');
    await load();
  } catch (e: any) { toast.error(e.message); }
  pendingDelete.value = null;
}

/** WebSocket：商品/规格/库存/汇率/分类变化时静默同步 */
function onProductsChanged() { load(true); }

onMounted(() => {
  load();
  window.addEventListener('ws:products_changed', onProductsChanged);
  window.addEventListener('resize', updateScrollHint);
});
onUnmounted(() => {
  window.removeEventListener('ws:products_changed', onProductsChanged);
  window.removeEventListener('resize', updateScrollHint);
});

// 分类数量或商品数变化 → 筛选条宽度变了，重新算一次左右渐隐
watch(
  [() => categories.value.length, () => products.value.length],
  () => nextTick(updateScrollHint)
);
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1 class="title">积分商城</h1>
      <div class="header-actions">
        <button class="btn btn-ghost cat-manage-btn" @click="categoryManagerOpen = true">🏷️ 分类</button>
        <button class="btn btn-primary add-btn" @click="openEditor()">＋ 新增</button>
      </div>
    </header>

    <GlassCard padding="14px 18px" class="cash-card" clickable label="设置现金兑换比例" @click="openRateEditor">
      <span class="emoji">💵</span>
      <div class="cash-info">
        <div class="cash-title">现金兑换</div>
        <div class="cash-desc">{{ cashRate }} 积分 = 1 元，点击设置兑换比例</div>
      </div>
      <span class="edit-arrow">⚙️</span>
    </GlassCard>

    <!-- 分类筛选条：点分类只看这一类的商品；「全部」固定在左，其余可左右滑动 -->
    <div v-if="!loading && products.length > 0" class="cat-bar">
      <button
        type="button"
        class="cat-filter pinned"
        :class="{ active: filterCat === 'all' }"
        @click="filterCat = 'all'"
      >
        <!-- 「全部」没有分类图标，补一个同尺寸的中性圆标，和其他分类按钮等高 -->
        <span class="flat-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="12" height="12">
            <circle cx="7.4" cy="7.4" r="3.3" fill="#8f8189" />
            <circle cx="16.6" cy="7.4" r="3.3" fill="#8f8189" opacity=".5" />
            <circle cx="7.4" cy="16.6" r="3.3" fill="#8f8189" opacity=".5" />
            <circle cx="16.6" cy="16.6" r="3.3" fill="#8f8189" />
          </svg>
        </span>
        全部 <em>{{ products.length }}</em>
      </button>
      <div
        ref="catScrollEl"
        class="cat-scroll"
        :class="{ 'can-left': canScrollLeft, 'can-right': canScrollRight }"
        @scroll.passive="updateScrollHint"
        @wheel="onCatWheel"
      >
        <button
          v-for="c in categories"
          :key="c.id"
          type="button"
          class="cat-filter"
          :class="{ active: filterCat === c.id }"
          @click="filterCat = c.id"
        >
          <CategoryIcon :icon="c.icon" :size="20" :color="c.color" />
          <span class="cf-name">{{ c.name }}</span>
          <em>{{ countOf(c.id) }}</em>
        </button>
        <button
          v-if="uncategorizedCount > 0"
          type="button"
          class="cat-filter"
          :class="{ active: filterCat === 'none' }"
          @click="filterCat = 'none'"
        >
          <span class="flat-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="12" height="12">
              <circle cx="12" cy="12" r="8" fill="none" stroke="#8f8189" stroke-width="2"
                stroke-dasharray="3.6 3.2" stroke-linecap="round" />
              <circle cx="12" cy="12" r="2.6" fill="#8f8189" opacity=".55" />
            </svg>
          </span>
          未分类 <em>{{ uncategorizedCount }}</em>
        </button>
      </div>
    </div>

    <!-- 显示样式切换：列表 / 网格 -->
    <div v-if="!loading && products.length > 0" class="list-bar">
      <span class="list-count">
        {{ filterCat === 'all' ? `共 ${products.length} 件商品` : `筛选出 ${visibleProducts.length} 件商品` }}
      </span>
      <div class="view-switch" role="group" aria-label="显示样式">
        <button
          type="button"
          :class="{ active: view === 'list' }"
          :aria-pressed="view === 'list'"
          @click="view = 'list'"
        >☰ 列表</button>
        <button
          type="button"
          :class="{ active: view === 'grid' }"
          :aria-pressed="view === 'grid'"
          @click="view = 'grid'"
        >▦ 网格</button>
      </div>
    </div>

    <EmptyState
      v-if="!loading && products.length === 0"
      emoji="🎁"
      text="还没有商品"
      hint="点击右上角「新增」添加商品"
    />

    <template v-else>
      <EmptyState
        v-if="!loading && visibleProducts.length === 0"
        emoji="🔍"
        text="这个分类下还没有商品"
        hint="换个分类看看，或在新增商品时选它"
      />

      <div v-else class="product-list" :class="view === 'grid' ? 'grid-view' : 'list-view'">
        <div
          v-for="p in visibleProducts"
          :key="p.id"
          class="product-row glass"
          :class="{ inactive: p.status === 'inactive', 'menu-open': openMenuId === p.id }"
        >
          <CategoryIcon
            :icon="p.image"
            :size="view === 'grid' ? 88 : 58"
            class="zoomable"
            @click="zoomIcon = p.image; zoomName = p.name"
          />
          <div class="row-name">
            <span class="name-text">{{ p.name }}</span>
            <span v-if="p.kind === 'prop'" class="tag prop">🔖 道具</span>
            <span v-if="p.kind === 'goods'" class="tag gift">🎁 礼物</span>
            <span v-if="p.status === 'inactive'" class="tag off">已下架</span>
            <span v-if="p.variants?.length" class="tag spec">{{ p.variants.length }} 档规格</span>
            <span v-if="view === 'list' && p.category_name" class="tag cat">{{ p.category_name }}</span>
          </div>
          <div class="row-cost">
            <template v-if="p.variants?.length">
              <span class="cost-num">{{ priceRange(p) }}</span><span class="unit">分</span>
            </template>
            <template v-else>
              <span class="cost-num">{{ p.cost }}</span><span class="unit">分</span>
            </template>
          </div>
          <div class="row-stock">
            <template v-if="p.variants?.length">
              <span v-if="p.total_stock === -1">库存 不限</span>
              <span v-else>库存 <span :class="{ low: (p.total_stock ?? 0) <= 3 }">{{ p.total_stock }}</span></span>
              <span class="spec-list">{{ p.variants.map((v) => `${v.name} ${v.cost}分/${v.stock === -1 ? '不限' : v.stock + '件'}`).join('，') }}</span>
            </template>
            <template v-else>
              <span v-if="p.stock === -1">库存 不限</span>
              <span v-else>库存 <span :class="{ low: p.stock <= 3 }">{{ p.stock }}</span></span>
            </template>
            <span v-if="p.limit_count > 0" class="limit-line">每{{ p.limit_days }}天限{{ p.limit_count }}次</span>
            <span v-if="(p.max_per_exchange ?? 1) > 1" class="limit-line">每次限{{ p.max_per_exchange }}件</span>
          </div>
          <div class="row-menu">
            <button
              class="dots-btn"
              :class="{ active: openMenuId === p.id }"
              title="更多操作"
              @click.stop="toggleMenu(p.id)"
            >⋮</button>
            <div v-if="openMenuId === p.id" class="popup-menu glass-strong" @click.stop>
              <button class="menu-item" @click="openEditor(p)">
                <span class="mi-icon">✏️</span> 编辑
              </button>
              <button class="menu-item" @click="openGift(p)">
                <span class="mi-icon">🎁</span> 赠送孩子
              </button>
              <button class="menu-item" @click="toggleStatus(p)">
                <span class="mi-icon">{{ p.status === 'active' ? '📥' : '📤' }}</span>
                {{ p.status === 'active' ? '下架' : '上架' }}
              </button>
              <button class="menu-item danger" @click="remove(p)">
                <span class="mi-icon">🗑️</span> 删除
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <ProductEditor v-if="editorOpen" v-model="editorOpen" :product="editing" @saved="onSaved" />

    <GiftModal
      v-if="giftOpen"
      v-model="giftOpen"
      :product="giftProduct"
      @gifted="onGifted"
    />

    <CategoryManagerModal v-model="categoryManagerOpen" @changed="load" />

    <!-- 图标放大预览 -->
    <IconLightbox :model-value="zoomOpen" :icon="zoomIcon" :name="zoomName" @update:model-value="syncZoom" />

    <!-- 汇率设置弹窗 -->
    <Modal v-model="rateOpen" title="💵 兑换比例设置" width="360px">
      <p class="modal-hint">设置多少积分兑换 1 元</p>
      <div class="rate-input-row">
        <input v-model.number="rateInput" type="number" min="1" step="1" class="rate-input" />
        <span class="rate-suffix">积分 = 1 元</span>
      </div>
      <div class="rate-preview">
        预览：{{ rateInput }} 积分可兑 1 元（1 积分 ≈ {{ (1 / rateInput).toFixed(2) }} 元）
      </div>
      <template #footer>
        <button type="button" class="btn btn-ghost" @click="rateOpen = false">取消</button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="rateSaving || !Number.isInteger(rateInput) || rateInput <= 0"
          @click="saveRate"
        >
          {{ rateSaving ? '保存中...' : '保存' }}
        </button>
      </template>
    </Modal>

    <ConfirmDialog
      v-model="confirmOpen"
      title="删除商品"
      :message="`确认删除「${pendingDelete?.name}」？删除后不可恢复`"
      confirmText="删除"
      variant="danger"
      @confirm="doDelete"
    />
  </div>
</template>

<style scoped>
/* 商品图片可点击放大 */
.zoomable { cursor: zoom-in; transition: transform var(--dur-fast); }
.zoomable:hover { transform: scale(1.06); }
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-16);
  gap: var(--space-12);
}
.title { font-size: var(--fs-3xl); }
.header-actions { display: flex; align-items: center; gap: var(--space-8); flex-shrink: 0; }
.add-btn,
.cat-manage-btn { white-space: nowrap; }

.cash-card {
  display: flex;
  align-items: center;
  gap: var(--space-14);
  margin-bottom: var(--space-16);
  background: linear-gradient(135deg, rgba(255, 209, 102, 0.15), rgba(255, 180, 84, 0.08));
  transition: filter var(--dur-fast);
}
/* 手型光标由 GlassCard 的 .glass-card[tabindex] 统一提供（B5），此处不再重复；
   hover 高亮改挂在 .cash-card 上，B6 去掉了靠 class 透传的 .clickable 标记。 */
.cash-card:hover { filter: brightness(1.1); }
.cash-card .emoji { font-size: var(--fs-5xl); }
.cash-title { font-family: var(--font-cute); font-size: var(--fs-lg); margin-bottom: var(--space-2); }
.cash-desc { font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.5; }
.edit-arrow { margin-left: auto; font-size: var(--fs-2xl); opacity: 0.6; }

/* ── 分类筛选条：「全部」固定，其余横向滑动 ────────────────────────────── */
.cat-bar {
  display: flex;
  align-items: center;
  /* gap 收到 0：滚动区自带 12px 水平 padding（给阴影留空间），
     两者相加就是「全部」与第一个分类之间的视觉间距 */
  gap: 0;
  margin-bottom: var(--space-10);
  min-width: 0;
}
/* 常驻的「全部」：不参与滚动，稍微抬起来区分于后面的分类 */
.cat-filter.pinned {
  flex-shrink: 0;
  position: relative;
  z-index: 1;
  box-shadow: var(--shadow-pill);
}
/* 可滚动的分类区：左右渐隐只在「那一侧还有内容」时挂上（由 JS 控制） */
.cat-scroll {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-8);
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  /* 滚动容器会把 overflow-y 强制成 auto，四边都贴着内容边缘裁切，
     柔和的投影一旦溢出就被切平——选中的按钮、以及首尾按钮的外侧
     会显得生硬不圆润。这里四边都留出阴影空间（padding 区在裁剪
     边界之内），垂直方向用负 margin 抵消，占位高度不变；水平方向
     的 12px 正好与下面 mask 的渐隐宽度对齐，所以首尾按钮本体不会
     被淡化，只有外侧那截本就极淡的阴影融进渐隐里 */
  padding: 8px 12px 16px;
  margin: -8px 0 -16px;
}
.cat-scroll::-webkit-scrollbar { display: none; }
/* 渐隐宽度与 .cat-scroll 的水平 padding 一致（12px）：只淡化那截
   本来就极淡的外侧阴影，按钮本体完全不受影响 */
.cat-scroll.can-left {
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 12px);
  mask-image: linear-gradient(to right, transparent 0, #000 12px);
}
.cat-scroll.can-right {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 12px), transparent 100%);
  mask-image: linear-gradient(to right, #000 calc(100% - 12px), transparent 100%);
}
.cat-scroll.can-left.can-right {
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
  mask-image: linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
}
.cat-filter {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-6);
  padding: var(--space-6) var(--space-12);
  border-radius: var(--r-pill);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  transition: all var(--dur-base);
  /* 6px 上下内边距 ×2 + 20px 图标 + 2px 边框 —— 让每个按钮（含没有分类图标的
     「全部」「未分类」）高度完全一致 */
  min-height: 34px;
  box-sizing: border-box;
}
/* 「全部」「未分类」没有分类图标，用同尺寸的中性圆标占位，体量与分类按钮对齐 */
.flat-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: var(--r-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 32% 26%, #ffffff 0%, rgba(191,179,185,0.2) 55%, rgba(191,179,185,0.4) 100%);
  box-shadow: 0 4px 12px rgba(191,179,185,0.27), inset 0 1px 2px rgba(255,255,255,0.6);
  /* 和分类图标一样带 2px 白边，圆的实际视觉直径才对得上 */
  border: 2px solid rgba(255, 255, 255, 0.7);
  box-sizing: border-box;
}
.cat-filter:hover { color: var(--text-primary); }
.cat-filter.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
  border-color: var(--accent-yellow);
  box-shadow: var(--shadow-pill);
  /* 抬到相邻按钮之上，阴影才不会被左右按钮的背景盖住两侧 */
  position: relative;
  z-index: 2;
}
.cat-filter em {
  font-style: normal;
  font-size: var(--fs-2xs);
  color: var(--text-muted);
  background: rgba(90, 58, 74, 0.08);
  border-radius: var(--r-pill);
  padding: 0 var(--space-6);
}
.cat-filter.active em { color: var(--text-on-yellow); background: rgba(255, 209, 102, 0.25); }
.cf-name { max-width: 92px; overflow: hidden; text-overflow: ellipsis; }

/* 显示样式切换条：列表 / 网格 */
.list-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-10);
  margin-bottom: var(--space-10);
}
.list-count { font-size: var(--fs-xs); color: var(--text-muted); }
.view-switch {
  display: inline-flex;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--r-pill);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
}
.view-switch button {
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  transition: all var(--dur-base);
}
.view-switch button.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
  box-shadow: var(--shadow-pill);
}

/* 商品行式列表 */
.product-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}

/* ── 网格视图：一行多件，图片居中、价格在下 ─────────────────────────────── */
.product-list.grid-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: var(--space-10);
}
.grid-view .product-row {
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-8);
  padding: var(--space-16) var(--space-12) var(--space-14);
}
.grid-view .row-name {
  flex: none;
  width: 100%;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--space-4);
}
.grid-view .name-text {
  font-size: var(--fs-md);
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  line-height: 1.3;
}
.grid-view .row-cost { min-width: 0; font-size: var(--fs-3xl); text-align: center; }
.grid-view .row-stock { min-width: 0; align-items: center; text-align: center; gap: var(--space-4); }
.grid-view .row-stock .spec-list {
  /* 规格明细在窄卡片里最多两行，超出省略，避免卡片高度参差不齐 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-align: center;
}
.grid-view .row-menu { position: absolute; top: var(--space-6); right: var(--space-6); }
.grid-view .dots-btn { width: 28px; height: 28px; font-size: var(--fs-md); }
.product-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-14);
  padding: var(--space-14) var(--space-18);
  border-radius: var(--r-md);
  overflow: visible; /* 让弹出菜单不被裁切 */
  transition: opacity var(--dur-base);
}
.product-row.inactive { opacity: 0.55; }
/* 菜单打开时该行浮到其他卡片之上，避免弹出菜单被后面的卡片遮挡 */
.product-row.menu-open { z-index: 50; }

.row-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-8);
}
.name-text {
  font-family: var(--font-cute);
  font-size: var(--fs-lg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag.off {
  flex-shrink: 0;
  background: rgba(255, 122, 122, 0.2);
  color: var(--text-on-red);
  font-size: var(--fs-2xs);
  padding: var(--space-2) var(--space-8);
  border-radius: var(--r-2xs);
}
.tag.spec {
  flex-shrink: 0;
  background: rgba(255, 152, 92, 0.18);
  color: var(--text-on-orange);
  font-size: var(--fs-2xs);
  padding: var(--space-2) var(--space-8);
  border-radius: var(--r-2xs);
}
.tag.cat {
  flex-shrink: 0;
  background: rgba(132, 197, 255, 0.2);
  color: var(--text-secondary);
  font-size: var(--fs-2xs);
  padding: var(--space-2) var(--space-8);
  border-radius: var(--r-2xs);
}
.tag.prop { background: rgba(130, 192, 255, 0.22); color: var(--text-on-sky); }
.tag.gift { background: rgba(255, 209, 102, 0.22); color: var(--text-on-yellow); }

.row-cost {
  flex-shrink: 0;
  font-family: var(--font-cute);
  color: var(--text-on-yellow);
  font-size: var(--fs-4xl);
  min-width: 84px;
  text-align: right;
  line-height: 1;
}
.unit { font-size: var(--fs-sm); margin-left: var(--space-4); color: var(--text-muted); }

.row-stock {
  flex-shrink: 0;
  font-size: var(--fs-sm);
  color: var(--text-muted);
  min-width: 80px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.row-stock .limit-line {
  font-size: var(--fs-2xs);
  color: var(--text-on-orange);
  background: rgba(255, 152, 92, 0.12);
  padding: 0 var(--space-6);
  border-radius: var(--r-2xs);
  width: fit-content;
}
.row-stock .spec-list {
  font-size: var(--fs-2xs);
  color: var(--text-muted);
  line-height: 1.4;
}
.row-stock .low { color: var(--text-on-red); font-weight: 600; }

/* 竖三点菜单 */
.row-menu {
  position: relative;
  flex-shrink: 0;
}
.dots-btn {
  width: 34px;
  height: 34px;
  border-radius: var(--r-sm);
  background: var(--glass-bg-strong);
  font-size: var(--fs-xl);
  line-height: 1;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur-fast);
}
.dots-btn:hover,
.dots-btn.active {
  background: var(--glass-bg);
  color: var(--text-primary);
}
.popup-menu {
  position: absolute;
  right: 0;
  top: calc(100% + var(--space-6));
  z-index: 100;
  min-width: 128px;
  padding: var(--space-6);
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  box-shadow: var(--shadow-pop);
  animation: menu-pop var(--dur-fast) ease-out;
}
@keyframes menu-pop {
  from { opacity: 0; transform: translateY(-6px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  text-align: left;
  white-space: nowrap;
  transition: background var(--dur-fast);
}
.menu-item:hover { background: var(--glass-bg); }
.menu-item.danger { color: var(--text-on-red); }
.mi-icon { font-size: var(--fs-sm); width: 18px; text-align: center; }

/* 汇率设置弹窗内容（外壳已迁入公共 Modal.vue） */
.modal-hint { font-size: var(--fs-sm); color: var(--text-secondary); margin-bottom: var(--space-16); }
.rate-input-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-8);
  margin-bottom: var(--space-12);
}
.rate-input { width: 100px; }
.rate-suffix { font-size: var(--fs-sm); color: var(--text-muted); }
.rate-preview {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-bottom: var(--space-20);
  padding: var(--space-10) var(--space-14);
  border-radius: var(--r-sm);
  background: var(--glass-bg);
}

@media (max-width: 480px) {
  .product-row { gap: var(--space-10); padding: var(--space-12) var(--space-14); }
  .row-cost { min-width: 64px; font-size: var(--fs-2xl); }
  .row-stock { min-width: 64px; font-size: var(--fs-sm); }
}
</style>
