import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';

type ClientInfo = {
  ws: WebSocket;
  userId: number;
  role: 'parent' | 'child';
  /**
   * 该连接所属范围（可选扩展点解析出来的）。
   * 默认 null：表示「不做范围区分」，所有推送都能收到。
   */
  scope: number | null;
};

const clients = new Map<number, Set<ClientInfo>>();

export let wss: WebSocketServer | null = null;

/* ============================================================================
 * 推送范围（可选扩展点）
 *
 * 默认不注册：所有广播都发给全部在线端，与没有这个功能时完全一致。
 * 注册之后，广播会按范围对齐 —— 只有「归属范围 == 本次变动范围」的端才收得到。
 * ========================================================================== */

/** 连接建立时，按 userId 解析该端所属范围；返回 null = 不参与范围筛选 */
let scopeOfClient: ((userId: number) => number | null) | null = null;
/** 每次广播时，解析「这次变动属于哪个范围」；返回 null = 放弃本次广播 */
let scopeOfPush: (() => number | null) | null = null;

export function registerPushScope(opts: {
  forClient: (userId: number) => number | null;
  current: () => number | null;
}): void {
  scopeOfClient = opts.forClient;
  scopeOfPush = opts.current;
}

/* ============================================================================
 * 连接鉴权（可选扩展点）
 *
 * 默认不注册：连接只校验「带了 userId 和 role」，与没有这个功能时完全一致 ——
 * 自建版跑在自家 NAS 的局域网里，能连上这台机器的人本来就是家里人。
 *
 * 注册之后，钩子返回 false / 抛错的连接会被立即关闭。这是给「一个实例服务多个
 * 家庭」的部署形态用的：那种场景下只凭查询串里的 userId 就能连上别人的推送通道
 * 是不可接受的 —— 推送内容里带着孩子的名字、积分变动、留言正文。
 *
 * 钩子是异步的（实现侧要用 verifyToken 验签），所以连接的注册发生在 await 之后。
 * 这期间的入站帧会被丢掉：客户端在 onopen 里就发 ping 的话可能丢一个，
 * 下一个 ping（30s）照常 —— 不影响任何业务消息。
 * ========================================================================== */

type WsAuthInfo = {
  userId: number;
  role: 'parent' | 'child' | null;
  /** 取查询串参数（token 等）。不给整个 url，避免实现侧顺手依赖别的参数 */
  getParam: (key: string) => string | null;
};

let wsAuth: ((info: WsAuthInfo) => boolean | Promise<boolean>) | null = null;

export function registerWsAuth(fn: (info: WsAuthInfo) => boolean | Promise<boolean>): void {
  wsAuth = fn;
}

export function initWs(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const userId = Number(url.searchParams.get('userId'));
    const role = url.searchParams.get('role') as 'parent' | 'child' | null;

    if (!userId || !role) {
      ws.close(4001, 'missing auth');
      return;
    }

    if (wsAuth) {
      let ok = false;
      try {
        ok = await wsAuth({ userId, role, getParam: (k) => url.searchParams.get(k) });
      } catch (e) {
        // 鉴权本身出错时按「不通过」处理：这里如果 fail-open，
        // 一个实现侧的小 bug 就会变成推送通道对全网敞开。
        console.error('[ws] 鉴权钩子抛错，已拒绝连接', e);
        ok = false;
      }
      // 校验期间连接可能已经断了，再 close 一次会抛「not opened」之类的噪声
      if (!ok) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(4003, 'unauthorized');
        }
        return;
      }
    }

    let scope: number | null = null;
    try {
      scope = scopeOfClient ? scopeOfClient(userId) : null;
    } catch {
      scope = null;
    }

    const info: ClientInfo = { ws, userId, role, scope };
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId)!.add(info);

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        /* ignore */
      }
    });

    ws.on('close', () => {
      clients.get(userId)?.delete(info);
      if (clients.get(userId)?.size === 0) clients.delete(userId);
    });
  });
}

// 推送给指定用户
export function pushToUser(userId: number, message: unknown): void {
  const set = clients.get(userId);
  if (!set) return;
  const payload = JSON.stringify(message);
  for (const c of set) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(payload);
    }
  }
}

/**
 * 广播。
 *
 * 注册了 scopeOfPush 时按范围筛选；解析不出范围（返回 null 或抛错）就**整条放弃**，
 * 而不是退回「发给所有人」—— 广播漏发只是让用户晚一步看到变化（客户端本来就会重拉），
 * 误发给别的范围则是把别人的动态暴露出去，两害相权必须选漏发。
 */
function broadcast(message: unknown, role: 'parent' | 'child' | null): void {
  let want: number | null = null;
  if (scopeOfPush) {
    try {
      want = scopeOfPush();
    } catch {
      want = null;
    }
    if (want === null) {
      console.warn('[ws] 解析不出本次推送的范围，已放弃广播');
      return;
    }
  }

  const payload = JSON.stringify(message);
  for (const set of clients.values()) {
    for (const c of set) {
      if (role && c.role !== role) continue;
      if (scopeOfPush && c.scope !== want) continue;
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
    }
  }
}

// 推送给所有家长
export function pushToParents(message: unknown): void {
  broadcast(message, 'parent');
}

// 推送给所有小孩（家长改了任务/商品，孩子端要立刻看到最新内容）
export function pushToChildren(message: unknown): void {
  broadcast(message, 'child');
}

// 推送给所有在线端（家长 + 小孩），用于「数据变了，你自己去重拉」的静默同步
export function pushToAll(message: unknown): void {
  broadcast(message, null);
}
