/**
 * 积分流水的「来源」归类。
 *
 * point_logs.source 的取值受建表时 CHECK 约束限制（不重建表没法加新值），
 * 而「临时任务」和「周期任务」的审批都写的是 'adhoc' —— 只能靠备注区分：
 * 周期任务审核通过的备注固定以「周期任务：」开头（见 recurring-tasks.ts 的 approve）。
 * 这里统一判断，积分流水 / 总览 / 孩子端首页三处共用，避免标签各标各的。
 */
export type PointSourceKind = 'daily' | 'recurring' | 'adhoc' | 'exchange' | 'adjust' | string;

export function sourceKind(source: string, note?: string | null): PointSourceKind {
  if (source === 'adhoc' && (note ?? '').startsWith('周期任务：')) return 'recurring';
  return source;
}
