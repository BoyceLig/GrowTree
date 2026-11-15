<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';
import GlassCard from '@/components/GlassCard.vue';
import Modal from '@/components/Modal.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';

/**
 * 心愿单（孩子 ⇄ 家长）
 *
 * 孩子：写「想要什么 / 为什么 / 预计积分（选填）」→ 等家长审核
 * 家长：抢单审核（同一时刻只有一位家长能操作）→ 补充商品信息上架商城 / 不通过
 * 审核完成后进入历史：审核人、审核时间、审核内容（上架的商品信息或驳回原因）
 */

type WishStatus = 'pending' | 'reviewing' | 'approved' | 'rejected' | 'cancelled';

interface WishItem {
  id: number;
  child_id: number;
  child_name: string;
  child_avatar: string;
  title: string;
  reason: string;
  estimated_points: number | null;
  status: WishStatus;
  reviewer_id: number | null;
  reviewer_name: string | null;
  reviewer_identity: string | null;
  review_started_at: number | null;
  reviewed_at: number | null;
  review_note: string | null;
  product_id: number | null;
  product_name: string | null;
  product_cost: number | null;
  product_stock: number | null;
  category_name: string | null;
  review: unknown;
  created_at: number;
  locked_by_me: boolean;
}

interface Category {
  id: number;
  name: string;
  icon: string;
  color: string;
  hidden: number;
}

const auth = useAuthStore();
const toast = useToastStore();
const router = useRouter();

const isParent = computed(() => auth.user?.role === 'parent');

const loading = ref(true);
const pending = ref<WishItem[]>([]);
const history = ref<WishItem[]>([]);
const items = ref<WishItem[]>([]);
const categories = ref<Category[]>([]);
const tab = ref<'pending' | 'history'>('pending');

// ── 孩子：许愿表单 ─────────────────────────────────────────────────────────
const createOpen = ref(false);
const creating = ref(false);
const submitError = ref('');
// type="number" 的 v-model 会把输入转成 number，这里必须同时接受字符串和数字
const createForm = reactive<{ title: string; reason: string; estimated: string | number }>({
  title: '',
  reason: '',
  estimated: '',
});

// ── 家长：审核弹窗 ─────────────────────────────────────────────────────────
const claimingId = ref<number | null>(null);
const reviewOpen = ref(false);
const reviewItem = ref<WishItem | null>(null);
const reviewing = ref(false);
const reviewSubmitted = ref(false);
const reviewForm = reactive({ name: '', cost: '', stock: '-1', category_id: '', note: '' });

const dialogTitle = computed(() =>
  reviewItem.value ? `审核 ${reviewItem.value.child_name} 的心愿` : '审核心愿'
);

function statusLabel(it: WishItem): string {
  if (it.status === 'pending') return '等待审核';
  if (it.status === 'reviewing') return '审核中';
  if (it.status === 'approved') return '已上架';
  if (it.status === 'rejected') return '未通过';
  return '已撤回';
}

function reviewerLabel(it: WishItem): string {
  const name = it.reviewer_name || '家长';
  const identity = it.reviewer_identity || '家长';
  return name === identity ? name : `${name}（${identity}）`;
}

/** 审核结果优先用快照（商品后来被改/删，历史仍然准确），旧数据回落到关联商品 */
function productOf(it: WishItem) {
  const p = (it.review as { product?: { name?: string; cost?: number; stock?: number; category_name?: string | null } } | null)?.product;
  return {
    name: p?.name ?? it.product_name ?? '—',
    cost: p?.cost ?? it.product_cost ?? 0,
    stock: p?.stock ?? it.product_stock ?? -1,
    category_name: p?.category_name ?? it.category_name ?? '',
  };
}

function fmtRelative(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtDateTime(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    if (isParent.value) {
      const res = await api.get<{ pending: WishItem[]; history: WishItem[] }>('/wish-requests');
      pending.value = res.pending;
      history.value = res.history;
    } else {
      const res = await api.get<{ items: WishItem[] }>('/wish-requests');
      items.value = res.items;
    }
  } catch {
    /* 首页卡片读不到就保持原样，不打扰用户 */
  } finally {
    if (!silent) loading.value = false;
  }
}

async function loadCategories() {
  if (!isParent.value) return;
  try {
    const res = await api.get<{ categories: Category[] }>('/product-categories');
    // 隐藏分类（许愿单）下的商品不会出现在孩子端商城，不能用来「上架」
    categories.value = res.categories.filter((c) => c.hidden === 0);
  } catch {
    categories.value = [];
  }
}

// ── 孩子：提交 / 撤回 ─────────────────────────────────────────────────────
function openCreate() {
  createForm.title = '';
  createForm.reason = '';
  createForm.estimated = '';
  submitError.value = '';
  createOpen.value = true;
}

async function submitWish() {
  const title = createForm.title.trim();
  const reason = createForm.reason.trim();
  if (!title) return toast.error('写一下想要什么吧');
  if (!reason) return toast.error('说一下为什么想要吧');

  const raw = createForm.estimated;
  const estimated = raw === '' || raw === null ? null : Number(raw);
  if (estimated !== null && (!Number.isInteger(estimated) || estimated <= 0)) {
    return toast.error('预计积分要填大于 0 的整数，或者留空');
  }

  creating.value = true;
  submitError.value = '';
  try {
    await api.post('/wish-requests', {
      title,
      reason,
      estimated_points: estimated,
    });
    createOpen.value = false;
    toast.success('心愿已经交给爸爸妈妈啦，等他们审核～');
    await load(true);
  } catch (e: any) {
    // 弹窗里直接显示失败原因；同时打到控制台，方便把报错发给开发定位
    console.error('[心愿单] 提交失败', e);
    submitError.value = e.message || '提交失败，请稍后再试';
    toast.error(submitError.value);
  } finally {
    creating.value = false;
  }
}

async function cancelWish(it: WishItem) {
  if (!window.confirm(`撤回心愿「${it.title}」吗？`)) return;
  try {
    await api.post(`/wish-requests/${it.id}/cancel`);
    toast.info('已撤回这个心愿');
    await load(true);
  } catch (e: any) {
    toast.error(e.message || '撤回失败');
  }
}

function goShop() {
  router.push('/child/shop');
}

// ── 家长：抢单 / 审核 ─────────────────────────────────────────────────────
async function startReview(it: WishItem) {
  if (it.status === 'reviewing' && !it.locked_by_me) return;
  claimingId.value = it.id;
  try {
    const res = await api.post<{ item: WishItem }>(`/wish-requests/${it.id}/claim`);
    openReview(res.item ?? it);
  } catch (e: any) {
    toast.error(e.message || '暂时无法接手这个心愿');
    await load(true);
  } finally {
    claimingId.value = null;
  }
}

function openReview(it: WishItem) {
  reviewItem.value = it;
  reviewSubmitted.value = false;
  reviewForm.name = it.title;
  reviewForm.cost = it.estimated_points ? String(it.estimated_points) : '100';
  reviewForm.stock = '-1';
  reviewForm.category_id = '';
  reviewForm.note = '';
  reviewOpen.value = true;
}

async function onReviewOpenChange(v: boolean) {
  if (v) {
    reviewOpen.value = true;
    return;
  }
  await closeReview();
}

/** 关窗即放弃：主动释放锁，其他家长马上可以接手 */
async function closeReview() {
  const it = reviewItem.value;
  reviewOpen.value = false;
  if (!reviewSubmitted.value && it && it.status === 'reviewing' && it.locked_by_me) {
    try {
      await api.post(`/wish-requests/${it.id}/release`);
    } catch {
      /* 锁已超时/被接手，忽略 */
    }
    await load(true);
  }
  reviewSubmitted.value = false;
  reviewItem.value = null;
}

async function submitReview(approve: boolean) {
  const it = reviewItem.value;
  if (!it || reviewing.value) return;

  const note = reviewForm.note.trim();
  if (!approve && !note) {
    return toast.error('不通过时请写一下原因，孩子会看到');
  }

  let payload: Record<string, unknown> = { approve, note: note || undefined };
  if (approve) {
    const name = reviewForm.name.trim();
    const cost = Number(reviewForm.cost);
    const stock = reviewForm.stock.trim() === '' ? -1 : Number(reviewForm.stock);
    if (!name) return toast.error('请填写上架的商品名称');
    if (!Number.isInteger(cost) || cost <= 0) return toast.error('所需积分要填大于 0 的整数');
    if (!Number.isInteger(stock) || stock < -1) return toast.error('库存填 -1 表示不限，或填 0 以上的整数');
    payload = {
      ...payload,
      name,
      cost,
      stock,
      category_id: reviewForm.category_id ? Number(reviewForm.category_id) : null,
    };
  }

  reviewing.value = true;
  try {
    await api.post(`/wish-requests/${it.id}/review`, payload);
    reviewSubmitted.value = true;
    reviewOpen.value = false;
    reviewItem.value = null;
    toast.success(approve ? '已通过，商品已上架商城' : '已标记为不通过');
    await load(true);
  } catch (e: any) {
    toast.error(e.message || '提交失败');
    // 锁被其他家长接手 / 心愿已被审核：关掉弹窗并刷新，避免对着旧状态继续操作
    if (e?.status === 409) {
      reviewSubmitted.value = true;
      reviewOpen.value = false;
      reviewItem.value = null;
      await load(true);
    }
  } finally {
    reviewing.value = false;
  }
}

function onPush() {
  load(true);
}

const PUSH_EVENTS = ['ws:wish_requests_changed', 'ws:wish_request_created', 'ws:wish_request_reviewed'];

onMounted(() => {
  load();
  loadCategories();
  for (const ev of PUSH_EVENTS) window.addEventListener(ev, onPush);
});
onUnmounted(() => {
  for (const ev of PUSH_EVENTS) window.removeEventListener(ev, onPush);
});
</script>

<template>
  <!-- 家长端：待审核队列 + 审核历史 -->
  <GlassCard v-if="isParent" class="wish-card" padding="16px 18px">
    <div class="wish-head">
      <div class="wish-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 12v8H4v-8" />
          <path d="M2 7h20v5H2z" />
          <path d="M12 22V7" />
          <path d="M12 7S10.6 3 8.1 3a2.4 2.4 0 0 0 0 4.8H12Z" />
          <path d="M12 7s1.4-4 3.9-4a2.4 2.4 0 0 1 0 4.8H12Z" />
        </svg>
      </div>
      <div class="wish-head-text">
        <div class="wish-title">
          心愿单
          <span v-if="pending.length" class="wish-badge" :aria-label="`${pending.length} 个心愿待审核`">{{ pending.length }}</span>
        </div>
        <div class="wish-sub">孩子写下心愿，你补充商品信息后直接上架；同时只有一位家长能审核</div>
      </div>
    </div>

    <div class="wish-tabs" role="tablist" aria-label="心愿单视图">
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'pending'"
        :class="['wish-tab', { active: tab === 'pending' }]"
        @click="tab = 'pending'"
      >
        待审核 <span class="tab-count">{{ pending.length }}</span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'history'"
        :class="['wish-tab', { active: tab === 'history' }]"
        @click="tab = 'history'"
      >
        审核历史 <span class="tab-count">{{ history.length }}</span>
      </button>
    </div>

    <!-- 待审核 -->
    <template v-if="tab === 'pending'">
      <div v-if="loading" class="wish-empty">加载中…</div>
      <div v-else-if="!pending.length" class="wish-empty">暂时没有待审核的心愿</div>
      <div v-else class="wish-grid">
        <article v-for="it in pending" :key="it.id" :class="['wish-item', it.status]">
          <div class="wi-top">
            <ZodiacAvatar :zodiac="it.child_avatar" :size="30" />
            <span class="wi-child">{{ it.child_name }}</span>
            <span :class="['status-chip', it.status]">{{ statusLabel(it) }}</span>
            <span class="wi-time">{{ fmtRelative(it.created_at) }}</span>
          </div>
          <h4 class="wi-title">{{ it.title }}</h4>
          <p class="wi-reason">{{ it.reason }}</p>
          <div class="wi-meta">
            <span v-if="it.estimated_points" class="points-chip">预计 {{ it.estimated_points }} 分</span>
            <span v-else class="points-chip muted">积分待定</span>
          </div>
          <div class="wi-foot">
            <span v-if="it.status === 'reviewing' && !it.locked_by_me" class="lock-hint">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.6" />
                <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
              </svg>
              {{ reviewerLabel(it) }} 审核中
            </span>
            <button
              v-else
              class="btn btn-primary wi-btn"
              type="button"
              :disabled="claimingId === it.id"
              @click="startReview(it)"
            >
              {{ claimingId === it.id ? '接手…' : it.status === 'reviewing' ? '继续审核' : '我来审核' }}
            </button>
          </div>
        </article>
      </div>
    </template>

    <!-- 审核历史 -->
    <template v-else>
      <div v-if="!history.length" class="wish-empty">还没有审核记录</div>
      <div v-else class="wish-history">
        <article v-for="it in history" :key="it.id" class="history-item">
          <div class="hi-top">
            <span :class="['status-chip', it.status]">{{ statusLabel(it) }}</span>
            <span class="hi-child">{{ it.child_name }}</span>
            <span class="hi-time">{{ fmtDateTime(it.reviewed_at) }}</span>
          </div>
          <div class="hi-wish">
            <strong>{{ it.title }}</strong>
            <span class="hi-reason">{{ it.reason }}</span>
            <span v-if="it.estimated_points" class="hi-points">预计 {{ it.estimated_points }} 分</span>
          </div>
          <div v-if="it.status === 'approved'" class="hi-result">
            上架商品「{{ productOf(it).name }}」 · {{ productOf(it).cost }} 分
            · 库存 {{ productOf(it).stock < 0 ? '不限' : productOf(it).stock }}
            <template v-if="productOf(it).category_name"> · {{ productOf(it).category_name }}</template>
          </div>
          <div v-if="it.review_note" :class="['hi-note', { warn: it.status === 'rejected' }]">
            审核留言：{{ it.review_note }}
          </div>
          <div class="hi-reviewer">审核人：{{ reviewerLabel(it) }} · {{ fmtDateTime(it.reviewed_at) }}</div>
        </article>
      </div>
    </template>
  </GlassCard>

  <!-- 孩子端：我的心愿 -->
  <GlassCard v-else class="wish-card" padding="16px 18px">
    <div class="wish-head">
      <div class="wish-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 12v8H4v-8" />
          <path d="M2 7h20v5H2z" />
          <path d="M12 22V7" />
          <path d="M12 7S10.6 3 8.1 3a2.4 2.4 0 0 0 0 4.8H12Z" />
          <path d="M12 7s1.4-4 3.9-4a2.4 2.4 0 0 1 0 4.8H12Z" />
        </svg>
      </div>
      <div class="wish-head-text">
        <div class="wish-title">我的心愿单</div>
        <div class="wish-sub">写下想要的礼物和理由，爸爸妈妈审核后会放进商城</div>
      </div>
      <button class="btn btn-primary wish-new" type="button" @click="openCreate">许个心愿</button>
    </div>

    <div v-if="loading" class="wish-empty">加载中…</div>
    <div v-else-if="!items.length" class="wish-empty">还没有心愿，写下第一个愿望吧～</div>
    <div v-else class="wish-grid">
      <article v-for="it in items" :key="it.id" :class="['wish-item', it.status]">
        <div class="wi-top">
          <span :class="['status-chip', it.status]">{{ statusLabel(it) }}</span>
          <span class="wi-time">{{ fmtRelative(it.created_at) }}</span>
        </div>
        <h4 class="wi-title">{{ it.title }}</h4>
        <p class="wi-reason">{{ it.reason }}</p>
        <div class="wi-meta">
          <span v-if="it.estimated_points" class="points-chip">预计 {{ it.estimated_points }} 分</span>
          <span v-else class="points-chip muted">积分待定</span>
        </div>

        <div v-if="it.status === 'reviewing'" class="child-note">
          由 {{ reviewerLabel(it) }} 审核中
        </div>

        <div v-if="it.status === 'approved'" class="child-approved">
          <span>已上架：{{ productOf(it).name }} · {{ productOf(it).cost }} 分</span>
          <button class="link-btn" type="button" @click="goShop">去商城看看</button>
        </div>

        <div v-if="it.status === 'rejected' && it.review_note" class="child-note warn">
          未通过：{{ it.review_note }}
        </div>

        <div v-if="it.status === 'pending'" class="wi-foot">
          <span class="lock-hint">等待爸爸妈妈审核</span>
          <button class="ghost-link" type="button" @click="cancelWish(it)">撤回</button>
        </div>
      </article>
    </div>
  </GlassCard>

  <!-- 孩子：许愿弹窗 -->
  <Modal v-model="createOpen" title="许个心愿" width="460px" variant="playful" :close-on-mask="!creating">
    <form class="wish-form" @submit.prevent="submitWish">
      <label class="field">
        <span class="field-label">想要什么 <em>必填</em></span>
        <input v-model="createForm.title" maxlength="50" placeholder="例如：乐高小汽车" />
        <span class="field-hint">{{ createForm.title.length }} / 50</span>
      </label>

      <label class="field">
        <span class="field-label">为什么想要 <em>必填</em></span>
        <textarea
          v-model="createForm.reason"
          rows="4"
          maxlength="500"
          placeholder="说说你的理由，比如：我已经坚持自己整理房间一个月了"
        ></textarea>
        <span class="field-hint">{{ createForm.reason.length }} / 500</span>
      </label>

      <label class="field">
        <span class="field-label">预计要扣的积分 <span class="optional">选填</span></span>
        <input
          v-model="createForm.estimated"
          type="number"
          min="1"
          max="99999"
          inputmode="numeric"
          placeholder="不确定可以不填"
        />
        <span class="field-hint">只是你的预估，爸爸妈妈上架时可以调整</span>
      </label>

      <p v-if="submitError" class="form-error" role="alert">{{ submitError }}</p>

      <div class="form-actions">
        <button class="btn btn-ghost" type="button" :disabled="creating" @click="createOpen = false">取消</button>
        <!-- 既支持回车提交，也直接绑点击：避免某些浏览器/热更新状态下表单 submit 不触发 -->
        <button class="btn btn-primary" type="button" :disabled="creating" @click="submitWish">
          {{ creating ? '提交中…' : '提交心愿' }}
        </button>
      </div>
    </form>
  </Modal>

  <!-- 家长：审核弹窗 -->
  <Modal
    :model-value="reviewOpen"
    :title="dialogTitle"
    width="500px"
    :close-on-mask="false"
    :close-on-esc="!reviewing"
    @update:model-value="onReviewOpenChange"
  >
    <div v-if="reviewItem" class="wish-form">
      <div class="review-origin">
        <div class="ro-label">孩子的心愿</div>
        <div class="ro-title">{{ reviewItem.title }}</div>
        <p class="ro-reason">{{ reviewItem.reason }}</p>
        <span v-if="reviewItem.estimated_points" class="points-chip">预计 {{ reviewItem.estimated_points }} 分</span>
        <span v-else class="points-chip muted">积分待定</span>
      </div>

      <label class="field">
        <span class="field-label">上架商品名称 <em>必填</em></span>
        <input v-model="reviewForm.name" maxlength="50" placeholder="商城里的商品名" />
      </label>

      <div class="field-row">
        <label class="field">
          <span class="field-label">所需积分 <em>必填</em></span>
          <input v-model="reviewForm.cost" type="number" min="1" max="99999" inputmode="numeric" />
        </label>
        <label class="field">
          <span class="field-label">库存 <span class="optional">-1 表示不限</span></span>
          <input v-model="reviewForm.stock" type="number" min="-1" max="99999" inputmode="numeric" />
        </label>
      </div>

      <label class="field">
        <span class="field-label">放进哪个分类</span>
        <select v-model="reviewForm.category_id">
          <option value="">不分类</option>
          <option v-for="c in categories" :key="c.id" :value="String(c.id)">{{ c.name }}</option>
        </select>
      </label>

      <label class="field">
        <span class="field-label">审核留言 <span class="optional">不通过时必填</span></span>
        <textarea
          v-model="reviewForm.note"
          rows="3"
          maxlength="200"
          placeholder="例如：这次先不通过，等你把房间整理坚持两周再来许愿"
        ></textarea>
        <span class="field-hint">通过时可以不填；不通过的原因孩子会看到</span>
      </label>

      <div class="lock-note">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.6" />
          <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
        </svg>
        你正在审核，其他家长暂时不能操作；关闭弹窗会释放这个心愿
      </div>

      <div class="form-actions">
        <button class="btn btn-ghost" type="button" :disabled="reviewing" @click="closeReview">取消</button>
        <button class="btn btn-danger" type="button" :disabled="reviewing" @click="submitReview(false)">不通过</button>
        <button class="btn btn-primary" type="button" :disabled="reviewing" @click="submitReview(true)">
          {{ reviewing ? '提交中…' : '通过并上架' }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.wish-card {
  margin-bottom: var(--space-20);
  border: 1px solid rgba(255, 196, 92, 0.4);
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.74), rgba(255, 248, 232, 0.64));
}

.wish-head {
  display: flex;
  align-items: center;
  gap: var(--space-12);
}
.wish-icon {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-full);
  color: var(--text-on-orange);
  background: rgba(255, 180, 84, 0.16);
  border: 1px solid rgba(255, 180, 84, 0.32);
}
.wish-icon svg { width: 22px; height: 22px; }
.wish-head-text { flex: 1; min-width: 0; }
.wish-title {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  font-family: var(--font-cute);
  font-size: var(--fs-lg);
}
.wish-sub {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-top: var(--space-2);
  line-height: 1.5;
}

.wish-badge {
  min-width: 20px;
  height: 20px;
  padding: 0 var(--space-6);
  border-radius: var(--r-pill);
  background: var(--danger);
  color: #fff;
  font-size: var(--fs-xs);
  font-family: var(--font-body);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.wish-new {
  flex-shrink: 0;
  padding: var(--space-8) var(--space-16);
  font-size: var(--fs-sm);
}

/* ── 分段控件 ─────────────────────────────────────────────────────────── */
.wish-tabs {
  display: flex;
  gap: var(--space-4);
  margin-top: var(--space-14);
  padding: var(--space-4);
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid var(--glass-border);
}
.wish-tab {
  flex: 1;
  padding: var(--space-8) var(--space-12);
  border-radius: var(--r-pill);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.wish-tab:hover { background: rgba(255, 180, 84, 0.12); }
.wish-tab.active {
  background: linear-gradient(135deg, rgba(255, 180, 84, 0.26), rgba(255, 155, 176, 0.22));
  color: var(--text-on-orange);
  font-weight: 600;
}
.wish-tab:focus-visible { outline: 2px solid var(--accent-orange); outline-offset: 1px; }
.tab-count { font-size: var(--fs-xs); opacity: 0.8; }

/* ── 心愿卡片 ─────────────────────────────────────────────────────────── */
.wish-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: var(--space-10);
  margin-top: var(--space-12);
}
.wish-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  min-width: 0;
  padding: var(--space-12);
  border-radius: var(--r-md);
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.wish-item:hover { box-shadow: 0 8px 20px rgba(180, 140, 90, 0.1); }
.wish-item.reviewing {
  border-color: rgba(132, 197, 255, 0.55);
  background: rgba(240, 249, 255, 0.6);
}
.wish-item.approved { border-color: rgba(126, 212, 185, 0.5); }
.wish-item.rejected { border-color: rgba(255, 140, 160, 0.42); }

.wi-top {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  min-width: 0;
}
.wi-child {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wi-time {
  margin-left: auto;
  flex-shrink: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.wi-title {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  line-height: 1.4;
  word-break: break-word;
}
.wi-reason {
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.wi-meta { display: flex; flex-wrap: wrap; gap: var(--space-6); }
.wi-foot {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  margin-top: auto;
  padding-top: var(--space-4);
}
.wi-btn { margin-left: auto; padding: var(--space-6) var(--space-14); font-size: var(--fs-sm); }

.status-chip {
  flex-shrink: 0;
  padding: 2px var(--space-8);
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  line-height: 1.6;
}
.status-chip.pending { background: rgba(255, 209, 102, 0.24); color: var(--text-on-yellow); }
.status-chip.reviewing { background: rgba(132, 197, 255, 0.24); color: var(--text-on-sky); }
.status-chip.approved { background: rgba(126, 212, 185, 0.24); color: var(--text-on-mint); }
.status-chip.rejected { background: rgba(255, 140, 160, 0.18); color: var(--text-on-red); }
.status-chip.cancelled { background: rgba(90, 58, 74, 0.08); color: var(--text-muted); }

.points-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--space-8);
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  background: rgba(255, 180, 84, 0.16);
  color: var(--text-on-orange);
}
.points-chip.muted { background: rgba(90, 58, 74, 0.06); color: var(--text-muted); }

.lock-hint {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.4;
}
.lock-hint svg { width: 13px; height: 13px; flex-shrink: 0; }

.child-note {
  font-size: var(--fs-xs);
  color: var(--text-on-sky);
  background: rgba(132, 197, 255, 0.14);
  border-radius: var(--r-sm);
  padding: var(--space-6) var(--space-8);
  line-height: 1.5;
}
.child-note.warn { color: var(--text-on-red); background: rgba(255, 140, 160, 0.12); }

.child-approved {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-8);
  font-size: var(--fs-xs);
  color: var(--text-on-mint);
  background: rgba(126, 212, 185, 0.14);
  border-radius: var(--r-sm);
  padding: var(--space-6) var(--space-8);
}
.link-btn, .ghost-link {
  padding: 0;
  font-size: var(--fs-xs);
  color: var(--text-on-orange);
  text-decoration: underline;
  cursor: pointer;
}
.ghost-link { margin-left: auto; color: var(--text-muted); }
.link-btn:focus-visible, .ghost-link:focus-visible { outline: 2px solid var(--accent-orange); outline-offset: 2px; }

.wish-empty {
  padding: var(--space-24) 0;
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

/* ── 审核历史 ─────────────────────────────────────────────────────────── */
.wish-history {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
  margin-top: var(--space-12);
}
.history-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  padding: var(--space-12) var(--space-14);
  border-radius: var(--r-md);
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
}
.hi-top { display: flex; align-items: center; gap: var(--space-8); }
.hi-child { font-size: var(--fs-sm); color: var(--text-secondary); }
.hi-time { margin-left: auto; font-size: var(--fs-xs); color: var(--text-muted); }
.hi-wish { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-6); }
.hi-wish strong { font-family: var(--font-cute); font-size: var(--fs-md); }
.hi-reason { font-size: var(--fs-xs); color: var(--text-muted); }
.hi-points { font-size: var(--fs-xs); color: var(--text-on-orange); }
.hi-result {
  font-size: var(--fs-sm);
  color: var(--text-on-mint);
  background: rgba(126, 212, 185, 0.12);
  border-radius: var(--r-sm);
  padding: var(--space-6) var(--space-8);
  line-height: 1.5;
}
.hi-note {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  background: rgba(90, 58, 74, 0.05);
  border-radius: var(--r-sm);
  padding: var(--space-6) var(--space-8);
  line-height: 1.5;
}
.hi-note.warn { color: var(--text-on-red); background: rgba(255, 140, 160, 0.1); }
.hi-reviewer { font-size: var(--fs-xs); color: var(--text-muted); }

/* ── 表单 ─────────────────────────────────────────────────────────────── */
.wish-form { display: flex; flex-direction: column; gap: var(--space-14); }
.field { display: flex; flex-direction: column; gap: var(--space-6); }
.field-label {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-secondary);
}
.field-label em {
  font-style: normal;
  font-size: var(--fs-2xs);
  font-weight: 500;
  color: var(--text-on-red);
  background: rgba(255, 140, 160, 0.14);
  border-radius: var(--r-2xs);
  padding: 1px var(--space-4);
  margin-left: var(--space-4);
}
.optional {
  font-size: var(--fs-xs);
  font-weight: 400;
  color: var(--text-muted);
  margin-left: var(--space-4);
}
.field-hint { font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-10); }

.review-origin {
  padding: var(--space-12);
  border-radius: var(--r-md);
  border: 1px dashed rgba(255, 180, 84, 0.55);
  background: rgba(255, 250, 238, 0.7);
}
.ro-label { font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: var(--space-4); }
.ro-title { font-family: var(--font-cute); font-size: var(--fs-lg); }
.ro-reason {
  margin: var(--space-6) 0 var(--space-8);
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.lock-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-6);
  padding: var(--space-8) var(--space-10);
  border-radius: var(--r-sm);
  background: rgba(132, 197, 255, 0.12);
  color: var(--text-on-sky);
  font-size: var(--fs-xs);
  line-height: 1.5;
}
.lock-note svg { width: 14px; height: 14px; flex-shrink: 0; margin-top: 1px; }

.form-error {
  margin: var(--space-8) 0 0;
  padding: var(--space-8) var(--space-12);
  border-radius: var(--r-sm);
  background: rgba(238, 106, 122, 0.12);
  color: var(--text-on-red);
  font-size: var(--fs-sm);
  line-height: 1.5;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-10);
  flex-wrap: wrap;
  margin-top: var(--space-4);
}

@media (max-width: 560px) {
  .wish-head { flex-wrap: wrap; }
  .wish-new { width: 100%; }
  .wish-grid { grid-template-columns: 1fr; }
  .field-row { grid-template-columns: 1fr; }
  .form-actions .btn { flex: 1; }
}
</style>
