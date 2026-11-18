<script setup lang="ts">
/**
 * 月视图网格（2026-11-14）：周一开头 6 行 7 列；
 * 每格：日期数字 + 特殊日 emoji 角标 + 日程色点（最多 3 个 + 溢出数）。
 */
import { computed } from 'vue';
import type { CalendarEvent, SpecialDayOccurrence } from './types';
import { eventColor, todayStr } from './types';

const props = defineProps<{
  year: number;
  /** 1-12 */
  month: number;
  selected: string;
  events: CalendarEvent[];
  specialDays: SpecialDayOccurrence[];
}>();
const emit = defineEmits<{ select: [date: string] }>();

interface Cell { dateStr: string; dayNum: number; inMonth: boolean; isToday: boolean; }

const cells = computed<Cell[]>(() => {
  const first = new Date(props.year, props.month - 1, 1);
  const offset = (first.getDay() + 6) % 7; // 周一开头
  const start = new Date(props.year, props.month - 1, 1 - offset);
  const today = todayStr();
  const out: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ dateStr, dayNum: d.getDate(), inMonth: d.getMonth() + 1 === props.month, isToday: dateStr === today });
  }
  return out;
});

const eventsByDate = computed(() => {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of props.events) {
    // 跨天日程：覆盖到的每一天都要有圆点
    const start = e.event_date;
    const end = e.end_date || e.event_date;
    const cursor = new Date(`${start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);
    if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) continue;
    while (cursor <= last) {
      const ds = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      const arr = map.get(ds) ?? [];
      arr.push(e);
      map.set(ds, arr);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return map;
});

const specialByDate = computed(() => {
  const map = new Map<string, SpecialDayOccurrence[]>();
  for (const s of props.specialDays) {
    const arr = map.get(s.date) ?? [];
    arr.push(s);
    map.set(s.date, arr);
  }
  return map;
});

function dotsOf(ds: string) {
  return (eventsByDate.value.get(ds) ?? []).slice(0, 3);
}
function extraOf(ds: string): number {
  const n = (eventsByDate.value.get(ds) ?? []).length;
  return n > 3 ? n - 3 : 0;
}
</script>

<template>
  <div class="cal-grid">
    <div class="cal-weekdays">
      <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w">{{ w }}</span>
    </div>
    <div class="cal-cells">
      <button
        v-for="c in cells"
        :key="c.dateStr"
        class="cal-cell"
        :class="{ dim: !c.inMonth, today: c.isToday, sel: c.dateStr === selected }"
        @click="emit('select', c.dateStr)"
      >
        <span class="day-row">
          <span class="daynum">{{ c.dayNum }}</span>
          <span v-if="(specialByDate.get(c.dateStr) ?? []).length > 0" class="special-emoji">
            {{ specialByDate.get(c.dateStr)![0].emoji }}
          </span>
        </span>
        <span class="dots">
          <i v-for="e in dotsOf(c.dateStr)" :key="e.id" :style="{ background: eventColor(e.id) }" />
          <em v-if="extraOf(c.dateStr) > 0" class="extra">+{{ extraOf(c.dateStr) }}</em>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.cal-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  font-size: var(--fs-2xs);
  color: var(--text-muted);
  text-align: center;
  padding-bottom: var(--space-6);
}
.cal-cells {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.cal-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-height: 52px;
  padding: var(--space-4) 0 var(--space-6);
  border-radius: var(--r-sm);
  border: 1.5px solid transparent;
  background: transparent;
  transition: background var(--dur-fast), border-color var(--dur-fast);
}
.cal-cell:hover { background: var(--glass-bg); }
.cal-cell.dim { opacity: 0.38; }
.cal-cell.today { border-color: var(--accent-mint); }
.cal-cell.today .daynum { color: var(--accent-mint); font-weight: 700; }
.cal-cell.sel { background: rgba(255, 209, 102, 0.16); border-color: rgba(255, 209, 102, 0.5); }
.day-row { display: inline-flex; align-items: center; gap: 2px; }
.daynum { font-size: var(--fs-sm); line-height: 1; color: var(--text-primary); }
/* 特殊日 emoji 紧跟日期数字、并与之在同一条水平线上（居中对齐，不再上浮）；
   不用绝对定位：桌面端格子很宽，图标会离数字太远，看不出是一组的 */
.special-emoji { font-size: 10px; line-height: 1; }
.dots { display: flex; gap: 3px; align-items: center; min-height: 6px; }
.dots i { width: 6px; height: 6px; border-radius: var(--r-full); flex-shrink: 0; }
.dots .extra { font-size: 9px; color: var(--text-muted); font-style: normal; line-height: 1; }
</style>
