<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import { useAuthStore } from '@/stores/auth';
import GlassCard from '@/components/GlassCard.vue';
import EmptyState from '@/components/EmptyState.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import CategoryIcon from '@/components/CategoryIcon.vue';
import IconLightbox from '@/components/IconLightbox.vue';
import Modal from '@/components/Modal.vue';
import BackpackModal from '@/components/BackpackModal.vue';
import { useShopView } from '@/composables/useShopView';
import { useCategories } from '@/composables/useCategories';

const toast = useToastStore();
const auth = useAuthStore();

/** 显示样式：列表 / 网格（偏好存本地，下次进入沿用） */
const { view } = useShopView('child');
const { categories, loadCategories } = useCategories();

/** 当前筛选的分类：'all' = 全部，数字 = 分类 id */
const filterCat = ref<'all' | number>('all');

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
  limit_days: number;
  limit_count: number;
  max_per_exchange: number;
  variants?: Variant[];
  total_stock?: number;
  min_cost?: number;
}
interface Request {
  id: number;
  type: 'product' | 'cash';
  product_name: string | null;
  product_icon: string | null;
  points: number;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  reason: string | null;
  created_at: number;
}

const products = ref<Product[]>([]);
const myRequests = ref<Request[]>([]);
const loading = ref(true);
const myPoints = computed(() => auth.user?.totalPoints ?? 0);
const tab = ref<'shop' | 'records'>('shop');
const backpackOpen = ref(false);

// 现金兑换弹窗
const cashOpen = ref(false);
const cashPoints = ref(10);
const cashRate = ref(10);
const cashAmount = computed(() => cashPoints.value / cashRate.value);

/** 现金兑换输入的实时校验提示：有值 = 不能提交 */
const cashError = computed(() => {
  if (!Number.isFinite(cashPoints.value) || cashPoints.value <= 0) return `请输入积分数量（${cashRate.value} 的倍数）`;
  if (cashPoints.value % cashRate.value !== 0) return `积分必须是 ${cashRate.value} 的倍数`;
  if (cashPoints.value > myPoints.value) return `积分不足：当前只有 ${myPoints.value} 分，还差 ${cashPoints.value - myPoints.value} 分`;
  return '';
});

// 确认弹窗
const confirmOpen = ref(false);
const confirmMessage = ref('');
const confirmAction = ref<(() => Promise<void>) | null>(null);
const cashSubmitting = ref(false);

// 图片放大预览
const zoomOpen = ref(false);
const zoomIcon = ref('');
const zoomName = ref('');
function openZoom(p: Product) {
  zoomIcon.value = p.image;
  zoomName.value = p.name;
  zoomOpen.value = true;
}

/** 按分类筛选后的商品列表 */
const visibleProducts = computed(() => {
  if (filterCat.value === 'all') return products.value;
  return products.value.filter((p) => p.category_id === filterCat.value);
});
function countOf(id: number) {
  return products.value.filter((p) => p.category_id === id).length;
}
/** 只在「有分类、且至少一个分类下有商品」时才显示筛选条，避免空壳 UI */
const showCatBar = computed(
  () => categories.value.length > 0 && products.value.length > 0
);

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

/** silent = 后台静默同步（不显示加载态），用于 WebSocket 推送后的自动刷新 */
async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const [p, r, rate] = await Promise.all([
      api.get<{ products: Product[] }>('/products'),
      api.get<{ requests: Request[] }>('/exchange-requests/mine'),
      api.get<{ rate: number }>('/products/cash-rate'),
      loadCategories(),
    ]);
    products.value = p.products;
    myRequests.value = r.requests;
    cashRate.value = rate.rate;
    // 选中的分类被家长删掉了 → 退回「全部」
    if (typeof filterCat.value === 'number' && !categories.value.some((c) => c.id === filterCat.value)) {
      filterCat.value = 'all';
    }
    await auth.refreshMe();
  } catch {
    /* 静默同步失败不弹错，保持原列表 */
  } finally {
    if (!silent) loading.value = false;
    nextTick(updateScrollHint); // 筛选条是 v-if 渲染的，等 DOM 出来再量宽度
  }
}

// ── 规格辅助 ───────────────────────────────────────────────────────────────

const hasVariants = (p: Product) => (p.variants?.length ?? 0) > 0;
/** 展示用最低价（有规格取规格最低价） */
const minCost = (p: Product) => (hasVariants(p) ? (p.min_cost ?? p.cost) : p.cost);
/** 展示用总库存（-1 = 不限） */
const totalStock = (p: Product) => (hasVariants(p) ? (p.total_stock ?? 0) : p.stock);
/** 是否整体售罄 */
const soldOut = (p: Product) => {
  if (!hasVariants(p)) return p.stock === 0;
  return (p.variants ?? []).every((v) => v.stock === 0);
};

// 规格选择弹窗
const variantOpen = ref(false);
const variantProduct = ref<Product | null>(null);
const pickedVariant = ref<Variant | null>(null);

function openVariantPicker(p: Product) {
  variantProduct.value = p;
  pickedVariant.value = null;
  variantOpen.value = true;
}

function pickVariant(v: Variant) {
  if (v.stock === 0) return toast.warning(`「${v.name}」这一档已经售罄啦`);
  const p = variantProduct.value;
  if (!p) return;
  pickedVariant.value = v;
  variantOpen.value = false;
  const maxPer = Math.max(1, p.max_per_exchange ?? 1);
  if (maxPer > 1) {
    qtyProduct.value = p;
    qtyValue.value = 1;
    qtyOpen.value = true;
    return;
  }
  doExchange(p, 1, v);
}

async function exchangeProduct(p: Product) {
  // 道具类：直接走后端接口（后端会跳过审核、直接入背包）
  if (p.kind === 'prop') {
    const qty = Math.max(1, p.max_per_exchange ?? 1);
    if (myPoints.value < minCost(p) * 1) {
      return toast.warning(`积分不足，还差 ${minCost(p) - myPoints.value} 分`);
    }
    try {
      const res: any = await api.post('/exchange-requests', {
        type: 'product',
        productId: p.id,
        variantId: null,
        quantity: 1,
      });
      if (res?.isProp) {
        const label = res.quantity > 1 ? `×${res.quantity}「${res.productName}」` : `「${res.productName}」`;
        toast.success(
          res.points > 0
            ? `兑换成功！扣 ${res.points} 分，${label} 已放进背包 🎒`
            : `兑换成功！${label} 已放进背包 🎒`
        );
      } else {
        // 旧数据（老商品没 kind 字段，或后端仍按审核走）：走 confirmDialog 兜底
        return runGoodsExchange(p);
      }
      await load();
      return;
    } catch (e: any) {
      const err = e.payload?.error;
      if (err === 'insufficient_points') toast.error('积分不足');
      else if (err === 'out_of_stock') toast.error('商品已售罄');
      else if (err === 'limit_reached') toast.warning('已达限兑次数，过几天再来吧~');
      else toast.error(e.message);
      return;
    }
  }
  return runGoodsExchange(p);
}

function runGoodsExchange(p: Product) {
  if (myPoints.value < minCost(p)) {
    return toast.warning(`积分不足，还差 ${minCost(p) - myPoints.value} 分`);
  }
  // 有规格的商品：先让小朋友选规格
  if (hasVariants(p)) {
    openVariantPicker(p);
    return;
  }
  const maxPer = Math.max(1, p.max_per_exchange ?? 1);
  if (maxPer > 1) {
    // 单次可兑多件 → 先选数量
    pickedVariant.value = null;
    qtyProduct.value = p;
    qtyValue.value = 1;
    qtyOpen.value = true;
    return;
  }
  doExchange(p, 1, null);
}

function doExchange(p: Product, quantity: number, variant: Variant | null = pickedVariant.value) {
  const unit = variant ? variant.cost : p.cost;
  const total = unit * quantity;
  const label = variant ? `「${p.name} · ${variant.name}」` : `「${p.name}」`;
  confirmMessage.value =
    quantity > 1
      ? `确认兑换 ${quantity} 件${label}？消耗 ${total} 分`
      : `确认兑换${label}？消耗 ${unit} 分\n（等待家长审核通过后扣分）`;
  confirmAction.value = async () => {
    try {
      await api.post('/exchange-requests', {
        type: 'product',
        productId: p.id,
        variantId: variant ? variant.id : null,
        quantity,
      });
      toast.success('申请已提交，等家长审核哦~');
      pickedVariant.value = null;
      await load();
    } catch (e: any) {
      const err = e.payload?.error;
      if (err === 'insufficient_points') toast.error('积分不足');
      else if (err === 'out_of_stock') toast.error('商品已售罄');
      else if (err === 'variant_required') toast.warning('请先选择商品规格');
      else if (err === 'limit_reached') toast.warning('已达限兑次数，过几天再来吧~');
      else if (err === 'exceeds_per_exchange') toast.warning(`每次最多兑换 ${Math.max(1, p.max_per_exchange ?? 1)} 件`);
      else toast.error(e.message);
    }
  };
  confirmOpen.value = true;
}

// 单次多件兑换：数量选择弹窗
const qtyOpen = ref(false);
const qtyProduct = ref<Product | null>(null);
const qtyValue = ref(1);
/** 当前要兑的单价（有规格时按所选规格算） */
const qtyUnit = computed(() => {
  const p = qtyProduct.value;
  if (!p) return 0;
  return pickedVariant.value ? pickedVariant.value.cost : p.cost;
});
const qtyMax = computed(() => {
  const p = qtyProduct.value;
  if (!p) return 1;
  let m = Math.max(1, p.max_per_exchange ?? 1);
  const stockLeft = pickedVariant.value ? pickedVariant.value.stock : p.stock;
  if (stockLeft !== -1) m = Math.min(m, stockLeft);
  m = Math.min(m, Math.floor(myPoints.value / (qtyUnit.value || 1)) || 1);
  return Math.max(1, m);
});
const qtyTotal = computed(() => qtyUnit.value * qtyValue.value);

function stepQty(d: number) {
  const next = qtyValue.value + d;
  if (next >= 1 && next <= qtyMax.value) qtyValue.value = next;
}

function confirmQty() {
  if (!qtyProduct.value) return;
  const p = qtyProduct.value;
  const q = qtyValue.value;
  qtyOpen.value = false;
  qtyProduct.value = null;
  doExchange(p, q, pickedVariant.value);
}

function openCash() {
  cashPoints.value = Math.min(cashRate.value, Math.floor(myPoints.value / cashRate.value) * cashRate.value || cashRate.value);
  cashOpen.value = true;
}

async function exchangeCash() {
  // 不静默失败：任何校验不过都给出明确提示
  if (cashError.value) return toast.warning(cashError.value);
  confirmMessage.value = `确认兑换 ${cashAmount.value} 元？消耗 ${cashPoints.value} 积分`;
  confirmAction.value = async () => {
    cashSubmitting.value = true;
    try {
      await api.post('/exchange-requests', { type: 'cash', points: cashPoints.value });
      toast.success(`已申请兑换 ${cashAmount.value} 元，等家长审核`);
      cashOpen.value = false;
      await load();
    } catch (e: any) {
      if (e.payload?.error === 'insufficient_points') toast.error('积分不足');
      else toast.error(e.message || '提交失败，请重试');
    } finally { cashSubmitting.value = false; }
  };
  confirmOpen.value = true;
}

async function runConfirm() {
  if (confirmAction.value) await confirmAction.value();
  confirmAction.value = null;
}

function fmtTime(ts: number) {
  const d = new Date(ts * 1000);
  const diff = Date.now() - ts * 1000;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const statusText: Record<string, string> = {
  pending: '⏳ 审核中',
  approved: '✅ 已通过',
  rejected: '❌ 已拒绝',
};

// 兑换记录类型图标
const typeIcon: Record<string, string> = {
  cash: '💰 现金',
  product: '商品',
};

/** WebSocket：家长新增/编辑/上下架商品、审核扣库存、改汇率 → 静默重拉 */
function onProductsChanged() { load(true); }

onMounted(() => {
  load();
  window.addEventListener('ws:exchange_reviewed', onReviewed);
  window.addEventListener('ws:products_changed', onProductsChanged);
  window.addEventListener('resize', updateScrollHint);
});

function onReviewed() {
  // 收到审核结果后刷新兑换记录
  load();
}

onUnmounted(() => {
  window.removeEventListener('ws:exchange_reviewed', onReviewed);
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
      <div>
        <h1 class="title">积分商城</h1>
        <p class="subtitle">攒积分，换好礼~</p>
      </div>
      <div class="header-actions">
        <button class="bp-entry" @click="backpackOpen = true">
          🎒 我的背包
        </button>
        <div class="points-box">
          <span class="num">{{ myPoints }}</span>
          <span class="unit">分</span>
          <span class="emoji">🌟</span>
        </div>
      </div>
    </header>

    <div class="tabs">
      <button :class="{ active: tab === 'shop' }" @click="tab = 'shop'">🎁 商城</button>
      <button :class="{ active: tab === 'records' }" @click="tab = 'records'">📋 我的兑换</button>
    </div>

    <template v-if="tab === 'shop'">
      <!-- 现金兑换入口 -->
      <GlassCard padding="16px 18px" class="cash-entry" clickable label="现金兑换" @click="openCash">
        <div class="cash-left">
          <span class="emoji">💵</span>
          <div>
            <div class="cash-title">现金兑换</div>
          <div class="cash-desc">{{ cashRate }} 🌟 = 1 元</div>
          </div>
        </div>
        <span class="arrow">›</span>
      </GlassCard>

      <!-- 分类筛选：点分类只看这一类的商品；「全部」固定在左，其余可左右滑动 -->
      <div v-if="showCatBar" class="cat-bar">
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
        </div>
      </div>

      <!-- 显示样式切换：列表 / 网格 -->
      <div v-if="!loading && products.length > 0" class="list-bar">
        <span class="list-count">
          {{ filterCat === 'all' ? `共 ${products.length} 件好礼` : `筛选出 ${visibleProducts.length} 件好礼` }}
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

      <EmptyState v-if="!loading && products.length === 0" emoji="🎁" text="商城还没有商品" hint="让爸爸妈妈添加商品吧~" />

      <template v-else>
        <EmptyState
          v-if="!loading && visibleProducts.length === 0"
          emoji="🔍"
          text="这个分类下还没有好礼"
          hint="换个分类看看吧~"
        />

        <div v-else class="product-list" :class="view === 'grid' ? 'grid-view' : 'list-view'">
          <GlassCard v-for="p in visibleProducts" :key="p.id" padding="12px 16px" class="product-row">
            <CategoryIcon
              :icon="p.image"
              :size="view === 'grid' ? 92 : 60"
              class="zoomable"
              @click="openZoom(p)"
            />
            <div class="p-info">
              <span class="name">
                {{ p.name }}
                <em v-if="p.kind === 'prop'" class="prop-tag">🔖 道具</em>
              </span>
              <span class="stock" :class="{ soldout: soldOut(p) }">
                {{ totalStock(p) === -1 ? '库存不限' : (totalStock(p) === 0 ? '已售罄' : `剩 ${totalStock(p)} 件`) }}
                <em v-if="hasVariants(p)" class="limit-tag">{{ p.variants!.length }} 档规格可选</em>
                <em v-if="p.limit_count > 0" class="limit-tag">每{{ p.limit_days }}天限{{ p.limit_count }}次</em>
                <em v-if="(p.max_per_exchange ?? 1) > 1" class="limit-tag">每次限兑{{ p.max_per_exchange }}件</em>
              </span>
              <span v-if="p.prop_desc && p.kind === 'prop'" class="spec-line prop-desc">💡 {{ p.prop_desc }}</span>
              <span v-if="hasVariants(p)" class="spec-line">
                {{ p.variants!.map((v) => `${v.name} ${v.cost}🌟`).join(' / ') }}
              </span>
            </div>
            <span class="cost">
              {{ minCost(p) }}<span v-if="hasVariants(p) && (p.variants!.length > 1)" class="cost-suffix">起</span> 🌟
            </span>
            <button
              :class="['btn btn-primary exchange-btn', p.kind === 'prop' ? 'prop-btn' : '']"
              :disabled="myPoints < minCost(p) || soldOut(p)"
              @click="exchangeProduct(p)"
            >
              {{ soldOut(p) ? '售罄' : (myPoints < minCost(p) ? '🌟不足' : (p.kind === 'prop' ? '兑换道具' : '兑换')) }}
            </button>
          </GlassCard>
        </div>
      </template>
    </template>

    <template v-else>
      <EmptyState v-if="!loading && myRequests.length === 0" emoji="📋" text="还没有兑换记录" />
      <div v-else class="records">
        <GlassCard v-for="r in myRequests" :key="r.id" padding="12px 16px" class="record">
          <div class="r-head">
            <span class="r-type">
              <CategoryIcon v-if="r.type === 'product'" :icon="r.product_icon" :size="24" />
              <span v-else class="r-type-emoji">💰</span>
              <span>{{ typeIcon[r.type] }}</span>
            </span>
            <span class="r-status" :class="r.status">{{ statusText[r.status] }}</span>
          </div>
          <div class="r-detail">
            <span v-if="r.type === 'product'">{{ r.product_name || '已删除商品' }}</span>
            <span v-else>{{ r.amount }} 元</span>
            <span class="r-pts">🌟 -{{ r.points }} 分</span>
          </div>
          <div v-if="r.status === 'rejected' && r.reason" class="r-reason">
            📝 {{ r.reason }}
          </div>
          <div class="r-time">{{ fmtTime(r.created_at) }}</div>
        </GlassCard>
      </div>
    </template>

    <!-- 现金兑换弹窗 -->
    <Modal v-model="cashOpen" title="💵 现金兑换" width="360px">
      <p class="modal-hint">{{ cashRate }} 🌟 = 1 元（必须是 {{ cashRate }} 的倍数）</p>
      <div class="my-points">🌟 当前积分：{{ myPoints }} 分</div>
      <div class="input-row">
        <input v-model.number="cashPoints" type="number" :min="cashRate" :step="cashRate" />
        <span class="suffix">分</span>
      </div>
      <div class="amount-display">
        可兑换 <span class="amount">{{ cashAmount }}</span> 元
      </div>
      <p v-if="cashError" class="cash-error">{{ cashError }}</p>
      <template #footer>
        <button type="button" class="btn btn-ghost" @click="cashOpen = false">取消</button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="cashSubmitting"
          @click="exchangeCash"
        >
          {{ cashSubmitting ? '提交中...' : '确认申请' }}
        </button>
      </template>
    </Modal>

    <!-- 规格选择弹窗 -->
    <Modal v-model="variantOpen" title="🧩 选择商品规格" width="380px">
      <template v-if="variantProduct">
        <div class="qty-product">
          <CategoryIcon :icon="variantProduct.icon" :size="40" />
          <div class="qty-pinfo">
            <span class="name">{{ variantProduct.name }}</span>
            <span class="unit-price">🌟 当前 {{ myPoints }} 分</span>
          </div>
        </div>
        <div class="variant-list">
          <button
            v-for="v in variantProduct.variants"
            :key="v.id"
            type="button"
            class="variant-item"
            :class="{ disabled: v.stock === 0, poor: v.stock !== 0 && myPoints < v.cost }"
            @click="pickVariant(v)"
          >
            <span class="v-name">{{ v.name }}</span>
            <span class="v-cost">{{ v.cost }} 🌟</span>
            <span class="v-stock">
              {{ v.stock === -1 ? '库存不限' : (v.stock === 0 ? '已售罄' : `剩 ${v.stock} 件`) }}
            </span>
          </button>
        </div>
        <p class="variant-tip">选好规格后再确认兑换，不同规格的积分价格不一样哦~</p>
      </template>
      <template #footer>
        <button type="button" class="btn btn-ghost" @click="variantOpen = false">取消</button>
      </template>
    </Modal>

    <!-- 单次多件兑换：数量选择弹窗 -->
    <Modal v-model="qtyOpen" title="🛒 选择兑换数量" width="360px">
      <template v-if="qtyProduct">
        <div class="qty-product">
          <CategoryIcon :icon="qtyProduct.icon" :size="40" />
          <div class="qty-pinfo">
            <span class="name">{{ qtyProduct.name }}<template v-if="pickedVariant"> · {{ pickedVariant.name }}</template></span>
            <span class="unit-price">{{ qtyUnit }} 🌟 / 件</span>
          </div>
        </div>
        <div class="qty-rule">每次最多兑换 {{ qtyMax }} 件</div>
        <div class="qty-stepper">
          <button type="button" class="qty-btn" :disabled="qtyValue <= 1" @click="stepQty(-1)">−</button>
          <span class="qty-num">{{ qtyValue }}</span>
          <button type="button" class="qty-btn" :disabled="qtyValue >= qtyMax" @click="stepQty(1)">＋</button>
        </div>
        <div class="amount-display">
          共消耗 <span class="amount">{{ qtyTotal }}</span> 🌟
        </div>
      </template>
      <template #footer>
        <button type="button" class="btn btn-ghost" @click="qtyOpen = false">取消</button>
        <button type="button" class="btn btn-primary" @click="confirmQty">下一步</button>
      </template>
    </Modal>

    <ConfirmDialog
      v-model="confirmOpen"
      title="确认操作"
      :message="confirmMessage"
      confirmText="确认"
      @confirm="runConfirm"
    />

    <!-- 图标放大预览 -->
    <IconLightbox v-model="zoomOpen" :icon="zoomIcon" :name="zoomName" />

    <!-- 我的背包 -->
    <BackpackModal v-model="backpackOpen" />
  </div>
</template>

<style scoped>
/* 商品图标可点击放大 */
.zoomable { cursor: zoom-in; transition: transform var(--dur-fast); }
.zoomable:hover { transform: scale(1.06); }

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-16);
  gap: var(--space-12);
}
.title { font-size: var(--fs-3xl); margin-bottom: var(--space-2); }
.subtitle { color: var(--text-secondary); font-size: var(--fs-sm); }
.header-actions { display: flex; align-items: center; gap: var(--space-10); flex-shrink: 0; }
.bp-entry {
  padding: var(--space-8) var(--space-14);
  border-radius: var(--r-md);
  background: linear-gradient(135deg, rgba(130, 192, 255, 0.25), rgba(80, 144, 220, 0.15));
  border: 1px solid rgba(130, 192, 255, 0.45);
  color: var(--text-on-sky);
  font-size: var(--fs-sm);
  font-weight: 600;
  white-space: nowrap;
  transition: all var(--dur-fast);
}
.bp-entry:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(80, 144, 220, 0.3); }
.points-box {
  background: linear-gradient(135deg, var(--accent-yellow), var(--accent-orange));
  padding: var(--space-8) var(--space-16);
  border-radius: var(--r-md);
  box-shadow: 0 4px 12px rgba(255, 180, 84, 0.3);
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
}
.points-box .emoji { font-size: var(--fs-md); }
.points-box .num {
  font-family: var(--font-cute);
  font-size: var(--fs-3xl);
  color: #4a2e00;
}
.points-box .unit { font-size: var(--fs-xs); color: #4a2e00; }

.tabs {
  display: flex;
  background: var(--glass-bg);
  border-radius: var(--r-md);
  padding: var(--space-4);
  gap: var(--space-4);
  margin-bottom: var(--space-16);
}
.tabs button {
  flex: 1;
  padding: var(--space-10);
  border-radius: var(--r-sm);
  color: var(--text-secondary);
  font-weight: 600;
  transition: all var(--dur-base);
}
.tabs button.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
  box-shadow: var(--shadow-pill);
}

.cash-entry {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-16);
  cursor: pointer;
  background: linear-gradient(135deg, rgba(255, 209, 102, 0.15), rgba(255, 180, 84, 0.08));
}
.cash-left { display: flex; align-items: center; gap: var(--space-12); }
.cash-entry .emoji { font-size: var(--fs-5xl); }
.cash-title { font-family: var(--font-cute); font-size: var(--fs-lg); }
.cash-desc { font-size: var(--fs-xs); color: var(--text-secondary); }
.arrow { font-size: var(--fs-3xl); color: var(--text-muted); }

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
  /* 6px 上下内边距 ×2 + 20px 图标 + 2px 边框 —— 让没有分类图标的「全部」
     和其他分类按钮高度完全一致 */
  min-height: 34px;
  box-sizing: border-box;
}
/* 「全部」没有分类图标，用同尺寸的中性圆标占位，体量与分类按钮对齐 */
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

.product-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}

/* ── 网格视图：一行多件，图片居中、名字与价格竖排 ───────────────────────── */
.product-list.grid-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(156px, 1fr));
  gap: var(--space-10);
}
/* 卡片内边距是 GlassCard 的 :style 内联值，这里必须 !important 才盖得住 */
.grid-view .product-row {
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-8);
  padding: var(--space-16) var(--space-10) var(--space-14) !important;
}
.grid-view .p-info { align-items: center; width: 100%; gap: var(--space-4); }
.grid-view .p-info .name { font-size: var(--fs-md); white-space: normal; line-height: 1.3; }
.grid-view .p-info .stock { line-height: 1.4; }
.grid-view .p-info .spec-line {
  /* 规格明细最多两行，超出省略，避免卡片高度参差不齐 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: normal;
}
.grid-view .cost { font-size: var(--fs-lg); }
.grid-view .exchange-btn { width: 100%; }
.product-row {
  display: flex;
  align-items: center;
  gap: var(--space-12);
}
.p-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.p-info .name {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex; align-items: center; gap: var(--space-6);
}
.prop-tag {
  font-style: normal;
  font-size: var(--fs-2xs);
  padding: 1px 6px;
  border-radius: var(--r-2xs);
  background: rgba(130, 192, 255, 0.22);
  color: var(--text-on-sky);
  flex-shrink: 0;
}
.prop-desc {
  font-size: var(--fs-xs) !important;
  color: var(--text-secondary) !important;
  line-height: 1.4;
  white-space: normal !important;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.prop-btn { background: linear-gradient(135deg, #7ec9ff, #4a94d8); color: #fff; }
.prop-btn:disabled { opacity: 0.5; }
.p-info .stock {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.limit-tag {
  font-style: normal;
  margin-left: var(--space-6);
  padding: 0 var(--space-6);
  border-radius: var(--r-2xs);
  background: rgba(255, 152, 92, 0.15);
  color: var(--text-on-orange);
}
.p-info .spec-line {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cost-suffix { font-size: var(--fs-xs); margin-left: 2px; }

/* 规格选择弹窗 */
.variant-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  margin-bottom: var(--space-12);
}
.variant-item {
  display: grid;
  grid-template-columns: 1.2fr 0.9fr 0.9fr;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-12) var(--space-14);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 2px solid transparent;
  text-align: left;
  transition: all var(--dur-fast);
}
.variant-item:hover { border-color: var(--accent-yellow); }
.variant-item .v-name { font-family: var(--font-cute); font-size: var(--fs-md); }
.variant-item .v-cost { color: var(--text-on-yellow); font-size: var(--fs-sm); }
.variant-item .v-stock { font-size: var(--fs-xs); color: var(--text-muted); text-align: right; }
.variant-item.disabled { opacity: 0.45; cursor: not-allowed; }
.variant-item.disabled:hover { border-color: transparent; }
.variant-item.poor { opacity: 0.7; }
.variant-tip { font-size: var(--fs-xs); color: var(--text-muted); }
.cash-error {
  font-size: var(--fs-xs);
  color: var(--text-on-red);
  background: rgba(255, 122, 122, 0.1);
  padding: var(--space-6) var(--space-10);
  border-radius: var(--r-sm);
  margin-bottom: var(--space-12);
  text-align: center;
}

/* 数量选择弹窗 */
.qty-product {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  margin-bottom: var(--space-16);
}
.qty-pinfo { display: flex; flex-direction: column; gap: var(--space-2); }
.qty-pinfo .name { font-family: var(--font-cute); font-size: var(--fs-md); }
.qty-pinfo .unit-price { font-size: var(--fs-xs); color: var(--text-on-yellow); }
.qty-rule {
  font-size: var(--fs-xs);
  color: var(--text-on-orange);
  background: rgba(255, 152, 92, 0.12);
  padding: var(--space-6) var(--space-10);
  border-radius: var(--r-sm);
  text-align: center;
  margin-bottom: var(--space-16);
}
.qty-stepper {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-16);
  margin-bottom: var(--space-16);
}
.qty-btn {
  width: 40px;
  height: 40px;
  border-radius: var(--r-full);
  background: var(--glass-bg);
  font-size: var(--fs-xl);
  font-weight: bold;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur-fast);
}
.qty-btn:disabled { opacity: 0.35; }
.qty-num {
  min-width: 48px;
  text-align: center;
  font-family: var(--font-cute);
  font-size: var(--fs-2xl);
}
.p-info .stock.soldout { color: var(--text-on-red); }
.product-row .cost {
  flex-shrink: 0;
  font-family: var(--font-cute);
  color: var(--text-on-yellow);
  font-size: var(--fs-xl);
}
.exchange-btn {
  flex-shrink: 0;
  min-width: 72px;
  padding: var(--space-8) var(--space-14);
  font-size: var(--fs-sm);
}
.exchange-btn:disabled { opacity: 0.45; }

.records { display: flex; flex-direction: column; gap: var(--space-10); }
.r-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-6); }
.r-type { display: inline-flex; align-items: center; gap: var(--space-6); font-size: var(--fs-sm); font-family: var(--font-cute); }
.r-type-emoji { font-size: var(--fs-xl); line-height: 1; }
.r-status { font-size: var(--fs-xs); padding: var(--space-2) var(--space-8); border-radius: var(--r-2xs); font-weight: 600; }
.r-status.pending { background: rgba(255, 209, 102, 0.2); color: var(--text-on-yellow); }
.r-status.approved { background: rgba(126, 212, 185, 0.2); color: var(--text-on-mint); }
.r-status.rejected { background: rgba(255, 122, 122, 0.2); color: var(--text-on-red); }
.r-detail {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-sm);
  margin-bottom: var(--space-4);
}
.r-pts { color: var(--text-on-red); font-family: var(--font-cute); }
.r-reason { font-size: var(--fs-xs); color: var(--text-on-red); margin-bottom: var(--space-4); }
.r-time { font-size: var(--fs-xs); color: var(--text-muted); }

/* 现金兑换弹窗内容（外壳已迁入公共 Modal.vue） */
.modal-hint { font-size: var(--fs-xs); color: var(--text-secondary); margin-bottom: var(--space-16); }
.my-points { font-size: var(--fs-sm); margin-bottom: var(--space-12); color: var(--text-secondary); }
.input-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-6);
  margin-bottom: var(--space-12);
}
.input-row input { flex: 1; }
.suffix { font-size: var(--fs-sm); color: var(--text-muted); }
.amount-display {
  font-size: var(--fs-md);
  margin-bottom: var(--space-20);
  text-align: center;
}
.amount-display .amount {
  font-family: var(--font-cute);
  color: var(--text-on-yellow);
  font-size: var(--fs-4xl);
}
</style>
