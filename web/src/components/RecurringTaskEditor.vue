<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';

const props = defineProps<{
  modelValue: boolean;
  task?: any;
  children: Child[];
}>();
const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  saved: [];
}>();

interface Child { id: number; name: string; avatar: string }

const toast = useToastStore();
const isEdit = computed(() => !!props.task);

const name = ref('');
const description = ref('');
const points = ref(10);
/** null = 不选重复频率 → 单次任务（只做一次） */
const freqType = ref<'daily' | 'weekly' | 'monthly' | null>('daily');
const weekdays = ref<number[]>([]);
const monthDay = ref(1);
const dueTimeEnabled = ref(false);
const dueTime = ref('20:00');
const childIds = ref<number[]>([]);
/** 有效时间段：如 2026-10-01 至 2026-10-07；不开启则长期有效 */
const validEnabled = ref(false);
const validFrom = ref('');
const validTo = ref('');
const saving = ref(false);

/** 本地时区今天 YYYY-MM-DD */
function todayStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const WEEKDAY_OPTIONS: { v: number; label: string }[] = [
  { v: 1, label: '一' },
  { v: 2, label: '二' },
  { v: 3, label: '三' },
  { v: 4, label: '四' },
  { v: 5, label: '五' },
  { v: 6, label: '六' },
  { v: 7, label: '日' },
];

// immediate: 组件由 v-if 控制挂载，打开时 modelValue 已是 true，watch 必须立即执行一次才能回填
watch(() => props.modelValue, (open) => {
  if (open) {
    if (props.task) {
      name.value = props.task.name;
      description.value = props.task.description ?? '';
      points.value = props.task.points;
      freqType.value = props.task.once_only ? null : props.task.freq_type;
      try { weekdays.value = JSON.parse(props.task.weekdays ?? '[]'); } catch { weekdays.value = []; }
      monthDay.value = props.task.month_day ?? 1;
      if (props.task.due_time) {
        dueTimeEnabled.value = true;
        dueTime.value = props.task.due_time;
      } else {
        dueTimeEnabled.value = false;
        dueTime.value = '20:00';
      }
      try { childIds.value = props.task.child_ids ? JSON.parse(props.task.child_ids) : []; } catch { childIds.value = []; }
      if (props.task.valid_from || props.task.valid_to) {
        validEnabled.value = true;
        validFrom.value = props.task.valid_from ?? '';
        validTo.value = props.task.valid_to ?? '';
      } else {
        validEnabled.value = false;
        validFrom.value = todayStr();
        validTo.value = todayStr(7);
      }
    } else {
      name.value = '';
      description.value = '';
      points.value = 10;
      freqType.value = 'daily';
      weekdays.value = [];
      monthDay.value = 1;
      dueTimeEnabled.value = false;
      dueTime.value = '20:00';
      childIds.value = [];
      validEnabled.value = false;
      validFrom.value = todayStr();
      validTo.value = todayStr(7);
    }
  }
}, { immediate: true });

function toggleChild(id: number) {
  const idx = childIds.value.indexOf(id);
  if (idx >= 0) childIds.value.splice(idx, 1);
  else childIds.value.push(id);
}

function toggleWeekday(v: number) {
  const idx = weekdays.value.indexOf(v);
  if (idx >= 0) weekdays.value.splice(idx, 1);
  else weekdays.value.push(v);
}

/** 频率按钮：点未选中的就选上；点已选中的则取消 → 变成「单次任务」 */
function toggleFreq(v: 'daily' | 'weekly' | 'monthly') {
  freqType.value = freqType.value === v ? null : v;
}

async function save() {
  if (!name.value.trim()) return toast.warning('请输入任务名称');
  if (freqType.value === 'weekly' && weekdays.value.length === 0) {
    return toast.warning('请选择每周的星期几');
  }
  if (dueTimeEnabled.value && !/^([01]?\d|2[0-3]):([0-5]\d)$/.test(dueTime.value)) {
    return toast.warning('最后完成时间格式不正确');
  }
  if (validEnabled.value) {
    if (!validFrom.value && !validTo.value) return toast.warning('请至少填写有效开始或结束日期');
    if (validFrom.value && validTo.value && validFrom.value > validTo.value) {
      return toast.warning('有效开始日期不能晚于结束日期');
    }
  }

  const body: Record<string, unknown> = {
    name: name.value.trim(),
    description: description.value.trim() || null,
    points: points.value,
    // freqType 为 null = 单次任务；freq_type 仅作占位（后端 DB 的 CHECK 不允许空）
    freq_type: freqType.value ?? 'daily',
    once_only: freqType.value === null,
    weekdays: freqType.value === 'weekly' ? [...weekdays.value].sort() : null,
    month_day: freqType.value === 'monthly' ? monthDay.value : null,
    due_time: dueTimeEnabled.value ? dueTime.value : null,
    child_ids: childIds.value.length > 0 ? [...childIds.value] : null,
    valid_from: validEnabled.value ? (validFrom.value || null) : null,
    valid_to: validEnabled.value ? (validTo.value || null) : null,
  };

  saving.value = true;
  try {
    if (isEdit.value) {
      await api.patch(`/recurring-tasks/${props.task.id}`, body);
      toast.success('已更新任务');
    } else {
      await api.post('/recurring-tasks', body);
      toast.success('任务创建成功 🎉');
    }
    emit('saved');
  } catch (e: any) {
    toast.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="isEdit ? '编辑任务' : '新建任务'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="form">
      <div class="field">
        <label class="label">指定小朋友（不选 = 所有小朋友都可领取）</label>
        <div class="child-grid">
          <button
            v-for="c in children"
            :key="c.id"
            type="button"
            :class="['child-chip', { active: childIds.includes(c.id) }]"
            @click="toggleChild(c.id)"
          >
            <ZodiacAvatar :zodiac="c.avatar" :size="56" />
            <span>{{ c.name }}</span>
            <span v-if="childIds.includes(c.id)" class="check">✓</span>
          </button>
        </div>
        <p class="hint">{{ childIds.length === 0 ? '当前：所有小朋友都能看到这个任务' : `当前：只有选中的 ${childIds.length} 个小朋友能看到` }}</p>
      </div>

      <div class="field">
        <label class="label">任务名称</label>
        <input v-model="name" type="text" maxlength="50" placeholder="如：每天整理书桌" />
      </div>

      <div class="field">
        <label class="label">任务描述（可选）</label>
        <textarea v-model="description" maxlength="200" rows="2" placeholder="任务详情..."></textarea>
      </div>

      <div class="field">
        <label class="label">奖励积分 🌟</label>
        <input v-model.number="points" type="number" min="1" max="999" />
      </div>

      <div class="field">
        <label class="label">重复频率（可以不选）</label>
        <div class="freq-row">
          <button
            type="button"
            :class="['freq-chip', { active: freqType === 'daily' }]"
            @click="toggleFreq('daily')"
          >每天</button>
          <button
            type="button"
            :class="['freq-chip', { active: freqType === 'weekly' }]"
            @click="toggleFreq('weekly')"
          >每周</button>
          <button
            type="button"
            :class="['freq-chip', { active: freqType === 'monthly' }]"
            @click="toggleFreq('monthly')"
          >每月</button>
        </div>

        <!-- 不选频率 = 单次任务 -->
        <div v-if="freqType === null" class="once-note">
          <span class="once-emoji">🔂</span>
          <span>
            <b>单次任务</b>：小朋友只做一次，做完就不会再出现。
            在想指定日期时打开下面的「设置有效时间段」即可（不设就一直可以领）。
          </span>
        </div>
        <p class="hint">
          {{ freqType === null
            ? '再点一下「每天 / 每周 / 每月」就能改回重复任务'
            : '再点一下已选中的频率即可取消选择 —— 那就是「单次任务」（只做一次）' }}
        </p>

        <!-- 每周：多选星期几 -->
        <div v-if="freqType === 'weekly'" class="weekday-row">
          <button
            v-for="opt in WEEKDAY_OPTIONS"
            :key="opt.v"
            type="button"
            :class="['weekday-chip', { active: weekdays.includes(opt.v) }]"
            @click="toggleWeekday(opt.v)"
          >周{{ opt.label }}</button>
        </div>
        <p v-if="freqType === 'weekly'" class="hint">可多选；每个选中的星期几各算一期</p>

        <!-- 每月：几号 -->
        <div v-if="freqType === 'monthly'" class="monthday-row">
          <span class="mini-label">每月</span>
          <input v-model.number="monthDay" type="number" min="1" max="28" class="monthday-input" />
          <span class="mini-label">号（1-28）</span>
        </div>
      </div>

      <div class="field">
        <label class="label">
          <input v-model="dueTimeEnabled" type="checkbox" class="checkbox" />
          最后完成时间
        </label>
        <div v-if="dueTimeEnabled" class="due-row">
          <input v-model="dueTime" type="time" class="time-input" />
          <span class="due-suffix">前完成</span>
        </div>
        <p class="hint">
          {{ freqType === null && !validEnabled
            ? '单次任务不设有效期时没有截止时间，这一项不生效；想限时就打开下面的「设置有效时间段」'
            : '超过这个时间本期就不能领取/提交了；不设置则当天 23:59 前' }}
        </p>
      </div>

      <div class="field">
        <label class="label">
          <input v-model="validEnabled" type="checkbox" class="checkbox" />
          设置有效时间段
        </label>
        <div v-if="validEnabled" class="due-row">
          <input v-model="validFrom" type="date" class="time-input" />
          <span class="due-suffix">至</span>
          <input v-model="validTo" type="date" class="time-input" />
        </div>
        <p class="hint">
          {{ validEnabled
            ? (freqType === null
                ? '单次任务会在结束日期（含当天，按上面的完成时间）后作废，例如「国庆做一次大扫除」'
                : '只在开始日期到结束日期之间可以领取（含首尾两天），例如假期专项任务；日期留空表示该侧不限')
            : (freqType === null
                ? '不设置则不过期 —— 可以一直领，直到小朋友做完这一次'
                : '不设置则长期有效，每天/每周/每月一直循环') }}
        </p>
      </div>
    </div>

    <template #footer>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" @click="emit('update:modelValue', false)">取消</button>
      <button class="btn btn-primary" @click="save" :disabled="saving">
        {{ saving ? '保存中...' : (isEdit ? '保存' : '创建') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: var(--space-18); }
.field { display: flex; flex-direction: column; gap: var(--space-8); }
.label { font-size: var(--fs-sm); color: var(--text-secondary); padding-left: var(--space-4); display: flex; align-items: center; gap: var(--space-6); }
.hint { font-size: var(--fs-xs); color: var(--text-muted); padding-left: var(--space-4); }
.checkbox { width: auto; }

.child-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-8);
}
.child-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-10) var(--space-4);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 2px solid transparent;
  transition: all var(--dur-base);
  position: relative;
  cursor: pointer;
}
.child-chip span { font-size: var(--fs-xs); font-family: var(--font-cute); }
.child-chip.active {
  border-color: var(--accent-yellow);
  background: rgba(255, 209, 102, 0.15);
}
.child-chip .check {
  position: absolute;
  top: var(--space-4);
  right: var(--space-6);
  color: var(--text-on-yellow);
  font-size: var(--fs-sm);
  font-weight: bold;
}

textarea { resize: vertical; min-height: 60px; font-family: inherit; }

.freq-row { display: flex; gap: var(--space-8); }
.freq-chip {
  flex: 1;
  padding: var(--space-10);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 2px solid transparent;
  color: var(--text-secondary);
  font-weight: 600;
  transition: all var(--dur-base);
  cursor: pointer;
}
.freq-chip.active {
  border-color: var(--accent-yellow);
  background: rgba(255, 209, 102, 0.15);
  color: var(--text-primary);
}

/* 不选频率 → 单次任务的说明块（比 .hint 更显眼一点） */
.once-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-8);
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-sm);
  background: rgba(255, 152, 92, 0.12);
  color: var(--text-on-orange);
  font-size: var(--fs-xs);
  line-height: 1.5;
}
.once-note b { color: var(--text-primary); }
.once-emoji { font-size: var(--fs-md); line-height: 1.2; }

.weekday-row { display: flex; gap: var(--space-6); flex-wrap: wrap; }
.weekday-chip {
  padding: var(--space-6) var(--space-12);
  border-radius: var(--r-full);
  background: var(--glass-bg);
  border: 2px solid transparent;
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  transition: all var(--dur-base);
  cursor: pointer;
}
.weekday-chip.active {
  border-color: var(--accent-yellow);
  background: rgba(255, 209, 102, 0.15);
  color: var(--text-primary);
  font-weight: 600;
}

.monthday-row { display: flex; align-items: center; gap: var(--space-8); }
.mini-label { font-size: var(--fs-sm); color: var(--text-secondary); }
.monthday-input { width: 90px; }

.due-row { display: flex; align-items: center; gap: var(--space-8); }
.time-input { flex: 1; }
.due-suffix { font-size: var(--fs-sm); color: var(--text-secondary); white-space: nowrap; }
</style>
