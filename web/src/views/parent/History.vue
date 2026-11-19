<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '@/api/client';
import GlassCard from '@/components/GlassCard.vue';
import EmptyState from '@/components/EmptyState.vue';
import { useToastStore } from '@/stores/toast';

/**
 * 家庭操作历史（2026-11-16）：全家庭 append-only 审计时间线。
 * 后端 services/audit.ts 自动记录所有成功的写操作，本页只读——
 * 没有、也永远不该有「删除/修改一条历史」的功能。
 */

interface LogRow {
  id: number;
  actor_id: number | null;
  actor_role: string | null;
  actor_name: string;
  module: string;
  action: string;
  detail: string;
  created_at: number;
  /** 本地日期 YYYY-MM-DD（后端统一口径，分组用） */
  day: string;
}

interface DayGroup {
  day: string;
  label: string;
  logs: LogRow[];
}

const toast = useToastStore();

// ── 查看范围：默认近 7 天，快捷按钮 + 自定义起止日期（精确到天） ──────────
type RangeMode = '7d' | '30d' | '6m' | 'custom';

const PAGE_SIZE = 50;

/** 可筛选模块（后端返回，顺序固定）；空字符串 = 全部 */
const modules = ref<string[]>([]);
const activeModule = ref('');

/** 操作人筛选：''=全部，'parent'/'child'=按角色，number=具体家长 id */
type ActorSel = '' | 'parent' | 'child' | number;
const actors = ref<{ id: number; label: string }[]>([]);
const actorSel = ref<ActorSel>('');

function pickActor(sel: ActorSel) {
  if (actorSel.value === sel) return;
  actorSel.value = sel;
  void resetList();
}

/** 模块标签：内部 module 名换成用户看得懂的说法（筛选按钮与时间线标签共用） */
function moduleLabel(m: string): string {
  if (m === '心愿') return '心愿单';
  if (m === '成长') return '身高体重';
  if (m === '日记') return '成长日记';
  return m;
}

/** 模块配色：同一套色组供日志标签和筛选按钮共用 */
const MODULE_TONES: Record<string, string> = {
  积分: 'tone-yellow',
  任务: 'tone-blue',
  审核: 'tone-orange',
  商城: 'tone-pink',
  背包: 'tone-mint',
  心愿: 'tone-violet',
  成长: 'tone-cyan',
  日记: 'tone-indigo',
  日历: 'tone-sky',
  信箱: 'tone-sand',
  悄悄话: 'tone-rose',
  账号: 'tone-slate',
  AI: 'tone-ai',
  其他: 'tone-gray',
};
function moduleTone(m: string): string {
  return MODULE_TONES[m] ?? 'tone-gray';
}

function pickModule(m: string) {
  if (activeModule.value === m) return;
  activeModule.value = m;
  void resetList();
}

const rangeMode = ref<RangeMode>('7d');
const from = ref('');
const to = ref('');

const logs = ref<LogRow[]>([]);
const hasMore = ref(false);
const total = ref(0);
const loading = ref(true);
const loadingMore = ref(false);

function todayStr(): string {
  return toDateStr(new Date());
}

function toDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 近 N 天：含今天在内往回数（近7天 = 今天 + 之前6天） */
function applyQuick(mode: Exclude<RangeMode, 'custom'>) {
  rangeMode.value = mode;
  const end = new Date();
  const start = new Date();
  if (mode === '7d') start.setDate(start.getDate() - 6);
  else if (mode === '30d') start.setDate(start.getDate() - 29);
  else start.setMonth(start.getMonth() - 6); // 近半年：按日历月回退 6 个月
  from.value = toDateStr(start);
  to.value = toDateStr(end);
  void resetList();
}

/** 手动改日期：自动切成「自定义」，开始晚于结束时自动对调 */
function onDateChange() {
  if (from.value && to.value && from.value > to.value) {
    [from.value, to.value] = [to.value, from.value];
  }
  rangeMode.value = 'custom';
  void resetList();
}

const quickItems: { mode: Exclude<RangeMode, 'custom'>; label: string }[] = [
  { mode: '7d', label: '近7天' },
  { mode: '30d', label: '近30天' },
  { mode: '6m', label: '近半年' },
];

// ── 拉取与分页 ─────────────────────────────────────────────────────────

async function fetchPage(offset: number) {
  const qs = new URLSearchParams({ from: from.value, to: to.value, limit: String(PAGE_SIZE), offset: String(offset) });
  if (activeModule.value) qs.set('module', activeModule.value);
  if (actorSel.value === 'parent' || actorSel.value === 'child') qs.set('role', actorSel.value);
  else if (typeof actorSel.value === 'number') qs.set('actorId', String(actorSel.value));
  return api.get<{
    logs: LogRow[];
    hasMore: boolean;
    total: number;
    modules: string[];
    actors: { id: number; label: string }[];
  }>(`/operation-logs?${qs}`);
}

async function resetList() {
  if (!from.value || !to.value) return;
  loading.value = true;
  try {
    const res = await fetchPage(0);
    logs.value = res.logs;
    hasMore.value = res.hasMore;
    total.value = res.total;
    modules.value = res.modules ?? [];
    actors.value = res.actors ?? [];
  } catch (e: any) {
    toast.error(e?.message || '操作历史加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  try {
    const res = await fetchPage(logs.value.length);
    logs.value = [...logs.value, ...res.logs];
    hasMore.value = res.hasMore;
    total.value = res.total;
  } catch (e: any) {
    toast.error(e?.message || '加载更多失败');
  } finally {
    loadingMore.value = false;
  }
}

// ── 按天分组 + 时间显示（精确到秒：哪时哪分哪秒） ─────────────────────────

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  const base = `${m}月${d}日 ${week}`;
  if (day === todayStr()) return `今天 · ${base}`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === toDateStr(yesterday)) return `昨天 · ${base}`;
  return y === new Date().getFullYear() ? base : `${y}年${base}`;
}

const dayGroups = computed<DayGroup[]>(() => {
  const groups: DayGroup[] = [];
  // 后端按 created_at DESC 返回，顺序天然是新→旧，这里只做按天归组
  for (const log of logs.value) {
    const last = groups[groups.length - 1];
    if (last && last.day === log.day) {
      last.logs.push(log);
    } else {
      groups.push({ day: log.day, label: dayLabel(log.day), logs: [log] });
    }
  }
  return groups;
});

/** 空态文案：按模块筛选时点明是哪个模块没有记录 */
const emptyText = computed(() =>
  activeModule.value
    ? `这个时间段还没有「${moduleLabel(activeModule.value)}」记录`
    : '这个时间段还没有操作记录'
);

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function roleLabel(role: string | null): string {
  return role === 'parent' ? '家长' : role === 'child' ? '孩子' : '系统';
}

onMounted(() => {
  applyQuick('7d');
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1 class="title">操作历史</h1>
      <p class="subtitle">全家所有人的操作自动记录成时间线，只增不改不删</p>
    </header>

    <!-- 查看范围 -->
    <GlassCard padding="14px 16px" class="range-card">
      <div class="quick-row">
        <button
          v-for="item in quickItems"
          :key="item.mode"
          class="quick-btn"
          :class="{ active: rangeMode === item.mode }"
          @click="applyQuick(item.mode)"
        >{{ item.label }}</button>
        <button class="quick-btn" :class="{ active: rangeMode === 'custom' }" disabled>自定义</button>
      </div>
      <div class="date-row">
        <input v-model="from" type="date" class="date-input" aria-label="开始日期" @change="onDateChange" />
        <span class="dash">→</span>
        <input v-model="to" type="date" class="date-input" aria-label="结束日期" @change="onDateChange" />
        <span class="count-hint">共 {{ total }} 条</span>
      </div>
      <div class="filter-row">
        <span class="filter-label">模块</span>
        <button class="filter-chip" :class="{ active: activeModule === '' }" @click="pickModule('')">全部</button>
        <button
          v-for="m in modules"
          :key="m"
          class="filter-chip"
          :class="[moduleTone(m), { active: activeModule === m }]"
          @click="pickModule(m)"
        >{{ moduleLabel(m) }}</button>
      </div>
      <div class="filter-row">
        <span class="filter-label">操作人</span>
        <button class="filter-chip" :class="{ active: actorSel === '' }" @click="pickActor('')">全部</button>
        <button class="filter-chip" :class="{ active: actorSel === 'parent' }" @click="pickActor('parent')">家长</button>
        <button class="filter-chip" :class="{ active: actorSel === 'child' }" @click="pickActor('child')">孩子</button>
        <button
          v-for="a in actors"
          :key="a.id"
          class="filter-chip"
          :class="{ active: actorSel === a.id }"
          @click="pickActor(a.id)"
        >{{ a.label }}</button>
      </div>
    </GlassCard>

    <EmptyState v-if="!loading && logs.length === 0" emoji="🕰️" :text="emptyText" />

    <div v-else class="timeline">
      <section v-for="g in dayGroups" :key="g.day" class="day-group">
        <header class="day-head">
          <span class="day-title">{{ g.label }}</span>
          <span class="day-count">{{ g.logs.length }} 条</span>
        </header>

        <div class="day-body">
          <GlassCard v-for="log in g.logs" :key="log.id" padding="12px 14px" class="log-item">
            <div class="time-col">
              <span class="time">{{ fmtTime(log.created_at) }}</span>
            </div>
            <div class="dot-col"><span class="dot"></span></div>
            <div class="content">
              <div class="row1">
                <strong class="actor">{{ log.actor_name || '未知' }}</strong>
                <span class="role-badge" :class="log.actor_role === 'parent' ? 'is-parent' : 'is-child'">
                  {{ roleLabel(log.actor_role) }}
                </span>
                <span class="text">
                  {{ log.action }}<template v-if="log.detail"> · {{ log.detail }}</template>
                </span>
              </div>
              <div class="row2">
                <span class="module-tag" :class="moduleTone(log.module)">{{ moduleLabel(log.module) }}</span>
              </div>
            </div>
          </GlassCard>
        </div>
      </section>

      <button v-if="hasMore" class="btn btn-ghost load-more" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? '加载中…' : '加载更多' }}
      </button>
      <p v-else-if="logs.length > 0" class="end-hint">— 已经到底啦，范围内共 {{ total }} 条 —</p>
    </div>

    <p class="immutable-hint">🔒 操作记录由系统自动记录，所有家长可见，任何人都不能修改或删除</p>
  </div>
</template>

<style scoped>
.page-header { margin-bottom: var(--space-16); }
.title { font-size: var(--fs-3xl); margin-bottom: var(--space-2); }
.subtitle { color: var(--text-secondary); font-size: var(--fs-sm); }

/* 查看范围 */
.range-card { margin-bottom: var(--space-16); }
.quick-row {
  display: flex;
  gap: var(--space-6);
  margin-bottom: var(--space-10);
  flex-wrap: wrap;
}
.quick-btn {
  padding: var(--space-6) var(--space-14);
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  color: var(--text-secondary);
  white-space: nowrap;
  font-size: var(--fs-sm);
  transition: all var(--dur-base);
}
.quick-btn.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
  font-weight: 600;
}
.quick-btn:disabled { cursor: default; opacity: 0.75; }

/* 筛选行（模块 / 操作人）：紧凑 chips，多行自动换行（手机端也不会溢出） */
.filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-6);
  margin-top: var(--space-10);
  padding-top: var(--space-10);
  border-top: 1px dashed var(--glass-border);
}
.filter-label {
  flex-shrink: 0;
  min-width: 42px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.filter-chip {
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  color: var(--text-secondary);
  white-space: nowrap;
  font-size: var(--fs-xs);
  transition: all var(--dur-base);
}
/* 带模块色的 chip：淡色底 + 同色深字；选中时加深 */
.filter-chip[class*="tone-"] {
  background: rgba(var(--tone-rgb), 0.14);
  color: var(--tone-fg);
}
.filter-chip.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
  font-weight: 600;
}
.filter-chip[class*="tone-"].active {
  background: rgba(var(--tone-rgb), 0.4);
  color: var(--tone-fg);
}

/* 模块色组：日志标签与筛选 chips 共用（--tone-rgb 底色分量，--tone-fg 文字色） */
.tone-yellow { --tone-rgb: 255, 209, 102; --tone-fg: #7a5a00; }
.tone-blue { --tone-rgb: 130, 192, 255; --tone-fg: #245a8a; }
.tone-orange { --tone-rgb: 255, 170, 100; --tone-fg: #8a4a10; }
.tone-pink { --tone-rgb: 255, 150, 190; --tone-fg: #8a2d55; }
.tone-mint { --tone-rgb: 110, 200, 160; --tone-fg: #25664c; }
.tone-violet { --tone-rgb: 180, 150, 255; --tone-fg: #553a8a; }
.tone-cyan { --tone-rgb: 100, 210, 220; --tone-fg: #16606a; }
.tone-indigo { --tone-rgb: 140, 165, 255; --tone-fg: #33478a; }
.tone-sky { --tone-rgb: 120, 200, 245; --tone-fg: #1d5f86; }
.tone-sand { --tone-rgb: 210, 180, 140; --tone-fg: #6b5432; }
.tone-rose { --tone-rgb: 255, 150, 160; --tone-fg: #8a2d3a; }
.tone-green { --tone-rgb: 126, 217, 163; --tone-fg: #1f5c3c; }
.tone-slate { --tone-rgb: 160, 175, 195; --tone-fg: #3f5570; }
.tone-gray { --tone-rgb: 160, 160, 160; --tone-fg: #5a5a5a; }
.tone-red { --tone-rgb: 255, 122, 122; --tone-fg: #8a2d2d; }
.tone-ai { --tone-rgb: 205, 170, 255; --tone-fg: #5b2f8a; }

.date-row {
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
.count-hint {
  flex-shrink: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  white-space: nowrap;
}

/* 时间线 */
.timeline { display: flex; flex-direction: column; gap: var(--space-16); }
.day-group { display: flex; flex-direction: column; gap: var(--space-8); }
.day-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 var(--space-4);
}
.day-title {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  color: var(--text-primary);
}
.day-count { font-size: var(--fs-xs); color: var(--text-muted); }

.day-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
.day-body::before {
  content: '';
  position: absolute;
  /* 穿起当天每条记录的竖线：落在圆点列的水平中心（38px 时间列 + 间距 + 10px 点列中心） */
  left: calc(38px + var(--space-10) + 5px);
  top: 20px;
  bottom: 20px;
  width: 2px;
  background: var(--glass-border);
}

.log-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-10);
}
.time-col {
  width: 38px;
  flex-shrink: 0;
  padding-top: var(--space-2);
}
.time {
  font-size: var(--fs-xs);
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
  white-space: nowrap;
}
.dot-col {
  width: 10px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding-top: 10px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: var(--r-full);
  background: var(--accent-yellow);
  box-shadow: 0 0 0 3px rgba(255, 209, 102, 0.25);
  position: relative;
  z-index: 1;
}
.content { flex: 1; min-width: 0; }
.row1 {
  display: flex;
  align-items: baseline;
  gap: var(--space-6);
  flex-wrap: wrap;
  font-size: var(--fs-sm);
}
.actor { font-family: var(--font-cute); white-space: nowrap; }
.role-badge {
  flex-shrink: 0;
  font-size: var(--fs-xs);
  padding: 0 var(--space-6);
  border-radius: var(--r-xs);
  line-height: 1.6;
}
.role-badge.is-parent { background: rgba(255, 209, 102, 0.2); color: var(--text-primary); }
.role-badge.is-child { background: rgba(126, 217, 163, 0.22); color: var(--text-primary); }
.text { color: var(--text-secondary); overflow-wrap: anywhere; }
.row2 { margin-top: var(--space-4); }
.module-tag {
  display: inline-block;
  padding: var(--space-2) var(--space-8);
  border-radius: var(--r-xs);
  background: rgba(var(--tone-rgb, 160, 160, 160), 0.2);
  font-size: var(--fs-xs);
  color: var(--tone-fg, var(--text-muted));
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

.immutable-hint {
  margin-top: var(--space-20);
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
</style>
