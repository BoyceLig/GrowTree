<script setup lang="ts">
/**
 * 特殊日新建/编辑（家长专属，2026-11-14）：
 * 名称 + emoji → 重复规则（单天/每周几/每月几号/每年几月几号）→ 作用范围（全家/指定孩子）
 * → 积分效果（获得倍率 / 消耗倍率 / 纯纪念）→ 生效起止。
 * 每条特殊日只带一种积分效果（学习日=获得翻倍、购物日=消耗减半，够用且好理解）。
 */
import { computed, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import type { FamilyMember, SpecialDayFull } from './types';
import { todayStr, WEEK_LABELS } from './types';

const props = defineProps<{
  modelValue: boolean;
  specialDay: SpecialDayFull | null;
  family: { parents: FamilyMember[]; children: FamilyMember[] };
}>();
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; saved: [] }>();

const toast = useToastStore();

const EMOJIS = ['🎉', '📚', '🎮', '🏆', '🎁', '🎂', '💪', '🚴', '🎨', '⛄', '🍕', '🌟'];

const name = ref('');
const emoji = ref('🎉');
const ruleType = ref<'once' | 'weekly' | 'monthly' | 'yearly'>('once');
const onceDate = ref('');
const weekdays = ref<number[]>([]);
const monthDays = ref<number[]>([]);
const yearlyDate = ref('');
const scope = ref<'all' | 'custom'>('all');
const targetIds = ref<number[]>([]);
const effectKind = ref<'earn' | 'spend' | 'none'>('none');
const earnMult = ref(2);
const spendMult = ref(0.5);
const rangeStart = ref('');
const rangeEnd = ref('');
const enabled = ref(true);
const saving = ref(false);

const isEdit = computed(() => !!props.specialDay);

watch(() => props.modelValue, (v) => {
  if (!v) return;
  const s = props.specialDay;
  if (s) {
    name.value = s.name;
    emoji.value = s.emoji || '🎉';
    ruleType.value = s.rule_type;
    onceDate.value = s.once_date ?? todayStr();
    weekdays.value = [...s.weekdays];
    monthDays.value = [...s.month_days];
    yearlyDate.value = s.yearly_md ? `${new Date().getFullYear()}-${s.yearly_md}` : todayStr();
    scope.value = s.scope;
    targetIds.value = [...s.target_ids];
    effectKind.value = s.effect_kind ?? 'none';
    earnMult.value = s.effect_kind === 'earn' ? Number(s.effect_value) : 2;
    spendMult.value = s.effect_kind === 'spend' ? Number(s.effect_value) : 0.5;
    rangeStart.value = s.range_start ?? '';
    rangeEnd.value = s.range_end ?? '';
    enabled.value = s.enabled;
  } else {
    name.value = '';
    emoji.value = '🎉';
    ruleType.value = 'once';
    onceDate.value = todayStr();
    weekdays.value = [];
    monthDays.value = [];
    yearlyDate.value = todayStr();
    scope.value = 'all';
    targetIds.value = [];
    effectKind.value = 'none';
    earnMult.value = 2;
    spendMult.value = 0.5;
    rangeStart.value = '';
    rangeEnd.value = '';
    enabled.value = true;
  }
}, { immediate: true });

function toggleWeekday(w: number) {
  const i = weekdays.value.indexOf(w);
  if (i >= 0) weekdays.value = weekdays.value.filter((x) => x !== w);
  else weekdays.value = [...weekdays.value, w].sort((a, b) => a - b);
}
function toggleMonthDay(d: number) {
  const i = monthDays.value.indexOf(d);
  if (i >= 0) monthDays.value = monthDays.value.filter((x) => x !== d);
  else monthDays.value = [...monthDays.value, d].sort((a, b) => a - b);
}
function toggleTarget(m: FamilyMember) {
  const i = targetIds.value.indexOf(m.id);
  if (i >= 0) targetIds.value = targetIds.value.filter((x) => x !== m.id);
  else targetIds.value = [...targetIds.value, m.id];
}

async function save() {
  if (!name.value.trim()) return toast.warning('给这个日子起个名字');
  if (ruleType.value === 'weekly' && weekdays.value.length === 0) return toast.warning('至少选一个周几');
  if (ruleType.value === 'monthly' && monthDays.value.length === 0) return toast.warning('至少选一个日期');
  if (ruleType.value === 'once' && !onceDate.value) return toast.warning('选一个具体日期');
  if (ruleType.value === 'yearly' && !yearlyDate.value) return toast.warning('选一个每年的日期');
  if (scope.value === 'custom' && targetIds.value.length === 0) return toast.warning('指定至少一个孩子');
  if (effectKind.value === 'earn' && (earnMult.value <= 1 || earnMult.value > 3)) {
    return toast.warning('获得倍率需要在 1.1 ~ 3 之间');
  }
  if (effectKind.value === 'spend' && (spendMult.value <= 0 || spendMult.value >= 1)) {
    return toast.warning('消耗倍率需要在 0.1 ~ 0.9 之间');
  }

  saving.value = true;
  try {
    const payload = {
      name: name.value.trim(),
      emoji: emoji.value,
      rule_type: ruleType.value,
      once_date: ruleType.value === 'once' ? onceDate.value : undefined,
      weekdays: ruleType.value === 'weekly' ? weekdays.value : undefined,
      month_days: ruleType.value === 'monthly' ? monthDays.value : undefined,
      yearly_md: ruleType.value === 'yearly' ? yearlyDate.value.slice(5) : undefined,
      range_start: rangeStart.value || null,
      range_end: rangeEnd.value || null,
      scope: scope.value,
      target_ids: scope.value === 'custom' ? targetIds.value : [],
      effect_kind: effectKind.value === 'none' ? null : effectKind.value,
      effect_value: effectKind.value === 'earn' ? earnMult.value : effectKind.value === 'spend' ? spendMult.value : undefined,
      enabled: enabled.value,
    };
    if (isEdit.value && props.specialDay) {
      await api.patch(`/special-days/${props.specialDay.id}`, payload);
      toast.success('特殊日已更新');
    } else {
      await api.post('/special-days', payload);
      toast.success('特殊日已创建 🎉');
    }
    emit('update:modelValue', false);
    emit('saved');
  } catch (e: any) {
    toast.error(e?.message ?? '保存失败');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    variant="playful"
    width="460px"
    :title="isEdit ? '✏️ 编辑特殊日' : '🎉 新特殊日'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="sd-form">
      <div class="sd-field">
        <label>名称</label>
        <input v-model="name" maxlength="30" placeholder="如：学习日 / 玩具日 / 生日" />
      </div>

      <div class="sd-field">
        <label>图标</label>
        <div class="sd-emoji-row">
          <button
            v-for="e in EMOJIS"
            :key="e"
            class="sd-emoji"
            :class="{ active: emoji === e }"
            @click="emoji = e"
          >{{ e }}</button>
        </div>
      </div>

      <div class="sd-field">
        <label>重复</label>
        <div class="sd-seg">
          <button class="sd-seg-opt" :class="{ active: ruleType === 'once' }" @click="ruleType = 'once'">单天</button>
          <button class="sd-seg-opt" :class="{ active: ruleType === 'weekly' }" @click="ruleType = 'weekly'">每周</button>
          <button class="sd-seg-opt" :class="{ active: ruleType === 'monthly' }" @click="ruleType = 'monthly'">每月</button>
          <button class="sd-seg-opt" :class="{ active: ruleType === 'yearly' }" @click="ruleType = 'yearly'">每年</button>
        </div>
        <input v-if="ruleType === 'once'" v-model="onceDate" type="date" />
        <div v-if="ruleType === 'weekly'" class="sd-chip-row">
          <button
            v-for="(w, i) in WEEK_LABELS"
            :key="w"
            class="sd-chip"
            :class="{ active: weekdays.includes(i + 1) }"
            @click="toggleWeekday(i + 1)"
          >{{ w }}</button>
        </div>
        <div v-if="ruleType === 'monthly'" class="sd-month-grid">
          <button
            v-for="d in 31"
            :key="d"
            class="sd-chip sd-day"
            :class="{ active: monthDays.includes(d) }"
            @click="toggleMonthDay(d)"
          >{{ d }}</button>
        </div>
        <input v-if="ruleType === 'yearly'" v-model="yearlyDate" type="date" />
      </div>

      <div class="sd-field">
        <label>给谁生效</label>
        <div class="sd-seg">
          <button class="sd-seg-opt" :class="{ active: scope === 'all' }" @click="scope = 'all'">全家</button>
          <button class="sd-seg-opt" :class="{ active: scope === 'custom' }" @click="scope = 'custom'">指定孩子</button>
        </div>
        <div v-if="scope === 'custom'" class="sd-chip-row">
          <button
            v-for="m in family.children"
            :key="m.id"
            class="sd-chip sd-member"
            :class="{ active: targetIds.includes(m.id) }"
            @click="toggleTarget(m)"
          >
            <ZodiacAvatar :zodiac="m.avatar ?? ''" :size="22" />
            <span>{{ m.nickname || m.name }}</span>
          </button>
        </div>
      </div>

      <div class="sd-field">
        <label>积分效果</label>
        <div class="sd-seg">
          <button class="sd-seg-opt" :class="{ active: effectKind === 'earn' }" @click="effectKind = 'earn'">获得加成</button>
          <button class="sd-seg-opt" :class="{ active: effectKind === 'spend' }" @click="effectKind = 'spend'">消耗折扣</button>
          <button class="sd-seg-opt" :class="{ active: effectKind === 'none' }" @click="effectKind = 'none'">纯纪念</button>
        </div>
        <div v-if="effectKind === 'earn'" class="sd-effect-row">
          <span>当天获得积分 ×</span>
          <input v-model.number="earnMult" type="number" min="1.1" max="3" step="0.1" />
          <span class="sd-hint">1.1 ~ 3，如 2 = 翻倍</span>
        </div>
        <div v-if="effectKind === 'spend'" class="sd-effect-row">
          <span>当天消耗积分 ×</span>
          <input v-model.number="spendMult" type="number" min="0.1" max="0.9" step="0.1" />
          <span class="sd-hint">0.1 ~ 0.9，如 0.5 = 减半</span>
        </div>
        <p v-if="effectKind === 'none'" class="sd-hint">只做标记，不影响积分</p>
        <p v-else class="sd-hint">只作用于孩子的积分；家长手动扣分不参与，商城/道具兑换按当天的倍率折算</p>
      </div>

      <div class="sd-field">
        <label>生效起止（选填）</label>
        <div class="sd-times">
          <input v-model="rangeStart" type="date" title="生效开始" />
          <span class="sd-dash">至</span>
          <input v-model="rangeEnd" type="date" title="生效结束" />
        </div>
      </div>

      <label v-if="isEdit" class="sd-inline">
        <input v-model="enabled" type="checkbox" class="sd-checkbox" />
        启用这条特殊日
      </label>
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="emit('update:modelValue', false)">取消</button>
      <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.sd-form { display: flex; flex-direction: column; gap: var(--space-14); }
.sd-field { display: flex; flex-direction: column; gap: var(--space-6); }
.sd-field > label { font-size: var(--fs-xs); color: var(--text-secondary); }
.sd-field input[type='text'],
.sd-field input:not([type]),
.sd-field input[type='date'],
.sd-field input[type='number'] {
  width: 100%;
  padding: var(--space-10);
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  font-family: inherit;
  font-size: var(--fs-sm);
}
.sd-emoji-row { display: flex; flex-wrap: wrap; gap: var(--space-4); }
.sd-emoji {
  width: 36px; height: 36px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 20px;
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  border: 1.5px solid transparent;
}
.sd-emoji.active { border-color: rgba(255, 209, 102, 0.7); background: rgba(255, 209, 102, 0.16); }

.sd-seg { display: flex; gap: var(--space-6); flex-wrap: wrap; }
.sd-seg-opt {
  padding: var(--space-6) var(--space-12);
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  background: var(--glass-bg);
  border: 1.5px solid var(--glass-border);
}
.sd-seg-opt.active { border-color: rgba(110, 200, 160, 0.75); background: rgba(110, 200, 160, 0.14); font-weight: 600; }

.sd-chip-row { display: flex; flex-wrap: wrap; gap: var(--space-6); }
.sd-chip {
  min-width: 34px;
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-full);
  font-size: var(--fs-xs);
  background: var(--glass-bg);
  border: 1.5px solid var(--glass-border);
}
.sd-chip.active { border-color: rgba(110, 200, 160, 0.75); background: rgba(110, 200, 160, 0.14); font-weight: 600; }
.sd-chip.sd-member { display: inline-flex; align-items: center; gap: var(--space-4); }
.sd-month-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: var(--space-4); }
.sd-day { min-width: 0; padding: var(--space-4) 0; text-align: center; }

.sd-effect-row { display: flex; align-items: center; gap: var(--space-8); font-size: var(--fs-sm); }
.sd-effect-row input { width: 80px; }
.sd-hint { font-size: var(--fs-2xs); color: var(--text-muted); }
.sd-times { display: flex; align-items: center; gap: var(--space-8); }
.sd-dash { color: var(--text-muted); }
.sd-inline { display: flex; align-items: center; gap: var(--space-6); font-size: var(--fs-sm); }
.sd-checkbox { width: 16px; height: 16px; }
</style>
