<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { sourceKind } from '@/utils/point-source';
import GlassCard from '@/components/GlassCard.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import EmptyState from '@/components/EmptyState.vue';
import Modal from '@/components/Modal.vue';
import TreeHoleBox from '@/components/TreeHoleBox.vue';
import ReviewCenterBox from '@/components/ReviewCenterBox.vue';
import BackpackModal from '@/components/BackpackModal.vue';

const router = useRouter();

interface ChildCard {
  id: number;
  name: string;
  avatar: string;
  total_points: number;
  today_points: number;
}

interface Dashboard {
  children: ChildCard[];
  todaySummary: { gain: number; loss: number; count: number };
}

interface Log {
  id: number;
  delta: number;
  note: string;
  source: string;
  creator_name: string | null;
  created_at: number;
}

const data = ref<Dashboard | null>(null);
const loading = ref(true);

// 积分记录弹窗
const logsOpen = ref(false);
const logsChild = ref<ChildCard | null>(null);
const logs = ref<Log[]>([]);
const logsLoading = ref(false);

// 孩子背包弹窗（家长模式：可查看 + 拿走道具）
const backpackOpen = ref(false);
const backpackChild = ref<ChildCard | null>(null);
function openBackpack(c: ChildCard) {
  backpackChild.value = c;
  backpackOpen.value = true;
}

const sortedChildren = computed(() => {
  const list = data.value?.children ?? [];
  return [...list].sort((a, b) => b.total_points - a.total_points);
});

const sourceLabels: Record<string, string> = {
  daily: '⭐ 日常',
  recurring: '📋 周期任务',
  adhoc: '📋 任务',
  exchange: '🎁 兑换',
  adjust: '✏️ 调整',
};

/** silent = 后台静默同步（不显示加载态）：用于 WebSocket 推送后的自动刷新 */
async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    data.value = await api.get<Dashboard>('/dashboard');
    // 关掉的明细弹窗里如果还开着，也顺手刷新，避免看到旧数据
    if (logsOpen.value && logsChild.value) {
      const res = await api.get<{ logs: Log[] }>(`/point-logs?userId=${logsChild.value.id}&limit=30`);
      logs.value = res.logs;
    }
  } catch {
    /* 静默同步失败不弹错，保持原数据 */
  } finally {
    if (!silent) loading.value = false;
  }
}

/** WebSocket：孩子的加分/任务提交/兑换申请等 → 首页总览立刻更新，不用手动刷新 */
function onPush() { load(true); }

const PUSH_EVENTS = [
  'ws:points_changed',
  'ws:new_exchange_request',
  'ws:task_completion_submitted',
  'ws:recurring_claim_submitted',
  'ws:recurring_review',
  'ws:recurring_claims_cleared',
  'ws:recurring_tasks_changed',
  'ws:growth_recorded',
  'ws:products_changed',
];

// 点击今日统计卡片 → 积分记录页
function goLogs() {
  router.push('/parent/logs');
}

async function openLogs(c: ChildCard) {
  logsChild.value = c;
  logsOpen.value = true;
  logsLoading.value = true;
  try {
    const res = await api.get<{ logs: Log[] }>(`/point-logs?userId=${c.id}&limit=30`);
    logs.value = res.logs;
  } finally {
    logsLoading.value = false;
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (d.toDateString() === now.toDateString()) {
    return `今天 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

onMounted(() => {
  load();
  for (const ev of PUSH_EVENTS) window.addEventListener(ev, onPush);
});
onUnmounted(() => {
  for (const ev of PUSH_EVENTS) window.removeEventListener(ev, onPush);
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1 class="title">总览</h1>
        <p class="subtitle">家庭积分排行</p>
      </div>
    </header>

    <!-- 今日统计（点击整卡查看积分记录） -->
    <GlassCard v-if="data" class="today-summary" padding="16px 20px" hover clickable @click="goLogs">
      <div class="summary-grid">
        <div class="summary-item">
          <span class="label">今日加分</span>
          <span class="value gain">+{{ data.todaySummary.gain }}</span>
        </div>
        <div class="divider"></div>
        <div class="summary-item">
          <span class="label">今日扣分</span>
          <span class="value loss">{{ data.todaySummary.loss }}</span>
        </div>
        <div class="divider"></div>
        <div class="summary-item">
          <span class="label">今日操作</span>
          <span class="value">{{ data.todaySummary.count }} 次</span>
        </div>
      </div>
    </GlassCard>

    <!-- 树洞信箱：家长在这里选孩子、看历史、发留言。
         放在今日统计下面：它是每天都会看一眼的入口，但不如积分排行重要。
         孩子一个都没建时组件自己会给出提示，不会渲染出一个空壳。 -->
    <TreeHoleBox />

    <!-- 审核：心愿单 + 商城兑换 + 任务完成合并处理 -->
    <ReviewCenterBox />

    <!-- 排行榜 -->
    <div v-if="loading" class="loading">
      <div v-for="i in 3" :key="i" class="skeleton-card"></div>
    </div>

    <EmptyState
      v-else-if="sortedChildren.length === 0"
      emoji="🐣"
      text="还没有小朋友呢"
      hint="在右上角「账号管理」里新增一个吧~"
    />

    <div v-else class="rank-list">
      <GlassCard
        v-for="c in sortedChildren"
        :key="c.id"
        hover
        padding="18px 20px"
        class="rank-card"
        @click="openLogs(c)"
      >
        <ZodiacAvatar :zodiac="c.avatar" :size="72" show-ring />
        <div class="info">
          <div class="name">{{ c.name }}</div>
          <div class="meta">
            今日得分 <strong class="today-points">+{{ c.today_points }}</strong>
          </div>
        </div>
        <div class="points">
          <span class="num">{{ c.total_points }}</span>
          <span class="unit">分</span>
        </div>
        <!-- 背包入口：emoji + 文字，点这里看孩子背包，不触发整卡的积分记录 -->
        <button class="bp-entry" title="查看孩子的背包：可赠送物品、拿走道具" @click.stop="openBackpack(c)">
          <span class="bp-entry-icon">🎒</span>
          <span class="bp-entry-text">背包</span>
        </button>
      </GlassCard>
    </div>


    <!-- 孩子背包弹窗（家长模式：可查看 + 拿走道具） -->
    <BackpackModal
      v-model="backpackOpen"
      :child-id="backpackChild?.id"
      :child-name="backpackChild?.name"
    />

    <!-- 积分记录弹窗 -->
    <Modal
      v-model="logsOpen"
      :title="logsChild ? `${logsChild.name} 的积分记录` : '积分记录'"
      width="480px"
    >
      <div v-if="logsLoading" class="logs-loading">加载中...</div>
      <div v-else-if="logs.length === 0" class="logs-empty">暂无积分记录</div>
      <div v-else class="logs-list">
        <div v-for="log in logs" :key="log.id" class="log-item">
          <div :class="['log-delta', log.delta > 0 ? 'gain' : 'loss']">
            {{ log.delta > 0 ? '+' : '' }}{{ log.delta }} 🌟
          </div>
          <div class="log-body">
            <div class="log-note">
              <span class="log-source">{{ sourceLabels[sourceKind(log.source, log.note)] || log.source }}</span>
              <span v-if="log.note">· {{ log.note }}</span>
            </div>
            <div class="log-time">{{ fmtTime(log.created_at) }}</div>
          </div>
        </div>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: var(--space-20);
  gap: var(--space-12);
}
.title { font-size: var(--fs-3xl); margin-bottom: var(--space-2); }
.subtitle { color: var(--text-secondary); font-size: var(--fs-sm); }

.today-summary {
  margin-bottom: var(--space-24);
}
.summary-grid {
  display: flex;
  align-items: center;
  justify-content: space-around;
}
.summary-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-6);
}
.summary-item .label {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.summary-item .value {
  font-size: var(--fs-2xl);
  font-family: var(--font-cute);
}
.gain { color: var(--text-on-mint); }
.loss { color: var(--text-on-pink); }
.divider {
  width: 1px;
  height: 32px;
  background: var(--glass-border);
}

.loading {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}
.skeleton-card {
  height: 88px;
  border-radius: var(--r-lg);
  background: var(--glass-bg);
  animation: pulse var(--dur-pulse) ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.8; }
}

.rank-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}

.rank-card {
  display: flex;
  align-items: center;
  gap: var(--space-14);
}

.info { flex: 1; }
.name { font-size: var(--fs-lg); font-family: var(--font-cute); }
.meta { font-size: var(--fs-xs); color: var(--text-muted); margin-top: var(--space-2); }
.today-points {
  color: var(--text-on-mint);
  font-family: var(--font-cute);
  font-size: var(--fs-sm);
}

.points {
  text-align: right;
}
/* 背包入口按钮：emoji + 文字，放在积分右侧，独立可点（阻止冒泡避免误开积分记录） */
.bp-entry {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 52px;
  padding: var(--space-8) var(--space-10);
  margin-left: var(--space-4);
  border-radius: var(--r-md);
  background: rgba(130, 192, 255, 0.18);
  border: 1px solid rgba(130, 192, 255, 0.4);
  cursor: pointer;
  transition: all var(--dur-fast);
}
.bp-entry-icon { font-size: 20px; line-height: 1; }
.bp-entry-text { font-size: var(--fs-2xs); color: var(--text-on-sky); font-weight: 600; }
.bp-entry:hover {
  transform: translateY(-2px);
  background: rgba(130, 192, 255, 0.3);
  box-shadow: 0 4px 10px rgba(80, 144, 220, 0.25);
}
.points .num {
  font-size: var(--fs-3xl);
  font-family: var(--font-cute);
  color: var(--text-on-yellow);
}
.points .unit {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-left: var(--space-2);
}

/* 积分记录弹窗 */
.logs-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
  max-height: 60vh;
  overflow-y: auto;
  padding-right: var(--space-4);
}
.log-item {
  display: flex;
  align-items: center;
  gap: var(--space-14);
  padding: var(--space-12) var(--space-14);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
}
.log-delta {
  font-size: var(--fs-xl);
  font-family: var(--font-cute);
  flex-shrink: 0;
  min-width: 72px;
  text-align: right;
}
.log-delta.gain { color: var(--text-on-mint); }
.log-delta.loss { color: var(--text-on-pink); }
.log-body {
  flex: 1;
  min-width: 0;
}
.log-note {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-source {
  margin-right: var(--space-4);
  opacity: 0.8;
}
.log-time {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-top: var(--space-2);
}
.logs-loading, .logs-empty {
  padding: var(--space-32) 0;
  text-align: center;
  color: var(--text-muted);
}
</style>
