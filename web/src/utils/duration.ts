/**
 * 任务计时相关的纯展示函数。
 *
 * 原先 `fmtDuration` 在家长端任务页、孩子端任务页各写了一份，第十三轮加「审核中心也要看用时」
 * 会变成第三份 —— 三处各写一遍的格式化函数，迟早出现「孩子看到 01:23、家长看到 1:23」
 * 这种对不上的怪事。所以统一收在这里。
 */

/** 计时信息的公共形状（后端 timerInfo 的返回；只用到这三个字段） */
export interface TimerLike {
  state?: 'idle' | 'running' | 'paused' | 'stopped';
  used_ms?: number;
  paused_ms?: number;
}

/** 毫秒 → mm:ss / h:mm:ss */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

/**
 * 计时信息 → 「01:23（暂停 00:10）」这样的核心文案（不含 ⏱ 与「用时」这类前缀，
 * 由调用方按语境拼）。**没计过时返回空串**：孩子从没点过计时按钮时，
 * 各端都不该出现一个「00:00」的假数据 —— 那看起来像是记了但没用时间。
 */
export function fmtTimerPair(timer: TimerLike | null | undefined): string {
  if (!timer) return '';
  const used = Number(timer.used_ms ?? 0);
  const paused = Number(timer.paused_ms ?? 0);
  if (used < 1000 && paused < 1000) return '';
  const pause = paused >= 1000 ? `（暂停 ${fmtDuration(paused)}）` : '';
  return `${fmtDuration(used)}${pause}`;
}

/** 是否处于「正在计时」状态：调用方据此加粗/变色 */
export function isTimerLive(timer: TimerLike | null | undefined): boolean {
  return timer?.state === 'running';
}
