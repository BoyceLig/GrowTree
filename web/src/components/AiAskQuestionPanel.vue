<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * 「Ask Question」面板：AI 需要追问 / 让家长做选择 / 动手前确认时，从输入框上方"上拉"出现。
 *
 * 刻意不做成全屏 Modal：
 *   - 只是对话区底部的一张卡片，聊天记录仍然可见、可滚动；
 *   - 多个问题用 `‹ 1 / 3 ›` 翻页，一次只答一题；
 *   - 每题可给 2~4 个选项（单选/多选），下方永远有自由输入（等于「其他」）；
 *   - 提交后把答案按题目顺序回传，服务端作为工具结果继续本轮；跳过/关闭 = 不回答。
 */

type AskOption = { label: string; description?: string };
type AskQuestion = { question: string; header?: string; options?: AskOption[]; multi?: boolean };

const props = defineProps<{
  questions: AskQuestion[];
  /** 来自哪个会话（切到别的会话/切页面后补弹时，让用户知道上下文） */
  sessionTitle?: string;
  /** 服务端给的过期时间戳（毫秒） */
  expiresAt?: number;
}>();
const emit = defineEmits<{
  submit: [answers: { answers: string[] }[]];
  skip: [];
}>();

/** 已完成的标记，防止「提交」和「关闭」重复触发 */
const finished = ref(false);
const page = ref(0);

const picked = ref<string[][]>(props.questions.map(() => []));
const others = ref<string[]>(props.questions.map(() => ''));

const current = computed<AskQuestion | null>(() => props.questions[page.value] ?? null);
const isLast = computed(() => page.value >= props.questions.length - 1);
const total = computed(() => props.questions.length);

const answers = computed(() =>
  props.questions.map((_, i) => {
    const list = [...(picked.value[i] ?? [])];
    const extra = (others.value[i] ?? '').trim();
    if (extra) list.push(extra);
    return { answers: list };
  })
);

const ready = computed(() => answers.value.some((a) => a.answers.length > 0));

/** 大概还剩几分钟（服务端 10 分钟超时；只用于提示，不做实时倒计时） */
const remainingMin = computed(() => {
  if (!props.expiresAt) return 0;
  return Math.max(0, Math.ceil((props.expiresAt - Date.now()) / 60000));
});

function isPicked(label: string): boolean {
  return (picked.value[page.value] ?? []).includes(label);
}

function choose(label: string): void {
  const q = current.value;
  if (!q) return;
  const cur = picked.value[page.value] ?? [];
  if (q.multi) {
    picked.value[page.value] = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
  } else {
    picked.value[page.value] = cur[0] === label ? [] : [label];
  }
}

function prevPage(): void {
  if (page.value > 0) page.value--;
}

function nextPage(): void {
  if (!isLast.value) page.value++;
}

function submit(): void {
  if (!ready.value || finished.value) return;
  finished.value = true;
  emit('submit', answers.value);
}

function skip(): void {
  if (finished.value) return;
  finished.value = true;
  emit('skip');
}
</script>

<template>
  <section class="ask-sheet" role="dialog" aria-label="AI 想先确认一下">
    <header class="ask-head">
      <span class="ask-title">AI 想先确认一下</span>
      <span v-if="total > 1" class="ask-pager">
        <button type="button" :disabled="page === 0" aria-label="上一题" @click="prevPage">‹</button>
        <span>{{ page + 1 }} / {{ total }}</span>
        <button type="button" :disabled="isLast" aria-label="下一题" @click="nextPage">›</button>
      </span>
      <button type="button" class="ask-close" aria-label="跳过并关闭" title="跳过" @click="skip">✕</button>
    </header>

    <p v-if="sessionTitle" class="ask-session">
      来自会话「{{ sessionTitle }}」<span v-if="remainingMin > 0"> · 约 {{ remainingMin }} 分钟内有效</span>
    </p>

    <div v-if="current" class="ask-body">
      <div class="ask-heading">
        <span v-if="current.header" class="ask-tag">{{ current.header }}</span>
        <span v-if="current.multi" class="ask-multi">可多选</span>
      </div>
      <p class="ask-q">{{ current.question }}</p>

      <div v-if="current.options?.length" class="ask-opts">
        <button
          v-for="(opt, i) in current.options"
          :key="opt.label"
          type="button"
          class="ask-opt"
          :class="{ on: isPicked(opt.label) }"
          :aria-pressed="isPicked(opt.label)"
          @click="choose(opt.label)"
        >
          <span class="ask-idx">{{ i + 1 }}</span>
          <span class="ask-opt-text">
            <b>{{ opt.label }}</b>
            <small v-if="opt.description">{{ opt.description }}</small>
          </span>
        </button>
      </div>
    </div>

    <!-- 自由输入放在滚动区外面：避免聚焦描边被滚动容器裁掉 -->
    <input
      v-if="current"
      v-model="others[page]"
      class="ask-other"
      :placeholder="current.options?.length ? '其他补充（可选，会一起提交）' : '输入你的回答'"
      @keyup.enter="isLast ? submit() : nextPage()"
    />

    <footer class="ask-foot">
      <span class="ask-hint">答完会自动继续；跳过或关闭 = 让 AI 按已知信息自己决定。</span>
      <div class="ask-foot-actions">
        <button type="button" class="btn small" @click="skip">跳过</button>
        <button v-if="!isLast" type="button" class="btn small btn-primary" @click="nextPage">下一步</button>
        <button v-else type="button" class="btn small btn-primary" :disabled="!ready" @click="submit">提交</button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
/* 输入框上方的白色圆角卡片：不铺满整条、不遮挡聊天文字，四周留白 + 柔阴影 */
.ask-sheet {
  flex: none;
  width: min(720px, calc(100% - var(--space-20)));
  margin: 0 auto var(--space-10);
  padding: var(--space-12) var(--space-14);
  border: 1px solid rgba(224, 188, 125, 0.4);
  border-radius: var(--r-lg);
  background: #fff;
  box-shadow: 0 10px 30px rgba(90, 58, 74, 0.14);
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  animation: ask-sheet-up 0.2s ease-out;
}
@keyframes ask-sheet-up {
  from {
    transform: translateY(10px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
.ask-head {
  display: flex;
  align-items: center;
  gap: var(--space-8);
}
.ask-title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.ask-pager {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
}
.ask-pager button {
  width: 24px;
  height: 24px;
  border-radius: var(--r-full);
  border: 1px solid var(--glass-border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  line-height: 1;
}
.ask-pager button:disabled {
  opacity: 0.35;
  cursor: default;
}
.ask-close {
  width: 26px;
  height: 26px;
  border-radius: var(--r-full);
  border: none;
  background: transparent;
  color: var(--text-muted, #7a6a55);
  cursor: pointer;
  line-height: 1;
}
.ask-close:hover {
  background: rgba(90, 58, 74, 0.08);
  color: var(--text-primary);
}
.ask-session {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  background: var(--glass-bg);
  border-radius: var(--r-sm);
  padding: var(--space-6) var(--space-10);
}
.ask-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  max-height: 34vh;
  overflow-y: auto;
  overflow-x: hidden;
  /* 留一点内边距，聚焦描边/圆角不会被滚动容器裁掉 */
  padding: 2px;
}
.ask-other {
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-8) var(--space-10);
  border: 1px solid rgba(224, 188, 125, 0.5);
  border-radius: var(--r-sm);
  background: #fff;
  color: var(--text-primary);
  font-size: var(--fs-sm);
  font-family: inherit;
}
.ask-other:focus {
  outline: none;
  border-color: rgba(255, 180, 84, 0.75);
  box-shadow: 0 0 0 3px rgba(255, 180, 84, 0.18);
}
.ask-heading {
  display: flex;
  align-items: center;
  gap: var(--space-6);
}
.ask-tag {
  font-size: var(--fs-2xs);
  padding: 1px var(--space-8);
  border-radius: var(--r-pill);
  background: rgba(255, 209, 102, 0.32);
  color: var(--text-on-orange);
}
.ask-multi {
  font-size: var(--fs-2xs);
  color: var(--text-muted, #7a6a55);
}
.ask-q {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-primary);
  line-height: 1.5;
}
.ask-opts {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.ask-opt {
  display: flex;
  align-items: flex-start;
  gap: var(--space-10);
  padding: var(--space-8) var(--space-10);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur-base), background var(--dur-base);
}
.ask-opt:hover {
  border-color: var(--accent-orange);
  color: var(--text-primary);
}
.ask-opt.on {
  border-color: var(--accent-orange);
  background: rgba(255, 180, 84, 0.22);
  color: var(--text-primary);
}
.ask-idx {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: var(--r-full);
  background: rgba(255, 180, 84, 0.28);
  color: var(--text-on-orange, #7a4a00);
  font-size: var(--fs-2xs);
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ask-opt-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ask-opt-text b {
  font-size: var(--fs-sm);
  font-weight: 600;
}
.ask-opt-text small {
  font-size: var(--fs-2xs);
  color: var(--text-muted, #7a6a55);
  line-height: 1.4;
}
.ask-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-12);
  flex-wrap: wrap;
}
.ask-hint {
  flex: 1;
  min-width: 200px;
  font-size: var(--fs-2xs);
  color: var(--text-muted, #7a6a55);
  line-height: 1.5;
}
.ask-foot-actions {
  display: flex;
  gap: var(--space-8);
  margin-left: auto;
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
}
.btn.small.btn-primary {
  background: linear-gradient(135deg, var(--accent-orange), var(--accent-pink));
  color: #fff;
}
.btn.small:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>