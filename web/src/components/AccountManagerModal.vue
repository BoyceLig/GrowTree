<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import BackButton from '@/components/BackButton.vue';
import ChildEditorModal from '@/components/ChildEditorModal.vue';
import EmptyState from '@/components/EmptyState.vue';
import IdentityPicker from '@/components/IdentityPicker.vue';
import { ZODIACS } from '@/utils/zodiac';
import { useImageUpload } from '@/composables/useImageUpload';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  changed: [];
}>();

interface ParentRow {
  id: number;
  name: string;
  nickname: string;
  avatar: string | null;
  identity: string | null;
  isPrimary: boolean;
  createdAt: number | null;
}

interface Child {
  id: number;
  name: string;
  avatar: string;
  total_points: number;
  birthday?: string | null;
  sex?: string | null;
}

type Tab = 'parents' | 'children';
type Page = 'list' | 'profile' | 'create-sub' | 'edit-sub';

const auth = useAuthStore();
const toast = useToastStore();
const { uploading, fileInput, pickImage, onFileChange, ACCEPT } = useImageUpload();

const tab = ref<Tab>('parents');
const page = ref<Page>('list');
const loading = ref(false);
const saving = ref(false);

const parents = ref<ParentRow[]>([]);
const children = ref<Child[]>([]);
const target = ref<ParentRow | null>(null);
const form = ref({
  name: '',
  nickname: '',
  identity: '',
  avatar: 'dragon',
  password: '',
});
// 密码明文/密文切换；进入任意详情页时重置为隐藏
const passwordVisible = ref(false);
// 进入详情页时的快照：用来判断是否有未保存修改
const baseline = ref({ ...form.value });

const isPrimary = computed(() => !!auth.user?.isPrimary);

/** 详情页有改动才拦截返回；列表页不参与 */
const dirty = computed(() => {
  if (page.value === 'list') return false;
  const a = form.value;
  const b = baseline.value;
  return (
    a.name !== b.name ||
    a.nickname !== b.nickname ||
    a.identity !== b.identity ||
    a.avatar !== b.avatar ||
    a.password !== ''
  );
});

const selfRow = computed<ParentRow>(() => parents.value.find((p) => p.id === auth.user?.id) ?? {
  id: auth.user?.id ?? 0,
  name: auth.user?.name ?? '',
  nickname: auth.user?.nickname || auth.user?.name || '',
  avatar: auth.user?.avatar ?? null,
  identity: auth.user?.identity ?? null,
  isPrimary: !!auth.user?.isPrimary,
  createdAt: null,
});

/** 主账号看全部家长；其他家长只看自己，不能看到其他家长账号 */
const visibleParents = computed(() => (isPrimary.value ? parents.value : [selfRow.value]));

const modalTitle = computed(() => {
  if (page.value === 'profile') return '我的账号';
  if (page.value === 'create-sub') return '新建其他家长';
  if (page.value === 'edit-sub') return '编辑其他家长';
  return '账号管理';
});

const pageTitle = computed(() => {
  if (page.value === 'profile') return '我的资料';
  if (page.value === 'create-sub') return '新建其他家长';
  return '编辑其他家长';
});

const pageHint = computed(() => {
  if (page.value === 'profile') {
    return isPrimary.value
      ? '主账号可以修改自己的头像、昵称、身份、账号和密码。'
      : '其他家长可以修改自己的头像、昵称和密码；账号和身份由主账号管理。';
  }
  if (page.value === 'create-sub') {
    return '只需填写登录账号、初始密码和身份；昵称和头像会先给默认值，由其他家长登录后自己管理。';
  }
  return '这里只修改其他家长的登录账号和密码；昵称、头像、身份由其他家长本人管理。';
});

// 孩子账号的新增/编辑/删除（沿用原有逻辑）
const childEditorOpen = ref(false);
const editingChild = ref<Child | null>(null);
const confirmOpen = ref(false);
const deletingChild = ref<Child | null>(null);
const deleting = ref(false);

watch(() => props.modelValue, (open) => {
  if (open) {
    tab.value = 'parents';
    page.value = 'list';
    loadAll();
  } else {
    page.value = 'list';
    childEditorOpen.value = false;
    confirmOpen.value = false;
  }
});

async function loadAll() {
  loading.value = true;
  try {
    if (isPrimary.value) {
      const res = await api.get<{ parents: ParentRow[] }>('/parents');
      parents.value = res.parents;
    } else {
      parents.value = [selfRow.value];
    }
    const kids = await api.get<{ children: Child[] }>('/children');
    children.value = kids.children;
  } catch (e: any) {
    toast.error(e.message || '账号加载失败');
  } finally {
    loading.value = false;
  }
}

function openSelf() {
  const row = parents.value.find((p) => p.id === auth.user?.id) ?? selfRow.value;
  target.value = row;
  form.value = {
    name: row.name,
    nickname: row.nickname || row.name,
    identity: row.identity || '',
    avatar: row.avatar || 'dragon',
    password: '',
  };
  baseline.value = { ...form.value };
  passwordVisible.value = false;
  page.value = 'profile';
}

function openEditSub(p: ParentRow) {
  target.value = p;
  form.value = {
    name: p.name,
    nickname: p.nickname,
    identity: p.identity || '',
    avatar: p.avatar || 'dragon',
    password: '',
  };
  baseline.value = { ...form.value };
  passwordVisible.value = false;
  page.value = 'edit-sub';
}

function openCreateSub() {
  target.value = null;
  form.value = { name: '', nickname: '', identity: '', avatar: 'dragon', password: '' };
  baseline.value = { ...form.value };
  passwordVisible.value = false;
  page.value = 'create-sub';
}

function backToList() {
  page.value = 'list';
  loadAll();
}

const discardOpen = ref(false);

/** 点返回：有改动先确认，没改动直接回列表 */
function requestBack() {
  if (dirty.value) {
    discardOpen.value = true;
    return;
  }
  backToList();
}

function confirmDiscard() {
  discardOpen.value = false;
  backToList();
}

function applyAvatar(url: string) {
  form.value.avatar = url;
}

async function saveCurrent() {
  if (page.value === 'profile') return saveProfile();
  if (page.value === 'create-sub') return createSubParent();
  if (page.value === 'edit-sub') return saveSubParent();
}

async function saveProfile() {
  if (!form.value.nickname.trim()) return toast.warning('请输入昵称');
  if (isPrimary.value && !form.value.name.trim()) return toast.warning('请输入账号');
  if (isPrimary.value && !form.value.identity.trim()) return toast.warning('请选择身份');
  if (form.value.password && form.value.password.length < 6) {
    return toast.warning('密码至少 6 位');
  }

  saving.value = true;
  try {
    const payload: {
      nickname: string;
      avatar: string;
      password?: string;
      name?: string;
      identity?: string;
    } = {
      nickname: form.value.nickname.trim(),
      avatar: form.value.avatar,
    };
    if (form.value.password) payload.password = form.value.password;
    // 其他家长的账号和身份由主账号管理，前端不提交这两项
    if (isPrimary.value) {
      payload.name = form.value.name.trim();
      payload.identity = form.value.identity.trim();
    }
    await auth.updateMe(payload);
    toast.success('资料已保存');
    await loadAll();
    page.value = 'list';
  } catch (e: any) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function createSubParent() {
  const name = form.value.name.trim();
  const identity = form.value.identity.trim();
  if (!name) return toast.warning('请输入账号');
  if (!form.value.password) return toast.warning('请设置初始密码');
  if (form.value.password.length < 6) return toast.warning('密码至少 6 位');
  if (!identity) return toast.warning('请选择身份');

  saving.value = true;
  try {
    await api.post('/parents', { name, password: form.value.password, identity });
    toast.success('其他家长创建成功');
    await loadAll();
    page.value = 'list';
    emit('changed');
  } catch (e: any) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function saveSubParent() {
  if (!target.value) return;
  const name = form.value.name.trim();
  if (!name) return toast.warning('请输入账号');
  if (form.value.password && form.value.password.length < 6) {
    return toast.warning('密码至少 6 位');
  }

  const body: { name?: string; password?: string } = {};
  if (name !== target.value.name) body.name = name;
  if (form.value.password) body.password = form.value.password;
  if (!body.name && !body.password) {
    toast.info('没有需要修改的内容');
    return;
  }

  saving.value = true;
  try {
    await api.patch(`/parents/${target.value.id}`, body);
    toast.success('其他家长账号已更新');
    await loadAll();
    page.value = 'list';
    emit('changed');
  } catch (e: any) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

function toastError(e: any) {
  const err = e.payload?.error;
  if (err === 'name_taken') toast.error('该账号已被其他家长使用');
  else if (err === 'invalid_avatar') toast.error('头像无效');
  else if (err === 'account_readonly') toast.error('其他家长的账号由主账号管理');
  else if (err === 'identity_readonly') toast.error('其他家长的身份由主账号设置');
  else toast.error(e.message || '保存失败');
}

function openAddChild() {
  editingChild.value = null;
  childEditorOpen.value = true;
}

function openEditChild(c: Child) {
  editingChild.value = c;
  childEditorOpen.value = true;
}

async function onChildSaved() {
  childEditorOpen.value = false;
  await loadAll();
  emit('changed');
}

function askDeleteChild(c: Child) {
  deletingChild.value = c;
  confirmOpen.value = true;
}

async function doDeleteChild() {
  if (!deletingChild.value) return;
  const targetChild = deletingChild.value;
  deleting.value = true;
  try {
    await api.delete(`/children/${targetChild.id}`);
    toast.success(`已删除「${targetChild.name}」`);
    deletingChild.value = null;
    await loadAll();
    emit('changed');
  } catch (e: any) {
    toast.error(e.message || '删除失败');
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="modalTitle"
    width="560px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- 一级：账号列表 -->
    <template v-if="page === 'list'">
      <div class="tabs" role="tablist" aria-label="账号类型">
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'parents'"
          :class="{ active: tab === 'parents' }"
          @click="tab = 'parents'"
        >
          家长账号
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'children'"
          :class="{ active: tab === 'children' }"
          @click="tab = 'children'"
        >
          孩子账号
        </button>
      </div>

      <div v-if="loading" class="loading">加载中...</div>

      <template v-else-if="tab === 'parents'">
        <div class="section-head">
          <div>
            <h4>{{ isPrimary ? '家长账号' : '我的账号' }}</h4>
            <p>{{ isPrimary ? '主账号可以新建其他家长，并修改其他家长的账号和密码。' : '其他家长账号由主账号创建，你可以修改自己的昵称、头像和密码。' }}</p>
          </div>
          <button v-if="isPrimary" class="btn btn-primary add-btn" @click="openCreateSub">
            ＋ 新建其他家长
          </button>
        </div>

        <div class="account-list">
          <button
            v-for="p in visibleParents"
            :key="p.id"
            type="button"
            class="account-row"
            @click="p.id === auth.user?.id ? openSelf() : openEditSub(p)"
          >
            <ZodiacAvatar :zodiac="p.avatar || 'dragon'" :size="46" />
            <div class="info">
              <div class="line1">
                <span class="name">{{ p.nickname }}</span>
                <span v-if="p.identity" class="tag">{{ p.identity }}</span>
                <span v-if="p.id === auth.user?.id" class="tag me">我</span>
                <span v-if="p.isPrimary" class="tag primary">主账号</span>
              </div>
              <div class="line2">账号：{{ p.name }}</div>
            </div>
            <span class="chevron" aria-hidden="true">›</span>
          </button>
        </div>

        <p v-if="!isPrimary" class="foot-hint">
          家长账号的新增和修改由主账号管理。孩子账号仍可在这里管理。
        </p>
      </template>

      <template v-else>
        <div class="section-head">
          <div>
            <h4>孩子账号</h4>
            <p>新增、编辑或删除孩子账号，设置孩子的生肖头像和登录 PIN。</p>
          </div>
          <button class="btn btn-primary add-btn" @click="openAddChild">＋ 新增孩子</button>
        </div>

        <EmptyState
          v-if="children.length === 0"
          emoji="🐣"
          text="还没有小朋友账号"
          hint="点击上方按钮新增一个吧~"
        />

        <div v-else class="account-list">
          <div v-for="c in children" :key="c.id" class="account-row static">
            <ZodiacAvatar :zodiac="c.avatar" :size="46" show-ring />
            <div class="info">
              <div class="line1"><span class="name">{{ c.name }}</span></div>
              <div class="line2">{{ c.total_points }} 分</div>
            </div>
            <div class="row-actions">
              <button class="mini-btn" @click="openEditChild(c)">编辑</button>
              <button class="mini-btn danger" @click="askDeleteChild(c)">删除</button>
            </div>
          </div>
        </div>
      </template>
    </template>

    <!-- 二级：我的资料 -->
    <template v-else-if="page === 'profile'">
      <div class="page-head">
        <BackButton label="返回账号列表" @click="requestBack" />
        <h4>{{ pageTitle }}</h4>
        <p>{{ pageHint }}</p>
      </div>

      <div class="form">
        <div class="field">
          <label class="label">头像</label>
          <div class="avatar-row">
            <ZodiacAvatar :zodiac="form.avatar" :size="56" show-ring />
            <div class="avatar-actions">
              <button type="button" class="upload-btn" @click="pickImage" :disabled="uploading">
                {{ uploading ? '上传中...' : '上传自定义头像' }}
              </button>
              <p class="hint">支持 PNG / JPG / GIF / WebP，3MB 以内</p>
            </div>
          </div>
          <input
            ref="fileInput"
            type="file"
            :accept="ACCEPT"
            hidden
            @change="onFileChange($event, applyAvatar)"
          />
          <div class="zodiac-grid">
            <button
              v-for="z in ZODIACS"
              :key="z.key"
              type="button"
              :class="['zodiac', { active: form.avatar === z.key }]"
              @click="form.avatar = z.key"
            >
              <ZodiacAvatar :zodiac="z.key" :size="44" />
              <span class="zname">{{ z.name }}</span>
            </button>
          </div>
        </div>

        <div class="field">
          <label class="label">昵称</label>
          <input v-model="form.nickname" type="text" maxlength="30" placeholder="在家庭里显示的名字" />
          <p class="hint">孩子端、树洞和流水里显示的是这个昵称</p>
        </div>

        <div class="field">
          <label class="label">身份</label>
          <IdentityPicker v-if="isPrimary" v-model="form.identity" />
          <div v-else class="readonly-box">
            <span>{{ form.identity || '未设置' }}</span>
            <span class="hint">身份由主账号设置，其他家长不能修改</span>
          </div>
        </div>

        <div class="field">
          <label class="label">账号</label>
          <input
            v-if="isPrimary"
            v-model="form.name"
            type="text"
            maxlength="30"
            placeholder="家长登录账号"
            autocomplete="username"
          />
          <div v-else class="readonly-box">
            <span>{{ form.name }}</span>
            <span class="hint">其他家长账号由主账号管理</span>
          </div>
          <p v-if="isPrimary" class="hint">登录时使用的账号名称</p>
        </div>

        <div class="field">
          <label class="label">新密码（留空则不修改）</label>
          <div class="password-wrap">
            <input
              v-model="form.password"
              :type="passwordVisible ? 'text' : 'password'"
              maxlength="64"
              placeholder="至少 6 位"
              autocomplete="new-password"
            />
            <button
              type="button"
              class="password-eye"
              :aria-label="passwordVisible ? '隐藏密码' : '显示密码'"
              :aria-pressed="passwordVisible"
              @click="passwordVisible = !passwordVisible"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z" />
                <circle cx="8" cy="8" r="2.1" />
                <path v-if="!passwordVisible" d="M2.5 2.5l11 11" />
              </svg>
            </button>
          </div>
          <p class="hint">修改后下次登录请使用新密码</p>
        </div>
      </div>
    </template>

    <!-- 二级：新建其他家长 -->
    <template v-else-if="page === 'create-sub'">
      <div class="page-head">
        <BackButton label="返回账号列表" @click="requestBack" />
        <h4>{{ pageTitle }}</h4>
        <p>{{ pageHint }}</p>
      </div>

      <div class="form">
        <div class="field">
          <label class="label">账号</label>
          <input v-model="form.name" type="text" maxlength="30" placeholder="其他家长登录账号" autocomplete="username" />
        </div>

        <div class="field">
          <label class="label">初始密码</label>
          <div class="password-wrap">
            <input
              v-model="form.password"
              :type="passwordVisible ? 'text' : 'password'"
              maxlength="64"
              placeholder="至少 6 位"
              autocomplete="new-password"
            />
            <button
              type="button"
              class="password-eye"
              :aria-label="passwordVisible ? '隐藏密码' : '显示密码'"
              :aria-pressed="passwordVisible"
              @click="passwordVisible = !passwordVisible"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z" />
                <circle cx="8" cy="8" r="2.1" />
                <path v-if="!passwordVisible" d="M2.5 2.5l11 11" />
              </svg>
            </button>
          </div>
          <p class="hint">密码不会回显，只能设置或重置</p>
        </div>

        <div class="field">
          <label class="label">身份</label>
          <IdentityPicker v-model="form.identity" />
          <p class="hint">昵称会默认使用所选身份，头像会自动配一个默认生肖图</p>
        </div>
      </div>
    </template>

    <!-- 二级：编辑其他家长（只改账号 / 密码） -->
    <template v-else>
      <div class="page-head">
        <BackButton label="返回账号列表" @click="requestBack" />
        <h4>{{ pageTitle }}</h4>
        <p>{{ pageHint }}</p>
      </div>

      <div v-if="target" class="summary">
        <ZodiacAvatar :zodiac="target.avatar || 'dragon'" :size="46" />
        <div>
          <div class="line1">
            <span class="name">{{ target.nickname }}</span>
            <span v-if="target.identity" class="tag">{{ target.identity }}</span>
          </div>
          <div class="line2">当前账号：{{ target.name }}</div>
        </div>
      </div>

      <div class="form">
        <div class="field">
          <label class="label">账号</label>
          <input v-model="form.name" type="text" maxlength="30" placeholder="其他家长登录账号" autocomplete="username" />
        </div>

        <div class="field">
          <label class="label">新密码（留空则不修改）</label>
          <div class="password-wrap">
            <input
              v-model="form.password"
              :type="passwordVisible ? 'text' : 'password'"
              maxlength="64"
              placeholder="至少 6 位"
              autocomplete="new-password"
            />
            <button
              type="button"
              class="password-eye"
              :aria-label="passwordVisible ? '隐藏密码' : '显示密码'"
              :aria-pressed="passwordVisible"
              @click="passwordVisible = !passwordVisible"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z" />
                <circle cx="8" cy="8" r="2.1" />
                <path v-if="!passwordVisible" d="M2.5 2.5l11 11" />
              </svg>
            </button>
          </div>
          <p class="hint">密码不会回显，只能设置或重置</p>
        </div>
      </div>
    </template>

    <ChildEditorModal
      v-if="childEditorOpen"
      v-model="childEditorOpen"
      :child="editingChild"
      @saved="onChildSaved"
    />

    <ConfirmDialog
      v-model="confirmOpen"
      variant="danger"
      title="删除账号"
      :message="`确定删除「${deletingChild?.name ?? ''}」吗？该账号的积分、任务、兑换记录都会一并删除，且无法恢复。`"
      confirm-text="确认删除"
      @confirm="doDeleteChild"
    />

    <ConfirmDialog
      v-model="discardOpen"
      variant="danger"
      title="未保存的修改"
      message="当前页有未保存的修改，返回后将全部丢弃。确定返回吗？"
      confirm-text="放弃修改"
      cancel-text="继续编辑"
      @confirm="confirmDiscard"
    />

    <template #footer>
      <template v-if="page === 'list'">
        <span style="flex:1"></span>
        <button class="btn btn-ghost" @click="emit('update:modelValue', false)">关闭</button>
      </template>
      <template v-else>
        <span style="flex:1"></span>
        <button class="btn btn-primary" @click="saveCurrent" :disabled="saving">
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: var(--space-4);
  padding: var(--space-4);
  margin-bottom: var(--space-14);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
}
.tabs button {
  flex: 1;
  min-height: 40px;
  border-radius: var(--r-sm);
  color: var(--text-secondary);
  font-weight: 600;
  transition: all var(--dur-base);
}
.tabs button.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
  box-shadow: var(--shadow-pill);
}

.loading {
  padding: var(--space-32) 0;
  text-align: center;
  color: var(--text-muted);
}

.section-head {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  margin-bottom: var(--space-12);
}
.section-head > div {
  flex: 1;
  min-width: 0;
}
.section-head h4 {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-primary);
}
.section-head p {
  margin: var(--space-4) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.6;
}
.add-btn {
  flex-shrink: 0;
  padding: var(--space-8) var(--space-14);
  font-size: var(--fs-sm);
}

.account-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  max-height: 56vh;
  overflow-y: auto;
  padding-right: var(--space-4);
}
.account-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-12);
  padding: var(--space-10) var(--space-14);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  text-align: left;
  transition: all var(--dur-fast);
}
.account-row:not(.static):hover {
  background: var(--glass-bg-strong);
  border-color: var(--accent-orange);
}
.account-row.static {
  cursor: default;
}
.info {
  flex: 1;
  min-width: 0;
}
.line1 {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  flex-wrap: wrap;
}
.name {
  font-size: var(--fs-md);
  font-family: var(--font-cute);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.line2 {
  margin-top: var(--space-2);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.tag {
  padding: 1px var(--space-6);
  border-radius: var(--r-pill);
  background: var(--glass-bg-strong);
  font-size: var(--fs-2xs);
  color: var(--text-secondary);
  white-space: nowrap;
}
.tag.me {
  background: var(--accent-mint);
  color: #1d5b4b;
}
.tag.primary {
  background: var(--accent-orange);
  color: var(--text-on-orange);
}
.chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 22px;
  line-height: 1;
}
.row-actions {
  display: flex;
  gap: var(--space-6);
  flex-shrink: 0;
}
.mini-btn {
  min-height: 34px;
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-sm);
  background: var(--glass-bg-strong);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  transition: all var(--dur-fast);
}
.mini-btn:hover {
  color: var(--text-primary);
  background: var(--glass-bg);
}
.mini-btn.danger:hover {
  background: rgba(255, 107, 107, 0.16);
  color: var(--danger);
}
.foot-hint {
  margin: var(--space-12) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.6;
}

.page-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  margin-bottom: var(--space-14);
}
.page-head h4 {
  margin-top: var(--space-4);
  font-size: var(--fs-lg);
  color: var(--text-primary);
}
.page-head p {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.6;
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-18);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
.label {
  padding-left: var(--space-4);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.hint {
  padding-left: var(--space-4);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.5;
}

.avatar-row {
  display: flex;
  align-items: center;
  gap: var(--space-14);
  padding: 0 var(--space-4);
}
.avatar-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.upload-btn {
  align-self: flex-start;
  min-height: 38px;
  padding: var(--space-8) var(--space-14);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  transition: all var(--dur-fast);
}
.upload-btn:hover {
  background: var(--glass-bg-strong);
}
.upload-btn:disabled {
  opacity: 0.6;
}
.zodiac-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-8);
}
.zodiac {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-2);
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  border: 2px solid transparent;
  transition: all var(--dur-base);
}
.zodiac:hover {
  background: var(--glass-bg-strong);
}
.zodiac.active {
  background: var(--glass-bg-strong);
  border-color: var(--accent-orange);
}
.zname {
  font-size: var(--fs-2xs);
  color: var(--text-secondary);
}

.readonly-box {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-10) var(--space-14);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  font-size: var(--fs-sm);
  color: var(--text-primary);
}
.readonly-box .hint {
  padding-left: 0;
}

.summary {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  padding: var(--space-10) var(--space-14);
  margin-bottom: var(--space-16);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
}

.password-wrap {
  position: relative;
}
.password-wrap input {
  padding-right: 46px;
}
.password-eye {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-full);
  background: transparent;
  color: var(--text-secondary);
  transition: color var(--dur-fast), background var(--dur-fast);
}
.password-eye:hover {
  color: var(--text-primary);
  background: rgba(90, 58, 74, 0.08);
}
.password-eye:active {
  transform: translateY(-50%) scale(0.94);
}
.password-eye:focus-visible {
  outline: 2px solid var(--accent-orange);
  outline-offset: 1px;
}
.password-eye svg {
  width: 18px;
  height: 18px;
}
</style>
