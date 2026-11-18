import path from 'node:path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { config } from '../../config.js';
import { ensureInsideDir } from './sentinel.js';

/**
 * 记忆层（移植 xiaoman core-memory，笔记格式对齐 Basic Memory）：
 *   - 笔记 = Markdown 文件，存 <DATA_DIR>/ai-memory/；
 *   - 格式：frontmatter（title/type/tags/created/updated）+ 正文；
 *   - 观察记录：正文里的 `- [分类] 内容` 行（Basic Memory 的 observations）；
 *   - 关联：`- [[另一个笔记]]` 行（wiki 链接，Basic Memory 的 relations）；
 *   - 检索：中文按「标题 > 标签 > 正文」加权打分，长查询再按逐字命中率兜底；
 *   - 文件可手工增删改，下次检索即生效。
 */

export type MemoryNote = {
  permalink: string;
  title: string;
  type: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** 观察记录：[分类, 内容] */
  observations: [string, string][];
  /** wiki 双链目标 */
  relations: string[];
  /** 除 frontmatter 外的原始正文（自由段落） */
  body: string;
};

export function memoryDir(): string {
  const dir = path.join(config.dataDir, 'ai-memory');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const NOTE_TYPE_HOWTO = 'howto';

function safePermalink(title: string): string {
  const base = title.trim().replace(/[\\/:*?"<>|#\s]+/g, '-').slice(0, 60) || 'note';
  return base;
}

function parseNote(raw: string, permalink: string): MemoryNote {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const meta: Record<string, string> = {};
  let bodyStart = 0;
  if ((lines[0] ?? '').trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
        if (m) meta[m[1]] = m[2].trim();
      }
      bodyStart = end + 1;
    }
  }
  const bodyLines = lines.slice(bodyStart);
  const observations: [string, string][] = [];
  const relations: string[] = [];
  const freeBody: string[] = [];
  for (const line of bodyLines) {
    const trimmed = line.trim();
    const obs = /^-\s*\[([^\]]+)\]\s*(.+)$/.exec(trimmed);
    const rel = /^-\s*\[\[([^\]]+)\]\]\s*$/.exec(trimmed);
    if (obs) observations.push([obs[1].trim(), obs[2].trim()]);
    else if (rel) relations.push(rel[1].trim());
    else freeBody.push(line);
  }
  const tags = meta.tags ? meta.tags.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  return {
    permalink,
    title: meta.title || permalink,
    type: meta.type || 'note',
    tags,
    createdAt: meta.created || '',
    updatedAt: meta.updated || '',
    observations,
    relations,
    body: freeBody.join('\n').trim(),
  };
}

function noteToMarkdown(note: Omit<MemoryNote, 'permalink'>, permalink: string): string {
  const now = new Date().toISOString().slice(0, 19);
  const lines = [
    '---',
    `title: ${note.title}`,
    `type: ${note.type}`,
    note.tags.length ? `tags: [${note.tags.join(', ')}]` : 'tags: []',
    `created: ${note.createdAt || now}`,
    `updated: ${now}`,
    `permalink: ${permalink}`,
    '---',
    '',
  ];
  if (note.observations.length) {
    lines.push('## Observations', '');
    for (const [cat, text] of note.observations) lines.push(`- [${cat}] ${text}`);
    lines.push('');
  }
  if (note.relations.length) {
    lines.push('## Relations', '');
    for (const r of note.relations) lines.push(`- [[${r}]]`);
    lines.push('');
  }
  if (note.body) {
    lines.push(note.body, '');
  }
  return lines.join('\n');
}

function scanPermalinks(): string[] {
  try {
    return readdirSync(memoryDir(), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name.slice(0, -3));
  } catch {
    return [];
  }
}

export function listMemoryNotes(): {
  permalink: string;
  title: string;
  type: string;
  tags: string[];
  updatedAt: string;
  /** 正文/观察记录里的一小段摘要，列表里给人看 */
  excerpt: string;
  observations: number;
}[] {
  const out: {
    permalink: string;
    title: string;
    type: string;
    tags: string[];
    updatedAt: string;
    excerpt: string;
    observations: number;
  }[] = [];
  for (const permalink of scanPermalinks()) {
    try {
      const p = ensureInsideDir(memoryDir(), `${permalink}.md`);
      const note = parseNote(readFileSync(p, 'utf-8'), permalink);
      let mtime = '';
      try {
        mtime = Math.floor(statSync(p).mtimeMs / 1000).toString();
      } catch {
        /* 忽略 */
      }
      const firstObs = note.observations[0]?.[1] ?? '';
      const excerpt = (firstObs || note.body).replace(/\s+/g, ' ').trim().slice(0, 120);
      out.push({
        permalink,
        title: note.title,
        type: note.type,
        tags: note.tags,
        updatedAt: mtime,
        excerpt,
        observations: note.observations.length,
      });
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 校验 permalink：只能是文件名，不允许目录穿越 */
export function isSafePermalink(permalink: string): boolean {
  return Boolean(permalink) && !/[\\/:*?"<>|]/.test(permalink) && permalink !== '.' && permalink !== '..';
}

/** 读整份 Markdown（含 frontmatter），给编辑器用 */
export function readMemoryMarkdown(permalink: string): string | undefined {
  if (!isSafePermalink(permalink)) return undefined;
  try {
    const p = ensureInsideDir(memoryDir(), `${permalink}.md`);
    // 去掉可能存在的 BOM，否则编辑器保存时首行 --- 校验会失败
    return readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
}

/** 原样写回整份 Markdown（编辑器保存）：只做最基本的格式校验，保留用户手写的结构 */
export function writeMemoryMarkdown(permalink: string, markdown: string): void {
  if (!isSafePermalink(permalink)) throw new Error('记忆文件名不合法');
  const text = markdown.replace(/\r\n/g, '\n');
  if (text.length > 200_000) throw new Error('内容太长（上限 200KB）');
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') throw new Error('缺少 frontmatter（第一行必须是 ---）');
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end <= 0) throw new Error('frontmatter 没有闭合（需要第二行 ---）');
  const head = lines.slice(1, end).join('\n');
  if (!/^title\s*:/m.test(head)) throw new Error('frontmatter 里必须有 title');
  const p = ensureInsideDir(memoryDir(), `${permalink}.md`);
  writeFileSync(p, text, 'utf-8');
}

export function readMemoryNote(permalink: string): MemoryNote | undefined {
  try {
    const p = ensureInsideDir(memoryDir(), `${permalink}.md`);
    return parseNote(readFileSync(p, 'utf-8'), permalink);
  } catch {
    return undefined;
  }
}

export type SaveNoteInput = {
  title: string;
  type?: string;
  tags?: string[];
  /** 追加的观察记录；已有相同内容会去重 */
  observations?: [string, string][];
  relations?: string[];
  body?: string;
};

/** 写笔记：已存在则合并（观察记录追加去重），不存在则新建（Basic Memory 的语义写） */
export function saveMemoryNote(input: SaveNoteInput): { permalink: string; merged: boolean } {
  const title = input.title.trim().slice(0, 60);
  if (!title) throw new Error('笔记标题不能为空');
  const permalink = safePermalink(title);
  const dir = memoryDir();
  const p = ensureInsideDir(dir, `${permalink}.md`);
  let existing: MemoryNote | undefined;
  try {
    existing = parseNote(readFileSync(p, 'utf-8'), permalink);
  } catch {
    existing = undefined;
  }

  const merged: Omit<MemoryNote, 'permalink'> = {
    title,
    type: input.type || existing?.type || 'note',
    tags: input.tags?.length ? input.tags : existing?.tags ?? [],
    createdAt: existing?.createdAt || new Date().toISOString().slice(0, 19),
    updatedAt: new Date().toISOString().slice(0, 19),
    observations: [...(existing?.observations ?? [])],
    relations: [...new Set([...(existing?.relations ?? []), ...(input.relations ?? [])])],
    body: input.body !== undefined ? input.body : existing?.body ?? '',
  };
  const seen = new Set(existing?.observations.map(([c, x]) => `${c}|${x}`) ?? []);
  for (const [cat, text] of input.observations ?? []) {
    const key = `${cat}|${text}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.observations.push([cat, text]);
    }
  }
  writeFileSync(p, noteToMarkdown(merged, permalink), 'utf-8');
  return { permalink, merged: Boolean(existing) };
}

export function deleteMemoryNote(permalink: string): boolean {
  try {
    const p = ensureInsideDir(memoryDir(), `${permalink}.md`);
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/* ── 中文检索 ──────────────────────────────────────────────────────────── */

export type MemoryHit = { permalink: string; title: string; snippet: string; score: number };

/**
 * 中文检索：标题命中 ×3、标签 ×2、正文命中 ×1；
 * 长查询按「逐字覆盖率」兜底（中文没有分词边界，全字命中也算相关）。
 */
export function searchMemory(query: string, limit = 5): MemoryHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: MemoryHit[] = [];
  for (const permalink of scanPermalinks()) {
    try {
      const p = ensureInsideDir(memoryDir(), `${permalink}.md`);
      const note = parseNote(readFileSync(p, 'utf-8'), permalink);
      const titleL = note.title.toLowerCase();
      const tagsL = note.tags.join(',').toLowerCase();
      const obsL = note.observations.map(([c, x]) => `${c}${x}`).join('\n').toLowerCase();
      const bodyL = `${note.body}\n${obsL}`.toLowerCase();
      if (!bodyL && !titleL) continue;

      let score = 0;
      if (titleL.includes(q)) score += 30;
      if (tagsL.includes(q)) score += 20;
      if (bodyL.includes(q)) score += 10;

      if (score === 0 && q.length >= 2) {
        // 逐字覆盖率兜底：查询里的每个字（去重）都在标题或正文里出现
        const chars = [...new Set([...q])].filter((c) => /[\u4e00-\u9fa5]/.test(c));
        if (chars.length) {
          const hit = chars.filter((c) => titleL.includes(c) || bodyL.includes(c) || tagsL.includes(c)).length;
          const ratio = hit / chars.length;
          if (ratio >= 0.8) score += Math.round(ratio * 12);
          else if (ratio >= 0.5) score += Math.round(ratio * 6);
        }
      }
      if (score > 0) {
        // 摘要：第一条命中的观察记录，或正文片段
        const idx = bodyL.indexOf(q);
        const obsHit = note.observations.find(([, x]) => x.toLowerCase().includes(q));
        const snippet = obsHit
          ? obsHit[1].slice(0, 120)
          : idx >= 0
            ? note.body.slice(Math.max(0, idx - 30), idx + 90).trim()
            : note.observations[0]?.[1]?.slice(0, 120) ?? note.body.slice(0, 120);
        hits.push({ permalink, title: note.title, snippet: snippet || permalink, score });
      }
    } catch {
      /* 坏文件跳过 */
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 经验沉淀：成功的工具路径写进 howto 类笔记（xiaoman learn 的对应物） */
export function learnExperience(moduleName: string, observation: string): void {
  if (!observation.trim()) return;
  saveMemoryNote({
    title: 'AI 经验本',
    type: NOTE_TYPE_HOWTO,
    tags: ['经验'],
    observations: [[moduleName, observation.trim().slice(0, 300)]],
  });
}
