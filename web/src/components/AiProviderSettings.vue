<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import AiModelCatalog from '@/components/AiModelCatalog.vue';

/**
 * AI 设置的「模型 / API」分区：供应商模式。
 *
 * 一个供应商 = 一套 OpenAI 兼容接口配置（Base URL + API Key + 模型名）。
 * 可以添加多个（智谱 / DeepSeek / 火山方舟 / MiniMax / 自定义）。
 * 聊天模型与图片识别各有一个独立开关：同类开关全局只能开一个，
 * 但「A 开聊天、B 开识图」可以并存；开着开关的供应商在左侧显示绿点。
 */

type ProviderKind = 'zhipu' | 'deepseek' | 'ark' | 'minimax' | 'custom';

type Provider = {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  /** 输入框里的值：留空 = 保持已保存的 Key（服务端按 id 保留） */
  apiKey: string;
  /** 上次保存的 Key 掩码，仅用于占位提示 */
  keyMask: string;
  hasKey: boolean;
  model: string;
  /** 图片识别模型；留空沿用聊天模型 */
  visionModel: string;
  /** 聊天模型开关：全局最多一个为 true */
  chatEnabled: boolean;
  /** 图片识别开关：全局最多一个为 true，与聊天开关互不影响 */
  visionEnabled: boolean;
};

const toast = useToastStore();

const PRESETS: Record<ProviderKind, { title: string; baseUrl: string; logo: string; hint: string; keyUrl?: string }> = {
  zhipu: {
    title: '智谱 API',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    logo: 'Z',
    hint: 'GLM 系列，OpenAI 兼容接口',
    keyUrl: 'https://www.bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  deepseek: {
    title: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com/v1',
    logo: 'D',
    hint: 'deepseek-chat / deepseek-reasoner，OpenAI 兼容接口',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  ark: {
    title: '火山方舟 API',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    logo: '火',
    hint: '豆包 Seed 系列，OpenAI 兼容接口；模型名填推理接入点或模型 ID',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  minimax: {
    title: 'MiniMax API',
    baseUrl: 'https://api.minimax.cn/v1',
    logo: 'M',
    hint: 'MiniMax M 系列，OpenAI 兼容接口',
    keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
  },
  custom: { title: '自定义供应商', baseUrl: '', logo: '＋', hint: '任意 OpenAI 兼容接口（自建网关、第三方中转等）' },
};

/** 官方申请 API Key 的页面；自定义供应商没有统一入口，返回空 */
function applyKeyUrl(kind: ProviderKind): string {
  return PRESETS[kind]?.keyUrl ?? '';
}

/** 添加供应商页的分组（参考图 2：厂商一组、自定义另一组） */
const ADD_GROUPS: { title: string; kinds: ProviderKind[] }[] = [
  { title: '模型厂商', kinds: ['zhipu', 'deepseek', 'ark', 'minimax'] },
  { title: '其他', kinds: ['custom'] },
];

/** 各厂商官方图标（从官网 favicon 取回，存于 web/public/icons/providers/，随静态资源发布；
 *  运行时不再依赖外网或第三方图标服务，拿不到的用名称首字兜底） */
const PRESET_ICONS: Partial<Record<ProviderKind, string>> = {
  zhipu: '/icons/providers/zhipu.png',
  deepseek: '/icons/providers/deepseek.png',
  ark: '/icons/providers/ark.png',
  minimax: '/icons/providers/minimax.png',
};

/** 自定义供应商的站点图标（origin → dataURL）：按 Base URL 让服务端去抓站点 favicon */
const ICON_CACHE_KEY = 'manalong:ai-custom-icons:v1';

function readIconCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ICON_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeIconCache(map: Record<string, string>): void {
  try {
    // 只保留最近 40 个站点，避免 localStorage 被图标撑爆
    const entries = Object.entries(map).slice(-40);
    localStorage.setItem(ICON_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 隐私模式/超额：存不下就算了，下次再抓 */
  }
}

/** 把抓到的图标缩成 64×64 PNG 再缓存：有的站点 favicon 是几百 KB 的多尺寸 ICO */
function shrinkIcon(dataUrl: string, size = 64): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const srcW = img.naturalWidth || img.width || size;
        const srcH = img.naturalHeight || img.height || size;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(dataUrl);
        const scale = Math.min(size / srcW, size / srcH);
        const w = Math.max(1, Math.round(srcW * scale));
        const h = Math.max(1, Math.round(srcH * scale));
        ctx.drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

const customIcons = ref<Record<string, string>>(readIconCache());
const iconLoading = ref<Record<string, boolean>>({});

function originOf(rawBaseUrl: string): string {
  const raw = rawBaseUrl.trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).origin;
  } catch {
    return '';
  }
}

/** 列表/详情里的图标：预设厂商用内置图标，自定义供应商用按 Base URL 抓到的图标 */
function iconFor(p: Provider): string {
  if (p.kind !== 'custom') return PRESET_ICONS[p.kind] ?? '';
  const origin = originOf(p.baseUrl);
  return origin ? customIcons.value[origin] ?? '' : '';
}

/** 抓一次站点图标；拿不到就保持名称首字，不打扰用户 */
async function fetchCustomIcon(p: Provider): Promise<void> {
  if (p.kind !== 'custom') return;
  const origin = originOf(p.baseUrl);
  if (!origin || customIcons.value[origin] || iconLoading.value[origin]) return;
  iconLoading.value = { ...iconLoading.value, [origin]: true };
  try {
    const data = await api.post<{ ok: boolean; dataUrl?: string }>('/ai/provider-icon', { baseUrl: p.baseUrl });
    if (data.ok && data.dataUrl) {
      const small = await shrinkIcon(data.dataUrl);
      customIcons.value = { ...customIcons.value, [origin]: small };
      writeIconCache(customIcons.value);
    }
  } catch {
    /* 站点没有图标 / 抓取失败：继续用首字 */
  } finally {
    iconLoading.value = { ...iconLoading.value, [origin]: false };
  }
}

const providers = ref<Provider[]>([]);
const temperature = ref<number | null>(null);
const maxTokens = ref<number | null>(null);
const contextWindow = ref<number | null>(null);

/** 上下文窗口 / 最大输出的快捷预设（与参考界面一致：点一下填入，已选中的置灰） */
const CONTEXT_PRESETS = [128000, 256000, 512000, 1000000];
const MAX_TOKEN_PRESETS = [4000, 8000, 16000, 32000, 128000];

/** 左侧选中的供应商（详情页展示它） */
const selectedId = ref<string>('');
/** detail = 供应商详情；add = 添加供应商列表 */
const view = ref<'detail' | 'add'>('detail');
const loading = ref(false);
const saving = ref(false);
const showApiKey = ref(false);
/**
 * 浏览器密码管理器会把「一个文本输入 + 一个密码输入」当成登录框，
 * 于是把 Base URL 存成账号、API Key 存成密码。这里让 Key 输入框默认用
 * type="text" + CSS 遮罩（-webkit-text-security），浏览器就不会把它识别成密码框，
 * 既不会自动填充，也不会弹「保存密码」。
 * 只有不支持该 CSS 的浏览器（Firefox）才退回 type="password"。
 */
const supportsTextSecurity =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc');
const apiKeyInputType = computed<'text' | 'password'>(() => (!showApiKey.value && !supportsTextSecurity ? 'password' : 'text'));

const selected = computed(() => providers.value.find((p) => p.id === selectedId.value) ?? null);

/* ── 模型列表面板（统一入口，面板由 AiModelCatalog 渲染在对应输入框下面） ── */

type ModelMode = 'chat' | 'vision';
const catalogMode = ref<ModelMode | null>(null);

/** 所有供应商共用的模型列表入口：mode 决定服务端筛选（聊天 / 识图） */
function openCatalog(mode: ModelMode): void {
  catalogMode.value = catalogMode.value === mode ? null : mode;
}

function pickModel(id: string): void {
  const p = selected.value;
  if (p) {
    if (catalogMode.value === 'vision') p.visionModel = id;
    else p.model = id;
  }
  catalogMode.value = null;
}

/* ── 读取与保存 ───────────────────────────────────────────────────────── */

type RawProvider = {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel: string;
  chatEnabled?: boolean;
  visionEnabled?: boolean;
  hasKey?: boolean;
};

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.get<{ providers: RawProvider[]; temperature: number | null; maxTokens: number | null; contextWindow: number | null }>('/ai/config');
    providers.value = (data.providers ?? []).map((p) => ({
      id: p.id,
      kind: p.kind ?? 'custom',
      name: p.name || (PRESETS[p.kind] ?? PRESETS.custom).title,
      baseUrl: p.baseUrl ?? '',
      apiKey: '', // 回显不回填明文：留空 = 保持原值
      keyMask: p.apiKey ?? '',
      hasKey: p.hasKey ?? Boolean(p.apiKey),
      model: p.model ?? '',
      visionModel: p.visionModel ?? '',
      chatEnabled: p.chatEnabled === true,
      visionEnabled: p.visionEnabled === true,
    }));
    temperature.value = data.temperature ?? null;
    maxTokens.value = data.maxTokens ?? null;
    contextWindow.value = data.contextWindow ?? null;
    // 自定义供应商按 Base URL 补图标（并行、失败静默）
    for (const p of providers.value) {
      if (p.kind === 'custom') void fetchCustomIcon(p);
    }
    // 保持当前选中项；没有就选开着聊天开关的，再没有就选开着识图的、最后选第一个
    if (!providers.value.some((p) => p.id === selectedId.value)) {
      selectedId.value =
        (providers.value.find((p) => p.chatEnabled) ??
          providers.value.find((p) => p.visionEnabled) ??
          providers.value[0])?.id ?? '';
    }
    if (!providers.value.length) view.value = 'add';
  } catch (err) {
    toast.warning((err as Error).message || '读取 AI 设置失败');
  } finally {
    loading.value = false;
  }
}

/** 缺哪项才能开启聊天：返回空串 = 齐了 */
function missingForChat(p: Provider): string {
  if (!p.baseUrl.trim()) return 'Base URL';
  if (!p.hasKey && !p.apiKey.trim()) return 'API Key';
  if (!p.model.trim()) return '模型';
  return '';
}

/** 缺哪项才能开启识图：识图模型留空时沿用聊天模型，所以聊天模型也能顶上 */
function missingForVision(p: Provider): string {
  if (!p.baseUrl.trim()) return 'Base URL';
  if (!p.hasKey && !p.apiKey.trim()) return 'API Key';
  if (!p.visionModel.trim() && !p.model.trim()) return '图片识别模型';
  return '';
}

/** 校验开着开关的供应商是否填全（没开的允许半成品放着） */
function validate(): boolean {
  for (const p of providers.value) {
    if (p.chatEnabled) {
      const miss = missingForChat(p);
      if (miss) {
        toast.warning(`「${p.name}」开着聊天模型，但还缺 ${miss}，填完再保存`);
        selectedId.value = p.id;
        view.value = 'detail';
        return false;
      }
    }
    if (p.visionEnabled) {
      const miss = missingForVision(p);
      if (miss) {
        toast.warning(`「${p.name}」开着图片识别，但还缺 ${miss}，填完再保存`);
        selectedId.value = p.id;
        view.value = 'detail';
        return false;
      }
    }
  }
  return true;
}

async function save(quiet = false): Promise<void> {
  if (!validate()) return;
  saving.value = true;
  try {
    const payload = {
      providers: providers.value.map((p) => ({
        id: p.id,
        kind: p.kind,
        name: p.name.trim(),
        baseUrl: p.baseUrl.trim(),
        apiKey: p.apiKey.trim(),
        model: p.model.trim(),
        visionModel: p.visionModel.trim(),
        chatEnabled: p.chatEnabled,
        visionEnabled: p.visionEnabled,
      })),
      temperature: toNumOrNull(temperature.value),
      maxTokens: toNumOrNull(maxTokens.value),
      contextWindow: toNumOrNull(contextWindow.value),
    };
    await api.put('/ai/config', payload);
    if (!quiet) toast.success('供应商配置已保存');
    // 重新读取一次：拿回掩码与 hasKey，顺手校正服务端归一化后的状态
    await load();
  } catch (err) {
    toast.warning((err as Error).message || '保存失败');
    // 保存失败：按服务端为准回读一次，避免界面停留在「看起来已切换」的假状态
    await load();
  } finally {
    saving.value = false;
  }
}

/* ── 供应商增删与启用 ─────────────────────────────────────────────────── */

function addProvider(kind: ProviderKind, fromAddView = true): void {
  const preset = PRESETS[kind];
  const id = `${kind}-${Date.now().toString(36)}`;
  const provider: Provider = {
    id,
    kind,
    name: preset.title,
    baseUrl: preset.baseUrl,
    apiKey: '',
    keyMask: '',
    hasKey: false,
    model: '',
    visionModel: '',
    // 第一个供应商默认开聊天：否则加完还得再点一下开关；识图开关默认关
    chatEnabled: providers.value.length === 0,
    visionEnabled: false,
  };
  providers.value = [...providers.value, provider];
  selectedId.value = id;
  if (fromAddView) view.value = 'detail';
}

/** 删除需二次确认（破坏性操作必须确认） */
const deleteId = ref<string>('');
const deleteOpen = computed({
  get: () => Boolean(deleteId.value),
  set: (v: boolean) => {
    if (!v) deleteId.value = '';
  },
});
const deleteName = computed(() => providers.value.find((p) => p.id === deleteId.value)?.name ?? '');

async function confirmDelete(): Promise<void> {
  const id = deleteId.value;
  deleteId.value = '';
  const removed = providers.value.find((p) => p.id === id);
  providers.value = providers.value.filter((p) => p.id !== id);
  // 删掉的正好开着聊天 / 识图：顺位交给剩下的第一个，避免 AI 静默不可用
  if (providers.value.length) {
    if (removed?.chatEnabled) {
      providers.value = providers.value.map((p, i) => ({ ...p, chatEnabled: i === 0 }));
    }
    if (removed?.visionEnabled) {
      providers.value = providers.value.map((p, i) => ({ ...p, visionEnabled: i === 0 }));
    }
  }
  if (!providers.value.some((p) => p.id === selectedId.value)) {
    selectedId.value = providers.value[0]?.id ?? '';
    if (!providers.value.length) view.value = 'add';
  }
  await save(true);
}

/** 聊天开关：全局只能开一个，开启它时只顶掉别家的聊天开关（识图不受影响） */
async function toggleChat(p: Provider): Promise<void> {
  const turnOn = !p.chatEnabled;
  if (turnOn) {
    const miss = missingForChat(p);
    if (miss) {
      toast.warning(`先把 ${miss} 填全，再开启聊天模型`);
      selectedId.value = p.id;
      view.value = 'detail';
      return;
    }
  }
  providers.value = providers.value.map((x) => ({ ...x, chatEnabled: turnOn && x.id === p.id }));
  await save(true);
  if (turnOn) toast.success(`聊天模型已切到「${p.name}」，新任务立即生效`);
  else if (!providers.value.some((x) => x.chatEnabled)) toast.warning('聊天模型全部关闭，AI 暂时不可用');
  else toast.info(`「${p.name}」的聊天模型已关闭`);
}

/** 识图开关：与聊天开关独立，开启时只顶掉别家的识图开关 */
async function toggleVision(p: Provider): Promise<void> {
  const turnOn = !p.visionEnabled;
  if (turnOn) {
    const miss = missingForVision(p);
    if (miss) {
      toast.warning(`先把 ${miss} 填全，再开启图片识别`);
      selectedId.value = p.id;
      view.value = 'detail';
      return;
    }
  }
  providers.value = providers.value.map((x) => ({ ...x, visionEnabled: turnOn && x.id === p.id }));
  await save(true);
  if (turnOn) toast.success(`图片识别已切到「${p.name}」，新任务立即生效`);
  else toast.info(`「${p.name}」的图片识别已关闭，带图消息会沿用聊天模型`);
}

/* ── 测试连接（每个模型单独测） ─────────────────────────────────────────── */

const chatProbing = ref(false);
const visionProbing = ref(false);
const chatTest = ref<boolean | null>(null);
const visionTest = ref<boolean | null>(null);

async function runProbe(withImage: boolean): Promise<{ chat: boolean; image: boolean | null }> {
  const p = selected.value;
  if (!p) throw new Error('还没有选择供应商');
  return api.post<{ chat: boolean; image: boolean | null }>('/ai/probe', {
    providerId: p.id,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
    visionModel: p.visionModel,
    withImage,
  });
}

async function testChat(): Promise<void> {
  if (chatProbing.value) return;
  chatProbing.value = true;
  chatTest.value = null;
  try {
    const data = await runProbe(false);
    chatTest.value = Boolean(data.chat);
  } catch {
    chatTest.value = false;
  } finally {
    chatProbing.value = false;
  }
}

async function testVision(): Promise<void> {
  if (visionProbing.value) return;
  visionProbing.value = true;
  visionTest.value = null;
  try {
    const data = await runProbe(true);
    visionTest.value = Boolean(data.image);
  } catch {
    visionTest.value = false;
  } finally {
    visionProbing.value = false;
  }
}

/* ── 小工具 ───────────────────────────────────────────────────────────── */

/** 供应商图标：预设厂商用官方图标，自定义供应商用「名称首字/首字母」（大小写统一成大写） */
function logoOf(p: { kind: ProviderKind; name: string }): string {
  if (p.kind !== 'custom') return PRESETS[p.kind]?.logo ?? '＋';
  const first = Array.from(p.name.trim())[0] ?? '';
  return first ? first.toUpperCase() : '＋';
}

/** 数字输入框清空时 v-model.number 给出空字符串，转成 null 交给服务端（= 用默认值） */
function toNumOrNull(v: number | string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 预设按钮文案：128000 → 128k，1000000 → 1M */
function fmtPreset(v: number): string {
  return v >= 1_000_000 ? `${v / 1_000_000}M` : `${v / 1000}k`;
}

function kindLabel(kind: ProviderKind): string {
  return PRESETS[kind]?.title ?? '自定义供应商';
}

function maskedHint(p: Provider): string {
  return p.hasKey ? `已保存 ${p.keyMask || 'Key'}（留空保持原值）` : '粘贴供应商控制台里的 API Key';
}

// 切换供应商：重置面板与测试结果，避免串用上一个供应商的列表
watch(selectedId, () => {
  catalogMode.value = null;
  chatTest.value = null;
  visionTest.value = null;
  showApiKey.value = false;
});

// 改了模型名就该重测：旧结果对不上新模型
watch(
  () => [selected.value?.model, selected.value?.visionModel],
  () => {
    chatTest.value = null;
    visionTest.value = null;
  }
);

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="prov-pane">
    <div class="prov-bar">
      <div class="prov-bar-text">
        <h4 class="prov-title">供应商连接</h4>
        <p class="prov-sub">
          每个供应商 = 一套 OpenAI 兼容接口配置（Base URL + API Key + 模型），请求走 /chat/completions 与 /models。聊天模型与图片识别各有独立开关，同类开关全局只能开一个（A 开聊天、B 开识图可以并存），开着开关的供应商左侧显示绿点。
        </p>
      </div>
      <div class="prov-bar-actions">
        <button class="btn small" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
        <button class="btn small btn-primary" @click="view = 'add'">＋ 添加供应商</button>
      </div>
    </div>

    <div class="prov-body">
      <!-- 左侧供应商列表 -->
      <aside class="prov-side" aria-label="供应商列表">
        <div class="side-label">已添加</div>
        <div v-if="!providers.length" class="side-empty">还没有供应商</div>
        <button
          v-for="p in providers"
          :key="p.id"
          type="button"
          class="side-item"
          :class="{ active: p.id === selectedId }"
          :aria-current="p.id === selectedId"
          @click="selectedId = p.id; view = 'detail'"
        >
          <span class="side-logo" :data-kind="p.kind" :class="{ 'has-icon': iconFor(p) }">
            <img v-if="iconFor(p)" :src="iconFor(p)" alt="" aria-hidden="true" />
            <template v-else>{{ logoOf(p) }}</template>
          </span>
          <span class="side-name">{{ p.name }}</span>
          <span
            class="side-dot"
            :class="{ on: p.chatEnabled || p.visionEnabled }"
            :title="p.chatEnabled && p.visionEnabled ? '聊天与识图都在使用' : p.chatEnabled ? '聊天正在使用' : p.visionEnabled ? '识图正在使用' : '未启用'"
          ></span>
        </button>
      </aside>

      <!-- 右侧内容 -->
      <section class="prov-main">
        <!-- 添加供应商 -->
        <div v-if="view === 'add'" class="add-view">
          <div class="add-head">
            <button class="btn small" @click="view = 'detail'">← 返回</button>
            <b>添加供应商</b>
          </div>
          <div v-for="group in ADD_GROUPS" :key="group.title" class="add-group">
            <div class="add-group-title">{{ group.title }}</div>
            <div class="add-grid">
              <button v-for="kind in group.kinds" :key="kind" type="button" class="add-card" @click="addProvider(kind)">
                <span class="add-logo" :data-kind="kind" :class="{ 'has-icon': PRESET_ICONS[kind] }">
                  <img v-if="PRESET_ICONS[kind]" :src="PRESET_ICONS[kind]" alt="" aria-hidden="true" />
                  <template v-else>{{ PRESETS[kind].logo }}</template>
                </span>
                <span class="add-text">
                  <b>{{ PRESETS[kind].title }}</b>
                  <small>{{ PRESETS[kind].hint }}</small>
                </span>
                <span class="add-arrow" aria-hidden="true">›</span>
              </button>
            </div>
          </div>
          <p class="hint">选一个供应商填好 Key 就能用；聊天与识图可以在不同供应商上分别开启，随时在这里切换。</p>
        </div>

        <!-- 供应商详情 -->
        <div v-else-if="selected" class="detail">
          <div class="detail-head">
            <span class="side-logo" :data-kind="selected.kind" :class="{ 'has-icon': iconFor(selected) }">
              <img v-if="iconFor(selected)" :src="iconFor(selected)" alt="" aria-hidden="true" />
              <template v-else>{{ logoOf(selected) }}</template>
            </span>
            <div class="detail-title">
              <b>{{ selected.name }}</b>
              <span class="hint">{{ kindLabel(selected.kind) }}</span>
            </div>
            <button class="btn small danger" aria-label="删除供应商" @click="deleteId = selected.id">删除</button>
          </div>

          <section class="form-card">
            <div class="card-head">
              <h4>连接信息</h4>
              <p>Base URL 决定请求发到哪里，API Key 决定用什么身份调用</p>
            </div>
            <label class="field">
              <span>名称</span>
              <input v-model="selected.name" autocomplete="off" name="provider-name" spellcheck="false" placeholder="如 工作用 DeepSeek" />
            </label>

            <label class="field">
              <span>Base URL</span>
              <span v-if="selected.kind !== 'custom'" class="field-note">已按供应商预设，一般不用改</span>
              <input
                v-model="selected.baseUrl"
                autocomplete="off"
                name="provider-base-url"
                spellcheck="false"
                autocapitalize="off"
                autocorrect="off"
                placeholder="https://api.deepseek.com/v1"
                @blur="fetchCustomIcon(selected)"
              />
            </label>

            <label class="field">
              <span>API Key</span>
              <div class="input-eye">
                <input
                  v-model="selected.apiKey"
                  :type="apiKeyInputType"
                  :class="{ masked: !showApiKey && supportsTextSecurity }"
                  :placeholder="maskedHint(selected)"
                  :autocomplete="apiKeyInputType === 'password' ? 'new-password' : 'off'"
                  name="provider-api-key"
                  spellcheck="false"
                  autocapitalize="off"
                  autocorrect="off"
                />
                <button
                  class="eye-btn"
                  type="button"
                  :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
                  :title="showApiKey ? '隐藏' : '显示'"
                  @click="showApiKey = !showApiKey"
                >
                  {{ showApiKey ? '🙈' : '👁️' }}
                </button>
                <a
                  v-if="applyKeyUrl(selected.kind)"
                  class="key-link"
                  :href="applyKeyUrl(selected.kind)"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="`去${PRESETS[selected.kind].title}官网申请 API Key`"
                  @click.stop
                >
                  申请 API Key
                </a>
              </div>
            </label>
          </section>

          <section class="form-card">
            <div class="card-head">
              <h4>模型</h4>
              <p>聊天与识图各有一个开关，同类开关全局只能开一个，可以把它们放在不同供应商上</p>
            </div>

            <div class="model-block">
              <div class="model-head">
                <span class="model-title">聊天模型</span>
                <div class="model-head-side">
                  <span class="model-state" :class="{ on: selected.chatEnabled }">
                    {{ selected.chatEnabled ? '聊天正在使用' : '未启用' }}
                  </span>
                  <button
                    type="button"
                    class="switch"
                    role="switch"
                    :aria-checked="selected.chatEnabled"
                    :class="{ on: selected.chatEnabled }"
                    :aria-label="selected.chatEnabled ? '关闭聊天模型' : '开启聊天模型'"
                    @click="toggleChat(selected)"
                  >
                    <span class="knob"></span>
                  </button>
                </div>
              </div>
              <label class="field">
                <div class="with-btn">
                  <input v-model="selected.model" autocomplete="off" placeholder="如 deepseek-chat" />
                  <button class="btn small" type="button" @click="openCatalog('chat')">模型列表</button>
                  <button
                    class="btn small test-btn"
                    type="button"
                    :disabled="chatProbing || !selected.baseUrl || !selected.model"
                    @click="testChat"
                  >
                    {{ chatProbing ? '测试中…' : '测试连接' }}
                  </button>
                </div>
                <span v-if="chatTest !== null" class="test-line" :class="chatTest ? 'ok' : 'bad'">
                  {{ chatTest ? '聊天模型可用' : '聊天模型连不上，检查 Base URL / API Key / 模型名' }}
                </span>
              </label>
              <AiModelCatalog
                v-if="catalogMode === 'chat'"
                :provider-id="selected.id"
                :base-url="selected.baseUrl"
                :api-key="selected.apiKey"
                mode="chat"
                :model-value="selected.model"
                @pick="pickModel"
                @close="catalogMode = null"
              />
            </div>

            <div class="model-block">
              <div class="model-head">
                <span class="model-title">图片识别模型</span>
                <div class="model-head-side">
                  <span class="model-state" :class="{ on: selected.visionEnabled }">
                    {{ selected.visionEnabled ? '识图正在使用' : '未启用' }}
                  </span>
                  <button
                    type="button"
                    class="switch"
                    role="switch"
                    :aria-checked="selected.visionEnabled"
                    :class="{ on: selected.visionEnabled }"
                    :aria-label="selected.visionEnabled ? '关闭图片识别' : '开启图片识别'"
                    @click="toggleVision(selected)"
                  >
                    <span class="knob"></span>
                  </button>
                </div>
              </div>
              <label class="field">
                <span class="field-note">可选，留空沿用本供应商的聊天模型；识图需要支持视觉的模型</span>
                <div class="with-btn">
                  <input
                    v-model="selected.visionModel"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="留空沿用聊天模型"
                  />
                  <button class="btn small" type="button" @click="openCatalog('vision')">模型列表</button>
                  <button
                    class="btn small test-btn"
                    type="button"
                    :disabled="visionProbing || !selected.baseUrl || !(selected.visionModel || selected.model)"
                    @click="testVision"
                  >
                    {{ visionProbing ? '测试中…' : '测试连接' }}
                  </button>
                </div>
                <span v-if="visionTest !== null" class="test-line" :class="visionTest ? 'ok' : 'bad'">
                  {{ visionTest ? '识别图片可用' : '该模型不能识图（不支持图片输入或调用失败）' }}
                </span>
              </label>
              <AiModelCatalog
                v-if="catalogMode === 'vision'"
                :provider-id="selected.id"
                :base-url="selected.baseUrl"
                :api-key="selected.apiKey"
                mode="vision"
                :model-value="selected.visionModel"
                @pick="pickModel"
                @close="catalogMode = null"
              />
            </div>
          </section>

          <!-- 可选的高级参数：留空就用服务端/模型默认值 -->
          <details class="advanced">
            <summary>高级参数（可选）</summary>
            <div class="adv-fields">
              <label class="field">
                <span>温度</span>
                <span class="field-note">0~2，留空用默认</span>
                <input v-model.number="temperature" type="number" step="0.1" min="0" max="2" placeholder="留空" />
              </label>
              <div class="field">
                <span>上下文窗口（tokens）</span>
                <span class="field-note">窗口越大能保留的历史对话越多；留空则不裁剪，交给接口自行处理</span>
                <div class="preset-row">
                  <input v-model.number="contextWindow" type="number" min="1" placeholder="留空" />
                  <button
                    v-for="p in CONTEXT_PRESETS"
                    :key="p"
                    type="button"
                    class="preset-chip"
                    :class="{ on: contextWindow === p }"
                    :disabled="contextWindow === p"
                    @click="contextWindow = p"
                  >
                    {{ fmtPreset(p) }}
                  </button>
                </div>
              </div>
              <div class="field">
                <span>最大输出（tokens）</span>
                <span class="field-note">留空用模型默认</span>
                <div class="preset-row">
                  <input v-model.number="maxTokens" type="number" min="1" placeholder="留空" />
                  <button
                    v-for="p in MAX_TOKEN_PRESETS"
                    :key="p"
                    type="button"
                    class="preset-chip"
                    :class="{ on: maxTokens === p }"
                    :disabled="maxTokens === p"
                    @click="maxTokens = p"
                  >
                    {{ fmtPreset(p) }}
                  </button>
                </div>
              </div>
            </div>
          </details>

          <div class="save-row">
            <button class="btn btn-primary" :disabled="saving" @click="save(false)">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </div>

        <div v-else class="empty">从左侧选一个供应商，或点「添加供应商」新增</div>
      </section>
    </div>

    <ConfirmDialog
      v-model="deleteOpen"
      title="删除供应商"
      :message="`确定删除「${deleteName}」吗？删除后它的 API Key 与模型配置都会一起清掉。`"
      confirmText="删除"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.prov-pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
  max-height: 62vh;
}
/* 小号按钮（与 AI 设置弹窗其它分区保持一致的视觉） */
.btn.small {
  min-height: 34px;
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-sm);
  border: none;
  background: var(--glass-bg-strong);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  white-space: nowrap;
}
.btn.small:hover:not(:disabled) {
  transform: none;
  color: var(--text-primary);
  background: var(--glass-bg);
}
/* 小号主按钮：保留渐变，不被 .btn.small 的浅底覆盖 */
.btn.small.btn-primary {
  background: linear-gradient(135deg, var(--accent-orange), var(--accent-pink));
  color: #fff;
  box-shadow: 0 4px 12px rgba(255, 155, 176, 0.35);
}
.btn.small.btn-primary:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--accent-orange), var(--accent-pink));
  color: #fff;
  filter: brightness(1.06);
}
.btn.small.danger {
  background: var(--glass-bg-strong);
  color: var(--text-secondary);
  border: none;
  box-shadow: none;
}
.btn.small.danger:hover:not(:disabled) {
  background: rgba(255, 107, 107, 0.16);
  color: var(--danger);
  filter: none;
}
.btn.small:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.test-result {
  font-size: var(--fs-xs);
  margin: 0;
  padding: var(--space-6) var(--space-8);
  border-radius: var(--r-sm);
  white-space: pre-wrap;
  word-break: break-all;
}
.test-result.bad {
  background: rgba(255, 122, 122, 0.16);
}
.prov-bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-12);
  flex-wrap: wrap;
}
.prov-bar-text {
  flex: 1;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 分区主标题：与 hint 明确拉开层级 */
.prov-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 700;
  color: var(--text-primary);
}
.prov-sub {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  line-height: 1.6;
  max-width: 52ch;
}
.prov-bar-actions {
  display: flex;
  gap: var(--space-8);
  flex: none;
  padding-top: 2px;
}
.hint {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  line-height: 1.6;
  margin: 0;
}

/* 分区卡片：把相关字段圈在一组，标题 + 副说明 + 字段
   底色故意带一点暖灰（不是纯白），让里面纯白的输入框能「浮」出来；
   边框用可见的暖色实线，替代原来白色半透明的 --glass-border。 */
.form-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
  padding: var(--space-16);
  border: 1px solid rgba(224, 188, 125, 0.55);
  border-radius: var(--r-md);
  background: #fdfaf6;
  box-shadow: 0 1px 2px rgba(90, 58, 74, 0.04);
}
.card-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: var(--space-8);
  border-bottom: 1px dashed rgba(224, 188, 125, 0.5);
}
.card-head h4 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-8);
  font-size: var(--fs-sm);
  font-weight: 700;
  color: var(--text-primary);
}
/* 标题左侧的小色条：一眼扫出分区起点 */
.card-head h4::before {
  content: '';
  flex: none;
  width: 4px;
  height: 14px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--accent-orange), var(--accent-pink));
}
.card-head p {
  margin: 0;
  font-size: var(--fs-2xs);
  color: var(--text-muted, #8a7a63);
  line-height: 1.5;
}

/* 左右两栏：左列表 + 右详情（参考图 1 的排布） */
.prov-body {
  display: grid;
  grid-template-columns: 190px 1fr;
  gap: var(--space-12);
  min-height: 0;
  flex: 1;
}
.prov-side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-8);
  border: 1px solid rgba(224, 188, 125, 0.4);
  border-radius: var(--r-md);
  background: #fff;
  overflow-y: auto;
  max-height: 56vh;
}
.side-label {
  font-size: var(--fs-2xs);
  color: var(--text-muted, #8a7a63);
  padding: var(--space-4) var(--space-6);
  letter-spacing: 0.04em;
}
.side-empty {
  font-size: var(--fs-xs);
  color: var(--text-muted, #8a7a63);
  padding: var(--space-10) var(--space-6);
  text-align: center;
}
.side-item {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-height: 40px;
  padding: var(--space-6) var(--space-8);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-base);
}
.side-item:hover {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}
.side-item.active {
  background: var(--glass-bg-strong);
  border-color: var(--accent-orange);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: var(--shadow-pill);
}
.side-logo {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: var(--r-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  font-weight: 700;
  background: rgba(255, 180, 84, 0.28);
  color: var(--text-on-orange, #7a4a00);
  overflow: hidden;
}
/* 有官方图标的供应商：去掉字母底色，让 PNG（自带透明/品牌底色）自己说话 */
.side-logo.has-icon,
.add-logo.has-icon {
  background: transparent;
}
.side-logo img,
.add-logo img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.side-logo[data-kind='deepseek'] {
  background: rgba(77, 107, 254, 0.18);
  color: #33459e;
}
.side-logo[data-kind='ark'] {
  background: rgba(255, 122, 122, 0.18);
  color: #a03a3a;
}
.side-logo[data-kind='minimax'] {
  background: rgba(126, 212, 185, 0.24);
  color: #2f6a58;
}
.side-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: var(--r-full);
  background: rgba(90, 58, 74, 0.18);
}
.side-dot.on {
  background: #22c55e;
}

/* 右侧外层面板保持白色玻璃，内层 .form-card 用暖色 —— 两层容器不撞色 */
.prov-main {
  min-width: 0;
  border: 1px solid rgba(224, 188, 125, 0.4);
  border-radius: var(--r-md);
  background: #fff;
  padding: var(--space-12);
  overflow-y: auto;
  max-height: 56vh;
}
.detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}
.detail-head {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  padding-bottom: var(--space-8);
  border-bottom: 1px dashed rgba(224, 188, 125, 0.55);
}
.detail-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--fs-md);
  color: var(--text-primary);
}

/* 添加供应商（参考图 2：分组卡片） */
.add-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}
.add-head {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  font-size: var(--fs-md);
  color: var(--text-primary);
}
.add-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
.add-group-title {
  font-size: var(--fs-xs);
  color: var(--text-muted, #8a7a63);
}
.add-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-8);
}
.add-card {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  padding: var(--space-10) var(--space-12);
  border: 1px solid rgba(224, 188, 125, 0.55);
  border-radius: var(--r-sm);
  background: #fff;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur-base), background var(--dur-base), box-shadow var(--dur-base);
}
.add-card:hover {
  border-color: var(--accent-orange);
  background: rgba(255, 180, 84, 0.12);
  box-shadow: var(--shadow-pill);
}
.add-logo {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  background: rgba(255, 180, 84, 0.28);
  color: var(--text-on-orange, #7a4a00);
  overflow: hidden;
}
.add-logo[data-kind='deepseek'] {
  background: rgba(77, 107, 254, 0.18);
  color: #33459e;
}
.add-logo[data-kind='ark'] {
  background: rgba(255, 122, 122, 0.18);
  color: #a03a3a;
}
.add-logo[data-kind='minimax'] {
  background: rgba(126, 212, 185, 0.24);
  color: #2f6a58;
}
.add-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.add-text b {
  font-size: var(--fs-sm);
}
.add-text small {
  font-size: var(--fs-2xs);
  color: var(--text-muted, #8a7a63);
  line-height: 1.5;
}
.add-arrow {
  color: var(--text-muted, #8a7a63);
  font-size: var(--fs-md);
}

/* 表单：label（强）与说明（弱）分层 */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--fs-xs);
  color: var(--text-muted, #5f5240);
}

/* ── 输入框：明确「可填写」的控件感 ──────────────────────────────────
   全局 input 用白色半透明边框 + 近白玻璃底，叠在白色卡片上完全看不见。
   这里覆盖成：纯白底 + 可见暖灰边框 + 轻微内阴影（凹陷感），
   圆角比卡片小一圈，让「容器」和「控件」一眼可分。
   checkbox 用 :not() 排除，保持原生勾选框外观。 */
.prov-pane input:not([type='checkbox']),
.prov-pane select,
.prov-pane textarea {
  width: 100%;
  padding: 10px var(--space-12);
  border: 1px solid rgba(90, 58, 74, 0.18);
  border-radius: var(--r-sm);
  background: #fff;
  color: var(--text-primary);
  box-shadow: inset 0 1px 2px rgba(90, 58, 74, 0.05);
  outline: none;
  transition: border-color var(--dur-base), box-shadow var(--dur-base), background var(--dur-base);
}
.prov-pane input:not([type='checkbox']):hover,
.prov-pane select:hover,
.prov-pane textarea:hover {
  border-color: rgba(90, 58, 74, 0.32);
}
.prov-pane input:not([type='checkbox']):focus,
.prov-pane select:focus,
.prov-pane textarea:focus {
  border-color: var(--accent-orange);
  background: #fff;
  box-shadow: 0 0 0 3px rgba(255, 180, 84, 0.22), inset 0 1px 2px rgba(90, 58, 74, 0.04);
}
/* 键盘焦点：沿用全局的 2px 深橙轮廓，别被上面的 outline:none 吞掉 */
.prov-pane input:not([type='checkbox']):focus-visible,
.prov-pane select:focus-visible,
.prov-pane textarea:focus-visible {
  outline: 2px solid var(--text-on-orange);
  outline-offset: 1px;
}
.prov-pane input::placeholder {
  color: var(--text-muted);
}
/* 原生 checkbox：全局 input 规则会把它拉成 100% 宽的方块，这里收回 */
.prov-pane input[type='checkbox'] {
  width: 15px;
  height: 15px;
  padding: 0;
  margin: 0;
  border-radius: 4px;
  accent-color: var(--accent-orange);
  flex: none;
  cursor: pointer;
}
/* 字段主标签：加大加重提色，和输入框、说明文字拉开层级 */
.field > span {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-secondary);
  line-height: 1.4;
}
/* 字段下方/下方的辅助说明：小一号、弱色、不加粗 */
.field > span.field-note {
  font-size: var(--fs-2xs);
  font-weight: 400;
  color: var(--text-muted, #8a7a63);
  margin-top: -2px;
}
.with-btn {
  display: flex;
  gap: var(--space-6);
  align-items: stretch;
}
.with-btn input {
  flex: 1;
}
.input-eye {
  display: flex;
  align-items: center;
  gap: 6px;
}
.input-eye input {
  flex: 1;
  min-width: 0;
}
/* 用 CSS 遮罩代替 password 类型：浏览器不再把它当密码框，也就不会自动填充/提示保存 */
.input-eye input.masked {
  -webkit-text-security: disc;
}
.eye-btn {
  flex: none;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-full);
  background: transparent;
  border: none;
  font-size: 15px;
  color: var(--text-secondary);
  cursor: pointer;
}
.eye-btn:hover {
  color: var(--text-primary);
  background: rgba(90, 58, 74, 0.08);
}
.key-link {
  flex: none;
  font-size: var(--fs-2xs);
  color: var(--accent-orange);
  text-decoration: none;
  white-space: nowrap;
  padding: var(--space-4);
}
.key-link:hover {
  text-decoration: underline;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-12);
}
.advanced {
  border: 1px solid rgba(224, 188, 125, 0.55);
  border-radius: var(--r-md);
  padding: var(--space-12);
  background: #fdfaf6;
  font-size: var(--fs-xs);
  color: var(--text-muted, #5f5240);
}
.advanced summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--text-secondary);
}
.advanced[open] summary {
  margin-bottom: var(--space-8);
}
.adv-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}
/* 预设值：输入框 + 一排胶囊按钮（参考界面里的 128k / 256k / 512k / 1M） */
.preset-row {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  flex-wrap: wrap;
}
.preset-row input {
  flex: 1;
  min-width: 96px;
}
.preset-chip {
  min-height: 30px;
  padding: 0 var(--space-10);
  border-radius: var(--r-pill);
  border: 1px solid rgba(90, 58, 74, 0.18);
  background: #fff;
  color: var(--text-secondary);
  font-size: var(--fs-2xs);
  cursor: pointer;
  transition: background var(--dur-base), border-color var(--dur-base);
}
.preset-chip:hover:not(:disabled) {
  border-color: var(--accent-orange);
  color: var(--text-primary);
}
.preset-chip.on,
.preset-chip:disabled {
  background: var(--glass-bg-strong);
  border-color: var(--accent-orange);
  color: var(--text-primary);
  cursor: default;
}

/* 模型分区：标题行右侧是开关，下面才是输入框 */
.model-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.model-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-10);
}
.model-title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-secondary);
  line-height: 1.4;
}
.model-head-side {
  display: flex;
  align-items: center;
  gap: var(--space-8);
}
.model-state {
  font-size: var(--fs-2xs);
  color: var(--text-muted, #8a7a63);
}
.model-state.on {
  color: #2f6b52;
}
.switch {
  flex: none;
  position: relative;
  width: 44px;
  height: 24px;
  /* 胶囊形：两端半圆、中间平直（--r-pill = 999px，不能用 --r-full 的 50%，那会变成椭圆） */
  border-radius: var(--r-pill);
  border: 1px solid rgba(90, 58, 74, 0.16);
  background: rgba(90, 58, 74, 0.12);
  cursor: pointer;
  transition: background var(--dur-base);
}
.switch .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: var(--r-full);
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: transform var(--dur-base);
}
.switch.on {
  background: var(--accent-orange);
  border-color: var(--accent-orange);
}
.switch.on .knob {
  transform: translateX(22px);
}

/* 模型列表面板 */
.catalog {
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  padding: var(--space-10);
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
.catalog-head {
  display: flex;
  gap: var(--space-6);
}
.catalog-title {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  white-space: nowrap;
  align-self: center;
}
.catalog-search {
  flex: 1;
}
.catalog-loading {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  text-align: center;
  padding: var(--space-10);
  margin: 0;
}
.catalog-list {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid rgba(224, 188, 125, 0.4);
  border-radius: var(--r-sm);
}
.catalog-item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: var(--space-8) var(--space-10);
  border: none;
  background: none;
  color: var(--text-primary);
  text-align: left;
  font-size: var(--fs-sm);
  cursor: pointer;
}
.catalog-item:hover {
  background: rgba(255, 180, 84, 0.18);
}
.catalog-item.picked {
  background: rgba(255, 180, 84, 0.3);
  font-weight: 600;
}
.catalog-id {
  word-break: break-all;
}
.catalog-badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}
.badge {
  font-size: var(--fs-2xs);
  line-height: 1.4;
  padding: 1px var(--space-8);
  border-radius: var(--r-pill);
  background: rgba(255, 209, 102, 0.32);
  color: var(--text-on-orange);
  white-space: nowrap;
}
.check {
  color: var(--text-on-orange);
  font-weight: 700;
  white-space: nowrap;
}

/* 测试连接：每个模型输入框右侧一个按钮，结果贴在框下方 */
.save-row {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-12);
  border-top: 1px dashed rgba(224, 188, 125, 0.55);
}
.test-btn {
  flex: none;
}
.test-line {
  align-self: flex-start;
  margin-top: var(--space-6);
  padding: 4px var(--space-10);
  border-radius: var(--r-pill);
  font-size: var(--fs-2xs);
  line-height: 1.5;
  white-space: normal;
  background: rgba(90, 58, 74, 0.08);
  color: var(--text-secondary);
}
.test-line.ok {
  background: rgba(126, 212, 185, 0.26);
  color: #2f6b52;
}
.test-line.bad {
  background: rgba(255, 107, 107, 0.16);
  color: #b23a3a;
}
.probe-error {
  margin: 0;
  font-size: var(--fs-2xs);
  color: #b23a3a;
  line-height: 1.5;
  word-break: break-all;
}
.field-error {
  font-size: var(--fs-2xs);
  color: #b23a3a;
  line-height: 1.5;
  word-break: break-all;
}
.field-note {
  font-size: var(--fs-2xs);
  color: var(--text-muted, #7a6a55);
  line-height: 1.5;
}
.empty {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  text-align: center;
  padding: var(--space-24);
}

/* 窄屏：两栏变上下 */
@media (max-width: 640px) {
  .prov-body {
    grid-template-columns: 1fr;
  }
  .prov-side,
  .prov-main {
    max-height: none;
  }
  .side-item {
    min-height: 44px;
  }
}
</style>