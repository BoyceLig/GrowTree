<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';

/**
 * 心愿单审核弹窗（供统一审核面板使用）。
 *
 * 调用方必须已经通过 /wish-requests/:id/claim 抢到锁；本组件只负责补充商品信息、
 * 提交通过/不通过，以及**关闭时主动释放锁**，避免其他家长被一个已经离开的弹窗挡住。
 */

interface Category {
  id: number;
  name: string;
  hidden: number;
}

interface WishReviewItem {
  id: number;
  child_name: string;
  title: string;
  reason: string;
  estimated_points: number | null;
  status: string;
  locked_by_me: boolean;
}

const props = defineProps<{
  modelValue: boolean;
  item: WishReviewItem | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  done: [];
}>();

const toast = useToastStore();
const categories = ref<Category[]>([]);
const saving = ref(false);
const submitted = ref(false);
const form = reactive({ name: '', cost: '', stock: '-1', category_id: '', note: '' });

const title = () => (props.item ? `审核 ${props.item.child_name} 的心愿` : '审核心愿');

async function loadCategories() {
  try {
    const res = await api.get<{ categories: Category[] }>('/product-categories');
    categories.value = res.categories.filter((c) => c.hidden === 0);
  } catch {
    categories.value = [];
  }
}

watch(
  () => props.item,
  (it) => {
    if (!it) return;
    form.name = it.title;
    form.cost = it.estimated_points ? String(it.estimated_points) : '100';
    form.stock = '-1';
    form.category_id = '';
    form.note = '';
    submitted.value = false;
    loadCategories();
  },
  { immediate: true }
);

async function close() {
  const it = props.item;
  emit('update:modelValue', false);
  if (!submitted.value && it && it.locked_by_me) {
    try {
      await api.post(`/wish-requests/${it.id}/release`);
    } catch {
      /* 锁已超时 / 已被接手，忽略 */
    }
    emit('done');
  }
  submitted.value = false;
}

async function onOpenChange(v: boolean) {
  if (v) {
    emit('update:modelValue', true);
    return;
  }
  await close();
}

async function submit(approve: boolean) {
  const it = props.item;
  if (!it || saving.value) return;

  const note = form.note.trim();
  if (!approve && !note) {
    return toast.error('不通过时请写一下原因，孩子会看到');
  }

  let body: Record<string, unknown> = { approve, note: note || undefined };
  if (approve) {
    const name = form.name.trim();
    const cost = Number(form.cost);
    const stock = form.stock.trim() === '' ? -1 : Number(form.stock);
    if (!name) return toast.error('请填写上架的商品名称');
    if (!Number.isInteger(cost) || cost <= 0) return toast.error('所需积分要填大于 0 的整数');
    if (!Number.isInteger(stock) || stock < -1) return toast.error('库存填 -1 表示不限，或填 0 以上的整数');
    body = {
      ...body,
      name,
      cost,
      stock,
      category_id: form.category_id ? Number(form.category_id) : null,
    };
  }

  saving.value = true;
  try {
    await api.post(`/wish-requests/${it.id}/review`, body);
    submitted.value = true;
    emit('update:modelValue', false);
    toast.success(approve ? '已通过，商品已上架商城' : '已标记为不通过');
    emit('done');
  } catch (e: any) {
    toast.error(e.message || '提交失败');
    // 锁被其他家长接手 / 孩子撤回：关掉弹窗，让列表刷新到最新状态
    if (e?.status === 409) {
      submitted.value = true;
      emit('update:modelValue', false);
      emit('done');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="title()"
    width="500px"
    :close-on-mask="false"
    :close-on-esc="!saving"
    @update:model-value="onOpenChange"
  >
    <div v-if="item" class="wish-form">
      <div class="review-origin">
        <div class="ro-label">孩子的心愿</div>
        <div class="ro-title">{{ item.title }}</div>
        <p class="ro-reason">{{ item.reason }}</p>
        <span v-if="item.estimated_points" class="points-chip">预计 {{ item.estimated_points }} 分</span>
        <span v-else class="points-chip muted">积分待定</span>
      </div>

      <label class="field">
        <span class="field-label">上架商品名称 <em>必填</em></span>
        <input v-model="form.name" maxlength="50" placeholder="商城里的商品名" />
      </label>

      <div class="field-row">
        <label class="field">
          <span class="field-label">所需积分 <em>必填</em></span>
          <input v-model="form.cost" type="number" min="1" max="99999" inputmode="numeric" />
        </label>
        <label class="field">
          <span class="field-label">库存 <span class="optional">-1 表示不限</span></span>
          <input v-model="form.stock" type="number" min="-1" max="99999" inputmode="numeric" />
        </label>
      </div>

      <label class="field">
        <span class="field-label">放进哪个分类</span>
        <select v-model="form.category_id">
          <option value="">不分类</option>
          <option v-for="c in categories" :key="c.id" :value="String(c.id)">{{ c.name }}</option>
        </select>
      </label>

      <label class="field">
        <span class="field-label">审核留言 <span class="optional">不通过时必填</span></span>
        <textarea
          v-model="form.note"
          rows="3"
          maxlength="200"
          placeholder="例如：这次先不通过，等你把房间整理坚持两周再来许愿"
        ></textarea>
        <span class="field-hint">通过时可以不填；不通过的原因孩子会看到</span>
      </label>

      <div class="lock-note">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.6" />
          <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
        </svg>
        你正在审核，其他家长暂时不能操作；关闭弹窗会释放这个心愿
      </div>

      <div class="form-actions">
        <button class="btn btn-ghost" type="button" :disabled="saving" @click="close">取消</button>
        <button class="btn btn-danger" type="button" :disabled="saving" @click="submit(false)">不通过</button>
        <button class="btn btn-primary" type="button" :disabled="saving" @click="submit(true)">
          {{ saving ? '提交中…' : '通过并上架' }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.wish-form { display: flex; flex-direction: column; gap: var(--space-14); }
.field { display: flex; flex-direction: column; gap: var(--space-6); }
.field-label {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-secondary);
}
.field-label em {
  font-style: normal;
  font-size: var(--fs-2xs);
  font-weight: 500;
  color: var(--text-on-red);
  background: rgba(255, 140, 160, 0.14);
  border-radius: var(--r-2xs);
  padding: 1px var(--space-4);
  margin-left: var(--space-4);
}
.optional {
  font-size: var(--fs-xs);
  font-weight: 400;
  color: var(--text-muted);
  margin-left: var(--space-4);
}
.field-hint { font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-10); }

.review-origin {
  padding: var(--space-12);
  border-radius: var(--r-md);
  border: 1px dashed rgba(255, 180, 84, 0.55);
  background: rgba(255, 250, 238, 0.7);
}
.ro-label { font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: var(--space-4); }
.ro-title { font-family: var(--font-cute); font-size: var(--fs-lg); }
.ro-reason {
  margin: var(--space-6) 0 var(--space-8);
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
.points-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--space-8);
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  background: rgba(255, 180, 84, 0.16);
  color: var(--text-on-orange);
}
.points-chip.muted { background: rgba(90, 58, 74, 0.06); color: var(--text-muted); }

.lock-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-6);
  padding: var(--space-8) var(--space-10);
  border-radius: var(--r-sm);
  background: rgba(132, 197, 255, 0.12);
  color: var(--text-on-sky);
  font-size: var(--fs-xs);
  line-height: 1.5;
}
.lock-note svg { width: 14px; height: 14px; flex-shrink: 0; margin-top: 1px; }

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-10);
  flex-wrap: wrap;
  margin-top: var(--space-4);
}

@media (max-width: 560px) {
  .field-row { grid-template-columns: 1fr; }
  .form-actions .btn { flex: 1; }
}
</style>
