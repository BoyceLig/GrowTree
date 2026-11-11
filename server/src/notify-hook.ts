/**
 * 订阅消息的中性钩子（2026-10-25）。
 *
 * ── 为什么经钩子，而不是让业务路由直接 import ext/notify ─────────────
 *   本文件在共享层（自建版也用），而订阅消息的模板、额度、时间窗全是
 *   商业版（ext）的东西，共享层不许反向依赖 —— 和 contribution.ts 的
 *   provider 是同一个道理：ext 启动时把 setNotifyHook 注进来，
 *   自建版没有注册，emitNotify 就是空操作。
 *
 * ── 调用方的分寸 ─────────────────────────────────────────────────────
 *   · 只在「事情确确实实发生了」之后调用（入库/更新成功），别在校验失败
 *     或事务回滚的分支上调用；
 *   · recipients 由调用方解析（本文件不知道谁是家长）；
 *   · data 的键是微信模板的占位符（thing1 / name2 / time3…），
 *     值一律字符串；场景清单见 ext/notify-seed.ts。
 */

export interface NotifyRecipient {
  userId: number;
  familyId?: number;
}

export type NotifyHook = (
  tkey: string,
  recipients: NotifyRecipient[],
  data: Record<string, string>,
  opts?: NotifyEnqueueOpts
) => void;

/** 入队可选项 */
export interface NotifyEnqueueOpts {
  /**
   * 点击通知跳转的页面（可带 query）。不传 = 用后台配置的模板页。
   * 周报/月报用它在跳转时直接打开「所统计周/月」的海报：
   * `pages/moments/index?tab=week&anchor=1`（anchor 0=本周/本月，1=上周/上月）。
   */
  page?: string;
}

let hook: NotifyHook | null = null;

/** 商业版（ext）在启动时注入；自建版永远不调 */
export function setNotifyHook(fn: NotifyHook | null): void {
  hook = fn;
}

/**
 * 业务事件点调用：通知相关的人。
 *
 * 双保险永不抛错：钩子本身可能因为库没就绪等原因炸，而通知是锦上添花，
 * 绝不能把它变成主业务的故障。ext 侧的 notifyEnqueue 还有自己的一层
 * try/catch（它要记日志），这里是兜底中的兜底。
 */
export function emitNotify(
  tkey: string,
  recipients: NotifyRecipient[],
  data: Record<string, string>,
  opts?: NotifyEnqueueOpts
): void {
  if (!hook || !recipients?.length) return;
  try {
    hook(tkey, recipients, data, opts);
  } catch (e) {
    console.error('[notify-hook] 通知钩子执行失败：', e);
  }
}

/** 通知里用的时间文本：MM-DD HH:mm（服务端本地时区） */
export function notifyTimeText(at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
}
