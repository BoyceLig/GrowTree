<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import GlassCard from '@/components/GlassCard.vue';
import EmptyState from '@/components/EmptyState.vue';
import RecurringTaskEditor from '@/components/RecurringTaskEditor.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const router = useRouter();
const toast = useToastStore();

interface RecurringClaim {
  id: number;
  user_id: number;
  user_name: string;
  period_key: string;
  status: 'claimed' | 'pending' | 'approved' | 'rejected';
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

const recurringTasks = ref<RecurringTask[]>([]);
const recLoading = ref(false);
const recEditorOpen = ref(false);
const editingRecurring = ref<RecurringTask | null>(null);
const recDeleteTarget = ref<RecurringTask | null>(null);

async function loadRecurring() {
  recLoading.value = true;
  try {
    const res = await api.get<{ tasks: RecurringTask[] }>('/recurring-tasks');
    recurringTasks.value = res.tasks;
  } finally {
    recLoading.value = false;
  }
}

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

/** 本地时区今天 YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 截止说明：单次任务不设结束日期时没有截止时间 */
function recDueText(t: RecurringTask): string {
  if (t.once_only) {
    if (!t.valid_to) return '单次任务 · 完成一次即可';
    return `${t.due_time ?? '23:59'} 前完成`;
  }
  return `${t.due_time ?? '23:59'} 前完成`;
}

/** 期次文案：单次任务没有「本期」概念 */
function periodMeta(t: RecurringTask): string {
  if (t.once_only) return '🔂 单次任务（只做一次）';
  return `🧾 本期：${t.current_period?.period_key ?? ''}`;
}

function openRecEditor(task?: RecurringTask) {
  editingRecurring.value = task ?? null;
  recEditorOpen.value = true;
}

async function onRecSaved() {
  recEditorOpen.value = false;
  await loadRecurring();
}

async function removeRecurring(task: RecurringTask) {
  try {
    await api.delete(`/recurring-tasks/${task.id}`);
    toast.success('已删除');
    await loadRecurring();
  } catch (e: any) {
    toast.error(e.message || '删除失败');
  }
}

async function toggleEnabled(task: RecurringTask) {
  try {
    await api.patch(`/recurring-tasks/${task.id}`, { enabled: !task.enabled });
    await loadRecurring();
  } catch (e: any) {
    toast.error(e.message || '操作失败');
  }
}

/**
 * 排序权重。用户明确要求「暂停和结束的任务自动排到后面」：
 *   0 = 还在用的（进行中，以及刚创建、等着生效的「未开始」）
 *   1 = 已结束（过了 valid_to）
 *   2 = 已停用（家长手动暂停）
 * 「未开始」故意不沉底 —— 那是家长刚建好、下周才生效的任务，沉到底部会让人以为没建成功。
 */
function taskWeight(t: RecurringTask): number {
  if (!t.enabled) return 2;
  if (!t.in_range) {
    const today = todayStr();
    if (t.valid_from && today < t.valid_from) return 0; // 未开始
    return 1; // 已结束
  }
  return 0;
}

/** 仍在用的排前面，结束/停用的排后面；同组内新建的在上面（id 大的在前） */
const sortedRecurring = computed(() =>
  [...recurringTasks.value].sort(
    (a, b) => taskWeight(a) - taskWeight(b) || b.id - a.id
  )
);

// ── 公共 ────────────────────────────────────────────────────────────────────

interface Child {
  id: number;
  name: string;
  avatar: string;
}

const children = ref<Child[]>([]);

async function load() {
  await loadRecurring();
  try {
    const res = await api.get<{ children: Child[] }>('/children');
    children.value = res.children;
  } catch { /* 编辑器需要，失败不阻塞页面 */ }
}

function onWsEvent() { load(); }
onMounted(() => {
  load();
  window.addEventListener('ws:recurring_claim_submitted', onWsEvent);
  window.addEventListener('ws:recurring_review', onWsEvent);
  window.addEventListener('ws:recurring_tasks_changed', onWsEvent);
  window.addEventListener('ws:recurring_claims_cleared', onWsEvent);
});
onUnmounted(() => {
  window.removeEventListener('ws:recurring_claim_submitted', onWsEvent);
  window.removeEventListener('ws:recurring_review', onWsEvent);
  window.removeEventListener('ws:recurring_tasks_changed', onWsEvent);
  window.removeEventListener('ws:recurring_claims_cleared', onWsEvent);
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1 class="title">管理任务</h1>
        <p class="subtitle">编辑、停用或删除已发布的任务</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost" @click="router.push('/parent/tasks')">返回任务</button>
        <button class="btn btn-primary" @click="openRecEditor()">＋ 新建任务</button>
      </div>
    </header>

    <div v-if="recLoading && recurringTasks.length === 0" class="loading-tip">正在加载…</div>
    <EmptyState
      v-else-if="sortedRecurring.length === 0"
      emoji="📋"
      text="还没有任务"
      hint="点右上角「新建任务」创建吧"
    />
    <div v-else class="task-list">
      <GlassCard v-for="t in sortedRecurring" :key="t.id" padding="16px 18px" class="task-card">
        <div class="task-head">
          <span class="freq-badge">{{ t.freq_text }}</span>
          <span class="status-badge" :class="{ active: !!t.enabled }">{{ recStatusText(t) }}</span>
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

        <div v-if="t.claims?.length" class="claim-summary">
          已有 {{ t.claims.length }} 条领取记录（待审核 {{ t.pending_count }} 条）
        </div>

        <div class="actions">
          <button class="btn btn-ghost small" @click="openRecEditor(t)">编辑</button>
          <button class="btn btn-ghost small" @click="toggleEnabled(t)">
            {{ t.enabled ? '停用' : '启用' }}
          </button>
          <button class="btn btn-ghost small danger" @click="recDeleteTarget = t">删除</button>
        </div>
      </GlassCard>
    </div>

    <RecurringTaskEditor
      v-if="recEditorOpen"
      v-model="recEditorOpen"
      :task="editingRecurring"
      :children="children"
      @saved="onRecSaved"
    />

    <ConfirmDialog
      :model-value="recDeleteTarget !== null"
      title="删除任务"
      :message="recDeleteTarget ? `确定删除任务「${recDeleteTarget.name}」？相关的领取记录也会一起删除哦` : ''"
      confirm-text="确定"
      cancel-text="取消"
      variant="danger"
      @update:model-value="!$event && (recDeleteTarget = null)"
      @confirm="recDeleteTarget && removeRecurring(recDeleteTarget)"
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
  flex-shrink: 0;
}

.loading-tip {
  padding: var(--space-24) 0;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-sm);
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
.status-badge {
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  font-weight: 600;
  background: rgba(126, 212, 185, 0.2);
  color: var(--text-on-mint);
}
.status-badge.active { background: rgba(126, 212, 185, 0.2); color: var(--text-on-mint); }
.status-badge.expired { background: rgba(255, 122, 122, 0.2); color: var(--text-on-red); }
.status-badge.completed { background: rgba(126, 212, 185, 0.3); color: var(--text-on-mint); }
.status-badge.pending { background: rgba(255, 209, 102, 0.2); color: var(--text-on-yellow); }
.status-badge.rejected { background: rgba(255, 122, 122, 0.2); color: var(--text-on-red); }

.task-list { display: flex; flex-direction: column; gap: var(--space-12); }

.task-head {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  margin-bottom: var(--space-8);
}
.user-info { display: flex; align-items: center; gap: var(--space-8); }
.user-name { font-family: var(--font-cute); font-size: var(--fs-sm); }

.points-tag {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-6) var(--space-14);
  border-radius: var(--r-lg);
  background: linear-gradient(135deg, rgba(255, 209, 102, 0.28), rgba(255, 209, 102, 0.12));
  border: 1px solid rgba(255, 209, 102, 0.45);
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

.claim-summary {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  background: var(--glass-bg);
  padding: var(--space-6) var(--space-10);
  border-radius: var(--r-sm);
  margin-bottom: var(--space-8);
}

.actions {
  display: flex;
  gap: var(--space-8);
  flex-wrap: wrap;
}
.small {
  padding: var(--space-6) var(--space-14);
  font-size: var(--fs-sm);
}
.danger:hover { color: var(--text-on-red); }

@media (max-width: 768px) {
  .page-header { flex-direction: column; align-items: stretch; }
}
</style>
