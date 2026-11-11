/**
 * 成长日记的共享类型与纯函数。
 *
 * 家长端（可编辑）和孩子端（只读）都要渲染同一条时间轴，
 * 编辑器弹窗、时间轴组件、页面筛选三处也都要用同一个 Diary 形状，
 * 所以类型集中在这里，避免各写一份后字段名漂移。
 */

export interface DiaryMedia {
  type: 'image' | 'video';
  url: string;
}

export interface Diary {
  id: number;
  user_id: number;
  child_name: string | null;
  child_avatar: string | null;
  diary_date: string;
  title: string | null;
  content: string | null;
  media: DiaryMedia[];
  creator_name: string | null;
  created_at: number;
  updated_at: number | null;
}

/** 时间轴按月分组后的一组 */
export interface DiaryGroup {
  month: string;        // "2026-09"
  label: string;        // "2026年9月"
  items: Diary[];
}

/** 把已按日期倒序排好的日记按月分组（保持原有顺序，不重排） */
export function groupByMonth(items: Diary[]): DiaryGroup[] {
  const groups: DiaryGroup[] = [];
  for (const d of items) {
    const month = d.diary_date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.items.push(d);
    else groups.push({ month, label: fmtMonthLabel(month), items: [d] });
  }
  return groups;
}

/** "2026-09" → "2026年9月"；同一年的首个分组由调用方决定是否省略年份 */
export function fmtMonthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `${y}年${Number(m)}月`;
}

/** 日记里的星期：时间轴上「9月30日」旁边补一个，方便回忆那天是周几 */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return Number.isNaN(dt.getTime()) ? '' : WEEK[dt.getDay()];
}

/** 相对今天的口语化描述，用在时间轴日期旁的小字上 */
export function relativeDay(dateStr: string, today: string): string {
  if (dateStr === today) return '今天';
  const toNum = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  const diff = toNum(today) - toNum(dateStr);
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff > 0 && diff < 7) return `${diff} 天前`;
  return '';
}

/** 附件数量摘要：给时间轴折叠态用（"3 张照片 · 1 个视频"） */
export function mediaSummary(media: DiaryMedia[]): string {
  const img = media.filter((m) => m.type === 'image').length;
  const video = media.filter((m) => m.type === 'video').length;
  const parts: string[] = [];
  if (img) parts.push(`${img} 张照片`);
  if (video) parts.push(`${video} 个视频`);
  return parts.join(' · ');
}
