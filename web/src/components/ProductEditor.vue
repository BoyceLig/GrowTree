<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import CategoryIcon from '@/components/CategoryIcon.vue';
import IconLightbox from '@/components/IconLightbox.vue';
import CategoryManagerModal from '@/components/CategoryManagerModal.vue';
import { useCategories } from '@/composables/useCategories';
import { useImageUpload } from '@/composables/useImageUpload';

const props = defineProps<{ modelValue: boolean; product?: any }>();
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; saved: [] }>();

const toast = useToastStore();
const { categories, loadCategories } = useCategories();
const { uploading, fileInput, pickImage, onFileChange, ACCEPT } = useImageUpload();

const isEdit = computed(() => !!props.product);
const name = ref('');
/** 商品类型：goods 礼物（需审核）/ prop 道具（直接入背包，可 0 积分） */
const kind = ref<'goods' | 'prop'>('goods');
/** 道具使用说明 */
const propDesc = ref('');
const cost = ref(20);
const stock = ref(-1);
const unlimited = ref(true);
/** 所属分类 —— 决定「没上传图片时」用哪个图标当商品图片 */
const categoryId = ref<number | null>(null);
/** 自定义商品图片（/uploads/xxx.png）；空串 = 没有单独上传，回落到分类图标 */
const image = ref('');
const limitEnabled = ref(false);
const limitDays = ref(7);
const limitCount = ref(1);
const maxPerExchange = ref(1);
/** 商品规格：启用后价格与库存按规格走 */
const variantsEnabled = ref(false);
const variants = ref<{ name: string; cost: number; stock: number }[]>([]);
const saving = ref(false);
const zoomOpen = ref(false);
const categoryManagerOpen = ref(false);

const isCustomImage = computed(() => !!image.value);
const currentCategory = computed(() => categories.value.find((c) => c.id === categoryId.value) ?? null);
/** 预览用图片：有自定义图片用它，否则直接展示分类图标 —— 所见即所得 */
const previewIcon = computed(() => image.value || currentCategory.value?.icon || 'gift');
/** 预览底色：自定义图片时交给 CategoryIcon 自己解析（图片会盖满圆，底色不可见） */
const previewColor = computed(() => (image.value ? '' : currentCategory.value?.color || ''));

function addVariant() {
  variants.value.push({ name: '', cost: cost.value || 10, stock: -1 });
}

function removeVariant(i: number) {
  variants.value.splice(i, 1);
  if (variants.value.length === 0) variantsEnabled.value = false;
}

/** 规格启用时展示的价格区间（列表/预览用） */
const variantRange = computed(() => {
  if (!variantsEnabled.value || variants.value.length === 0) return '';
  const costs = variants.value.map((v) => Number(v.cost) || 0).filter((c) => c > 0);
  if (costs.length === 0) return '';
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  return min === max ? `${min} 分` : `${min} ~ ${max} 分`;
});

// immediate: 组件由 v-if 控制挂载，打开时 modelValue 已是 true，watch 必须立即执行一次才能回填
watch(() => props.modelValue, (open) => {
  if (open) {
    // 分类可能刚被别的窗口改过，打开编辑器就刷一次
    if (categories.value.length === 0) loadCategories();
    if (props.product) {
      name.value = props.product.name;
      kind.value = props.product.kind === 'prop' ? 'prop' : 'goods';
      propDesc.value = props.product.prop_desc || '';
      cost.value = props.product.cost;
      stock.value = props.product.stock;
      unlimited.value = props.product.stock === -1;
      categoryId.value = props.product.category_id ?? null;
      image.value = props.product.icon || '';
      limitEnabled.value = (props.product.limit_count ?? 0) > 0;
      limitDays.value = props.product.limit_days > 0 ? props.product.limit_days : 7;
      limitCount.value = props.product.limit_count > 0 ? props.product.limit_count : 1;
      maxPerExchange.value = Math.max(1, props.product.max_per_exchange ?? 1);
      const vs = Array.isArray(props.product.variants) ? props.product.variants : [];
      variantsEnabled.value = vs.length > 0;
      variants.value = vs.map((v: any) => ({ name: v.name, cost: v.cost, stock: v.stock }));
    } else {
      name.value = '';
      kind.value = 'goods';
      propDesc.value = '';
      cost.value = 20;
      stock.value = -1;
      unlimited.value = true;
      // 新商品默认落在第一个分类：分类同时是「没传图片」时的兜底图片，不该是空的
      categoryId.value = categories.value[0]?.id ?? null;
      image.value = '';
      limitEnabled.value = false;
      limitDays.value = 7;
      limitCount.value = 1;
      maxPerExchange.value = 1;
      variantsEnabled.value = false;
      variants.value = [];
    }
  }
}, { immediate: true });

async function save() {
  if (!name.value.trim()) return toast.warning('请输入商品名称');
  if (categoryId.value == null && !image.value) {
    return toast.warning('请选择商品分类，或上传一张商品图片');
  }
  // 规格暂不支持道具（后端已拦截）
  if (kind.value === 'prop' && variantsEnabled.value) {
    return toast.warning('道具类商品暂不支持多规格，请关闭规格开关');
  }
  if (variantsEnabled.value) {
    if (variants.value.length === 0) return toast.warning('请至少添加一个规格，或关闭规格开关');
    for (const [i, v] of variants.value.entries()) {
      if (!v.name.trim()) return toast.warning(`第 ${i + 1} 个规格还没填名称`);
      if (!(Number(v.cost) > 0)) return toast.warning(`规格「${v.name || i + 1}」的积分必须大于 0`);
      if (v.stock !== -1 && Number(v.stock) < 0) return toast.warning(`规格「${v.name || i + 1}」的库存不能小于 0（不限量请填 -1）`);
    }
  } else {
    if (kind.value === 'goods' && cost.value <= 0) return toast.warning('礼物类商品积分必须大于 0');
    if (kind.value === 'prop' && cost.value < 0) return toast.warning('道具积分不能为负数');
    if (!unlimited.value && stock.value < 0) return toast.warning('库存不能小于0');
  }
  if (limitEnabled.value && (limitDays.value < 1 || limitCount.value < 1)) {
    return toast.warning('限兑天数和次数都要大于 0');
  }
  if (maxPerExchange.value < 1) return toast.warning('单次限兑数量至少为 1');

  saving.value = true;
  try {
    const body: Record<string, unknown> = {
      name: name.value.trim(),
      kind: kind.value,
      prop_desc: propDesc.value.trim(),
      // 有规格时商品自身的价格/库存只作为兜底值保留
      cost: variantsEnabled.value ? (variants.value[0]?.cost ?? cost.value) : cost.value,
      stock: variantsEnabled.value ? -1 : (unlimited.value ? -1 : stock.value),
      icon: image.value,
      category_id: categoryId.value,
      limit_days: limitEnabled.value ? limitDays.value : 0,
      limit_count: limitEnabled.value ? limitCount.value : 0,
      max_per_exchange: Math.max(1, Math.floor(maxPerExchange.value || 1)),
      variants: variantsEnabled.value
        ? variants.value.map((v) => ({ name: v.name.trim(), cost: Math.floor(Number(v.cost)), stock: Number(v.stock) === -1 ? -1 : Math.floor(Number(v.stock)) }))
        : null,
    };
    if (isEdit.value) {
      await api.patch(`/products/${props.product.id}`, body);
      toast.success('已更新');
    } else {
      await api.post('/products', body);
      toast.success('商品已添加 🎁');
    }
    emit('saved');
  } catch (e: any) { toast.error(e.message); }
  finally { saving.value = false; }
}

/** 分类管理弹窗关闭后：分类列表可能变了（新建/删除），把失效的选中项修正掉 */
async function onCategoriesChanged() {
  await loadCategories();
  if (categoryId.value != null && !categories.value.some((c) => c.id === categoryId.value)) {
    categoryId.value = categories.value[0]?.id ?? null;
  }
}
</script>

<template>
  <Modal :model-value="modelValue" :title="isEdit ? '编辑商品' : '新增商品'" @update:model-value="emit('update:modelValue', $event)">
    <div class="form">
      <!-- ── 1. 选分类（决定商品在图上的归属，也是「没传图片」时的默认图片来源）── -->
      <div class="field">
        <label class="label">商品分类</label>
        <div class="cat-grid">
          <button
            v-for="c in categories"
            :key="c.id"
            type="button"
            :class="['cat-chip', { active: categoryId === c.id }]"
            @click="categoryId = c.id"
          >
            <CategoryIcon :icon="c.icon" :size="34" :color="c.color" />
            <span class="cat-label">{{ c.name }}</span>
          </button>
          <button type="button" class="cat-chip manage-chip" @click="categoryManagerOpen = true">
            <span class="manage-plus">＋</span>
            <span class="cat-label">新建分类</span>
          </button>
        </div>
      </div>

      <!-- ── 2. 商品图片（居中；不传就用分类图标）────────────────────────── -->
      <div class="field">
        <label class="label centered-label">商品图片</label>
        <div class="img-picker">
          <button
            type="button"
            class="img-slot"
            :disabled="uploading"
            :title="isCustomImage ? '点击放大预览' : '点击上传商品图片'"
            @click="isCustomImage ? (zoomOpen = true) : pickImage()"
          >
            <CategoryIcon :icon="previewIcon" :size="104" :color="previewColor" />
            <span v-if="uploading" class="img-mask">上传中…</span>
          </button>
          <div class="img-actions">
            <button type="button" class="btn btn-ghost" :disabled="uploading" @click="pickImage">
              {{ isCustomImage ? '更换图片' : '📷 上传图片' }}
            </button>
            <button v-if="isCustomImage" type="button" class="btn btn-ghost" @click="image = ''">
              恢复分类图标
            </button>
          </div>
          <p class="hint center">
            <template v-if="isCustomImage">点上方图片可放大预览；换回分类图标请点「恢复分类图标」</template>
            <template v-else>
              不上传图片时，默认用分类图标当商品图片（当前：{{ currentCategory?.name ?? '未选分类' }}）
            </template>
          </p>
          <input
            ref="fileInput"
            type="file"
            :accept="ACCEPT"
            style="display:none"
            @change="(e) => onFileChange(e, (url) => { image = url; })"
          />
        </div>
      </div>

      <!-- ── 3. 商品类型 ────────────────────────────────────────────────── -->
      <div class="field">
        <label class="label">商品类型</label>
        <div class="kind-row">
          <label :class="['kind-chip', { active: kind === 'goods' }]">
            <input v-model="kind" type="radio" value="goods" class="kind-radio" />
            <span class="kind-emoji">🎁</span>
            <span class="kind-name">礼物</span>
            <span class="kind-submit">孩子兑换后需家长审核</span>
          </label>
          <label :class="['kind-chip', 'prop-chip', { active: kind === 'prop' }]">
            <input v-model="kind" type="radio" value="prop" class="kind-radio" />
            <span class="kind-emoji">🔖</span>
            <span class="kind-name">道具</span>
            <span class="kind-submit">兑换即入背包，可免费</span>
          </label>
        </div>
      </div>

      <!-- ── 4. 商品名称 ────────────────────────────────────────────────── -->
      <div class="field">
        <label class="label">商品名称</label>
        <input v-model="name" type="text" maxlength="50" placeholder="如：冰淇淋一次 / 免周末作业券" />
      </div>

      <!-- 道具使用说明：仅道具类显示 -->
      <div v-if="kind === 'prop'" class="field">
        <label class="label">道具使用说明（选填）</label>
        <textarea v-model="propDesc" rows="2" maxlength="200"
          placeholder="例：凭此券可免一次周末作业；使用时请跟爸爸妈妈说一声" />
      </div>

      <!-- ── 规格开关：关闭时是单一价格/库存，打开后每个规格各有价格与库存 ── -->
      <div class="field">
        <label class="label">
          <input v-model="variantsEnabled" type="checkbox" class="checkbox" />
          设置商品规格（如：小杯 / 大杯，各自价格和库存）
        </label>
        <p class="hint">开启后，小朋友兑换时需要先选规格；下面的「所需积分 / 库存」由各规格决定</p>
      </div>

      <div v-if="variantsEnabled" class="field variant-box">
        <div class="variant-head">
          <span class="mini-label">规格名</span>
          <span class="mini-label">所需积分</span>
          <span class="mini-label">库存</span>
          <span class="variant-del-holder"></span>
        </div>
        <div v-for="(v, i) in variants" :key="i" class="variant-row">
          <input v-model="v.name" type="text" maxlength="20" placeholder="如：小杯" class="v-name" />
          <input v-model.number="v.cost" type="number" min="1" max="99999" class="v-cost" />
          <input v-model.number="v.stock" type="number" class="v-stock" placeholder="-1=不限" />
          <button type="button" class="variant-del" title="删除该规格" @click="removeVariant(i)">✕</button>
        </div>
        <button type="button" class="btn btn-ghost add-variant" @click="addVariant">＋ 添加规格</button>
        <p class="hint">{{ variantRange ? `当前价格区间：${variantRange}` : '还没有规格，至少添加一个' }}；库存填 -1 表示不限量</p>
      </div>

      <template v-else>
        <div class="field">
          <label class="label">所需积分</label>
          <input v-model.number="cost" type="number" :min="kind === 'prop' ? 0 : 1" max="99999" />
          <p v-if="kind === 'prop' && cost === 0" class="hint center">0 积分 = 免费道具，孩子点一下就能进背包</p>
        </div>
        <div class="field">
          <label class="label">
            <input v-model="unlimited" type="checkbox" class="checkbox" />
            不限库存
          </label>
          <input v-if="!unlimited" v-model.number="stock" type="number" min="0" placeholder="库存数量" />
        </div>
      </template>
      <div class="field">
        <label class="label">
          <input v-model="limitEnabled" type="checkbox" class="checkbox" />
          限兑次数
        </label>
        <div v-if="limitEnabled" class="limit-row">
          <span class="mini-label">每</span>
          <input v-model.number="limitDays" type="number" min="1" class="limit-input" />
          <span class="mini-label">天最多兑</span>
          <input v-model.number="limitCount" type="number" min="1" class="limit-input" />
          <span class="mini-label">次</span>
        </div>
        <p v-if="limitEnabled" class="hint">同一小朋友在这个周期内最多兑换该次数（含待审核的申请）</p>
      </div>
      <div class="field">
        <label class="label">单次限兑数量</label>
        <div class="limit-row">
          <span class="mini-label">每次最多兑</span>
          <input v-model.number="maxPerExchange" type="number" min="1" max="99" class="limit-input" />
          <span class="mini-label">件</span>
        </div>
        <p class="hint">孩子一次最多能兑换的件数；设为 1 表示每次只能兑 1 件</p>
      </div>
    </div>
    <template #footer>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" @click="emit('update:modelValue', false)">取消</button>
      <button class="btn btn-primary" @click="save" :disabled="saving">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </template>
  </Modal>

  <!-- 图标/图片放大预览 -->
  <IconLightbox v-model="zoomOpen" :icon="previewIcon" :name="name || '商品图片'" />

  <!-- 分类管理（新建 / 改名 / 换图标），从「新建分类」进 -->
  <CategoryManagerModal v-model="categoryManagerOpen" @changed="onCategoriesChanged" />
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: var(--space-16); }
.field { display: flex; flex-direction: column; gap: var(--space-8); }
.label { font-size: var(--fs-sm); color: var(--text-secondary); padding-left: var(--space-4); display: flex; align-items: center; gap: var(--space-6); }
.label.centered-label { justify-content: center; padding-left: 0; }
.checkbox { width: auto; }

.limit-row { display: flex; align-items: center; gap: var(--space-8); }
.mini-label { font-size: var(--fs-sm); color: var(--text-secondary); white-space: nowrap; }
.limit-input { width: 80px; }
.hint { font-size: var(--fs-xs); color: var(--text-muted); padding-left: var(--space-4); }
.hint.center { text-align: center; padding-left: 0; line-height: 1.5; }

/* ── 分类选择 ── */
.cat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-8);
}
.cat-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-8) var(--space-4);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 2px solid transparent;
  transition: all var(--dur-base);
  cursor: pointer;
}
.cat-chip.active { border-color: var(--accent-yellow); background: rgba(255, 209, 102, 0.15); }
.cat-label {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  font-family: var(--font-cute);
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.manage-chip { border-style: dashed; border-color: var(--glass-border); }
.manage-chip:hover { border-color: var(--accent-yellow); }
.manage-plus { font-size: 24px; line-height: 34px; color: var(--text-muted); }

/* ── 商品图片：居中大图 + 上传按钮 ── */
.img-picker { display: flex; flex-direction: column; align-items: center; gap: var(--space-10); }
.img-slot {
  position: relative;
  border-radius: var(--r-full);
  line-height: 0;
  cursor: pointer;
  transition: transform var(--dur-fast);
}
.img-slot:hover { transform: scale(1.03); }
.img-mask {
  position: absolute;
  inset: 0;
  border-radius: var(--r-full);
  background: rgba(255, 255, 255, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}
.img-actions { display: flex; gap: var(--space-8); }
.img-actions .btn { padding: var(--space-6) var(--space-14); font-size: var(--fs-sm); }

/* ── 商品类型选择 ── */
.kind-row { display: flex; gap: var(--space-10); }
.kind-chip {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: var(--space-10) var(--space-8);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 2px solid transparent;
  cursor: pointer;
  transition: all var(--dur-base);
  font-family: var(--font-cute);
}
.kind-chip.active { border-color: var(--accent-yellow); background: rgba(255, 209, 102, 0.15); }
.kind-chip.prop-chip.active { border-color: rgba(130, 192, 255, 0.8); background: rgba(130, 192, 255, 0.15); }
.kind-emoji { font-size: 26px; line-height: 1; }
.kind-name { font-size: var(--fs-md); color: var(--text-primary); }
.kind-submit { font-size: var(--fs-xs); color: var(--text-muted); }
.kind-radio { display: none; }

/* ── 商品类型选择 ── */

.variant-box {
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  gap: var(--space-8);
}
.variant-head,
.variant-row {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr 26px;
  align-items: center;
  gap: var(--space-8);
}
.variant-head .mini-label { font-size: var(--fs-xs); color: var(--text-muted); padding-left: var(--space-4); }
.variant-del-holder { width: 26px; }
.variant-row .v-cost,
.variant-row .v-stock { width: 100%; }
.variant-del {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--text-muted);
  background: transparent;
  font-size: var(--fs-xs);
  transition: all var(--dur-fast);
}
.variant-del:hover { color: #fff; background: rgba(255, 122, 122, 0.75); }
.add-variant {
  align-self: flex-start;
  padding: var(--space-6) var(--space-14);
  font-size: var(--fs-sm);
}
</style>
