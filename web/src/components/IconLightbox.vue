<script setup lang="ts">
import CategoryIcon from '@/components/CategoryIcon.vue';

// 图标/商品图片放大预览灯箱：点击遮罩任意处关闭
const props = defineProps<{
  modelValue: boolean;
  icon?: string | null;
  name?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>();

function close() {
  emit('update:modelValue', false);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="lb-fade">
      <div v-if="modelValue" class="lb-overlay" @click="close">
        <div class="lb-body" @click.stop>
          <CategoryIcon :icon="icon" :size="280" class="lb-icon" />
          <p v-if="name" class="lb-name">{{ name }}</p>
          <p class="lb-hint">点击空白处关闭</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.lb-overlay {
  position: fixed;
  inset: 0;
  background: rgba(20, 16, 12, 0.6);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1600; /* 高于 ConfirmDialog(1500) 与 Modal(1000) */
  padding: var(--space-24);
}
.lb-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-12);
}
.lb-icon {
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
}
.lb-name {
  color: #fff;
  font-family: var(--font-cute);
  font-size: var(--fs-xl);
}
.lb-hint {
  color: rgba(255, 255, 255, 0.6);
  font-size: var(--fs-xs);
}
.lb-fade-enter-active,
.lb-fade-leave-active {
  transition: opacity var(--dur-base);
}
.lb-fade-enter-from,
.lb-fade-leave-to {
  opacity: 0;
}
</style>
