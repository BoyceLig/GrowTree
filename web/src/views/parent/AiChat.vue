<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted, computed } from 'vue';
import { api, uploadFile } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import { useAuthStore } from '@/stores/auth';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import AiAskQuestionPanel from '@/components/AiAskQuestionPanel.vue';
import { useWsStore } from '@/stores/ws';

/**
 * 家长端 AI 对话页。
 *
 * 布局：左侧会话栏（铺开显示、右键/⋯ 菜单支持重命名与删除）+ 右侧对话区。
 * 数据流：HTTP 只负责「发消息」与「拉历史」；回复通过 WS 事件流回来
 * （stores/ws.ts 派发 ws:ai_chat_* 全家桶），这里按 sessionId 过滤后渲染。
 * done/error 事件到达后整段重拉消息 —— 服务端在 agent 循环里落库的是
 * 拼装好的多轮（assistant/tool）记录，本地拼不如重拉可靠。
 *
 * 确认卡：内置工具与部分 MCP 工具的写操作不会直接执行，服务端先落
 * 「待确认动作」并把 token 推过来（ai_chat_confirm），家长点确认才写库。
 */

type Session = { id: number; title: string; updated_at: number };
type Attachment = { kind: 'image' | 'file'; url: string; name: string; mime: string; size: number; extracted?: string };
type Msg = {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  attachments: Attachment[] | null;
  meta: {
    toolName?: string;
    toolArgs?: string;
    reasoning?: string;
    toolCalls?: { id: string; name: string; argumentsJson: string }[];
    confirm?: { token: string; summary: string; detail: string };
    guidance?: boolean;
  } | null;
  created_at: number;
};
type ConfirmCard = { token: string; summary: string; detail: string };
/** Ask Question 面板：AI 追问 / 让家长选择时的问题结构（与组件保持一致） */
type AskQuestion = {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multi?: boolean;
};

const toast = useToastStore();
const auth = useAuthStore();
const wsStore = useWsStore();

/* ── 会话侧栏 ──────────────────────────────────────────────────────────── */

const sessions = ref<Session[]>([]);
const activeSessionId = ref<number | null>(null);
/** 右键/⋯ 菜单：锚定会话 + 屏幕坐标 */
const sessionMenu = ref<{ id: number; x: number; y: number } | null>(null);
/** 行内重命名：正在改名的会话 id + 输入框内容 */
const renameId = ref<number | null>(null);
const renameValue = ref('');
const deleteOpen = ref(false);
/** 待删除的会话 id（显式指定，避免依赖 activeSessionId 的竞态） */
const deleteTargetId = ref<number | null>(null);

function fmtSessionTime(unix: number): string {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function openSessionMenu(e: MouseEvent, id: number): void {
  // 视口内夹取，避免菜单溢出屏幕
  const x = Math.min(e.clientX, window.innerWidth - 150);
  const y = Math.min(e.clientY, window.innerHeight - 110);
  sessionMenu.value = { id, x, y };
}

function openSessionMenuById(id: number, ev: Event): void {
  const btn = ev.target as HTMLElement;
  const rect = btn.getBoundingClientRect();
  openSessionMenu({ clientX: rect.left, clientY: rect.bottom + 4 } as MouseEvent, id);
}

const safetyOptions: { mode: 'alwaysAsk' | 'onDemand' | 'allowAll'; title: string; desc: string }[] = [
  { mode: 'alwaysAsk', title: '始终询问', desc: '每次执行写操作前都要家长确认' },
  { mode: 'onDemand', title: '按需确认', desc: '只针对有风险的操作（外部 MCP、写入技能文件）进行询问' },
  { mode: 'allowAll', title: '全部允许', desc: '不再询问，AI 直接执行写操作并全部记入审计' },
];

const safetyLabel = computed(() => {
  const cur = safetyOptions.find((o) => o.mode === safety.value);
  return cur ? cur.title : '安全策略';
});

function openSafetyMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const x = Math.min(rect.left, window.innerWidth - 290);
  const y = window.innerHeight - rect.top + 6; // 用 bottom 锚定：菜单从按钮上方往上长，不会被页面底部裁掉
  safetyMenu.value = { x, bottom: y };
}

function closeSafetyMenu(): void {
  safetyMenu.value = null;
}

async function pickSafety(mode: 'alwaysAsk' | 'onDemand' | 'allowAll'): Promise<void> {
  closeSafetyMenu();
  if (!auth.user?.isPrimary) {
    toast.warning('安全策略仅主家长可修改');
    return;
  }
  try {
    await api.put('/ai/config', { safety: mode });
    safety.value = mode;
    toast.success('安全策略已更新');
  } catch (err) {
    toast.warning((err as Error).message || '修改失败');
  }
}
function closeSessionMenu(): void {
  sessionMenu.value = null;
}

function startRename(id: number): void {
  const s = sessions.value.find((x) => x.id === id);
  if (!s) return;
  renameId.value = id;
  renameValue.value = s.title;
  closeSessionMenu();
  nextTick(() => {
    (document.getElementById(`rename-input-${id}`) as HTMLInputElement | null)?.focus();
  });
}

async function saveRename(id: number): Promise<void> {
  const title = renameValue.value.trim();
  renameId.value = null;
  if (!title) return;
  try {
    await api.put(`/ai/sessions/${id}`, { title });
    const s = sessions.value.find((x) => x.id === id);
    if (s) s.title = title;
  } catch (err) {
    toast.warning((err as Error).message || '重命名失败');
  }
}

/* ── 消息与流式 ────────────────────────────────────────────────────────── */

const messages = ref<Msg[]>([]);
const loadingMessages = ref(false);
const inputText = ref('');
const composing = ref(false); // 中文输入法选词中的 Enter 不能当发送
const sending = ref(false);
const streamingText = ref('');
/** 本回合已执行/正在执行的工具步骤（含参数与结果，界面上完整可见） */
const streamingTools = ref<{ tool: string; summary: string; args?: string; result?: string }[]>([]);
/** 本回合模型的思考增量（支持 reasoning_content 的供应商才有） */
const liveReasoning = ref('');
/** 模型自己列的步骤计划（update_plan 维护），全程保留，不被后续工具覆盖 */
const plan = ref<PlanStep[]>([]);
const planDone = computed(() => plan.value.filter((s) => s.status === 'done').length);
/* 回合状态提示：思考中 / 正在回答 / 正在执行工具，带计时，避免长时间静默像卡死 */
const waitPhase = ref<'idle' | 'thinking' | 'writing' | 'tool'>('idle');
const waitTool = ref('');
const waitSeconds = ref(0);
let waitTimer: number | null = null;

function startWaitClock(startedAt?: number): void {
  waitPhase.value = 'thinking';
  waitTool.value = '';
  waitSeconds.value = startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;
  if (waitTimer) window.clearInterval(waitTimer);
  waitTimer = window.setInterval(() => {
    waitSeconds.value += 0.1;
  }, 100);
}

function stopWaitClock(): void {
  if (waitTimer) {
    window.clearInterval(waitTimer);
    waitTimer = null;
  }
  waitPhase.value = 'idle';
  waitTool.value = '';
}
const confirms = ref<ConfirmCard[]>([]);
/** 计划步骤（与后端 update_plan 对齐） */
type PlanStep = { title: string; status: 'pending' | 'in_progress' | 'done' };
/** 回合状态（与后端 turnState 对齐） */
type TurnView = {
  sessionId: number;
  phase: 'thinking' | 'writing' | 'tool';
  tool?: string;
  startedAt?: number;
  steps?: string[];
  plan?: PlanStep[];
};
const ACTIVE_SESSION_KEY = 'manalong:ai-active-session';

/** 待回答的 Ask Question 队列：可能同时来自不同会话，面板一次显示最早的一个 */
type PendingAsk = { token: string; sessionId: number; sessionTitle?: string; questions: AskQuestion[]; expiresAt?: number };
const pendingAsks = ref<PendingAsk[]>([]);
const ask = computed(() => pendingAsks.value[0] ?? null);

/** 收到 WS 事件 / 接口拉取都走这里：同一个 token 只保留一份 */
function upsertAsk(item: PendingAsk): void {
  if (!item?.token) return;
  const i = pendingAsks.value.findIndex((x) => x.token === item.token);
  if (i >= 0) pendingAsks.value[i] = { ...pendingAsks.value[i], ...item };
  else pendingAsks.value = [...pendingAsks.value, item];
}

function removeAsk(token: string): void {
  pendingAsks.value = pendingAsks.value.filter((x) => x.token !== token);
}

/**
 * 以服务端为准同步待答问题：刷新页面、切走再回来、WS 重连、断网恢复都靠它补弹面板。
 * 服务端已经超时/被别人答掉的，会在这次同步里被移除。
 */
async function loadPendingQuestions(): Promise<void> {
  try {
    const data = await api.get<{ questions: PendingAsk[] }>('/ai/questions');
    pendingAsks.value = (data.questions ?? []).map((q) => ({
      ...q,
      sessionTitle:
        q.sessionTitle || sessions.value.find((s) => s.id === q.sessionId)?.title || '',
    }));
  } catch {
    /* 离线/未登录：保留本地已有的队列，等下次同步 */
  }
}
const attachments = ref<Attachment[]>([]);
/** 图片灯箱：点开对话里的图片放大看（只读，不提供下载） */
const previewImage = ref<{ url: string; name: string } | null>(null);
/** 灯箱缩放与平移：滚轮缩放、左键拖动，操作只作用在图片上 */
const lbScale = ref(1);
const lbX = ref(0);
const lbY = ref(0);
const lbDragging = ref(false);
const lbImgEl = ref<HTMLImageElement | null>(null);
/** 图片按屏幕适配后的基础尺寸；缩放时改 width/height 而不是 transform:scale，避免放大后发虚 */
const lbBase = ref({ w: 0, h: 0 });
let lbDragStart = { x: 0, y: 0, ox: 0, oy: 0 };
/** 排队中的消息（回合进行中发的）：服务端存库，切页面/刷新都还在 */
type QueueItem = {
  id: number;
  sessionId: number;
  content: string;
  attachments: Attachment[] | null;
  createdAt: number;
  sortOrder: number;
};
const queue = ref<QueueItem[]>([]);
const aiReady = ref(true);
const safety = ref<'alwaysAsk' | 'onDemand' | 'allowAll'>('onDemand');
const safetyMenu = ref<{ x: number; bottom: number } | null>(null);

/** 清空本回合的实时过程（工具步骤 + 思考）：切会话 / 新回合开始时调用 */
function resetLiveTools(): void {
  streamingTools.value = [];
  liveReasoning.value = '';
}

const msgsEl = ref<HTMLElement | null>(null);
const imgInput = ref<HTMLInputElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const composerEl = ref<HTMLElement | null>(null);
const textareaEl = ref<HTMLTextAreaElement | null>(null);

async function onVisibilityChange(): Promise<void> {
  if (document.visibilityState !== 'visible') return;
  await loadPendingQuestions();
  await syncTurnState();
}

/**
 * 与服务端的"回合状态"对齐：切走再回来时恢复「还在跑」的界面
 * （思考中 / 正在回答 / 正在执行工具 + 已运行秒数），不用发消息试探。
 */
async function syncTurnState(): Promise<void> {
  const sid = activeSessionId.value;
  if (sid == null) return;
  try {
    const data = await api.get<{ turns: TurnView[] }>('/ai/turn-state');
    const mine = data.turns.find((t) => t.sessionId === sid);
    if (!mine) {
      // 切走期间已经跑完了：收掉本地"进行中"的假状态并重拉消息
      if (sending.value) {
        sending.value = false;
        stopWaitClock();
        streamingText.value = '';
        streamingTools.value = [];
      liveReasoning.value = '';
        plan.value = [];
        await reloadMessages();
      }
      return;
    }
    if (!sending.value) {
      // 刚从别的页面回来：恢复进行中状态（文本增量靠后续 WS，结束后重拉补全）
      sending.value = true;
      streamingText.value = '';
      streamingTools.value = [];
      liveReasoning.value = '';
      plan.value = [];
      startWaitClock(mine.startedAt);
    }
    waitPhase.value = mine.phase === 'tool' ? 'tool' : mine.phase === 'writing' ? 'writing' : 'thinking';
    waitTool.value = mine.tool ?? '';
    // 恢复模型自己列的计划与已执行步骤（切页面/重连后仍在）
    plan.value = Array.isArray(mine.plan) ? mine.plan : [];
    const known = new Set(streamingTools.value.map((t) => t.tool));
    for (const step of mine.steps ?? []) {
      if (known.has(step)) continue;
      streamingTools.value.push({ tool: step, summary: '' });
      known.add(step);
    }
  } catch {
    /* 旧服务端没有该接口时忽略，退化为原来的行为 */
  }
}

/* ── 渲染 ──────────────────────────────────────────────────────────────── */

marked.setOptions({ async: false, gfm: true, breaks: true });

function renderMarkdown(text: string): string {
  const html = marked.parse(text) as string;
  return DOMPurify.sanitize(html);
}

/* ── 过程分组 ──────────────────────────────────────────────────────────── */

/**
 * 把「思考 / 工具调用 / 工具结果」按回合聚成一块过程，挂在最终回答上面。
 * 过程默认折叠（只显示「过程 · N 步」），点开能看到每一步传了什么、返回了什么；
 * 正在进行的回合则整块展开，像 Trae 那样边跑边看。
 */
type ProcStep = {
  type: 'reasoning' | 'note' | 'tool';
  text?: string;
  tool?: string;
  args?: string;
  result?: string;
  needsConfirm?: boolean;
};

type ChatItem =
  | { kind: 'user'; key: string; msg: Msg }
  | { kind: 'turn'; key: string; steps: ProcStep[]; final: string };

const chatItems = computed<ChatItem[]>(() => {
  const items: ChatItem[] = [];
  let cur: { key: string; steps: ProcStep[]; final: string } | null = null;
  const flush = () => {
    if (cur) items.push({ kind: 'turn', key: cur.key, steps: cur.steps, final: cur.final });
    cur = null;
  };

  for (const m of messages.value) {
    if (m.role === 'user') {
      flush();
      items.push({ kind: 'user', key: `u${m.id}`, msg: m });
      continue;
    }
    if (!cur) cur = { key: `t${m.id}`, steps: [], final: '' };
    const meta = m.meta;

    if (meta?.reasoning) cur.steps.push({ type: 'reasoning', text: meta.reasoning });

    if (m.role === 'assistant') {
      if (Array.isArray(meta?.toolCalls) && meta.toolCalls.length) {
        if (m.content) cur.steps.push({ type: 'note', text: m.content });
        for (const call of meta.toolCalls) {
          cur.steps.push({ type: 'tool', tool: call.name, args: call.argumentsJson ?? '', result: '', needsConfirm: false });
        }
      } else if (m.content) {
        cur.final = m.content;
      }
    } else if (m.role === 'tool') {
      // 结果按调用顺序回填到第一个还没结果的工具步骤上
      const target = cur.steps.find((s) => s.type === 'tool' && !s.result);
      if (target) {
        target.result = m.content;
        if (meta?.toolName) target.tool = meta.toolName;
        target.needsConfirm = Boolean(meta?.confirm);
      } else {
        cur.steps.push({
          type: 'tool',
          tool: meta?.toolName ?? '工具',
          args: meta?.toolArgs ?? '',
          result: m.content,
          needsConfirm: Boolean(meta?.confirm),
        });
      }
    }
  }
  flush();
  return items;
});

function fmtArgs(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 0);
  } catch {
    return text;
  }
}

function scrollBottom(): void {
  nextTick(() => {
    const el = msgsEl.value;
    if (el) {
      el.scrollTop = el.scrollHeight;
      scheduleActiveNav();
    }
  });
}

/* ── 右侧消息导航：小横线 + 悬浮消息列表 ──────────────────────────────── */

const msgNavOpen = ref(false);
const activeNavId = ref<number | null>(null);
let navCloseTimer: number | null = null;
let navScrollRaf = 0;

const userNavItems = computed(() =>
  messages.value
    .filter((m) => m.role === 'user')
    .map((m) => {
      const text = (m.content ?? '').replace(/\s+/g, ' ').trim();
      const attachment = m.attachments?.length
        ? m.attachments.some((a) => a.kind === 'image')
          ? '［图片］'
          : `［${m.attachments[0]?.name || '附件'}］`
        : '';
      return {
        id: m.id,
        text: `${m.meta?.guidance ? '引导 · ' : ''}${text || attachment || '（空消息）'}`,
      };
    })
);

/** 视口顶部附近的那条用户消息 = 当前定位点 */
function updateActiveNav(): void {
  const el = msgsEl.value;
  if (!el) return;
  const rows = el.querySelectorAll<HTMLElement>('[data-uid]');
  if (!rows.length) {
    activeNavId.value = null;
    return;
  }
  const threshold = el.getBoundingClientRect().top + 72;
  let current = Number(rows[0].dataset.uid);
  for (const row of rows) {
    if (row.getBoundingClientRect().top <= threshold) current = Number(row.dataset.uid);
    else break;
  }
  activeNavId.value = current;
}

function onMsgsScroll(): void {
  scheduleActiveNav();
}

/** 滚动/流式输出都会频繁触发，合并到一帧里算一次 */
function scheduleActiveNav(): void {
  if (navScrollRaf) return;
  navScrollRaf = requestAnimationFrame(() => {
    navScrollRaf = 0;
    updateActiveNav();
  });
}

function openMsgNav(): void {
  if (navCloseTimer) {
    window.clearTimeout(navCloseTimer);
    navCloseTimer = null;
  }
  if (!userNavItems.value.length) return;
  updateActiveNav();
  msgNavOpen.value = true;
}

function closeMsgNavSoon(): void {
  if (navCloseTimer) window.clearTimeout(navCloseTimer);
  navCloseTimer = window.setTimeout(() => {
    msgNavOpen.value = false;
    navCloseTimer = null;
  }, 160);
}

function scrollToNavMessage(id: number): void {
  const el = msgsEl.value;
  if (!el) return;
  const row = el.querySelector<HTMLElement>(`[data-uid="${id}"]`);
  if (!row) return;
  const cRect = el.getBoundingClientRect();
  const rRect = row.getBoundingClientRect();
  const top = el.scrollTop + (rRect.top - cRect.top) - (el.clientHeight - rRect.height) / 2;
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  activeNavId.value = id;
}

/* ── 会话 ──────────────────────────────────────────────────────────────── */

async function loadSessions(): Promise<void> {
  const data = await api.get<{ sessions: Session[] }>('/ai/sessions');
  sessions.value = data.sessions ?? [];
}

async function loadQueue(): Promise<void> {
  const sid = activeSessionId.value;
  if (sid == null) {
    queue.value = [];
    return;
  }
  try {
    const data = await api.get<{ items: QueueItem[] }>(`/ai/sessions/${sid}/queue`);
    if (activeSessionId.value === sid) queue.value = data.items ?? [];
  } catch {
    /* 旧服务端没有队列接口时忽略 */
  }
}

async function pickSession(id: number | null): Promise<void> {
  activeSessionId.value = id;
  try {
    if (id == null) sessionStorage.removeItem(ACTIVE_SESSION_KEY);
    else sessionStorage.setItem(ACTIVE_SESSION_KEY, String(id));
  } catch {
    /* 隐私模式：忽略 */
  }
  messages.value = [];
streamingText.value = '';
  streamingTools.value = [];
  plan.value = [];
confirms.value = [];
  queue.value = [];
  dragIndex.value = null;
  dragGhost.value = null;
  stopWaitClock();
  // 切会话时清掉上一条会话残留的实时过程（工具步骤 + 思考）
  resetLiveTools();
  if (id == null) return;
  loadingMessages.value = true;
  try {
    const data = await api.get<{ messages: Msg[] }>(`/ai/sessions/${id}/messages`);
    messages.value = data.messages ?? [];
    scrollBottom();
} finally {
    loadingMessages.value = false;
  }
  // 这个会话可能正有回合在跑（刚从别的页面切回来）：恢复「进行中」状态
  await syncTurnState();
  await loadQueue();
}

async function newSession(): Promise<void> {
  const data = await api.post<{ session: Session }>('/ai/sessions', {});
  sessions.value.unshift(data.session);
  await pickSession(data.session.id);
}

async function deleteSession(): Promise<void> {
  const id = deleteTargetId.value ?? activeSessionId.value;
  if (id == null) return;
  try {
    await api.delete(`/ai/sessions/${id}`);
  } catch (err) {
    toast.warning((err as Error).message || '删除失败');
    deleteOpen.value = false;
    return;
  }
  toast.success('对话已删除');
  deleteOpen.value = false;
  deleteTargetId.value = null;
  sessions.value = sessions.value.filter((s) => s.id !== id);
  if (activeSessionId.value === id) {
    await pickSession(sessions.value[0]?.id ?? null);
  } else {
    await loadSessions();
  }
}

function askDelete(id: number): void {
  closeSessionMenu();
  deleteTargetId.value = id;
  if (id !== activeSessionId.value) void pickSession(id);
  deleteOpen.value = true;
}

/** 取消/关闭确认框时清掉目标，避免下次误删旧目标 */
watch(deleteOpen, (open) => {
  if (!open) deleteTargetId.value = null;
});

/* ── 附件 ──────────────────────────────────────────────────────────────── */

function pickImages(): void {
  imgInput.value?.click();
}

function pickFiles(): void {
  fileInput.value?.click();
}

async function uploadFiles(files: File[]): Promise<void> {
  for (const file of files) {
    if (attachments.value.length >= 6) {
      toast.warning('一条消息最多带 6 个附件');
      break;
    }
    try {
      const up = await uploadFile('/ai/upload', file);
      attachments.value.push({ kind: up.kind, url: up.url, name: up.name, mime: up.mime, size: up.size });
    } catch (err) {
      toast.warning((err as Error).message || '上传失败');
    }
  }
}

async function onFilesChosen(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  await uploadFiles(files);
}

/** 粘贴：剪贴板里带图片/文件时直接当附件上传；纯文本仍走默认粘贴 */
function onPaste(e: ClipboardEvent): void {
  const dt = e.clipboardData;
  if (!dt) return;
  const files: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (!files.length && dt.files?.length) files.push(...Array.from(dt.files));
  if (!files.length) return;
  e.preventDefault();
  void uploadFiles(files);
}

function removeAttachment(idx: number): void {
  attachments.value.splice(idx, 1);
}

/* ── 图片灯箱：滚轮缩放 + 左键拖动 ─────────────────────────────────────── */

function resetLightbox(): void {
  lbScale.value = 1;
  lbX.value = 0;
  lbY.value = 0;
  lbDragging.value = false;
}

function openPreview(att: { url: string; name: string }): void {
  resetLightbox();
  lbBase.value = { w: 0, h: 0 };
  previewImage.value = { url: att.url, name: att.name };
}

function closePreview(): void {
  previewImage.value = null;
  resetLightbox();
  lbBase.value = { w: 0, h: 0 };
}

/** 图片加载后按屏幕算一次基础尺寸；缩放时直接改 width/height，浏览器会按目标尺寸重新采样 */
function onLightboxImageLoad(): void {
  const el = lbImgEl.value;
  if (!el) return;
  const naturalW = el.naturalWidth || el.clientWidth;
  const naturalH = el.naturalHeight || el.clientHeight;
  if (!naturalW || !naturalH) return;
  const fit = Math.min(
    Math.max(120, window.innerWidth - 48) / naturalW,
    Math.max(120, window.innerHeight * 0.8) / naturalH,
    1
  );
  lbBase.value = { w: Math.round(naturalW * fit), h: Math.round(naturalH * fit) };
  clampLightboxPan();
}

const lbImgStyle = computed(() => {
  const base = lbBase.value;
  if (!base.w || !base.h) return {};
  return {
    width: `${base.w * lbScale.value}px`,
    height: `${base.h * lbScale.value}px`,
    maxWidth: 'none',
    maxHeight: 'none',
    transform: `translate(calc(-50% + ${lbX.value}px), calc(-50% + ${lbY.value}px))`,
  };
});

/** 平移范围限制在放大后的图片内，避免把图拖出屏幕 */
function clampLightboxPan(): void {
  if (!lbBase.value.w || !lbBase.value.h) return;
  const maxX = Math.max(0, (lbBase.value.w * lbScale.value - window.innerWidth) / 2);
  const maxY = Math.max(0, (lbBase.value.h * lbScale.value - window.innerHeight) / 2);
  lbX.value = Math.max(-maxX, Math.min(maxX, lbX.value));
  lbY.value = Math.max(-maxY, Math.min(maxY, lbY.value));
}

/** 以鼠标位置为锚点缩放 */
function onLightboxWheel(e: WheelEvent): void {
  if (!lbBase.value.w) return;
  const raw = lbScale.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15);
  const next = raw <= 1.01 ? 1 : Math.min(5, raw);
  if (next === lbScale.value) return;

  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  const ratio = next / lbScale.value;
  const dx = e.clientX - centerX;
  const dy = e.clientY - centerY;
  lbX.value = dx - (dx - lbX.value) * ratio;
  lbY.value = dy - (dy - lbY.value) * ratio;
  lbScale.value = next;

  if (next === 1) {
    lbX.value = 0;
    lbY.value = 0;
  } else {
    clampLightboxPan();
  }
}

function onLightboxPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || lbScale.value <= 1) return;
  e.preventDefault();
  lbDragging.value = true;
  lbDragStart = { x: e.clientX, y: e.clientY, ox: lbX.value, oy: lbY.value };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onLightboxPointerMove(e: PointerEvent): void {
  if (!lbDragging.value) return;
  lbX.value = lbDragStart.ox + (e.clientX - lbDragStart.x);
  lbY.value = lbDragStart.oy + (e.clientY - lbDragStart.y);
  clampLightboxPan();
}

function onLightboxPointerUp(e: PointerEvent): void {
  if (!lbDragging.value) return;
  lbDragging.value = false;
  try {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {
    /* 指针已释放 */
  }
}

/* ── 发送与流式接收 ────────────────────────────────────────────────────── */

async function send(): Promise<void> {
  if (composing.value || blockedByAsk.value) return;
  const text = inputText.value.trim();
  if (!text && attachments.value.length === 0) return;
  if (activeSessionId.value == null) await newSession();
  const sessionId = activeSessionId.value!;

  const optimisticId = -Date.now();
  const sentAttachments = attachments.value;
  // 回合进行中也能发：默认排队，当前回复结束后自动执行。
  // 发之前和服务端校准一次：断线 / 服务重启后本地可能还停在"正在回答"的假状态，
  // 那种情况下服务端其实已经空闲，直接排队会永远等不到终点，要先收掉假状态。
  let wasRunning = sending.value;
  if (wasRunning) {
    try {
      const turns = await api.get<{ turns: TurnView[] }>('/ai/turn-state');
      wasRunning = turns.turns.some((t) => t.sessionId === sessionId);
      if (!wasRunning) {
        sending.value = false;
        stopWaitClock();
        streamingText.value = '';
        resetLiveTools();
        plan.value = [];
        await reloadMessages();
      }
    } catch {
      /* 旧服务端没有该接口时按本地状态处理 */
    }
  }
  inputText.value = '';
  resetTextareaHeight();
  attachments.value = [];
  // 排队时立刻在输入框上方出现一张「等待发送」卡片；不往聊天记录里塞气泡
  if (wasRunning) {
    queue.value = [
      ...queue.value,
      {
        id: optimisticId,
        sessionId,
        content: text,
        attachments: sentAttachments.length ? [...sentAttachments] : null,
        createdAt: Math.floor(Date.now() / 1000),
        sortOrder: Number.MAX_SAFE_INTEGER,
      },
    ];
  } else {
    messages.value.push({
      id: optimisticId,
      role: 'user',
      content: text,
      attachments: sentAttachments.length ? [...sentAttachments] : null,
      meta: null,
      created_at: Math.floor(Date.now() / 1000),
    });
    scrollBottom();
    sending.value = true;
    streamingText.value = '';
    resetLiveTools();
    plan.value = [];
    startWaitClock();
  }
  try {
    const data = await api.post<{ queued?: boolean; item?: QueueItem }>(`/ai/sessions/${sessionId}/messages`, {
      text,
      attachments: sentAttachments,
      // 明确告诉服务端「这条要排队」：即使回合刚好结束也先落队列，再立刻取出来执行
      queue: wasRunning,
    });
    if (data.queued) {
      // 排队消息只显示在输入框上方的队列里，不混进聊天记录
      messages.value = messages.value.filter((m) => m.id !== optimisticId);
      if (data.item) {
        queue.value = [
          ...queue.value.filter((q) => q.id !== optimisticId && q.id !== data.item!.id),
          data.item,
        ];
      } else {
        await loadQueue();
      }
      scrollBottom();
    } else if (wasRunning) {
      // 旧服务端不认 queue 标记：本地以为在跑、服务端其实已空闲，把占位卡片换回聊天气泡
      queue.value = queue.value.filter((q) => q.id !== optimisticId);
      messages.value.push({
        id: optimisticId,
        role: 'user',
        content: text,
        attachments: sentAttachments.length ? [...sentAttachments] : null,
        meta: null,
        created_at: Math.floor(Date.now() / 1000),
      });
      toast.info('上一回合刚好结束，这条消息已直接发送');
      scrollBottom();
    }
  } catch (err) {
    messages.value = messages.value.filter((m) => m.id !== optimisticId);
    queue.value = queue.value.filter((q) => q.id !== optimisticId);
    // 409 = 这个会话上一回合还没结束。最常见的原因是它正停在 Ask Question 面板等回答：
    // 这时把面板补出来，而不是给用户看一条"还在生成中"的报错。
    if ((err as any)?.status === 409) {
      await loadPendingQuestions();
      // 注意：只有"这个会话"真的有等待回答的问题，才当作 Ask Question 场景；
      // 别的会话挂着问题不该吞掉当前会话的报错
      if (pendingAsks.value.some((q) => q.sessionId === sessionId)) {
        inputText.value = text;
        attachments.value = sentAttachments;
        resetTextareaHeight();
        return; // 保持 sending：回答后面板会把回合继续下去
      }
    }
    // 其它失败：把输入还原，别让用户重打一遍
    inputText.value = text;
    attachments.value = sentAttachments;
    resetTextareaHeight();
    if (!wasRunning) {
      sending.value = false;
      streamingText.value = '';
      stopWaitClock();
    }
    toast.warning((err as Error).message || '发送失败');
  }
}

/* ── 队列操作：编辑 / 引导 / 删除 / 长按拖动排序 ─────────────────────── */

async function editQueue(item: QueueItem): Promise<void> {
  if (inputText.value.trim()) {
    toast.info('输入框里还有内容，先清空再编辑排队消息吧');
    return;
  }
  try {
    await api.delete(`/ai/sessions/${item.sessionId}/queue/${item.id}`);
  } catch (err) {
    toast.warning((err as Error).message || '取回消息失败');
    return;
  }
  queue.value = queue.value.filter((q) => q.id !== item.id);
  inputText.value = item.content;
  attachments.value = Array.isArray(item.attachments) ? [...item.attachments] : [];
  nextTick(() => {
    autoGrow();
    textareaEl.value?.focus();
  });
}

async function guideQueue(item: QueueItem): Promise<void> {
  try {
    await api.post(`/ai/sessions/${item.sessionId}/queue/${item.id}/guide`, {});
    queue.value = queue.value.filter((q) => q.id !== item.id);
    toast.success('已把这条补充给正在回答的 AI');
  } catch (err) {
    toast.warning((err as Error).message || '引导失败');
    await loadQueue();
  }
}

async function removeQueue(item: QueueItem): Promise<void> {
  try {
    await api.delete(`/ai/sessions/${item.sessionId}/queue/${item.id}`);
    queue.value = queue.value.filter((q) => q.id !== item.id);
    toast.success('已删除排队消息');
  } catch (err) {
    toast.warning((err as Error).message || '删除失败');
  }
}

/** 面板底部的 ×：取消全部等待发送的消息（二次确认，避免误清） */
async function clearQueue(): Promise<void> {
  if (!queue.value.length) return;
  if (!window.confirm(`取消全部 ${queue.value.length} 条等待发送的消息吗？`)) return;
  const items = [...queue.value];
  try {
    await Promise.all(items.map((q) => api.delete(`/ai/sessions/${q.sessionId}/queue/${q.id}`)));
    queue.value = [];
    toast.success('已取消全部排队消息');
  } catch {
    await loadQueue();
  }
}

/** 停止当前回合：服务端会保留已生成的半截回答并正常结束 */
async function stopTurn(): Promise<void> {
  const sid = activeSessionId.value;
  if (sid == null || !sending.value) return;
  try {
    const data = await api.post<{ ok: boolean }>(`/ai/sessions/${sid}/stop`, {});
    if (data.ok) {
      toast.info('已停止当前回答');
      return;
    }
    // 服务端其实已经空闲（本地状态偏旧）：直接收掉假的「正在回答」
    sending.value = false;
    stopWaitClock();
    await reloadMessages();
  } catch (err) {
    toast.warning((err as Error).message || '停止失败');
  }
}

/* 六点图标直接拖动排序：按住即拿起，拖动时有张虚拟卡片跟着鼠标走，上下移动与目标行交换 */
const dragIndex = ref<number | null>(null);
const dragGhost = ref<{
  x: number;
  y: number;
  width: number;
  item: QueueItem;
  leaving: boolean;
} | null>(null);
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragStartY = 0;
let dragMoved = false;

function onQueuePointerDown(e: PointerEvent, index: number): void {
  const item = queue.value[index];
  const row = (e.currentTarget as HTMLElement).closest('.queue-row') as HTMLElement | null;
  if (!item || !row) return;
  const rect = row.getBoundingClientRect();
  dragIndex.value = index;
  dragStartY = e.clientY;
  dragMoved = false;
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;
  dragGhost.value = {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    item,
    leaving: false,
  };
  document.body.classList.add('queue-dragging');
  window.addEventListener('pointermove', onQueuePointerMove);
  window.addEventListener('pointerup', onQueuePointerUp);
  window.addEventListener('pointercancel', onQueuePointerUp);
}

function onQueuePointerMove(e: PointerEvent): void {
  if (dragIndex.value == null) return;
  e.preventDefault();
  if (dragGhost.value) {
    dragGhost.value = {
      ...dragGhost.value,
      x: e.clientX - dragOffsetX,
      y: e.clientY - dragOffsetY,
    };
  }
  if (Math.abs(e.clientY - dragStartY) < 4) return;
  const target = document
    .elementFromPoint(e.clientX, e.clientY)
    ?.closest('[data-queue-index]') as HTMLElement | null;
  if (!target) return;
  const to = Number(target.dataset.queueIndex);
  const from = dragIndex.value;
  if (!Number.isInteger(to) || to === from || to < 0 || to >= queue.value.length) return;
  const next = [...queue.value];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  queue.value = next;
  dragIndex.value = to;
  dragStartY = e.clientY;
  dragMoved = true;
}

function dropGhost(): void {
  if (!dragGhost.value) return;
  dragGhost.value = { ...dragGhost.value, leaving: true };
  window.setTimeout(() => {
    if (dragGhost.value?.leaving) dragGhost.value = null;
  }, 160);
}

async function onQueuePointerUp(): Promise<void> {
  window.removeEventListener('pointermove', onQueuePointerMove);
  window.removeEventListener('pointerup', onQueuePointerUp);
  window.removeEventListener('pointercancel', onQueuePointerUp);
  document.body.classList.remove('queue-dragging');
  dropGhost();
  const changed = dragMoved;
  dragIndex.value = null;
  dragMoved = false;
  if (!changed) return;
  const sid = activeSessionId.value;
  if (sid == null) return;
  try {
    const data = await api.put<{ items: QueueItem[] }>(`/ai/sessions/${sid}/queue/order`, {
      ids: queue.value.map((q) => q.id),
    });
    queue.value = data.items ?? queue.value;
  } catch {
    /* 排序失败就保留本地顺序，下次刷新会回到服务端顺序 */
  }
}

/** 输入框自适应高度：随内容增长、自动换行，最高不超过可视区高度的 1/3 */
function autoGrow(): void {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = 'auto';
  const max = Math.floor(window.innerHeight / 3);
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

function resetTextareaHeight(): void {
  nextTick(() => {
    const el = textareaEl.value;
    if (!el) return;
    el.style.height = 'auto';
  });
}

function onKeydown(e: KeyboardEvent): void {
  if (composing.value) return; // 输入法选词中的 Enter 是确认候选词，不是发送
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

function onWsEvent(e: Event): void {
  const msg = (e as CustomEvent).detail;
  // 问答面板不受「当前会话」过滤：切到别的会话时，也可能有回合停在等回答
  if (msg.type === 'ws:ai_chat_question') {
    upsertAsk({
      token: msg.token,
      sessionId: msg.sessionId,
      sessionTitle: sessions.value.find((s) => s.id === msg.sessionId)?.title ?? '',
      questions: msg.questions ?? [],
    });
    return;
  }
  if (msg.type === 'ws:ai_chat_question_closed') {
    removeAsk(msg.token);
    return;
  }
  if (msg.sessionId !== activeSessionId.value) return;
  if (msg.type === 'ws:ai_chat_delta') {
    waitPhase.value = 'writing';
    streamingText.value += msg.text ?? '';
    scrollBottom();
  } else if (msg.type === 'ws:ai_chat_plan') {
    plan.value = Array.isArray(msg.steps) ? msg.steps : [];
    scrollBottom();
  } else if (msg.type === 'ws:ai_chat_status') {
    if (!sending.value) {
      // 队列自动接上下一条时，先恢复「进行中」界面
      sending.value = true;
      streamingText.value = '';
      streamingTools.value = [];
      liveReasoning.value = '';
      plan.value = [];
      startWaitClock();
    }
    waitPhase.value = msg.phase === 'tool' ? 'tool' : msg.phase === 'writing' ? 'writing' : 'thinking';
    waitTool.value = msg.tool ?? '';
    scrollBottom();
  } else if (msg.type === 'ws:ai_chat_reasoning') {
    liveReasoning.value += msg.text ?? '';
    scrollBottom();
  } else if (msg.type === 'ws:ai_chat_tool') {
    // 工具开始/结束都会带来工具名：先切到「正在执行」状态，再把这一步（含参数与结果）记进过程
    waitPhase.value = 'tool';
    waitTool.value = msg.tool;
    streamingTools.value.push({
      tool: msg.tool,
      summary: msg.summary ?? '',
      args: msg.args ?? '',
      result: msg.result ?? '',
    });
    scrollBottom();
  } else if (msg.type === 'ws:ai_chat_confirm') {
    if (!confirms.value.some((c) => c.token === msg.token)) {
      confirms.value.push({ token: msg.token, summary: msg.summary, detail: msg.detail });
    }
    scrollBottom();
} else if (msg.type === 'ws:ai_chat_done' || msg.type === 'ws:ai_chat_error') {
    if (msg.type === 'ws:ai_chat_error') toast.warning(msg.error || 'AI 出错了');
    stopWaitClock();
    streamingText.value = '';
    resetLiveTools();
    plan.value = [];
    sending.value = false;
    void reloadMessages();
    void loadQueue();
  } else if (msg.type === 'ws:ai_chat_queue') {
    queue.value = Array.isArray(msg.items) ? msg.items : [];
  } else if (msg.type === 'ws:ai_chat_queue_sent') {
    // 排队消息轮到了：卡片收起的同时立刻以家长气泡出现在聊天记录里
    const messageId = Number(msg.messageId) || -Date.now();
    if (!messages.value.some((m) => m.id === messageId)) {
      messages.value.push({
        id: messageId,
        role: 'user',
        content: String(msg.text ?? ''),
        attachments: Array.isArray(msg.attachments) && msg.attachments.length ? msg.attachments : null,
        meta: null,
        created_at: Math.floor(Date.now() / 1000),
      });
    }
    if (!sending.value) {
      sending.value = true;
      streamingText.value = '';
      streamingTools.value = [];
      liveReasoning.value = '';
      plan.value = [];
      startWaitClock();
    }
    scrollBottom();
  } else if (msg.type === 'ws:ai_chat_guidance') {
    // 引导会打断当前回答：半截输出作废，清掉流式文本后等新一轮带上补充重新回答
    streamingText.value = '';
    resetLiveTools();
    if (!sending.value) sending.value = true;
    startWaitClock();
    messages.value.push({
      id: Number(msg.messageId) || -Date.now(),
      role: 'user',
      content: String(msg.text ?? ''),
      attachments: null,
      meta: { guidance: true },
      created_at: Math.floor(Date.now() / 1000),
    });
    toast.info('引导已送达，AI 会立刻参考你的补充重新回答');
    scrollBottom();
  } else if (msg.type === 'ws:ai_chat_warning') {
    toast.warning(msg.text || 'MCP 连接有问题');
  }
}

async function reloadMessages(): Promise<void> {
  if (activeSessionId.value == null) return;
  const data = await api.get<{ messages: Msg[] }>(`/ai/sessions/${activeSessionId.value}/messages`);
  messages.value = data.messages ?? [];
  scrollBottom();
}

/* ── 确认卡 ────────────────────────────────────────────────────────────── */

async function confirmAction(card: ConfirmCard, choice: 'once' | 'task' | 'deny'): Promise<void> {
  try {
    const data = await api.post<{ detail: string }>('/ai/confirm', { token: card.token, choice });
    toast.success(data.detail || '已执行');
  } catch (err) {
    toast.warning((err as Error).message || '执行失败');
  }
  confirms.value = confirms.value.filter((c) => c.token !== card.token);
  await reloadMessages();
}

/* ── Ask Question 面板 ─────────────────────────────────────────────────── */

/** 提交答案（payload 为 null = 跳过）：服务端拿它当工具结果继续本轮 */
async function answerAsk(payload: { answers: string[] }[] | null): Promise<void> {
  const token = ask.value?.token;
  if (!token) return;
  // 先收起面板，防止连点；失败再从服务端同步回来
  removeAsk(token);
  try {
    await api.post('/ai/answer', { token, answers: payload });
  } catch (err) {
    const message = (err as Error).message || '';
    if (/已经关闭|已回答|超时/.test(message)) toast.info('这个问题已经关闭了');
    else toast.warning(message || '提交失败');
    void loadPendingQuestions();
    return;
  }
  // 回答后回合会继续：本地立刻切回「进行中」，否则后续流式增量会因为 sending=false 不显示
  sending.value = true;
  if (waitPhase.value === 'idle') startWaitClock();
  void syncTurnState();
  void loadPendingQuestions();
}

/* ── 生命周期 ──────────────────────────────────────────────────────────── */

const wsTypes = [
  'ai_chat_delta',
  'ai_chat_reasoning',
  'ai_chat_tool',
  'ai_chat_confirm',
  'ai_chat_question',
  'ai_chat_question_closed',
  'ai_chat_status',
  'ai_chat_done',
  'ai_chat_error',
  'ai_chat_warning',
  'ai_chat_queue',
  'ai_chat_queue_sent',
  'ai_chat_guidance',
];

function onDocClick(e: MouseEvent): void {
  // 菜单打开时点别处就收起；点在菜单自身或行内 ⋯ 上不收
  const target = e.target as HTMLElement;
  if (target.closest('.session-menu') || target.closest('.row-more') || target.closest('.safety-menu') || target.closest('.safety-btn')) return;
  closeSessionMenu();
  closeSafetyMenu();
}

onMounted(async () => {
  for (const t of wsTypes) window.addEventListener(`ws:${t}`, onWsEvent);
  document.addEventListener('click', onDocClick, { capture: true });
  try {
    const status = await api.get<{ configured: boolean }>('/ai/status');
    aiReady.value = status.configured;
  } catch {
    aiReady.value = false;
  }
await loadSessions();
  await pickSession(sessions.value[0]?.id ?? null);
  // 回到这个页面时可能已经有"等回答"的问题（之前不在界面/断网/刷新）
  await loadPendingQuestions();
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onVisibilityChange);
  window.addEventListener('online', onVisibilityChange);
  window.addEventListener('resize', autoGrow);
});

// WS 重连（网络恢复 / 后台切回）时补一次：断线期间发的 ask_chat_question 事件会丢
watch(
  () => wsStore.connected,
  (connected) => {
    if (connected) {
      void loadPendingQuestions();
      void syncTurnState();
    }
  }
);

/**
 * 回合进行中兜底轮询待答问题：即使 WS 的事件丢了（或服务端版本较旧）也能在 2~3 秒内弹出面板，
 * 不用切页面才出现。回合结束即停止。
 */
let askPollTimer: number | null = null;
function stopAskPoll(): void {
  if (askPollTimer) {
    window.clearInterval(askPollTimer);
    askPollTimer = null;
  }
}
watch(
  () => sending.value,
  (running) => {
    stopAskPoll();
    if (running) {
      askPollTimer = window.setInterval(() => {
        void loadPendingQuestions();
        // 同时校准回合状态：服务重启/断线后不会一直卡在「加入排队」
        void syncTurnState();
      }, 2500);
    }
  }
);

// 提问卡片 / 计划列表出现会改变布局：自动贴到底部，避免最新一条消息被挡住还得手动拉
onUnmounted(() => {
  for (const t of wsTypes) window.removeEventListener(`ws:${t}`, onWsEvent);
  document.removeEventListener('click', onDocClick, { capture: true });
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('focus', onVisibilityChange);
  window.removeEventListener('online', onVisibilityChange);
  window.removeEventListener('resize', autoGrow);
  if (navCloseTimer) window.clearTimeout(navCloseTimer);
  if (navScrollRaf) cancelAnimationFrame(navScrollRaf);
  stopWaitClock();
  stopAskPoll();
});

/** 当前会话有等待回答的提问：先把问题答完再发，避免无谓的 409 */
const blockedByAsk = computed(() => Boolean(ask.value && ask.value.sessionId === activeSessionId.value));

// 提问卡片 / 计划列表出现会改变布局：自动贴到底部，避免最新一条消息被挡住还得手动拉
watch(ask, () => scrollBottom());
watch(blockedByAsk, () => scrollBottom());
watch(plan, () => scrollBottom());
const canSend = computed(
  () =>
    !blockedByAsk.value &&
    (inputText.value.trim().length > 0 || attachments.value.length > 0)
);
/** 底栏按钮：空闲 → 发送；回复中有内容 → 加入排队；回复中没内容 → 停止 */
const composerMode = computed<'stop' | 'queue' | 'send'>(() => {
  if (!sending.value) return 'send';
  return canSend.value ? 'queue' : 'stop';
});
</script>

<template>
  <div class="ai-page">
    <!-- 左侧会话栏：铺开展示，右键/⋯ 菜单支持重命名与删除 -->
    <aside class="ai-sidebar glass">
      <button class="btn small new-chat-btn" @click="newSession">＋ 新对话</button>
      <div class="session-list">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="session-row"
          :class="{ active: s.id === activeSessionId }"
          @click="pickSession(s.id)"
          @contextmenu.prevent="openSessionMenu($event, s.id)"
        >
          <template v-if="renameId === s.id">
            <input
              :id="`rename-input-${s.id}`"
              v-model="renameValue"
              class="rename-input"
              @keydown.enter.prevent="saveRename(s.id)"
              @blur="saveRename(s.id)"
              @click.stop
            />
          </template>
          <template v-else>
            <span class="session-title">{{ s.title }}</span>
            <span class="session-meta">{{ fmtSessionTime(s.updated_at) }}</span>
          </template>
          <button
            v-if="renameId !== s.id"
            class="row-more btn small"
            aria-label="会话操作"
            title="重命名 / 删除"
            @click.stop="openSessionMenuById(s.id, $event)"
          >⋯</button>
        </div>
        <p v-if="!sessions.length" class="session-empty">还没有对话</p>
      </div>
    </aside>

    <!-- 右侧对话区 -->
    <div class="ai-main">
      <header class="ai-head glass">
        <span class="ai-title">AI 助手</span>
      </header>

      <div v-if="!aiReady" class="not-ready glass">
        ⚙️ AI 还没有配置：请主家长点右上角头像 →「AI 设置」，填好模型接口后即可使用。
      </div>

      <div class="ai-body">
        <div ref="msgsEl" class="ai-msgs scroll-area" @scroll.passive="onMsgsScroll">
        <div v-if="activeSessionId == null" class="empty-hint">
          <p>和 AI 聊聊家里的事 🌱</p>
          <p class="sub">可以问积分情况、让它看图导入数据（点下方按钮上传）、或开启 Agent 模式让它直接操作。</p>
          <button class="btn btn-primary" @click="newSession">开始新对话</button>
        </div>

        <template v-for="item in chatItems" :key="item.key">
<div v-if="item.kind === 'user'" class="row user" :data-uid="item.msg.id">
            <div class="bubble user-bubble">
              <span v-if="item.msg.meta?.guidance" class="guidance-tag">引导</span>
              <div v-if="item.msg.attachments?.length" class="atts">
                <template v-for="att in item.msg.attachments" :key="att.url">
                  <img
                    v-if="att.kind === 'image'"
                    class="att-img"
                    :src="att.url"
                    :alt="att.name"
                    title="点击放大"
                    @click="openPreview(att)"
                  />
                  <span v-else class="att-file">📄 {{ att.name }}</span>
                </template>
              </div>
              <span class="plain">{{ item.msg.content }}</span>
            </div>
          </div>

          <div v-else class="row assistant">
            <div class="bubble ai-bubble">
              <details v-if="item.steps.length" class="turn-process">
                <summary class="proc-summary">
                  <span class="proc-count">过程 · {{ item.steps.length }} 步</span>
                  <span class="proc-hint">思考与工具调用</span>
                </summary>
                <ol class="proc-list">
                  <li v-for="(s, i) in item.steps" :key="i" class="proc-item" :class="s.type">
                    <div class="proc-head">
                      <span class="proc-idx">{{ i + 1 }}</span>
                      <span class="proc-name">{{
                        s.type === 'tool' ? s.tool : s.type === 'reasoning' ? '思考' : '说明'
                      }}</span>
                    </div>
                    <div v-if="s.type === 'tool' && s.args" class="proc-block">
                      <span class="proc-label">参数</span>
                      <code class="proc-code">{{ fmtArgs(s.args) }}</code>
                    </div>
                    <div v-if="s.type === 'tool' && s.result" class="proc-block">
                      <span class="proc-label">{{ s.needsConfirm ? '待确认' : '结果' }}</span>
                      <pre class="proc-pre">{{ s.result }}</pre>
                    </div>
                    <p v-if="s.type !== 'tool' && s.text" class="proc-text">{{ s.text }}</p>
                  </li>
                </ol>
              </details>
              <div v-if="item.final" v-html="renderMarkdown(item.final)"></div>
            </div>
          </div>
        </template>

        <div v-if="sending" class="row assistant">
          <div class="bubble ai-bubble streaming">
            <div v-if="plan.length" class="plan-feed">
              <div class="plan-head">
                <span>执行计划</span>
                <span class="plan-count">{{ planDone }} / {{ plan.length }}</span>
              </div>
              <ul class="plan-list">
                <li v-for="(s, i) in plan" :key="i" class="plan-item" :class="s.status">
                  <span class="plan-mark">{{ s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▶' : i + 1 }}</span>
                  <span class="plan-title">{{ s.title }}</span>
                </li>
              </ul>
            </div>
            <details v-if="liveReasoning || streamingTools.length" class="turn-process live" open>
              <summary class="proc-summary">
                <span class="proc-count">进行中 · {{ streamingTools.length + (liveReasoning ? 1 : 0) }} 步</span>
                <span class="proc-hint">实时过程</span>
              </summary>
              <ol class="proc-list">
                <li v-if="liveReasoning" class="proc-item reasoning">
                  <div class="proc-head">
                    <span class="proc-idx">·</span>
                    <span class="proc-name">思考</span>
                  </div>
                  <p class="proc-text">{{ liveReasoning }}</p>
                </li>
                <li v-for="(t, i) in streamingTools" :key="i" class="proc-item tool">
                  <div class="proc-head">
                    <span class="proc-idx">{{ i + 1 }}</span>
                    <span class="proc-name">{{ t.tool }}</span>
                  </div>
                  <div v-if="t.args" class="proc-block">
                    <span class="proc-label">参数</span>
                    <code class="proc-code">{{ fmtArgs(t.args) }}</code>
                  </div>
                  <div v-if="t.result" class="proc-block">
                    <span class="proc-label">结果</span>
                    <pre class="proc-pre">{{ t.result }}</pre>
                  </div>
                </li>
              </ol>
            </details>
            <span v-if="streamingText" v-html="renderMarkdown(streamingText)"></span>
            <span v-if="waitPhase === 'tool'" class="thinking">
              正在执行：{{ waitTool || '工具' }}<span class="dots">…</span>
              <em class="wait-time">{{ waitSeconds.toFixed(1) }}s</em>
            </span>
            <span v-else-if="!streamingText" class="thinking">
              {{ waitPhase === 'writing' ? '正在回答' : 'AI 正在思考' }}<span class="dots">…</span>
              <em class="wait-time">{{ waitSeconds.toFixed(1) }}s</em>
            </span>
          </div>
        </div>

        <div v-for="card in confirms" :key="card.token" class="confirm-card glass">
          <div class="cc-title">⚠️ AI 请求执行操作，请确认</div>
          <div class="cc-body">{{ card.detail }}</div>
          <div class="cc-actions">
            <button class="btn btn-success small" @click="confirmAction(card, 'once')">✅ 允许一次</button>
            <button class="btn small" @click="confirmAction(card, 'task')">🔁 本次任务都允许</button>
            <button class="btn small danger" @click="confirmAction(card, 'deny')">✖ 拒绝</button>
          </div>
        </div>
</div>

        <!-- 右侧消息导航：小横线定位，悬浮展开历史提问，点击平滑滚回 -->
        <div
          v-if="userNavItems.length > 1"
          class="msg-nav"
          @mouseenter="openMsgNav"
          @mouseleave="closeMsgNavSoon"
        >
          <div class="msg-rail" aria-label="消息导航">
            <button
              v-for="m in userNavItems"
              :key="m.id"
              type="button"
              class="nav-dash"
              :class="{ current: activeNavId === m.id }"
              :aria-label="`跳到：${m.text.slice(0, 30)}`"
              @click="scrollToNavMessage(m.id)"
            ></button>
          </div>
          <div v-if="msgNavOpen" class="msg-nav-panel" @mouseenter="openMsgNav">
            <button
              v-for="(m, i) in userNavItems"
              :key="m.id"
              type="button"
              class="nav-item"
              :class="{ current: activeNavId === m.id }"
              @click="scrollToNavMessage(m.id)"
            >
              <span class="nav-idx">{{ i + 1 }}</span>
              <span class="nav-text">{{ m.text }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Ask Question：贴着输入框上方的上拉卡片，不遮挡聊天记录 -->
      <AiAskQuestionPanel
        v-if="ask"
        :key="ask.token"
        :questions="ask.questions"
        :session-title="ask.sessionTitle"
        :expires-at="ask.expiresAt"
        @submit="answerAsk"
        @skip="answerAsk(null)"
      />

      <!-- 排队中的消息：整块「等待发送」面板，一条消息一行；当前回复结束后按顺序自动发送 -->
      <section v-if="queue.length" class="queue-panel" aria-label="等待发送的排队消息">
        <div class="queue-list">
          <div
            v-for="(q, i) in queue"
            :key="q.id"
            class="queue-row"
            :class="{ dragging: dragIndex === i }"
            :data-queue-index="i"
          >
            <button
              class="qc-grip"
              type="button"
              title="拖动调整顺序"
              aria-label="拖动调整顺序"
              @pointerdown.prevent="onQueuePointerDown($event, i)"
            >
              <svg viewBox="0 0 10 16" aria-hidden="true">
                <circle cx="2.5" cy="3" r="1.2" />
                <circle cx="7.5" cy="3" r="1.2" />
                <circle cx="2.5" cy="8" r="1.2" />
                <circle cx="7.5" cy="8" r="1.2" />
                <circle cx="2.5" cy="13" r="1.2" />
                <circle cx="7.5" cy="13" r="1.2" />
              </svg>
            </button>
            <span class="qc-clock" title="等待发送" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="5.8" />
                <path d="M8 4.6V8l2.3 1.5" />
              </svg>
            </span>
            <span class="qc-text">{{ q.content || '（仅附件）' }}</span>
            <span v-if="q.attachments?.length" class="qc-att">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M10.6 4.6L5.9 9.3a2 2 0 0 0 2.8 2.8l4.4-4.4a3.4 3.4 0 0 0-4.8-4.8L3.7 7.5a4.8 4.8 0 0 0 6.8 6.8l2.8-2.8" />
              </svg>
              {{ q.attachments.length }}
            </span>
            <div class="qc-actions">
              <button class="qc-btn" type="button" title="编辑：取回输入框，改好再发" aria-label="编辑排队消息" @click="editQueue(q)">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 13l.8-3.2L11 2.6l2.4 2.4L6.2 12.2 3 13z" />
                  <path d="M9.8 3.8l2.4 2.4" />
                </svg>
              </button>
              <button class="qc-btn guide" type="button" title="引导：立刻补充给正在回答的 AI" aria-label="引导：立刻补充给正在回答的 AI" @click="guideQueue(q)">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 13V3.4" />
                  <path d="M4.2 7l3.8-3.6L11.8 7" />
                </svg>
              </button>
              <button class="qc-btn danger" type="button" title="删除这条排队消息" aria-label="删除排队消息" @click="removeQueue(q)">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 4.5h10" />
                  <path d="M6.5 4.5V2.5h3v2" />
                  <path d="M4.8 5.5l.7 8h5l.7-8" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <!-- 面板状态：所有排队消息共用一条「等待发送」，× 取消全部 -->
        <div class="queue-status">
          <span class="queue-status-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <path d="M13.6 7.4c0 2.9-2.5 5.2-5.6 5.2-.6 0-1.2-.1-1.7-.3L3 13.4l1-2.8a4.9 4.9 0 0 1-1.6-3.2C2.4 4.5 4.9 2.2 8 2.2s5.6 2.3 5.6 5.2z" />
              <circle cx="5.9" cy="7.4" r=".7" />
              <circle cx="8" cy="7.4" r=".7" />
              <circle cx="10.1" cy="7.4" r=".7" />
            </svg>
          </span>
          <span class="queue-status-text">等待发送…</span>
          <button class="qc-cancel" type="button" title="取消全部排队消息" aria-label="取消全部排队消息" @click="clearQueue">×</button>
        </div>
      </section>

      <!-- 拖动时跟随鼠标的浮动卡片 -->
      <Teleport to="body">
        <div
          v-if="dragGhost"
          class="queue-ghost"
          :style="{ width: dragGhost.width + 'px', transform: `translate3d(${dragGhost.x}px, ${dragGhost.y}px, 0)` }"
        >
          <div class="queue-ghost-inner" :class="{ leaving: dragGhost.leaving }">
            <span class="qc-grip ghost-grip" aria-hidden="true">
              <svg viewBox="0 0 10 16">
                <circle cx="2.5" cy="3" r="1.2" />
                <circle cx="7.5" cy="3" r="1.2" />
                <circle cx="2.5" cy="8" r="1.2" />
                <circle cx="7.5" cy="8" r="1.2" />
                <circle cx="2.5" cy="13" r="1.2" />
                <circle cx="7.5" cy="13" r="1.2" />
              </svg>
            </span>
            <span class="qc-clock" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="5.8" />
                <path d="M8 4.6V8l2.3 1.5" />
              </svg>
            </span>
            <span class="qc-text">{{ dragGhost.item.content || '（仅附件）' }}</span>
            <span v-if="dragGhost.item.attachments?.length" class="qc-att">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M10.6 4.6L5.9 9.3a2 2 0 0 0 2.8 2.8l4.4-4.4a3.4 3.4 0 0 0-4.8-4.8L3.7 7.5a4.8 4.8 0 0 0 6.8 6.8l2.8-2.8" />
              </svg>
              {{ dragGhost.item.attachments.length }}
            </span>
          </div>
        </div>
      </Teleport>

      <footer v-if="!blockedByAsk" ref="composerEl" class="composer glass" @paste="onPaste">
        <div v-if="attachments.length" class="pending-atts">
          <span v-for="(att, i) in attachments" :key="att.url" class="pending-att">
            <img
              v-if="att.kind === 'image'"
              :src="att.url"
              class="pa-thumb"
              :alt="att.name"
              title="点击放大"
              @click="openPreview(att)"
            />
            <span v-else class="pa-name">📄 {{ att.name }}</span>
            <button class="pa-remove" aria-label="移除附件" title="移除" @click="removeAttachment(i)">×</button>
          </span>
        </div>
        <div class="composer-row">
          <input ref="imgInput" type="file" multiple accept="image/png,image/jpeg,image/webp,image/bmp" class="file-input" @change="onFilesChosen" />
          <input ref="fileInput" type="file" multiple accept=".txt,.md,.csv,.json,.pdf" class="file-input" @change="onFilesChosen" />
          <textarea
            ref="textareaEl"
            v-model="inputText"
            class="composer-input"
            rows="1"
            :placeholder="blockedByAsk ? '请先回答上方的问题…' : sending ? '继续输入，当前回复结束后自动发送…' : '问问 AI…（Enter 发送，Shift+Enter 换行）'"
            @input="autoGrow"
            @keydown="onKeydown"
            @compositionstart="composing = true"
            @compositionend="composing = false"
          ></textarea>
<button
            class="btn btn-primary send-btn"
            :class="{ stop: composerMode === 'stop' }"
            :disabled="composerMode !== 'stop' && !canSend"
            :aria-busy="sending"
            :aria-label="composerMode === 'stop' ? '停止当前回答' : composerMode === 'queue' ? '加入排队' : '发送'"
            @click="composerMode === 'stop' ? stopTurn() : send()"
          >
            <svg v-if="composerMode === 'stop'" class="stop-icon" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4" y="4" width="8" height="8" rx="1.6" />
            </svg>
            {{ composerMode === 'stop' ? '停止' : composerMode === 'queue' ? '加入排队' : '发送' }}
          </button>
        </div>
        <div class="attach-row">
          <button class="btn small safety-btn" :class="{ warn: safety === 'allowAll' }" :title="`安全策略：${safetyLabel}`" @click="openSafetyMenu">
            <span class="ico" aria-hidden="true">🛡</span>{{ safetyLabel }}
          </button>
          <button class="btn small attach-btn" aria-label="上传图片" title="上传图片（识别后导入数据）" @click="pickImages">
            <span class="ico" aria-hidden="true">🖼️</span>图片
          </button>
          <button class="btn small attach-btn" aria-label="上传文件" title="上传文档（txt/md/csv/json/pdf）" @click="pickFiles">
            <span class="ico" aria-hidden="true">📎</span>文件
          </button>
        </div>      </footer>
    </div>

    <!-- 安全策略浮层 -->
    <Teleport to="body">
      <div
        v-if="safetyMenu"
        class="safety-menu glass"
        :style="{ left: safetyMenu.x + 'px', bottom: safetyMenu.bottom + 'px' }"
      >
        <button
          v-for="opt in safetyOptions"
          :key="opt.mode"
          class="safety-entry"
          :class="{ on: safety === opt.mode }"
          :disabled="!auth.user?.isPrimary"
          :title="auth.user?.isPrimary ? '' : '仅主家长可修改'"
          @click="pickSafety(opt.mode)"
        >
          <span class="se-check">{{ safety === opt.mode ? '✓' : '🛡' }}</span>
          <span class="se-body">
            <span class="se-title">{{ opt.title }}</span>
            <span class="se-desc">{{ opt.desc }}</span>
          </span>
        </button>
        <p v-if="!auth.user?.isPrimary" class="se-note">仅主家长可修改安全策略</p>
      </div>
    </Teleport>

    <!-- 会话右键/⋯ 菜单 -->
    <Teleport to="body">
      <div
        v-if="sessionMenu"
        class="session-menu glass"
        :style="{ left: sessionMenu.x + 'px', top: sessionMenu.y + 'px' }"
      >
        <button class="menu-entry" @click="startRename(sessionMenu.id)">✏️ 重命名</button>
        <button class="menu-entry danger" @click="askDelete(sessionMenu.id)">🗑️ 删除</button>
      </div>
    </Teleport>

    <!-- 图片灯箱：点击图片放大查看（只读，不提供下载） -->
    <Teleport to="body">
      <Transition name="lb-fade">
        <div v-if="previewImage" class="lb-overlay" @click="closePreview">
          <img
            ref="lbImgEl"
            class="lb-img"
            :class="{ 'is-zoomed': lbScale > 1, 'is-dragging': lbDragging }"
            :src="previewImage.url"
            :alt="previewImage.name"
            :style="lbImgStyle"
            draggable="false"
            @load="onLightboxImageLoad"
            @click.stop
            @dblclick.stop="resetLightbox"
            @wheel.prevent="onLightboxWheel"
            @pointerdown="onLightboxPointerDown"
            @pointermove="onLightboxPointerMove"
            @pointerup="onLightboxPointerUp"
            @pointercancel="onLightboxPointerUp"
          />
          <p v-if="lbScale === 1" class="lb-hint">滚轮缩放 · 按住拖动 · 点击空白处关闭</p>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog
      v-model="deleteOpen"
      title="删除对话"
      message="删除后这段对话的所有消息都无法找回，确定删除吗？"
      confirmText="删除"
      variant="danger"
      @confirm="deleteSession"
    />
  </div>
</template>

<style scoped>
.ai-page {
  display: flex;
  gap: var(--space-12);
  height: calc(100dvh - 158px);
  min-height: 320px;
  max-width: 1060px;
  margin: 0 auto;
}

/* ── 左侧会话栏 ── */
.ai-sidebar {
  width: 216px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  padding: var(--space-10);
  overflow: hidden;
}
.new-chat-btn {
  width: 100%;
  justify-content: center;
}
.session-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.session-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-8) var(--space-10);
  border-radius: var(--r-sm);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background var(--dur-fast), border var(--dur-fast);
}
.session-row:hover {
  background: var(--glass-bg-strong);
}
.session-row.active {
  background: var(--glass-bg-strong);
  border-color: var(--accent-orange);
}
.session-title {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 26px;
}
.session-row.active .session-title {
  font-weight: 600;
}
.session-meta {
  font-size: var(--fs-2xs);
  color: var(--text-muted);
}
.session-row .row-more {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  min-height: 26px;
  padding: 0 var(--space-6);
  opacity: 0;
}
.session-row:hover .row-more,
.session-row.active .row-more {
  opacity: 1;
}
.session-empty {
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  padding: var(--space-12) 0;
}
.rename-input {
  width: 100%;
  box-sizing: border-box;
  font-size: var(--fs-sm);
  padding: 2px var(--space-6);
  border-radius: var(--r-sm);
  border: 1px solid var(--accent-orange);
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}
.rename-input:focus {
  outline: none;
}

/* 右键/⋯ 菜单 */
.session-menu {
  position: fixed;
  z-index: 1600;
  min-width: 132px;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: var(--r-md);
}
.menu-entry {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-8) var(--space-10);
  border: none;
  background: none;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}
.menu-entry:hover {
  background: var(--glass-bg-strong);
}
.menu-entry.danger:hover {
  background: rgba(255, 107, 107, 0.14);
  color: var(--danger);
}

/* ── 右侧对话区 ── */
.ai-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}
.ai-head {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-8) var(--space-12);
}
.ai-title {
  font-family: var(--font-cute);
  font-size: var(--fs-lg);
  margin-right: auto;
}
.agent-toggle.on {
  background: rgba(255, 180, 84, 0.3);
  color: var(--text-on-orange);
  font-weight: 600;
}
.not-ready {
  padding: var(--space-10) var(--space-14);
  font-size: var(--fs-sm);
  color: var(--text-muted);
  border-radius: var(--r-md);
}
.ai-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.ai-msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
  padding: var(--space-4) 34px var(--space-4) var(--space-6);
}

/* 右侧消息导航：默认是一列小横线，悬停展开历史提问列表 */
.msg-nav {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 6;
  padding: 4px 0;
}
.msg-rail {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 7px;
  max-height: min(58vh, 420px);
  overflow-y: auto;
  padding: 8px 4px;
  scrollbar-width: none;
}
.msg-rail::-webkit-scrollbar {
  display: none;
}
.nav-dash {
  flex: 0 0 auto;
  width: 10px;
  height: 2px;
  padding: 0;
  border: none;
  border-radius: 2px;
  background: rgba(120, 90, 105, 0.3);
  cursor: pointer;
  transition: width 0.16s ease, background 0.16s ease;
}
.nav-dash:hover {
  width: 16px;
  background: rgba(110, 70, 90, 0.62);
}
.nav-dash.current {
  width: 16px;
  background: var(--text-primary);
  opacity: 0.72;
}
.msg-nav-panel {
  position: absolute;
  right: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%);
  width: min(340px, 46vw);
  max-height: min(60vh, 460px);
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-radius: var(--r-md);
  border: 1px solid var(--glass-border);
  background: var(--glass-bg-strong);
  box-shadow: 0 14px 34px rgba(120, 80, 60, 0.18);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.nav-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-6);
  width: 100%;
  padding: 7px 9px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--fs-xs);
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}
.nav-item:hover {
  background: rgba(255, 209, 102, 0.16);
  color: var(--text-primary);
}
.nav-item.current {
  color: var(--text-primary);
  font-weight: 600;
}
.nav-idx {
  flex: 0 0 auto;
  min-width: 1.3em;
  opacity: 0.45;
  font-variant-numeric: tabular-nums;
}
.nav-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-hint {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
}
.empty-hint .sub {
  font-size: var(--fs-xs);
  margin-bottom: var(--space-12);
}
.row {
  display: flex;
}
.row.user {
  justify-content: flex-end;
}
.bubble {
  max-width: 78%;
  padding: 10px 14px;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  line-height: 1.6;
  word-break: break-word;
}
.user-bubble {
  background: linear-gradient(160deg, #ffd98a, #ffc766);
  color: #4a3300;
  border: 1px solid rgba(200, 140, 40, 0.35);
  white-space: pre-wrap;
}
.ai-bubble {
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-border);
}
.ai-bubble :deep(p) {
  margin: 0 0 var(--space-8);
}
.ai-bubble :deep(p:last-child) {
  margin-bottom: 0;
}
.ai-bubble :deep(ul),
.ai-bubble :deep(ol) {
  margin: 0 0 var(--space-8);
  padding-left: 1.4em;
}
.ai-bubble :deep(code) {
  background: rgba(255, 209, 102, 0.22);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.9em;
}
.ai-bubble :deep(pre) {
  background: rgba(255, 209, 102, 0.22);
  padding: var(--space-8);
  border-radius: var(--r-sm);
  overflow-x: auto;
  font-size: 0.85em;
}
.ai-bubble :deep(table) {
  border-collapse: collapse;
  margin-bottom: var(--space-8);
}
.ai-bubble :deep(th),
.ai-bubble :deep(td) {
  border: 1px solid rgba(224, 188, 125, 0.55);
  padding: 4px 8px;
  font-size: 0.9em;
}
.atts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
  margin-bottom: var(--space-8);
}
.att-img {
  width: 120px;
  max-height: 120px;
  object-fit: cover;
  border-radius: var(--r-sm);
  cursor: zoom-in;
  transition: transform var(--dur-fast);
}
.att-img:hover {
  transform: scale(1.03);
}
.att-file {
  font-size: var(--fs-xs);
  background: var(--glass-bg-strong);
  padding: 4px 8px;
  border-radius: var(--r-sm);
}
.tool-row {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  background: rgba(255, 209, 102, 0.14);
  border-radius: var(--r-sm);
  padding: 4px 10px;
  max-width: 86%;
}
.tool-row summary {
  cursor: pointer;
}
.tool-result {
  margin: var(--space-6) 0 0;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
  font-size: 0.95em;
}

/* ── 过程块：思考 + 工具调用（折叠可展开，像 Trae 的执行轨迹） ───────── */
.turn-process {
  margin: 0 0 var(--space-8);
  border: 1px solid rgba(224, 188, 125, 0.45);
  border-radius: var(--r-sm);
  background: rgba(255, 255, 255, 0.55);
  overflow: hidden;
}
.turn-process.live {
  border-color: var(--accent-mint);
}
.proc-summary {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: 6px 10px;
  cursor: pointer;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  list-style: none;
  user-select: none;
}
.proc-summary::-webkit-details-marker {
  display: none;
}
.proc-summary::before {
  content: '▸';
  font-size: 0.9em;
  transition: transform 0.15s ease;
}
.turn-process[open] > .proc-summary::before {
  transform: rotate(90deg);
}
.proc-count {
  font-weight: 600;
  color: var(--text-primary);
}
.proc-hint {
  margin-left: auto;
  opacity: 0.7;
}
.proc-list {
  margin: 0;
  padding: 0 10px 10px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}
.proc-item {
  border-left: 2px solid rgba(0, 0, 0, 0.08);
  padding: 2px 0 2px 8px;
}
.proc-item.tool {
  border-left-color: var(--accent-mint);
}
.proc-item.reasoning,
.proc-item.note {
  border-left-color: var(--text-muted);
}
.proc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
}
.proc-idx {
  min-width: 14px;
  color: var(--text-muted);
  opacity: 0.8;
}
.proc-name {
  font-weight: 600;
  color: var(--text-primary);
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
}
.proc-text {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
.proc-block {
  margin-top: 4px;
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.proc-label {
  flex: none;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  opacity: 0.75;
}
.proc-code,
.proc-pre {
  margin: 0;
  padding: 4px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(0, 0, 0, 0.08);
  font-size: var(--fs-xs);
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
}
.proc-pre {
  flex: 1;
  max-height: 180px;
}
.streaming .thinking {
  color: var(--text-muted);
  display: inline-flex;
  align-items: baseline;
}
/* 省略号呼吸 + 计时，告诉用户"在动"而不是卡住 */
.streaming .thinking .dots {
  display: inline-block;
  animation: wait-blink 1.2s steps(2, start) infinite;
}
@keyframes wait-blink {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}
.wait-time {
  font-style: normal;
  margin-left: var(--space-6);
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
.plan-feed {
  border: 1px dashed rgba(224, 188, 125, 0.5);
  border-radius: var(--r-sm);
  padding: var(--space-8);
  margin-bottom: var(--space-6);
  background: rgba(255, 255, 255, 0.55);
}
.plan-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  margin-bottom: var(--space-6);
}
.plan-count {
  color: var(--text-muted, #7a6a55);
  font-variant-numeric: tabular-nums;
}
.plan-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.plan-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-8);
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  line-height: 1.5;
}
.plan-mark {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: var(--r-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-2xs);
  background: rgba(90, 58, 74, 0.08);
  color: var(--text-muted, #7a6a55);
  margin-top: 1px;
}
.plan-item.done {
  color: var(--text-secondary);
}
.plan-item.done .plan-mark {
  background: #22c55e;
  color: #fff;
}
.plan-item.in_progress {
  color: var(--text-primary);
  font-weight: 600;
}
.plan-item.in_progress .plan-mark {
  background: var(--accent-orange);
  color: #fff;
  animation: plan-pulse 1.2s ease-in-out infinite;
}
@keyframes plan-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
.tool-feed {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
  margin-bottom: var(--space-6);
}
.tool-chip {
  font-size: var(--fs-xs);
  background: rgba(126, 212, 185, 0.2);
  border: 1px solid rgba(126, 212, 185, 0.4);
  padding: 2px 8px;
  border-radius: var(--r-full);
  color: #2f6b52;
}
.confirm-card {
  border: 1.5px solid rgba(230, 140, 40, 0.55);
  background: linear-gradient(160deg, rgba(255, 244, 220, 0.95), rgba(255, 232, 190, 0.9));
  border-radius: var(--r-md);
  padding: var(--space-10) var(--space-14);
}
.cc-title {
  font-weight: 700;
  font-size: var(--fs-sm);
  margin-bottom: var(--space-4);
}
.cc-body {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-bottom: var(--space-8);
  white-space: pre-wrap;
}
.cc-actions {
  display: flex;
  gap: var(--space-8);
}

/* ── 底部输入区 ── */
/* 排队面板（输入框上方）：整块「等待发送」，每条消息一行；悬停时露出拖动柄和操作 */
.queue-panel {
  flex: none;
  display: flex;
  flex-direction: column;
  margin: 0 var(--space-4) var(--space-2);
  padding: var(--space-4);
  border-radius: var(--r-md);
  border: 1px solid rgba(224, 188, 125, 0.4);
  background: var(--glass-bg-strong);
  box-shadow: 0 2px 10px rgba(90, 58, 74, 0.07);
  overflow: hidden;
}
.queue-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 26vh;
  overflow-y: auto;
}
.queue-row {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-height: 36px;
  padding: 0 var(--space-8) 0 var(--space-4);
  border-radius: var(--r-sm);
  transition: background var(--dur-fast), opacity var(--dur-fast);
}
.queue-row:hover,
.queue-row:focus-within {
  background: rgba(255, 180, 84, 0.14);
}
.queue-row.dragging {
  opacity: 0.4;
  background: rgba(255, 180, 84, 0.08);
}
.qc-grip {
  flex: none;
  width: 18px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  opacity: 0;
  pointer-events: none;
  cursor: grab;
  touch-action: none;
  display: grid;
  place-items: center;
  padding: 0;
  transition: opacity var(--dur-fast);
}
.queue-row:hover .qc-grip,
.queue-row:focus-within .qc-grip,
.queue-row.dragging .qc-grip {
  opacity: 0.65;
  pointer-events: auto;
}
.qc-grip:active {
  cursor: grabbing;
}
.qc-grip svg {
  width: 10px;
  height: 16px;
  fill: currentColor;
}
.qc-clock {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  opacity: 0.72;
}
.qc-clock svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
}
.qc-text {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  line-height: 1.45;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qc-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast);
}
.queue-row:hover .qc-actions,
.queue-row:focus-within .qc-actions,
.queue-row.dragging .qc-actions {
  opacity: 1;
  pointer-events: auto;
}
.qc-btn {
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  border-radius: var(--r-2xs);
  color: var(--text-muted);
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.qc-btn svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.qc-btn:hover {
  background: rgba(255, 180, 84, 0.18);
  color: var(--text-on-orange);
}
.qc-btn.guide:hover {
  background: rgba(126, 212, 185, 0.24);
  color: var(--text-on-mint);
}
.qc-btn.danger:hover {
  background: rgba(255, 107, 107, 0.14);
  color: var(--text-on-red);
}
/* 面板底部的「等待发送」状态条：所有排队消息共用一条 */
.queue-status {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  margin-top: var(--space-6);
  padding: var(--space-6) var(--space-8) 0;
  border-top: 1px solid rgba(224, 188, 125, 0.22);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
}
.queue-status-icon {
  display: grid;
  place-items: center;
  color: var(--text-muted);
}
.queue-status-icon svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
  animation: qc-wait 1.8s ease-in-out infinite;
}
@keyframes qc-wait {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}
.queue-status-text {
  line-height: 1.4;
}
.qc-att {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--fs-2xs);
  color: var(--text-muted);
}
.qc-att svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}
.qc-cancel {
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  border-radius: var(--r-2xs);
  color: var(--text-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
}
.qc-cancel:hover {
  background: rgba(255, 107, 107, 0.14);
  color: var(--text-on-red);
}
/* 拖动时跟着鼠标走的浮动卡片 */
.queue-ghost {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9999;
  pointer-events: none;
  will-change: transform;
}
.queue-ghost-inner {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-height: 36px;
  padding: 0 var(--space-8) 0 var(--space-4);
  border-radius: var(--r-sm);
  border: 1px solid rgba(255, 180, 84, 0.85);
  background: var(--glass-bg-strong);
  box-shadow: 0 16px 34px rgba(90, 58, 74, 0.24), 0 3px 8px rgba(90, 58, 74, 0.12);
  transform: rotate(-1.2deg) scale(1.02);
  transition: transform 0.16s ease, opacity 0.16s ease;
}
.queue-ghost-inner.leaving {
  opacity: 0;
  transform: rotate(0deg) scale(0.96);
}
.ghost-grip {
  opacity: 0.75;
  pointer-events: none;
}
@media (hover: none) {
  .qc-grip,
  .qc-actions {
    opacity: 1;
    pointer-events: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .queue-status-icon svg {
    animation: none;
  }
  .queue-ghost-inner {
    transition: none;
  }
}
.guidance-tag {
  display: inline-block;
  margin-bottom: 3px;
  padding: 0 var(--space-6);
  border-radius: var(--r-pill);
  background: rgba(126, 212, 185, 0.28);
  color: #2f6b52;
  font-size: var(--fs-2xs);
}
body.queue-dragging {
  user-select: none;
  cursor: grabbing;
}

.composer {
  padding: var(--space-8) var(--space-10);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.composer-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-8);
}
.send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  white-space: nowrap;
}
.stop-icon {
  width: 12px;
  height: 12px;
  fill: currentColor;
}
.safety-btn {
  color: var(--text-secondary);
  min-height: 32px;
  padding: var(--space-4) var(--space-10);
  font-size: var(--fs-xs);
}
.safety-btn.warn {
  color: #94551a;
  background: rgba(255, 209, 102, 0.28);
}
.safety-menu {
  position: fixed;
  z-index: 1600;
  width: 272px;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: var(--r-md);
}
.safety-entry {
  display: flex;
  align-items: flex-start;
  gap: var(--space-10);
  padding: var(--space-8) var(--space-10);
  border: none;
  background: none;
  border-radius: var(--r-sm);
  cursor: pointer;
  text-align: left;
}
.safety-entry:hover:not(:disabled) {
  background: var(--glass-bg-strong);
}
.safety-entry:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.se-check {
  width: 20px;
  flex-shrink: 0;
  text-align: center;
  color: var(--text-primary);
}
.se-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.se-title {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  font-weight: 600;
}
.safety-entry.on .se-title {
  color: var(--text-on-orange);
}
.se-desc {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.5;
}
.se-note {
  margin: var(--space-4) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  text-align: center;
}
.attach-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-8);
  align-items: center;
}
/* 输入区下方的小按钮：高度取「发送按钮 44px」与原来 32px」的中间值，图标再放大一档 */
.attach-row .btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  min-height: 38px;
}
.attach-row .ico {
  font-size: 16px;
  line-height: 1;
}
.attach-btn {
  min-height: 32px;
  padding: var(--space-4) var(--space-10);
  font-size: var(--fs-xs);
}
.file-input {
  display: none;
}
.composer-input {
  flex: 1;
  resize: none;
  max-height: 33dvh; /* 输入框最高不超过可视区高度的 1/3 */
  min-height: 44px;
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  font-family: inherit;
  line-height: 1.5;
  overflow-y: auto;
}
.pending-atts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
}
.pending-att {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.pa-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: var(--r-sm);
  border: 1px solid var(--glass-border);
  cursor: zoom-in;
}
.pa-name {
  font-size: var(--fs-xs);
  background: var(--glass-bg-strong);
  padding: 6px 10px;
  border-radius: var(--r-sm);
}
.pa-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border-radius: var(--r-full);
  border: none;
  background: #e06055;
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

@media (max-width: 768px) {
  .ai-page {
    flex-direction: column;
    height: calc(100dvh - 140px);
  }
  .msg-nav {
    display: none;
  }
  .ai-msgs {
    padding-right: var(--space-6);
  }
  /* 小屏：会话栏变横向滚动条 */
  .ai-sidebar {
    width: 100%;
    flex-direction: row;
    align-items: center;
    overflow-x: auto;
    padding: var(--space-8);
  }
  .new-chat-btn {
    width: auto;
    flex-shrink: 0;
  }
  .session-list {
    flex-direction: row;
    overflow-y: hidden;
    overflow-x: auto;
  }
  .session-row {
    flex-shrink: 0;
    max-width: 160px;
    border: 1px solid var(--glass-border);
    background: var(--glass-bg);
  }
  .session-row .row-more {
    opacity: 1;
  }
  .bubble {
    max-width: 88%;
  }
  .send-btn {
    min-height: 44px;
  }
  .attach-btn,
  .safety-btn {
    flex: 1;
    min-height: 38px;
    justify-content: center;
  }
}

/* ── 图片灯箱（与成长记录同一套观感，不提供下载） ── */
.lb-overlay {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: rgba(20, 16, 12, 0.72);
  backdrop-filter: blur(6px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-12);
  z-index: 1600;
  padding: var(--space-24);
}
.lb-img {
  position: absolute;
  top: 50%;
  left: 50%;
  max-width: calc(100vw - 48px);
  max-height: 80vh;
  border-radius: var(--r-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
  transform: translate(-50%, -50%);
  cursor: zoom-in;
  user-select: none;
  -webkit-user-drag: none;
  touch-action: none;
}
.lb-img.is-zoomed { cursor: grab; }
.lb-img.is-dragging { cursor: grabbing; }
.lb-hint {
  position: absolute;
  bottom: var(--space-24);
  left: 50%;
  transform: translateX(-50%);
  color: rgba(255, 255, 255, 0.65);
  font-size: var(--fs-xs);
  white-space: nowrap;
  pointer-events: none;
}
.lb-fade-enter-active,
.lb-fade-leave-active { transition: opacity var(--dur-base); }
.lb-fade-enter-from,
.lb-fade-leave-to { opacity: 0; }
</style>
