<script setup lang="ts">
import { computed } from 'vue';

/**
 * 写操作确认面板：与 Ask Question 同一套「输入框上方上拉卡片」样式。
 * 服务端生成确认 token 后立刻弹出，家长选完才真正写库。
 */
type ConfirmCard = { token: string; summary: string; detail: string };

const props = defineProps<{
  card: ConfirmCard;
  index?: number;
  total?: number;
  busy?: boolean;
}>();
const emit = defineEmits<{ choose: ['once' | 'task' | 'deny'] }>();

const title = computed(() => props.card.summary || 'AI 请求执行操作');
const detail = computed(() => (props.card.detail && props.card.detail !== title.value ? props.card.detail : ''));
</script>

<template>
  <section class="confirm-sheet" role="dialog" aria-label="AI 请求执行操作，请确认">
    <header class="confirm-head">
      <span class="confirm-title">⚠️ 请确认这次操作</span>
      <span v-if="(total ?? 1) > 1" class="confirm-pager">{{ (index ?? 0) + 1 }} / {{ total }}</span>
    </header>

    <div class="confirm-body">
      <p class="confirm-summary">{{ title }}</p>
      <p v-if="detail" class="confirm-detail">{{ detail }}</p>
      <p class="confirm-hint">确认后才会真正写入；拒绝则这次不执行。</p>
    </div>

    <footer class="confirm-actions">
      <button type="button" class="btn small danger" :disabled="busy" @click="emit('choose', 'deny')">✖ 拒绝</button>
      <button type="button" class="btn small" :disabled="busy" @click="emit('choose', 'task')">🔁 本次任务都允许</button>
      <button type="button" class="btn small btn-primary" :disabled="busy" @click="emit('choose', 'once')">
        ✅ 允许一次
      </button>
    </footer>
  </section>
</template>

<style scoped>
.confirm-sheet {
  flex: none;
  width: min(720px, calc(100% - var(--space-20)));
  margin: 0 auto var(--space-10);
  padding: var(--space-12) var(--space-14);
  border: 1px solid rgba(224, 188, 125, 0.55);
  border-radius: var(--r-lg);
  background: #fff;
  box-shadow: 0 10px 30px rgba(90, 58, 74, 0.16);
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  animation: confirm-sheet-up 0.2s ease-out;
}
@keyframes confirm-sheet-up {
  from {
    transform: translateY(10px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
.confirm-head {
  display: flex;
  align-items: center;
  gap: var(--space-8);
}
.confirm-title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.confirm-pager {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
}
.confirm-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  max-height: 34vh;
  overflow-y: auto;
  padding: 2px;
}
.confirm-summary {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-primary);
  line-height: 1.5;
}
.confirm-detail {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.55;
  white-space: pre-wrap;
}
.confirm-hint {
  margin: 0;
  font-size: var(--fs-2xs);
  color: var(--text-muted, #7a6a55);
}
.confirm-actions {
  display: flex;
  gap: var(--space-8);
  justify-content: flex-end;
  flex-wrap: wrap;
}
.btn.small {
  min-height: 32px;
  padding: var(--space-4) var(--space-12);
  border-radius: var(--r-sm);
  border: none;
  background: var(--glass-bg);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  white-space: nowrap;
  cursor: pointer;
}
.btn.small.btn-primary {
  background: linear-gradient(135deg, var(--accent-orange), var(--accent-pink));
  color: #fff;
}
.btn.small.danger {
  color: #b23b3b;
}
.btn.small:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
