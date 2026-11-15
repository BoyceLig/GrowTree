<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import GlassCard from '@/components/GlassCard.vue';
import EmptyState from '@/components/EmptyState.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import CategoryIcon from '@/components/CategoryIcon.vue';
import RejectModal from '@/components/RejectModal.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import WishReviewModal from '@/components/WishReviewModal.vue';
import {
  type ReviewItem,
  mergePending,
  mergeProcessed,
  summarize,
  tagText,
  tagTone,
  summaryOf,
} from '@/utils/review';
import { fmtTimerPair, isTimerLive } from '@/utils/duration';

/**
 * 审核面板：兑换申请与任务完成申请**混排成一条时间线**。
 *
 * 为什么不再分「兑换 / 任务」两个大 tab：两类申请的家长动作完全一样（看一眼 → 通过 / 拒绝），
 * 拆成两组反而要求家长先判断"这条属于哪一类"再切页。按提交时间倒序混排、每条自带类型标签，
 * 与「待办」的心智模型一致 —— 你要处理的是**一件事**，不是"某一类事"。
 * （合并与排序的规则抽在 utils/review.ts，可用 .workbuddy/review-timeline/ 定数据直测。）
 *
 * 为什么「已处理」默认折叠：它的数据要 4 个请求（后端 status 无 all 选项，
 * 见 server/src/routes/exchange-requests.ts:131 与 adhoc-tasks.ts:181，都是 `WHERE status = ?`），
 * 而绝大多数打开只是来处理待办的。折叠后默认只发 2 个请求，展开才补。
 *
 * 同一份组件同时供「总览页弹窗」与「/parent/review 整页」使用：embedded 时去掉页面级
 * 内边距与标题（弹窗自己已经有标题栏与内边距），其余行为完全一致，避免两处实现漂移。
 */
withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });

const toast = useToastStore();

const pending = ref<ReviewItem[]>([]);
const processed = ref<ReviewItem[]>([]);
const loading = ref(true);
const loadingProcessed = ref(false);
const showProcessed = ref(false);
const processingKey = ref<string | null>(null);

/* ── 心愿单：需要先抢单锁，再在弹窗里补充商品信息 ─────────────────────── */
const wishClaimingKey = ref<string | null>(null);
const wishOpen = ref(false);
const wishTarget = ref<any | null>(null);

const rejectTarget = ref<ReviewItem | null>(null);
const rejectOpen = ref(false);
/** single=单条拒绝（拒绝原因只作用于一条）；batch=批量拒绝（同一个原因应用到选中的所有条） */
const rejectMode = ref<'single' | 'batch'>('single');

const confirmOpen = ref(false);
const confirmMessage = ref('');
const confirmAction = ref<(() => Promise<void>) | null>(null);

/* ── 多选 / 全选 / 批量审核 ────────────────────────────────────────────────
   用 key（`exchange:3` 这种带类型前缀的字符串）而不是数字 id 记选中项：
   兑换与任务的自增 id 各自独立，两家的 id=7 是两条不同的申请，直接存 id 会串。 */
const selectedKeys = ref<Set<string>>(new Set());
const batchRunning = ref(false);
const batchDone = ref(0);
const batchTotal = ref(0);

/* ── 按孩子统计 / 筛选 ──────────────────────────────────────────────────────
   孩子清单直接从待办里派生（每条都带 user_id/name/avatar），不用额外请求；
   筛选只作用在「待审核」上 —— 已处理是历史流水，按人切片的价值不大。 */
const childFilter = ref<number | null>(null);

/** 待办里出现过的孩子 + 各自条数，条数多的排前面 */
const pendingChildren = computed(() => {
  const map = new Map<number, { id: number; name: string; avatar: string; count: number }>();
  for (const it of pending.value) {
    const cur = map.get(it.user_id);
    if (cur) cur.count++;
    else map.set(it.user_id, { id: it.user_id, name: it.user_name, avatar: it.user_avatar, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.id - b.id);
});

/** 当前筛选下要展示的待办 */
const visiblePending = computed(() =>
  childFilter.value === null ? pending.value : pending.value.filter((i) => i.user_id === childFilter.value)
);

/** 筛选后如果这个孩子没有待办了，自动回到「全部」，避免停在空白页 */
watch(pendingChildren, (list) => {
  if (childFilter.value !== null && !list.some((c) => c.id === childFilter.value)) childFilter.value = null;
});

/** 换孩子之后，之前选中的（现在看不见的）条目要一起丢掉 */
watch(childFilter, () => pruneSelection());

const summary = computed(() => summarize(visiblePending.value));

/** 心愿单需要补充商品信息，不能走批量通过/拒绝，因此不参与勾选 */
const selectablePending = computed(() => visiblePending.value.filter((i) => i.kind !== 'wish'));

const selectedItems = computed(() => selectablePending.value.filter((i) => selectedKeys.value.has(i.key)));
const selectedCount = computed(() => selectedItems.value.length);
const allSelected = computed(
  () => selectablePending.value.length > 0 && selectedCount.value === selectablePending.value.length
);
const halfSelected = computed(() => selectedCount.value > 0 && !allSelected.value);

/** 选中项按类型聚合的加减分合计，放在批量通过确认框里，避免误点 */
const batchBreakdown = computed(() => {
  const tasks = selectedItems.value.filter((i) => i.kind !== 'exchange');
  const exchanges = selectedItems.value.filter((i) => i.kind === 'exchange');
  const plus = tasks.reduce((s, i) => s + (i.task_points ?? 0), 0);
  const minus = exchanges.reduce((s, i) => s + (i.points ?? 0), 0);
  const parts: string[] = [];
  if (tasks.length) parts.push(`任务是 ${tasks.length} 条（+${plus} 分）`);
  if (exchanges.length) parts.push(`兑换 ${exchanges.length} 条（-${minus} 分）`);
  return parts.join('，');
});

/** 列表刷新后丢掉已经不在「当前可见列表」里的选中项
 *  —— 用 visiblePending 而不是 pending：切换孩子筛选时，看不见的条目不该继续被全选/批量带走 */
function pruneSelection() {
  const alive = new Set(visiblePending.value.map((i) => i.key));
  const next = new Set([...selectedKeys.value].filter((k) => alive.has(k)));
  if (next.size !== selectedKeys.value.size) selectedKeys.value = next;
}

function toggleSelect(it: ReviewItem) {
  if (it.kind === 'wish') return;
  const next = new Set(selectedKeys.value);
  if (next.has(it.key)) next.delete(it.key);
  else next.add(it.key);
  selectedKeys.value = next;
}

function toggleSelectAll() {
  selectedKeys.value = allSelected.value ? new Set() : new Set(selectablePending.value.map((i) => i.key));
}

async function loadPending() {
  const [ex, tk, rc, ws] = await Promise.all([
    api.get<{ requests: any[] }>('/exchange-requests?status=pending'),
    api.get<{ completions: any[] }>('/adhoc-tasks/completions?status=pending'),
    api.get<{ completions: any[] }>('/recurring-tasks/claims?status=pending'),
    api.get<{ pending: any[] }>('/wish-requests'),
  ]);
  pending.value = mergePending(ex.requests, tk.completions, rc.completions, ws.pending);
  pruneSelection();
}

async function loadProcessed() {
  loadingProcessed.value = true;
  try {
    const [exOk, exNo, tkOk, tkNo, rcOk, rcNo, ws] = await Promise.all([
      api.get<{ requests: any[] }>('/exchange-requests?status=approved'),
      api.get<{ requests: any[] }>('/exchange-requests?status=rejected'),
      api.get<{ completions: any[] }>('/adhoc-tasks/completions?status=approved'),
      api.get<{ completions: any[] }>('/adhoc-tasks/completions?status=rejected'),
      api.get<{ completions: any[] }>('/recurring-tasks/claims?status=approved'),
      api.get<{ completions: any[] }>('/recurring-tasks/claims?status=rejected'),
      api.get<{ history: any[] }>('/wish-requests'),
    ]);
    processed.value = mergeProcessed(
      exOk.requests,
      exNo.requests,
      tkOk.completions,
      tkNo.completions,
      rcOk.completions,
      rcNo.completions,
      ws.history
    );
  } finally {
    loadingProcessed.value = false;
  }
}

/** 角标（家长端右下角入口）的数字来自 /dashboard，这里只负责喊它重新拉一次 */
function notifyBadge() {
  window.dispatchEvent(new Event('review:updated'));
}

async function load() {
  loading.value = true;
  try {
    await loadPending();
  } catch (e: any) {
    toast.error(e.message || '加载失败');
  } finally {
    loading.value = false;
    notifyBadge();
  }
}

/** 处理完一条之后：待审核必须重拉；已处理展开着也顺带刷新，否则刚点的那条会消失得莫名其妙 */
async function refresh() {
  await loadPending();
  if (showProcessed.value) await loadProcessed();
  notifyBadge();
}

async function toggleProcessed() {
  showProcessed.value = !showProcessed.value;
  if (showProcessed.value && processed.value.length === 0) {
    try {
      await loadProcessed();
    } catch (e: any) {
      toast.error(e.message || '加载失败');
    }
  }
}

/** 三类申请的审核动作地址（单条与批量共用同一套映射，避免两处漂移） */
function actionUrl(it: ReviewItem, action: 'approve' | 'reject'): string {
  if (it.kind === 'exchange') return `/exchange-requests/${it.id}/${action}`;
  if (it.kind === 'recurring') return `/recurring-tasks/claims/${it.id}/${action}`;
  return `/adhoc-tasks/completions/${it.id}/${action}`;
}

function errText(e: any): string {
  const err = e?.payload?.error;
  if (err === 'already_reviewed') return '已被处理';
  if (err === 'insufficient_points') return '积分不足';
  if (err === 'not_found') return '申请不存在';
  return e?.message || '处理失败';
}

function handleError(e: any) {
  const err = e?.payload?.error;
  if (err === 'already_reviewed') toast.warning('该申请已处理过，正在刷新列表');
  else if (err === 'insufficient_points') toast.error('该小朋友积分不足，兑换未通过');
  else toast.error(e?.message || '操作失败');
}

/** 卡片标题上方的小标签：让孩子/家长一眼分清「名称」和「理由」 */
function cardTitleLabel(it: ReviewItem): string {
  if (it.kind === 'wish') return '商品名称';
  if (it.kind === 'exchange') return it.exType === 'cash' ? '兑换内容' : '商品名称';
  return '任务名称';
}

/** 申请理由：心愿单一定有；任务完成如果孩子写了说明也一并展示 */
function cardReason(it: ReviewItem): string {
  if (it.kind === 'wish') return it.wish_reason || '';
  return it.reason || '';
}

/** 心愿单审核人展示：昵称（身份），两者相同不重复 */
function wishReviewerLabel(it: ReviewItem): string {
  const name = it.wish_reviewer_name || '家长';
  const identity = it.wish_reviewer_identity || '家长';
  return name === identity ? name : `${name}（${identity}）`;
}

async function startWishReview(it: ReviewItem) {
  if (it.wish_status === 'reviewing' && !it.wish_locked_by_me) return;
  wishClaimingKey.value = it.key;
  try {
    const res = await api.post<{ item: any }>(`/wish-requests/${it.id}/claim`);
    wishTarget.value = res.item;
    wishOpen.value = true;
  } catch (e: any) {
    toast.error(e.message || '暂时无法接手这个心愿');
    if (e?.status === 409) await refresh();
  } finally {
    wishClaimingKey.value = null;
  }
}

async function onWishDone() {
  wishOpen.value = false;
  wishTarget.value = null;
  await refresh();
}

function askApprove(it: ReviewItem) {
  if (it.kind === 'wish') {
    startWishReview(it);
    return;
  }
  confirmMessage.value =
    it.kind === 'exchange'
      ? `通过${it.user_name}的兑换申请？将扣除 ${it.points} 积分`
      : it.kind === 'recurring'
        ? `通过${it.user_name}的「${it.task_name}」（${it.period_key}）完成申请？将加 ${it.task_points} 积分`
        : `通过${it.user_name}的「${it.task_name}」完成申请？将加 ${it.task_points} 积分`;
  confirmAction.value = () => doApprove(it);
  confirmOpen.value = true;
}

async function doApprove(it: ReviewItem) {
  processingKey.value = it.key;
  try {
    const res = await api.post<{ ok: boolean; newBalance: number }>(actionUrl(it, 'approve'), {});
    toast.success(
      it.kind === 'exchange'
        ? `已通过，${it.user_name} 剩余 ${res.newBalance} 分`
        : `已通过，${it.user_name} 当前 ${res.newBalance} 分`
    );
    await refresh();
  } catch (e: any) {
    handleError(e);
    // 已处理过的条目还留在列表里，刷新一次让它消失，否则家长会反复点同一个按钮
    if (e?.payload?.error === 'already_reviewed') await refresh();
  } finally {
    processingKey.value = null;
  }
}

/* ── 批量审核 ────────────────────────────────────────────────────────────
   刻意**不新增后端批量接口**：三类申请的通过/拒绝各自带着扣库存、退积分、写流水、
   推 WebSocket 等副作用，逐个调用现成接口能原样复用这些事务；而 better-sqlite3 是
   同步 API、Node 又是单线程，串行发请求本来就是顺序执行的，不存在并发写冲突。
   批量要补的只是"进度反馈 + 部分失败的汇总"，那是纯前端的事。 */

async function runBatch(action: 'approve' | 'reject', reason?: string) {
  const items = selectedItems.value.slice();
  if (items.length === 0) return;

  batchRunning.value = true;
  batchDone.value = 0;
  batchTotal.value = items.length;

  const fails: string[] = [];
  let ok = 0;
  for (const it of items) {
    try {
      await api.post(actionUrl(it, action), action === 'reject' ? { reason } : {});
      ok += 1;
    } catch (e: any) {
      fails.push(`${it.user_name} ${summaryOf(it)}（${errText(e)}）`);
    }
    batchDone.value += 1;
  }

  batchRunning.value = false;
  batchTotal.value = 0;
  selectedKeys.value = new Set();

  try {
    await refresh();
  } catch {
    /* refresh 自己会 toast，这里不重复报 */
  }

  const verb = action === 'approve' ? '通过' : '拒绝';
  if (fails.length === 0) {
    toast.success(`已批量${verb} ${ok} 条申请`);
  } else {
    const detail = fails.slice(0, 2).join('；');
    const more = fails.length > 2 ? `，等 ${fails.length} 条` : '';
    // 部分失败必须有明确的名字与原因 —— 只说"失败 2 条"家长根本不知道该补哪一条
    toast.warning(`${verb}成功 ${ok}/${items.length} 条，失败：${detail}${more}`);
  }
}

function askBatchApprove() {
  if (selectedCount.value === 0) return;
  confirmMessage.value = `通过选中的 ${selectedCount.value} 条申请？${batchBreakdown.value}`;
  confirmAction.value = () => runBatch('approve');
  confirmOpen.value = true;
}

function askBatchReject() {
  if (selectedCount.value === 0) return;
  rejectMode.value = 'batch';
  rejectTarget.value = null;
  rejectOpen.value = true;
}

function askReject(it: ReviewItem) {
  rejectMode.value = 'single';
  rejectTarget.value = it;
  rejectOpen.value = true;
}

/**
 * 拒绝原因由 RejectModal 收集后回传。
 * 这里刻意让弹窗只负责"取原因"，请求发往哪个接口由本组件决定 ——
 * 之前的 RejectModal 把兑换接口写死在自己身上，导致任务拒绝只能另走一套
 * ConfirmDialog，而那套里的 taskRejectReason 从未绑定过输入框，
 * 于是**任务拒绝原因恒为空字符串**，小朋友永远看不到为什么被拒。
 */
async function doReject(reason: string) {
  if (rejectMode.value === 'batch') {
    rejectOpen.value = false;
    await runBatch('reject', reason);
    return;
  }

  const it = rejectTarget.value;
  if (!it) return;
  processingKey.value = it.key;
  try {
    await api.post(actionUrl(it, 'reject'), { reason });
    toast.success(
      it.kind === 'exchange' ? '已拒绝，积分已退回' : `已拒绝${it.user_name}的完成申请`
    );
    rejectOpen.value = false;
    await refresh();
  } catch (e: any) {
    handleError(e);
  } finally {
    processingKey.value = null;
  }
}

async function runConfirm() {
  if (confirmAction.value) await confirmAction.value();
  confirmAction.value = null;
}

/** 拒绝弹窗的标题/说明：单条与批量两种口径 */
const rejectTitle = computed(() => {
  if (rejectMode.value === 'batch') return `批量拒绝（${selectedCount.value} 条）`;
  return rejectTarget.value?.kind === 'exchange' ? '拒绝兑换申请' : '拒绝任务完成';
});
const rejectHint = computed(() => {
  if (rejectMode.value === 'batch') {
    return `这 ${selectedCount.value} 条申请将使用同一个原因；兑换的积分会退回，任务完成后可重新提交`;
  }
  const it = rejectTarget.value;
  if (!it) return '';
  return it.kind === 'exchange'
    ? `拒绝后，积分将退回给 ${it.user_name}`
    : `拒绝后 ${it.user_name} 可以重新提交这个任务`;
});

function fmtTime(ts: number | null) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const diff = Date.now() - ts * 1000;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** 周期任务申请上的用时文案；没计过时返回空串（不显示「00:00」这种假数据）。
 *  待审核卡片旁边有「用时」标签，值里不再重复前缀 —— 弹窗一格宽度有限，
 *  「⏱ 用时 00:05（暂停 00:01）」会被截成「…（暂停 0」，纯时长刚好放下。 */
function usedText(it: ReviewItem): string {
  return fmtTimerPair(it.timer);
}

/** 已处理压扁卡片里没有标签，自带 ⏱ 前缀 */
function usedMiniText(it: ReviewItem): string {
  const pair = fmtTimerPair(it.timer);
  return pair ? `⏱ ${pair}` : '';
}

function usedLive(it: ReviewItem): boolean {
  return isTimerLive(it.timer);
}

// 收到新申请推送时，若面板正开着就自动刷新（面板只在弹窗/整页可见时挂载）
function onPush() {
  refresh().catch(() => {});
}

onMounted(() => {
  load();
  window.addEventListener('ws:new_exchange_request', onPush);
  window.addEventListener('ws:task_completion_submitted', onPush);
  window.addEventListener('ws:recurring_claim_submitted', onPush);
  window.addEventListener('ws:wish_request_created', onPush);
  window.addEventListener('ws:wish_requests_changed', onPush);
  window.addEventListener('ws:wish_request_reviewed', onPush);
});

onUnmounted(() => {
  window.removeEventListener('ws:new_exchange_request', onPush);
  window.removeEventListener('ws:task_completion_submitted', onPush);
  window.removeEventListener('ws:recurring_claim_submitted', onPush);
  window.removeEventListener('ws:wish_request_created', onPush);
  window.removeEventListener('ws:wish_requests_changed', onPush);
  window.removeEventListener('ws:wish_request_reviewed', onPush);
});
</script>

<template>
  <div :class="embedded ? 'panel' : 'page'">
    <header v-if="!embedded" class="page-header">
      <h1 class="title">审核中心</h1>
      <p class="subtitle">处理小朋友的兑换申请和任务完成申请</p>
    </header>

    <p v-if="!loading && summary.total > 0" class="summary">
      共 <strong>{{ summary.total }}</strong> 条待处理
      <span class="split">
        心愿单 {{ summary.wish }} · 商城兑换 {{ summary.exchange }} · 任务 {{ summary.task }}
      </span>
    </p>

    <!-- 按孩子统计 + 筛选：角标就是该孩子当前待办条数，点一下只看他的 -->
    <div v-if="!loading && pendingChildren.length > 0" class="child-bar">
      <button
        type="button"
        class="child-chip"
        :class="{ active: childFilter === null }"
        @click="childFilter = null"
      >全部小朋友</button>
      <button
        v-for="c in pendingChildren"
        :key="c.id"
        type="button"
        class="child-chip"
        :class="{ active: childFilter === c.id }"
        @click="childFilter = c.id"
      >
        <ZodiacAvatar :zodiac="c.avatar" :size="20" />
        <span class="chip-name">{{ c.name }}</span>
        <em>{{ c.count }}</em>
      </button>
    </div>

    <div v-if="loading" class="loading">正在加载…</div>

    <EmptyState
      v-else-if="visiblePending.length === 0"
      :emoji="childFilter === null ? '🎉' : '🙌'"
      :text="childFilter === null ? '没有待审核的申请' : '这个小朋友没有待审核的申请'"
      :hint="childFilter === null ? '小朋友提交兑换或完成任务后会出现在这里' : '换一个小朋友，或点「全部小朋友」看所有待办'"
    />

    <!-- 待审核：两类混排，按提交时间倒序 -->
    <div v-else class="list">
      <!-- 批量操作条：勾选后才显示批量按钮。滚动时吸顶，长列表里不必翻回顶部 -->
      <div v-if="selectablePending.length > 0" class="batch-bar">
        <label class="pick-all">
          <input
            type="checkbox"
            class="box"
            :checked="allSelected"
            :indeterminate.prop="halfSelected"
            :disabled="batchRunning"
            @change="toggleSelectAll"
          />
          <span class="pick-all-text">{{ allSelected ? '取消全选' : '全选' }}</span>
        </label>
        <span class="picked" :class="{ on: selectedCount > 0 }">
          已选 <strong>{{ selectedCount }}</strong> 条
        </span>
        <div class="batch-actions">
          <button
            class="btn btn-success small"
            :disabled="selectedCount === 0 || batchRunning"
            @click="askBatchApprove"
          >
            ✅ 批量通过
          </button>
          <button
            class="btn btn-danger small"
            :disabled="selectedCount === 0 || batchRunning"
            @click="askBatchReject"
          >
            ❌ 批量拒绝
          </button>
        </div>
      </div>

      <p v-if="batchRunning" class="batch-progress" role="status">
        正在处理 {{ batchDone }}/{{ batchTotal }} 条…
      </p>

      <div class="pending-grid">
        <GlassCard
          v-for="it in visiblePending"
          :key="it.key"
          padding="14px 18px"
          class="item"
          :class="{ picked: selectedKeys.has(it.key) }"
        >
        <div class="card-head">
          <ZodiacAvatar :zodiac="it.user_avatar" :size="40" />
          <div class="who">
            <div class="user-name">{{ it.user_name }}</div>
            <div class="time">{{ fmtTime(it.created_at) }}</div>
          </div>
          <span class="tag" :class="tagTone(it)">{{ tagText(it) }}</span>
        </div>

        <!-- 名称和理由各自带小标签：文字再多也能一眼分清哪行是什么 -->
        <div class="card-section">
          <span class="card-label">{{ cardTitleLabel(it) }}</span>
          <h4 v-if="it.kind === 'wish'" class="card-title">{{ it.wish_title }}</h4>
          <h4 v-else-if="it.kind === 'exchange' && it.exType === 'cash'" class="card-title cash-title">
            {{ it.amount }} 元现金
          </h4>
          <h4 v-else-if="it.kind === 'exchange'" class="card-title with-icon">
            <CategoryIcon :icon="it.product_icon" :size="20" />
            <span>{{ it.product_name || '已删除的商品' }}</span>
          </h4>
          <h4 v-else class="card-title">{{ it.task_name }}</h4>
        </div>

        <div v-if="cardReason(it)" class="card-section">
          <span class="card-label">申请理由</span>
          <p class="card-reason">{{ cardReason(it) }}</p>
        </div>

        <div class="meta-row">
          <template v-if="it.kind === 'wish'">
            <span class="meta-chip points" :class="{ muted: !it.estimated_points }">
              {{ it.estimated_points ? `预计 ${it.estimated_points} 分` : '积分待定' }}
            </span>
          </template>
          <template v-else-if="it.kind === 'exchange'">
            <span class="meta-chip minus">消耗 {{ it.points }} 分</span>
          </template>
          <template v-else-if="it.kind === 'recurring'">
            <span class="meta-chip plus">+{{ it.task_points }} 分</span>
            <span class="meta-chip">期次 {{ it.period_key }}</span>
            <span v-if="usedText(it)" class="meta-chip used" :class="{ live: usedLive(it) }">
              用时 {{ usedText(it) }}
            </span>
          </template>
          <template v-else>
            <span class="meta-chip plus">+{{ it.task_points }} 分</span>
          </template>
        </div>

        <div class="actions">
          <label v-if="it.kind !== 'wish'" class="pick foot-pick">
            <input
              type="checkbox"
              class="box"
              :checked="selectedKeys.has(it.key)"
              :disabled="batchRunning"
              :aria-label="`选择 ${it.user_name} 的${tagText(it)}申请`"
              @change="toggleSelect(it)"
            />
          </label>

          <div class="action-btns">
          <template v-if="it.kind === 'wish'">
            <span v-if="it.wish_status === 'reviewing' && !it.wish_locked_by_me" class="lock-hint">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.6" />
                <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
              </svg>
              {{ wishReviewerLabel(it) }} 审核中
            </span>
            <button
              v-else
              class="btn btn-primary small"
              :disabled="wishClaimingKey === it.key || batchRunning"
              @click="startWishReview(it)"
            >
              {{ wishClaimingKey === it.key ? '接手…' : it.wish_status === 'reviewing' ? '继续审核' : '审核' }}
            </button>
          </template>
          <template v-else>
            <button
              class="btn btn-success small"
              :disabled="processingKey === it.key || batchRunning"
              @click="askApprove(it)"
            >
              {{ processingKey === it.key ? '处理中...' : '✅ 通过' }}
            </button>
            <button
              class="btn btn-danger small"
              :disabled="processingKey === it.key || batchRunning"
              @click="askReject(it)"
            >
              ❌ 拒绝
            </button>
          </template>
          </div>
        </div>
        </GlassCard>
      </div>
    </div>

    <!-- 已处理：默认折叠，展开才请求 -->
    <div class="history">
      <button
        class="history-toggle"
        type="button"
        :aria-expanded="showProcessed ? 'true' : 'false'"
        @click="toggleProcessed"
      >
        <span class="chev" aria-hidden="true">{{ showProcessed ? '▾' : '▸' }}</span>
        {{ showProcessed ? '收起已处理记录' : '查看最近已处理' }}
      </button>

      <div v-if="showProcessed" class="history-body">
        <div v-if="loadingProcessed" class="loading">正在加载…</div>
        <p v-else-if="processed.length === 0" class="empty">还没有已处理的记录</p>
        <div v-else class="list">
          <GlassCard
            v-for="it in processed"
            :key="it.key"
            padding="12px 16px"
            class="item done"
          >
            <div class="head">
              <div class="user">
                <ZodiacAvatar :zodiac="it.user_avatar" :size="36" />
                <div class="who">
                  <div class="user-name">{{ it.user_name }}</div>
                  <div class="time">{{ fmtTime(it.reviewed_at ?? it.created_at) }}</div>
                </div>
              </div>
              <span class="tag" :class="tagTone(it)">{{ tagText(it) }}</span>
            </div>

            <div class="line">
              <span class="what">{{ summaryOf(it) }}</span>
              <span v-if="usedMiniText(it)" class="used-mini" :class="{ live: usedLive(it) }">{{ usedMiniText(it) }}</span>
              <span
                v-if="it.kind === 'wish'"
                class="pts wish-pts"
              >
                {{ it.estimated_points ? `预计 ${it.estimated_points} 分` : '积分待定' }}
              </span>
              <span v-else class="pts" :class="it.kind === 'task' || it.kind === 'recurring' ? 'plus' : 'minus'">
                {{ it.kind === 'task' || it.kind === 'recurring' ? '+' : '-' }}{{ it.kind === 'task' || it.kind === 'recurring' ? it.task_points : it.points }} 分
              </span>
            </div>

            <p v-if="it.kind === 'wish'" class="wish-history-reason">{{ it.wish_reason }}</p>

            <div class="result" :class="it.status">
              <span aria-hidden="true">{{ it.status === 'approved' ? '✅' : '❌' }}</span>
              <span v-if="it.kind === 'wish' && it.status === 'approved'">
                已上架「{{ it.wish_product_name || '商品' }}」 · {{ it.wish_product_cost ?? 0 }} 分
                <template v-if="it.wish_category_name"> · {{ it.wish_category_name }}</template>
              </span>
              <span v-else-if="it.status === 'approved'">已通过</span>
              <span v-else>已拒绝{{ it.reason ? `：${it.reason}` : '（未填原因）' }}</span>
            </div>

            <div v-if="it.kind === 'wish'" class="hi-reviewer">
              审核人：{{ wishReviewerLabel(it) }} · {{ fmtTime(it.reviewed_at) }}
            </div>
          </GlassCard>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-model="confirmOpen"
      title="确认通过"
      :message="confirmMessage"
      confirmText="通过"
      @confirm="runConfirm"
    />

    <RejectModal
      v-if="rejectTarget || rejectMode === 'batch'"
      v-model="rejectOpen"
      :title="rejectTitle"
      :hint="rejectHint"
      :saving="rejectMode === 'batch' ? batchRunning : processingKey === rejectTarget?.key"
      @submit="doReject"
    />

    <WishReviewModal v-model="wishOpen" :item="wishTarget" @done="onWishDone" />
  </div>
</template>

<style scoped>
.page-header { margin-bottom: var(--space-16); }
.title { font-size: var(--fs-3xl); margin-bottom: var(--space-2); }
.subtitle { color: var(--text-secondary); font-size: var(--fs-sm); }

.summary {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-bottom: var(--space-12);
}
.summary strong {
  color: var(--text-primary);
  font-size: var(--fs-lg);
  font-family: var(--font-cute);
}
.summary .split {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-left: var(--space-8);
}

/* ── 按孩子统计 / 筛选 ──────────────────────────────────────────────────── */
.child-bar {
  display: flex;
  gap: var(--space-8);
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  /* 上下留出选中态阴影的空间，再用负 margin 抵消占位（同商城筛选条的配方） */
  padding: 8px 10px 16px;
  margin: -8px 0 calc(var(--space-12) - 16px);
}
.child-bar::-webkit-scrollbar { display: none; }
.child-chip {
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
  min-height: 34px;
  box-sizing: border-box;
}
.child-chip:hover { color: var(--text-primary); }
.child-chip.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
  border-color: var(--accent-yellow);
  box-shadow: var(--shadow-pill);
  position: relative;
  z-index: 2;
}
.chip-name { max-width: 92px; overflow: hidden; text-overflow: ellipsis; }
.child-chip em {
  font-style: normal;
  font-size: var(--fs-2xs);
  color: var(--text-muted);
  background: rgba(90, 58, 74, 0.08);
  border-radius: var(--r-pill);
  padding: 0 var(--space-6);
}
.child-chip.active em { color: var(--text-on-yellow); background: rgba(255, 209, 102, 0.25); }

.loading,
.empty {
  padding: var(--space-24) 0;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.list { display: flex; flex-direction: column; gap: var(--space-12); }

/* 待审核卡片：沿用原心愿单的卡片宽度，横向自动排满，排不下就换到第二排 */
.pending-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  align-items: stretch;
  gap: var(--space-12);
}
.pending-grid .item {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.pending-grid .actions {
  margin-top: auto;
  padding-top: var(--space-10);
  border-top: 1px solid var(--glass-border);
  flex-wrap: wrap;
}

/* 卡片头部：头像固定左上，昵称与时间两行，类型标签靠右 */
.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  margin-bottom: var(--space-12);
}
.card-head .who { flex: 1; min-width: 0; }
.card-head .user-name {
  font-size: var(--fs-sm);
  font-weight: 600;
  line-height: 1.35;
}
.card-head .time { font-size: var(--fs-2xs); }
.card-head .tag { flex-shrink: 0; }

/* 名称 / 理由分组：每组带一个小标签，文字多也不会混在一起 */
.card-section + .card-section { margin-top: var(--space-10); }
.card-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: 3px;
  font-size: var(--fs-2xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.card-label::before {
  content: '';
  width: 3px;
  height: 10px;
  border-radius: var(--r-pill);
  background: currentColor;
  opacity: 0.45;
}

/* 标题：卡片里最大的一级，先看清审核对象 */
.card-title {
  margin: 0;
  font-family: var(--font-cute);
  font-size: var(--fs-lg);
  font-weight: 700;
  line-height: 1.35;
  color: var(--text-primary);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-title.cash-title { color: var(--text-on-yellow); }
.card-title.with-icon {
  display: flex;
  align-items: center;
  gap: var(--space-8);
}
.card-title.with-icon span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 心愿理由：比标题小一档，最多两行，不抢标题 */
.card-reason {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 元信息：积分/期次/用时做成小胶囊，扫一眼即可 */
.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
  margin: var(--space-12) 0;
}
.meta-chip {
  padding: 3px var(--space-8);
  border-radius: var(--r-pill);
  font-size: var(--fs-2xs);
  line-height: 1.5;
  white-space: nowrap;
  background: rgba(90, 58, 74, 0.06);
  color: var(--text-secondary);
}
.meta-chip.points { background: rgba(255, 180, 84, 0.16); color: var(--text-on-orange); }
.meta-chip.minus { background: rgba(255, 140, 160, 0.14); color: var(--text-on-red); }
.meta-chip.plus { background: rgba(126, 212, 185, 0.16); color: var(--text-on-mint); }
.meta-chip.used { background: rgba(132, 197, 255, 0.14); color: var(--text-on-sky); }
.meta-chip.used.live { background: rgba(255, 180, 84, 0.16); color: var(--text-on-orange); }
.meta-chip.muted { background: rgba(90, 58, 74, 0.06); color: var(--text-muted); }

/* 底部操作：勾选放左下，按钮靠右，和上面内容用一条淡分隔线隔开 */
.foot-pick {
  width: 32px;
  height: 32px;
  margin-left: calc(-1 * var(--space-4));
}
.action-btns {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-8);
  flex-wrap: wrap;
}

@media (max-width: 560px) {
  .pending-grid { grid-template-columns: 1fr; }
}

/* ── 批量操作条 ─────────────────────────────────────────────────────────
   吸顶：待办可能有十几条，勾完最后一条还要滚回顶部才能点「批量通过」是最烦的。
   底色必须不透明（--glass-bg-strong + 模糊），否则滚动时下面的卡片会透出来。 */
.batch-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-10);
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  border: 1px solid var(--glass-border);
  background: var(--glass-bg-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow);
}
.pick-all {
  display: inline-flex;
  align-items: center;
  gap: var(--space-8);
  cursor: pointer;
  user-select: none;
}
.pick-all-text { font-size: var(--fs-sm); font-weight: 600; color: var(--text-secondary); }

.picked { font-size: var(--fs-xs); color: var(--text-muted); }
.picked.on { color: var(--text-on-orange); }
.picked strong { font-family: var(--font-cute); font-size: var(--fs-md); }

.batch-actions { margin-left: auto; display: flex; gap: var(--space-8); }

.batch-progress {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-on-orange);
  text-align: center;
}

/* 自绘圆形复选框：原生 checkbox 在各端 WebView 里样式不一、默认尺寸也偏小。
   appearance:none 之后仍需自己覆盖全局 input 的 width/padding/border-radius。
   勾选态的浅橙渐变 + 深色勾，与 .btn-success 用深色文字是同一个理由：
   白勾压在 #ffb454/#ff9bb0 上只有 1.44–1.99:1，图形也辨不清。 */
.box {
  appearance: none;
  -webkit-appearance: none;
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: var(--r-full);
  border: 1.5px solid rgba(90, 58, 74, 0.28);
  background: var(--glass-bg-strong);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background var(--dur-fast), border-color var(--dur-fast);
}
.box::after {
  content: '✓';
  font-size: 13px;
  line-height: 1;
  font-weight: 700;
  color: var(--text-primary);
  opacity: 0;
  transform: scale(0.6);
  transition: opacity var(--dur-fast), transform var(--dur-fast);
}
.box:checked,
.box:indeterminate {
  border-color: transparent;
  background: linear-gradient(135deg, var(--accent-orange), var(--accent-pink));
}
.box:checked::after { opacity: 1; transform: scale(1); }
/* 半选（勾了一部分）：不显示勾，显示一条横杠 */
.box:indeterminate::after {
  content: '';
  width: 10px;
  height: 2px;
  border-radius: var(--r-pill);
  background: var(--text-primary);
  opacity: 1;
  transform: none;
}
.box:disabled { cursor: default; opacity: 0.55; }

/* 卡片上的勾选热区：视觉 22px，可点区域 40×40（移动端建议 44，这里受卡片高度限制） */
.pick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  margin-left: calc(-1 * var(--space-8));
  cursor: pointer;
}

.item.picked { box-shadow: 0 0 0 2px var(--accent-orange), var(--glass-shadow); }

.head {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  margin-bottom: var(--space-12);
}
.user { display: flex; align-items: center; gap: var(--space-10); min-width: 0; }
.who { min-width: 0; }
.user-name {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.time { font-size: var(--fs-xs); color: var(--text-muted); }

/* 类型标签：文字一律用 --text-on-*（装饰强调色对白底只有 1.44–2.53:1），
   底色用同色相的浅色 —— 与 B2 定下的「颜色角色不兼职」约定一致 */
.tag {
  flex-shrink: 0;
  /* head 从 space-between 改成默认排列：多了一个复选框后，靠 space-between 会把
     头像和复选框之间也撑开。改成只有 tag 自己靠右，头像紧贴复选框。 */
  margin-left: auto;
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.tag.wish { background: rgba(255, 155, 176, 0.2); color: var(--text-on-red); }
.tag.product { background: rgba(132, 197, 255, 0.2); color: var(--text-on-sky); }
.tag.cash { background: rgba(255, 209, 102, 0.2); color: var(--text-on-yellow); }
.tag.task { background: rgba(126, 212, 185, 0.2); color: var(--text-on-mint); }
.tag.recurring { background: rgba(255, 152, 92, 0.18); color: var(--text-on-orange); }

.detail {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-24);
  padding: var(--space-10) 0;
  border-top: 1px solid var(--glass-border);
  border-bottom: 1px solid var(--glass-border);
  margin-bottom: var(--space-12);
}
.field { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.label { font-size: var(--fs-xs); color: var(--text-muted); }
.value {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.value.with-icon { display: inline-flex; align-items: center; gap: var(--space-8); }
.value.cash { color: var(--text-on-yellow); }
.value.minus { color: var(--text-on-red); }
.value.plus { color: var(--text-on-mint); }
/* 用时：等宽数字（避免秒数跳动时整行宽度抖动），计时中用橙色提示「还在跑」。
   带暂停时较长，允许换行 —— 被 ellipsis 截成「00:05（暂停 0…」就失去意义了 */
.value.used { color: var(--text-on-sky); font-variant-numeric: tabular-nums; white-space: normal; line-height: 1.35; }
.value.used.live { color: var(--text-on-orange); font-weight: 700; }
.lock-hint {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.lock-hint svg { width: 13px; height: 13px; flex-shrink: 0; }

.actions { display: flex; gap: var(--space-8); }
.small { padding: var(--space-6) var(--space-14); font-size: var(--fs-sm); }

/* 已处理 */
.history {
  margin-top: var(--space-20);
  padding-top: var(--space-16);
  border-top: 1px solid var(--glass-border);
}
.history-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-6);
  padding: var(--space-6) var(--space-8);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  font-weight: 600;
  transition: background var(--dur-fast);
}
.history-toggle:hover { background: var(--glass-bg); }
.chev { font-size: var(--fs-xs); }
.history-body { margin-top: var(--space-12); }

.item.done { opacity: 0.92; }
.line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-12);
  font-size: var(--fs-sm);
}
.what {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 这一行现在可能有三个块（摘要 · 用时 · 积分），摘要必须能被压缩，
     否则时间太长（如「周期任务（2026-10-08）」）时会把积分挤出卡片 */
  flex: 1 1 auto;
  min-width: 0;
}
/* 已处理记录里的用时：小一号、不抢积分的位置 */
.used-mini {
  font-size: var(--fs-xs);
  color: var(--text-on-sky);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  white-space: nowrap;
}
.used-mini.live { color: var(--text-on-orange); font-weight: 600; }
.pts { font-family: var(--font-cute); font-weight: 700; flex-shrink: 0; }
.pts.plus { color: var(--text-on-mint); }
.pts.minus { color: var(--text-on-red); }
.pts.wish-pts {
  font-family: var(--font-body);
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-on-orange);
}

.wish-history-reason {
  margin: var(--space-6) 0 0;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-secondary);
}
.hi-reviewer {
  margin-top: var(--space-6);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}

.result {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  font-size: var(--fs-xs);
  padding: var(--space-8) var(--space-12);
  border-radius: var(--r-sm);
  margin-top: var(--space-10);
}
.result.rejected { background: rgba(255, 122, 122, 0.1); color: var(--text-on-red); }
.result.approved { background: rgba(126, 212, 185, 0.1); color: var(--text-on-mint); }
</style>
