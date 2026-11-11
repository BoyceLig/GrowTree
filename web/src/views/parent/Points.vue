<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import GlassCard from '@/components/GlassCard.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import EmptyState from '@/components/EmptyState.vue';
import PointItemEditor from '@/components/PointItemEditor.vue';
import Modal from '@/components/Modal.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const toast = useToastStore();

interface Child { id: number; name: string; avatar: string; total_points: number }
interface PointItem {
  id: number;
  name: string;
  type: 'gain' | 'loss';
  points: number;
  daily_limit: number;
  enabled: number;
  is_default: number;
  owner_id: number | null;
}

const children = ref<Child[]>([]);
const items = ref<PointItem[]>([]);
const loading = ref(true);
// 页面级孩子复选：默认不选任何孩子，点分值按钮/临时加减分前必须先勾选
const selectedChildIds = ref<number[]>([]);
const tab = ref<'gain' | 'loss'>('gain');

// 编辑器
const editorOpen = ref(false);
const editingItem = ref<PointItem | null>(null);

// 临时加减分弹窗
const adjustOpen = ref(false);
const adjustNote = ref('');
const adjustDelta = ref(5); // 正加分 负扣分
const adjustType = ref<'gain' | 'loss'>('gain');
const adjustSaving = ref(false);
const adjustChildIds = ref<number[]>([]); // 批量：选中的孩子
const adjustConfirmOpen = ref(false); // 提交前的二次确认

function toggleChild(id: number) {
  const i = selectedChildIds.value.indexOf(id);
  if (i >= 0) selectedChildIds.value.splice(i, 1);
  else selectedChildIds.value.push(id);
}

function toggleAdjustChild(id: number) {
  const i = adjustChildIds.value.indexOf(id);
  if (i >= 0) adjustChildIds.value.splice(i, 1);
  else adjustChildIds.value.push(id);
}

// 可见项目：未选孩子时显示全部（通用 + 所有专属）；选了则显示通用 + 所选孩子的专属项
const visibleItems = computed(() => {
  return items.value.filter(
    (i) => i.type === tab.value && i.enabled && (i.owner_id === null || selectedChildIds.value.includes(i.owner_id))
  );
});

async function load() {
  loading.value = true;
  try {
    const childRes = await api.get<{ children: Child[] }>('/children');
    children.value = childRes.children;
    await loadItems();
  } finally {
    loading.value = false;
  }
}

async function loadItems() {
  const itemRes = await api.get<{ items: PointItem[] }>('/point-items');
  items.value = itemRes.items;
}

// ── 常规项目打卡（同样走复选 + 二次确认） ─────────────────────────────────

const applyConfirmOpen = ref(false);
const applyTarget = ref<PointItem | null>(null);

const applyConfirmMessage = computed(() => {
  const names = selectedChildIds.value
    .map((id) => children.value.find((c) => c.id === id)?.name ?? '')
    .filter(Boolean)
    .join('、');
  const it = applyTarget.value;
  if (!it) return '';
  return `将给 ${names} ${it.type === 'gain' ? '加' : '扣'} ${Math.abs(it.points)} 分（项目：${it.name}），请确认`;
});

function requestApply(item: PointItem) {
  if (selectedChildIds.value.length === 0) {
    toast.warning('请先点击上方头像，选择要操作的小朋友');
    return;
  }
  applyTarget.value = item;
  applyConfirmOpen.value = true;
}

async function doApply() {
  const ids = [...selectedChildIds.value];
  const item = applyTarget.value;
  if (!item) return;
  const okNames: string[] = [];
  for (const id of ids) {
    const c = children.value.find((x) => x.id === id);
    try {
      const res = await api.post<{ ok: boolean; newBalance: number; delta: number }>(
        '/point-items/apply',
        { userId: id, itemId: item.id }
      );
      if (c) c.total_points = res.newBalance;
      okNames.push(c?.name ?? String(id));
    } catch (e: any) {
      if (e.payload?.error === 'daily_limit_reached') {
        toast.warning(`${c?.name ?? '小朋友'} 今日「${item.name}」已达上限`);
      } else {
        toast.error(`${c?.name ?? '小朋友'} 操作失败：${e.message || '未知错误'}`);
      }
    }
  }
  if (okNames.length > 0) {
    toast.success(`已给 ${okNames.join('、')} ${item.points > 0 ? '+' : ''}${item.points} 分`);
  }
}

function openEditor(item?: PointItem) {
  editingItem.value = item ?? null;
  editorOpen.value = true;
}

function openAdjust() {
  adjustNote.value = '';
  adjustDelta.value = 5;
  adjustType.value = 'gain';
  // 所有复选默认不选，由家长自行勾选
  adjustChildIds.value = [];
  adjustOpen.value = true;
}

/** 计算实际分值：类型决定正负 */
function adjustDeltaValue(): number {
  return adjustType.value === 'gain' ? Math.abs(adjustDelta.value) : -Math.abs(adjustDelta.value);
}

/** 二次确认弹窗里的文案：明确给谁、加还是减、几分 */
const adjustConfirmMessage = computed(() => {
  const names = adjustChildIds.value
    .map((id) => children.value.find((c) => c.id === id)?.name ?? '')
    .filter(Boolean)
    .join('、');
  const d = adjustDeltaValue();
  return `将给 ${names} ${d > 0 ? '加' : '减'} ${Math.abs(d)} 分（事项：${adjustNote.value.trim() || '未填写'}），请确认`;
});

function submitAdjust() {
  if (adjustChildIds.value.length === 0) {
    toast.warning('请选择至少一个小朋友');
    return;
  }
  if (!adjustNote.value.trim()) {
    toast.warning('请输入事项');
    return;
  }
  if (adjustDeltaValue() === 0) {
    toast.warning('分值不能为0');
    return;
  }
  // 弹出确认窗口，列出对象与分值，避免批量误操作
  adjustConfirmOpen.value = true;
}

async function doAdjust() {
  const ids = [...adjustChildIds.value];
  const delta = adjustDeltaValue();
  const note = adjustNote.value.trim();
  adjustSaving.value = true;
  const okNames: string[] = [];
  try {
    for (const id of ids) {
      const c = children.value.find((x) => x.id === id);
      try {
        const res = await api.post<{ ok: boolean; newBalance: number; delta: number }>(
          '/point-items/adjust',
          { userId: id, delta, note }
        );
        if (c) c.total_points = res.newBalance;
        okNames.push(c?.name ?? String(id));
      } catch (e: any) {
        toast.error(`${c?.name ?? '小朋友'} 操作失败：${e.message || '未知错误'}`);
      }
    }
    if (okNames.length > 0) {
      toast.success(`已给 ${okNames.join('、')} ${delta > 0 ? '+' : ''}${delta} 分`);
      adjustOpen.value = false;
    }
  } finally {
    adjustSaving.value = false;
  }
}

/**
 * 另一个家长新建/改了/删了积分项目 → 静默重拉项目列表。
 * 只调 loadItems（不调 load）：load 会把整页切回 loading 骨架，闪一下很难看，
 * 而且孩子余额没变、不需要重拉。
 */
function onItemsChanged(): void {
  void loadItems();
}

onMounted(() => {
  void load();
  window.addEventListener('ws:point_items_changed', onItemsChanged);
});

onUnmounted(() => {
  window.removeEventListener('ws:point_items_changed', onItemsChanged);
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1 class="title">积分管理</h1>
        <p class="subtitle">先点头像选择小朋友（可多选），再点分值打卡或临时加减分</p>
      </div>
    </header>

    <!-- 小孩复选条：默认全部不选 -->
    <div v-if="children.length > 0" class="child-bar">
      <button
        v-for="c in children"
        :key="c.id"
        :class="['child-chip', { active: selectedChildIds.includes(c.id) }]"
        @click="toggleChild(c.id)"
      >
        <ZodiacAvatar :zodiac="c.avatar" :size="40" />
        <div class="chip-info">
          <span class="chip-name">{{ c.name }}</span>
          <span class="chip-pts">{{ c.total_points }} 分 🌟</span>
        </div>
        <span v-if="selectedChildIds.includes(c.id)" class="chip-check">✓</span>
      </button>
    </div>
    <p v-if="children.length > 0" class="select-hint">
      {{ selectedChildIds.length === 0 ? '还没选小朋友：点分值按钮会提醒先选择' : `已选 ${selectedChildIds.length} 个小朋友` }}
    </p>

    <EmptyState
      v-if="!loading && children.length === 0"
      emoji="🐣"
      text="还没有小朋友"
      hint="去总览页新增一个吧~"
    />

    <template v-else-if="children.length > 0">
      <!-- 切换 加分 / 扣分 -->
      <div class="tabs">
        <button :class="{ active: tab === 'gain' }" @click="tab = 'gain'">
          <span class="emoji">🌟</span> 加分项目
        </button>
        <button :class="{ active: tab === 'loss' }" @click="tab = 'loss'">
          <span class="emoji">📉</span> 扣分项目
        </button>
        <button class="add-btn" @click="openEditor()">＋ 自定义项目</button>
      </div>

      <EmptyState
        v-if="visibleItems.length === 0"
        emoji="📭"
        :text="tab === 'gain' ? '还没有加分项' : '还没有扣分项'"
        hint="点击上方「自定义项目」新增"
      />

      <!-- 常规项长条 -->
      <div v-else class="item-list">
        <GlassCard
          v-for="item in visibleItems"
          :key="item.id"
          hover
          padding="10px 14px"
          :class="['item-card', item.type]"
        >
          <div class="item-info" @click="openEditor(item)">
            <span class="item-name">{{ item.name }}</span>
            <span class="item-limit">每日 {{ item.daily_limit === 0 ? '不限' : item.daily_limit + ' 次' }}</span>
          </div>
          <span class="item-edit" @click="openEditor(item)">✏️</span>
          <button
            :class="['apply-btn', item.type]"
            @click="requestApply(item)"
          >
            {{ item.points > 0 ? '+' : '' }}{{ item.points }}
          </button>
        </GlassCard>
      </div>

      <!-- 底部：临时加减分卡片 -->
      <GlassCard hover padding="16px" class="adjust-card" clickable label="临时加减分" @click="openAdjust">
        <div class="adjust-inner">
          <span class="adjust-icon">✏️</span>
          <div class="adjust-text">
            <div class="adjust-title">临时加减分</div>
            <div class="adjust-hint">今天临时表现好/不好？记一笔</div>
          </div>
          <span class="adjust-arrow">›</span>
        </div>
      </GlassCard>
    </template>

    <!-- 编辑器 -->
    <PointItemEditor
      v-if="editorOpen"
      v-model="editorOpen"
      :item="editingItem"
      :default-type="tab"
      :owner-id="selectedChildIds.length === 1 ? selectedChildIds[0] : null"
      @saved="loadItems"
    />

    <!-- 临时加减分弹窗 -->
    <Modal
      v-if="adjustOpen"
      :model-value="adjustOpen"
      title="临时加减分"
      @update:model-value="adjustOpen = $event"
    >
      <div class="form">
        <div class="field">
          <label class="label">选择小朋友（可多选）</label>
          <div class="child-grid">
            <button
              v-for="c in children"
              :key="c.id"
              type="button"
              :class="['pick-chip', { active: adjustChildIds.includes(c.id) }]"
              @click="toggleAdjustChild(c.id)"
            >
              <ZodiacAvatar :zodiac="c.avatar" :size="40" />
              <span class="pick-name">{{ c.name }}</span>
              <span v-if="adjustChildIds.includes(c.id)" class="check">✓</span>
            </button>
          </div>
          <p class="pick-hint">{{ adjustChildIds.length === 0 ? '还没选小朋友' : `已选 ${adjustChildIds.length} 个小朋友` }}</p>
        </div>

        <div class="field">
          <label class="label">类型</label>
          <div class="type-tabs">
            <button type="button" :class="{ active: adjustType === 'gain' }" @click="adjustType = 'gain'">🌟 加分</button>
            <button type="button" :class="{ active: adjustType === 'loss' }" @click="adjustType = 'loss'">📉 扣分</button>
          </div>
        </div>

        <div class="field">
          <label class="label">分值</label>
          <input v-model.number="adjustDelta" type="number" min="1" max="999" />
        </div>

        <div class="field">
          <label class="label">事项</label>
          <input v-model="adjustNote" type="text" maxlength="100" placeholder="如：今天主动洗碗" />
        </div>
      </div>

      <template #footer>
        <span style="flex:1"></span>
        <button class="btn btn-ghost" @click="adjustOpen = false">取消</button>
        <button class="btn btn-primary" :disabled="adjustSaving" @click="submitAdjust">
          {{ adjustSaving ? '提交中...' : '提交' }}
        </button>
      </template>
    </Modal>

    <!-- 提交前的二次确认：列出对象、动作与分值 -->
    <ConfirmDialog
      v-model="adjustConfirmOpen"
      title="请确认操作"
      :message="adjustConfirmMessage"
      confirm-text="确认提交"
      cancel-text="再改改"
      @confirm="doAdjust"
    />

    <!-- 常规项目打卡的二次确认 -->
    <ConfirmDialog
      v-model="applyConfirmOpen"
      title="请确认操作"
      :message="applyConfirmMessage"
      confirm-text="确认提交"
      cancel-text="再改改"
      @confirm="doApply"
    />
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: var(--space-16);
  gap: var(--space-12);
}
.title { font-size: var(--fs-3xl); margin-bottom: var(--space-2); }
.subtitle { color: var(--text-secondary); font-size: var(--fs-sm); }

.child-bar {
  display: flex;
  gap: var(--space-8);
  margin-bottom: var(--space-8);
  overflow-x: auto;
  /* 横向滚动容器会连带裁剪纵向溢出（对号 -6px 悬出卡片外），
     上下预留空间让 ✓ 完整显示 */
  padding: var(--space-10) var(--space-2) var(--space-4);
}
.child-chip {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-8) var(--space-12);
  border-radius: var(--r-lg);
  background: var(--glass-bg);
  border: 2px solid transparent;
  transition: all var(--dur-base);
  flex-shrink: 0;
  cursor: pointer;
}
.child-chip.active {
  border-color: var(--accent-yellow);
  background: rgba(255, 209, 102, 0.15);
}
.chip-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.2;
}
.chip-name {
  font-family: var(--font-cute);
  font-size: var(--fs-sm);
}
.chip-pts {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.chip-check {
  position: absolute;
  top: -6px;
  right: -4px;
  width: 20px;
  height: 20px;
  border-radius: var(--r-full);
  background: var(--accent-yellow);
  color: #fff;
  font-size: 12px;
  font-weight: bold;
  display: flex;
  align-items: center;
  justify-content: center;
}
.child-chip { position: relative; }
.select-hint {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin: calc(var(--space-8) * -1) 0 var(--space-12);
  padding-left: var(--space-4);
}

.tabs {
  display: flex;
  background: var(--glass-bg);
  border-radius: var(--r-md);
  padding: var(--space-4);
  gap: var(--space-4);
  margin-bottom: var(--space-16);
  align-items: center;
}
.tabs button {
  flex: 1;
  padding: var(--space-10) var(--space-8);
  border-radius: var(--r-sm);
  color: var(--text-secondary);
  font-weight: 600;
  transition: all var(--dur-base);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-6);
  font-size: var(--fs-sm);
}
.tabs button.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
  box-shadow: var(--shadow-pill);
}
.tabs .add-btn {
  flex: 0 0 auto;
  background: var(--accent-yellow);
  color: #fff;
  padding: var(--space-10) var(--space-14);
  font-size: var(--fs-sm);
}
.tabs .add-btn:hover {
  filter: brightness(1.05);
}

.item-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
  margin-bottom: var(--space-16);
}

.adjust-card {
  cursor: pointer;
  border: 2px dashed var(--glass-border);
}
.adjust-inner {
  display: flex;
  align-items: center;
  gap: var(--space-12);
}
.adjust-icon {
  font-size: var(--fs-3xl);
}
.adjust-text {
  flex: 1;
}
.adjust-title {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
}
.adjust-hint {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-top: var(--space-2);
}
.adjust-arrow {
  font-size: var(--fs-3xl);
  color: var(--text-muted);
}
.item-card {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  border: 1px solid var(--glass-border);
}
.item-card.gain {
  border-color: rgba(126, 212, 185, 0.35);
  background: linear-gradient(to right, rgba(126, 212, 185, 0.09), #ffffff 50%);
}
.item-card.loss {
  border-color: rgba(255, 155, 176, 0.5);
  background: linear-gradient(to right, rgba(255, 155, 176, 0.12), #ffffff 50%);
}
.item-info {
  flex: 1;
  min-width: 0;
  cursor: pointer;
  text-align: left;
}
.item-name {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-limit {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-top: var(--space-2);
  display: block;
}
.item-edit {
  font-size: var(--fs-sm);
  opacity: 0.5;
  cursor: pointer;
  flex-shrink: 0;
}
.apply-btn {
  min-width: 68px;
  padding: var(--space-8) var(--space-18);
  border-radius: var(--r-md);
  font-family: var(--font-cute);
  font-size: var(--fs-lg);
  transition: all var(--dur-fast);
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  flex-shrink: 0;
}
.apply-btn:hover { transform: translateY(-1px); }
.apply-btn:active { transform: scale(0.94); }
.apply-btn.gain {
  color: var(--text-on-mint);
  background: rgba(126, 212, 185, 0.15);
  border-color: rgba(126, 212, 185, 0.35);
}
.apply-btn.gain:hover {
  background: rgba(126, 212, 185, 0.22);
  box-shadow: 0 6px 18px rgba(126, 212, 185, 0.25);
}
.apply-btn.loss {
  color: var(--text-on-pink);
  background: rgba(255, 155, 176, 0.15);
  border-color: rgba(255, 155, 176, 0.35);
}
.apply-btn.loss:hover {
  background: rgba(255, 155, 176, 0.22);
  box-shadow: 0 6px 18px rgba(255, 155, 176, 0.25);
}

.form { display: flex; flex-direction: column; gap: var(--space-18); }
.field { display: flex; flex-direction: column; gap: var(--space-8); }
.label { font-size: var(--fs-sm); color: var(--text-secondary); padding-left: var(--space-4); }
.selected-child {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  padding: var(--space-8) var(--space-12);
  background: var(--glass-bg);
  border-radius: var(--r-md);
  font-family: var(--font-cute);
}
/* 批量选择孩子的网格（与任务编辑器风格一致） */
.child-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
  gap: var(--space-10);
}
.pick-chip {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-6);
  padding: var(--space-10) var(--space-4);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 2px solid transparent;
  transition: all var(--dur-base);
  cursor: pointer;
}
.pick-chip.active {
  border-color: var(--accent-yellow);
  background: rgba(255, 209, 102, 0.15);
}
.pick-name {
  font-family: var(--font-cute);
  font-size: var(--fs-xs);
  color: var(--text-primary);
}
.pick-chip .check {
  position: absolute;
  top: -6px;
  right: -4px;
  width: 18px;
  height: 18px;
  border-radius: var(--r-full);
  background: var(--accent-yellow);
  color: #fff;
  font-size: 11px;
  font-weight: bold;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pick-hint {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  padding-left: var(--space-4);
}
.type-tabs {
  display: flex;
  background: var(--glass-bg);
  border-radius: var(--r-md);
  padding: var(--space-4);
  gap: var(--space-4);
}
.type-tabs button {
  flex: 1;
  padding: var(--space-10);
  border-radius: var(--r-sm);
  color: var(--text-secondary);
  font-weight: 600;
  transition: all var(--dur-base);
}
.type-tabs button.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
  box-shadow: var(--shadow-pill);
}
input {
  width: 100%;
  padding: var(--space-12) var(--space-14);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  font-size: var(--fs-md);
  color: var(--text-primary);
  font-family: var(--font-cute);
}
input:focus {
  outline: none;
  border-color: var(--accent-yellow);
}

@media (max-width: 768px) {
  .page-header { flex-direction: column; align-items: stretch; }
}
</style>
