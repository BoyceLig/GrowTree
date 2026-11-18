<script setup lang="ts">
/**
 * 日视图议程（2026-11-14）：
 * 顶部特殊日横幅（签名元素）→ 全天日程置顶 → 按时间排序的日程卡。
 * 参与人用生肖头像叠放展示；私有/家长公开有可见性徽章。
 */
import { computed } from 'vue';
import type { CalendarEvent, SpecialDayOccurrence } from './types';
import { effectText, eventColor, fmtMult, memberLabel, timeRangeText } from './types';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';

const props = defineProps<{
  date: string;
  events: CalendarEvent[];
  specialDays: SpecialDayOccurrence[];
  isParent: boolean;
  meId: number;
}>();
const emit = defineEmits<{ create: []; edit: [e: CalendarEvent] }>();

const sorted = computed(() =>
  [...props.events].sort((a, b) => {
    if (a.is_all_day !== b.is_all_day) return a.is_all_day ? -1 : 1;
    return (a.start_time ?? '').localeCompare(b.start_time ?? '');
  }),
);

function canEdit(e: CalendarEvent): boolean {
  if (e.redacted) return false;
  return props.isParent || e.created_by === props.meId;
}

function visBadge(e: CalendarEvent): string {
  return e.visibility === 'private' ? '🔒 私有' : '';
}

function isCrossDay(e: CalendarEvent): boolean {
  return !!e.end_date && e.end_date !== e.event_date;
}
</script>

<template>
  <div class="agenda">
    <!-- 特殊日横幅（签名元素） -->
    <div v-for="s in specialDays" :key="`${s.id}-${s.date}`" class="special-banner">
      <span class="sb-emoji">{{ s.emoji }}</span>
      <div class="sb-main">
        <div class="sb-name">今天是 {{ s.name }}</div>
        <div class="sb-effect" :class="s.effect_kind ?? 'none'">
          {{ s.effect_kind ? effectText(s) : '一个特别的日子' }}
        </div>
      </div>
    </div>

    <div v-if="sorted.length === 0 && specialDays.length === 0" class="agenda-empty">
      这天还没有日程，点右上角 ＋ 安排一件事吧
    </div>
    <div v-else-if="sorted.length === 0" class="agenda-empty">这天没有日程安排</div>

    <div
      v-for="e in sorted"
      :key="e.id"
      class="event-card"
      :class="{ redacted: e.redacted }"
      :style="{ '--bar': eventColor(e.id) }"
      @click="canEdit(e) && emit('edit', e)"
    >
      <div class="ec-body">
        <div class="ec-title-row">
          <span class="ec-title">{{ e.redacted ? '私有日程' : e.title }}</span>
          <span v-if="visBadge(e)" class="ec-vis">{{ visBadge(e) }}</span>
          <span v-if="isCrossDay(e)" class="ec-cross">跨天</span>
        </div>
        <div class="ec-time">{{ timeRangeText(e) }}</div>
        <div v-if="!e.redacted && e.note" class="ec-note">{{ e.note }}</div>
        <div v-if="!e.redacted" class="ec-people">
          <div class="ec-avatars">
            <span v-for="p in e.participants.slice(0, 4)" :key="p.id" class="ec-avatar">
              <ZodiacAvatar :zodiac="p.avatar ?? ''" :size="22" />
            </span>
            <span v-if="e.participants.length > 4" class="ec-more">+{{ e.participants.length - 4 }}</span>
          </div>
          <span class="ec-names">{{ e.participants.map(memberLabel).join('、') }}</span>
          <button v-if="canEdit(e)" class="ec-edit" @click.stop="emit('edit', e)">编辑</button>
        </div>
        <div v-else class="ec-redacted-hint">🔒 这条日程对你隐藏了详情</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agenda { display: flex; flex-direction: column; gap: var(--space-10); }

.special-banner {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  padding: var(--space-10) var(--space-14);
  border-radius: var(--r-md);
  background: linear-gradient(135deg, rgba(255, 209, 102, 0.22), rgba(240, 160, 90, 0.14));
  border: 1px solid rgba(255, 209, 102, 0.5);
}
.sb-emoji { font-size: 24px; line-height: 1; }
.sb-name { font-family: var(--font-cute); font-size: var(--fs-md); }
.sb-effect { font-size: var(--fs-xs); margin-top: 2px; }
.sb-effect.earn { color: #1d6a4d; font-weight: 600; }
.sb-effect.spend { color: var(--text-on-yellow); font-weight: 600; }
.sb-effect.none { color: var(--text-muted); }

.agenda-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-sm);
  padding: var(--space-16) 0;
}

.event-card {
  display: flex;
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-left: 4px solid var(--bar);
  overflow: hidden;
  cursor: default;
}
.ec-body { flex: 1; min-width: 0; padding: var(--space-10) var(--space-12); }
.ec-title-row { display: flex; align-items: center; gap: var(--space-8); min-width: 0; }
.ec-cross {
  flex-shrink: 0;
  font-size: var(--fs-2xs);
  padding: 1px var(--space-6);
  border-radius: var(--r-full);
  background: rgba(240, 160, 90, 0.16);
  color: var(--text-on-yellow);
}
.ec-redacted-hint {
  margin-top: var(--space-6);
  font-size: var(--fs-2xs);
  color: var(--text-muted);
}
/* 私有占位卡：只有「几点到几点」，视觉上明显弱于完整卡片 */
.event-card.redacted {
  border-left-color: var(--glass-border);
  background: rgba(255, 255, 255, 0.35);
  border-style: dashed;
  cursor: default;
}
.ec-title {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ec-vis {
  flex-shrink: 0;
  font-size: var(--fs-2xs);
  padding: 1px var(--space-6);
  border-radius: var(--r-full);
  background: rgba(130, 192, 255, 0.16);
  color: var(--text-on-sky);
}
.ec-time { font-size: var(--fs-xs); color: var(--text-muted); margin-top: 2px; }
.ec-note {
  font-size: var(--fs-2xs); color: var(--text-secondary); margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ec-people { display: flex; align-items: center; gap: var(--space-8); margin-top: var(--space-6); }
.ec-avatars { display: flex; }
.ec-avatar { margin-right: -6px; display: inline-flex; border-radius: var(--r-full); }
.ec-more { font-size: var(--fs-2xs); color: var(--text-muted); align-self: center; margin-left: 4px; }
.ec-names {
  flex: 1; min-width: 0;
  font-size: var(--fs-2xs); color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ec-edit {
  flex-shrink: 0;
  padding: var(--space-2) var(--space-10);
  border-radius: var(--r-sm);
  font-size: var(--fs-2xs);
  background: rgba(130, 192, 255, 0.14);
  color: var(--text-on-sky);
}
</style>
