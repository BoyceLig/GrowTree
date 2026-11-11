<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { api } from '@/api/client';
import GlassCard from '@/components/GlassCard.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import EmptyState from '@/components/EmptyState.vue';
import { sourceKind } from '@/utils/point-source';

interface Log {
  id: number;
  user_id: number;
  user_name: string;
  delta: number;
  source: string;
  note: string | null;
  creator_name: string | null;
  created_at: number;
  /** 本地日期 YYYY-MM-DD（后端按天分页时附带，分组/统计都用它） */
  day?: string;
}

interface Child { id: number; name: string; avatar: string }

interface DayGroup {
  day: string;
  label: string;
  logs: Log[];
  /** 当天每个孩子的加/减分合计 */
  totals: { id: number; name: string; gain: number; loss: number }[];
}

interface SummaryRow {
  user_id: number;
  user_name: string;
  gain: number;
  loss: number;
  count: number;
}

const children = ref<Child[]>([]);
const logs = ref<Log[]>([]);
/** 已加载的日期（新→旧），按天分页的「书签」 */
const days = ref<string[]>([]);
const page = ref(0);
const hasMore = ref(false);
const totalDays = ref(0);
const loading = ref(true);
const loadingMore = ref(false);
const filterUserId = ref<number | null>(null);

/** 「更多」每次展开多少天（与后端 DAY_PAGE_SIZE 一致） */
const DAY_PAGE_SIZE = 50;

async function loadChildren() {
  const res = await api.get<{ children: Child[] }>('/children');
  children.value = res.children;
}

function query(extra: Record<string, string>): string {
  const qs = new URLSearchParams(extra);
  if (filterUserId.value) qs.set('userId', String(filterUserId.value));
  return qs.toString();
}

/** 从第一页拉起（筛选变化 / 首次进入） */
async function resetList() {
  loading.value = true;
  try {
    page.value = 0;
    const res = await api.get<{
      days: string[]; logs: Log[]; hasMore: boolean; totalDays: number;
    }>(`/point-logs/by-day?${query({ page: '0' })}`);
    days.value = res.days;
    logs.value = res.logs;
    hasMore.value = res.hasMore;
    totalDays.value = res.totalDays;
  } finally {
    loading.value = false;
  }
}

/** 「更多」：再往前翻一页（50 天），追加到已有记录后面，直到没有为止 */
async function loadMore() {
  if (loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  try {
    const next = page.value + 1;
    const res = await api.get<{
      days: string[]; logs: Log[]; hasMore: boolean; totalDays: number;
    }>(`/point-logs/by-day?${query({ page: String(next) })}`);
    days.value = [...days.value, ...res.days];
    logs.value = [...logs.value, ...res.logs];
    hasMore.value = res.hasMore;
    totalDays.value = res.totalDays;
    page.value = next;
  } finally {
    loadingMore.value = false;
  }
}

// ── 按天分组 + 每天每个孩子的加/减分合计 ─────────────────────────────────

function todayStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  const base = `${m}月${d}日 ${week}`;
  if (day === todayStr()) return `今天 · ${base}`;
  if (day === todayStr(-1)) return `昨天 · ${base}`;
  return y === new Date().getFullYear() ? base : `${y}年${base}`;
}

const dayGroups = computed<DayGroup[]>(() =>
  days.value
    .map((day) => {
      const dayLogs = logs.value.filter((l) => l.day === day);
      const map = new Map<number, { id: number; name: string; gain: number; loss: number }>();
      for (const l of dayLogs) {
        const cur = map.get(l.user_id) ?? { id: l.user_id, name: l.user_name, gain: 0, loss: 0 };
        if (l.delta > 0) cur.gain += l.delta;
        else cur.loss += l.delta;
        map.set(l.user_id, cur);
      }
      // 展示顺序跟筛选条上的孩子顺序一致
      const order = new Map(children.value.map((c, i) => [c.id, i]));
      const totals = [...map.values()].sort(
        (a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99) || a.id - b.id
      );
      return { day, label: dayLabel(day), logs: dayLogs, totals };
    })
    .filter((g) => g.logs.length > 0)
);

// ── 时间段统计：每个孩子的加/减分合计 ────────────────────────────────────

const sumFrom = ref('');
const sumTo = ref('');
const summaryLoading = ref(false);
const summaryDone = ref(false);
const summaryRows = ref<SummaryRow[]>([]);
const summaryRange = ref<{ from: string | null; to: string | null }>({ from: null, to: null });

async function runSummary() {
  if (!sumFrom.value && !sumTo.value) return;
  summaryLoading.value = true;
  try {
    const res = await api.get<{ summary: SummaryRow[]; from: string | null; to: string | null }>(
      `/point-logs/summary?${query({ from: sumFrom.value, to: sumTo.value })}`
    );
    summaryRows.value = res.summary;
    summaryRange.value = { from: res.from, to: res.to };
    summaryDone.value = true;
  } catch {
    summaryDone.value = false;
  } finally {
    summaryLoading.value = false;
  }
}

function clearSummary() {
  sumFrom.value = '';
  sumTo.value = '';
  summaryRows.value = [];
  summaryDone.value = false;
}

/** 统计结果：没出现的孩子也补 0，家长能看到完整名单 */
const summaryView = computed(() => {
  if (!summaryDone.value) return [];
  const byId = new Map(summaryRows.value.map((r) => [r.user_id, r]));
  return children.value
    .map((c) => {
      const r = byId.get(c.id);
      return {
        id: c.id,
        name: c.name,
        avatar: c.avatar,
        gain: r?.gain ?? 0,
        loss: r?.loss ?? 0,
        count: r?.count ?? 0,
      };
    })
    .sort((a, b) => b.gain + b.loss - (a.gain + a.loss));
});

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

const sourceLabels: Record<string, string> = {
  daily: '日常',
  recurring: '周期任务',
  adhoc: '临时任务',
  exchange: '兑换',
  adjust: '临时',
};

function childName(id: number): string {
  return children.value.find((c) => c.id === id)?.name ?? '';
}

function switchFilter(id: number | null) {
  filterUserId.value = id;
  clearSummary();
  void resetList();
}

onMounted(async () => {
  await loadChildren();
  await resetList();
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1 class="title">积分流水</h1>
      <p class="subtitle">按天分组，每天标题里是各孩子当天的加/减分合计</p>
    </header>

    <div class="filters">
      <button :class="{ active: filterUserId === null }" @click="switchFilter(null)">
        全部
      </button>
      <button
        v-for="c in children"
        :key="c.id"
        :class="{ active: filterUserId === c.id }"
        @click="switchFilter(c.id)"
      >
        {{ c.name }}
      </button>
    </div>

    <!-- 时间段统计 -->
    <GlassCard padding="14px 16px" class="summary-card">
      <div class="summary-head">
        <span class="summary-title">📊 时间段统计</span>
        <span class="summary-hint">选起止日期，算每个孩子一共加/减了多少分</span>
      </div>
      <div class="summary-form">
        <input v-model="sumFrom" type="date" class="date-input" aria-label="开始日期" />
        <span class="dash">→</span>
        <input v-model="sumTo" type="date" class="date-input" aria-label="结束日期" />
        <button
          class="btn btn-primary sum-btn"
          :disabled="summaryLoading || (!sumFrom && !sumTo)"
          @click="runSummary"
        >{{ summaryLoading ? '统计中…' : '统计' }}</button>
        <button v-if="summaryDone" class="btn btn-ghost" @click="clearSummary">清空</button>
      </div>

      <div v-if="summaryDone" class="summary-result">
        <div v-for="row in summaryView" :key="row.id" class="sum-row">
          <ZodiacAvatar :zodiac="row.avatar" :size="30" />
          <span class="sum-name">{{ row.name }}</span>
          <span class="sum-net" :class="row.gain + row.loss > 0 ? 'gain' : row.gain + row.loss < 0 ? 'loss' : ''">
            净 {{ (row.gain + row.loss) > 0 ? '+' : '' }}{{ row.gain + row.loss }}
          </span>
          <span class="sum-detail">
            <b class="g">+{{ row.gain }}</b> / <b class="l">{{ row.loss }}</b>
            <i v-if="row.count" class="cnt">{{ row.count }} 笔</i>
          </span>
        </div>
        <p class="sum-range">
          统计范围：{{ summaryRange.from || '最早' }} ~ {{ summaryRange.to || '今天' }}
        </p>
      </div>
    </GlassCard>

    <EmptyState v-if="!loading && logs.length === 0" emoji="📜" text="还没有积分记录哦" />

    <div v-else class="days">
      <section v-for="g in dayGroups" :key="g.day" class="day-group">
        <header class="day-head">
          <span class="day-title">{{ g.label }}</span>
          <span class="day-totals">
            <span v-for="t in g.totals" :key="t.id" class="day-chip" :title="childName(t.id)">
              <b class="chip-name">{{ childName(t.id) || t.name }}</b>
              <i class="chip-gain">+{{ t.gain }}</i>
              <i class="chip-loss">{{ t.loss }}</i>
            </span>
          </span>
        </header>

        <GlassCard v-for="log in g.logs" :key="log.id" padding="12px 14px" class="log-item">
          <div :class="['delta', log.delta > 0 ? 'gain' : 'loss']">
            {{ log.delta > 0 ? '+' : '' }}{{ log.delta }}
          </div>
          <div class="content">
            <div class="row1">
              <strong>{{ log.user_name }}</strong>
              <span class="note">{{ log.note }}</span>
            </div>
            <div class="row2">
              <span class="tag">{{ sourceLabels[sourceKind(log.source, log.note)] ?? log.source }}</span>
              <span v-if="log.creator_name" class="op">操作人：{{ log.creator_name }}</span>
              <span class="time">{{ fmtTime(log.created_at) }}</span>
            </div>
          </div>
        </GlassCard>
      </section>

      <!-- 更多：每次往前翻 50 天，翻完为止 -->
      <button v-if="hasMore" class="btn btn-ghost load-more" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? '加载中…' : `更多（还有 ${totalDays - days.length} 天）` }}
      </button>
      <p v-else-if="logs.length > 0" class="end-hint">— 已经到底啦，共 {{ totalDays }} 天 —</p>
    </div>
  </div>
</template>

<style scoped>
.page-header { margin-bottom: var(--space-16); }
.title { font-size: var(--fs-3xl); margin-bottom: var(--space-2); }
.subtitle { color: var(--text-secondary); font-size: var(--fs-sm); }

.filters {
  display: flex;
  gap: var(--space-6);
  margin-bottom: var(--space-12);
  overflow-x: auto;
  padding-bottom: var(--space-4);
  scrollbar-width: none;
}
.filters::-webkit-scrollbar { display: none; }
.filters button {
  padding: var(--space-6) var(--space-14);
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  color: var(--text-secondary);
  white-space: nowrap;
  font-size: var(--fs-sm);
  transition: all var(--dur-base);
}
.filters button.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}

/* 时间段统计 */
.summary-card { margin-bottom: var(--space-16); }
.summary-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-10);
  margin-bottom: var(--space-10);
  flex-wrap: wrap;
}
.summary-title { font-family: var(--font-cute); font-size: var(--fs-md); }
.summary-hint { font-size: var(--fs-xs); color: var(--text-muted); }
.summary-form {
  /* 起止日期 + 统计/清空按钮固定一行：日期框允许收缩（min-width:0），
     窄屏也不换行 */
  display: flex;
  align-items: center;
  gap: var(--space-8);
  flex-wrap: nowrap;
}
.date-input {
  flex: 1 1 0;
  min-width: 0;
  padding: var(--space-6) var(--space-10);
  border-radius: var(--r-sm);
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  font-size: var(--fs-sm);
  color: var(--text-primary);
  font-family: inherit;
}
.dash { color: var(--text-muted); flex-shrink: 0; }
.sum-btn { padding: var(--space-6) var(--space-14); font-size: var(--fs-sm); flex-shrink: 0; }
.summary-form .btn.btn-ghost { flex-shrink: 0; }

.summary-result {
  margin-top: var(--space-12);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.sum-row {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  padding: var(--space-6) var(--space-10);
  background: var(--glass-bg);
  border-radius: var(--r-sm);
}
.sum-name {
  font-family: var(--font-cute);
  font-size: var(--fs-sm);
  min-width: 3.5em;
}
.sum-net { font-size: var(--fs-sm); font-weight: 700; color: var(--text-secondary); }
.sum-net.gain { color: var(--text-on-mint); }
.sum-net.loss { color: var(--text-on-pink); }
.sum-detail { margin-left: auto; font-size: var(--fs-xs); color: var(--text-secondary); }
.sum-detail .g { color: var(--text-on-mint); font-weight: 600; }
.sum-detail .l { color: var(--text-on-pink); font-weight: 600; }
.sum-detail .cnt { color: var(--text-muted); font-style: normal; margin-left: var(--space-6); }
.sum-range { font-size: var(--fs-xs); color: var(--text-muted); padding-left: var(--space-4); }

/* 按天分组 */
.days { display: flex; flex-direction: column; gap: var(--space-16); }
.day-group { display: flex; flex-direction: column; gap: var(--space-8); }
.day-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-10);
  flex-wrap: wrap;
  padding: 0 var(--space-4);
}
.day-title {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  color: var(--text-primary);
}
.day-totals { display: flex; gap: var(--space-6); flex-wrap: wrap; }
.day-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-8);
  border-radius: var(--r-xs);
  background: var(--glass-bg);
  font-size: var(--fs-xs);
  line-height: 1.4;
}
.chip-name { color: var(--text-secondary); font-weight: 600; }
.chip-gain { color: var(--text-on-mint); font-style: normal; }
.chip-loss { color: var(--text-on-pink); font-style: normal; }

.log-item {
  display: flex;
  align-items: center;
  gap: var(--space-14);
}
.delta {
  width: 60px;
  text-align: center;
  font-family: var(--font-cute);
  font-size: var(--fs-2xl);
  flex-shrink: 0;
}
.delta.gain { color: var(--text-on-mint); }
.delta.loss { color: var(--text-on-pink); }

.content { flex: 1; min-width: 0; }
.row1 { display: flex; align-items: center; gap: var(--space-8); font-size: var(--fs-sm); }
.note { color: var(--text-secondary); overflow-wrap: anywhere; }

.row2 {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  margin-top: var(--space-4);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.tag {
  padding: var(--space-2) var(--space-8);
  border-radius: var(--r-xs);
  background: var(--glass-bg);
}

.load-more {
  margin: var(--space-4) auto 0;
  display: block;
}
.end-hint {
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  padding: var(--space-8) 0;
}
</style>
