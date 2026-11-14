<script setup lang="ts">
/**
 * 二级页面的返回控件：图标 + 文字，胶囊样式带描边与投影，
 * 比裸文字更像可点控件；悬停/按下/键盘聚焦都有明确反馈。
 *
 * 父级只负责「点了要回哪」，是否拦截未保存修改由父级决定。
 */
defineProps<{ label: string }>();
const emit = defineEmits<{ click: [] }>();
</script>

<template>
  <button type="button" class="back-button" @click="emit('click')">
    <span class="icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 3 5 8l5 5" />
      </svg>
    </span>
    <span class="text">{{ label }}</span>
  </button>
</template>

<style scoped>
.back-button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-8);
  align-self: flex-start;
  min-height: 44px;
  padding: var(--space-4) var(--space-16) var(--space-4) var(--space-4);
  border-radius: var(--r-pill);
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-pill);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  font-weight: 600;
  line-height: 1.2;
  transition: background var(--dur-fast), border-color var(--dur-fast),
    box-shadow var(--dur-fast), transform var(--dur-fast);
}
.back-button:hover {
  background: #fff;
  border-color: var(--accent-orange);
  box-shadow: 0 6px 16px rgba(90, 58, 74, 0.2);
}
.back-button:active {
  transform: translateY(1px);
  box-shadow: 0 2px 6px rgba(90, 58, 74, 0.16);
}
.back-button:focus-visible {
  outline: 2px solid var(--accent-orange);
  outline-offset: 2px;
}

.icon {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: var(--r-full);
  background: rgba(255, 180, 84, 0.16);
  color: var(--text-on-orange);
  transition: background var(--dur-fast);
}
.icon svg {
  width: 15px;
  height: 15px;
  transition: transform var(--dur-fast);
}
.back-button:hover .icon {
  background: rgba(255, 180, 84, 0.3);
}
.back-button:hover .icon svg {
  transform: translateX(-2px);
}
</style>
