import { getDb } from '../db/index.js';

/**
 * 特殊日积分效果（2026-11-14）
 *
 * 特殊日是家长给某些日子设的「节日」（如学习日），可带当天的积分效果：
 *   - earn  获得倍率（>1，如 ×2 翻倍）
 *   - spend 消耗倍率（<1，如 ×0.5 减半）
 *
 * 口径约定（用户已确认 D1/D2/D3）：
 *   - 获得倍率作用于所有加分链路：一键加分、临时调整、临时任务、周期任务、背包拿走返还、
 *     道具兑换扣分前的对称路径等正向 delta；
 *   - 消耗倍率只作用于商城/道具兑换的扣分；家长手动「扣分」是规则不是消费，不减半；
 *   - 同一天多条特殊日重叠：获得取最大倍率、消耗取最小倍率，来源并列展示；
 *   - 任务类奖励按「孩子提交申请的那天」取效果（与流水 created_at 口径一致），不是审核那天。
 */

export interface DayEffectSource {
  name: string;
  emoji: string;
  kind: 'earn' | 'spend';
}

export interface DayEffect {
  earnMult: number;
  spendMult: number;
  sources: DayEffectSource[];
}

/** 本地时区 YYYY-MM-DD */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** unix 秒 → 本地 YYYY-MM-DD（效果算在流水归属的那天） */
export function dateOfTs(ts: number): string {
  return todayLocal(new Date(ts * 1000));
}

function parseJsonNums(s: string | null): number[] {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

/** 重复规则是否命中 dateStr（不含 scope 判断） */
export function ruleHits(rule: any, dateStr: string): boolean {
  if (rule.range_start && dateStr < rule.range_start) return false;
  if (rule.range_end && dateStr > rule.range_end) return false;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  switch (rule.rule_type) {
    case 'once':
      return rule.once_date === dateStr;
    case 'weekly': {
      // 存储约定 1=周一…7=周日；JS getDay() 0=周日
      const wd = d.getDay() === 0 ? 7 : d.getDay();
      return parseJsonNums(rule.weekdays).includes(wd);
    }
    case 'monthly': {
      // 小月没有 29/30/31，自然跳过
      return parseJsonNums(rule.month_days).includes(d.getDate());
    }
    case 'yearly':
      return rule.yearly_md === dateStr.slice(5);
    default:
      return false;
  }
}

/**
 * 某孩子某天的积分效果。没有任何命中的特殊日时 earnMult/spendMult 均为 1，
 * 调用方按 ≠1 判断是否套用。纯纪念日（无效果）不影响倍率。
 */
export function dayEffectFor(childId: number, dateStr: string): DayEffect {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM special_days WHERE enabled = 1').all() as any[];
  const effect: DayEffect = { earnMult: 1, spendMult: 1, sources: [] };
  for (const rule of rows) {
    if (!ruleHits(rule, dateStr)) continue;
    if (rule.scope === 'custom') {
      const hit = db
        .prepare('SELECT 1 FROM special_day_targets WHERE special_day_id = ? AND user_id = ?')
        .get(rule.id, childId);
      if (!hit) continue;
    }
    const value = Number(rule.effect_value);
    if (rule.effect_kind === 'earn' && value > 1) {
      if (value > effect.earnMult) effect.earnMult = value;
      effect.sources.push({ name: rule.name, emoji: rule.emoji, kind: 'earn' });
    } else if (rule.effect_kind === 'spend' && value > 0 && value < 1) {
      if (value < effect.spendMult) effect.spendMult = value;
      effect.sources.push({ name: rule.name, emoji: rule.emoji, kind: 'spend' });
    }
  }
  return effect;
}

/** 流水备注后缀：「（学习日 ×2）」；整数倍率输出 ×2，小数输出 ×1.5 */
export function effectSuffix(effect: DayEffect, kind: 'earn' | 'spend'): string {
  const mult = kind === 'earn' ? effect.earnMult : effect.spendMult;
  if (mult === 1) return '';
  const src = effect.sources.find((s) => s.kind === kind);
  const name = src ? src.name : '特殊日';
  const multTxt = Number.isInteger(mult) ? String(mult) : String(Number(mult.toFixed(2)));
  return `（${name} ×${multTxt}）`;
}

/** WS / 响应里带给前端的提示对象；无效果返回 null */
export function effectInfo(
  effect: DayEffect,
  kind: 'earn' | 'spend',
): { name: string; emoji: string; mult: number } | null {
  const mult = kind === 'earn' ? effect.earnMult : effect.spendMult;
  if (mult === 1) return null;
  const src = effect.sources.find((s) => s.kind === kind);
  return { name: src?.name ?? '特殊日', emoji: src?.emoji ?? '🎉', mult: Number(Number(mult.toFixed(2))) };
}
