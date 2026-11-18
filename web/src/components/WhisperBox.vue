<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';
import GlassCard from '@/components/GlassCard.vue';
import Modal from '@/components/Modal.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';

/**
 * 悄悄话（家长 ⇄ 孩子 的一对一私密会话）。
 *
 * 每个家长和每个孩子各有一条独立会话，只有这两个人能看；
 * 家里其他家长看不到列表、也读不到消息。
 * 和树洞信箱（家庭群聊）是两套独立数据，互不影响。
 */

interface WhisperThread {
  peer_id: number;
  peer_name: string;
  peer_avatar: string | null;
  peer_identity: string;
  child_id: number;
  parent_id: number;
  last_content: string | null;
  last_at: number | null;
  last_sender_role: 'parent' | 'child' | null;
  last_sender_name: string | null;
  last_sender_identity: string | null;
  unread: number;
}

interface WhisperMessage {
  id: number;
  child_id: number;
  parent_id: number;
  sender_id: number;
  sender_role: 'parent' | 'child';
  sender_name: string | null;
  sender_identity: string | null;
  content: string;
  created_at: number;
}

const auth = useAuthStore();
const toast = useToastStore();

const isParent = computed(() => auth.user?.role === 'parent');

const threads = ref<WhisperThread[]>([]);
const selectedChildId = ref<number | null>(null);
const active = ref<WhisperThread | null>(null);

const boxOpen = ref(false);
const messages = ref<WhisperMessage[]>([]);
const loadingMsgs = ref(false);
const draft = ref('');
const sending = ref(false);
const listEl = ref<HTMLElement | null>(null);

const current = computed(
  () => threads.value.find((t) => t.child_id === selectedChildId.value) ?? threads.value[0] ?? null
);
const unreadTotal = computed(() => threads.value.reduce((s, t) => s + t.unread, 0));

const dialogTitle = computed(() => (active.value ? `和 ${active.value.peer_name} 的悄悄话` : '悄悄话'));

const canSend = computed(() => !!draft.value.trim() && !sending.value && !!active.value);

function threadKey(t: WhisperThread): string {
  return `${t.child_id}:${t.parent_id}`;
}

/** 家长端窗口里显示「昵称（身份）」，昵称和身份相同时不重复 */
function peerLabel(t: WhisperThread): string {
  return t.peer_name === t.peer_identity ? t.peer_name : `${t.peer_name}（${t.peer_identity}）`;
}

/** 预览文案同样标出发送人 */
function previewFor(t: WhisperThread): string {
  if (!t.last_at || !t.last_content) return '还没有悄悄话，说第一句吧～';
  const identity = t.last_sender_identity || (t.last_sender_role === 'child' ? '孩子' : '家长');
  const who = `${t.last_sender_name || '未知'}（${identity}）`;
  return `${who}：${t.last_content}`;
}

function senderLabel(m: WhisperMessage): string {
  const identity = m.sender_identity || (m.sender_role === 'child' ? '孩子' : '家长');
  return `${m.sender_name || '未知'}（${identity}）`;
}

async function loadThreads() {
  try {
    const res = await api.get<{ threads: WhisperThread[] }>('/whispers/threads');
    threads.value = res.threads;
    if (!threads.value.some((t) => t.child_id === selectedChildId.value)) {
      selectedChildId.value = threads.value[0]?.child_id ?? null;
    }
    // 刷新后把弹窗指向新对象，避免一直拿着旧引用
    if (active.value) {
      const key = threadKey(active.value);
      active.value = threads.value.find((t) => threadKey(t) === key) ?? null;
      if (!active.value) boxOpen.value = false;
    }
  } catch {
    /* 首页卡片读不到就保持原样，不打扰用户 */
  }
}

function selectChild(id: number) {
  selectedChildId.value = id;
}

async function open(t: WhisperThread | null) {
  if (!t) return;
  active.value = t;
  boxOpen.value = true;
  await loadMessages();
}

async function loadMessages(silent = false) {
  const t = active.value;
  if (!t) return;
  if (!silent) loadingMsgs.value = true;
  try {
    const res = await api.get<{ messages: WhisperMessage[] }>(
      `/whispers/messages?child_id=${t.child_id}&parent_id=${t.parent_id}&limit=200`
    );
    if (!active.value || threadKey(active.value) !== threadKey(t)) return;
    messages.value = res.messages;
    await scrollToBottom();
    await loadThreads();
  } catch {
    /* 静默失败：保持原有消息列表 */
  } finally {
    if (!silent) loadingMsgs.value = false;
  }
}

async function scrollToBottom() {
  await nextTick();
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function send() {
  const t = active.value;
  if (!canSend.value || !t) return;
  const text = draft.value.trim();
  sending.value = true;
  try {
    await api.post('/whispers/messages', {
      child_id: t.child_id,
      parent_id: t.parent_id,
      content: text,
    });
    draft.value = '';
    await loadMessages(true);
  } catch (e: any) {
    toast.error(e.message || '发送失败');
  } finally {
    sending.value = false;
  }
}

function mine(m: WhisperMessage): boolean {
  return m.sender_id === auth.user?.id;
}

async function onWhisperPush() {
  await loadThreads();
  if (boxOpen.value && active.value) await loadMessages(true);
}

function fmtRelative(ts: number): string {
  const d = new Date(ts * 1000);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtMsgTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

onMounted(() => {
  loadThreads();
  window.addEventListener('ws:whisper_message', onWhisperPush);
});
onUnmounted(() => {
  window.removeEventListener('ws:whisper_message', onWhisperPush);
});
</script>

<template>
  <!-- 家长端：一张入口卡，先选孩子，再打开只有你们俩的会话 -->
  <GlassCard v-if="isParent" class="wh-card" padding="16px 18px">
    <div class="wh-head">
      <div class="wh-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-4.2A7.5 7.5 0 0 1 4 11.5 7.5 7.5 0 0 1 11.5 4h1A7.5 7.5 0 0 1 20 11.5Z" />
          <path d="M12 14.2s-2.6-1.5-2.6-3.2a1.6 1.6 0 0 1 2.6-1.2 1.6 1.6 0 0 1 2.6 1.2c0 1.7-2.6 3.2-2.6 3.2Z" />
        </svg>
      </div>
      <div class="wh-head-text">
        <div class="wh-title">
          悄悄话
          <span v-if="unreadTotal > 0" class="wh-badge" :aria-label="`${unreadTotal} 条未读悄悄话`">{{ unreadTotal }}</span>
        </div>
        <div class="wh-sub">只在你和孩子之间可见，其他家长看不到</div>
      </div>
    </div>

    <div v-if="threads.length" class="wh-kids">
      <template v-if="threads.length > 1">
        <button
          v-for="t in threads"
          :key="t.child_id"
          type="button"
          :class="['kid-chip', { active: t.child_id === selectedChildId }]"
          @click="selectChild(t.child_id)"
        >
          <ZodiacAvatar :zodiac="t.peer_avatar || ''" :size="22" />
          <span class="kid-name">{{ t.peer_name }}</span>
          <span v-if="t.unread > 0" class="kid-dot">{{ t.unread }}</span>
        </button>
      </template>
      <div v-else class="kid-single">
        <ZodiacAvatar :zodiac="threads[0].peer_avatar || ''" :size="22" />
        <span class="kid-name">{{ threads[0].peer_name }}</span>
        <span v-if="threads[0].unread > 0" class="kid-dot">{{ threads[0].unread }}</span>
      </div>
    </div>

    <div v-if="current" class="wh-preview">
      <div class="pv-line">{{ previewFor(current) }}</div>
      <div v-if="current.last_at" class="pv-time">{{ fmtRelative(current.last_at) }}</div>
    </div>
    <div v-else class="wh-preview empty">还没有小朋友的账号</div>

    <button class="btn btn-primary wh-btn" type="button" :disabled="!current" @click="open(current)">
      {{ current?.last_at ? '打开悄悄话' : '说第一句悄悄话' }}
    </button>
  </GlassCard>

  <!-- 孩子端：每个家长一个独立窗口，可以分别打开私聊 -->
  <section v-else class="wh-windows" aria-label="悄悄话">
    <GlassCard
      v-for="t in threads"
      :key="threadKey(t)"
      class="wh-window"
      padding="14px 16px"
    >
      <div class="ww-top">
        <ZodiacAvatar :zodiac="t.peer_avatar || ''" :size="38" />
        <div class="ww-info">
          <div class="ww-name">{{ peerLabel(t) }}</div>
          <div class="ww-sub">只在你和 {{ t.peer_name }} 之间可见</div>
        </div>
        <span v-if="t.unread > 0" class="wh-badge" :aria-label="`${t.unread} 条未读`">{{ t.unread }}</span>
      </div>
      <div class="ww-preview">{{ previewFor(t) }}</div>
      <button class="ww-open" type="button" @click="open(t)">
        {{ t.last_at ? '打开悄悄话' : '说第一句悄悄话' }}
      </button>
    </GlassCard>
    <GlassCard v-if="!threads.length" class="wh-window wh-window-empty" padding="14px 16px">
      <div class="ww-sub">还没有家长账号</div>
    </GlassCard>
  </section>

  <Modal v-model="boxOpen" :title="dialogTitle" width="460px">
    <div class="chat">
      <div class="wh-privacy">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.6" />
          <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
        </svg>
        仅你们两人可见，其他家长看不到
      </div>

      <div ref="listEl" class="chat-list">
        <p v-if="loadingMsgs && !messages.length" class="chat-tip">加载中…</p>
        <p v-else-if="!messages.length" class="chat-tip">还没有悄悄话，说第一句吧～</p>
        <div
          v-for="m in messages"
          :key="m.id"
          :class="['bubble-row', mine(m) ? 'mine' : 'theirs']"
        >
          <div class="bubble">
            <div class="bubble-sender">{{ senderLabel(m) }}</div>
            <div class="bubble-text">{{ m.content }}</div>
            <div class="bubble-time">{{ fmtMsgTime(m.created_at) }}</div>
          </div>
        </div>
      </div>

      <form class="chat-input" @submit.prevent="send">
        <textarea
          v-model="draft"
          class="ci-text"
          rows="2"
          maxlength="500"
          :placeholder="active ? `想对 ${active.peer_name} 说的悄悄话…` : '想说点什么呢…'"
          @keydown.enter.exact.prevent="send"
        ></textarea>
        <div class="ci-foot">
          <span class="ci-count">{{ draft.length }} / 500</span>
          <span class="ci-tip">回车发送</span>
          <button class="btn btn-primary ci-btn" type="submit" :disabled="!canSend">
            {{ sending ? '发送中' : '发送' }}
          </button>
        </div>
      </form>
    </div>
  </Modal>
</template>

<style scoped>
.wh-card {
  margin-bottom: var(--space-20);
  border: 1px solid rgba(255, 155, 176, 0.34);
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.72), rgba(255, 241, 245, 0.62));
}

.wh-head { display: flex; align-items: center; gap: var(--space-12); }
.wh-icon {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-full);
  color: #e0718f;
  background: rgba(255, 155, 176, 0.18);
  border: 1px solid rgba(255, 155, 176, 0.3);
}
.wh-icon svg { width: 22px; height: 22px; }
.wh-head-text { flex: 1; min-width: 0; }
.wh-title {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  font-family: var(--font-cute);
  font-size: var(--fs-lg);
}
.wh-sub { font-size: var(--fs-xs); color: var(--text-muted); margin-top: var(--space-2); line-height: 1.5; }

.wh-badge {
  min-width: 20px;
  height: 20px;
  padding: 0 var(--space-6);
  border-radius: var(--r-pill);
  background: var(--danger);
  color: #fff;
  font-size: var(--fs-xs);
  font-family: var(--font-body);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.wh-kids {
  display: flex;
  gap: var(--space-8);
  overflow-x: auto;
  margin-top: var(--space-12);
  padding-bottom: var(--space-2);
}
.kid-chip, .kid-single {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  padding: var(--space-6) var(--space-12);
  border-radius: var(--r-pill);
  background: var(--glass-bg);
  border: 2px solid transparent;
  font-size: var(--fs-sm);
  flex-shrink: 0;
  transition: all var(--dur-fast);
}
.kid-chip { cursor: pointer; }
.kid-chip:hover { border-color: rgba(255, 155, 176, 0.5); }
.kid-chip.active { border-color: var(--accent-pink); background: rgba(255, 155, 176, 0.18); }
.kid-name { font-family: var(--font-cute); white-space: nowrap; }
.kid-dot {
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-4);
  border-radius: var(--r-pill);
  background: var(--danger);
  color: #fff;
  font-size: var(--fs-xs);
  font-family: var(--font-body);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.wh-preview {
  margin-top: var(--space-12);
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px dashed rgba(255, 155, 176, 0.42);
}
.wh-preview.empty { color: var(--text-muted); font-size: var(--fs-sm); }
.pv-line {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.pv-time { font-size: var(--fs-xs); color: var(--text-muted); margin-top: var(--space-4); }

.wh-btn { width: 100%; margin-top: var(--space-12); }

/* 孩子端的多个悄悄话窗口：按可用宽度横向铺开，放满自动换行 */
.wh-windows {
  display: grid;
  /* 190px 是「能放下头像 + 昵称 + 两行预览 + 按钮」的最小宽度：
     1100px 宽时 5 列，900px 时 4 列，693px 时 3 列，不会退化成一条长列表 */
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: var(--space-10);
  margin-bottom: var(--space-20);
}
.wh-window {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid rgba(255, 155, 176, 0.32);
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.72), rgba(255, 241, 245, 0.58));
  transition: transform var(--dur-fast), box-shadow var(--dur-fast), border-color var(--dur-fast);
}
.wh-window:hover {
  transform: translateY(-1px);
  border-color: rgba(255, 155, 176, 0.52);
  box-shadow: 0 8px 20px rgba(180, 90, 118, 0.12);
}
.wh-window-empty { grid-column: 1 / -1; }

.ww-top { display: flex; align-items: center; gap: var(--space-8); min-width: 0; }
.ww-info { flex: 1; min-width: 0; }
.ww-name {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ww-sub {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ww-preview {
  flex: 1;
  margin-top: var(--space-8);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.55;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ww-open {
  width: 100%;
  margin-top: var(--space-10);
  padding: var(--space-6) var(--space-10);
  border-radius: var(--r-pill);
  border: 1px solid rgba(255, 155, 176, 0.4);
  background: rgba(255, 155, 176, 0.12);
  color: #c25574;
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: background var(--dur-fast), border-color var(--dur-fast), transform var(--dur-fast);
}
.ww-open:hover { background: rgba(255, 155, 176, 0.2); border-color: var(--accent-pink); }
.ww-open:active { transform: scale(0.99); }
.ww-open:focus-visible { outline: 2px solid var(--accent-pink); outline-offset: 1px; }

/* 手机上与上方内容同宽时两列并排，避免家长一多就拉出一条长列表 */
@media (max-width: 520px) {
  .wh-windows { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* ── 会话窗 ───────────────────────────────────────────────────────────── */
.chat { display: flex; flex-direction: column; gap: var(--space-12); }
.wh-privacy {
  display: inline-flex;
  align-items: center;
  gap: var(--space-6);
  align-self: flex-start;
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-pill);
  background: rgba(255, 155, 176, 0.14);
  color: #b45a76;
  font-size: var(--fs-xs);
}
.wh-privacy svg { width: 14px; height: 14px; }

.chat-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
  max-height: 46vh;
  max-height: 46dvh;
  min-height: 160px;
  overflow-y: auto;
  padding: var(--space-4);
  scrollbar-width: thin;
}
.chat-tip {
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-sm);
  padding: var(--space-24) 0;
}

.bubble-row { display: flex; }
.bubble-row.mine { justify-content: flex-end; }
.bubble-row.theirs { justify-content: flex-start; }
.bubble {
  max-width: 78%;
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-lg);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
}
.bubble-row.mine .bubble {
  background: rgba(255, 155, 176, 0.22);
  border-color: rgba(255, 155, 176, 0.45);
}
.bubble-sender {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-bottom: var(--space-2);
}
.bubble-text {
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble-time {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-top: var(--space-4);
  text-align: right;
}

.chat-input { display: flex; flex-direction: column; gap: var(--space-6); }
.ci-text {
  width: 100%;
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  border: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.6);
  font-family: inherit;
  font-size: var(--fs-sm);
  line-height: 1.6;
  resize: vertical;
  color: var(--text-primary);
}
.ci-text:focus { outline: 2px solid var(--accent-pink); outline-offset: 1px; }

.ci-foot { display: flex; align-items: center; gap: var(--space-8); }
.ci-count, .ci-tip { font-size: var(--fs-xs); color: var(--text-muted); }
.ci-foot .ci-tip { margin-left: auto; }
.ci-btn { padding: var(--space-8) var(--space-20); }
</style>
