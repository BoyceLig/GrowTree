<script setup lang="ts">
/**
 * 家长赠送商品给孩子的弹窗 —— 独立于商品类型（礼物/道具都能送）
 * props.fixedChildId 有值时锁定赠送对象（家长从「孩子背包」里发起赠送），隐藏孩子选择
 */
import { ref, watch, onMounted } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import CategoryIcon from '@/components/CategoryIcon.vue';

const props = defineProps<{
  modelValue: boolean;
  product?: {
    id: number;
    name: string;
    /** 商品图标；可选：实际显示用 image 优先，icon 只是兜底（背包赠送链路没有 icon） */
    icon?: string;
    image: string;
    cost: number;
    kind?: 'goods' | 'prop';
    prop_desc?: string;
    variants?: any[];
  } | null;
  /** 锁定赠送对象：从背包弹窗发起时由 BackpackModal 传入 */
  fixedChildId?: number;
  /** 锁定对象的名字，用于 toast 与标题 */
  fixedChildName?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  gifted: [];
}>();

const toast = useToastStore();

interface Child { id: number; name: string; avatar: string; }
const children = ref<Child[]>([]);
const childrenLoading = ref(false);
const childId = ref<number | null>(null);
const quantity = ref(1);
const reason = ref('');
const submitting = ref(false);

async function loadChildren(silent = false) {
  if (!silent) childrenLoading.value = true;
  try {
    const data = await api.get<{ children: Child[] }>('/dashboard');
    children.value = data.children ?? [];
    if (!childId.value && children.value.length > 0) childId.value = children.value[0].id;
  } catch {}
  finally { if (!silent) childrenLoading.value = false; }
}

watch(() => props.modelValue, (v) => {
  if (v) {
    quantity.value = 1;
    reason.value = '';
    if (props.fixedChildId != null) {
      // 锁定对象：不用拉孩子列表
      childId.value = props.fixedChildId;
      return;
    }
    if (children.value.length === 0) loadChildren();
    else if (!childId.value && children.value.length > 0) childId.value = children.value[0].id;
  }
});

onMounted(() => {
  if (props.modelValue) {
    if (props.fixedChildId != null) childId.value = props.fixedChildId;
    else loadChildren();
  }
});

function validate() {
  if (!props.product) return false;
  if (props.product.variants && props.product.variants.length > 0) {
    toast.warning('带规格的商品暂不支持直接赠送，请先让孩子自己兑换');
    return false;
  }
  if (!childId.value) {
    toast.warning('请选择要赠送的孩子');
    return false;
  }
  if (!reason.value.trim()) {
    toast.warning('请填写赠送理由，让孩子知道为什么收到这份礼物');
    return false;
  }
  return true;
}

async function submit() {
  if (!validate() || !props.product || !childId.value) return;
  submitting.value = true;
  try {
    await api.post('/backpack/gift', {
      childId: childId.value,
      productId: props.product.id,
      quantity: quantity.value,
      reason: reason.value.trim(),
    });
    const name = props.fixedChildName
      || children.value.find((c) => c.id === childId.value)?.name;
    toast.success(`已送给「${name ?? '孩子'}」，孩子会收到通知 🎒`);
    emit('gifted');
    emit('update:modelValue', false);
  } catch (e: any) { toast.error(e.message); }
  finally { submitting.value = false; }
}
</script>

<template>
  <Modal
    v-if="product"
    :model-value="modelValue"
    variant="playful"
    width="380px"
    title="🎁 赠送商品给孩子"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="gift-product">
      <CategoryIcon :icon="product.image || product.icon" :size="60" />
      <div class="gp-info">
        <div class="gp-name">{{ product.name }}</div>
        <div class="gp-cost">
          <span v-if="product.cost > 0" class="gp-price">原价 {{ product.cost }} 🌟</span>
          <span v-else class="gp-price gp-free">免费道具</span>
          <span class="gp-send">赠送不扣孩子积分</span>
        </div>
        <div v-if="product.prop_desc && product.kind === 'prop'" class="gp-desc">{{ product.prop_desc }}</div>
      </div>
    </div>

    <div class="gift-field">
      <template v-if="fixedChildId != null">
        <!-- 锁定对象：从背包发起时只送这一个孩子 -->
        <label>赠送给</label>
        <div class="gift-fixed-child">👦 {{ fixedChildName || '孩子' }}</div>
      </template>
      <template v-else>
        <label>送给谁 <em>*</em></label>
        <div class="child-grid">
          <button
            v-for="c in children"
            :key="c.id"
            type="button"
            :class="['child-chip', { active: childId === c.id }]"
            @click="childId = c.id"
          >
            <CategoryIcon :icon="c.avatar || 'user'" :size="36" />
            <span>{{ c.name }}</span>
          </button>
        </div>
      </template>
    </div>

    <div class="gift-field">
      <label>数量</label>
      <input v-model.number="quantity" type="number" min="1" max="20" />
    </div>

    <div class="gift-field">
      <label>赠送理由 <em>*</em></label>
      <textarea v-model="reason" rows="2" maxlength="200"
        placeholder="例：这周表现很棒，送你一张免作业券当奖励～" />
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="emit('update:modelValue', false)">取消</button>
      <button class="btn btn-primary" :disabled="submitting" @click="submit">
        {{ submitting ? '发送中...' : '确认赠送' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.gift-product {
  display: flex; gap: var(--space-12); padding: var(--space-10);
  background: var(--glass-bg); border-radius: var(--r-md); margin-bottom: var(--space-14);
}
.gp-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.gp-name { font-family: var(--font-cute); font-size: var(--fs-md); }
.gp-cost { display: flex; gap: var(--space-8); font-size: var(--fs-xs); color: var(--text-muted); margin-top: 2px; }
.gp-price { color: var(--text-on-yellow); }
.gp-price.gp-free { color: var(--text-on-mint); }
.gp-send { color: var(--text-secondary); }
.gp-desc { font-size: var(--fs-xs); color: var(--text-secondary); margin-top: 4px; line-height: 1.4; }

.gift-field { display: flex; flex-direction: column; gap: var(--space-6); margin-bottom: var(--space-12); }
.gift-field label { font-size: var(--fs-xs); color: var(--text-secondary); }
.gift-field em { color: var(--text-on-red); font-style: normal; margin-left: 2px; }
.gift-field input, .gift-field textarea {
  padding: var(--space-10); border-radius: var(--r-sm);
  background: var(--glass-bg); border: 1px solid var(--glass-border);
  font-family: inherit; font-size: var(--fs-sm);
}
.gift-field textarea { resize: vertical; }

.child-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: var(--space-8); }
.child-chip {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-4);
  padding: var(--space-8) var(--space-6); border-radius: var(--r-md);
  background: var(--glass-bg); border: 2px solid transparent;
  cursor: pointer; transition: all var(--dur-base);
}
.child-chip.active { border-color: var(--accent-yellow); background: rgba(255, 209, 102, 0.15); }
.child-chip span { font-size: var(--fs-xs); }
.gift-fixed-child {
  padding: var(--space-8) var(--space-12);
  border-radius: var(--r-sm);
  background: rgba(130, 192, 255, 0.14);
  border: 1px solid rgba(130, 192, 255, 0.4);
  font-size: var(--fs-sm);
  color: var(--text-on-sky);
}
</style>
