<script setup lang="ts">
/**
 * 背包弹窗 —— 孩子端看自己的背包、家长端看某个孩子的背包
 * props.childId 空 = 孩子端（后端用登录态）；有值 = 家长端（后端按 childId 查）
 *
 * 2026-11-14 改版：物品以网格卡片展示，按状态分组；
 * 家长端底部有「操作记录」历史（赠送 / 兑换入包 / 使用 / 拿走，精确到时分）。
 *
 * 两端文案与操作完全区分：
 * - 孩子端：提示「去商城兑换/等爸爸妈妈送你」，未使用道具可「使用」，
 *   被家长拿走的道具在「已被拿走」分组里可见（含理由）
 * - 家长端：提示「去商城赠送或点下方按钮」，未使用道具可「拿走」（必填理由，可返还积分），
 *   顶部有「赠送物品」按钮直接送道具（必填理由），家长不能替孩子「使用」道具
 */
import { ref, watch, onMounted, computed } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import EmptyState from '@/components/EmptyState.vue';
import CategoryIcon from '@/components/CategoryIcon.vue';
import GiftModal from '@/components/GiftModal.vue';

const props = defineProps<{
  modelValue: boolean;
  childId?: number;
  childName?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  changed: [];
}>();

const toast = useToastStore();

/** 家长模式：传了 childId 即为家长查看孩子背包 */
const isParent = computed(() => props.childId != null);

interface BackpackItem {
  id: number;
  product_id: number | null;
  name: string;
  icon: string;
  description: string;
  cost: number;
  status: 'unused' | 'used';
  acquired_at: number;
  used_at: number | null;
  use_note: string | null;
  /** exchange = 孩子自己兑换；gift = 家长赠送 */
  source?: 'exchange' | 'gift';
  /** 非 null = 已被家长拿走（行保留，不再删除） */
  taken_at?: number | null;
  take_reason?: string | null;
  take_refund?: number;
}

const items = ref<BackpackItem[]>([]);
const loading = ref(false);

/** 待使用：没被用过、也没被拿走 */
const unusedItems = computed(() => items.value.filter((i) => i.status === 'unused' && !i.taken_at));
/** 孩子自己用掉的 */
const usedItems = computed(() => items.value.filter((i) => i.status === 'used' && !i.taken_at));
/** 被家长拿走的（保留行，两端都展示） */
const takenItems = computed(() => items.value.filter((i) => !!i.taken_at).sort((a, b) => (b.taken_at ?? 0) - (a.taken_at ?? 0)));

async function load(silent = false) {
  if (!props.modelValue) return;
  if (!silent) loading.value = true;
  try {
    const url = props.childId ? `/backpack/child/${props.childId}` : '/backpack';
    const data = await api.get<{ items: BackpackItem[] }>(url);
    items.value = data.items;
  } catch (e: any) {
    if (!silent) toast.error(e.message || '加载背包失败');
  } finally {
    if (!silent) loading.value = false;
  }
}

onMounted(() => { if (props.modelValue) { load(); loadLogs(); } });
watch(() => props.modelValue, (v) => {
  if (v) {
    load();
    loadLogs();
    // 每次打开都重置子弹窗状态，避免上次操作残留
    pickOpen.value = false;
    giftOpen.value = false;
  }
});

function fmtTime(ts: number) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 历史记录时间：精确到时分，跨天/跨年补日期 */
function fmtLogTime(ts: number) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// ── 家长端：操作记录（背包历史） ─────────────────────────────────────
interface BackpackLog {
  id: number;
  action: 'gift' | 'exchange' | 'use' | 'take';
  item_name: string;
  icon: string;
  quantity: number;
  detail: string;
  refund_points: number;
  actor_role: 'parent' | 'child';
  actor_label: string;
  created_at: number;
}
const logs = ref<BackpackLog[]>([]);
const logsLoading = ref(false);

async function loadLogs() {
  if (!isParent.value || !props.childId) return;
  logsLoading.value = true;
  try {
    const d = await api.get<{ logs: BackpackLog[] }>(`/backpack/logs?childId=${props.childId}`);
    logs.value = d.logs;
  } catch {
    /* 历史加载失败不阻塞背包展示 */
  } finally {
    logsLoading.value = false;
  }
}

const LOG_META: Record<BackpackLog['action'], { emoji: string; cls: string; verb: string }> = {
  gift: { emoji: '🎁', cls: 'log-gift', verb: '赠送了' },
  exchange: { emoji: '🛒', cls: 'log-exchange', verb: '兑换了' },
  use: { emoji: '✨', cls: 'log-use', verb: '使用了' },
  take: { emoji: '🗑️', cls: 'log-take', verb: '拿走了' },
};

function logText(l: BackpackLog) {
  const who = l.actor_label || (l.actor_role === 'parent' ? '家长' : '孩子');
  const q = l.quantity > 1 ? ` ×${l.quantity}` : '';
  return `${who} ${LOG_META[l.action].verb}「${l.item_name}」${q}`;
}

// ── 孩子端：使用道具 ────────────────────────────────────────────────
const useOpen = ref(false);
const useItem = ref<BackpackItem | null>(null);
const useNote = ref('');
function openUse(item: BackpackItem) {
  useItem.value = item;
  useNote.value = '';
  useOpen.value = true;
}
async function confirmUse() {
  if (!useItem.value) return;
  try {
    await api.post(`/backpack/${useItem.value.id}/use`, { note: useNote.value.trim() });
    toast.success(`「${useItem.value.name}」已使用 ✨`);
    useOpen.value = false;
    await load(true);
    emit('changed');
  } catch (e: any) { toast.error(e.message); }
}

// ── 家长端：拿走道具（必填理由，可返还积分） ─────────────────────────
const takeOpen = ref(false);
const takeItem = ref<BackpackItem | null>(null);
const takeReason = ref('');
const takeRefund = ref<number | null>(null);
function openTake(item: BackpackItem) {
  takeItem.value = item;
  takeReason.value = '';
  takeRefund.value = item.cost > 0 ? item.cost : null;
  takeOpen.value = true;
}
async function confirmTake() {
  if (!takeItem.value) return;
  if (!takeReason.value.trim()) return toast.warning('请填写拿走理由，让孩子知道为什么');
  try {
    const body: any = { reason: takeReason.value.trim() };
    if (takeRefund.value !== null) body.refundPoints = takeRefund.value;
    await api.post(`/backpack/${takeItem.value.id}/take`, body);
    toast.success(`已从背包拿走「${takeItem.value.name}」，孩子会收到通知`);
    takeOpen.value = false;
    await load(true);
    loadLogs();
    emit('changed');
  } catch (e: any) { toast.error(e.message); }
}

// ── 家长端：赠送物品（先选商品，再填理由） ───────────────────────────
interface PickProduct {
  id: number;
  name: string;
  image: string;
  cost: number;
  kind?: 'goods' | 'prop';
  prop_desc?: string;
  wish_only?: number;
  status?: string;
  variants?: any[];
}
const pickOpen = ref(false);
const pickLoading = ref(false);
const pickProducts = ref<PickProduct[]>([]);
const giftOpen = ref(false);
const giftProduct = ref<PickProduct | null>(null);

async function openPicker() {
  pickOpen.value = true;
  pickLoading.value = true;
  try {
    const data = await api.get<{ products: PickProduct[] }>('/products');
    // 可赠送：上架中、非许愿专用、无规格（带规格的商品后端暂不支持赠送）
    pickProducts.value = (data.products ?? []).filter(
      (p) => p.status === 'active' && p.wish_only !== 1 && (!p.variants || p.variants.length === 0)
    );
  } catch (e: any) {
    toast.error(e.message || '加载商品失败');
  } finally {
    pickLoading.value = false;
  }
}
function chooseProduct(p: PickProduct) {
  pickOpen.value = false;
  giftProduct.value = p;
  giftOpen.value = true;
}
function onGifted() {
  // 赠送成功 → 刷新背包列表 + 历史 + 通知外层（总览页）
  load(true);
  loadLogs();
  emit('changed');
}
</script>

<template>
  <!-- 主背包弹窗 -->
  <Modal
    :model-value="modelValue && !useOpen && !takeOpen && !pickOpen && !giftOpen"
    variant="playful"
    width="640px"
    :title="childName ? `${childName} 的背包` : '🎒 我的背包'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- 家长端顶部操作条：直接赠送物品 -->
    <div v-if="isParent" class="bp-toolbar">
      <span class="bp-toolbar-hint">可以送孩子道具，也可以拿走已兑换的道具</span>
      <button class="bp-gift-btn" @click="openPicker">🎁 赠送物品</button>
    </div>

    <EmptyState
      v-if="!loading && items.length === 0"
      emoji="🎒"
      :text="isParent ? `${childName ?? '孩子'}的背包是空的` : '背包是空的'"
      :hint="isParent ? '点右上角「赠送物品」送 TA 一个道具吧~' : '去商城兑换道具，或者等爸爸妈妈送你~'"
    />

    <template v-else>
      <!-- 待使用 / 未使用 -->
      <div v-if="unusedItems.length > 0" class="bp-section">
        <div class="bp-section-title">
          <span>{{ isParent ? '📦 未使用' : '📦 待使用' }}（{{ unusedItems.length }}）</span>
        </div>
        <div class="bp-grid">
          <div v-for="i in unusedItems" :key="i.id" class="bp-card">
            <span v-if="i.source === 'gift'" class="bp-source-badge" title="家长赠送">🎁 送</span>
            <CategoryIcon :icon="i.icon" :size="56" class="bp-icon" />
            <div class="bp-name" :title="i.name">{{ i.name }}</div>
            <div class="bp-meta">
              <span v-if="i.cost > 0" class="bp-cost">{{ i.cost }} 🌟</span>
              <span v-else class="bp-cost bp-free">免费</span>
              <span class="bp-time">{{ fmtTime(i.acquired_at) }}</span>
            </div>
            <button v-if="!isParent" class="bp-btn bp-use" @click="openUse(i)">使用</button>
            <button
              v-else
              class="bp-btn bp-take"
              :title="i.cost > 0 ? `拿走这${i.cost}分道具（可返还积分）` : '拿走这个赠送的道具'"
              @click="openTake(i)"
            >拿走</button>
          </div>
        </div>
      </div>

      <!-- 已使用：两端都保留历史 -->
      <div v-if="usedItems.length > 0" class="bp-section">
        <div class="bp-section-title">
          <span>✅ 已使用（{{ usedItems.length }}）</span>
        </div>
        <div class="bp-grid">
          <div v-for="i in usedItems" :key="i.id" class="bp-card bp-card-used">
            <CategoryIcon :icon="i.icon" :size="48" class="bp-icon" />
            <div class="bp-name" :title="i.name">{{ i.name }}</div>
            <span class="bp-state-badge bp-state-used">✅ 已使用</span>
            <div class="bp-meta">
              <span class="bp-time">于 {{ fmtTime(i.used_at!) }} 使用</span>
            </div>
            <div v-if="i.use_note" class="bp-note" :title="i.use_note">{{ i.use_note }}</div>
          </div>
        </div>
      </div>

      <!-- 已被拿走：行保留，两端都能看到（含理由与返还积分） -->
      <div v-if="takenItems.length > 0" class="bp-section">
        <div class="bp-section-title">
          <span>🗑️ 已被拿走（{{ takenItems.length }}）</span>
        </div>
        <div class="bp-grid">
          <div v-for="i in takenItems" :key="i.id" class="bp-card bp-card-taken">
            <CategoryIcon :icon="i.icon" :size="44" class="bp-icon" />
            <div class="bp-name" :title="i.name">{{ i.name }}</div>
            <span class="bp-state-badge bp-state-taken">🗑️ 已被拿走</span>
            <div class="bp-meta">
              <span class="bp-time">{{ fmtTime(i.taken_at!) }}</span>
              <span v-if="(i.take_refund ?? 0) > 0" class="bp-refund">返 {{ i.take_refund }} 🌟</span>
            </div>
            <div v-if="i.take_reason" class="bp-note" :title="i.take_reason">理由：{{ i.take_reason }}</div>
          </div>
        </div>
      </div>

      <!-- 家长端：操作记录（历史） -->
      <div v-if="isParent" class="bp-section bp-logs-section">
        <div class="bp-section-title">
          <span>📜 操作记录</span>
        </div>
        <div v-if="logsLoading" class="bp-logs-loading">加载中...</div>
        <div v-else-if="logs.length === 0" class="bp-logs-empty">还没有操作记录，赠送、兑换、使用、拿走都会记在这里</div>
        <div v-else class="bp-logs">
          <div v-for="l in logs" :key="l.id" class="bp-log" :class="LOG_META[l.action].cls">
            <span class="bp-log-emoji">{{ LOG_META[l.action].emoji }}</span>
            <div class="bp-log-main">
              <div class="bp-log-text">{{ logText(l) }}</div>
              <div v-if="l.detail || (l.action === 'take' && l.refund_points > 0)" class="bp-log-sub">
                <span v-if="l.action === 'take' && l.refund_points > 0" class="bp-log-refund">返还 {{ l.refund_points }} 🌟</span>
                <span v-if="l.detail" class="bp-log-detail" :title="l.detail">{{ l.detail }}</span>
              </div>
            </div>
            <span class="bp-log-time">{{ fmtLogTime(l.created_at) }}</span>
          </div>
        </div>
      </div>
    </template>
  </Modal>

  <!-- 商品选择（家长赠送第一步） -->
  <Modal
    v-if="pickOpen"
    :model-value="pickOpen"
    variant="playful"
    width="440px"
    title="🎁 选择要赠送的商品"
    @update:model-value="pickOpen = $event"
  >
    <div v-if="pickLoading" class="pick-loading">加载中...</div>
    <EmptyState
      v-else-if="pickProducts.length === 0"
      emoji="🛒"
      text="没有可赠送的商品"
      hint="带规格或已下架的商品暂不支持赠送，先去商城上架一个吧"
    />
    <div v-else class="pick-grid">
      <button v-for="p in pickProducts" :key="p.id" class="pick-card" @click="chooseProduct(p)">
        <CategoryIcon :icon="p.image || 'gift'" :size="48" />
        <span class="pick-name">{{ p.name }}</span>
        <span class="pick-cost">
          <template v-if="p.kind === 'prop'">{{ p.cost > 0 ? `${p.cost} 🌟` : '免费道具' }}</template>
          <template v-else>{{ p.cost }} 🌟</template>
        </span>
      </button>
    </div>
  </Modal>

  <!-- 赠送理由（家长赠送第二步，复用 GiftModal，锁定孩子） -->
  <GiftModal
    v-if="giftOpen"
    v-model="giftOpen"
    :product="giftProduct"
    :fixed-child-id="childId"
    :fixed-child-name="childName"
    @gifted="onGifted"
  />

  <!-- 孩子端：使用弹窗 -->
  <Modal
    v-if="useOpen && useItem"
    :model-value="useOpen"
    variant="playful"
    width="360px"
    title="✨ 使用道具"
    @update:model-value="useOpen = $event"
  >
    <div class="use-confirm">
      <CategoryIcon :icon="useItem.icon" :size="56" />
      <div class="use-name">{{ useItem.name }}</div>
      <p v-if="useItem.description" class="use-desc">{{ useItem.description }}</p>
      <textarea v-model="useNote" rows="2" maxlength="200" placeholder="使用备注（选填）" />
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="useOpen = false">取消</button>
      <button class="btn btn-primary" @click="confirmUse">确认使用</button>
    </template>
  </Modal>

  <!-- 家长端：拿走弹窗（必填理由 + 可返还积分） -->
  <Modal
    v-if="takeOpen && takeItem"
    :model-value="takeOpen"
    variant="playful"
    width="360px"
    title="🗑️ 从背包拿走"
    @update:model-value="takeOpen = $event"
  >
    <div class="take-form">
      <div class="take-item-head">
        <CategoryIcon :icon="takeItem.icon" :size="44" />
        <div>
          <div class="take-item-name">{{ takeItem.name }}</div>
          <div v-if="takeItem.cost > 0" class="take-item-cost">原兑换价：{{ takeItem.cost }} 🌟</div>
          <div v-else class="take-item-cost">赠送物品</div>
        </div>
      </div>
      <div class="take-field">
        <label>拿走理由 <em>*</em></label>
        <textarea v-model="takeReason" rows="2" maxlength="200" placeholder="告诉孩子为什么要拿走这个道具" />
      </div>
      <div v-if="takeItem.cost > 0" class="take-field">
        <label>返还给孩子的积分</label>
        <div class="take-refund-row">
          <button class="refund-preset" @click="takeRefund = takeItem!.cost">全额返还（{{ takeItem.cost }} 分）</button>
          <button class="refund-preset" @click="takeRefund = 0">不返还</button>
          <input v-model.number="takeRefund" type="number" min="0" :max="takeItem!.cost" placeholder="自定义" />
        </div>
      </div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="takeOpen = false">取消</button>
      <button class="btn btn-danger" @click="confirmTake">确认拿走</button>
    </template>
  </Modal>
</template>

<style scoped>
/* ── 家长端顶部操作条 ── */
.bp-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-10);
  padding: var(--space-8) var(--space-12);
  margin-bottom: var(--space-12);
  border-radius: var(--r-md);
  background: rgba(130, 192, 255, 0.12);
  border: 1px dashed rgba(130, 192, 255, 0.45);
}
.bp-toolbar-hint { font-size: var(--fs-xs); color: var(--text-secondary); }
.bp-gift-btn {
  flex-shrink: 0;
  padding: var(--space-6) var(--space-14);
  border-radius: var(--r-sm);
  background: linear-gradient(135deg, rgba(130, 192, 255, 0.35), rgba(80, 144, 220, 0.25));
  border: 1px solid rgba(130, 192, 255, 0.55);
  color: var(--text-on-sky);
  font-size: var(--fs-xs);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: all var(--dur-fast);
}
.bp-gift-btn:hover { transform: translateY(-1px); box-shadow: 0 3px 10px rgba(80, 144, 220, 0.3); }

.bp-section { display: flex; flex-direction: column; gap: var(--space-10); margin-bottom: var(--space-16); }
.bp-section:last-child { margin-bottom: 0; }
.bp-section-title {
  font-size: var(--fs-sm); color: var(--text-muted);
  padding-bottom: var(--space-6); border-bottom: 1px solid var(--glass-border);
}

/* ── 网格卡片 ── */
.bp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-10);
}
.bp-card {
  position: relative;
  display: flex; flex-direction: column; align-items: center; gap: var(--space-4);
  padding: var(--space-14) var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  text-align: center;
  min-width: 0;
  transition: transform var(--dur-fast), box-shadow var(--dur-fast);
}
.bp-card:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08); }
/* 家长赠送来源角标 */
.bp-source-badge {
  position: absolute; top: var(--space-6); right: var(--space-6);
  padding: 2px var(--space-6);
  border-radius: var(--r-full);
  font-size: var(--fs-2xs);
  background: rgba(130, 192, 255, 0.18);
  color: var(--text-on-sky);
  border: 1px solid rgba(130, 192, 255, 0.4);
}
.bp-icon { flex-shrink: 0; }
.bp-name {
  font-family: var(--font-cute); font-size: var(--fs-md);
  max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bp-meta {
  font-size: var(--fs-2xs); color: var(--text-muted);
  display: flex; gap: var(--space-6); align-items: center; flex-wrap: wrap; justify-content: center;
}
.bp-cost { color: var(--text-on-yellow); font-size: var(--fs-xs); }
.bp-free { color: var(--text-on-mint); }
.bp-refund { color: var(--text-on-mint); }
.bp-note {
  font-size: var(--fs-2xs); color: var(--text-muted); line-height: 1.4;
  max-width: 100%;
  display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

/* 卡片操作按钮：占满卡片底部 */
.bp-btn {
  width: 100%;
  margin-top: var(--space-4);
  padding: var(--space-6) 0;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs); font-weight: 600; white-space: nowrap;
}
.bp-use { background: var(--accent-mint); color: #1d4a3c; }
.bp-use:hover { filter: brightness(1.05); }
.bp-take { background: rgba(255, 122, 122, 0.15); color: var(--text-on-red); }
.bp-take:hover { background: rgba(255, 122, 122, 0.28); }

/* 已使用 / 已被拿走的卡片状态 */
.bp-card-used { opacity: 0.62; }
.bp-card-taken { opacity: 0.55; background: transparent; border-style: dashed; }
.bp-state-badge {
  padding: 2px var(--space-8);
  border-radius: var(--r-full);
  font-size: var(--fs-2xs); font-weight: 600;
}
.bp-state-used { background: rgba(110, 200, 160, 0.18); color: #2a6a4f; }
.bp-state-taken { background: rgba(255, 122, 122, 0.15); color: var(--text-on-red); }

/* ── 家长端操作记录 ── */
.bp-logs-section { margin-top: var(--space-4); }
.bp-logs-loading, .bp-logs-empty {
  font-size: var(--fs-xs); color: var(--text-muted);
  padding: var(--space-10); text-align: center;
}
.bp-logs {
  display: flex; flex-direction: column;
  max-height: 240px; overflow-y: auto;
  scrollbar-width: thin;
}
.bp-log {
  display: flex; align-items: flex-start; gap: var(--space-8);
  padding: var(--space-8) var(--space-6);
  border-bottom: 1px dashed var(--glass-border);
}
.bp-log:last-child { border-bottom: none; }
.bp-log-emoji { flex-shrink: 0; font-size: var(--fs-md); line-height: 1.2; }
.bp-log-main { flex: 1; min-width: 0; }
.bp-log-text { font-size: var(--fs-xs); color: var(--text-primary); line-height: 1.4; }
.bp-log-sub {
  display: flex; gap: var(--space-8); align-items: baseline; margin-top: 2px;
  font-size: var(--fs-2xs); color: var(--text-muted);
}
.bp-log-refund { color: var(--text-on-mint); flex-shrink: 0; }
.bp-log-detail {
  max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bp-log-time { flex-shrink: 0; font-size: var(--fs-2xs); color: var(--text-muted); }
/* 动作着色：左侧竖线 + emoji 微底色，一眼区分动作类型 */
.bp-log { border-left: 3px solid transparent; border-radius: var(--r-sm); }
.log-gift { border-left-color: rgba(130, 192, 255, 0.65); }
.log-exchange { border-left-color: rgba(255, 209, 102, 0.75); }
.log-use { border-left-color: rgba(110, 200, 160, 0.75); }
.log-take { border-left-color: rgba(255, 122, 122, 0.65); }

/* ── 商品选择网格 ── */
.pick-loading { text-align: center; color: var(--text-muted); padding: var(--space-20); }
.pick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: var(--space-10);
  max-height: 320px;
  overflow-y: auto;
}
.pick-card {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-4);
  padding: var(--space-10) var(--space-6);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 2px solid transparent;
  cursor: pointer;
  transition: all var(--dur-fast);
  min-width: 0;
}
.pick-card:hover { border-color: var(--accent-yellow); background: rgba(255, 209, 102, 0.12); }
.pick-name {
  font-size: var(--fs-xs);
  max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pick-cost { font-size: var(--fs-2xs); color: var(--text-on-yellow); }

.use-confirm { display: flex; flex-direction: column; align-items: center; gap: var(--space-8); }
.use-name { font-family: var(--font-cute); font-size: var(--fs-lg); }
.use-desc { font-size: var(--fs-xs); color: var(--text-muted); text-align: center; }
textarea { width: 100%; padding: var(--space-10); border-radius: var(--r-sm); background: var(--glass-bg); border: 1px solid var(--glass-border); font-family: inherit; font-size: var(--fs-sm); resize: vertical; }

.take-form { display: flex; flex-direction: column; gap: var(--space-12); }
.take-item-head { display: flex; align-items: center; gap: var(--space-10); padding: var(--space-10); background: var(--glass-bg); border-radius: var(--r-md); }
.take-item-name { font-family: var(--font-cute); font-size: var(--fs-md); }
.take-item-cost { font-size: var(--fs-xs); color: var(--text-muted); margin-top: 2px; }
.take-field { display: flex; flex-direction: column; gap: var(--space-6); }
.take-field label { font-size: var(--fs-xs); color: var(--text-secondary); }
.take-field em { color: var(--text-on-red); font-style: normal; margin-left: 2px; }
.take-refund-row { display: flex; gap: var(--space-6); align-items: center; flex-wrap: wrap; }
.refund-preset {
  padding: var(--space-4) var(--space-10); border-radius: var(--r-sm); font-size: var(--fs-xs);
  background: var(--glass-bg); border: 1px solid var(--glass-border);
}
.take-refund-row input { width: 90px; padding: var(--space-8); border-radius: var(--r-sm); background: var(--glass-bg); border: 1px solid var(--glass-border); }

.btn-danger { background: rgba(255, 122, 122, 0.9); color: #fff; }
.btn-danger:hover { background: rgba(255, 100, 100, 1); }
</style>
