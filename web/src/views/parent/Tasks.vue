<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import GlassCard from '@/components/GlassCard.vue';
import EmptyState from '@/components/EmptyState.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import RecurringTaskEditor from '@/components/RecurringTaskEditor.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { fmtTimerPair, isTimerLive } from '@/utils/duration';

const router = useRouter();
const toast = useToastStore();

interface Child {
  id: number;
  name: string;
  avatar: string;
  total_points: number;
}

interface RecurringClaim {
  id: number;
  user_id: number;
  user_name: string;
  user_avatar: string;
  period_key: string;
  /** 完成日（期次归属日 YYYY-MM-DD）：家长晚审核不会把它挪到审核那天 */
  period_date: string | null;
  status: 'claimed' | 'pending' | 'approved' | 'rejected';
  due_at: number | null;
  claimed_at: number;
  submitted_at: number | null;
  reviewed_at: number | null;
  /** 孩子做这个任务花了多久（暂停不计入有效用时，括号里单列） */
  timer?: { state: 'idle' | 'running' | 'paused' | 'stopped'; used_ms: number; paused_ms: number };
}

interface RecurringTask {
  id: number;
  name: string;
  description: string | null;
  points: number;
  freq_type: 'daily' | 'weekly' | 'monthly';
  /** 1 = 单次任务（发布时不选重复频率）：只做一次 */
  once_only: number;
  freq_text: string;
  due_time: string | null;
  child_ids: string | null;
  child_names?: string[] | null;
  valid_from: string | null;
  valid_to: string | null;
  valid_text: string | null;
  in_range: boolean;
  enabled: number;
  pending_count: number;
  current_period: { period_key: string; due_at: number | null; claimable: boolean } | null;
  claims?: RecurringClaim[];
}

const children = ref<Child[]>([]);
const recurringTasks = ref<RecurringTask[]>([]);
const recLoading = ref(false);
const recEditorOpen = ref(false);
const editingRecurring = ref<RecurringTask | null>(null);

async function loadChildren() {
  try {
    const res = await api.get<{ children: Child[] }>('/children');
    children.value = res.children;
  } catch { /* 编辑器需要，失败不阻塞页面 */ }
}

async function loadRecurring() {
  recLoading.value = true;
  try {
    const res = await api.get<{ tasks: RecurringTask[] }>('/recurring-tasks');
    recurringTasks.value = res.tasks;
    // 打开页面固定停在「可领取」标签，不自动跳走
  } finally {
    recLoading.value = false;
  }
}

/** WebSocket 事件自动刷新（孩子领取/提交、审核结果、任务增删改） */
function onWsEvent() { loadRecurring(); }

onMounted(() => {
  window.addEventListener('ws:recurring_claim_submitted', onWsEvent);
  window.addEventListener('ws:recurring_review', onWsEvent);
  window.addEventListener('ws:recurring_claims_cleared', onWsEvent);
  window.addEventListener('ws:recurring_tasks_changed', onWsEvent);
  loadChildren();
  loadRecurring();
});

onUnmounted(() => {
  window.removeEventListener('ws:recurring_claim_submitted', onWsEvent);
  window.removeEventListener('ws:recurring_review', onWsEvent);
  window.removeEventListener('ws:recurring_claims_cleared', onWsEvent);
  window.removeEventListener('ws:recurring_tasks_changed', onWsEvent);
});

function openRecEditor(task?: RecurringTask) {
  editingRecurring.value = task ?? null;
  recEditorOpen.value = true;
}

async function onRecSaved() {
  recEditorOpen.value = false;
  await loadRecurring();
}

// 「删除记录」：只清掉领取/完成记录，任务本身保留（已领取/已完成标签用）
const recClearTarget = ref<RecurringTask | null>(null);

async function clearRecurringClaims(task: RecurringTask) {
  try {
    await api.delete(`/recurring-tasks/${task.id}/claims`);
    toast.success('已删除领取记录，小朋友可重新领取');
    await loadRecurring();
  } catch (e: any) {
    toast.error(e.message || '删除失败');
  }
}

// 单独删除某个孩子的领取/完成记录（逐条删除用）
const claimDeleteTarget = ref<RecurringClaim | null>(null);

async function removeClaim(c: RecurringClaim) {
  try {
    await api.delete(`/recurring-tasks/claims/${c.id}`);
    toast.success('已删除该条记录');
    await loadRecurring();
  } catch (e: any) {
    toast.error(e.message || '删除失败');
  }
}

/** 任务卡片的状态文案 */
function recStatusText(t: RecurringTask): string {
  if (!t.enabled) return '⏸ 已停用';
  if (!t.in_range) {
    const today = todayStr();
    if (t.valid_from && today < t.valid_from) return '📅 未开始';
    return '🏁 已结束';
  }
  if (t.pending_count > 0) return `⏳ ${t.pending_count} 条待审核`;
  if (!t.current_period) return '📅 今日无期次';
  if (!t.current_period.claimable) return '⏰ 本期已过';
  return '🟢 可领取';
}

/** 任务卡片上的截止说明 */
function recDueText(t: RecurringTask): string {
  // 单次任务：没有「期次」，有结束日期才算有截止时间
  if (t.once_only) {
    if (!t.valid_to) return '单次任务 · 完成一次即可';
    return `${t.due_time ?? '23:59'} 前完成`;
  }
  return t.due_time ? `${t.due_time} 前完成` : '当天 23:59 前完成';
}

/** 期次文案：单次任务没有「本期」概念，直接用它的期次名 */
function periodMeta(t: RecurringTask): string {
  if (t.once_only) return '🔂 单次任务（只做一次）';
  return `🧾 本期：${t.current_period?.period_key ?? ''}`;
}

/** 领取记录行尾的期次文案（单次任务的期次名本身就是中文，不再加「期次」前缀） */
function claimPeriodLine(t: RecurringTask, c: RecurringClaim): string {
  return t.once_only ? c.period_key : `期次 ${c.period_key}`;
}

/** 本地时区今天 YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 任务排序：本期可领取 → 启用但本期不可领 → 已停用 */
const sortedRecurring = computed(() => {
  const rank = (t: RecurringTask) => {
    if (!t.enabled) return 2;
    return t.current_period?.claimable ? 0 : 1;
  };
  return [...recurringTasks.value].sort((a, b) => rank(a) - rank(b));
});

// ── 分类标签：可领取 / 已领取 / 已完成 ─────────────────────────────────────

const recTab = ref<'claimable' | 'claimed' | 'completed'>('claimable');

/** 领取记录是否已超时（领了没提交 / 被拒后没在截止前重提） */
function claimExpired(c: RecurringClaim): boolean {
  return (c.status === 'claimed' || c.status === 'rejected') && !!c.due_at && Date.now() / 1000 > c.due_at;
}

/** 领取记录的状态文案 */
function claimStatusText(c: RecurringClaim): string {
  if (c.status === 'approved') return '✅ 已完成';
  if (c.status === 'pending') return '⏳ 待审核';
  if (claimExpired(c)) return '⏰ 已超时';
  if (c.status === 'rejected') return '❌ 被拒绝';
  return '🟢 已领取';
}

function claimClass(c: RecurringClaim): string {
  if (c.status === 'approved') return 'approved';
  if (c.status === 'pending') return 'pending';
  if (claimExpired(c)) return 'expired';
  if (c.status === 'rejected') return 'rejected';
  return 'claimed';
}

/** 本地时区判断某 unix 秒是否是今天（不要用 toISOString，那是 UTC） */
function isToday(ts: number | null): boolean {
  if (!ts) return false;
  const d = new Date(ts * 1000);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/** 本地时区把 unix 秒转成 YYYY-MM-DD */
function dayKey(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 「已完成」归日：按任务期次归属日（孩子哪天做的任务就算哪天完成），
 *  家长晚几天审核不会把记录挪到审核那天 —— 晚审只影响什么时候加分。
 *  老记录没有 period_date 时退回按审核时间判断。 */
function isTodayCompleted(c: RecurringClaim): boolean {
  if (c.period_date) return c.period_date === todayStr();
  return isToday(c.reviewed_at);
}

/** 已完成记录的行尾文案；审核发生在别的日子时补注审核时间，方便家长对照 */
function completedText(c: RecurringClaim): string {
  if (!c.period_date) return c.reviewed_at ? `于 ${fmtTs(c.reviewed_at)} 通过` : '';
  const reviewed = dayKey(c.reviewed_at);
  if (reviewed && reviewed !== c.period_date) return `${c.period_date} 完成（${fmtTs(c.reviewed_at)} 审核）`;
  return `${c.period_date} 完成`;
}

/** 按孩子筛选：null = 全部孩子。三个标签（可领取/已领取/已完成）共用同一个筛选值 */
const filterChild = ref<number | null>(null);

/** 某条记录/某个孩子是否命中当前筛选 */
function matchChild(userId: number): boolean {
  return filterChild.value === null || filterChild.value === userId;
}

/** 该任务适用的孩子（child_ids 为 NULL/空 = 所有孩子） */
function applicableChildren(t: RecurringTask): Child[] {
  let ids: number[] | null = null;
  try { ids = t.child_ids ? (JSON.parse(t.child_ids) as number[]) : null; } catch { ids = null; }
  if (!ids || ids.length === 0) return children.value;
  return children.value.filter((c) => ids!.includes(c.id));
}

/** 该任务在当前筛选下适用/相关的孩子 */
function scopedChildren(t: RecurringTask): Child[] {
  return applicableChildren(t).filter((c) => matchChild(c.id));
}

/** 每个孩子在「当前标签」下的条目数（筛选条上的角标） */
function countForChild(childId: number): number {
  const tab = recTab.value;
  if (tab === 'claimable') {
    let n = 0;
    for (const t of recurringTasks.value) {
      if (!applicableChildren(t).some((c) => c.id === childId)) continue;
      const claimedIds = new Set(currentPeriodClaims(t).map((c) => c.user_id));
      const stillWaiting = applicableChildren(t).some((k) => !claimedIds.has(k.id));
      if (t.enabled && t.current_period?.claimable && stillWaiting && !claimedIds.has(childId)) n++;
    }
    return n;
  }
  if (tab === 'claimed') {
    return recurringTasks.value.filter((t) =>
      (t.claims ?? []).some((c) => c.user_id === childId && c.status !== 'approved')
    ).length;
  }
  return recurringTasks.value.filter((t) =>
    (t.claims ?? []).some((c) => c.user_id === childId && c.status === 'approved' && isTodayCompleted(c))
  ).length;
}

/** 本期（当前期次）已有的领取记录 */
function currentPeriodClaims(t: RecurringTask): RecurringClaim[] {
  const p = t.current_period;
  if (!p) return [];
  return (t.claims ?? []).filter((c) => c.period_key === p.period_key);
}

/** 可领取标签下：只逐个列出**还没领取**的孩子（已领取的去看「已领取」标签） */
interface ChildClaimRow { id: number; name: string; avatar: string; text: string; cls: string }

function claimableRows(t: RecurringTask): ChildClaimRow[] {
  const claimedIds = new Set(currentPeriodClaims(t).map((c) => c.user_id));
  return scopedChildren(t)
    .filter((ch) => !claimedIds.has(ch.id))
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      avatar: ch.avatar,
      text: '待领取',
      cls: 'waiting',
    }));
}

/** 各标签下的任务集合
 *  - 可领取：启用且在有效期内、本期可领，且**还有孩子没领**（所有孩子都领了才移出）
 *  - 已领取：存在未通过的领取记录（部分孩子领了、部分没领也在这里）
 *  - 已完成：当天（按任务期次归日）有通过的完成记录（「更多」展开后也显示更早的） */
const recTabTasks = computed<Record<'claimable' | 'claimed' | 'completed', RecurringTask[]>>(() => {
  const claimable: RecurringTask[] = [];
  const claimed: RecurringTask[] = [];
  const completed: RecurringTask[] = [];
  for (const t of recurringTasks.value) {
    const approvedClaims = (t.claims ?? []).filter((c) => c.status === 'approved' && matchChild(c.user_id));
    if (approvedClaims.some((c) => isTodayCompleted(c)) || (recShowAllCompleted.value && approvedClaims.length > 0)) {
      completed.push(t);
    }
    if ((t.claims ?? []).some((c) => c.status !== 'approved' && matchChild(c.user_id))) claimed.push(t);
    const period = t.current_period;
    const kids = scopedChildren(t);
    const claimedIds = new Set(currentPeriodClaims(t).map((c) => c.user_id));
    // 还有孩子没领就继续留在「可领取」（没有孩子可领时也保留，避免任务凭空消失）。
    // 按孩子筛选时，「没有适用的孩子」不算可领取 —— 否则每个任务都会混进所有人的列表。
    const stillWaiting = filterChild.value === null
      ? kids.length === 0 || kids.some((k) => !claimedIds.has(k.id))
      : kids.some((k) => !claimedIds.has(k.id));
    if (t.enabled && period?.claimable && stillWaiting) claimable.push(t);
  }
  return { claimable, claimed, completed };
});

const recTabCount = (k: 'claimable' | 'claimed' | 'completed') => {
  // 已完成标签的数字只统计「今天完成」的记录数（按期次归属日，不按审核时间）
  if (k === 'completed') {
    return recurringTasks.value.reduce(
      (sum, t) => sum + (t.claims ?? []).filter((c) => c.status === 'approved' && isTodayCompleted(c) && matchChild(c.user_id)).length,
      0
    );
  }
  return recTabTasks.value[k].length;
};

// ── 已完成标签：当天记录直接展示，更早的记录点「更多」查看 ─────────────────

const recShowAllCompleted = ref(false);

/** 「更多历史记录」：侧边浮动标签，始终可见（不依赖滚动位置） */

/** 更早（非今天完成）的完成记录总数 */
const olderCompletedCount = computed(() =>
  recurringTasks.value.reduce(
    (sum, t) => sum + (t.claims ?? []).filter((c) => c.status === 'approved' && !isTodayCompleted(c) && matchChild(c.user_id)).length,
    0
  )
);

/** 当前标签下展示的任务（复用现有排序） */
const recVisibleTasks = computed(() => {
  const set = new Set(recTabTasks.value[recTab.value].map((t) => t.id));
  return sortedRecurring.value.filter((t) => set.has(t.id));
});

/** 当前标签下某任务的领取记录（已领取=进行中；已完成=今天完成的，展开后显示全部） */
function recVisibleClaims(t: RecurringTask): RecurringClaim[] {
  if (recTab.value === 'completed') {
    const list = (t.claims ?? []).filter(
      (c) => c.status === 'approved' && matchChild(c.user_id) && (recShowAllCompleted.value || isTodayCompleted(c))
    );
    // 新的在前：先按完成日（期次归属日），同日再按审核时间
    return [...list].sort((a, b) =>
      String(b.period_date ?? dayKey(b.reviewed_at)).localeCompare(String(a.period_date ?? dayKey(a.reviewed_at)))
      || (b.reviewed_at ?? 0) - (a.reviewed_at ?? 0)
    );
  }
  return (t.claims ?? []).filter((c) => c.status !== 'approved' && matchChild(c.user_id));
}

function fmtTs(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 领取 / 完成记录行上的用时文案：没计时过就不显示；暂停过才补括号 */
function claimUsedText(c: RecurringClaim): string {
  const pair = fmtTimerPair(c.timer);
  if (!pair) return '';
  return `⏱ ${isTimerLive(c.timer) ? '计时中 ' : ''}${pair}`;
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1 class="title">任务中心</h1>
        <p class="subtitle">小朋友自己领取任务，完成后你审核</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-primary" @click="router.push('/parent/tasks/manage')">管理任务</button>
        <button class="btn btn-primary" @click="openRecEditor()">＋ 新建任务</button>
      </div>
    </header>

    <div v-if="recLoading && recurringTasks.length === 0" class="rec-loading">正在加载…</div>
    <EmptyState
      v-else-if="recurringTasks.length === 0"
      emoji="📋"
      text="还没有任务"
      hint="点击右上角「新建任务」，比如每天整理书桌、每周三倒垃圾"
    />
    <template v-else>
      <div class="tabs">
        <button :class="{ active: recTab === 'claimable' }" @click="recTab = 'claimable'">可领取 {{ recTabCount('claimable') }}</button>
        <button :class="{ active: recTab === 'claimed' }" @click="recTab = 'claimed'">已领取 {{ recTabCount('claimed') }}</button>
        <button :class="{ active: recTab === 'completed' }" @click="recTab = 'completed'">已完成 {{ recTabCount('completed') }}</button>
      </div>

      <!-- 按孩子筛选：三个标签通用，角标是该孩子在当前标签下的条目数 -->
      <div v-if="children.length > 1" class="child-bar">
        <button
          type="button"
          class="child-chip"
          :class="{ active: filterChild === null }"
          @click="filterChild = null"
        >全部小朋友</button>
        <button
          v-for="c in children"
          :key="c.id"
          type="button"
          class="child-chip"
          :class="{ active: filterChild === c.id }"
          @click="filterChild = c.id"
        >
          <ZodiacAvatar :zodiac="c.avatar" :size="20" />
          <span class="chip-name">{{ c.name }}</span>
          <em>{{ countForChild(c.id) }}</em>
        </button>
      </div>

      <EmptyState
        v-if="recVisibleTasks.length === 0"
        :emoji="recTab === 'claimable' ? '🙋' : recTab === 'claimed' ? '🟢' : '✅'"
        :text="recTab === 'claimable' ? '没有可领取的任务' : recTab === 'claimed' ? '还没有小朋友领取' : '今天还没有完成的记录'"
        :hint="filterChild !== null ? '这个小朋友在当前标签下暂时没有记录' : ''"
      />

      <div v-else class="task-list">
        <GlassCard v-for="t in recVisibleTasks" :key="t.id" padding="16px 18px" class="task-card">
          <div class="task-head">
            <span class="freq-badge">{{ t.freq_text }}</span>
            <span v-if="recTab === 'claimable'" class="status-badge" :class="{ active: !!t.enabled }">{{ recStatusText(t) }}</span>
            <div class="points-tag">+{{ t.points }} 🌟</div>
          </div>

          <h3 class="task-name">{{ t.name }}</h3>
          <p v-if="t.description" class="task-desc">{{ t.description }}</p>

          <div class="task-meta">
            <span class="meta-item">⏰ {{ recDueText(t) }}</span>
            <span v-if="t.valid_text" class="meta-item validity">📆 {{ t.valid_text }}</span>
            <span v-if="t.current_period" class="meta-item">{{ periodMeta(t) }}</span>
            <span class="meta-item">👶 {{ t.child_names?.length ? t.child_names.join('、') : '所有小朋友' }}</span>
          </div>

          <!-- 可领取标签：只列出还没领取的孩子（已领取的去「已领取」标签看） -->
          <div v-if="recTab === 'claimable' && claimableRows(t).length > 0" class="claim-list">
            <div v-for="r in claimableRows(t)" :key="r.id" class="claim-row">
              <ZodiacAvatar :zodiac="r.avatar" :size="28" />
              <span class="claim-name">{{ r.name }}</span>
              <span class="claim-badge" :class="r.cls">{{ r.text }}</span>
            </div>
          </div>

          <!-- 已领取 / 已完成：标明是哪个小朋友 -->
          <div v-else-if="recVisibleClaims(t).length > 0" class="claim-list">
            <div v-for="c in recVisibleClaims(t)" :key="c.id" class="claim-row">
              <ZodiacAvatar :zodiac="c.user_avatar" :size="28" />
              <span class="claim-name">{{ c.user_name }}</span>
              <span
                v-if="recTab !== 'completed'"
                class="claim-badge"
                :class="claimClass(c)"
              >{{ claimStatusText(c) }}</span>
              <span class="claim-period">{{ recTab === 'completed' ? completedText(c) : claimPeriodLine(t, c) }}</span>
              <!-- 用时：孩子开始计时才有；暂停过会在括号里补上暂停时长 -->
              <span v-if="claimUsedText(c)" class="claim-used" :class="{ live: c.timer?.state === 'running' }">
                {{ claimUsedText(c) }}
              </span>
              <!-- 已领取/已完成标签：每条记录行尾都有单独删除按钮（只删这一个孩子的记录） -->
              <button
                v-if="recTab !== 'claimable'"
                class="claim-del"
                :aria-label="`删除 ${c.user_name} 的${recTab === 'completed' ? '完成' : '领取'}记录`"
                @click="claimDeleteTarget = c"
              >✕</button>
            </div>
          </div>

          <div v-if="recTab === 'claimed'" class="actions">
            <!-- 已领取标签：只保留删除记录（不删任务本身） -->
            <button class="btn btn-ghost small danger" @click="recClearTarget = t">删除记录</button>
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

    <RecurringTaskEditor
      v-if="recEditorOpen"
      v-model="recEditorOpen"
      :task="editingRecurring"
      :children="children"
      @saved="onRecSaved"
    />

    <ConfirmDialog
      :model-value="recClearTarget !== null"
      title="删除领取记录"
      :message="recClearTarget ? `确定删除「${recClearTarget.name}」的所有领取和完成记录？任务本身会保留，小朋友可以重新领取` : ''"
      confirm-text="确定"
      cancel-text="取消"
      variant="danger"
      @update:model-value="!$event && (recClearTarget = null)"
      @confirm="recClearTarget && clearRecurringClaims(recClearTarget)"
    />

    <ConfirmDialog
      :model-value="claimDeleteTarget !== null"
      title="删除记录"
      :message="claimDeleteTarget ? `确定删除「${claimDeleteTarget.user_name}」在期次 ${claimDeleteTarget.period_key} 的记录？删除后小朋友可以重新领取` : ''"
      confirm-text="确定"
      cancel-text="取消"
      variant="danger"
      @update:model-value="!$event && (claimDeleteTarget = null)"
      @confirm="claimDeleteTarget && removeClaim(claimDeleteTarget)"
    />
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: var(--space-16);
  gap: var(--space-12);
}
.title { font-size: var(--fs-3xl); margin-bottom: var(--space-2); }
.subtitle { color: var(--text-secondary); font-size: var(--fs-sm); }

.header-actions {
  display: flex;
  gap: var(--space-10);
  align-items: center;
}

.freq-badge {
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  font-weight: 600;
  background: rgba(255, 152, 92, 0.15);
  color: var(--text-on-orange);
  white-space: nowrap;
}
.rec-loading {
  padding: var(--space-24) 0;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}
.status-badge.active { background: rgba(126, 212, 185, 0.2); color: var(--text-on-mint); }

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

/* ── 按孩子筛选 ─────────────────────────────────────────────────────────── */
.child-bar {
  display: flex;
  gap: var(--space-8);
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  /* 上下留出选中态阴影的空间，再用负 margin 抵消占位（同商城筛选条的处理） */
  padding: 8px 12px 16px;
  margin: -8px 0 calc(var(--space-16) - 16px);
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

.task-list { display: flex; flex-direction: column; gap: var(--space-12); }
.task-card { transition: transform var(--dur-fast); }

.task-head {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  margin-bottom: var(--space-8);
}
.status-badge {
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  font-weight: 600;
  background: rgba(126, 212, 185, 0.2);
  color: var(--text-on-mint);
}
.points-tag {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-6) var(--space-14);
  border-radius: var(--r-lg);
  background: linear-gradient(135deg, rgba(255, 209, 102, 0.28), rgba(255, 209, 102, 0.12));
  border: 1px solid rgba(255, 209, 102, 0.45);
  box-shadow: 0 2px 8px rgba(255, 209, 102, 0.15);
  font-family: var(--font-cute);
  color: var(--text-on-yellow);
  font-size: var(--fs-lg);
  white-space: nowrap;
}

.task-name {
  font-size: var(--fs-lg);
  margin-bottom: var(--space-4);
  font-family: var(--font-cute);
}
.task-desc {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-bottom: var(--space-8);
  line-height: 1.5;
}
.task-meta {
  display: flex;
  gap: var(--space-16);
  flex-wrap: wrap;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-bottom: var(--space-8);
}
.task-meta .validity { color: var(--text-on-orange); }

.claim-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  margin-bottom: var(--space-10);
}
.claim-row {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-6) var(--space-10);
  background: var(--glass-bg);
  border-radius: var(--r-sm);
}
.claim-name {
  font-family: var(--font-cute);
  font-size: var(--fs-sm);
}
.claim-badge {
  padding: 2px var(--space-8);
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.claim-badge.claimed { background: rgba(126, 212, 185, 0.2); color: var(--text-on-mint); }
.claim-badge.pending { background: rgba(255, 209, 102, 0.2); color: var(--text-on-yellow); }
.claim-badge.rejected { background: rgba(255, 122, 122, 0.2); color: var(--text-on-red); }
.claim-badge.expired { background: rgba(255, 122, 122, 0.2); color: var(--text-on-red); }
.claim-badge.approved { background: rgba(126, 212, 185, 0.3); color: var(--text-on-mint); }
/* 「待领取」：中性色，和已领取标签下的状态徽标同一套样式 */
.claim-badge.waiting { background: rgba(120, 118, 140, 0.16); color: var(--text-secondary); }
.claim-period {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  white-space: nowrap;
}
/* 用时：和期次排在一起，正在计时的高亮一下 */
.claim-used {
  font-size: var(--fs-xs);
  color: var(--text-on-mint);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.claim-used.live { color: var(--text-on-orange); font-weight: 600; }
/* 单独删除某条记录的小按钮 */
.claim-del {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: var(--fs-xs);
  line-height: 1;
  color: var(--text-muted);
  background: transparent;
  transition: all var(--dur-fast);
}
.claim-del:hover {
  color: #fff;
  background: rgba(255, 122, 122, 0.75);
}

.actions {
  display: flex;
  gap: var(--space-8);
  flex-wrap: wrap;
}
.more-side {
  /* 「更多历史记录」：贴在任务页右侧、垂直居中的浮动标签。
     底色与 .glass-card / .btn 同一套玻璃 token（和审核入口按钮同配方），只圆左侧两角，
     像从页面侧边抽出来的一张签；不再用滚动位置做显示条件。 */
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
.small {
  padding: var(--space-6) var(--space-14);
  font-size: var(--fs-sm);
}
.danger:hover {
  color: var(--text-on-red);
}

@media (max-width: 768px) {
  .page-header { flex-direction: column; align-items: stretch; }
}
</style>
