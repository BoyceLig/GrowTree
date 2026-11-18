<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import AiProviderSettings from '@/components/AiProviderSettings.vue';
import AiMemorySettings from '@/components/AiMemorySettings.vue';

/**
 * AI 设置弹窗（右上角菜单入口，仅主家长）。
 * 三个分区：模型/API、MCP、技能。
 *   - 模型/API（AiProviderSettings）：供应商模式 —— 智谱 / DeepSeek / 火山方舟 / MiniMax / 自定义，
 *     每个供应商一套 Base URL + API Key + 模型，聊天与识图各有一个开关，可分别指向不同供应商；
 *     模型名可手填，也可「模型列表」拉取 {baseUrl}/models 后点选回填。
 *   - 技能：目录制（<DATA_DIR>/skills/<文件夹>/SKILL.md），卡片列表 + 胶囊开关 + 卸载；
 *     Docker 部署挂 ./skills:/app/data/skills 卷即可热更新。
 */

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>();
const toast = useToastStore();

const tab = ref<'api' | 'mcp' | 'skills' | 'memory'>('api');

/* ── MCP ───────────────────────────────────────────────────────────────── */

/** 安全策略（写类/不可逆操作） */
const safety = ref<'alwaysAsk' | 'onDemand' | 'allowAll'>('onDemand');
/** 正在保存安全策略：此时别被 loadConfig 的旧响应覆盖 */
const savingSafety = ref(false);

type McpEntry = {
  title?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  confirm?: 'writes' | 'all' | 'none';
  tools?: string[];
  timeoutSeconds?: number;
};
const mcpServers = ref<Record<string, McpEntry>>({});
const editingName = ref<string | null>(null); // null=新建
const editingOriginalName = ref<string | null>(null); // 改名场景：原来的 key
const mcpEditingOpen = ref(false);
const mcpForm = ref<{ name: string; title: string; url: string; command: string; args: string; env: string; headers: string; confirm: 'writes' | 'all' | 'none'; timeoutSeconds: number }>(
  { name: '', title: '', url: '', command: '', args: '', env: '', headers: '', confirm: 'writes', timeoutSeconds: 30 }
);
const mcpTesting = ref<string | null>(null);
const mcpTestResult = ref<{ name: string; ok: boolean; detail: string } | null>(null);
/** 删除服务器需二次确认（ux-guidelines #35：破坏性操作必须确认） */
const mcpDeleteName = ref<string | null>(null);
const mcpDeleteOpen = computed({
  get: () => mcpDeleteName.value != null,
  set: (v: boolean) => {
    if (!v) mcpDeleteName.value = null;
  },
});
async function confirmMcpDelete(): Promise<void> {
  const name = mcpDeleteName.value;
  mcpDeleteName.value = null;
  if (!name) return;
  const next = { ...mcpServers.value };
  delete next[name];
  mcpServers.value = next;
  await saveMcp();
}

function kvLinesToObj(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function objToKvLines(obj?: Record<string, string>): string {
  return Object.entries(obj ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function openNewServer(): void {
  editingName.value = null;
  editingOriginalName.value = null;
  mcpEditingOpen.value = true;
  mcpForm.value = { name: '', title: '', url: '', command: '', args: '', env: '', headers: '', confirm: 'writes', timeoutSeconds: 30 };
}

function openEditServer(name: string): void {
  const e = mcpServers.value[name] ?? {};
  editingName.value = name;
  editingOriginalName.value = name;
  mcpEditingOpen.value = true;
  mcpForm.value = {
    name,
    title: e.title ?? name,
    url: e.url ?? '',
    command: e.command ?? '',
    args: (e.args ?? []).join(' '),
    env: objToKvLines(e.env),
    headers: objToKvLines(e.headers),
    confirm: e.confirm ?? 'writes',
    timeoutSeconds: e.timeoutSeconds ?? 30,
  };
}

function formToEntry(): McpEntry {
  const f = mcpForm.value;
  return {
    title: f.title.trim() || f.name.trim(),
    url: f.url.trim() || undefined,
    command: f.command.trim() || undefined,
    args: f.args.trim() ? f.args.trim().split(/\s+/) : [],
    env: kvLinesToObj(f.env),
    headers: kvLinesToObj(f.headers),
    enabled: mcpServers.value[editingOriginalName.value ?? '']?.enabled ?? true,
    confirm: f.confirm,
    timeoutSeconds: Math.max(1, Math.floor(Number(f.timeoutSeconds) || 30)),
  };
}

function saveServer(): void {
  const name = mcpForm.value.name.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    toast.warning('服务器名称只能包含字母、数字、下划线或连字符');
    return;
  }
  const entry = formToEntry();
  if (!entry.url && !entry.command) {
    toast.warning('url 与 command 必须填一个');
    return;
  }
  const next = { ...mcpServers.value };
  // 改名时删掉旧 key；同 id 覆盖
  if (editingOriginalName.value && editingOriginalName.value !== name) delete next[editingOriginalName.value];
  next[name] = entry;
  mcpServers.value = next;
  editingName.value = null;
  editingOriginalName.value = null;
  mcpEditingOpen.value = false;
  void saveMcp();
}

function removeServer(name: string): void {
  mcpDeleteName.value = name;
}

function toggleServer(name: string): void {
  const e = mcpServers.value[name];
  if (!e) return;
  mcpServers.value = { ...mcpServers.value, [name]: { ...e, enabled: e.enabled === false } };
  void saveMcp();
}

let safetySeq = 0;
async function saveSafety(mode: 'alwaysAsk' | 'onDemand' | 'allowAll'): Promise<void> {
  const seq = ++safetySeq;
  safety.value = mode;
  savingSafety.value = true;
  try {
    const data = await api.put<{ safety?: string }>('/ai/config', { safety: mode });
    if (seq !== safetySeq) return;
    // 以服务端实际落库的结果为准：存没存上，界面立刻就能看出来
    if (data.safety === 'alwaysAsk' || data.safety === 'onDemand' || data.safety === 'allowAll') {
      safety.value = data.safety;
    }
    const st = await api.get<{ safety?: string }>('/ai/status');
    if (seq !== safetySeq) return;
    if (st.safety === 'alwaysAsk' || st.safety === 'onDemand' || st.safety === 'allowAll') {
      safety.value = st.safety;
    }
    if (safety.value !== mode) toast.warning('安全策略没有存下来，请再试一次');
    else toast.success('安全策略已更新');
  } catch (err) {
    if (seq !== safetySeq) return;
    toast.warning((err as Error).message || '保存失败');
    // 保存失败：回到服务端当前值，别让界面显示一个没生效的状态
    try {
      const st = await api.get<{ safety?: string }>('/ai/status');
      if (seq === safetySeq && (st.safety === 'alwaysAsk' || st.safety === 'onDemand' || st.safety === 'allowAll')) {
        safety.value = st.safety;
      }
    } catch {
      /* 离线：保留用户选择 */
    }
  } finally {
    if (seq === safetySeq) savingSafety.value = false;
  }
}

async function saveMcp(): Promise<void> {
  try {
    const data = await api.put<{ warnings: string[] }>('/ai/config', { mcp: mcpServers.value });
    if (data.warnings?.length) toast.warning(data.warnings.join('；'));
    else toast.success('MCP 配置已保存');
  } catch (err) {
    toast.warning((err as Error).message || '保存失败');
  }
}

async function testServer(name: string): Promise<void> {
  mcpTesting.value = name;
  mcpTestResult.value = null;
  try {
    const entry = mcpServers.value[name];
    const data = await api.post<{ ok: boolean; tools?: { name: string; description: string }[]; error?: string }>('/ai/mcp/test', {
      name,
      entry,
    });
    if (data.ok) {
      const names = (data.tools ?? []).map((t) => t.name);
      mcpTestResult.value = {
        name,
        ok: true,
        detail: names.length ? `连接成功，${names.length} 个工具：${names.join('、')}` : '连接成功，但没有可用工具',
      };
    } else {
      mcpTestResult.value = { name, ok: false, detail: data.error ?? '连接失败' };
    }
  } catch (err) {
    mcpTestResult.value = { name, ok: false, detail: (err as Error).message };
  } finally {
    mcpTesting.value = null;
  }
}

/* ── 技能（目录制，只读 + 开关 + 刷新） ───────────────────────────────── */

type DirSkill = { folder: string; name: string; description: string; enabled: boolean; instructions: string; updatedAt: number; builtin?: boolean };
type SkillScan = { skills: DirSkill[]; warnings: { folder: string; problem: string }[]; dir: string; builtinDir?: string | null };
const skills = ref<SkillScan>({ skills: [], warnings: [], dir: '' });
const loadingSkills = ref(false);
const togglingSkill = ref<string | null>(null);

async function loadSkills(): Promise<void> {
  loadingSkills.value = true;
  try {
    skills.value = await api.get<SkillScan>('/ai/skills');
  } catch (err) {
    toast.warning((err as Error).message || '读取技能目录失败');
  } finally {
    loadingSkills.value = false;
  }
}

async function toggleSkill(s: DirSkill): Promise<void> {
  togglingSkill.value = s.folder;
  try {
    skills.value = await api.post<SkillScan>('/ai/skills/toggle', { folder: s.folder, enabled: !s.enabled });
  } catch (err) {
    toast.warning((err as Error).message || '操作失败');
  } finally {
    togglingSkill.value = null;
  }
}

function fmtTime(unix: number): string {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false });
}

/* ── 卸载技能（删目录，二次确认） ─────────────────────────────────────── */

const removeTarget = ref<DirSkill | null>(null);
const removeOpen = computed({
  get: () => removeTarget.value != null,
  set: (v: boolean) => {
    if (!v) removeTarget.value = null;
  },
});
const removingSkill = ref(false);

function askRemoveSkill(s: DirSkill): void {
  removeTarget.value = s;
}

async function confirmRemoveSkill(): Promise<void> {
  const target = removeTarget.value;
  removeTarget.value = null;
  if (!target || removingSkill.value) return;
  removingSkill.value = true;
  try {
    skills.value = await api.delete<SkillScan>(`/ai/skills/${encodeURIComponent(target.folder)}`);
    toast.success(`已卸载「${target.name}」`);
  } catch (err) {
    toast.warning((err as Error).message || '卸载失败');
  } finally {
    removingSkill.value = false;
  }
}

async function loadConfig(): Promise<void> {
  try {
    const data = await api.get<{ mcp: Record<string, McpEntry>; safety: 'alwaysAsk' | 'onDemand' | 'allowAll' }>('/ai/config');
    mcpServers.value = data.mcp ?? {};
    if (!savingSafety.value) safety.value = data.safety ?? 'onDemand';
  } catch (err) {
    toast.warning((err as Error).message || '读取 AI 设置失败');
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      mcpTestResult.value = null;
      openNewServer();
      void loadConfig();
    }
  }
);

watch(tab, (t) => {
  if (t === 'skills' && !skills.value.skills.length && !loadingSkills.value) void loadSkills();
});
</script>

<template>
  <Modal :model-value="modelValue" title="AI 设置" width="720px" @update:model-value="emit('update:modelValue', $event)">
    <div class="ai-settings">
      <div class="tabs" role="tablist" aria-label="AI 设置分区">
        <button class="tab" role="tab" :aria-selected="tab === 'api'" :class="{ active: tab === 'api' }" @click="tab = 'api'">模型 / API</button>
<button class="tab" role="tab" :aria-selected="tab === 'mcp'" :class="{ active: tab === 'mcp' }" @click="tab = 'mcp'">MCP</button>
        <button class="tab" role="tab" :aria-selected="tab === 'skills'" :class="{ active: tab === 'skills' }" @click="tab = 'skills'">技能/Skill</button>
        <button class="tab" role="tab" :aria-selected="tab === 'memory'" :class="{ active: tab === 'memory' }" @click="tab = 'memory'">记忆</button>
      </div>

      <!-- ── 模型 / API（供应商模式，独立组件） ── -->
<AiProviderSettings v-if="tab === 'api'" />

      <!-- ── MCP ── -->
      <div v-else-if="tab === 'mcp'" class="pane">
        <div class="safety-row">
          <span class="safety-label">安全策略（写类/不可逆操作）</span>
          <div class="safety-opts" role="radiogroup" aria-label="安全策略">
            <button class="mini-opt" :class="{ on: safety === 'allowAll' }" @click="saveSafety('allowAll')">允许</button>
            <button class="mini-opt" :class="{ on: safety === 'onDemand' }" @click="saveSafety('onDemand')">按需</button>
            <button class="mini-opt" :class="{ on: safety === 'alwaysAsk' }" @click="saveSafety('alwaysAsk')">询问</button>
          </div>
          <span class="safety-hint">允许=不询问直接执行并全部审计；按需=仅高风险操作（外部 MCP、写技能文件）弹确认卡；询问=每次写操作都弹确认卡（可允许一次/本次任务都允许/拒绝）</span>
        </div>

        <p class="hint">
标准 mcpServers JSON 配置，支持 HTTP 与本地命令两种接入。值里可以写
          <code>${环境变量}</code> 引用服务端的同名环境变量。
        </p>

        <div v-if="Object.keys(mcpServers).length === 0" class="empty">还没有配置 MCP 服务器</div>
        <div v-for="(entry, name) in mcpServers" :key="name" class="server-row" :class="{ disabled: entry.enabled === false }">
          <div class="server-main">
            <b>{{ entry.title || name }}</b>
            <code class="server-name">{{ name }}</code>
            <span class="server-ep">{{ entry.url || entry.command }}</span>
            <span class="server-confirm">{{ entry.confirm === 'all' ? '每次确认' : entry.confirm === 'none' ? '不确认' : '写操作确认' }}</span>
          </div>
          <div class="server-actions">
            <button class="btn small" :disabled="mcpTesting === name" @click="testServer(String(name))">{{ mcpTesting === name ? '测试中…' : '测试' }}</button>
            <button class="btn small" @click="openEditServer(String(name))">编辑</button>
            <button class="btn small" :aria-pressed="entry.enabled !== false" @click="toggleServer(String(name))">{{ entry.enabled === false ? '启用' : '停用' }}</button>
            <button class="btn small danger" aria-label="删除 MCP 服务器" @click="mcpDeleteName = String(name)">删除</button>
          </div>
          <p v-if="mcpTestResult?.name === name" class="test-result" :class="mcpTestResult.ok ? 'ok' : 'bad'">
            {{ mcpTestResult.ok ? '✅' : '❌' }} {{ mcpTestResult.detail }}
          </p>
        </div>

        <button class="btn" @click="openNewServer">＋ 添加服务器</button>

        <div v-if="mcpEditingOpen" class="server-form">
          <div class="sf-title">{{ editingOriginalName ? '编辑服务器' : '添加服务器' }}</div>
          <div class="grid2">
            <label class="field"><span>名称（字母/数字/_/-）</span><input v-model="mcpForm.name" placeholder="amap" /></label>
            <label class="field"><span>显示名</span><input v-model="mcpForm.title" placeholder="高德地图" /></label>
          </div>
          <label class="field"><span>HTTP 地址（二选一）</span><input v-model="mcpForm.url" placeholder="https://mcp.example.com/mcp" /></label>
          <label class="field"><span>本地命令（二选一）</span><input v-model="mcpForm.command" placeholder="npx -y @modelcontextprotocol/server-xxx" /></label>
          <label class="field"><span>命令参数（空格分隔）</span><input v-model="mcpForm.args" placeholder="--key xxx" /></label>
          <div class="grid2">
            <label class="field"><span>环境变量（每行 KEY=value）</span><textarea v-model="mcpForm.env" rows="3" placeholder="AMAP_KEY=xxx"></textarea></label>
            <label class="field"><span>请求头（每行 KEY=value）</span><textarea v-model="mcpForm.headers" rows="3" placeholder="Authorization=Bearer xxx"></textarea></label>
          </div>
          <div class="grid2">
            <label class="field">
              <span>调用确认策略</span>
              <select v-model="mcpForm.confirm">
                <option value="writes">疑似写操作需确认</option>
                <option value="all">每次调用都要确认</option>
                <option value="none">不确认</option>
              </select>
            </label>
            <label class="field"><span>超时（秒）</span><input v-model="mcpForm.timeoutSeconds" type="number" min="1" /></label>
          </div>
          <div class="sf-actions">
            <button class="btn btn-primary" @click="saveServer">保存服务器</button>
            <button class="btn" @click="mcpEditingOpen = false">取消</button>
          </div>
        </div>
      </div>

<!-- ── 技能（目录制） ── -->
      <div v-else-if="tab === 'skills'" class="pane">
        <p class="hint">
          技能 = 一段指令（<b>名字 + 一句话描述 + 正文</b>），放在数据目录的 <code>skills/</code> 子目录，
          每个技能一个文件夹、里面一个 <code>SKILL.md</code>。AI 对话时，启用的技能会注入它的系统提示词。
          <b>【预设】</b>是随程序发布的内置技能，排在最前、始终启用，不能停用或卸载；其余技能可以自己开关或卸载。
        </p>

<div class="skill-dir-row">
          <code class="skill-dir">{{ skills.dir || '（数据目录）/skills' }}</code>
          <button class="btn small" :disabled="loadingSkills" @click="loadSkills">{{ loadingSkills ? '刷新中…' : '🔄 刷新' }}</button>
        </div>
        <p v-if="skills.builtinDir" class="skill-dir-note">
          预设技能目录：<code>{{ skills.builtinDir }}</code>（随程序发布，只读）
        </p>

        <div v-if="!skills.skills.length && !skills.warnings.length && !loadingSkills" class="empty">
          技能目录还是空的 —— 新建 <code>skills/我的技能/SKILL.md</code>（frontmatter 写 name 和 description，正文写指令）
        </div>
<div v-for="s in skills.skills" :key="s.folder" class="skill-card" :class="{ disabled: !s.enabled }">
          <div class="skill-main">
            <div class="skill-head">
              <b class="skill-name">{{ s.name }}</b>
              <span v-if="s.builtin" class="preset-badge">预设</span>
              <code class="server-name">{{ s.folder }}</code>
            </div>
            <span class="skill-desc">{{ s.description }}</span>
            <span v-if="s.updatedAt" class="skill-time">更新于 {{ fmtTime(s.updatedAt) }}</span>
          </div>
          <div class="skill-actions">
            <button
              type="button"
              class="switch"
              role="switch"
              :aria-checked="s.enabled"
              :aria-label="`${s.enabled ? '停用' : '启用'}技能 ${s.name}`"
              :class="{ on: s.enabled }"
              :disabled="s.builtin || togglingSkill === s.folder"
              :title="s.builtin ? '内置预设技能始终启用，不能停用' : ''"
              @click="toggleSkill(s)"
            >
              <span class="knob" />
            </button>
            <button v-if="!s.builtin" class="btn small danger" @click="askRemoveSkill(s)">卸载</button>
          </div>
        </div>
        <div v-for="w in skills.warnings" :key="w.folder" class="warn-row">
          ⚠️ <b>{{ w.folder }}</b>：{{ w.problem }}
        </div>

        <details class="skill-sample">
          <summary>SKILL.md 写法示例</summary>
          <pre>---
name: 积分导入助手
description: 把图片或文件里的积分记录整理成规范格式再提交
enabled: true
---

当用户发来积分记录照片或文件时：
1. 逐行识别出「孩子、加/减分、原因、日期」；
2. 识别不全的先向家长确认，不要猜；
3. 整理完后调用 add_point_records 提交，等家长点确认。</pre>
</details>
      </div>

      <!-- ── 记忆（Markdown 文件，可编辑/删除） ── -->
      <AiMemorySettings v-else />
    </div>

    <template #footer>
      <button class="btn" @click="emit('update:modelValue', false)">关闭</button>
    </template>
  </Modal>

<ConfirmDialog
    v-model="mcpDeleteOpen"
    title="删除 MCP 服务器"
    :message="`确定删除「${mcpDeleteName ?? ''}」吗？删除后 AI 将无法再调用它的工具。`"
    confirmText="删除"
    variant="danger"
    @confirm="confirmMcpDelete"
  />

  <ConfirmDialog
    v-model="removeOpen"
    title="卸载技能"
    :message="`确定卸载「${removeTarget?.name ?? ''}」吗？会删除技能文件夹 ${removeTarget?.folder ?? ''}，无法撤销。`"
    confirmText="卸载"
    variant="danger"
    @confirm="confirmRemoveSkill"
  />
</template>

<style scoped>
.ai-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
}
.tabs {
  display: flex;
  gap: var(--space-4);
  padding: var(--space-4);
  border-radius: var(--r-md);
  background: #fdfaf6;
  border: 1px solid rgba(224, 188, 125, 0.55);
}
.tabs .tab {
  flex: 1;
  min-height: 40px;
  border-radius: var(--r-sm);
  color: var(--text-secondary);
  font-weight: 600;
  transition: all var(--dur-base);
  font-size: var(--fs-md);
  background: transparent;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tabs .tab:hover {
  color: var(--text-primary);
}
.tabs .tab.active {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
  box-shadow: var(--shadow-pill);
}
.pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
  max-height: 56vh;
  overflow-y: auto;
}
.hint {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  line-height: 1.6;
  margin: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--fs-xs);
  color: var(--text-muted, #5f5240);
}
/* 字段主标签：加重提色，与说明文字分层 */
.field > span {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-secondary);
  line-height: 1.4;
}
/* 输入框：纯白底 + 可见边框 + 凹陷感，和玻璃卡片区分开
   （全局 input 的白色半透明边框在浅色卡片上等于没有） */
.pane input,
.pane select,
.pane textarea {
  width: 100%;
  padding: 10px var(--space-12);
  border: 1px solid rgba(90, 58, 74, 0.18);
  border-radius: var(--r-sm);
  background: #fff;
  color: var(--text-primary);
  box-shadow: inset 0 1px 2px rgba(90, 58, 74, 0.05);
  outline: none;
  transition: border-color var(--dur-base), box-shadow var(--dur-base);
}
.pane input:hover,
.pane select:hover,
.pane textarea:hover {
  border-color: rgba(90, 58, 74, 0.32);
}
.pane input:focus,
.pane select:focus,
.pane textarea:focus {
  border-color: var(--accent-orange);
  box-shadow: 0 0 0 3px rgba(255, 180, 84, 0.22), inset 0 1px 2px rgba(90, 58, 74, 0.04);
}
.pane input:focus-visible,
.pane select:focus-visible,
.pane textarea:focus-visible {
  outline: 2px solid var(--text-on-orange);
  outline-offset: 1px;
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-12);
}
.safety-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  padding: var(--space-12) var(--space-16);
  border: 1px solid rgba(224, 188, 125, 0.55);
  border-radius: var(--r-md);
  background: #fdfaf6;
}
.safety-label {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  font-weight: 600;
}
.safety-opts {
  display: flex;
  gap: var(--space-8);
}
.mini-opt {
  flex: 1;
  min-height: 34px;
  border-radius: var(--r-sm);
  border: 1px solid rgba(90, 58, 74, 0.18);
  background: #fff;
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.mini-opt.on {
  background: var(--glass-bg-strong);
  border-color: var(--accent-orange);
  color: var(--text-primary);
  font-weight: 600;
}
.safety-hint {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.5;
}
.empty {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  text-align: center;
  padding: var(--space-12);
}
.server-row {
  border: 1px solid rgba(224, 188, 125, 0.45);
  border-radius: var(--r-md);
  padding: var(--space-10) var(--space-12);
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  background: var(--glass-bg);
}
.server-row.disabled {
  opacity: 0.55;
}
.server-main {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  flex-wrap: wrap;
  font-size: var(--fs-sm);
}
.skill-card {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  padding: var(--space-12);
  border: 1px solid rgba(224, 188, 125, 0.45);
  border-radius: var(--r-md);
  background: #fff;
  transition: opacity var(--dur-base), border-color var(--dur-base);
}
.skill-card:hover {
  border-color: rgba(224, 188, 125, 0.8);
}
.skill-card.disabled {
  opacity: 0.6;
}
.skill-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.skill-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-8);
  flex-wrap: wrap;
}
.skill-name {
  font-size: var(--fs-md);
  color: var(--text-primary);
}
.preset-badge {
  font-size: var(--fs-2xs);
  padding: 1px var(--space-8);
  border-radius: var(--r-pill);
  background: rgba(126, 212, 185, 0.24);
  color: #2f6b52;
  white-space: nowrap;
}
.skill-dir-note {
  margin: -4px 0 0;
  font-size: var(--fs-2xs);
  color: var(--text-muted, #7a6a55);
  word-break: break-all;
}
.skill-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-10);
}
.switch {
  flex: none;
  position: relative;
  width: 44px;
  height: 24px;
  /* 胶囊形：两端半圆、中间平直（--r-pill = 999px） */
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
  transform: translateX(20px);
}
.switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.server-name {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
}
.server-ep {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
  white-space: nowrap;
}
.server-confirm {
  font-size: var(--fs-xs);
  background: rgba(126, 212, 185, 0.2);
  border-radius: var(--r-full);
  padding: 2px 8px;
  color: #2f6b52;
}
.skill-desc {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  flex: 1;
}
.skill-time {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  opacity: 0.8;
}
.skill-dir-row {
  display: flex;
  align-items: center;
  gap: var(--space-8);
}
.skill-dir {
  flex: 1;
  font-size: var(--fs-xs);
  background: #fff;
  border: 1px solid rgba(90, 58, 74, 0.18);
  border-radius: var(--r-sm);
  padding: var(--space-6) var(--space-10);
  word-break: break-all;
  color: var(--text-secondary);
}
.warn-row {
  font-size: var(--fs-xs);
  color: #8a5a00;
  background: rgba(255, 200, 100, 0.16);
  border-radius: var(--r-sm);
  padding: var(--space-6) var(--space-10);
}
.skill-sample {
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
}
.skill-sample pre {
  background: var(--glass-bg);
  border-radius: var(--r-sm);
  padding: var(--space-8) var(--space-10);
  white-space: pre-wrap;
  font-size: 0.92em;
  line-height: 1.5;
}
.server-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
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
.test-result.ok {
  background: rgba(126, 212, 185, 0.2);
}
.test-result.bad {
  background: rgba(255, 122, 122, 0.16);
}
.server-form {
  border: 1px solid rgba(224, 188, 125, 0.55);
  border-radius: var(--r-md);
  padding: var(--space-16);
  background: #fdfaf6;
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}
.sf-title {
  font-weight: 700;
  font-size: var(--fs-sm);
}
.sf-actions {
  display: flex;
  gap: var(--space-8);
}
</style>
