import { getDb } from '../../db/index.js';

/**
 * 上下文装配层。
 *
 * 这一层的存在意义：模型「理解得准不准」，主要取决于它拿到上下文时
 * 还剩下多少猜测空间。这里在每一轮对话开始前，把「能确定的事实」
 * （有几个孩子、分别是谁、余额多少、今天是几号）直接摆到模型面前，
 * 让它不必先查一遍再猜，也就不会把「孩子」理解成别人。
 *
 * 注意：这里只做「事实注入」，不改写家长的原话——
 * 原话原样进上下文，指代解析由模型结合快照完成。
 */

export type FamilyChild = { id: number; name: string; points: number };

/** 家长端可见的孩子（隐藏的孩子不参与默认指代） */
export function listFamilyChildren(): FamilyChild[] {
  return getDb()
    .prepare(
      `SELECT id, name, COALESCE(total_points, 0) AS points
       FROM users WHERE role = 'child' AND hidden = 0 ORDER BY id`
    )
    .all() as FamilyChild[];
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** YYYY-MM-DD（按东八区，避免服务器时区不同导致日期差一天） */
export function todayInShanghai(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 家庭实时快照：注入 system prompt 的「确定事实」块 */
export function buildFamilySnapshot(now: Date): string {
  const children = listFamilyChildren();
  const date = todayInShanghai(now);
  const weekday = WEEKDAYS[now.getDay()];
  const lines: string[] = [`- 今天：${date}（${weekday}）`];

  if (!children.length) {
    lines.push('- 家里还没有孩子账号：涉及孩子的操作要先提醒家长去「孩子管理」里添加。');
  } else if (children.length === 1) {
    const c = children[0];
    lines.push(`- 家里只有 1 个孩子：${c.name}（id=${c.id}，当前余额 ${c.points} 分）。`);
    lines.push('- 家长说「孩子 / 娃 / 他 / 她」时，指的就是这一个孩子，直接用上面的 id，不要反问。');
  } else {
    lines.push(`- 家里有 ${children.length} 个孩子，家长说「孩子」时可能指其中任何一个：`);
    for (const c of children) lines.push(`  - ${c.name}（id=${c.id}，当前余额 ${c.points} 分）`);
  }
  return lines.join('\n');
}
