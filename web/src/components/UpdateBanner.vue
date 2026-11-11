<script setup lang="ts">
/**
 * 新版本提示条 + 一键升级弹窗
 * ---------------------------------------------------------------
 * 打开家长端时静默查一次阿里云仓库的最新版本（后端 /api/update/status，
 * 10 分钟缓存）。有新版就在顶栏下方浮出一条提示；点「立即升级」让同 compose
 * 里的 Watchtower 去拉新镜像并重建容器。
 *
 * 三种结局：
 *   1) 具备一键升级   → 调 /api/update/apply → 轮询等新版本起来 → 自动刷新
 *   2) 没有 Watchtower → 直接给出 docker 命令 + 复制按钮（优雅降级，不报错）
 *   3) 查询失败/无新版 → 什么都不显示，绝不影响正常使用
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '@/api/client';
import Modal from '@/components/Modal.vue';
import { useToastStore } from '@/stores/toast';

interface UpdateStatus {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  canAutoUpdate: boolean;
  manualCommand: string;
  ok: boolean;
  checkedAt: number;
  error?: string;
}

interface ApplyResult {
  ok: boolean;
  message: string;
  manualCommand?: string;
}

interface ChangeGroup {
  title: string;
  items: string[];
}

interface ChangeVersion {
  version: string;
  date: string;
  groups: ChangeGroup[];
}

interface RemoteChangelog {
  ok: boolean;
  source: 'remote' | 'local';
  latest: string | null;
  versions: ChangeVersion[];
  error?: string;
}

const toast = useToastStore();

const status = ref<UpdateStatus | null>(null);
const checking = ref(false);
const dismissed = ref(false);
const modalOpen = ref(false);
/** idle=仅提示  applying=正在下发  upgrading=等待重启  manual=需手动执行 */
const phase = ref<'idle' | 'applying' | 'upgrading' | 'manual'>('idle');
const manualCmd = ref('');
const copied = ref(false);
// 降级为手动升级时，弹窗里显示**具体原因**（后端会给出精准文案：
// 缺 watchtower 标签 / 云端 latest 标签未更新 / 拉镜像失败 …），
// 不能一律写"没有启用一键升级"——那样用户看不出问题出在哪。
const manualReason = ref('当前服务器没有启用一键升级，请登录部署设备执行下面这条命令：');
const manualHint = ref('命令执行完，刷新本页面即可。以后只要部署时带上 watchtower 服务，就能直接在这里一键升级。');
let disposed = false;

// ── 查看新版更新内容 ──
// 新版本的说明还没进当前运行的镜像，后端会去代码仓库读最新的 CHANGELOG.md
// （公开仓库，匿名可读）。拉不到时后端退回镜像里已有的记录并给 ok=false，
// 这里就说明"这还不是新版本的说明"，绝不显示空白弹窗。
const clOpen = ref(false);
const clLoading = ref(false);
const cl = ref<RemoteChangelog | null>(null);

/** 弹窗里展示的那一版：优先匹配用户要升级的版本，匹配不到就用仓库里最新的一版 */
const clVersion = computed<ChangeVersion | null>(() => {
  const list = cl.value?.versions ?? [];
  const target = status.value?.latest;
  return list.find((v) => v.version === target) ?? list[0] ?? null;
});

/** 拿到的说明是否就是提示条上那个待升级的版本 */
const clIsTarget = computed(
  () => !!clVersion.value && clVersion.value.version === status.value?.latest,
);

async function openChangelog() {
  clOpen.value = true;
  if (cl.value || clLoading.value) return;
  clLoading.value = true;
  try {
    cl.value = await api.get<RemoteChangelog>('/update/changelog');
  } catch (e: any) {
    cl.value = {
      ok: false,
      source: 'local',
      latest: null,
      versions: [],
      error: e?.message || '获取更新说明失败',
    };
  } finally {
    clLoading.value = false;
  }
}

/** 看完更新内容直接升级：先收起这个弹窗，再走原来的升级流程 */
function upgradeFromChangelog() {
  clOpen.value = false;
  onUpgradeClick();
}

const DISMISS_KEY = 'growtree:update-dismissed';

async function check(opts: { silent?: boolean; force?: boolean } = {}) {
  if (!opts.silent) checking.value = true;
  try {
    const q = opts.force ? '?force=1' : '';
    const s = await api.get<UpdateStatus>(`/update/status${q}`);
    // 容器重启期间 /status 会被旧进程应答，current 仍是旧值 —— 以服务端返回为准
    status.value = s;
    if (!opts.silent) {
      if (!s.ok) toast.error(s.error ? `检查更新失败：${s.error}` : '检查更新失败');
      else if (!s.hasUpdate) toast.success(`已是最新版本 v${s.current} 🎉`);
      else toast.info(`发现新版本 v${s.latest ?? ''}`);
    }
    if (s.hasUpdate && sessionStorage.getItem(DISMISS_KEY) !== s.latest) {
      dismissed.value = false;
    }
  } catch (e: any) {
    if (!opts.silent) toast.error(e?.message || '检查更新失败');
  } finally {
    checking.value = false;
  }
}

function dismiss() {
  dismissed.value = true;
  if (status.value?.latest) sessionStorage.setItem(DISMISS_KEY, status.value.latest);
}

async function onUpgradeClick() {
  manualCmd.value = status.value?.manualCommand || 'docker compose pull growtree && docker compose up -d growtree';
  copied.value = false;
  manualReason.value = '当前服务器没有启用一键升级，请登录部署设备执行下面这条命令：';
  manualHint.value =
    '命令执行完，刷新本页面即可。以后只要部署时带上 watchtower 服务，就能直接在这里一键升级。';

  if (!status.value?.canAutoUpdate) {
    phase.value = 'manual';
    modalOpen.value = true;
    return;
  }

  phase.value = 'applying';
  modalOpen.value = true;

  // 后端要等 watchtower 把容器停稳、重建完才返回（NAS 上 30~60 秒很常见），
  // 所以不傻等这个请求：3 秒后就开始轮询，用轮询结果判断"升级中/已完成"。
  // apply 的返回值只在**失败**时用来决定是否降级为手动命令。
  const req = api.post<ApplyResult>('/update/apply');
  const grace = window.setTimeout(() => {
    if (phase.value === 'applying') {
      phase.value = 'upgrading';
      startPolling();
    }
  }, 3000);

  try {
    const res = await req;
    if (!res.ok) {
      window.clearTimeout(grace);
      manualCmd.value = res.manualCommand || manualCmd.value;
      if (res.message) manualReason.value = `${res.message}：`;
      manualHint.value = '命令执行完，刷新本页面即可。';
      phase.value = 'manual';
      toast.warning(res.message || '自动升级未启动，请手动执行');
    } else if (phase.value === 'applying') {
      // 请求很快返回成功：立即进入轮询
      window.clearTimeout(grace);
      phase.value = 'upgrading';
      startPolling();
    }
  } catch (e: any) {
    window.clearTimeout(grace);
    // ⚠️ 关键分支：升级成功时，watchtower 会**把本容器停掉重建**，
    // 于是这个还在飞行的 HTTP 请求会被直接掐断（Failed to fetch / 连接重置）。
    // 这不是失败，恰恰是升级正在进行的典型现象 —— 交给轮询去确认最终结果，
    // 绝不能弹「请手动升级」，否则用户会以为没升成功、又去手动跑一遍。
    if (phase.value === 'upgrading') return;
    manualReason.value = '升级服务没有响应，请登录部署设备执行下面这条命令：';
    manualHint.value = '命令执行完，刷新本页面即可。';
    phase.value = 'manual';
    toast.error(e?.message || '升级请求失败');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询等新容器起来：watchtower 重建期间请求会失败，属预期，静默忽略 */
async function startPolling() {
  const target = status.value?.latest;
  for (let i = 0; i < 60; i++) {
    if (disposed) return;
    await sleep(5000);
    if (disposed || phase.value !== 'upgrading') return; // 已降级为手动 / 页面已卸载
    try {
      const s = await api.get<UpdateStatus>('/update/status?force=1');
      if (s.ok && target && s.current === target) {
        toast.success(`已升级到 v${target}，正在刷新…`);
        await sleep(1200);
        location.reload();
        return;
      }
    } catch {
      // 容器正在重启 —— 继续等
    }
  }
  if (disposed) return;
  toast.warning('升级等待超时，请稍后手动刷新页面查看结果');
  modalOpen.value = false;
  phase.value = 'idle';
}

async function copyCmd() {
  try {
    await navigator.clipboard.writeText(manualCmd.value);
    copied.value = true;
    toast.success('命令已复制');
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    toast.error('复制失败，请手动选中复制');
  }
}

function onSettingsCheck() {
  dismissed.value = false;
  check({ force: true });
}

onMounted(() => {
  check({ silent: true });
  window.addEventListener('growtree:check-update', onSettingsCheck);
});

onUnmounted(() => {
  disposed = true;
  window.removeEventListener('growtree:check-update', onSettingsCheck);
});
</script>

<template>
  <!-- 提示条：只在确实有新版本、且用户没点过「稍后」时出现 -->
  <Transition name="banner-drop">
    <div v-if="status?.hasUpdate && !dismissed" class="update-banner">
      <span class="ub-icon">🌳</span>
      <div class="ub-text">
        <div class="ub-title">发现新版本 <b>v{{ status.latest }}</b></div>
        <div class="ub-sub">当前 v{{ status.current }}</div>
      </div>
      <button class="ub-btn ghost" @click="openChangelog">查看更新</button>
      <button class="ub-btn primary" @click="onUpgradeClick">立即升级</button>
      <button class="ub-btn ghost" @click="dismiss">稍后</button>
    </div>
  </Transition>

  <!-- 新版更新内容：只展示待升级那一版，够短，一眼看完 -->
  <Modal
    v-model="clOpen"
    :title="`v${status?.latest ?? ''} 更新内容`"
    width="460px"
  >
    <p v-if="clLoading" class="cl-state">正在获取更新说明…</p>

    <div v-else class="cl-body">
      <p v-if="cl && !cl.ok" class="cl-warn">
        ⚠️ {{ cl.error || '暂时获取不到更新说明' }}。下面显示的是当前已安装版本的记录，
        升级后可在「设置 → 关于成长树」查看完整更新日志。
      </p>

      <template v-if="clVersion">
        <div class="release">
          <div class="release-head">
            <strong>{{ clVersion.version }}</strong>
            <span v-if="clVersion.date" class="date">{{ clVersion.date }}</span>
            <span v-if="!clIsTarget" class="tag-old">尚未发布</span>
          </div>
          <div v-for="(g, gi) in clVersion.groups" :key="gi" class="group">
            <div v-if="g.title" class="group-title">{{ g.title }}</div>
            <ul>
              <li v-for="(it, ii) in g.items" :key="ii">{{ it }}</li>
            </ul>
          </div>
        </div>

        <p v-if="!clIsTarget" class="cl-note">仓库里的更新说明还没写到 v{{ status?.latest }}，先看看最近这版。</p>
        <p v-else class="cl-note">更早的版本可在「设置 → 关于成长树」里查看。</p>
      </template>

      <p v-else class="cl-state">这个版本没有附带更新说明</p>
    </div>

    <template #footer>
      <button class="btn" @click="clOpen = false">关闭</button>
      <button class="btn btn-primary" @click="upgradeFromChangelog">立即升级</button>
    </template>
  </Modal>

  <Modal v-model="modalOpen" :title="phase === 'manual' ? '手动升级' : '版本升级'" width="460px" :close-on-mask="phase !== 'applying' && phase !== 'upgrading'">
    <!-- 正在下发 / 正在重启 -->
    <div v-if="phase === 'applying' || phase === 'upgrading'" class="up-flow">
      <div class="spinner"></div>
      <p class="up-msg">
        {{ phase === 'applying' ? '正在通知升级服务…' : '正在拉取新镜像并重启，请稍候…' }}
      </p>
      <p class="up-hint">通常需要 30 秒到 2 分钟。期间页面可能短暂打不开，属于正常现象，<b>不要关闭这个页面</b>，升级完成后会自动刷新。</p>
    </div>

    <!-- 需要手动执行 -->
    <div v-else class="up-manual">
      <p class="up-msg">{{ manualReason }}</p>
      <div class="cmd-box">
        <code>{{ manualCmd }}</code>
        <button class="copy-btn" @click="copyCmd">{{ copied ? '已复制' : '复制' }}</button>
      </div>
      <p class="up-hint">{{ manualHint }}</p>
    </div>

    <template #footer>
      <button v-if="phase !== 'applying' && phase !== 'upgrading'" class="btn btn-primary" @click="modalOpen = false">知道了</button>
    </template>
  </Modal>
</template>

<style scoped>
.update-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-8) var(--space-16);
  background: linear-gradient(135deg, rgba(126, 212, 185, 0.22), rgba(255, 209, 102, 0.22));
  border-bottom: 1px solid rgba(126, 212, 185, 0.35);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}
.ub-icon {
  font-size: var(--fs-lg);
  line-height: 1;
  flex-shrink: 0;
}
.ub-text {
  flex: 1;
  min-width: 0;
}
.ub-title {
  font-size: var(--fs-sm);
  color: var(--text-primary);
}
.ub-title b {
  font-family: var(--font-cute);
  color: var(--text-on-mint);
}
.ub-sub {
  font-size: var(--fs-2xs);
  color: var(--text-muted);
  margin-top: var(--space-2);
}
.ub-btn {
  flex-shrink: 0;
  padding: var(--space-6) var(--space-12);
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  font-weight: 700;
  transition: all var(--dur-fast);
  cursor: pointer;
}
.ub-btn.primary {
  background: linear-gradient(135deg, var(--accent-mint), #57c3a2);
  color: #fff;
}
.ub-btn.primary:hover {
  filter: brightness(1.05);
  transform: translateY(-1px);
}
.ub-btn.ghost {
  background: transparent;
  color: var(--text-secondary);
}
.ub-btn.ghost:hover {
  background: rgba(255, 255, 255, 0.5);
}

.banner-drop-enter-active,
.banner-drop-leave-active {
  transition: opacity var(--dur-base) ease, transform var(--dur-base) ease;
}
.banner-drop-enter-from,
.banner-drop-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}

.up-flow {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-12);
  padding: var(--space-12) 0;
  text-align: center;
}
.spinner {
  width: 40px;
  height: 40px;
  border-radius: var(--r-full);
  border: 3px solid rgba(126, 212, 185, 0.3);
  border-top-color: var(--accent-mint);
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.up-msg {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  line-height: 1.6;
}
.up-hint {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.7;
}
.up-manual {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}
.cmd-box {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-10) var(--space-12);
  background: rgba(90, 58, 74, 0.06);
  border-radius: var(--r-md);
}
.cmd-box code {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fs-xs);
  color: var(--text-primary);
  word-break: break-all;
  line-height: 1.6;
}
.copy-btn {
  flex-shrink: 0;
  padding: var(--space-6) var(--space-12);
  border-radius: var(--r-pill);
  background: var(--glass-bg-strong);
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--dur-fast);
}
.copy-btn:hover {
  background: #fff;
}

/* ── 新版更新内容弹窗 ── */
.cl-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}
.cl-state {
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  padding: var(--space-16) 0;
}
.cl-warn {
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-secondary);
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  background: rgba(255, 209, 102, 0.18);
}
.cl-note {
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-muted);
  padding-left: var(--space-4);
}

.release {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  padding: var(--space-12) var(--space-14);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
}
.release-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-8);
}
.release-head strong {
  font-size: var(--fs-md);
  color: var(--text-primary);
}
.release-head .date {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.tag-old {
  margin-left: auto;
  padding: var(--space-2) var(--space-8);
  border-radius: var(--r-pill);
  font-size: var(--fs-2xs);
  color: var(--text-muted);
  background: rgba(90, 58, 74, 0.07);
}

.group {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.group-title {
  font-size: var(--fs-xs);
  color: var(--accent-orange);
  font-weight: 500;
}
.group ul {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  padding-left: var(--space-14);
  list-style: disc;
}
.group li {
  font-size: var(--fs-sm);
  line-height: 1.55;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

/* 手机：提示条上有 3 个按钮，收紧间距与内边距，别把标题挤没了 */
@media (max-width: 520px) {
  .update-banner {
    gap: var(--space-6);
    padding: var(--space-8) var(--space-10);
  }
  .ub-icon {
    display: none;
  }
  .ub-btn {
    padding: var(--space-6) var(--space-8);
    font-size: var(--fs-2xs);
  }
}
</style>
