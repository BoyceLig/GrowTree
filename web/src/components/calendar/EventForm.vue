<script setup lang="ts">
/**
 * 日程新建/编辑表单（2026-11-14，2026-11-16 改版）：
 * 标题 → 日期范围/时间/时长 → 参与人 → 可见性 → 备注。
 * 可见性只有两档（docs/日历与特殊日功能方案.md §4.1）：
 *   - 公开：所有人可见
 *   - 私有：家长都可见；孩子只有创建者/参与人看完整，其他兄弟姐妹只看到「私有日程」占位（保留时间）
 * 支持跨天：开始日期 → 结束日期；时长与结束时间双向计算。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import type { CalendarEvent, FamilyInfo, FamilyMember } from './types';
import { fmtDuration, memberLabel, todayStr } from './types';

const props = defineProps<{
  modelValue: boolean;
  /** 新建时预填的日期 */
  date: string;
  /** 编辑时传入原日程 */
  event: CalendarEvent | null;
  family: FamilyInfo;
  isParent: boolean;
  meId: number;
}>();
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; saved: [] }>();

const toast = useToastStore();

const title = ref('');
const eventDate = ref('');
const endDate = ref('');
const allDay = ref(true);
const startTime = ref('09:00');
const endTime = ref('10:00');
/** 总时长（分钟）；跨天时 > 1440 */
const durationMin = ref(1440);
const durD = ref(1);
const durH = ref(0);
const durM = ref(0);
const note = ref('');
const visibility = ref<'public' | 'private'>('public');
const picked = ref<number[]>([]);
const saving = ref(false);
const confirmDelete = ref(false);
let durLock = false;

const isEdit = computed(() => !!props.event);

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function daysBetween(a: string, b: string): number {
  const A = new Date(`${a}T00:00:00`).getTime();
  const B = new Date(`${b}T00:00:00`).getTime();
  return Math.round((B - A) / 86400000);
}
function diffMinutes(fromDate: string, fromTime: string, toDate: string, toTime: string): number {
  const a = new Date(`${fromDate}T${fromTime}:00`).getTime();
  const b = new Date(`${toDate}T${toTime}:00`).getTime();
  return Math.round((b - a) / 60000);
}

/** 把总分钟数拆到「天/时/分」三个输入框（不触发反向计算） */
function syncDurFields(min: number) {
  durLock = true;
  const total = Math.max(0, min);
  durD.value = Math.floor(total / 1440);
  durH.value = Math.floor((total % 1440) / 60);
  durM.value = total % 60;
  nextTick(() => { durLock = false; });
}

/** 结束 → 时长：改结束日期/时间时由它重算 */
function recalcDurationFromEnd() {
  let min: number;
  if (allDay.value) {
    // 全天按「含首尾的自然日」算，11-16 → 11-17 = 2 天
    min = Math.max(1, daysBetween(eventDate.value, endDate.value) + 1) * 1440;
  } else {
    min = diffMinutes(eventDate.value, startTime.value, endDate.value, endTime.value);
  }
  durationMin.value = Math.max(0, min);
  syncDurFields(durationMin.value);
}

/** 时长 → 结束：改时长/开始日期/开始时间时由它重算 */
function applyDurationToEnd() {
  if (!eventDate.value) return;
  if (allDay.value) {
    const days = Math.max(1, Math.ceil(durationMin.value / 1440));
    const d = new Date(`${eventDate.value}T00:00:00`);
    d.setDate(d.getDate() + days - 1);
    endDate.value = localDate(d);
    return;
  }
  const start = new Date(`${eventDate.value}T${startTime.value || '09:00'}:00`);
  const end = new Date(start.getTime() + Math.max(0, durationMin.value) * 60000);
  endDate.value = localDate(end);
  endTime.value = `${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
}

/** 新建日程的默认时段：选中日 09:00–10:00；若选中的就是今天且已过 9 点，
 *  则从「当前时间的下一个整点」开始、持续 1 小时（跨到次日 0 点也支持）。 */
function defaultTimeRange(ds: string): { start: string; end: string; endDate: string } {
  const now = new Date();
  const today = localDate(now);
  let startMin = 9 * 60;
  if (ds === today) {
    const cur = now.getHours() * 60 + now.getMinutes();
    if (cur >= 9 * 60) {
      // 下一个整点：9:00 → 10:00；9:59 → 10:00；10:00 → 11:00
      startMin = Math.floor(cur / 60) * 60 + 60;
    }
  }
  if (startMin >= 24 * 60) {
    // 23 点之后：从 23:00 开始，默认跨到次日 00:00
    startMin = 23 * 60;
  }
  const start = `${pad2(Math.floor(startMin / 60))}:${pad2(startMin % 60)}`;
  const end = new Date(`${ds}T${start}:00`);
  end.setMinutes(end.getMinutes() + 60);
  return { start, end: `${pad2(end.getHours())}:${pad2(end.getMinutes())}`, endDate: localDate(end) };
}

function onStartDateChange() {
  if (!endDate.value || endDate.value < eventDate.value) endDate.value = eventDate.value;
  applyDurationToEnd();
}
function onEndDateChange() {
  if (endDate.value < eventDate.value) endDate.value = eventDate.value;
  recalcDurationFromEnd();
}
function onStartTimeChange() { applyDurationToEnd(); }
function onEndTimeChange() { recalcDurationFromEnd(); }
function onDurationInput() {
  if (durLock) return;
  durationMin.value = Math.max(0, durD.value * 1440 + durH.value * 60 + durM.value);
  applyDurationToEnd();
}
function onAllDayToggle() {
  if (allDay.value) {
    if (!endDate.value || endDate.value < eventDate.value) endDate.value = eventDate.value;
    recalcDurationFromEnd();
  } else {
    if (durationMin.value <= 0) durationMin.value = 60;
    applyDurationToEnd();
  }
}

const durationText = computed(() => {
  if (allDay.value) {
    const days = Math.max(1, Math.ceil(durationMin.value / 1440));
    return days === 1 ? '全天' : `共 ${days} 天`;
  }
  return durationMin.value > 0 ? `共 ${fmtDuration(durationMin.value)}` : '结束时间需晚于开始时间';
});

watch(() => props.modelValue, (v) => {
  if (!v) return;
  confirmDelete.value = false;
  if (props.event) {
    title.value = props.event.title;
    eventDate.value = props.event.event_date;
    endDate.value = props.event.end_date || props.event.event_date;
    allDay.value = props.event.is_all_day;
    startTime.value = props.event.start_time ?? '09:00';
    endTime.value = props.event.end_time ?? '10:00';
    note.value = props.event.note;
    visibility.value = props.event.visibility === 'private' ? 'private' : 'public';
    picked.value = props.event.participants.map((p) => p.id);
    recalcDurationFromEnd();
  } else {
    const d = props.date || todayStr();
    const range = defaultTimeRange(d);
    title.value = '';
    eventDate.value = d;
    endDate.value = range.endDate;
    allDay.value = false;
    startTime.value = range.start;
    endTime.value = range.end;
    durationMin.value = 60;
    syncDurFields(60);
    note.value = '';
    visibility.value = 'public';
    picked.value = props.isParent ? [] : [props.meId];
  }
}, { immediate: true });

const children = computed(() => props.family.children);
const parents = computed(() => props.family.parents);

function label(m: FamilyMember): string {
  return memberLabel(m);
}

/** chip 是否可点 */
function pickable(m: FamilyMember): boolean {
  if (!props.isParent) {
    // 孩子：自己永远锁定；私有锁定为自己（父母全可见，兄弟姐妹只看占位）
    if (m.id === props.meId) return false;
    return visibility.value !== 'private';
  }
  // 家长：新规则下公开/私有都是「全家家长可见 + 孩子按规则看」，参与人不受可见性限制
  return true;
}

function togglePick(m: FamilyMember) {
  if (!pickable(m)) return;
  // 自己（孩子端）锁定必选
  if (!props.isParent && m.id === props.meId) return;
  const i = picked.value.indexOf(m.id);
  if (i >= 0) picked.value = picked.value.filter((x) => x !== m.id);
  else picked.value = [...picked.value, m.id];
}

function chipClass(m: FamilyMember) {
  return {
    picked: picked.value.includes(m.id),
    locked: !pickable(m),
  };
}

/** 私有提示 */
const privateHint = computed(() => {
  if (visibility.value !== 'private') return '';
  return props.isParent
    ? '家长都可见；孩子之间只看到「私有日程」和时间，看不到标题 / 参与人 / 备注'
    : '爸爸妈妈都能看到；兄弟姐妹只看到「私有日程」和时间';
});

const visibilityOptions: { value: 'public' | 'private'; label: string }[] = [
  { value: 'public', label: '公开' },
  { value: 'private', label: '私有' },
];

function chooseVisibility(v: 'public' | 'private') {
  visibility.value = v;
  if (v === 'private' && !props.isParent) picked.value = [props.meId];
}

async function save() {
  if (!title.value.trim()) return toast.warning('给日程起个名字吧');
  if (!eventDate.value) return toast.warning('选一个日期');
  if (!endDate.value || endDate.value < eventDate.value) return toast.warning('结束日期不能早于开始日期');
  if (picked.value.length === 0) return toast.warning('至少选择一位参与人');
  if (!allDay.value) {
    if (!startTime.value || !endTime.value) return toast.warning('请选择开始和结束时间');
    if (diffMinutes(eventDate.value, startTime.value, endDate.value, endTime.value) <= 0) {
      return toast.warning('结束时间要晚于开始时间');
    }
  }
  saving.value = true;
  try {
    const payload = {
      title: title.value.trim(),
      event_date: eventDate.value,
      end_date: endDate.value,
      is_all_day: allDay.value,
      start_time: allDay.value ? null : startTime.value,
      end_time: allDay.value ? null : endTime.value,
      note: note.value.trim(),
      participant_ids: picked.value,
      visibility: visibility.value,
    };
    if (isEdit.value && props.event) {
      await api.patch(`/calendar/events/${props.event.id}`, payload);
      toast.success('日程已更新');
    } else {
      await api.post('/calendar/events', payload);
      toast.success('日程已创建 📅');
    }
    emit('update:modelValue', false);
    emit('saved');
  } catch (e: any) {
    const map: Record<string, string> = {
      end_before_start: '结束时间要晚于开始时间',
      invalid_date: '日期不合法',
      participant_not_found: '参与人不存在，刷新后重试',
    };
    toast.error(map[e?.error] ?? e?.message ?? '保存失败');
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!props.event) return;
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    return;
  }
  try {
    await api.delete(`/calendar/events/${props.event.id}`);
    toast.success('日程已删除');
    emit('update:modelValue', false);
    emit('saved');
  } catch (e: any) {
    toast.error(e?.message ?? '删除失败');
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    variant="playful"
    width="520px"
    :title="isEdit ? '✏️ 编辑日程' : '📅 新日程'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="ef-form">
      <div class="ef-field">
        <label>标题</label>
        <input v-model="title" maxlength="50" placeholder="如：钢琴课 / 看牙医 / 家庭日" />
      </div>

      <div class="ef-field">
        <label class="ef-inline">
          <input v-model="allDay" type="checkbox" class="ef-checkbox" @change="onAllDayToggle" />
          全天
        </label>
        <!-- 起止都写成「几月几日 几时几分」：左边开始、右边结束 -->
        <div class="ef-dt-row">
          <div class="ef-dt">
            <input v-model="eventDate" type="date" :max="endDate || undefined" @change="onStartDateChange" />
            <input v-if="!allDay" v-model="startTime" type="time" @change="onStartTimeChange" />
          </div>
          <span class="ef-to">–</span>
          <div class="ef-dt">
            <input v-model="endDate" type="date" :min="eventDate || undefined" @change="onEndDateChange" />
            <input v-if="!allDay" v-model="endTime" type="time" @change="onEndTimeChange" />
          </div>
        </div>
      </div>

      <!-- 时长与结束时间双向计算：改结束 → 时长自动变；改时长 → 结束自动变 -->
      <div class="ef-field">
        <label>时长 <span class="ef-dur-sum">{{ durationText }}</span></label>
        <div class="ef-dur">
          <input
            v-model.number="durD"
            type="number"
            :min="allDay ? 1 : 0"
            max="366"
            class="ef-dur-num"
            @input="onDurationInput"
          />
          <span class="ef-dur-unit">天</span>
          <template v-if="!allDay">
            <input v-model.number="durH" type="number" min="0" max="23" class="ef-dur-num" @input="onDurationInput" />
            <span class="ef-dur-unit">小时</span>
            <input v-model.number="durM" type="number" min="0" max="59" class="ef-dur-num" @input="onDurationInput" />
            <span class="ef-dur-unit">分钟</span>
          </template>
        </div>
      </div>

      <div class="ef-field">
        <label>参与人 <em>*</em></label>
        <div class="ef-group" v-if="parents.length && (isParent || visibility !== 'private')">
          <span class="ef-group-label">家长</span>
          <div class="ef-chips">
            <button
              v-for="m in parents"
              :key="m.id"
              class="ef-chip"
              :class="chipClass(m)"
              :title="m.id === meId && !isParent ? '自己（必选）' : ''"
              @click="togglePick(m)"
            >
              <ZodiacAvatar :zodiac="m.avatar ?? ''" :size="26" />
              <span class="ef-chip-name">{{ label(m) }}</span>
            </button>
          </div>
        </div>
        <div class="ef-group">
          <span class="ef-group-label">{{ isParent ? '孩子' : '兄弟姐妹' }}</span>
          <div class="ef-chips">
            <button
              v-for="m in children"
              :key="m.id"
              class="ef-chip"
              :class="chipClass(m)"
              @click="togglePick(m)"
            >
              <ZodiacAvatar :zodiac="m.avatar ?? ''" :size="26" />
              <span class="ef-chip-name">{{ label(m) }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="ef-field">
        <label>谁能看见</label>
        <div class="ef-vis-row">
          <button
            v-for="o in visibilityOptions"
            :key="o.value"
            class="ef-vis-opt"
            :class="{ active: visibility === o.value }"
            @click="chooseVisibility(o.value)"
          >{{ o.label }}</button>
        </div>
        <p v-if="privateHint" class="ef-hint">{{ privateHint }}</p>
        <p v-if="!isParent && visibility === 'public'" class="ef-hint">兄弟姐妹和爸爸妈妈都能看到这条日程</p>
      </div>

      <div class="ef-field">
        <label>备注</label>
        <textarea v-model="note" rows="2" maxlength="200" placeholder="地点、要带的东西…（选填）" />
      </div>
    </div>

    <template #footer>
      <button v-if="isEdit" class="btn ef-del" @click="remove">
        {{ confirmDelete ? '再点一下确认删除' : '删除' }}
      </button>
      <button class="btn btn-ghost" @click="emit('update:modelValue', false)">取消</button>
      <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.ef-form { display: flex; flex-direction: column; gap: var(--space-14); }
.ef-field { display: flex; flex-direction: column; gap: var(--space-6); }
.ef-field > label { font-size: var(--fs-xs); color: var(--text-secondary); }
.ef-field em { color: var(--text-on-red); font-style: normal; margin-left: 2px; }
.ef-field input[type='text'],
.ef-field input:not([type]),
.ef-field input[type='date'],
.ef-field input[type='time'],
.ef-field textarea {
  width: 100%;
  padding: var(--space-10);
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  font-family: inherit;
  font-size: var(--fs-sm);
  resize: vertical;
}
.ef-inline { display: flex; align-items: center; gap: var(--space-6); font-size: var(--fs-sm); color: var(--text-primary); }
.ef-checkbox { width: 16px; height: 16px; }
.ef-times { display: flex; align-items: center; gap: var(--space-8); }
.ef-dash { color: var(--text-muted); }
.ef-range { display: flex; align-items: center; gap: var(--space-8); }
.ef-range input { flex: 1; min-width: 0; }
.ef-to { color: var(--text-muted); }

/* 「日期 + 时间」一组，左起右止：2026-11-16 09:00 – 2026-11-17 11:30 */
.ef-dt-row { display: flex; align-items: center; gap: var(--space-8); }
.ef-dt { display: flex; align-items: center; gap: var(--space-6); flex: 1; min-width: 0; }
.ef-dt input { min-width: 0; }
.ef-dt input[type='date'] { flex: 1.35; }
.ef-dt input[type='time'] { flex: 1; }
/* 窄屏：起止各占一行，避免四个控件挤在一行把日期裁掉 */
@media (max-width: 520px) {
  .ef-dt-row { flex-wrap: wrap; gap: var(--space-6); }
  .ef-dt { flex-basis: 100%; }
  .ef-to { display: none; }
}

/* 时长：天/时/分，改它反算结束时间 */
.ef-dur { display: flex; align-items: center; gap: var(--space-6); flex-wrap: wrap; }
.ef-dur-num {
  width: 62px;
  padding: var(--space-8);
  text-align: center;
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  border: 1.5px solid var(--glass-border);
  font-size: var(--fs-sm);
}
.ef-dur-unit { font-size: var(--fs-xs); color: var(--text-secondary); }
.ef-dur-sum { font-size: var(--fs-2xs); color: var(--text-muted); font-weight: 400; }

.ef-group { margin-top: var(--space-4); }
.ef-group-label { font-size: var(--fs-2xs); color: var(--text-muted); display: block; margin-bottom: var(--space-4); }
.ef-chips { display: flex; flex-wrap: wrap; gap: var(--space-6); }
.ef-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-10) var(--space-4) var(--space-4);
  border-radius: var(--r-full);
  background: var(--glass-bg);
  border: 1.5px solid var(--glass-border);
  transition: all var(--dur-fast);
  max-width: 140px;
}
.ef-chip.picked { border-color: rgba(110, 200, 160, 0.75); background: rgba(110, 200, 160, 0.14); }
.ef-chip.locked { opacity: 0.5; cursor: default; }
.ef-chip-name { font-size: var(--fs-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ef-vis-row { display: flex; gap: var(--space-6); flex-wrap: wrap; }
.ef-vis-opt {
  padding: var(--space-6) var(--space-12);
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  background: var(--glass-bg);
  border: 1.5px solid var(--glass-border);
}
.ef-vis-opt.active { border-color: rgba(110, 200, 160, 0.75); background: rgba(110, 200, 160, 0.14); font-weight: 600; }
.ef-hint { font-size: var(--fs-2xs); color: var(--text-muted); }

.ef-del { background: rgba(255, 122, 122, 0.12); color: var(--text-on-red); margin-right: auto; }
.ef-del:hover { background: rgba(255, 122, 122, 0.25); }
</style>
