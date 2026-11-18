/** 日历组件共享类型与小工具（2026-11-14） */

export interface CalendarParticipant {
  id: number;
  name: string;
  nickname: string | null;
  avatar: string | null;
  role: 'parent' | 'child';
  parent_identity: string | null;
}

export interface CalendarEvent {
  id: number;
  title: string;
  event_date: string;
  /** 结束日期（跨天）；后端保证一定有值（同一天时 = event_date） */
  end_date: string;
  is_all_day: boolean;
  start_time: string | null;
  end_time: string | null;
  note: string;
  visibility: 'public' | 'private';
  created_by: number | null;
  creator_name: string | null;
  creator_nickname: string | null;
  participants: CalendarParticipant[];
  /** 孩子端看别人的私有日程：占位卡（只有日期/时间，没有标题/参与人/备注） */
  redacted?: boolean;
}

/** 日程是否覆盖某一天（跨天时中间每一天都算） */
export function coversDate(e: CalendarEvent, date: string): boolean {
  const end = e.end_date || e.event_date;
  return e.event_date <= date && date <= end;
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function minutesOf(t: string | null): number {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
export function dayDiff(a: string, b: string): number {
  const A = new Date(`${a}T00:00:00`).getTime();
  const B = new Date(`${b}T00:00:00`).getTime();
  return Math.round((B - A) / 86400000);
}

/** 总时长（分钟）；全天按「含首尾的自然日」算，11-16 → 11-17 = 2 天 */
export function durationMinutes(e: CalendarEvent): number {
  const end = e.end_date || e.event_date;
  const days = Math.max(0, dayDiff(e.event_date, end));
  if (e.is_all_day) return (days + 1) * 1440;
  if (!e.start_time || !e.end_time) return 0;
  return Math.max(0, days * 1440 + minutesOf(e.end_time) - minutesOf(e.start_time));
}

export function fmtDuration(min: number): string {
  if (min <= 0) return '';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d ? `${d}天` : '', h ? `${h}小时` : '', m ? `${m}分钟` : ''].join('');
}

/** 月/日 简写：2026-11-16 → 11-16 */
export function shortDate(ds: string): string {
  return `${Number(ds.slice(5, 7))}-${Number(ds.slice(8))}`;
}

/** 中式「几月几日 几时几分」：2026-11-16 + '09:00' → 11月16日 09:00 */
export function dateTimeText(ds: string, t: string | null): string {
  return `${Number(ds.slice(5, 7))}月${Number(ds.slice(8))}日${t ? ` ${t}` : ''}`;
}

/**
 * 日程卡上的时间文案（2026-11-16 起统一带日期）：
 *   单日「11月16日 09:00 – 11月16日 10:30（1小时30分钟）」
 *   跨天「11月16日 09:00 – 11月18日 11:30（2天2小时30分钟）」
 *   全天「11月16日 全天」/ 跨天「11月16日 – 11月18日 全天（3天）」
 */
export function timeRangeText(e: CalendarEvent): string {
  const start = dateTimeText(e.event_date, e.is_all_day ? null : e.start_time);
  const end = dateTimeText(e.end_date || e.event_date, e.is_all_day ? null : e.end_time);
  const cross = (e.end_date || e.event_date) !== e.event_date;
  if (e.is_all_day) {
    return cross ? `${start} – ${end} 全天` : `${start} 全天`;
  }
  const dur = fmtDuration(durationMinutes(e));
  return `${start} – ${end}${dur ? `（${dur}）` : ''}`;
}

export interface SpecialDayOccurrence {
  id: number;
  name: string;
  emoji: string;
  date: string;
  effect_kind: 'earn' | 'spend' | null;
  effect_value: number | null;
}

export interface FamilyMember {
  id: number;
  name: string;
  nickname: string | null;
  avatar: string | null;
  role: 'parent' | 'child';
  parent_identity: string | null;
}

export interface FamilyInfo {
  parents: FamilyMember[];
  children: FamilyMember[];
}

export interface SpecialDayFull {
  id: number;
  name: string;
  emoji: string;
  rule_type: 'once' | 'weekly' | 'monthly' | 'yearly';
  once_date: string | null;
  weekdays: number[];
  month_days: number[];
  yearly_md: string | null;
  range_start: string | null;
  range_end: string | null;
  scope: 'all' | 'custom';
  target_ids: number[];
  target_names?: string[];
  effect_kind: 'earn' | 'spend' | null;
  effect_value: number | null;
  enabled: boolean;
}

/** 日程色板：按事件 id 稳定取色，月视图圆点与日视图色条一致 */
export const EVENT_COLORS = [
  '#6ec8a0', '#ffd166', '#84c5ff', '#ff7a7a',
  '#f0a05a', '#b58cff', '#7fd8cc', '#f7b1c1',
];

export function eventColor(id: number): string {
  return EVENT_COLORS[Math.abs(id) % EVENT_COLORS.length];
}

export function memberLabel(m: FamilyMember | CalendarParticipant): string {
  return m.nickname || m.name;
}

/** 倍率展示：2 → ×2，1.5 → ×1.5 */
export function fmtMult(v: number | null | undefined): string {
  if (v == null) return '';
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
}

export function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

export const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/** 特殊日重复规则摘要（管理列表用） */
export function ruleSummary(s: SpecialDayFull): string {
  let base = '';
  switch (s.rule_type) {
    case 'once': base = `单天 · ${s.once_date ?? ''}`; break;
    case 'weekly': base = `每周${s.weekdays.map((w) => WEEK_LABELS[w - 1]).join('、')}`; break;
    case 'monthly': base = `每月 ${s.month_days.join('、')} 号`; break;
    case 'yearly': {
      const [mm, dd] = (s.yearly_md ?? '').split('-');
      base = `每年 ${Number(mm)}月${Number(dd)}日`;
      break;
    }
  }
  if (s.range_start) {
    base += `（${s.range_start} 起${s.range_end ? `，${s.range_end} 止` : ''}）`;
  }
  return base;
}

/** 特殊日效果徽章文案 */
export function effectText(s: { effect_kind: 'earn' | 'spend' | null; effect_value: number | null }): string {
  if (s.effect_kind === 'earn') return `获得 ×${fmtMult(s.effect_value)}`;
  if (s.effect_kind === 'spend') return `消耗 ×${fmtMult(s.effect_value)}`;
  return '纪念日';
}
