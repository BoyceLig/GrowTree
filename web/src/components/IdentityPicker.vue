<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * 身份选择：内置 20 个常见称谓 + 自定义输入。
 * 单值选择（一个人只有一个身份），但按参考图用胶囊网格呈现。
 */
const IDENTITIES = [
  '妈妈', '爸爸', '奶奶', '爷爷', '姥姥',
  '姥爷', '外婆', '外公', '伯伯', '伯母',
  '叔叔', '婶婶', '姑姑', '姑父', '舅舅',
  '舅妈', '姨姨', '姨夫', '干妈', '阿姨',
];

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [v: string] }>();

const custom = ref(IDENTITIES.includes(props.modelValue) ? '' : props.modelValue);

watch(
  () => props.modelValue,
  (v) => {
    custom.value = IDENTITIES.includes(v) ? '' : v;
  },
);

function choose(value: string) {
  custom.value = '';
  emit('update:modelValue', value);
}

function onCustomInput(e: Event) {
  const value = (e.target as HTMLInputElement).value;
  custom.value = value;
  emit('update:modelValue', value.trim());
}
</script>

<template>
  <div class="identity-picker">
    <div class="identity-grid" role="group" aria-label="选择身份">
      <button
        v-for="name in IDENTITIES"
        :key="name"
        type="button"
        class="pill"
        :class="{ active: modelValue === name }"
        :aria-pressed="modelValue === name"
        @click="choose(name)"
      >
        {{ name }}
      </button>
    </div>

    <label class="custom-label" for="identity-custom">自定义</label>
    <input
      id="identity-custom"
      :value="custom"
      type="text"
      maxlength="20"
      placeholder="如：姑姑、阿姨..."
      @input="onCustomInput"
    />
  </div>
</template>

<style scoped>
.identity-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}
.identity-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-8);
}
.pill {
  min-height: 40px;
  padding: var(--space-6) var(--space-4);
  border-radius: var(--r-pill);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  line-height: 1.2;
  transition: all var(--dur-fast);
}
.pill:hover {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}
.pill.active {
  background: rgba(255, 155, 176, 0.16);
  border-color: var(--accent-pink);
  color: var(--accent-orange-red);
  font-weight: 600;
}
.custom-label {
  margin-top: var(--space-2);
  padding-left: var(--space-4);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
@media (max-width: 440px) {
  .identity-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
