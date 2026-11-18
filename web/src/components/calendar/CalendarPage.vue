<script setup lang="ts">
/**
 * 日历主页面（两端共用，2026-11-14）：
 * 月份导航 + 月视图网格 + 日视图议程 + 浮动「＋」建日程；
 * 家长端多一个「特殊日」管理入口（列表 + 新建/编辑/启停/删除）。
 * 可见性、私有日程规则由后端过滤，前端只渲染拿到的数据。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import EmptyState from '@/components/EmptyState.vue';
import MonthGrid from './MonthGrid.vue';
import DayAgenda from './DayAgenda.vue';
import EventForm from './EventForm.vue';
import SpecialDayEditor from './SpecialDayEditor.vue';
import type { CalendarEvent, FamilyInfo, SpecialDayFull, SpecialDayOccurrence } from './types';
import { coversDate, effectText, ruleSummary, todayStr } from './types';

const props = defineProps<{ isParent: boolean }>();

const auth = useAuthStore();
const toast = useToastStore();

const now = new Date();
const curY = ref(now.getFullYear());
const curM = ref(now.getMonth() + 1); // 1-12
const selected = ref(todayStr());
const loading = ref(false);
const events = ref<CalendarEvent[]>([]);
const specialDays = ref<SpecialDayOccurrence[]>([]);
const family = ref<FamilyInfo>({ parents: [], children: [] });

/** 月视图网格实际覆盖的范围（含前后月补位），按这个区间取数 */
const gridRange = computed(() => {
  const first = new Date(curY.value, curM.value - 1, 1);
  const offset = (first.getDay() + 6) % 7;
  const gridStart = new Date(curY.value, curM.value - 1, 1 - offset);
  const last = new Date(curY.value, curM.value, 0);
  const endOffset = (last.getDay() + 6) % 7;
  const gridEnd = new Date(last.getFullYear(), last.getMonth(), last.getDate() + (6 - endOffset));
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(gridStart), to: fmt(gridEnd) };
});

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const { from, to } = gridRange.value;
    const d = await api.get<{ events: CalendarEvent[]; specialDays: SpecialDayOccurrence[]; family: FamilyInfo }>(
      `/calendar?from=${from}&to=${to}`,
    );
    events.value = d.events;
    specialDays.value = d.specialDays;
    family.value = d.family;
  } catch (e: any) {
    if (!silent) toast.error(e?.message ?? '日历加载失败');
  } finally {
    if (!silent) loading.value = false;
  }
}

function prevMonth() {
  if (curM.value === 1) { curY.value -= 1; curM.value = 12; } else curM.value -= 1;
}
function nextMonth() {
  if (curM.value === 12) { curY.value += 1; curM.value = 1; } else curM.value += 1;
}
function goToday() {
  const t = todayStr();
  const [y, m] = t.split('-').map(Number);
  curY.value = y; curM.value = m; selected.value = t;
  load(true);
}

const agendaEvents = computed(() => events.value.filter((e) => coversDate(e, selected.value)));
const agendaSpecials = computed(() => specialDays.value.filter((s) => s.date === selected.value));

// ── 日程表单 ──
const formOpen = ref(false);
const editingEvent = ref<CalendarEvent | null>(null);
const prefillDate = ref(todayStr());
function openCreate() {
  editingEvent.value = null;
  prefillDate.value = selected.value;
  formOpen.value = true;
}
function openEdit(e: CalendarEvent) {
  editingEvent.value = e;
  formOpen.value = true;
}

// ── 特殊日管理（家长端） ──
const manageOpen = ref(false);
const manageList = ref<SpecialDayFull[]>([]);
const manageLoading = ref(false);
const editorOpen = ref(false);
const editingSpecial = ref<SpecialDayFull | null>(null);
const confirmDelId = ref<number | null>(null);

async function loadManage() {
  manageLoading.value = true;
  try {
    const d = await api.get<{ specialDays: SpecialDayFull[] }>('/special-days');
    manageList.value = d.specialDays;
  } catch (e: any) {
    toast.error(e?.message ?? '特殊日加载失败');
  } finally {
    manageLoading.value = false;
  }
}
function openManage() {
  manageOpen.value = true;
  loadManage();
}
function openSpecialEditor(s: SpecialDayFull | null) {
  editingSpecial.value = s;
  editorOpen.value = true;
}
async function toggleEnabled(s: SpecialDayFull) {
  try {
    await api.patch(`/special-days/${s.id}`, { ...s, enabled: !s.enabled });
    s.enabled = !s.enabled;
    load(true);
  } catch (e: any) {
    toast.error(e?.message ?? '操作失败');
  }
}
async function removeSpecial(s: SpecialDayFull) {
  if (confirmDelId.value !== s.id) {
    confirmDelId.value = s.id;
    return;
  }
  try {
    await api.delete(`/special-days/${s.id}`);
    toast.success('特殊日已删除');
    confirmDelId.value = null;
    loadManage();
    load(true);
  } catch (e: any) {
    toast.error(e?.message ?? '删除失败');
  }
}
function onSpecialSaved() {
  loadManage();
  load(true);
}

// ── WS：日程/特殊日变化静默刷新 ──
function onWsCalendar() { load(true); }
function onWsSpecial() { load(true); if (manageOpen.value) loadManage(); }
onMounted(() => {
  load();
  window.addEventListener('ws:calendar_changed', onWsCalendar);
  window.addEventListener('ws:special_days_changed', onWsSpecial);
});
onBeforeUnmount(() => {
  window.removeEventListener('ws:calendar_changed', onWsCalendar);
  window.removeEventListener('ws:special_days_changed', onWsSpecial);
});
</script>

<template>
  <div class="cal-page">
    <div class="cal-header">
      <button class="cal-nav" @click="prevMonth">‹</button>
      <div class="cal-title">{{ curY }}年{{ curM }}月</div>
      <button class="cal-nav" @click="nextMonth">›</button>
      <button class="cal-today-btn" @click="goToday">今天</button>
      <button v-if="isParent" class="cal-special-btn" @click="openManage">🎉 特殊日</button>
    </div>

    <div class="cal-card">
      <MonthGrid
        :year="curY"
        :month="curM"
        :selected="selected"
        :events="events"
        :special-days="specialDays"
        @select="selected = $event"
      />
    </div>

    <div class="cal-card agenda-card">
      <div class="agenda-head">
        <div class="agenda-date">{{ Number(selected.slice(5, 7)) }}月{{ Number(selected.slice(8)) }}日</div>
        <!-- 新建入口固定在议程卡右上角：有日程也在原位，不再悬浮遮挡内容 -->
        <button class="agenda-add" title="新建日程" aria-label="新建日程" @click="openCreate">＋</button>
      </div>
      <DayAgenda
        :date="selected"
        :events="agendaEvents"
        :special-days="agendaSpecials"
        :is-parent="isParent"
        :me-id="auth.user?.id ?? 0"
        @create="openCreate"
        @edit="openEdit"
      />
    </div>

    <!-- 新建/编辑日程 -->
    <EventForm
      v-if="formOpen"
      v-model="formOpen"
      :date="prefillDate"
      :event="editingEvent"
      :family="family"
      :is-parent="isParent"
      :me-id="auth.user?.id ?? 0"
      @saved="load(true)"
    />

    <!-- 特殊日管理（家长端） -->
    <Modal
      v-if="manageOpen"
      :model-value="manageOpen && !editorOpen"
      width="520px"
      title="🎉 特殊日管理"
      @update:model-value="manageOpen = $event"
    >
      <div v-if="manageLoading" class="sp-loading">加载中...</div>
      <EmptyState
        v-else-if="manageList.length === 0"
        emoji="🎉"
        text="还没有特殊日"
        hint="给某天起个名字，比如「学习日」，当天的积分就能翻倍"
      />
      <div v-else class="sp-list">
        <div v-for="s in manageList" :key="s.id" class="sp-item" :class="{ off: !s.enabled }">
          <span class="sp-emoji">{{ s.emoji }}</span>
          <div class="sp-main">
            <div class="sp-name">
              {{ s.name }}
              <span class="sp-effect" :class="s.effect_kind ?? 'none'">{{ effectText(s) }}</span>
              <span v-if="!s.enabled" class="sp-off-tag">已停用</span>
            </div>
            <div class="sp-rule">{{ ruleSummary(s) }} · {{ s.scope === 'all' ? '全家' : `指定孩子：${(s.target_names ?? []).join('、') || '未知'}` }}</div>
          </div>
          <div class="sp-actions">
            <button class="sp-btn" :title="s.enabled ? '点击停用' : '点击启用'" @click="toggleEnabled(s)">
              {{ s.enabled ? '停用' : '启用' }}
            </button>
            <button class="sp-btn" @click="openSpecialEditor(s)">编辑</button>
            <button class="sp-btn sp-del" @click="removeSpecial(s)">
              {{ confirmDelId === s.id ? '确认删除' : '删除' }}
            </button>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-primary" @click="openSpecialEditor(null)">＋ 新建特殊日</button>
      </template>
    </Modal>

    <!-- 特殊日编辑器 -->
    <SpecialDayEditor
      v-if="editorOpen"
      v-model="editorOpen"
      :special-day="editingSpecial"
      :family="family"
      @saved="onSpecialSaved"
    />
  </div>
</template>

<style scoped>
.cal-page { position: relative; display: flex; flex-direction: column; gap: var(--space-12); padding-bottom: var(--space-16); }

.cal-header { display: flex; align-items: center; gap: var(--space-8); }
.cal-title { font-family: var(--font-cute); font-size: var(--fs-lg); min-width: 110px; text-align: center; }
.cal-nav {
  width: 34px; height: 34px;
  border-radius: var(--r-full);
  font-size: 20px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  color: var(--text-primary);
  display: inline-flex; align-items: center; justify-content: center;
}
.cal-today-btn, .cal-special-btn {
  margin-left: auto;
  padding: var(--space-6) var(--space-12);
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  white-space: nowrap;
}
.cal-special-btn { margin-left: 0; background: rgba(255, 209, 102, 0.16); border-color: rgba(255, 209, 102, 0.45); }
.cal-today-btn + .cal-special-btn { margin-left: 0; }

.cal-card {
  border-radius: var(--r-lg);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  padding: var(--space-12);
}

/* 议程卡头部：日期在左、新建在右上角（固定在卡内，有日程也不挪位） */
.agenda-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-8); }
.agenda-date { font-family: var(--font-cute); font-size: var(--fs-md); margin-bottom: 0; }

/* 新建日程按钮：flex 居中让「＋」落在圆形背景的视觉中心（之前用行高居中会偏下） */
.agenda-add {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: var(--r-full);
  font-size: 20px;
  font-family: inherit;
  line-height: 1;
  background: linear-gradient(135deg, #ffd166, #f0a05a);
  color: #4a2c00;
  box-shadow: 0 4px 12px rgba(240, 160, 90, 0.35);
}
.agenda-add:active { transform: scale(0.94); }

.sp-loading { text-align: center; color: var(--text-muted); padding: var(--space-16); }
.sp-list { display: flex; flex-direction: column; gap: var(--space-8); max-height: 380px; overflow-y: auto; scrollbar-width: thin; }
.sp-item {
  display: flex; align-items: center; gap: var(--space-10);
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
}
.sp-item.off { opacity: 0.55; }
.sp-emoji { font-size: 22px; flex-shrink: 0; }
.sp-main { flex: 1; min-width: 0; }
.sp-name { font-family: var(--font-cute); font-size: var(--fs-md); display: flex; align-items: center; gap: var(--space-6); flex-wrap: wrap; }
.sp-effect {
  font-size: var(--fs-2xs);
  padding: 1px var(--space-6);
  border-radius: var(--r-full);
  font-family: inherit;
}
.sp-effect.earn { background: rgba(110, 200, 160, 0.18); color: #1d6a4d; }
.sp-effect.spend { background: rgba(255, 209, 102, 0.22); color: var(--text-on-yellow); }
.sp-effect.none { background: var(--glass-bg); color: var(--text-muted); }
.sp-off-tag { font-size: var(--fs-2xs); color: var(--text-muted); }
.sp-rule { font-size: var(--fs-2xs); color: var(--text-muted); margin-top: 2px; }
.sp-actions { display: flex; gap: var(--space-4); flex-shrink: 0; }
.sp-btn {
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-sm);
  font-size: var(--fs-2xs);
  background: rgba(130, 192, 255, 0.12);
  color: var(--text-on-sky);
  white-space: nowrap;
}
.sp-btn.sp-del { background: rgba(255, 122, 122, 0.12); color: var(--text-on-red); }
</style>
