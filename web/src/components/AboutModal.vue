<script setup lang="ts">
/**
 * 「关于满伴成长树」弹窗：版本号 + 检查更新 + 更新内容 + 作者与许可 + 上游致谢。
 *
 * 数据全部来自 `GET /api/about`（后端读镜像里的 CHANGELOG.md），
 * 版本号与「一键升级」同源（MANALONG_VERSION），不会出现两处版本号打架。
 *
 * 更新内容固定只显示最近 PREVIEW_COUNT 个版本 —— 更新日志越攒越长，
 * 全铺出来会把「作者与许可」挤到很下面。
 *
 * 「检查更新」不在本组件里自己实现：点一下只把意图交给父级（头像菜单里的 Layout），
 * 由它关掉弹窗后再广播给提示条组件，查版本与升级弹窗始终只有一份实现。
 */
import { computed, ref, watch } from 'vue';
import Modal from '@/components/Modal.vue';
import { api } from '@/api/client';

interface ChangeGroup {
  title: string;
  items: string[];
}

interface ChangeVersion {
  version: string;
  date: string;
  groups: ChangeGroup[];
}

interface AboutInfo {
  name: string;
  nameEn: string;
  version: string;
  author: string;
  contact: string;
  licenseName: string;
  licenseNote: string;
  repo: string;
  credit: string;
  changelog: ChangeVersion[];
}

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  /** 请求检查更新（由父级关闭弹窗后广播 `manalong:check-update`） */
  check: [];
}>();

/** 更新内容只展示最近几个版本 */
const PREVIEW_COUNT = 3;

const info = ref<AboutInfo | null>(null);
const loading = ref(false);
const failed = ref('');

const versions = computed(() => (info.value?.changelog ?? []).slice(0, PREVIEW_COUNT));

async function load() {
  if (info.value || loading.value) return;
  loading.value = true;
  failed.value = '';
  try {
    info.value = await api.get<AboutInfo>('/about');
  } catch (e: any) {
    failed.value = e?.message || '内容加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) load();
  },
);
</script>

<template>
  <Modal
    :model-value="modelValue"
    title="关于满伴"
    width="480px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="about">
      <header class="brand">
        <img class="logo" src="/manalong.png" alt="" />
        <h4>
          满伴
          <span class="en">ManAlong</span>
        </h4>
        <p class="sub">家庭积分管理系统</p>
        <div class="ver-line">
          <span class="ver">v{{ info?.version ?? '…' }}</span>
          <span class="ver-tip">当前版本</span>
        </div>
        <button type="button" class="check" @click="emit('check')">🔄 检查更新</button>
      </header>

      <p v-if="loading" class="state">正在加载…</p>
      <p v-else-if="failed" class="state state-err">{{ failed }}</p>

      <template v-else-if="info">
        <section class="block">
          <h5>更新内容</h5>
          <p v-if="!versions.length" class="muted">这个版本没有附带更新说明</p>

          <div v-for="v in versions" :key="v.version + v.date" class="release">
            <div class="release-head">
              <strong>{{ v.version }}</strong>
              <span v-if="v.date" class="date">{{ v.date }}</span>
            </div>
            <div v-for="(g, gi) in v.groups" :key="gi" class="group">
              <div v-if="g.title" class="group-title">{{ g.title }}</div>
              <ul>
                <li v-for="(it, ii) in g.items" :key="ii">{{ it }}</li>
              </ul>
            </div>
          </div>

          <p v-if="versions.length" class="muted">仅显示最近 {{ versions.length }} 个版本</p>
        </section>

        <section class="block">
          <h5>作者与许可</h5>
          <p class="author">{{ info.author }} · 微信 {{ info.contact }}</p>
          <p class="muted">{{ info.licenseName }} —— {{ info.licenseNote }}</p>
          <a class="repo" :href="info.repo" target="_blank" rel="noopener noreferrer">{{ info.repo }}</a>
        </section>

        <p v-if="info.credit" class="credit">{{ info.credit }}</p>
      </template>
    </div>
  </Modal>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: var(--space-20);
}

.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  text-align: center;
}
.logo {
  width: 64px;
  height: 64px;
  border-radius: var(--r-lg);
  object-fit: contain;
}
.brand h4 {
  font-family: var(--font-cute);
  font-size: var(--fs-xl);
  display: flex;
  align-items: baseline;
  gap: var(--space-6);
}
.en {
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
  font-weight: 400;
  color: var(--text-muted);
}
.sub {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.ver-line {
  display: inline-flex;
  align-items: center;
  gap: var(--space-8);
  margin-top: var(--space-6);
  padding: var(--space-4) var(--space-12);
  border-radius: var(--r-full);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
}
.ver {
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-sm);
  color: var(--text-primary);
}
.ver-tip {
  font-size: var(--fs-2xs);
  color: var(--text-muted);
}

.state {
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  padding: var(--space-16) 0;
}
.state-err {
  color: var(--text-danger, #c0392b);
}

.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}
.block h5 {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
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
.date {
  font-size: var(--fs-xs);
  color: var(--text-muted);
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
}
/* 长英文/数字串（如摘要、路径）不许撑破卡片 */
.group li,
.muted,
.repo {
  overflow-wrap: anywhere;
}

/* 「检查更新」：与版本徽章同一套玻璃质感，点击后由提示条组件接管 */
.check {
  margin-top: var(--space-10);
  padding: var(--space-6) var(--space-14);
  border-radius: var(--r-full);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  transition: background var(--dur-fast);
}
.check:hover {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}

.author {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  padding-left: var(--space-4);
}
.muted {
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-muted);
  padding-left: var(--space-4);
}
.repo {
  font-size: var(--fs-xs);
  color: var(--accent-orange);
  padding-left: var(--space-4);
  word-break: break-all;
}

/* 上游致谢（MIT 署名）：压在最底部，用一条细线与上面的内容分开 */
.credit {
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-muted);
  padding-top: var(--space-14);
  border-top: 1px solid var(--glass-border);
  overflow-wrap: anywhere;
}
</style>
