<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch, watchEffect } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import GlassCard from '@/components/GlassCard.vue';
import EmptyState from '@/components/EmptyState.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { fmtDuration, fmtTimerPair } from '@/utils/duration';

const toast = useToastStore();

/** 计时状态（后端按 timer_* 列算好）：running 时 used_ms 会一直涨，paused 时 paused_ms 涨 */
interface TimerInfo {
  state: 'idle' | 'running' | 'paused' | 'stopped';
  used_ms: number;
  paused_ms: number;
}

interface RecurringTask {
  id: number;
  name: string;
  description: string | null;
  points: number;
  freq_type: 'daily' | 'weekly' | 'monthly';
  /** 1 = 单次任务（家长发布时没选重复频率）：只做一次 */
  once_only: number;
  freq_text: string;
  due_time: string | null;
  valid_from: string | null;
  valid_to: string | null;
  valid_text: string | null;
  in_range: boolean;
  current_period: { period_key: string; due_at: number | null; claimable: boolean } | null;
  my_claim: {
    id: number;
    status: 'claimed' | 'pending' | 'approved' | 'rejected';
    due_at: number | null;
    reason: string | null;
    expired?: boolean;
    timer?: TimerInfo;
  } | null;
  /** 我在该任务下的全部完成记录（当天直接展示，更早的放「更多」）
   *  period_date = 完成日（期次归属日）：家长晚审核不会把它挪到审核那天 */
  my_history?: {
    id: number;
    period_key: string;
    reviewed_at: number | null;
    period_date?: string | null;
    timer?: TimerInfo;
  }[];
}

const recurringTasks = ref<RecurringTask[]>([]);
const loading = ref(true);
const processing = ref<number | null>(null);

/** 我自己拖出来的任务顺序（服务端持久化，见 /recurring-tasks/reorder）：
 *  存的是**全部可见任务**的 id 顺序 —— 后端要求提交的必须是一个完整排列 */
const orderIds = ref<number[]>([]);

async function loadRecurring() {
  loading.value = true;
  try {
    const res = await api.get<{ tasks: RecurringTask[] }>('/recurring-tasks/available');
    recurringTasks.value = res.tasks;
    // 后端已经按我保存的顺序返回（没排过的按发布时间排在后面），这里原样记住
    orderIds.value = res.tasks.map((t) => t.id);
    // 计时显示的本地基准时刻：服务端给的 used_ms 是「拉到数据那一刻」的快照，
    // 运行中/暂停中要在此基础上按本地时钟继续走
    timerFetchedAt.value = Date.now();
    // 打开页面固定停在「可领取」标签；不自动跳走，避免领取后被强行切到别的标签
  } finally { loading.value = false; }
}

// ── 计时 ────────────────────────────────────────────────────────────────────
const timerFetchedAt = ref(Date.now());
const timerBusy = ref<number | null>(null);
/** 每秒 +1：驱动「计时中」的秒数自己往前走（不改服务端数据） */
const tick = ref(0);
let tickTimer: number | null = null;

/** 有效用时（不含暂停）：运行中时在服务端快照上叠加本地经过的时间 */
function timerUsedMs(t: RecurringTask): number {
  void tick.value;
  const tm = t.my_claim?.timer;
  if (!tm) return 0;
  const drift = tm.state === 'running' ? Math.max(0, Date.now() - timerFetchedAt.value) : 0;
  return tm.used_ms + drift;
}

/** 暂停用时：暂停中时同样继续走 */
function timerPausedMs(t: RecurringTask): number {
  void tick.value;
  const tm = t.my_claim?.timer;
  if (!tm) return 0;
  const drift = tm.state === 'paused' ? Math.max(0, Date.now() - timerFetchedAt.value) : 0;
  return tm.paused_ms + drift;
}

async function timerAction(t: RecurringTask, action: 'start' | 'pause' | 'stop') {
  if (!t.my_claim) return;
  const claimId = t.my_claim.id;
  timerBusy.value = claimId;
  try {
    const res = await api.post<{ timer: TimerInfo }>(`/recurring-tasks/claims/${claimId}/timer/${action}`);
    t.my_claim.timer = res.timer;
    timerFetchedAt.value = Date.now();
    if (action === 'stop') toast.success(`已停止计时，用时 ${fmtDuration(res.timer.used_ms)}`);
    else if (action === 'start' && res.timer.state === 'running') toast.info('开始计时啦，加油！');
  } catch (e: any) {
    const err = e.payload?.error;
    if (err === 'timer_finished') toast.warning('这个任务的计时已经结束了');
    else if (err === 'timer_running') toast.warning('已经在计时中啦');
    else if (err === 'timer_not_running') toast.warning('现在没有在计时');
    else if (err === 'already_submitted') toast.warning('已经提交过了');
    else toast.error(e.message || '计时操作失败');
    await loadRecurring();
  } finally { timerBusy.value = null; }
}

async function claimRecurring(t: RecurringTask) {
  processing.value = -t.id;
  try {
    await api.post(`/recurring-tasks/${t.id}/claim`);
    toast.success('领取成功，完成后记得提交哦~');
    await loadRecurring();
  } catch (e: any) {
    const err = e.payload?.error;
    if (err === 'already_claimed') toast.warning('本期已经领取过了');
    else if (err === 'period_overdue') toast.warning('本期已过截止时间');
    else if (err === 'not_scheduled_today') toast.warning('今天没有这期任务');
    else if (err === 'out_of_valid_range') toast.warning('这个任务现在不在有效期内');
    else toast.error(e.message);
  } finally { processing.value = null; }
}

function submitRecurring(t: RecurringTask) {
  if (!t.my_claim) return;
  confirmMessage.value = `提交「${t.name}」完成申请？`;
  confirmAction.value = async () => {
    processing.value = -t.my_claim!.id;
    try {
      await api.post(`/recurring-tasks/claims/${t.my_claim!.id}/submit`);
      toast.success('已提交完成申请，等爸爸妈妈审核~');
      await loadRecurring();
    } catch (e: any) {
      const err = e.payload?.error;
      if (err === 'already_pending') toast.warning('已经提交过了，请耐心等待');
      else if (err === 'already_approved') toast.warning('这个任务已完成');
      else if (err === 'period_overdue') toast.warning('已过最后完成时间，本期不能提交了');
      else toast.error(e.message);
    } finally { processing.value = null; }
  };
  confirmOpen.value = true;
}

/** 任务卡片的截止文案 */
function recDueText(t: RecurringTask): string {
  // 单次任务：只做一次，没有「期次」；有结束日期时才有截止时间
  if (t.once_only) {
    if (!t.valid_to) return '单次任务 · 完成一次就可以啦';
    return `${t.due_time ?? '23:59'} 前完成`;
  }
  const due = t.due_time ?? '23:59';
  return `${t.freq_text} ${due} 前完成`;
}

/** 排序：可领取 → 可提交/可重提 → 待审核 → 已完成/已超时/不可领 */
const sortedRecurring = computed(() => {
  const rank = (t: RecurringTask): number => {
    if (!t.my_claim) return t.current_period?.claimable ? 0 : 4;
    if (t.my_claim.status === 'claimed') return t.my_claim.expired ? 4 : 1;
    // 被拒后过了截止 → 不能再重提，和超时一样沉到后面
    if (t.my_claim.status === 'rejected') return t.my_claim.expired ? 4 : 2;
    if (t.my_claim.status === 'pending') return 3;
    return 4; // approved
  };
  return [...recurringTasks.value].sort((a, b) => rank(a) - rank(b));
});

// ── 分类标签：可领取 / 已领取 / 已完成 ─────────────────────────────────────

const recTab = ref<'claimable' | 'claimed' | 'completed'>('claimable');

/** 本地时区今天 YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时区判断某 unix 秒是否是今天（不要用 toISOString，那是 UTC） */
function isToday(ts: number | null): boolean {
  if (!ts) return false;
  const d = new Date(ts * 1000);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/** 完成记录是否算「今天完成」：按任务期次归属日（家长晚审核不改完成日，只影响何时加分）；
 *  老记录缺 period_date 时退回按审核时间判断 */
function isTodayCompleted(h: { period_date?: string | null; reviewed_at: number | null }): boolean {
  if (h.period_date) return h.period_date === todayStr();
  return isToday(h.reviewed_at);
}

/** 今天完成的记录数 */
function todayCompletedRecords(t: RecurringTask): number {
  return (t.my_history ?? []).filter((c) => isTodayCompleted(c)).length;
}

/** 今天是否有通过的完成记录 */
function todayApproved(t: RecurringTask): boolean {
  return todayCompletedRecords(t) > 0;
}

/** 「已完成」标签里那条完成的用时：优先取本期记录，取不到再从今天的完成历史里找。
 *  没计过时返回空串（不显示「00:00」—— 那看起来像是记了但没用时间）。 */
function completedUsedText(t: RecurringTask): string {
  const pair =
    fmtTimerPair(t.my_claim?.status === 'approved' ? t.my_claim.timer : null) ||
    fmtTimerPair((t.my_history ?? []).find((h) => isTodayCompleted(h))?.timer);
  return pair ? `⏱ 用时 ${pair}` : '';
}

// ── 已完成标签：当天记录直接展示，更早的记录点「更多」查看 ─────────────────

const recShowAllCompleted = ref(false);

/** 「更多历史记录」：侧边浮动按钮，始终可见（不依赖滚动位置） */

/** 更早（非今天完成）的完成记录总数 */
const olderCompletedCount = computed(() =>
  recurringTasks.value.reduce(
    (sum, t) => sum + (t.my_history ?? []).filter((c) => !isTodayCompleted(c)).length,
    0
  )
);

const recTabTasks = computed<Record<'claimable' | 'claimed' | 'completed', RecurringTask[]>>(() => {
  const claimable: RecurringTask[] = [];
  const claimed: RecurringTask[] = [];
  const completed: RecurringTask[] = [];
  for (const t of recurringTasks.value) {
    if (todayApproved(t) || (recShowAllCompleted.value && (t.my_history?.length ?? 0) > 0)) completed.push(t);
    else if (t.my_claim && t.my_claim.status !== 'approved') {
      // 超时但截止日已过 → 这期翻篇，任何标签都不再显示（等下一期）
      if (t.my_claim.expired && !expiredVisibleToday(t)) continue;
      claimed.push(t); // 已领取/待审核/被拒/已超时（超时只在截止当天展示）
    }
    else if (!t.my_claim && t.current_period?.claimable) claimable.push(t);
  }
  return { claimable, claimed, completed };
});

const recTabCount = (k: 'claimable' | 'claimed' | 'completed') => {
  // 已完成标签的数字只统计当天通过的记录数
  if (k === 'completed') {
    return recurringTasks.value.reduce((sum, t) => sum + todayCompletedRecords(t), 0);
  }
  return recTabTasks.value[k].length;
};

function fmtTs(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 未领取且本期领取时间已过：在「可领取」标签下展示、提示超时，但不能领取
 *  多带一个客户端时钟判断，页面一直开着跨过截止时间也能立刻变「已超时」。
 *  只在**截止当天**展示 —— 跨了天这期就翻篇：每日任务第二天出现新一期，
 *  周任务不是排期日自动消失，月度任务要等下个月，不再挂着「已超时」示众 */
function isExpiredUnclaimed(t: RecurringTask): boolean {
  void tick.value; // 每秒跳一次：让 computed 在跨天/过点的瞬间自动重算
  if (t.my_claim) return false;
  const p = t.current_period;
  if (!p) return false;
  // 单次任务不设结束日期时 due_at 为 null（= 不过期）
  if (p.due_at == null) return false;
  return isToday(p.due_at) && (!p.claimable || Date.now() / 1000 > p.due_at);
}

/** 已领取/被拒后超时的本期记录：同样只在截止当天展示「已超时」，
 *  截止日一过整个任务就从「已领取」标签消失（等下一期） */
function expiredVisibleToday(t: RecurringTask): boolean {
  void tick.value;
  const c = t.my_claim;
  return !!c?.expired && c.due_at != null && isToday(c.due_at);
}

/** 过期未领取的任务（只展示、不入「可领取」标签的计数） */
const recExpiredUnclaimed = computed(() =>
  recurringTasks.value.filter((t) => isExpiredUnclaimed(t) && !todayApproved(t))
);

/** 「可领取」标签下真正能排序的（超时未领取的永远沉底，不参与排序） */
const claimableMain = computed(() => {
  const ids = new Set(recTabTasks.value.claimable.map((t) => t.id));
  return recurringTasks.value.filter((t) => ids.has(t.id));
});

/** claimableMain 按我保存的 orderIds 排好后，**就是卡片实际显示的顺序**。
 *  序号、换位置的目标、提交给后端的三者必须共用这一个数组，
 *  否则会出现「卡片已经换到第一行、序号还写着 2」这类对不上的情况。 */
const claimableOrdered = computed(() => {
  const pos = new Map(orderIds.value.map((id, i) => [id, i]));
  return claimableMain.value
    .slice()
    .sort((a, b) => (pos.get(a.id) ?? 1e6) - (pos.get(b.id) ?? 1e6) || a.id - b.id);
});

/** 当前标签下的任务（复用排序）
 *  「可领取」标签按我自己的排序展示，并额外带上「已超时未领取」的任务 —— 展示但不可领、不参与排序 */
const recVisibleRecurring = computed(() => {
  if (recTab.value === 'claimable') {
    const main = claimableOrdered.value;
    const expiredIds = new Set(recExpiredUnclaimed.value.map((t) => t.id));
    const tail = sortedRecurring.value.filter((t) => expiredIds.has(t.id) && !main.some((m) => m.id === t.id));
    return [...main, ...tail];
  }
  const set = new Set(recTabTasks.value[recTab.value].map((t) => t.id));
  return sortedRecurring.value.filter((t) => set.has(t.id));
});

/** 卡片上的序号：只有「可领取」标签下、且参与排序的任务才显示小圆标。
 *  取自 claimableOrdered（= 显示顺序），所以换完位置序号立刻跟着变。 */
function seqOf(t: RecurringTask): number {
  if (recTab.value !== 'claimable') return 0;
  const i = claimableOrdered.value.findIndex((x) => x.id === t.id);
  return i >= 0 ? i + 1 : 0;
}

// ── 任务排序：点两下换位置（2026-10-15 起，替代原来的长按拖拽） ─────────────
//
// 为什么不用拖拽：拖动时卡片要跟手走、其它卡片要实时让位，手指稍微回摆卡片就来回蹦，
// 孩子很难"稳稳放到想放的位置"。改成「点第一张 → 点第二张」两步交换后：
// 点到哪里就是哪里，全程卡片不动、零误判，两次点击比拖拽还快。
//
// 落在按钮/输入框上的点击一律放行（领取任务、开始计时、提交…都长在卡片上），
// 所以点按钮不会误触发选卡。

/** 第一下选中的任务 id（正在等第二张）；null = 没选中 */
const pickedId = ref<number | null>(null);
/** 正在提交顺序：这期间忽略新的点击，避免连点打出两个请求 */
const savingOrder = ref(false);

/** 选中任务的名字（提示条上要念出来：孩子能确认自己选中的是哪张） */
const pickedName = computed(() => {
  const id = pickedId.value;
  if (id === null) return '';
  return recurringTasks.value.find((t) => t.id === id)?.name ?? '';
});

// 选中的任务被领走（跑去了「已领取」标签）、超时沉底、或切了标签 →
// 选中态自动作废，免得提示条念着一个屏幕上根本看不到的任务
watchEffect(() => {
  const id = pickedId.value;
  if (id !== null && !claimableOrdered.value.some((t) => t.id === id)) pickedId.value = null;
});
watch(recTab, () => { pickedId.value = null; });

/** 当前列表里的卡片元素（顺序 = DOM 顺序 = 显示顺序）—— 换位动画（FLIP）要用 */
function listCards(): HTMLElement[] {
  const list = document.querySelector('.task-list');
  return list ? ([...list.querySelectorAll('.task-card')] as HTMLElement[]) : [];
}

/**
 * 点卡片的统一入口：
 *   没选中 → 选中它；选中了自己 → 取消；选中了别人 → 两张交换位置。
 */
function onCardTap(e: MouseEvent, t: RecurringTask) {
  if (recTab.value !== 'claimable') return; // 只有「可领取」标签能排序
  if (savingOrder.value) return;
  // 点在按钮/链接/输入框上 → 那是它们的活儿，别拦
  const target = e.target as HTMLElement | null;
  if (target?.closest('button, a, input, textarea, select')) return;
  // 超时沉底的那几张不在可排序区间里，点了给个说明（别让人觉得点了没反应）
  if (!claimableOrdered.value.some((x) => x.id === t.id)) {
    if (isExpiredUnclaimed(t)) toast.warning('这个任务已经超时了，等下一期再排吧~');
    return;
  }
  if (pickedId.value === null) { pickedId.value = t.id; return; }
  if (pickedId.value === t.id) { pickedId.value = null; return; }
  void swapPositions(pickedId.value, t.id);
}

/** 把 a、b 两个任务的位置对调（其它卡片相对顺序不变），并保存到后端 */
async function swapPositions(aId: number, bId: number) {
  const ids = claimableOrdered.value.map((t) => t.id);
  const ia = ids.indexOf(aId);
  const ib = ids.indexOf(bId);
  if (ia < 0 || ib < 0 || ia === ib) { pickedId.value = null; return; }

  const snapshot = [...orderIds.value];

  // FLIP 第一步：先记下动画前的布局位置（offsetTop 不受正挂着的 transform 影响）
  const before = new Map<number, number>();
  for (const el of listCards()) before.set(Number(el.dataset.taskId), el.offsetTop);

  ids[ia] = bId;
  ids[ib] = aId;

  // orderIds 里还混着「已领取/已完成」的任务：只把可领取那一批的槽位换成新顺序，
  // 其它任务原位不动 —— 否则换一次位置会顺手把别的任务挤走
  const claimable = new Set(ids);
  let k = 0;
  orderIds.value = orderIds.value.map((tid) => (claimable.has(tid) ? ids[k++] : tid));
  pickedId.value = null;

  // FLIP 第二步：DOM 更新后让动过的卡片从旧位置"滑"到新位置（而不是闪现过去）
  nextTick(() => {
    for (const el of listCards()) {
      const oldTop = before.get(Number(el.dataset.taskId));
      if (oldTop === undefined) continue;
      const delta = oldTop - el.offsetTop;
      if (!delta) continue;
      el.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
        { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
      );
    }
  });

  savingOrder.value = true;
  try {
    await api.post('/recurring-tasks/reorder', { ids: [...orderIds.value] });
    toast.success('顺序换好啦~');
  } catch (e: any) {
    // 保存失败（比如家长刚改过任务，顺序过期了）→ 回到服务端的顺序，别让页面停在假状态
    orderIds.value = snapshot;
    if (e.payload?.error === 'stale_list') toast.warning('任务刚有变动，顺序没保存，请再试一次');
    else toast.error(e.message || '顺序没保存成功');
    await loadRecurring();
  } finally {
    savingOrder.value = false;
  }
}

// 确认弹窗
const confirmOpen = ref(false);
const confirmMessage = ref('');
const confirmAction = ref<(() => Promise<void>) | null>(null);

async function runConfirm() {
  if (confirmAction.value) await confirmAction.value();
  confirmAction.value = null;
}

function onWsEvent() { loadRecurring(); }
onMounted(() => {
  loadRecurring();
  // 计时显示每秒刷新一次（只改本地显示，不发请求）
  tickTimer = window.setInterval(() => { tick.value++; }, 1000);
  window.addEventListener('ws:recurring_review', onWsEvent);
  window.addEventListener('ws:recurring_claims_cleared', onWsEvent);
  // 家长新建/编辑/启停/删除任务 → 三个标签都实时重拉，不用手动刷新页面
  window.addEventListener('ws:recurring_tasks_changed', onWsEvent);
});
onUnmounted(() => {
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
  window.removeEventListener('ws:recurring_review', onWsEvent);
  window.removeEventListener('ws:recurring_claims_cleared', onWsEvent);
  window.removeEventListener('ws:recurring_tasks_changed', onWsEvent);
  // 选中一半离开页面（切标签/退出登录）时清掉选中态，回来不会莫名其妙是"选中的"
  pickedId.value = null;
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1 class="title">我的任务</h1>
      <p class="subtitle">完成任务可以赚积分哦~</p>
    </header>

    <EmptyState
      v-if="!loading && recurringTasks.length === 0"
      emoji="📋"
      text="暂无任务"
      hint="爸爸妈妈发布后这里会显示哦~"
      class="tab-empty"
    />
    <template v-else>
      <div class="tabs">
        <button :class="{ active: recTab === 'claimable' }" @click="recTab = 'claimable'">可领取 {{ recTabCount('claimable') }}</button>
        <button :class="{ active: recTab === 'claimed' }" @click="recTab = 'claimed'">已领取 {{ recTabCount('claimed') }}</button>
        <button :class="{ active: recTab === 'completed' }" @click="recTab = 'completed'">已完成 {{ recTabCount('completed') }}</button>
      </div>
      <!-- 排序提示：只在「可领取」且确实有得排（≥2 条）时出现，否则只是噪音。
           选中一张后换成「已选中 xxx」的引导文案 —— 孩子才知道下一步该点哪儿。 -->
      <p
        v-if="recTab === 'claimable' && claimableOrdered.length > 1"
        class="drag-tip"
        :class="{ picking: pickedId !== null }"
      >
        <template v-if="pickedId === null">
          💡 想调整顺序？先点一下任务卡片，再点要跟它换位置的那张
        </template>
        <template v-else>
          👉 已选中「{{ pickedName }}」，再点一张卡片就跟它换位置（点它自己可以取消）
        </template>
      </p>
      <EmptyState
        v-if="recVisibleRecurring.length === 0"
        :emoji="recTab === 'claimable' ? '🙋' : recTab === 'claimed' ? '🟢' : '✅'"
        :text="recTab === 'claimable' ? '没有可领取的任务' : recTab === 'claimed' ? '还没有领取的任务' : '今天还没有完成的记录'"
        :hint="recTab === 'claimable' ? '快去领取赚积分吧~' : ''"
        class="tab-empty"
      />
      <div v-else class="task-list" style="margin-bottom: var(--space-20)">
        <GlassCard
          v-for="t in recVisibleRecurring"
          :key="t.id"
          :data-task-id="t.id"
          padding="18px 20px"
          class="task-card"
          :class="{
            pickable: seqOf(t) > 0,
            picked: pickedId === t.id,
          }"
          @click="onCardTap($event, t)"
        >
          <div class="head">
            <!-- 序号：只在「可领取」标签下出现，取自当前显示顺序（换完位置立刻变）。
                 排序改「点两下换位置」后不再需要拖拽手柄了。 -->
            <template v-if="seqOf(t) > 0">
              <span class="seq-badge" aria-hidden="true">{{ seqOf(t) }}</span>
            </template>
            <span v-if="t.my_claim?.status === 'approved'" class="status completed">✅ 已完成</span>
            <span v-else-if="t.my_claim?.status === 'pending'" class="status review">⏳ 待审核</span>
            <span v-else-if="t.my_claim?.status === 'claimed' && t.my_claim.expired" class="status expired">⏰ 已超时</span>
            <span v-else-if="t.my_claim?.status === 'rejected' && t.my_claim.expired" class="status expired">⏰ 已超时</span>
            <span v-else-if="t.my_claim?.status === 'rejected'" class="status rejected">❌ 被拒绝</span>
            <span v-else-if="t.my_claim?.status === 'claimed'" class="status active">🟢 已领取</span>
            <span v-else-if="recTab === 'completed'" class="status completed">🕘 历史完成</span>
            <span v-else-if="isExpiredUnclaimed(t)" class="status expired">⏰ 已超时</span>
            <span v-else class="status recurring">{{ t.freq_text }}</span>
            <div class="reward">+{{ t.points }} 🌟</div>
          </div>
          <h3 class="name">{{ t.name }}</h3>
          <p v-if="t.description" class="desc">{{ t.description }}</p>
          <div class="meta">
            <span>📅 {{ recDueText(t) }}</span>
            <span v-if="t.valid_text" class="validity">📆 {{ t.valid_text }}</span>
          </div>

          <!-- 拒绝原因 -->
          <div v-if="t.my_claim?.status === 'rejected'" class="rejected-box">
            <span class="emoji">📝</span>
            <span>上次未通过：{{ t.my_claim.reason || '原因未说明' }}</span>
          </div>

          <!-- 完成记录（已完成标签展开「更多」时显示） -->
          <div v-if="recTab === 'completed' && recShowAllCompleted && (t.my_history?.length ?? 0) > 0" class="history-list">
            <div v-for="h in t.my_history" :key="h.id" class="history-row">
              <span class="history-period">🧾 {{ h.period_key }}</span>
              <span v-if="h.timer && h.timer.used_ms >= 1000" class="history-used">
                ⏱ {{ fmtDuration(h.timer.used_ms) }}<template v-if="h.timer.paused_ms >= 1000">（暂停 {{ fmtDuration(h.timer.paused_ms) }}）</template>
              </span>
              <span class="history-time">{{ h.period_date ? `${h.period_date} 完成` : (h.reviewed_at ? `${fmtTs(h.reviewed_at)} 通过` : '') }}</span>
            </div>
          </div>

          <!-- 计时：领取后可以开始计时，暂停不计入有效用时；点提交会自动结束计时 -->
          <div
            v-if="recTab === 'claimed' && t.my_claim && !t.my_claim.expired"
            class="timer-box"
            :class="t.my_claim.timer?.state ?? 'idle'"
          >
            <div class="timer-face">
              <span class="timer-emoji">{{ t.my_claim.timer?.state === 'paused' ? '⏸' : '⏱' }}</span>
              <span class="timer-time">{{ fmtDuration(timerUsedMs(t)) }}</span>
              <span v-if="timerPausedMs(t) >= 1000" class="timer-paused">（暂停 {{ fmtDuration(timerPausedMs(t)) }}）</span>
              <span v-if="!t.my_claim.timer || t.my_claim.timer.state === 'idle'" class="timer-tip">还没有开始计时</span>
            </div>
            <div class="timer-btns">
              <button
                v-if="t.my_claim.timer?.state !== 'running' && t.my_claim.timer?.state !== 'stopped'"
                type="button"
                class="btn btn-timer start"
                :disabled="timerBusy === t.my_claim.id"
                @click="timerAction(t, 'start')"
              >{{ t.my_claim.timer?.state === 'paused' ? '▶ 继续计时' : '▶ 开始计时' }}</button>
              <button
                v-if="t.my_claim.timer?.state === 'running'"
                type="button"
                class="btn btn-timer pause"
                :disabled="timerBusy === t.my_claim.id"
                @click="timerAction(t, 'pause')"
              >⏸ 暂停</button>
              <button
                v-if="t.my_claim.timer?.state === 'running' || t.my_claim.timer?.state === 'paused'"
                type="button"
                class="btn btn-timer stop"
                :disabled="timerBusy === t.my_claim.id"
                @click="timerAction(t, 'stop')"
              >⏹ 停止计时</button>
              <span v-if="t.my_claim.timer?.state === 'stopped'" class="timer-done">✅ 计时已结束</span>
            </div>
          </div>

          <!-- 操作区 -->
          <div class="actions">
            <!-- 已完成标签：完成信息（当期完成 / 更早的历史记录） -->
            <div v-if="recTab === 'completed'" class="hint done">
              <span class="emoji">🎉</span>
              <span>{{ todayApproved(t) ? `本期完成！已获得 ${t.points} 积分` : '更早完成的记录' }}</span>
              <span v-if="completedUsedText(t)" class="hint-used">{{ completedUsedText(t) }}</span>
            </div>
            <!-- 待审核 -->
            <div v-else-if="t.my_claim?.status === 'pending'" class="hint">
              <span class="emoji">💡</span>
              <span>已提交，等待爸爸妈妈审核~</span>
              <span v-if="t.my_claim.timer && t.my_claim.timer.used_ms >= 1000" class="hint-used">
                ⏱ 用时 {{ fmtDuration(t.my_claim.timer.used_ms) }}<template v-if="t.my_claim.timer.paused_ms >= 1000">（暂停 {{ fmtDuration(t.my_claim.timer.paused_ms) }}）</template>
              </span>
            </div>
            <!-- 已领取未超时 → 提交完成 -->
            <button
              v-else-if="t.my_claim?.status === 'claimed' && !t.my_claim.expired"
              class="btn btn-submit big"
              :disabled="processing === -t.my_claim.id"
              @click="submitRecurring(t)"
            >
              {{ processing === -t.my_claim.id ? '提交中...' : '📤 提交完成' }}
            </button>
            <!-- 已超时 -->
            <div v-else-if="t.my_claim?.status === 'claimed' && t.my_claim.expired" class="hint overdue">
              <span class="emoji">⏰</span>
              <span>超过最后完成时间了，这期领到的积分飞走啦~</span>
            </div>
            <!-- 被拒绝且已过截止 → 不能重新提交 -->
            <div v-else-if="t.my_claim?.status === 'rejected' && t.my_claim.expired" class="hint overdue">
              <span class="emoji">⏰</span>
              <span>超过最后完成时间了，这期不能再重新提交啦~</span>
            </div>
            <!-- 被拒绝 → 重新提交 -->
            <button
              v-else-if="t.my_claim?.status === 'rejected'"
              class="btn btn-submit big"
              :disabled="processing === -t.my_claim.id"
              @click="submitRecurring(t)"
            >
              {{ processing === -t.my_claim.id ? '提交中...' : '🔄 重新提交' }}
            </button>
            <!-- 未领取 → 领取 -->
            <button
              v-else-if="t.current_period?.claimable"
              class="btn btn-success big"
              :disabled="processing === -t.id"
              @click="claimRecurring(t)"
            >
              {{ processing === -t.id ? '领取中...' : '🙋 领取任务' }}
            </button>
            <!-- 未领取且本期已超时 → 只能看，不能领 -->
            <div v-else-if="isExpiredUnclaimed(t)" class="hint overdue">
              <span class="emoji">⏰</span>
              <span>本期领取时间已过，不能再领取啦，等下一期吧~</span>
            </div>
            <!-- 无期次 / 不在有效期 -->
            <div v-else class="hint overdue">
              <span class="emoji">🌙</span>
              <span>{{ t.in_range === false ? '这个任务当前不在有效期内' : '还没到领取时间，或本期已经结束啦' }}</span>
            </div>
          </div>
        </GlassCard>
      </div>

      <!-- 已完成：更早的记录点「更多」查看（侧边浮动，不依赖滚动位置；
           放在列表容器**外面** —— 当天没有完成记录时列表不渲染，按钮也必须能用；
           始终显示，方便随时查看历史记录） -->
      <button
        v-if="recTab === 'completed'"
        type="button"
        class="more-side"
        :aria-expanded="recShowAllCompleted"
        :aria-label="recShowAllCompleted ? '收起历史完成记录' : `查看更多历史完成记录，共 ${olderCompletedCount} 条`"
        @click="recShowAllCompleted = !recShowAllCompleted"
      >
        <span class="more-side-text">{{ recShowAllCompleted ? '收起历史' : '更多历史' }}</span>
        <span v-if="!recShowAllCompleted && olderCompletedCount > 0" class="more-side-count" aria-hidden="true">
          {{ olderCompletedCount > 99 ? '99+' : olderCompletedCount }}
        </span>
      </button>
    </template>

    <ConfirmDialog
      v-model="confirmOpen"
      message=""
      :custom-message="confirmMessage"
      confirm-text="确认提交"
      @confirm="runConfirm"
    />
  </div>
</template>

<style scoped>
.page-header {
  margin-bottom: var(--space-16);
}
.title { font-size: var(--fs-3xl); margin-bottom: var(--space-2); }
.subtitle { color: var(--text-secondary); font-size: var(--fs-sm); }

.tabs {
  display: flex;
  background: var(--glass-bg);
  border-radius: var(--r-md);
  padding: var(--space-4);
  gap: var(--space-4);
  margin-bottom: var(--space-12);
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
.tab-empty { margin-bottom: var(--space-20); }

.task-list { display: flex; flex-direction: column; gap: var(--space-12); }

/* 可领取标签：序号（排序改成「点两下换位置」后不再有拖拽手柄） */
.seq-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 var(--space-6);
  border-radius: var(--r-pill);
  background: linear-gradient(135deg, rgba(255, 176, 92, 0.9), rgba(255, 138, 61, 0.9));
  color: #fff;
  font-family: var(--font-cute);
  font-size: var(--fs-sm);
  font-weight: 700;
  line-height: 1;
  box-shadow: 0 2px 6px rgba(255, 138, 61, 0.35);
}

/* 换位动画靠 FLIP（Web Animations，见 swapPositions），这里的 transition 只服务选中态的缩放 */
.task-card {
  transition: transform var(--dur-fast), box-shadow var(--dur-fast);
}
/* 可排序的卡片：给一点点"可以点"的手感（只有可领取标签下的卡片有） */
.task-card.pickable { cursor: pointer; }
/* 第一下选中的那张：描边亮起 + 序号变实色，孩子一眼看出"我选中了它" */
.task-card.picked {
  transform: scale(1.012);
  border-color: var(--accent-orange);
  box-shadow: 0 0 0 2px rgba(255, 152, 92, 0.35), var(--shadow-pop);
}
.task-card.picked .seq-badge {
  background: var(--accent-orange-red);
  box-shadow: 0 2px 8px rgba(255, 122, 122, 0.45);
}
/* 排序提示：一行小字，不能比任务卡本身还抢眼；选中后高亮一下提醒"还差一步" */
.drag-tip {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.6;
  margin-bottom: var(--space-10);
  padding-left: var(--space-4);
  transition: color var(--dur-fast);
}
.drag-tip.picking {
  color: var(--text-on-orange);
  font-weight: 600;
}
.head {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  margin-bottom: var(--space-8);
}
/* 序号/状态加进来后，用 margin-left:auto 顶住积分，而不是 space-between（多元素时会被拉开） */
.head .reward { margin-left: auto; }
.status {
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.status.active { background: rgba(126, 212, 185, 0.2); color: var(--text-on-mint); }
.status.review { background: rgba(255, 209, 102, 0.2); color: var(--text-on-yellow); }
.status.completed { background: rgba(126, 212, 185, 0.3); color: var(--text-on-mint); }
.status.expired { background: rgba(255, 122, 122, 0.2); color: var(--text-on-red); }
.status.rejected { background: rgba(255, 122, 122, 0.2); color: var(--text-on-red); }
.status.recurring { background: rgba(255, 152, 92, 0.15); color: var(--text-on-orange); }

.reward {
  font-family: var(--font-cute);
  color: var(--text-on-yellow);
  font-size: var(--fs-2xl);
}

.name {
  font-size: var(--fs-lg);
  margin-bottom: var(--space-4);
  font-family: var(--font-cute);
}
.desc {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-bottom: var(--space-8);
  line-height: 1.5;
}
.meta {
  display: flex;
  gap: var(--space-16);
  flex-wrap: wrap;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-bottom: var(--space-12);
}
.meta .validity { color: var(--text-on-orange); }

.rejected-box {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  font-size: var(--fs-xs);
  color: var(--text-on-red);
  background: rgba(255, 122, 122, 0.1);
  padding: var(--space-8) var(--space-12);
  border-radius: var(--r-sm);
  margin-bottom: var(--space-12);
}

/* ── 计时 ───────────────────────────────────────────────────────────────── */
.timer-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-10);
  flex-wrap: wrap;
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  border: 1px dashed var(--glass-border);
  margin-bottom: var(--space-12);
}
.timer-face {
  display: flex;
  align-items: baseline;
  gap: var(--space-6);
  min-width: 0;
}
.timer-emoji { font-size: var(--fs-lg); }
.timer-time {
  font-family: var(--font-cute);
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  letter-spacing: 1px;
}
.timer-paused { font-size: var(--fs-xs); color: var(--text-on-orange); }
.timer-tip { font-size: var(--fs-xs); color: var(--text-muted); }
.timer-btns { display: flex; align-items: center; gap: var(--space-8); flex-wrap: wrap; }
.timer-done { font-size: var(--fs-xs); color: var(--text-on-mint); font-weight: 600; }

.btn-timer {
  padding: var(--space-6) var(--space-14);
  font-size: var(--fs-sm);
  font-weight: 600;
  border-radius: var(--r-pill);
  border: 1px solid transparent;
  transition: all var(--dur-fast);
}
.btn-timer:disabled { opacity: 0.55; }
.btn-timer.start {
  background: linear-gradient(135deg, #7ed4b9, #4fb99b);
  color: #fff;
  box-shadow: 0 3px 10px rgba(79, 185, 155, 0.3);
}
.btn-timer.pause {
  background: linear-gradient(135deg, #ffd166, #f0b429);
  color: #5a4a42;
  box-shadow: 0 3px 10px rgba(240, 180, 41, 0.3);
}
.btn-timer.stop {
  background: rgba(255, 122, 122, 0.14);
  color: var(--text-on-red);
  border-color: rgba(255, 122, 122, 0.35);
}
.btn-timer:hover { filter: brightness(1.05); }

/* 计时中：整块底色柔化，一眼能看出在跑 */
.timer-box.running {
  background: rgba(126, 212, 185, 0.12);
  border-color: rgba(126, 212, 185, 0.5);
  border-style: solid;
}
.timer-box.running .timer-time { color: var(--text-on-mint); }
.timer-box.paused {
  background: rgba(255, 209, 102, 0.14);
  border-color: rgba(255, 209, 102, 0.5);
  border-style: solid;
}
.timer-box.paused .timer-time { color: var(--text-on-yellow); }
.hint-used { margin-left: auto; font-size: var(--fs-xs); color: var(--text-muted); }

.actions {
  display: flex;
  gap: var(--space-8);
}
.big {
  flex: 1;
  padding: var(--space-12);
  font-size: var(--fs-md);
  font-family: var(--font-cute);
}
/* 提交完成按钮：渐变橙（领取按钮保持原色不动）。
   hover 保持橙色、只轻微提亮 —— 全局的灰白 hover 已在 main.css 排除 .btn-submit */
.btn-submit {
  background: linear-gradient(135deg, #ffb05c, #ff8a3d);
  color: #ffffff;
  border: none;
  box-shadow: 0 4px 12px rgba(255, 138, 61, 0.35);
}
.btn-submit:hover { filter: brightness(1.06); }
.btn-submit:disabled { opacity: 0.55; }
.hint {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-12);
  background: var(--glass-bg);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.hint.done {
  color: var(--text-on-mint);
  background: rgba(126, 212, 185, 0.1);
}
.hint.overdue {
  color: var(--text-on-red);
  background: rgba(255, 122, 122, 0.1);
}
.hint .emoji { font-size: var(--fs-lg); }

/* 已完成标签：历史记录行 + 更多按钮 */
.history-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  margin-bottom: var(--space-12);
}
.history-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-6) var(--space-10);
  background: var(--glass-bg);
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
}
.history-period { color: var(--text-secondary); }
.history-used { margin-left: auto; color: var(--text-on-mint); font-size: var(--fs-xs); }
.history-time { color: var(--text-muted); }
/* 「更多历史记录」：贴在任务页右侧、垂直居中的浮动标签。
   底色与 .glass-card / .btn 同一套玻璃 token（和审核入口按钮同配方），只圆左侧两角，
   看起来像从页面侧边抽出来的一张签；不再用滚动位置做显示条件。 */
.more-side {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 30;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-12) var(--space-4);
  border: 1px solid var(--glass-border);
  border-right: none;
  border-radius: var(--r-md) 0 0 var(--r-md);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow-float);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  font-weight: 600;
  line-height: 1;
  transition: transform var(--dur-fast), background var(--dur-base), box-shadow var(--dur-fast);
}
.more-side:hover {
  background: var(--glass-bg-strong);
  box-shadow: var(--glass-shadow-hover);
}
.more-side:active {
  transform: translateY(-50%) scale(0.96);
}
.more-side-text {
  writing-mode: vertical-rl;
  letter-spacing: 2px;
}
.more-side-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-4);
  border-radius: var(--r-pill);
  background: var(--accent-orange-red);
  color: #fff;
  font-size: var(--fs-2xs);
  font-weight: 700;
  line-height: 1;
}
</style>
