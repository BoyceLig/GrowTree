/**
 * MCP（Model Context Protocol）接入。
 *
 * 配置格式与社区通用 mcpServers 完全一致（Claude Desktop / Cline 同款），
 * 并移植了 xiaoman McpConfig.parse 的关键行为：
 *   - 配置值里的 ${ENV_VAR} 做环境变量替换（Key 类信息不写死在配置里）；
 *   - 校验失败的服务器不生效，但只产生 warning，绝不让整个 AI 功能挂掉；
 *   - 连接是懒加载 + 按名字缓存，配置变更后 invalidate。
 *
 * 传输层用官方 @modelcontextprotocol/sdk（streamable HTTP + stdio 都覆盖）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerEntry } from './settings.js';

export type McpToolInfo = { name: string; description: string; server: string; inputSchema: Record<string, unknown> };

type LiveConnection = {
  client: Client;
  entry: McpServerEntry;
};

const connections = new Map<string, LiveConnection>();

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** ${VAR} 替换；缺失的变量记到 missing，由调用方决定降级策略 */
function substitute(value: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined || v === null || v === '') {
      missing.add(name);
      return '';
    }
    return v;
  });
}

export type ParsedMcpEntry = { name: string; entry: McpServerEntry };

/**
 * agent 侧入口：传入 getAiMcp() 的 Record<name, entry>，走同一套校验与 ${ENV} 替换。
 */
export function parseMcpServersWithEnv(record: Record<string, McpServerEntry>): { servers: ParsedMcpEntry[]; warnings: string[] } {
  return parseMcpConfig(record);
}

/**
 * 解析 mcpServers 配置（对象形状：{ mcpServers: { name: {...} } }，
 * 也容忍直接传 { name: {...} }——设置界面直接存的就是后者的 JSON）。
 * 返回有效服务器列表 + 逐条警告；坏配置永远只降级不抛错。
 */
export function parseMcpConfig(raw: unknown): { servers: ParsedMcpEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const servers: ParsedMcpEntry[] = [];
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    obj = (r.mcpServers && typeof r.mcpServers === 'object' ? (r.mcpServers as Record<string, unknown>) : r) as Record<
      string,
      unknown
    >;
  }
  if (!obj) {
    warnings.push('MCP 配置无效：需要 JSON 对象');
    return { servers, warnings };
  }
  for (const [name, value] of Object.entries(obj)) {
    if (name.startsWith('_')) continue; // 下划线开头视为注释项（社区惯例）
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      warnings.push(`服务器「${name}」未启用：名称只能包含字母、数字、下划线或连字符`);
      continue;
    }
    if (!value || typeof value !== 'object') {
      warnings.push(`服务器「${name}」未启用：配置需要 JSON 对象`);
      continue;
    }
    if ((value as Record<string, unknown>).enabled === false) continue;
    const missing = new Set<string>();
    const v = value as Record<string, unknown>;
    const sub = (s: string) => substitute(s, process.env, missing);
    const subMap = (m: unknown): Record<string, string> => {
      const out: Record<string, string> = {};
      if (m && typeof m === 'object') {
        for (const [k, val] of Object.entries(m as Record<string, unknown>)) out[k] = sub(String(val));
      }
      return out;
    };
    if (missing.size) {
      warnings.push(`服务器「${name}」未启用：缺少环境变量 ${[...missing].join('、')}`);
      continue;
    }
    const url = typeof v.url === 'string' && v.url.trim() ? sub(v.url.trim()) : undefined;
    const command = typeof v.command === 'string' && v.command.trim() ? sub(v.command.trim()) : undefined;
    if (!url === !command) {
      warnings.push(`服务器「${name}」未启用：url 与 command 必须二选一`);
      continue;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      warnings.push(`服务器「${name}」未启用：url 必须是 http(s) 地址`);
      continue;
    }
    const timeoutSeconds = typeof v.timeoutSeconds === 'number' && v.timeoutSeconds > 0 ? v.timeoutSeconds : 30;
    servers.push({
      name,
      entry: {
        title: typeof v.title === 'string' && v.title.trim() ? v.title.trim() : name,
        url,
        headers: subMap(v.headers),
        command,
        args: Array.isArray(v.args) ? (v.args as unknown[]).map((a) => sub(String(a))) : [],
        env: subMap(v.env),
        enabled: true,
        confirm: v.confirm === 'all' || v.confirm === 'none' ? v.confirm : 'writes',
        tools: Array.isArray(v.tools) ? (v.tools as unknown[]).map((t) => String(t)) : undefined,
        timeoutSeconds,
      },
    });
  }
  return { servers, warnings };
}

async function getConnection(name: string, entry: McpServerEntry): Promise<Client> {
  const existing = connections.get(name);
  if (existing) return existing.client;

  const client = new Client({ name: 'manalong-ai', version: '1.0.0' });
  const timeoutMs = (entry.timeoutSeconds ?? 30) * 1000;
  if (entry.url) {
    const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: { headers: entry.headers ?? {} },
    });
    await withTimeout(client.connect(transport), timeoutMs, 'MCP 服务器 ' + name + ' 连接超时');
  } else if (entry.command) {
    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      env: { ...(entry.env ?? {}) } as Record<string, string>,
    });
    await withTimeout(client.connect(transport), timeoutMs, 'MCP 服务器 ' + name + ' 连接超时');
  } else {
    throw new Error(`服务器 ${name} 缺少 url 或 command`);
  }
  connections.set(name, { client, entry });
  return client;
}

/** 配置变更后丢弃某个（或全部）缓存连接，下次用时重连 */
export function invalidateMcp(name?: string): void {
  if (name) {
    const conn = connections.get(name);
    if (conn) {
      void conn.client.close().catch(() => {});
      connections.delete(name);
    }
    return;
  }
  for (const [key, conn] of connections) {
    void conn.client.close().catch(() => {});
    connections.delete(key);
  }
}

export async function listMcpTools(
  name: string,
  entry: McpServerEntry
): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }> {
  try {
    const client = await getConnection(name, entry);
    const result = await client.listTools({}, { timeout: (entry.timeoutSeconds ?? 30) * 1000 });
    const tools: McpToolInfo[] = (result.tools ?? [])
      .filter((t) => !entry.tools || entry.tools.includes(t.name))
      .map((t) => ({ name: t.name, description: t.description ?? '', server: name, inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown> }));
    return { ok: true, tools };
  } catch (e) {
    // 连接失败不留半死的缓存
    connections.delete(name);
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

/** MCP 工具调用的确认策略（移植 xiaoman ConfirmPolicy 的启发式） */
export function mcpCallNeedsConfirm(entry: McpServerEntry, toolName: string): boolean {
  const policy = entry.confirm ?? 'writes';
  if (policy === 'all') return true;
  if (policy === 'none') return false;
  // writes：读语义的工具名直接放行，其余一律要求确认
  const readLike = /^(get|list|search|query|read|fetch|find|describe|lookup|history|count)/i;
  return !readLike.test(toolName);
}

export async function callMcpTool(
  server: string,
  entry: McpServerEntry,
  toolName: string,
  argsJson: string
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const client = await getConnection(server, entry);
    let args: Record<string, unknown> = {};
    try {
      args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, error: '工具参数不是合法 JSON' };
    }
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: (entry.timeoutSeconds ?? 30) * 1000,
    });
    if (result.isError) {
      const errText = Array.isArray(result.content)
        ? result.content
            .map((c: any) => (c?.type === 'text' ? c.text : ''))
            .join('\n')
            .trim()
        : '';
      return { ok: false, error: errText.slice(0, 1000) || 'MCP 工具返回错误' };
    }
    const text = Array.isArray(result.content)
      ? result.content
          .map((c: any) => {
            if (c?.type === 'text') return c.text;
            if (c?.type === 'image') return `[图片输出，忽略]`;
            if (c?.type === 'resource') return `[资源输出：${c.resource?.uri ?? ''}]`;
            return '';
          })
          .filter(Boolean)
          .join('\n')
          .trim()
      : JSON.stringify((result as any).structuredContent ?? result).slice(0, 4000);
    return { ok: true, text: text.slice(0, 8000) || '(工具无文本输出)' };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

/** 进程退出前收尾：stdio 连接挂着子进程，不关会拖住退出 */
export async function shutdownMcp(): Promise<void> {
  for (const [, conn] of connections) {
    await conn.client.close().catch(() => {});
  }
  connections.clear();
}
