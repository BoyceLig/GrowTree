<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';
import GlassCard from '@/components/GlassCard.vue';
import Modal from '@/components/Modal.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';

/**
 * 树洞信箱（家长 ⇄ 孩子互相留言）。
 *
 * 两端首页共用同一个组件，差别只有一处：家长要「选发给谁」。
 * 所以这里不接收任何 props —— 角色从登录态取，家长端的多孩子选择内建。
 * props 化反而会让两个页面各自维护一份「当前选了哪个孩子」，
 * 一旦两边不一致（切了孩子没切会话）就会把留言发错人。
 */

interface MailThread {
  child_id: number;
  child_name: string;
  child_avatar: string | null;
  last_content: string | null;
  last_at: number | null;
  last_sender_role: 'parent' | 'child' | null;
  unread: number;
}

interface MailMessage {
  id: number;
  child_id: number;
  sender_id: number;
  sender_role: 'parent' | 'child';
  sender_name: string | null;
  content: string;
  created_at: number;
}

const auth = useAuthStore();
const toast = useToastStore();

const isParent = computed(() => auth.user?.role === 'parent');

const threads = ref<MailThread[]>([]);
const selectedId = ref<number | null>(null);

const boxOpen = ref(false);
const messages = ref<MailMessage[]>([]);
const loadingMsgs = ref(false);
const draft = ref('');
const sending = ref(false);
const listEl = ref<HTMLElement | null>(null);

const unreadTotal = computed(() => threads.value.reduce((s, t) => s + t.unread, 0));
const current = computed(() => threads.value.find((t) => t.child_id === selectedId.value) ?? null);

const canSend = computed(() => !!draft.value.trim() && !sending.value && selectedId.value !== null);

const dialogTitle = computed(() => {
  if (isParent.value) return current.value ? `和 ${current.value.child_name} 的树洞` : '树洞信箱';
  return '树洞信箱';
});

/** 卡片上的预览文案：把「谁说的」也带上，家长一眼就知道需不需要回 */
const previewText = computed(() => {
  const t = current.value;
  if (!t) return '还没有小朋友的账号';
  if (!t.last_at || !t.last_content) return '还没有留言，放句悄悄话进来吧～';
  // 孩子看到的是"我："（自己上次说的），家长看到的是孩子的名字 —— 两端视角不同
  const who =
    t.last_sender_role === 'child' ? (isParent.value ? t.child_name : '我') : '爸爸妈妈';
  return `${who}：${t.last_content}`;
});

const previewTime = computed(() => (current.value?.last_at ? fmtRelative(current.value.last_at) : ''));

async function loadThreads() {
  try {
    const res = await api.get<{ threads: MailThread[] }>('/mailbox/threads');
    threads.value = res.threads;
    // 首次进来默认选中第一个孩子；已选中的孩子被删掉时也要收回一个有效值，
    // 否则家长会停在一个"对话不存在"的空卡片上，还发不出消息
    if (!threads.value.some((t) => t.child_id === selectedId.value)) {
      selectedId.value = threads.value[0]?.child_id ?? null;
    }
  } catch {
    /* 首页卡片读不到就保持原样，不打扰家长 */
  }
}

function selectChild(id: number) {
  selectedId.value = id;
  // 已经开着会话窗时切孩子，直接换到新会话，不用关掉再点开
  if (boxOpen.value) loadMessages(true);
}

async function open() {
  if (selectedId.value === null) return;
  boxOpen.value = true;
  await loadMessages();
}

/** markRead 默认 true —— 读接口会把对方发来的消息标成已读，读完要顺手刷一次角标 */
async function loadMessages(silent = false) {
  const id = selectedId.value;
  if (id === null) return;
  if (!silent) loadingMsgs.value = true;
  try {
    const res = await api.get<{ messages: MailMessage[] }>(`/mailbox/messages?child_id=${id}&limit=200`);
    // 切孩子的请求可能后回来，落地前先确认选中的还是同一个会话
    if (selectedId.value !== id) return;
    messages.value = res.messages;
    await scrollToBottom();
    await loadThreads(); // 已读标记已在服务端落库，刷新后角标才会消失
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
  if (!canSend.value || selectedId.value === null) return;
  const text = draft.value.trim();
  sending.value = true;
  try {
    await api.post('/mailbox/messages', { child_id: selectedId.value, content: text });
    draft.value = '';
    await loadMessages(true);
  } catch (e: any) {
    toast.error(e.message || '发送失败');
  } finally {
    sending.value = false;
  }
}

function mine(m: MailMessage): boolean {
  return m.sender_id === auth.user?.id;
}

// ── 实时：对方留言后卡片与会话窗都要立刻更新 ──────────────────────────────
async function onMailboxPush() {
  await loadThreads();
  if (boxOpen.value) await loadMessages(true);
  // 窗口没开时不主动标已读：那样角标就没意义了 —— 只是刷新线程里的未读数
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
  window.addEventListener('ws:mailbox_message', onMailboxPush);
});
onUnmounted(() => {
  window.removeEventListener('ws:mailbox_message', onMailboxPush);
});
</script>

<template>
  <GlassCard class="th-card" padding="16px 18px">
    <div class="th-top">
      <div class="th-emoji" aria-hidden="true">🌳</div>
      <div class="th-head">
        <div class="th-title">
          树洞信箱
          <span v-if="unreadTotal > 0" class="th-badge" :aria-label="`${unreadTotal} 条未读`">{{ unreadTotal }}</span>
        </div>
        <div class="th-sub">
          {{ isParent ? '和孩子说句悄悄话，孩子打开就能看见' : '想跟爸爸妈妈说的话，都可以放进来～' }}
        </div>
      </div>
    </div>

    <!-- 家长：选发给哪个孩子。只有一个孩子时不铺一排 chip，直接显示名字 -->
    <div v-if="isParent && threads.length" class="th-kids">
      <template v-if="threads.length > 1">
        <button
          v-for="t in threads"
          :key="t.child_id"
          type="button"
          :class="['kid-chip', { active: t.child_id === selectedId }]"
          @click="selectChild(t.child_id)"
        >
          <ZodiacAvatar :zodiac="t.child_avatar || ''" :size="22" />
          <span class="kid-name">{{ t.child_name }}</span>
          <span v-if="t.unread > 0" class="kid-dot">{{ t.unread }}</span>
        </button>
      </template>
      <div v-else class="kid-single">
        <ZodiacAvatar :zodiac="threads[0].child_avatar || ''" :size="22" />
        <span class="kid-name">{{ threads[0].child_name }}</span>
        <span v-if="threads[0].unread > 0" class="kid-dot">{{ threads[0].unread }}</span>
      </div>
    </div>

    <div v-if="current" class="th-preview" @click="open">
      <div class="pv-line">{{ previewText }}</div>
      <div v-if="previewTime" class="pv-time">{{ previewTime }}</div>
    </div>
    <div v-else class="th-preview empty">还没有小朋友的账号</div>

    <button class="btn btn-primary th-btn" type="button" :disabled="!current" @click="open">
      {{ current?.last_at ? '打开信箱' : '写第一条留言' }}
    </button>
  </GlassCard>

  <Modal
    v-model="boxOpen"
    :title="dialogTitle"
    :variant="isParent ? 'default' : 'playful'"
    width="460px"
  >
    <div class="chat">
      <div ref="listEl" class="chat-list">
        <p v-if="loadingMsgs && !messages.length" class="chat-tip">加载中…</p>
        <p v-else-if="!messages.length" class="chat-tip">
          {{ isParent ? '还没聊过，写第一句话吧～' : '还没有留言，说点什么吧～' }}
        </p>
        <div
          v-for="m in messages"
          :key="m.id"
          :class="['bubble-row', mine(m) ? 'mine' : 'theirs']"
        >
          <div class="bubble">
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
          :placeholder="isParent ? `想对 ${current?.child_name ?? '孩子'} 说的话…` : '想对爸爸妈妈说的话…'"
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
.th-card {
  margin-bottom: var(--space-20);
  border: 1px solid var(--glass-border);
}

.th-top { display: flex; align-items: center; gap: var(--space-12); }
.th-emoji { font-size: var(--fs-4xl); flex-shrink: 0; }
.th-head { flex: 1; min-width: 0; }
.th-title {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  font-family: var(--font-cute);
  font-size: var(--fs-lg);
}
.th-badge {
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
.th-sub { font-size: var(--fs-xs); color: var(--text-muted); margin-top: var(--space-2); line-height: 1.5; }

.th-kids {
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
.kid-chip.active { border-color: var(--accent-yellow); background: rgba(255, 209, 102, 0.2); }
.kid-name { font-family: var(--font-cute); white-space: nowrap; }
/* 未读小圆点：卡片整体的角标在标题上，这里标到具体是哪个孩子 */
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

.th-preview {
  margin-top: var(--space-12);
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px dashed var(--glass-border);
  cursor: pointer;
  transition: background var(--dur-fast);
}
.th-preview:hover { background: var(--glass-bg-strong); }
.th-preview.empty { cursor: default; color: var(--text-muted); font-size: var(--fs-sm); }
.th-preview.empty:hover { background: var(--glass-bg); }
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

.th-btn { width: 100%; margin-top: var(--space-12); }

/* ── 会话窗 ───────────────────────────────────────────────────────────── */
.chat { display: flex; flex-direction: column; gap: var(--space-12); }

.chat-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
  /* 用 dvh 而不是 vh：移动端地址栏占位时 100vh 偏大，会把输入框顶出屏幕 */
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
/* 自己的留言用主色气泡，一眼分得清谁说的 */
.bubble-row.mine .bubble {
  background: rgba(255, 209, 102, 0.32);
  border-color: rgba(255, 180, 84, 0.4);
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
.ci-text:focus { outline: 2px solid var(--accent-yellow); outline-offset: 1px; }

.ci-foot { display: flex; align-items: center; gap: var(--space-8); }
.ci-count, .ci-tip { font-size: var(--fs-xs); color: var(--text-muted); }
.ci-foot .ci-tip { margin-left: auto; }
.ci-btn { padding: var(--space-8) var(--space-20); }
</style>
