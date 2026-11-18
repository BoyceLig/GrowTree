import path from 'node:path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { config } from '../../config.js';
import { ensureInsideDir } from './sentinel.js';

/**
 * 技能（Skill）：直接从数据目录的 skills/ 子目录读取（xiaoman DirectorySkillRepository 的思路）。
 *
 * 目录约定：
 *   <DATA_DIR>/skills/<技能文件夹名>/SKILL.md      ← 必需
 *   <DATA_DIR>/skills/<技能文件夹名>/flow.yaml    ← 可选（流程技能：按步骤调用工具）
 * SKILL.md 结构（与 xiaoman 同款）：
 *   ---
 *   name: 积分导入助手          ← 可选，缺省用文件夹名
 *   description: 一句话描述      ← 必填，进 system prompt 的技能清单
 *   enabled: true               ← 可选，缺省 true；设置界面开关会改这一行
 *   ---
 *   指令正文（markdown）……
 * flow.yaml 结构：
 *   name: 导入积分
 *   steps:
 *     - tool: list_children
 *     - tool: get_point_summary
 *       args:
 *         days: 7
 *
 * 为什么从目录而不是 DB：技能是「文本资产」，放在数据目录里可以随卷备份、
 * 用户能手工增删改，Docker 部署挂一个 ./skills:/app/data/skills 卷即可热更新；
 * 界面只做展示/开关/刷新，源头始终是文件。
 */

const SKILL_MD = 'SKILL.md';
const FLOW_YAML = 'flow.yaml';

export function skillsDir(): string {
  const dir = path.join(config.dataDir, 'skills');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 内置预设技能目录（随程序发布、不打进数据卷）：用户看得到但不可改/停用/卸载。
 * dev 下是 server/builtin-skills，Docker 下是 /app/server/builtin-skills。
 */
let builtinDirCache: string | null | undefined;
export function builtinSkillsDir(): string | null {
  if (builtinDirCache !== undefined) return builtinDirCache;
  const candidates = [
    path.resolve(__dirname, '../../../builtin-skills'),
    path.resolve(process.cwd(), 'server/builtin-skills'),
    path.resolve(process.cwd(), 'builtin-skills'),
  ];
  builtinDirCache = candidates.find((p) => existsSync(p)) ?? null;
  return builtinDirCache;
}

export type SkillFlowStep = { tool: string; args: Record<string, unknown> };
export type SkillFlow = { name: string; steps: SkillFlowStep[] };

export type DirSkill = {
  /** 文件夹名（唯一标识） */
  folder: string;
  name: string;
  description: string;
  enabled: boolean;
  instructions: string;
  /** SKILL.md 最后修改时间（unix 秒），给界面展示「最近改动」 */
  updatedAt: number;
  /** true = 内置预设技能（随程序发布，只读、不可停用/卸载） */
  builtin: boolean;
  /** flow.yaml 定义的流程（没有则不是流程技能） */
  flow?: SkillFlow;
};

export type SkillScanResult = {
  skills: DirSkill[];
  /** 无效文件夹的问题清单（名字 → 原因），坏文件夹不影响好技能 */
  warnings: { folder: string; problem: string }[];
  /** 技能目录绝对路径（界面提示用户往哪放文件） */
  dir: string;
  /** 内置预设技能目录（随程序发布，界面只读展示） */
  builtinDir: string | null;
};

/** 解析 SKILL.md 的 frontmatter：只要 `key: value` 单行格式（xiaoman 用完整 YAML，这里够用） */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
  if (end < 0) return null;
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) meta[key] = value;
  }
  return { meta, body: lines.slice(end + 1).join('\n').trim() };
}

/**
 * flow.yaml 的最小 YAML 解析（只支持本文件用到的形状）：
 *   顶层 name/description 标量 + steps 列表，每步 tool 标量与可选 args 映射。
 * 校验规则移植 xiaoman FlowParser 的精神：结构错的步骤直接报 problem，不静默跳过。
 */
export function parseFlowYaml(text: string): { flow?: SkillFlow; problem?: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let name = '';
  let inSteps = false;
  const steps: SkillFlowStep[] = [];
  let current: SkillFlowStep | null = null;
  let inArgs = false;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      inSteps = false;
      inArgs = false;
      current = null;
      const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
      if (!m) return { problem: `flow.yaml 顶层出现无法解析的行：${line.slice(0, 40)}` };
      if (m[1] === 'name') name = m[2].trim();
      else if (m[1] === 'steps') inSteps = true;
      continue;
    }
    if (!inSteps) return { problem: `flow.yaml 的步骤必须放在 steps: 下面（出现了游离内容：${line.slice(0, 40)}）` };
    const stepItem = /^-\s*tool\s*:\s*(\S+)\s*$/.exec(line);
    if (stepItem) {
      current = { tool: stepItem[1], args: {} };
      steps.push(current);
      inArgs = false;
      continue;
    }
    if (!current) return { problem: `steps: 列表必须以「- tool: 工具名」开头（出现了游离内容：${line.slice(0, 40)}）` };
    const argEntry = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (argEntry && argEntry[1] === 'args') {
      inArgs = true;
      // 行内写法 args: {"days": 7}
      if (argEntry[2].trim()) {
        try {
          current.args = JSON.parse(argEntry[2].trim());
        } catch {
          return { problem: `工具 ${current.tool} 的 args 行内值必须是 JSON：${argEntry[2].slice(0, 40)}` };
        }
      }
      continue;
    }
    if (inArgs && argEntry) {
      const v = argEntry[2].trim().replace(/^['"]|['"]$/g, '');
      const num = Number(v);
      current.args[argEntry[1]] = v !== '' && !Number.isNaN(num) ? num : v;
      continue;
    }
    return { problem: `步骤 ${current.tool} 下出现无法解析的行：${line.slice(0, 40)}` };
  }
  if (!steps.length) return { problem: 'steps: 至少需要一个「- tool: 工具名」步骤' };
  const unknown = steps.filter((s) => !/^[a-z_][a-z0-9_]*$/.test(s.tool));
  if (unknown.length) return { problem: `步骤工具名不合法：${unknown.map((s) => s.tool).join('、')}` };
  return { flow: { name: name || '未命名流程', steps } };
}

function scanOneFolder(baseDir: string, folder: string, builtin: boolean): { skill?: DirSkill; problem?: string } {
  const dir = ensureInsideDir(baseDir, folder);
  const mdPath = path.join(dir, SKILL_MD);
  let text: string;
  try {
    text = readFileSync(mdPath, 'utf-8');
  } catch {
    return { problem: `缺少 ${SKILL_MD}` };
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) return { problem: 'SKILL.md 需要 --- 包起来的 frontmatter 头（name/description）' };
  const name = (parsed.meta.name || folder).trim().slice(0, 40);
  const description = parsed.meta.description?.trim() ?? '';
  if (!description) return { problem: 'frontmatter 缺少 description（一句话描述，模型靠它决定何时用这个技能）' };
  if (description.includes('\n')) return { problem: 'description 必须是一行' };
  let updatedAt = 0;
  try {
    updatedAt = Math.floor(statSync(mdPath).mtimeMs / 1000);
  } catch {
    /* 展示字段，缺省 0 */
  }
  const skill: DirSkill = {
    folder,
    name,
    description: description.slice(0, 200),
    enabled: parsed.meta.enabled !== 'false',
    instructions: parsed.body.slice(0, 8000),
    updatedAt,
    builtin,
  };
  // 可选流程：flow.yaml 存在则解析校验
  try {
    const flowText = readFileSync(path.join(dir, FLOW_YAML), 'utf-8');
    const r = parseFlowYaml(flowText);
    if (r.flow) skill.flow = r.flow;
    else return { problem: `flow.yaml：${r.problem}` };
  } catch {
    /* 没有 flow.yaml，普通指令技能 */
  }
  return { skill };
}

function readFolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** 全量扫盘（每次都新读：文件可能被用户/挂载卷随时改过，「刷新」就是重新调这个）
 *  先扫内置预设技能（不可改），再扫数据目录里的用户技能；同名的用户技能会被忽略。 */
export function listSkills(): SkillScanResult {
  const dir = skillsDir();
  const builtinDir = builtinSkillsDir();
  const skills: DirSkill[] = [];
  const warnings: { folder: string; problem: string }[] = [];
  const seen = new Set<string>();

  if (builtinDir) {
    for (const folder of readFolders(builtinDir)) {
      if (folder.startsWith('_') || folder.startsWith('.')) continue;
      try {
        const { skill, problem } = scanOneFolder(builtinDir, folder, true);
        if (skill) {
          skills.push(skill);
          seen.add(folder);
        } else {
          warnings.push({ folder: `【预设】${folder}`, problem: problem! });
        }
      } catch (e) {
        warnings.push({ folder: `【预设】${folder}`, problem: `读取失败：${(e as Error)?.message ?? e}` });
      }
    }
  }

  for (const folder of readFolders(dir)) {
    if (folder.startsWith('_') || folder.startsWith('.')) continue; // 约定：下划线/点开头的文件夹视为存放区，不解析
    if (seen.has(folder)) {
      warnings.push({ folder, problem: '与内置预设技能同名，已忽略（请换个文件夹名）' });
      continue;
    }
    try {
      const { skill, problem } = scanOneFolder(dir, folder, false);
      if (skill) skills.push(skill);
      else warnings.push({ folder, problem: problem! });
    } catch (e) {
      warnings.push({ folder, problem: `读取失败：${(e as Error)?.message ?? e}` });
    }
  }
  return { skills, warnings, dir, builtinDir };
}

/** 设置界面的启用开关：只改 SKILL.md frontmatter 里的 enabled 行 */
export function setSkillEnabled(folder: string, enabled: boolean): { ok: boolean; error?: string } {
  let mdPath: string;
  try {
    mdPath = ensureInsideDir(skillsDir(), path.join(folder, SKILL_MD));
  } catch {
    return { ok: false, error: '技能文件夹名不合法' };
  }
  const builtinDir = builtinSkillsDir();
  if (builtinDir && existsSync(path.join(builtinDir, folder))) {
    return { ok: false, error: '内置预设技能不能停用（它随程序发布，始终生效）' };
  }
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/.test(folder)) return { ok: false, error: '技能文件夹名不合法' };
  let text: string;
  try {
    text = readFileSync(mdPath, 'utf-8');
  } catch {
    return { ok: false, error: `找不到 ${folder}/${SKILL_MD}` };
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return { ok: false, error: 'SKILL.md 没有 frontmatter，无法记录启用状态' };
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
  if (end < 0) return { ok: false, error: 'frontmatter 没有闭合的 ---' };
  let touched = false;
  for (let i = 1; i < end; i++) {
    if (/^enabled\s*:/.test(lines[i])) {
      lines[i] = `enabled: ${enabled ? 'true' : 'false'}`;
      touched = true;
      break;
    }
  }
  if (!touched) lines.splice(1, 0, `enabled: ${enabled ? 'true' : 'false'}`);
  try {
    writeFileSync(mdPath, lines.join('\n'), 'utf-8');
  } catch (e) {
    return { ok: false, error: `写入失败：${(e as Error)?.message ?? e}` };
  }
  return { ok: true };
}

/** 卸载技能：删除整个技能文件夹（界面上要二次确认） */
export function deleteSkillFolder(folder: string): { ok: boolean; error?: string } {
  const name = folder.trim();
  const builtinDir = builtinSkillsDir();
  if (builtinDir && existsSync(path.join(builtinDir, name))) {
    return { ok: false, error: '内置预设技能不能卸载' };
  }
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,40}$/.test(name)) return { ok: false, error: '技能文件夹名不合法' };
  try {
    const dir = ensureInsideDir(skillsDir(), name);
    if (!statSync(dir).isDirectory()) return { ok: false, error: '不是技能文件夹' };
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

/** 技能创作（AI 通过 create_skill 工具写）：新建或合并更新一个技能文件夹 */
export function writeSkillFolder(input: {
  folder: string;
  name: string;
  description: string;
  instructions: string;
  enabled?: boolean;
}): { folder: string; name: string; merged: boolean } {
  const folder = input.folder.trim();
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,40}$/.test(folder)) {
    throw new Error('技能文件夹名只能包含中文、字母、数字、下划线或连字符（最长 40）');
  }
  const name = input.name.trim().slice(0, 40);
  const description = input.description.trim().slice(0, 200);
  const instructions = input.instructions.trim().slice(0, 8000);
  if (!name) throw new Error('技能名称不能为空');
  if (!description || description.includes('\n')) throw new Error('技能描述必须是一行且不能为空');
  if (!instructions) throw new Error('技能指令内容不能为空');
  const builtinDir = builtinSkillsDir();
  if (builtinDir && existsSync(path.join(builtinDir, folder))) {
    throw new Error('这个文件夹名属于内置预设技能，请换一个名字');
  }

  const dir = ensureInsideDir(skillsDir(), folder);
  mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, SKILL_MD);
  let merged = false;
  let createdAt = new Date().toISOString().slice(0, 19);
  try {
    const existing = parseFrontmatter(readFileSync(mdPath, 'utf-8'));
    if (existing) {
      merged = true;
      createdAt = existing.meta.created || createdAt;
    }
  } catch {
    /* 新建 */
  }
  const meta = [`name: ${name}`, `description: ${description}`, `enabled: ${input.enabled !== false}`];
  // 保留原文件的 created（frontmatterText 会透传 raw 之外的字段，这里手动拼）
  const content = `---\n${meta.join('\n')}\ncreated: ${createdAt}\n---\n\n${instructions}\n`;
  writeFileSync(mdPath, content, 'utf-8');
  return { folder, name, merged };
}

/* ── system prompt 注入 ────────────────────────────────────────────────── */

const PROMPT_BUDGET_TOTAL = 16000;
const PROMPT_BUDGET_PER = 6000;

/** 注入 system prompt 的技能区块：清单（含流程技能标记）+ 启用技能的完整指令（带预算截断） */
export function buildSkillsPromptSection(): string {
  const { skills } = listSkills();
  const enabled = skills.filter((s) => s.enabled);
  if (!enabled.length) return '';
  const lines: string[] = ['', '', '## 可用技能（处理到相关请求时遵循对应技能的指令；【预设】为系统内置，始终启用）'];
  let remaining = PROMPT_BUDGET_TOTAL;
  for (const skill of enabled) {
    const flowMark = skill.flow ? '【流程技能，可用 run_skill 执行】' : '';
    lines.push(`- ${skill.builtin ? '【预设】' : ''}${skill.name}${flowMark}：${skill.description}`);
    if (remaining <= 0) continue;
    const body = skill.instructions.slice(0, PROMPT_BUDGET_PER).slice(0, remaining);
    if (body) {
      lines.push('', body);
      remaining -= body.length;
    }
  }
  return lines.join('\n');
}
