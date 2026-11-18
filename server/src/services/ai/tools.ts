import { getDb } from '../../db/index.js';
import { pushToParents, pushToUser, pushToAll } from '../../ws.js';
import { appendAuditRow } from '../audit.js';
import type { LlmToolSpec } from './llm.js';
import {
  judge,
  type SentinelVerdict,
  getPending,
  resolvePending,
  auditConfirm,
  type ActorInfo,
  type PendingChoice,
} from './sentinel.js';
import { searchMemory, saveMemoryNote } from './memory.js';
import { listSkills, setSkillEnabled, writeSkillFolder } from './skills.js';
import { getAiMcp } from './settings.js';
import { callMcpTool } from './mcp.js';
import { dayEffectFor, effectSuffix, effectInfo, dateOfTs, todayLocal, ruleHits } from '../dayEffect.js';
import { awardContribution } from '../../routes/contribution.js';
import { recordGrowthRecord } from '../../routes/growth.js';
import { hashPasswordSync, isValidPin } from '../../auth.js';

/**
 * AI 助手的工具集（agent 模式的「手」）—— 按层分工：
 *   - 读工具直接执行；
 *   - 写/不可逆动作一律先过 Sentinel（judge）：策略=允许→直接执行并审计；
 *     策略=询问→生成确认单（家长可选 允许一次/本次任务都允许/拒绝）；
 *     策略=拒绝→模型只能转告家长；
 *   - 每一次实际执行都写 operation_logs：module=AI，action=「被执行模块 · 动作」。
 */

export type ToolCtx = { userId: number; taskId: string; actor: ActorInfo; /** 流程技能内部步骤：整体已过 Sentinel，单步不再重复询问 */ bypassJudge?: boolean };

export type ToolOutcome =
  | { kind: 'result'; text: string }
  | { kind: 'confirm'; token: string; summary: string; detail: string };

/* ── 模块名与审计 ──────────────────────────────────────────────────────── */

function moduleNameOf(tool: string): string {
  switch (tool) {
case 'add_point_records':
    case 'manage_point_item':
    case 'list_point_items': return '积分';
    case 'create_tasks':
    case 'list_tasks':
    case 'manage_adhoc_task':
    case 'review_task_completion':
    case 'list_pending_reviews': return '任务';
    case 'list_shop':
    case 'manage_product':
    case 'handle_exchange': return '商城';
    case 'get_backpack': return '背包';
    case 'ask_user': return '问答';
    case 'update_plan': return '计划';
    case 'get_point_summary':
    case 'list_children': return '查询';
    case 'memory_save':
    case 'memory_search': return '记忆';
    case 'web_search':
    case 'web_fetch': return '联网';
    case 'create_skill':
    case 'run_skill': return '技能';
    case 'list_calendar':
    case 'create_calendar_event':
    case 'manage_calendar_event':
    case 'list_special_days':
    case 'manage_special_day': return '日历';
    case 'list_accounts':
    case 'create_child':
    case 'create_parent': return '账号';
    case 'list_growth_records':
    case 'add_growth_record':
    case 'add_growth_records': return '成长';
    case 'list_diaries': return '日记';
    case 'list_operation_logs': return '历史';
    case 'manage_product_category':
    case 'set_cash_rate': return '商城';
    default: return 'AI';
  }
}

function auditExec(actor: ActorInfo, moduleName: string, action: string, detail: string): void {
  try {
    appendAuditRow({
      actor_id: actor.userId,
      actor_role: actor.role,
      actor_name: actor.name,
      module: 'AI',
      action: `${moduleName} · ${action}`,
      detail,
      method: 'AI',
      path: '/ai/agent',
    });
  } catch {
    /* 审计失败不影响执行 */
  }
}

/* ── 工具清单（给模型的 JSON Schema） ─────────────────────────────────── */

const childRef = {
  type: 'object',
  properties: {
    childId: { type: 'integer', description: '孩子 id（list_children 返回的 id）' },
    childName: { type: 'string', description: '孩子名字（当没拿到 id 时作为兜底）' },
  },
};

export const builtinToolSpecs: LlmToolSpec[] = [
  {
    name: 'list_children',
    description: '列出家里所有孩子的 id、名字、当前积分余额。任何涉及孩子的操作前先调用它拿 id。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_point_summary',
    description: '查询孩子的积分流水与汇总。可指定孩子与天数（默认最近 7 天）。',
    parameters: {
      type: 'object',
      properties: {
        childId: { type: 'integer', description: '可选，孩子 id' },
        days: { type: 'integer', description: '可选，最近几天（默认 7，最大 90）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_backpack',
    description: '查询孩子背包里的道具（名字、状态、来源、获得时间）。可指定孩子。',
    parameters: {
      type: 'object',
      properties: { ...childRef.properties },
      additionalProperties: false,
    },
  },
  {
    name: 'add_point_records',
    description:
      '批量给孩子加减积分（识别图片/文字导入数据的落库动作）。属写操作，需家长确认后才会执行。' +
      '每条记录：delta 正负整数（加分正、扣分负），note 一句话原因，date 可选 YYYY-MM-DD（补记过去的日期）。',
    parameters: {
      type: 'object',
      properties: {
        records: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              childId: { type: 'integer' },
              childName: { type: 'string' },
              delta: { type: 'integer' },
              note: { type: 'string' },
              date: { type: 'string', description: 'YYYY-MM-DD，可选' },
            },
            required: ['delta', 'note'],
          },
        },
        reason: { type: 'string', description: '这批记录的来源说明，如「数学练习册照片」' },
      },
      required: ['records'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_tasks',
    description: '批量创建一次性任务（指定孩子、任务名、奖励积分、可选截止日期 YYYY-MM-DD）。属写操作，需家长确认后才会执行。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              childId: { type: 'integer' },
              childName: { type: 'string' },
              name: { type: 'string' },
              points: { type: 'integer' },
              deadline: { type: 'string', description: 'YYYY-MM-DD，可选' },
            },
            required: ['name', 'points'],
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
{
    name: 'list_tasks',
    description: '查任务现状：临时任务、周期任务与待审核的完成申请（按孩子过滤）。改任务/审核前先看一遍。',
    parameters: {
      type: 'object',
      properties: {
        childId: { type: 'number', description: '可选，只看某个孩子' },
        includeDone: { type: 'boolean', description: '可选，连已完成/已过期的临时任务一起列出' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_point_items',
    description: '列出积分项（加分/扣分项、每日上限、启用状态、是否某孩子专属）。',
    parameters: {
      type: 'object',
      properties: { childId: { type: 'number', description: '可选，含通用项与该孩子专属项' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_shop',
    description: '列出商城商品（价格、库存、状态、分类、类型）以及待审核的兑换申请。',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '可选，按商品名筛选' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_pending_reviews',
    description: '汇总所有待家长处理的申请：临时任务完成、周期任务完成、商品/现金兑换。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'manage_adhoc_task',
    description: '修改或删除临时任务（action=update / delete）。改积分、改名、改截止日期都走这里。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete'] },
        taskId: { type: 'number' },
        name: { type: 'string', description: 'update 可选，新名称（最长 60 字）' },
        points: { type: 'number', description: 'update 可选，新积分（1~10000）' },
        deadline: { type: 'string', description: 'update 可选，YYYY-MM-DD；传空字符串表示取消截止' },
        category: { type: 'string', description: 'update 可选，学习/生活/运动/其他' },
        description: { type: 'string', description: 'update 可选，任务说明' },
      },
      required: ['action', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'review_task_completion',
    description: '审核孩子提交的临时任务完成申请（通过加分 / 拒绝写原因）。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        completionId: { type: 'number' },
        decision: { type: 'string', enum: ['approve', 'reject'] },
        reason: { type: 'string', description: '拒绝时必填，说明原因' },
      },
      required: ['completionId', 'decision'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_point_item',
    description: '新增/修改/删除/启停积分项（action=create / update / delete / toggle）。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'toggle'] },
        itemId: { type: 'number', description: 'update/delete/toggle 必填' },
        name: { type: 'string', description: 'create 必填；update 可选，最长 40 字' },
        type: { type: 'string', enum: ['gain', 'loss'], description: '加分项 / 扣分项' },
        points: { type: 'number', description: '正数；扣分项内部按负数存' },
        dailyLimit: { type: 'number', description: '每日上限次数，0 = 不限' },
        ownerId: { type: 'number', description: '可选，专属某个孩子；不传 = 通用' },
        enabled: { type: 'boolean', description: 'toggle/update 可选' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_product',
    description: '新增/修改/删除/上下架商品（action=create / update / delete / toggle）。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'toggle'] },
        productId: { type: 'number', description: 'update/delete/toggle 必填' },
        name: { type: 'string', description: '商品名，最长 40 字' },
        cost: { type: 'number', description: '所需积分（正整数）' },
        stock: { type: 'number', description: '库存，-1 = 不限' },
        categoryId: { type: 'number', description: '可选，商品分类 id' },
        kind: { type: 'string', enum: ['goods', 'prop'], description: 'goods=实物/礼物，prop=道具' },
        status: { type: 'string', enum: ['active', 'inactive'], description: '上架 / 下架' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'handle_exchange',
    description: '审核兑换申请（通过扣积分与库存 / 拒绝写原因）。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        requestId: { type: 'number' },
        decision: { type: 'string', enum: ['approve', 'reject'] },
        reason: { type: 'string', description: '拒绝时必填' },
      },
      required: ['requestId', 'decision'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_calendar',
    description:
      '查看一段日期内的日程与特殊日（默认今天起 7 天）。返回日程 id、标题、日期、时间、参与人、备注，以及命中的特殊日与积分倍率。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '开始日期 YYYY-MM-DD，默认今天' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD，默认开始日期后 6 天' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_calendar_event',
    description:
      '创建日程。参与人用 participantIds（list_accounts 里的 id）或 participantNames（姓名）至少给一个；都不给时默认创建者自己参加。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '日程标题，最长 50 字' },
        event_date: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        end_date: { type: 'string', description: '可选，结束日期 YYYY-MM-DD；跨天日程才需要' },
        is_all_day: { type: 'boolean', description: '是否全天，默认 true' },
        start_time: { type: 'string', description: '非全天时必填，HH:MM' },
        end_time: { type: 'string', description: '非全天时必填，HH:MM' },
        note: { type: 'string', description: '可选，备注（最长 200 字）' },
        participantIds: { type: 'array', items: { type: 'integer' }, description: '参与人用户 id' },
        participantNames: { type: 'array', items: { type: 'string' }, description: '参与人姓名（拿不到 id 时兜底）' },
        visibility: { type: 'string', enum: ['public', 'private'], description: '公开 / 私有，默认公开' },
      },
      required: ['title', 'event_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_calendar_event',
    description: '修改或删除日程（action=update / delete）。update 只传要改的字段。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete'] },
        eventId: { type: 'integer', description: '日程 id（list_calendar 返回）' },
        title: { type: 'string' },
        event_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD；传空字符串表示恢复为同一天' },
        is_all_day: { type: 'boolean' },
        start_time: { type: 'string', description: 'HH:MM' },
        end_time: { type: 'string', description: 'HH:MM' },
        note: { type: 'string' },
        participantIds: { type: 'array', items: { type: 'integer' } },
        participantNames: { type: 'array', items: { type: 'string' } },
        visibility: { type: 'string', enum: ['public', 'private'] },
      },
      required: ['action', 'eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_special_days',
    description: '列出所有特殊日：重复规则、生效范围、积分倍率、指定孩子与启用状态。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'manage_special_day',
    description:
      '新增/修改/删除/启停特殊日（action=create / update / delete / toggle）。特殊日按 once/weekly/monthly/yearly 重复，' +
      '当天可获得积分倍率（effectKind=earn，1~3）或消耗折扣（effectKind=spend，0~1）；不设效果就是纯纪念日。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'toggle'] },
        specialDayId: { type: 'integer', description: 'update/delete/toggle 必填' },
        name: { type: 'string', description: '名称，最长 30 字' },
        emoji: { type: 'string', description: '可选，默认 🎉' },
        ruleType: { type: 'string', enum: ['once', 'weekly', 'monthly', 'yearly'] },
        onceDate: { type: 'string', description: 'ruleType=once 时必填，YYYY-MM-DD' },
        weekdays: { type: 'array', items: { type: 'integer' }, description: 'ruleType=weekly：1=周一…7=周日' },
        monthDays: { type: 'array', items: { type: 'integer' }, description: 'ruleType=monthly：1~31 号' },
        yearlyMd: { type: 'string', description: 'ruleType=yearly：MM-DD' },
        rangeStart: { type: 'string', description: '可选，生效起始日 YYYY-MM-DD' },
        rangeEnd: { type: 'string', description: '可选，生效结束日 YYYY-MM-DD' },
        scope: { type: 'string', enum: ['all', 'custom'], description: 'all=全家，custom=指定孩子' },
        targetIds: { type: 'array', items: { type: 'integer' }, description: 'scope=custom 时的孩子 id' },
        effectKind: { type: 'string', enum: ['earn', 'spend'], description: '不传 = 无积分效果' },
        effectValue: { type: 'number', description: 'earn 为 1~3 的倍率；spend 为 0~1 的折扣' },
        enabled: { type: 'boolean', description: '默认 true' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_accounts',
    description:
      '列出全家账号：家长（账号名、身份、是否主账号）与孩子（生日、性别、积分、日记可见、是否隐藏）。创建账号、安排日程前先看。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_child',
    description: '新建孩子账号：昵称、4~6 位数字 PIN、生肖头像、生日、性别。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '孩子昵称，1~20 字' },
        pin: { type: 'string', description: '登录 PIN，4~6 位数字' },
        avatar: {
          type: 'string',
          enum: ['rat', 'ox', 'tiger', 'rabbit', 'dragon', 'snake', 'horse', 'goat', 'monkey', 'rooster', 'dog', 'pig'],
          description: '生肖头像',
        },
        birthday: { type: 'string', description: '生日 YYYY-MM-DD' },
        sex: { type: 'string', enum: ['male', 'female'] },
      },
      required: ['name', 'pin', 'avatar', 'birthday', 'sex'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_parent',
    description: '新建子家长账号（仅主家长可用）：账号名、密码、身份称谓（如妈妈/爸爸/奶奶）。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '登录账号名，1~30 字' },
        password: { type: 'string', description: '登录密码，6~64 位' },
        identity: { type: 'string', description: '身份称谓，如妈妈 / 爸爸 / 奶奶，1~20 字' },
      },
      required: ['name', 'password', 'identity'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_growth_records',
    description:
      '查看身高体重记录。指定 childId 时列出该孩子的全部记录；不指定时汇总每个孩子最新一条与记录条数。',
    parameters: {
      type: 'object',
      properties: {
        childId: { type: 'integer', description: '可选，孩子 id' },
        childName: { type: 'string', description: '可选，孩子姓名（拿不到 id 时兜底）' },
        limit: { type: 'integer', description: '可选，最多返回多少条，默认 20' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_growth_record',
    description:
      '录入/更新孩子某天的身高体重（同一天重复录入按更新处理，并按成长规则自动加积分）。身高 cm、体重 kg 至少填一项。单条修改用这个；多条历史数据请改用 add_growth_records 一次提交。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        childId: { type: 'integer', description: '孩子 id' },
        childName: { type: 'string', description: '孩子姓名（拿不到 id 时兜底）' },
        date: { type: 'string', description: '测量日期 YYYY-MM-DD，默认今天' },
        heightCm: { type: 'number', description: '身高厘米（30~250），可不填' },
        weightKg: { type: 'number', description: '体重公斤（2~200），可不填' },
        note: { type: 'string', description: '可选，备注（最长 100 字）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_growth_records',
    description:
      '批量录入/更新孩子身高体重，适合一次导入多条历史数据。按日期从早到晚依次写入，同一天重复录入按更新处理，并按成长规则自动结算积分；返回每条明细与合计积分。回复家长时直接引用返回的合计积分，不要自己累加。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        childId: { type: 'integer', description: '孩子 id' },
        childName: { type: 'string', description: '孩子姓名（拿不到 id 时兜底）' },
        records: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: '测量日期 YYYY-MM-DD' },
              heightCm: { type: 'number', description: '身高厘米（30~250），没量身高就不传或传 null' },
              weightKg: { type: 'number', description: '体重公斤（2~200），没量体重就不传或传 null' },
              note: { type: 'string', description: '可选，备注（最长 100 字）' },
            },
            required: ['date'],
          },
        },
      },
      required: ['records'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_diaries',
    description:
      '统计并查看成长日记：返回总篇数与最近日记摘要，可按孩子、日期范围、关键字筛选。孩子自己写的私密日记不计入。',
    parameters: {
      type: 'object',
      properties: {
        childId: { type: 'integer', description: '可选，按孩子筛选' },
        from: { type: 'string', description: '可选，起始日期 YYYY-MM-DD' },
        to: { type: 'string', description: '可选，结束日期 YYYY-MM-DD' },
        keyword: { type: 'string', description: '可选，匹配标题或正文' },
        limit: { type: 'integer', description: '可选，最多列多少篇，默认 10' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_operation_logs',
    description:
      '读取操作历史（默认最近 7 天）。可按模块（积分/任务/审核/商城/背包/心愿/成长/日记/日历/信箱/悄悄话/账号/AI/其他）、' +
      '操作人角色或账号 id 筛选。用于回答「最近谁做了什么」。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '开始日期 YYYY-MM-DD，默认 7 天前' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD，默认今天' },
        module: { type: 'string', description: '可选，模块名' },
        role: { type: 'string', enum: ['parent', 'child'], description: '可选，按操作人角色' },
        actorId: { type: 'integer', description: '可选，按操作人用户 id' },
        limit: { type: 'integer', description: '可选，最多返回条数，默认 30' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'manage_product_category',
    description: '新增/修改/删除商品分类（action=create / update / delete）。删除分类不会删商品，商品会变成未分类。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'] },
        categoryId: { type: 'integer', description: 'update/delete 必填' },
        name: { type: 'string', description: '分类名，最长 12 字' },
        icon: { type: 'string', description: '图标 key：snack/toy/activity/game/study/privilege/food/gift' },
        color: { type: 'string', description: '#RRGGBB，可选' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_cash_rate',
    description: '设置积分兑换现金的比例（多少积分 = 1 元）。属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: { rate: { type: 'integer', description: '正整数，如 10 表示 10 积分 = 1 元' } },
      required: ['rate'],
      additionalProperties: false,
    },
  },
  {
    name: 'web_search',
    description:
      '联网搜索家庭以外的公开信息（政策、学校、活动、科普、商品对比、路线等）。' +
      '只返回标题/链接/摘要，需要原文细节再调 web_fetch。' +
      '回答时必须注明来源站点与链接，并交叉验证；搜不到就如实说没搜到。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，尽量具体（带上地区、年份等限定词）' },
        limit: { type: 'integer', description: '可选，返回条数，默认 5，最多 8' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'web_fetch',
    description:
      '打开一个网页并抽取正文（最多 8000 字），用于核对搜索结果的原文细节。' +
      '只支持 http/https 公网地址。引用时给出该页链接。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整网址' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_save',
description:
      '把「工具查不到、长期有用」的信息写入长期记忆（Markdown 笔记，自动去重合并）：家长的偏好/忌讳、操作与沟通习惯、常用流程。' +
      '不要写入积分、余额、任务状态、兑换记录等能实时查到的数据。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '笔记标题，如「小满的偏好」' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选，标签便于检索' },
        observations: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              category: { type: 'string', description: '观察分类，如 偏好/事实/注意事项' },
              text: { type: 'string' },
            },
            required: ['category', 'text'],
          },
        },
        relations: { type: 'array', items: { type: 'string' }, description: '可选，关联的其他笔记标题' },
      },
      required: ['title', 'observations'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description: '检索长期记忆（中文全文检索）。回答「上次说过什么」「孩子的习惯」类问题前先查一下。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_skill',
description:
      '把一段可复用的长流程保存成技能（写入技能目录的 SKILL.md），下次对话自动注入。' +
      '家长同意「存成技能」后调用；属写操作，需家长确认。',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: '技能文件夹名（字母数字或中文，会成为目录名）' },
        name: { type: 'string', description: '技能显示名' },
        description: { type: 'string', description: '一句话描述（模型靠它决定何时使用该技能）' },
        instructions: { type: 'string', description: '指令正文（markdown）' },
        enabled: { type: 'boolean', description: '是否启用，默认 true' },
      },
      required: ['folder', 'name', 'description', 'instructions'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_skill',
    description: '执行一个带 flow.yaml 流程的技能（按步骤依次调用工具）。只对配置了流程的技能可用；普通技能的说明已自动注入对话。',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能文件夹名' },
        input: { type: 'string', description: '可选，本次执行的目标/参数说明' },
      },
      required: ['skill'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_user',
    description:
      '向家长弹「问答面板」一次性问清楚（1~4 个问题，每题可带 2~4 个选项，可多选）。' +
      '适用：信息不足需要追问、要在多个方案里让家长选、或动手前想再确认一次。' +
      '家长答完会自动继续；一次把要问的问完。寒暄、已有足够信息、或自己能查到的不要用。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '要问家长的完整问题' },
              header: { type: 'string', description: '可选，4~8 字的短标题' },
              multi: { type: 'boolean', description: '是否允许多选，默认单选' },
              options: {
                type: 'array',
                maxItems: 4,
                description: '可选。给选项能让家长少打字；题面已足够明确时可以不给',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '选项文字（简短）' },
                    description: { type: 'string', description: '可选，补充说明' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_plan',
    description:
      '多步骤任务开始时，用 3~8 条步骤列出计划；开始某一步或完成某一步时再次调用（传完整清单，状态 pending / in_progress / done）。' +
      '界面会按这个清单显示整体进度；单步操作、闲聊不要调用。',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '这一步做什么（短句）' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['title', 'status'],
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
];

/* ── 内部查询 ──────────────────────────────────────────────────────────── */

function findChild(id?: number, name?: string): { id: number; name: string } | undefined {
  const db = getDb();
  if (id != null) {
    return db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'child'").get(id) as
      | { id: number; name: string }
      | undefined;
  }
  if (name) {
    return db.prepare("SELECT id, name FROM users WHERE name = ? AND role = 'child'").get(name) as
      | { id: number; name: string }
      | undefined;
  }
  return undefined;
}

function assertChildId(childId?: number, childName?: string): { id: number; name: string } {
  const child = findChild(childId, childName);
  if (!child) {
    throw new Error(`找不到孩子${childName ? `「${childName}」` : childId != null ? ` id=${childId}` : ''}，请先调用 list_children`);
  }
  return child;
}

/* ── 只读工具 ──────────────────────────────────────────────────────────── */

function listChildren(): string {
  const rows = getDb()
    .prepare("SELECT id, name, total_points, avatar FROM users WHERE role = 'child' AND hidden = 0 ORDER BY id")
    .all() as any[];
  if (!rows.length) return '（家里还没有孩子账号）';
  return rows.map((r) => `- id=${r.id} ${r.name}：${r.total_points} 分`).join('\n');
}

function pointSummary(childId: number | undefined, days: number): string {
  const db = getDb();
  const d = Math.min(Math.max(days || 7, 1), 90);
  const since = Math.floor(Date.now() / 1000) - d * 86400;
  if (childId != null) {
    const child = assertChildId(childId);
    const rows = db
      .prepare(
        `SELECT delta, source, note, biz_date, datetime(created_at, 'unixepoch', 'localtime') as t
         FROM point_logs WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 50`
      )
      .all(child.id, since) as any[];
    const total = (db.prepare('SELECT total_points FROM users WHERE id = ?').get(child.id) as any).total_points;
    const body = rows.length
      ? rows.map((r) => `- ${r.t} ${r.delta > 0 ? '+' : ''}${r.delta}分 [${r.source}] ${r.note ?? ''}`).join('\n')
      : '（该时段没有流水）';
    return `孩子 ${child.name} 当前余额 ${total} 分，最近 ${d} 天流水（最多 50 条）：\n${body}`;
  }
  const rows = db
    .prepare(
      `SELECT u.name as name, SUM(pl.delta) as sum_delta, COUNT(*) as cnt
       FROM point_logs pl JOIN users u ON u.id = pl.user_id
       WHERE pl.created_at >= ? GROUP BY pl.user_id ORDER BY pl.user_id`
    )
    .all(since) as any[];
  if (!rows.length) return `最近 ${d} 天全家没有积分变动。`;
  return `最近 ${d} 天积分变动汇总：\n${rows.map((r) => `- ${r.name}：${r.sum_delta > 0 ? '+' : ''}${r.sum_delta} 分（${r.cnt} 笔）`).join('\n')}`;
}

function backpackOf(childId: number | undefined, childName?: string): string {
  const child = assertChildId(childId, childName);
  const rows = getDb()
    .prepare(
      `SELECT name, icon, status, source, cost,
        datetime(acquired_at, 'unixepoch', 'localtime') as got,
        CASE WHEN taken_at IS NOT NULL THEN datetime(taken_at, 'unixepoch', 'localtime') END as taken
       FROM backpack_items WHERE child_id = ? ORDER BY acquired_at DESC LIMIT 60`
    )
    .all(child.id) as any[];
  if (!rows.length) return `孩子 ${child.name} 的背包是空的。`;
  const lines = rows.map((r) => {
    const state = r.taken ? `已被家长拿走（${r.taken}）` : r.status === 'used' ? '已使用' : '未使用';
    return `- ${r.icon || ''}${r.name}（${state}，来源:${r.source === 'gift' ? '家长赠送' : '兑换'}${r.cost ? `，${r.cost}分` : ''}，获得 ${r.got}）`;
  });
  return `孩子 ${child.name} 的背包（共 ${rows.length} 件，最多显示 60）：\n${lines.join('\n')}`;
}

/* ── 任务 / 积分项 / 商城 / 待审 概览（只读） ───────────────────────────── */

function tasksOverview(childId?: number, includeDone?: boolean): string {
  const db = getDb();
  const child = childId != null ? assertChildId(childId) : null;
  const adhoc = db
    .prepare(
      `SELECT t.id, t.name, t.points, t.status, t.deadline, u.name as child
       FROM adhoc_tasks t JOIN users u ON u.id = t.user_id
       WHERE (? IS NULL OR t.user_id = ?) ${includeDone ? '' : "AND t.status = 'active'"}
       ORDER BY t.created_at DESC LIMIT 50`
    )
    .all(child ? child.id : null, child ? child.id : null) as any[];
  const recurring = db
    .prepare(
      `SELECT id, name, points, freq_type, once_only, weekly_once, weekdays, month_day, child_ids, enabled
       FROM recurring_tasks ORDER BY enabled DESC, created_at DESC LIMIT 40`
    )
    .all() as any[];
  const pendingAdhoc = db
    .prepare(
      `SELECT tc.id, tc.created_at, t.name as task, u.name as child
       FROM task_completions tc JOIN adhoc_tasks t ON t.id = tc.task_id JOIN users u ON u.id = tc.user_id
       WHERE tc.status = 'pending' ORDER BY tc.created_at DESC LIMIT 30`
    )
    .all() as any[];
  const pendingRecurring = db
    .prepare(
      `SELECT rc.id, rc.period_key, t.name as task, u.name as child
       FROM recurring_claims rc JOIN recurring_tasks t ON t.id = rc.task_id JOIN users u ON u.id = rc.user_id
       WHERE rc.status = 'pending' ORDER BY rc.submitted_at DESC LIMIT 30`
    )
    .all() as any[];

  const lines: string[] = [];
  lines.push(`## 临时任务${child ? `（${child.name}）` : ''}：${adhoc.length ? '' : '无'}`);
  for (const t of adhoc) {
    const deadline = t.deadline ? new Date(t.deadline * 1000).toLocaleDateString('zh-CN') : '无截止';
    lines.push(`- id=${t.id}「${t.name}」${t.child} ${t.points}分 状态:${t.status} 截止:${deadline}`);
  }
  const freqCn = (r: any) =>
    r.once_only ? '单次' : r.freq_type === 'daily' ? '每天' : r.freq_type === 'weekly' ? `每周${r.weekly_once ? '(多天一次)' : ''}` : `每月${r.month_day ?? ''}号`;
  lines.push('', `## 周期任务（共 ${recurring.length}）`);
  for (const r of recurring.slice(0, 30)) {
    lines.push(`- id=${r.id}「${r.name}」${r.points}分 ${freqCn(r)} ${r.enabled ? '启用' : '停用'}`);
  }
  lines.push('', `## 待审核的任务完成申请（${pendingAdhoc.length + pendingRecurring.length}）`);
  for (const p of pendingAdhoc) lines.push(`- 临时任务 completionId=${p.id}「${p.task}」${p.child}`);
  for (const p of pendingRecurring) lines.push(`- 周期任务 claimId=${p.id}「${p.task}」${p.child} 期次 ${p.period_key}`);
  return lines.join('\n');
}

function pointItemsText(childId?: number): string {
  const db = getDb();
  const child = childId != null ? assertChildId(childId) : null;
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.type, p.points, p.daily_limit, p.enabled, p.owner_id, u.name as owner
       FROM point_items p LEFT JOIN users u ON u.id = p.owner_id
       WHERE (? IS NULL OR p.owner_id IS NULL OR p.owner_id = ?)
       ORDER BY p.type, p.sort_order, p.id`
    )
    .all(child ? child.id : null, child ? child.id : null) as any[];
  if (!rows.length) return '还没有积分项。';
  return `积分项（共 ${rows.length}）：\n${rows
    .map(
      (r) =>
        `- id=${r.id}「${r.name}」${r.type === 'gain' ? '+' : ''}${r.points}分 每日上限:${r.daily_limit || '不限'} ${r.enabled ? '启用' : '停用'}${r.owner ? ` 专属:${r.owner}` : ' 通用'}`
    )
    .join('\n')}`;
}

function shopText(keyword?: string): string {
  const db = getDb();
  const kw = String(keyword ?? '').trim();
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.cost, p.stock, p.status, p.kind, c.name as category
       FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
       WHERE (? = '' OR p.name LIKE ?)
       ORDER BY p.status = 'active' DESC, p.id DESC LIMIT 60`
    )
    .all(kw, `%${kw}%`) as any[];
  const pending = db
    .prepare(
      `SELECT r.id, r.type, r.points, r.amount, r.quantity, u.name as child, p.name as product
       FROM exchange_requests r JOIN users u ON u.id = r.user_id LEFT JOIN products p ON p.id = r.product_id
       WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 30`
    )
    .all() as any[];
  const lines: string[] = [];
  lines.push(`## 商品（共 ${rows.length}）`);
  for (const p of rows) {
    lines.push(
      `- id=${p.id}「${p.name}」${p.cost}分 库存:${p.stock < 0 ? '不限' : p.stock} ${p.status === 'active' ? '上架' : '下架'} ${p.kind === 'prop' ? '道具' : '礼物'}${p.category ? ` 分类:${p.category}` : ''}`
    );
  }
  lines.push('', `## 待审核的兑换（${pending.length}）`);
  for (const r of pending) {
    lines.push(
      `- requestId=${r.id} ${r.child} ${r.type === 'cash' ? `兑换现金 ${r.amount} 元` : `兑换「${r.product ?? '已删除商品'}」×${r.quantity ?? 1}`}，扣 ${r.points} 分`
    );
  }
  const categories = db
    .prepare('SELECT id, name, hidden FROM product_categories ORDER BY sort_order ASC, id ASC')
    .all() as any[];
  lines.push('', `## 商品分类（共 ${categories.length}）`);
  for (const c of categories) {
    lines.push(`- id=${c.id}「${c.name}」${c.hidden ? '（许愿单系统分类）' : ''}`);
  }
  const cash = db.prepare("SELECT value FROM settings WHERE key = 'cash_rate'").get() as { value: string } | undefined;
  lines.push('', `## 现金兑换比例：${cash?.value ?? 10} 积分 = 1 元`);
  return lines.join('\n');
}

function pendingReviewsText(): string {
  return tasksOverview() + '\n\n' + shopText();
}

/* ── 日程 / 特殊日 / 账号 / 成长 / 日记 / 历史（只读） ─────────────────── */

const AI_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateArg(v: unknown): v is string {
  return typeof v === 'string' && AI_DATE_RE.test(v);
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayLocal(d);
}

function parseJsonNumList(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number).filter((n) => Number.isInteger(n));
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(Number).filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

function resolveParticipants(ids: unknown, names: unknown, fallbackId: number): { ids: number[]; labels: string[] } {
  const db = getDb();
  const found = new Map<number, string>();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = Number(raw);
    const u = db.prepare('SELECT id, name FROM users WHERE id = ?').get(id) as any;
    if (!u) throw new Error(`找不到参与人 id=${id}`);
    found.set(u.id, u.name);
  }
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    const u = db.prepare('SELECT id, name FROM users WHERE name = ? OR nickname = ?').get(name, name) as any;
    if (!u) throw new Error(`找不到参与人「${name}」`);
    found.set(u.id, u.name);
  }
  if (!found.size) {
    const me = db.prepare('SELECT id, name FROM users WHERE id = ?').get(fallbackId) as any;
    if (me) found.set(me.id, me.name);
  }
  return { ids: [...found.keys()], labels: [...found.values()] };
}

function calendarText(from?: unknown, to?: unknown): string {
  const start = isDateArg(from) ? from : todayLocal();
  const end = isDateArg(to) ? to : shiftDate(start, 6);
  if (start > end) throw new Error('开始日期不能晚于结束日期');
  const spanDays = Math.round((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000);
  if (spanDays > 62) throw new Error('日程查询范围最多 62 天，请分段查询');
  const db = getDb();
  const events = db.prepare(`
    SELECT e.* FROM calendar_events e
    WHERE e.event_date <= ? AND COALESCE(e.end_date, e.event_date) >= ?
    ORDER BY e.event_date ASC, e.is_all_day DESC, e.start_time ASC, e.id ASC
  `).all(end, start) as any[];

  const lines = [`日程（${start} ~ ${end}）：`];
  if (!events.length) lines.push('（这段时间没有日程）');
  for (const e of events) {
    const parts = db.prepare(`
      SELECT u.name FROM calendar_event_participants p JOIN users u ON u.id = p.user_id
      WHERE p.event_id = ? ORDER BY u.role DESC, u.id
    `).all(e.id) as any[];
    const span = e.end_date && e.end_date !== e.event_date ? `${e.event_date} ~ ${e.end_date}` : e.event_date;
    const time = e.is_all_day ? '全天' : `${e.start_time ?? ''}-${e.end_time ?? ''}`;
    lines.push(
      `- id=${e.id} ${span} ${time}「${e.title}」参与人：${parts.map((p) => p.name).join('、') || '无'}` +
        `${e.note ? ` 备注：${e.note}` : ''}${e.visibility === 'private' ? '（私有）' : ''}`
    );
  }

  const rules = db.prepare('SELECT * FROM special_days WHERE enabled = 1').all() as any[];
  const hits: string[] = [];
  const cursor = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  while (cursor <= endDate) {
    const ds = todayLocal(cursor);
    for (const rule of rules) {
      if (!ruleHits(rule, ds)) continue;
      const effect =
        rule.effect_kind === 'earn'
          ? `获得积分 ×${rule.effect_value}`
          : rule.effect_kind === 'spend'
            ? `消耗积分 ×${rule.effect_value}`
            : '纯纪念日';
      hits.push(`- ${ds}「${rule.emoji ?? ''}${rule.name}」${effect}${rule.scope === 'custom' ? '（指定孩子）' : ''}`);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  lines.push('', `特殊日（${start} ~ ${end}）：`);
  lines.push(...(hits.length ? hits : ['（这段时间没有特殊日）']));
  return lines.join('\n');
}

function specialDaysText(): string {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM special_days ORDER BY enabled DESC, id ASC').all() as any[];
  if (!rows.length) return '还没有特殊日。';
  const targets = db.prepare(`
    SELECT t.special_day_id, u.name FROM special_day_targets t JOIN users u ON u.id = t.user_id
  `).all() as any[];
  return `特殊日（共 ${rows.length}）：\n${rows
    .map((r) => {
      const rule =
        r.rule_type === 'once'
          ? `单次 ${r.once_date ?? ''}`
          : r.rule_type === 'weekly'
            ? `每周 ${parseJsonNumList(r.weekdays).join('、')}`
            : r.rule_type === 'monthly'
              ? `每月 ${parseJsonNumList(r.month_days).join('、')} 号`
              : `每年 ${r.yearly_md ?? ''}`;
      const effect =
        r.effect_kind === 'earn'
          ? `获得 ×${r.effect_value}`
          : r.effect_kind === 'spend'
            ? `消耗 ×${r.effect_value}`
            : '无积分效果';
      const names = targets.filter((t) => t.special_day_id === r.id).map((t) => t.name).join('、');
      const scope = r.scope === 'custom' ? `指定：${names || '（未设置）'}` : '全家';
      const range = r.range_start || r.range_end ? `生效：${r.range_start ?? '…'}~${r.range_end ?? '…'}` : '';
      return `- id=${r.id}「${r.emoji ?? ''}${r.name}」${rule} ${effect} ${scope}${range ? ' ' + range : ''} ${r.enabled ? '启用' : '停用'}`;
    })
    .join('\n')}`;
}

function accountsText(): string {
  const db = getDb();
  const parents = db.prepare(
    "SELECT id, name, nickname, parent_identity, is_primary FROM users WHERE role = 'parent' ORDER BY is_primary DESC, id"
  ).all() as any[];
  const children = db.prepare(
    "SELECT id, name, total_points, birthday, sex, diary_visible, hidden FROM users WHERE role = 'child' ORDER BY id"
  ).all() as any[];
  const lines = ['家长账号：'];
  if (!parents.length) lines.push('- （无）');
  for (const p of parents) {
    const nick = p.nickname && p.nickname !== p.name ? ` 昵称：${p.nickname}` : '';
    lines.push(`- id=${p.id} ${p.name}${p.parent_identity ? `（${p.parent_identity}）` : ''}${p.is_primary ? ' 主账号' : ''}${nick}`);
  }
  lines.push('', `孩子账号（${children.length}）：`);
  if (!children.length) lines.push('- （无）');
  for (const c of children) {
    lines.push(
      `- id=${c.id} ${c.name}：${c.total_points ?? 0} 分 生日 ${c.birthday ?? '未填'} ${c.sex === 'male' ? '男' : c.sex === 'female' ? '女' : '性别未填'}` +
        ` 日记${c.diary_visible === 0 ? '不可见' : '可见'}${c.hidden ? ' 已隐藏' : ''}`
    );
  }
  return lines.join('\n');
}

function growthText(childId?: unknown, childName?: unknown, limit?: unknown): string {
  const db = getDb();
  const max = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const fmt = (r: any) =>
    `- ${r.record_date} 身高 ${r.height_cm ?? '—'}cm 体重 ${r.weight_kg ?? '—'}kg` +
    `${r.grow_cm != null ? `（较上次 ${r.grow_cm > 0 ? '+' : ''}${r.grow_cm}cm）` : ''}` +
    `${r.awarded ? ` 积分 ${r.awarded > 0 ? '+' : ''}${r.awarded}` : ''}${r.note ? ` 备注：${r.note}` : ''}`;

  if (childId != null || childName != null) {
    const child = assertChildId(
      childId != null ? Number(childId) : undefined,
      childName != null ? String(childName) : undefined
    );
    const rows = db
      .prepare('SELECT * FROM growth_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT ?')
      .all(child.id, max) as any[];
    if (!rows.length) return `孩子 ${child.name} 还没有身高体重记录。`;
    return `孩子 ${child.name} 的成长记录（最近 ${rows.length} 条）：\n${rows.map(fmt).join('\n')}`;
  }

  const children = db
    .prepare("SELECT id, name FROM users WHERE role = 'child' AND hidden = 0 ORDER BY id")
    .all() as any[];
  if (!children.length) return '（家里还没有孩子账号）';
  return children
    .map((c) => {
      const last = db
        .prepare('SELECT * FROM growth_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT 1')
        .get(c.id) as any;
      const count = (db.prepare('SELECT COUNT(*) AS n FROM growth_records WHERE user_id = ?').get(c.id) as any).n;
      return last ? `- ${c.name}：共 ${count} 条，最近 ${fmt(last).slice(2)}` : `- ${c.name}：还没有记录`;
    })
    .join('\n');
}

function diariesText(childId?: unknown, from?: unknown, to?: unknown, keyword?: unknown, limit?: unknown): string {
  const db = getDb();
  // 家长视角：孩子自己写的私密日记不展示（与 /growth/diaries 的口径一致）
  const where: string[] = ['d.created_by <> d.user_id'];
  const params: any[] = [];
  if (childId != null) {
    const child = assertChildId(Number(childId));
    where.push('d.user_id = ?');
    params.push(child.id);
  }
  if (isDateArg(from)) {
    where.push('d.diary_date >= ?');
    params.push(from);
  }
  if (isDateArg(to)) {
    where.push('d.diary_date <= ?');
    params.push(to);
  }
  const kw = String(keyword ?? '').trim();
  if (kw) {
    const like = `%${kw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(d.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM growth_diaries d ${whereSql}`).get(...params) as any).n;
  const max = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const rows = db
    .prepare(
      `SELECT d.*, u.name AS child_name FROM growth_diaries d JOIN users u ON u.id = d.user_id
       ${whereSql} ORDER BY d.diary_date DESC, d.id DESC LIMIT ?`
    )
    .all(...params, max) as any[];

  const lines = [`共 ${total} 篇成长日记${kw ? `（含关键字「${kw}」）` : ''}。`];
  if (!rows.length) lines.push('（没有符合条件的日记）');
  for (const d of rows) {
    const text = String(d.content ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const media = (() => {
      try {
        const arr = JSON.parse(d.media ?? '[]');
        return Array.isArray(arr) ? arr.length : 0;
      } catch {
        return 0;
      }
    })();
    lines.push(
      `- ${d.diary_date} ${d.child_name}${d.title ? `《${d.title}》` : ''}：${text.slice(0, 80) || '（无正文）'}${media ? `（${media} 个附件）` : ''}`
    );
  }
  return lines.join('\n');
}

function operationLogsText(
  from?: unknown,
  to?: unknown,
  module?: unknown,
  role?: unknown,
  actorId?: unknown,
  limit?: unknown
): string {
  const db = getDb();
  const end = isDateArg(to) ? to : todayLocal();
  const start = isDateArg(from) ? from : shiftDate(end, -6);
  if (start > end) throw new Error('开始日期不能晚于结束日期');
  const dayExpr = "date(o.created_at, 'unixepoch', 'localtime')";
  const moduleExpr = "CASE WHEN o.module IN ('账号','孩子','登录','系统') THEN '账号' ELSE o.module END";
  const conds = [`${dayExpr} >= ?`, `${dayExpr} <= ?`];
  const args: any[] = [start, end];
  const mod = String(module ?? '').trim();
  if (mod) {
    conds.push(`${moduleExpr} = ?`);
    args.push(mod);
  }
  const actor = Number(actorId ?? 0) || 0;
  if (actor > 0) {
    conds.push('o.actor_id = ?');
    args.push(actor);
  } else if (role === 'parent' || role === 'child') {
    conds.push('o.actor_role = ?');
    args.push(role);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM operation_logs o ${where}`).get(...args) as any).n;
  const max = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const rows = db
    .prepare(
      `SELECT ${moduleExpr} AS module, o.actor_name, o.actor_role, o.action, o.detail,
              datetime(o.created_at, 'unixepoch', 'localtime') AS t
       FROM operation_logs o ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`
    )
    .all(...args, max) as any[];

  const lines = [`操作历史 ${start} ~ ${end}：共 ${total} 条${rows.length < total ? `，最近 ${rows.length} 条如下` : ''}`];
  if (!rows.length) lines.push('（这段时间没有操作记录）');
  for (const r of rows) {
    const who = `${r.actor_name ?? '未知'}${r.actor_role === 'child' ? '（孩子）' : ''}`;
    lines.push(`- ${r.t} ${who} [${r.module}] ${r.action}${r.detail ? `：${String(r.detail).slice(0, 80)}` : ''}`);
  }
  return lines.join('\n');
}

/* ── 写类动作的实际执行（Sentinel 放行/确认后调用） ────────────────────── */

export type ExecResult = { ok: true; detail: string } | { ok: false; error: string };

function execAddPointRecords(payload: any, confirmedBy: number): ExecResult {
  const records = payload.records as { childId: number; delta: number; note: string; date: string | null }[];
  const db = getDb();
  try {
    const txn = db.transaction(() => {
      for (const r of records) {
        db.prepare('UPDATE users SET total_points = total_points + ? WHERE id = ?').run(r.delta, r.childId);
        db.prepare(
          `INSERT INTO point_logs (user_id, delta, source, note, created_by, biz_date)
           VALUES (?, ?, 'adjust', ?, ?, ?)`
        ).run(r.childId, r.delta, `AI：${r.note}`, confirmedBy, r.date);
      }
    });
    txn();
    for (const childId of new Set(records.map((r) => r.childId))) {
      const balance = (db.prepare('SELECT total_points FROM users WHERE id = ?').get(childId) as any)?.total_points ?? 0;
      const delta = records.filter((r) => r.childId === childId).reduce((s, r) => s + r.delta, 0);
      pushToUser(childId, { type: 'points_changed', userId: childId, delta, newBalance: balance, note: 'AI 导入积分', dayEffect: null });
    }
    pushToParents({ type: 'ai_points_imported', count: records.length });
    return { ok: true, detail: `已导入 ${records.length} 条积分记录` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execCreateTasks(payload: any, confirmedBy: number): ExecResult {
  const tasks = payload.tasks as { childId: number; name: string; points: number; deadline: number | null }[];
  const now = Math.floor(Date.now() / 1000);
  const insert = getDb().prepare(
    `INSERT INTO adhoc_tasks (name, description, category, points, deadline, user_id, created_by, created_at)
     VALUES (?, 'AI 创建', '其他', ?, ?, ?, ?, ?)`
  );
  try {
    const txn = getDb().transaction(() => {
      for (const t of tasks) insert.run(t.name, t.points, t.deadline, t.childId, confirmedBy, now);
    });
    txn();
    pushToParents({ type: 'ai_tasks_created', count: tasks.length });
    return { ok: true, detail: `已创建 ${tasks.length} 个任务` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execSkillCreate(payload: any): ExecResult {
  try {
    const r = writeSkillFolder(
      {
        folder: String(payload.folder ?? ''),
        name: String(payload.name ?? ''),
        description: String(payload.description ?? ''),
        instructions: String(payload.instructions ?? ''),
        enabled: payload.enabled !== false,
      }
    );
    return { ok: true, detail: `技能「${r.name}」已${r.merged ? '更新' : '创建'}（目录：${r.folder}）` };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

function execSkillFlow(payload: any, actor: ActorInfo): ExecResult {
  const steps = payload.steps as { tool: string; argsJson: string }[];
  const results: string[] = [];
  for (let i = payload.startIndex ?? 0; i < steps.length; i++) {
    const step = steps[i];
    const outcome = executeBuiltinTool(step.tool, step.argsJson, {
      userId: actor.userId,
      taskId: String(payload.taskId ?? 'flow'),
      actor,
      bypassJudge: true,
    });
    if (outcome.kind !== 'result') continue;
    if (/失败|错误|不能|找不到|为空/.test(outcome.text)) {
      return { ok: false, error: `流程第 ${i + 1} 步（${step.tool}）失败：${outcome.text.slice(0, 200)}` };
    } else {
      results.push(`${i + 1}. ${step.tool} ✓`);
    }
  }
  return { ok: true, detail: `流程「${payload.flowName}」执行完成（${steps.length} 步）：\n${results.join('\n')}` };
}



function execManageAdhocTask(payload: any): ExecResult {
  const db = getDb();
  const id = Number(payload.taskId);
  const task = db.prepare("SELECT * FROM adhoc_tasks WHERE id = ?").get(id) as any;
  if (!task) return { ok: false, error: '任务不存在' };
  try {
    if (payload.action === 'delete') {
      const pending = db.prepare("SELECT COUNT(*) as n FROM task_completions WHERE task_id = ? AND status = 'pending'").get(id) as any;
      if (pending?.n) return { ok: false, error: '这个任务还有待审核的完成申请，先审核再删除' };
      db.prepare('DELETE FROM adhoc_tasks WHERE id = ?').run(id);
      pushToParents({ type: 'tasks_changed', action: 'delete' });
      return { ok: true, detail: `已删除任务「${task.name}」` };
    }
    const sets: string[] = [];
    const vals: any[] = [];
    if (typeof payload.name === 'string') {
      const name = payload.name.trim().slice(0, 60);
      if (!name) return { ok: false, error: '任务名不能为空' };
      sets.push('name = ?');
      vals.push(name);
    }
    if (payload.points != null) {
      const points = Number(payload.points);
      if (!Number.isInteger(points) || points <= 0 || points > 10000) return { ok: false, error: '积分必须是 1~10000 的整数' };
      sets.push('points = ?');
      vals.push(points);
    }
    if (typeof payload.deadline === 'string') {
      const d = payload.deadline.trim();
      if (!d) {
        sets.push('deadline = NULL');
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: '截止日期格式应为 YYYY-MM-DD' };
        sets.push('deadline = ?');
        vals.push(Math.floor(new Date(`${d}T23:59:59`).getTime() / 1000));
      }
    }
    if (typeof payload.category === 'string' && payload.category.trim()) {
      sets.push('category = ?');
      vals.push(payload.category.trim().slice(0, 20));
    }
    if (typeof payload.description === 'string') {
      sets.push('description = ?');
      vals.push(payload.description.trim().slice(0, 500));
    }
    if (!sets.length) return { ok: false, error: '没有要修改的字段' };
    db.prepare(`UPDATE adhoc_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    pushToParents({ type: 'tasks_changed', action: 'update' });
    return { ok: true, detail: `已修改任务「${task.name}」` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execReviewTaskCompletion(payload: any, userId: number): ExecResult {
  const db = getDb();
  const id = Number(payload.completionId);
  const tc = db
    .prepare(
      `SELECT tc.*, t.name as task_name, t.points as task_points
       FROM task_completions tc JOIN adhoc_tasks t ON t.id = tc.task_id WHERE tc.id = ?`
    )
    .get(id) as any;
  if (!tc) return { ok: false, error: '找不到这条完成申请' };
  if (tc.status !== 'pending') return { ok: false, error: '这条申请已经审核过了' };
  const now = Math.floor(Date.now() / 1000);
  try {
    if (payload.decision === 'reject') {
      const reason = String(payload.reason ?? '').trim().slice(0, 200);
      if (!reason) return { ok: false, error: '拒绝需要写原因' };
      db.prepare("UPDATE task_completions SET status = 'rejected', reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(
        reason,
        userId,
        now,
        id
      );
      pushToUser(tc.user_id, { type: 'task_review', taskId: tc.task_id, status: 'rejected', reason });
      return { ok: true, detail: `已拒绝「${tc.task_name}」的完成申请` };
    }
    const awardedAt = tc.created_at || now;
    const effect = dayEffectFor(tc.user_id, dateOfTs(awardedAt));
    const useEffect = tc.task_points > 0 && effect.earnMult !== 1;
    const gained = useEffect ? Math.round(tc.task_points * effect.earnMult) : tc.task_points;
    const effectNote = useEffect ? effectSuffix(effect, 'earn') : '';
    const txn = db.transaction(() => {
      db.prepare('UPDATE users SET total_points = total_points + ? WHERE id = ?').run(gained, tc.user_id);
      db.prepare(
        `INSERT INTO point_logs (user_id, delta, source, ref_id, note, created_by, created_at)
         VALUES (?, ?, 'adhoc', ?, ?, ?, ?)`
      ).run(tc.user_id, gained, tc.task_id, `任务：${tc.task_name}${effectNote}`, userId, awardedAt);
      awardContribution(db, tc.user_id, awardedAt, userId);
      db.prepare("UPDATE task_completions SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(userId, now, id);
      db.prepare("UPDATE adhoc_tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(now, tc.task_id);
    });
    txn();
    const newBalance = (db.prepare('SELECT total_points FROM users WHERE id = ?').get(tc.user_id) as any)?.total_points ?? 0;
    pushToUser(tc.user_id, { type: 'task_review', taskId: tc.task_id, status: 'approved', points: gained, dayEffect: useEffect ? effectInfo(effect, 'earn') : null });
    return { ok: true, detail: `已通过「${tc.task_name}」，+${gained} 分，余额 ${newBalance} 分` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execManagePointItem(payload: any): ExecResult {
  const db = getDb();
  try {
    if (payload.action === 'create') {
      const name = String(payload.name ?? '').trim().slice(0, 40);
      if (!name) return { ok: false, error: '积分项名称不能为空' };
      const type = payload.type === 'loss' ? 'loss' : 'gain';
      const abs = Number(payload.points);
      if (!Number.isInteger(abs) || abs <= 0 || abs > 10000) return { ok: false, error: '积分必须是 1~10000 的整数' };
      const limit = Math.max(0, Math.min(99, Number(payload.dailyLimit ?? 1) || 0));
      const ownerId = payload.ownerId != null ? assertChildId(Number(payload.ownerId)).id : null;
      db.prepare('INSERT INTO point_items (name, type, points, daily_limit, owner_id, enabled) VALUES (?, ?, ?, ?, ?, 1)').run(
        name,
        type,
        type === 'loss' ? -abs : abs,
        limit,
        ownerId
      );
      pushToParents({ type: 'point_items_changed' });
      return { ok: true, detail: `已新增积分项「${name}」` };
    }
    const id = Number(payload.itemId);
    const item = db.prepare('SELECT * FROM point_items WHERE id = ?').get(id) as any;
    if (!item) return { ok: false, error: '积分项不存在' };
    if (payload.action === 'delete') {
      db.prepare('DELETE FROM point_items WHERE id = ?').run(id);
      pushToParents({ type: 'point_items_changed' });
      return { ok: true, detail: `已删除积分项「${item.name}」` };
    }
    if (payload.action === 'toggle') {
      db.prepare('UPDATE point_items SET enabled = ? WHERE id = ?').run(item.enabled ? 0 : 1, id);
      pushToParents({ type: 'point_items_changed' });
      return { ok: true, detail: `已${item.enabled ? '停用' : '启用'}积分项「${item.name}」` };
    }
    const sets: string[] = [];
    const vals: any[] = [];
    if (typeof payload.name === 'string' && payload.name.trim()) {
      sets.push('name = ?');
      vals.push(payload.name.trim().slice(0, 40));
    }
    if (payload.type === 'gain' || payload.type === 'loss') {
      sets.push('type = ?');
      vals.push(payload.type);
      // 只改类型没改数值时，分数符号要跟着类型走
      if (payload.points == null && payload.type !== item.type) {
        sets.push('points = ?');
        vals.push(payload.type === 'loss' ? -Math.abs(item.points) : Math.abs(item.points));
      }
    }
    if (payload.points != null) {
      const abs = Number(payload.points);
      if (!Number.isInteger(abs) || abs === 0 || Math.abs(abs) > 10000) return { ok: false, error: '积分必须是 1~10000 的整数' };
      const type = payload.type === 'loss' || (payload.type == null && item.type === 'loss') ? 'loss' : 'gain';
      sets.push('points = ?');
      vals.push(type === 'loss' ? -Math.abs(abs) : Math.abs(abs));
    }
    if (payload.dailyLimit != null) {
      sets.push('daily_limit = ?');
      vals.push(Math.max(0, Math.min(99, Number(payload.dailyLimit) || 0)));
    }
    if (payload.enabled != null) {
      sets.push('enabled = ?');
      vals.push(payload.enabled ? 1 : 0);
    }
    if (!sets.length) return { ok: false, error: '没有要修改的字段' };
    db.prepare(`UPDATE point_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    pushToParents({ type: 'point_items_changed' });
    return { ok: true, detail: `已修改积分项「${item.name}」` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execManageProduct(payload: any): ExecResult {
  const db = getDb();
  try {
    if (payload.action === 'create') {
      const name = String(payload.name ?? '').trim().slice(0, 40);
      if (!name) return { ok: false, error: '商品名不能为空' };
      const cost = Number(payload.cost);
      if (!Number.isInteger(cost) || cost <= 0 || cost > 100000) return { ok: false, error: '所需积分必须是正整数' };
      const stock = payload.stock == null ? -1 : Number(payload.stock);
      if (!Number.isInteger(stock) || stock < -1) return { ok: false, error: '库存需为 -1（不限）或非负整数' };
      const categoryId = payload.categoryId != null ? Number(payload.categoryId) : null;
      const kind = payload.kind === 'prop' ? 'prop' : 'goods';
      db.prepare('INSERT INTO products (name, cost, stock, category_id, kind, status) VALUES (?, ?, ?, ?, ?, ?)').run(
        name,
        cost,
        stock,
        categoryId,
        kind,
        'active'
      );
      pushToAll({ type: 'products_changed', action: 'create' });
      return { ok: true, detail: `已新增商品「${name}」，${cost} 分` };
    }
    const id = Number(payload.productId);
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as any;
    if (!p) return { ok: false, error: '商品不存在' };
    if (payload.action === 'delete') {
      const used = db.prepare("SELECT COUNT(*) as n FROM exchange_requests WHERE product_id = ? AND status = 'pending'").get(id) as any;
      if (used?.n) return { ok: false, error: '这个商品还有待审核的兑换申请，先处理再删除' };
      db.prepare('DELETE FROM products WHERE id = ?').run(id);
      pushToAll({ type: 'products_changed', action: 'delete' });
      return { ok: true, detail: `已删除商品「${p.name}」` };
    }
    if (payload.action === 'toggle') {
      const next = p.status === 'active' ? 'inactive' : 'active';
      db.prepare('UPDATE products SET status = ? WHERE id = ?').run(next, id);
      pushToAll({ type: 'products_changed', action: 'status' });
      return { ok: true, detail: `已${next === 'active' ? '上架' : '下架'}商品「${p.name}」` };
    }
    const sets: string[] = [];
    const vals: any[] = [];
    if (typeof payload.name === 'string' && payload.name.trim()) {
      sets.push('name = ?');
      vals.push(payload.name.trim().slice(0, 40));
    }
    if (payload.cost != null) {
      const cost = Number(payload.cost);
      if (!Number.isInteger(cost) || cost <= 0) return { ok: false, error: '所需积分必须是正整数' };
      sets.push('cost = ?');
      vals.push(cost);
    }
    if (payload.stock != null) {
      const stock = Number(payload.stock);
      if (!Number.isInteger(stock) || stock < -1) return { ok: false, error: '库存需为 -1 或非负整数' };
      sets.push('stock = ?');
      vals.push(stock);
    }
    if (payload.categoryId != null) {
      sets.push('category_id = ?');
      vals.push(Number(payload.categoryId));
    }
    if (payload.kind === 'goods' || payload.kind === 'prop') {
      sets.push('kind = ?');
      vals.push(payload.kind);
    }
    if (payload.status === 'active' || payload.status === 'inactive') {
      sets.push('status = ?');
      vals.push(payload.status);
    }
    if (!sets.length) return { ok: false, error: '没有要修改的字段' };
    db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    pushToAll({ type: 'products_changed', action: 'update' });
    return { ok: true, detail: `已修改商品「${p.name}」` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execHandleExchange(payload: any, userId: number): ExecResult {
  const db = getDb();
  const id = Number(payload.requestId);
  const r = db.prepare('SELECT * FROM exchange_requests WHERE id = ?').get(id) as any;
  if (!r) return { ok: false, error: '找不到这条兑换申请' };
  if (r.status !== 'pending') return { ok: false, error: '这条兑换申请已经处理过了' };
  const now = Math.floor(Date.now() / 1000);
  if (payload.decision === 'reject') {
    const reason = String(payload.reason ?? '').trim().slice(0, 200);
    if (!reason) return { ok: false, error: '拒绝需要写原因' };
    db.prepare("UPDATE exchange_requests SET status = 'rejected', reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(
      reason,
      userId,
      now,
      id
    );
    pushToUser(r.user_id, { type: 'exchange_reviewed', requestId: id, status: 'rejected', exchangeType: r.type, points: r.points, amount: r.amount, reason });
    return { ok: true, detail: '已拒绝这条兑换申请' };
  }
  try {
    let finalCost = 0;
    let newBalance = 0;
    const txn = db.transaction(() => {
      const effect = dayEffectFor(r.user_id, todayLocal());
      const discounted = r.type === 'product' && r.points > 0 && effect.spendMult !== 1;
      finalCost = discounted ? Math.max(1, Math.round(r.points * effect.spendMult)) : r.points;
      const user = db.prepare('SELECT total_points FROM users WHERE id = ?').get(r.user_id) as any;
      if (!user || user.total_points < finalCost) throw new Error('积分不够');
      db.prepare('UPDATE users SET total_points = total_points - ? WHERE id = ?').run(finalCost, r.user_id);
      const productName = r.product_id ? (db.prepare('SELECT name FROM products WHERE id = ?').get(r.product_id) as any)?.name ?? '已删除' : '';
      db.prepare(
        `INSERT INTO point_logs (user_id, delta, source, ref_id, note, created_by)
         VALUES (?, ?, 'exchange', ?, ?, ?)`
      ).run(
        r.user_id,
        -finalCost,
        r.id,
        r.type === 'cash' ? `兑换现金 ${r.amount}元` : `兑换商品：${productName}${r.variant_name ? `（${r.variant_name}）` : ''}`,
        userId
      );
      db.prepare("UPDATE exchange_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(userId, now, id);
      if (r.type === 'product' && r.product_id) {
        const qty = Math.max(1, r.quantity ?? 1);
        if (r.variant_id) {
          db.prepare('UPDATE product_variants SET stock = stock - ? WHERE id = ? AND stock >= ?').run(qty, r.variant_id, qty);
        } else {
          db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(qty, r.product_id, qty);
        }
      }
      newBalance = (db.prepare('SELECT total_points FROM users WHERE id = ?').get(r.user_id) as any)?.total_points ?? 0;
    });
    txn();
    pushToUser(r.user_id, { type: 'exchange_reviewed', requestId: id, status: 'approved', exchangeType: r.type, points: finalCost, amount: r.amount, newBalance });
    pushToAll({ type: 'products_changed', action: 'stock', productId: r.product_id ?? null });
    return { ok: true, detail: `已通过兑换，扣 ${finalCost} 分，孩子余额 ${newBalance} 分` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

/* ── 日程 / 特殊日 / 账号 / 成长 / 商城设置（写） ─────────────────────── */

const AI_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const AVATAR_KEYS = new Set(['rat', 'ox', 'tiger', 'rabbit', 'dragon', 'snake', 'horse', 'goat', 'monkey', 'rooster', 'dog', 'pig']);
const CATEGORY_ICONS = new Set(['snack', 'toy', 'activity', 'game', 'study', 'privilege', 'food', 'gift']);
const FEMALE_IDENTITIES = new Set([
  '妈妈', '奶奶', '姥姥', '外婆', '伯母', '婶婶', '姑姑', '舅妈', '姨姨', '干妈', '阿姨',
]);

function numList(v: unknown): number[] {
  return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n)) : [];
}

function writeSpecialTargets(specialDayId: number, ids: number[]): void {
  const db = getDb();
  db.prepare('DELETE FROM special_day_targets WHERE special_day_id = ?').run(specialDayId);
  const ins = db.prepare('INSERT OR IGNORE INTO special_day_targets (special_day_id, user_id) VALUES (?, ?)');
  for (const uid of [...new Set(ids)]) ins.run(specialDayId, uid);
}

function execCalendarEvent(payload: any, userId: number): ExecResult {
  const db = getDb();
  try {
    if (payload.action === 'delete') {
      const id = Number(payload.eventId);
      const e = db.prepare('SELECT title FROM calendar_events WHERE id = ?').get(id) as any;
      if (!e) return { ok: false, error: '日程不存在' };
      db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
      pushToAll({ type: 'calendar_changed', action: 'delete', eventId: id });
      return { ok: true, detail: `已删除日程「${e.title}」` };
    }

    if (payload.action === 'update') {
      const id = Number(payload.eventId);
      const existing = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as any;
      if (!existing) return { ok: false, error: '日程不存在' };
      const oldParticipants = (db.prepare('SELECT user_id FROM calendar_event_participants WHERE event_id = ?').all(id) as any[]).map(
        (p) => p.user_id
      );

      const title = payload.title !== undefined ? String(payload.title).trim().slice(0, 50) : existing.title;
      if (!title) return { ok: false, error: '日程标题不能为空' };
      const eventDate = payload.event_date !== undefined ? String(payload.event_date) : existing.event_date;
      if (!isDateArg(eventDate)) return { ok: false, error: '开始日期格式应为 YYYY-MM-DD' };
      let endDate = payload.end_date !== undefined ? String(payload.end_date) : (existing.end_date ?? eventDate);
      if (!endDate) endDate = eventDate;
      if (!isDateArg(endDate)) return { ok: false, error: '结束日期格式应为 YYYY-MM-DD' };
      if (endDate < eventDate) return { ok: false, error: '结束日期不能早于开始日期' };
      const isAllDay = payload.is_all_day !== undefined ? Boolean(payload.is_all_day) : !!existing.is_all_day;
      const startTime = payload.start_time !== undefined ? String(payload.start_time ?? '') || null : existing.start_time;
      const endTime = payload.end_time !== undefined ? String(payload.end_time ?? '') || null : existing.end_time;
      if (!isAllDay && (!startTime || !endTime)) return { ok: false, error: '非全天日程需要 start_time 与 end_time' };
      if (!isAllDay && (!AI_TIME_RE.test(startTime!) || !AI_TIME_RE.test(endTime!))) {
        return { ok: false, error: '时间格式应为 HH:MM' };
      }
      const note = payload.note !== undefined ? String(payload.note).slice(0, 200) : (existing.note ?? '');
      const visibility =
        payload.visibility === 'private' || payload.visibility === 'public' ? payload.visibility : existing.visibility;
      const idsArg = Array.isArray(payload.participantIds) ? payload.participantIds : [];
      const namesArg = Array.isArray(payload.participantNames) ? payload.participantNames : [];
      const participants =
        idsArg.length || namesArg.length ? resolveParticipants(idsArg, namesArg, userId).ids : oldParticipants;
      if (!participants.length) return { ok: false, error: '至少需要一个参与人' };

      db.transaction(() => {
        db.prepare(
          `UPDATE calendar_events
           SET title = ?, event_date = ?, end_date = ?, is_all_day = ?, start_time = ?, end_time = ?,
               note = ?, visibility = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          title,
          eventDate,
          endDate,
          isAllDay ? 1 : 0,
          isAllDay ? null : startTime,
          isAllDay ? null : endTime,
          note,
          visibility,
          Math.floor(Date.now() / 1000),
          id
        );
        db.prepare('DELETE FROM calendar_event_participants WHERE event_id = ?').run(id);
        const ins = db.prepare('INSERT OR IGNORE INTO calendar_event_participants (event_id, user_id) VALUES (?, ?)');
        for (const uid of participants) ins.run(id, uid);
      })();
      pushToAll({ type: 'calendar_changed', action: 'update', eventId: id });
      return { ok: true, detail: `已修改日程「${title}」` };
    }

    // create
    const title = String(payload.title ?? '').trim().slice(0, 50);
    if (!title) return { ok: false, error: '日程标题不能为空' };
    const eventDate = String(payload.event_date ?? '');
    if (!isDateArg(eventDate)) return { ok: false, error: '开始日期格式应为 YYYY-MM-DD' };
    const endDate = String(payload.end_date ?? '') || eventDate;
    if (!isDateArg(endDate)) return { ok: false, error: '结束日期格式应为 YYYY-MM-DD' };
    if (endDate < eventDate) return { ok: false, error: '结束日期不能早于开始日期' };
    const isAllDay = payload.is_all_day === undefined ? true : Boolean(payload.is_all_day);
    const startTime = String(payload.start_time ?? '') || null;
    const endTime = String(payload.end_time ?? '') || null;
    if (!isAllDay && (!startTime || !endTime)) return { ok: false, error: '非全天日程需要 start_time 与 end_time' };
    if (!isAllDay && (!AI_TIME_RE.test(startTime!) || !AI_TIME_RE.test(endTime!))) {
      return { ok: false, error: '时间格式应为 HH:MM' };
    }
    const note = String(payload.note ?? '').slice(0, 200);
    const visibility = payload.visibility === 'private' ? 'private' : 'public';
    const participants = resolveParticipants(payload.participantIds, payload.participantNames, userId);
    if (!participants.ids.length) return { ok: false, error: '至少需要一个参与人' };
    if (participants.ids.length > 20) return { ok: false, error: '参与人最多 20 个' };

    let eventId = 0;
    db.transaction(() => {
      const r = db.prepare(
        `INSERT INTO calendar_events (title, event_date, end_date, is_all_day, start_time, end_time, note, visibility, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(title, eventDate, endDate, isAllDay ? 1 : 0, isAllDay ? null : startTime, isAllDay ? null : endTime, note, visibility, userId);
      eventId = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT OR IGNORE INTO calendar_event_participants (event_id, user_id) VALUES (?, ?)');
      for (const uid of participants.ids) ins.run(eventId, uid);
    })();
    pushToAll({ type: 'calendar_changed', action: 'create', eventId });
    return { ok: true, detail: `已创建日程「${title}」（${eventDate}，参与人：${participants.labels.join('、')}）` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execSpecialDay(payload: any, userId: number): ExecResult {
  const db = getDb();
  try {
    const action = String(payload.action ?? '');
    if (action === 'delete' || action === 'toggle') {
      const row = db.prepare('SELECT * FROM special_days WHERE id = ?').get(Number(payload.specialDayId)) as any;
      if (!row) return { ok: false, error: '特殊日不存在' };
      if (action === 'delete') {
        db.prepare('DELETE FROM special_days WHERE id = ?').run(row.id);
        pushToAll({ type: 'special_days_changed', action: 'delete', specialDayId: row.id });
        return { ok: true, detail: `已删除特殊日「${row.name}」` };
      }
      const next = row.enabled ? 0 : 1;
      db.prepare('UPDATE special_days SET enabled = ? WHERE id = ?').run(next, row.id);
      pushToAll({ type: 'special_days_changed', action: 'update', specialDayId: row.id });
      return { ok: true, detail: `已${next ? '启用' : '停用'}特殊日「${row.name}」` };
    }

    const existing =
      action === 'update' ? (db.prepare('SELECT * FROM special_days WHERE id = ?').get(Number(payload.specialDayId)) as any) : null;
    if (action === 'update' && !existing) return { ok: false, error: '特殊日不存在' };

    const name = String(payload.name ?? existing?.name ?? '').trim().slice(0, 30);
    if (!name) return { ok: false, error: '特殊日名称不能为空' };
    const emoji = String(payload.emoji ?? existing?.emoji ?? '🎉').slice(0, 8) || '🎉';
    const ruleType = String(payload.ruleType ?? existing?.rule_type ?? '');
    if (!['once', 'weekly', 'monthly', 'yearly'].includes(ruleType)) {
      return { ok: false, error: 'ruleType 只能是 once / weekly / monthly / yearly' };
    }

    const onceRaw = payload.onceDate !== undefined ? String(payload.onceDate ?? '') : (existing?.once_date ?? '');
    const onceDate = ruleType === 'once' ? (isDateArg(onceRaw) ? onceRaw : null) : null;
    if (ruleType === 'once' && !onceDate) return { ok: false, error: '单次特殊日需要 onceDate（YYYY-MM-DD）' };

    const weekdays =
      payload.weekdays !== undefined ? numList(payload.weekdays) : parseJsonNumList(existing?.weekdays);
    const monthDays =
      payload.monthDays !== undefined ? numList(payload.monthDays) : parseJsonNumList(existing?.month_days);
    if (ruleType === 'weekly' && !weekdays.length) return { ok: false, error: '每周特殊日需要 weekdays（1=周一…7=周日）' };
    if (ruleType === 'monthly' && !monthDays.length) return { ok: false, error: '每月特殊日需要 monthDays（1~31）' };
    if (weekdays.some((n) => n < 1 || n > 7)) return { ok: false, error: 'weekdays 只能是 1~7' };
    if (monthDays.some((n) => n < 1 || n > 31)) return { ok: false, error: 'monthDays 只能是 1~31' };

    const yearlyMd = payload.yearlyMd !== undefined ? String(payload.yearlyMd ?? '') : (existing?.yearly_md ?? '');
    if (ruleType === 'yearly' && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(yearlyMd)) {
      return { ok: false, error: '每年特殊日需要 yearlyMd（MM-DD）' };
    }

    const rangeStart =
      payload.rangeStart !== undefined ? String(payload.rangeStart ?? '') || null : (existing?.range_start ?? null);
    const rangeEnd = payload.rangeEnd !== undefined ? String(payload.rangeEnd ?? '') || null : (existing?.range_end ?? null);
    if (rangeStart && !isDateArg(rangeStart)) return { ok: false, error: 'rangeStart 格式应为 YYYY-MM-DD' };
    if (rangeEnd && !isDateArg(rangeEnd)) return { ok: false, error: 'rangeEnd 格式应为 YYYY-MM-DD' };
    if (rangeStart && rangeEnd && rangeStart > rangeEnd) return { ok: false, error: '生效起始日不能晚于结束日' };

    const kindArg = payload.effectKind !== undefined ? payload.effectKind : (existing?.effect_kind ?? null);
    let effectKind: 'earn' | 'spend' | null = null;
    let effectValue: number | null = null;
    if (kindArg === 'earn' || kindArg === 'spend') {
      effectKind = kindArg;
      effectValue = payload.effectValue !== undefined ? Number(payload.effectValue) : Number(existing?.effect_value);
      if (!Number.isFinite(effectValue)) return { ok: false, error: '设置积分效果时需要 effectValue' };
      if (effectKind === 'earn' && (effectValue <= 1 || effectValue > 3)) {
        return { ok: false, error: '获得倍率需大于 1 且不超过 3（如 2 表示双倍）' };
      }
      if (effectKind === 'spend' && (effectValue <= 0 || effectValue >= 1)) {
        return { ok: false, error: '消耗折扣需大于 0 且小于 1（如 0.5 表示半价）' };
      }
    } else if (kindArg !== null && kindArg !== undefined && kindArg !== '') {
      return { ok: false, error: 'effectKind 只能是 earn 或 spend；不设效果请留空' };
    }

    const scope = payload.scope === 'custom' || payload.scope === 'all' ? payload.scope : (existing?.scope ?? 'all');
    let targetIds: number[] = [];
    if (scope === 'custom') {
      targetIds =
        payload.targetIds !== undefined
          ? numList(payload.targetIds)
          : ((db.prepare('SELECT user_id FROM special_day_targets WHERE special_day_id = ?').all(existing?.id ?? 0) as any[]).map(
              (t) => t.user_id
            ));
      if (!targetIds.length) return { ok: false, error: '指定孩子时需要 targetIds' };
      const placeholders = targetIds.map(() => '?').join(',');
      const found = db.prepare(`SELECT id, role FROM users WHERE id IN (${placeholders})`).all(...targetIds) as any[];
      if (found.length !== new Set(targetIds).size) return { ok: false, error: '部分孩子 id 不存在' };
      if (found.some((u) => u.role !== 'child')) return { ok: false, error: 'targetIds 只能填孩子' };
    }

    const enabled = payload.enabled !== undefined ? Boolean(payload.enabled) : existing ? !!existing.enabled : true;
    const weekdaysJson = ruleType === 'weekly' ? JSON.stringify(weekdays) : null;
    const monthDaysJson = ruleType === 'monthly' ? JSON.stringify(monthDays) : null;
    const yearlyJson = ruleType === 'yearly' ? yearlyMd : null;

    if (existing) {
      db.prepare(
        `UPDATE special_days
         SET name = ?, emoji = ?, rule_type = ?, once_date = ?, weekdays = ?, month_days = ?, yearly_md = ?,
             range_start = ?, range_end = ?, scope = ?, effect_kind = ?, effect_value = ?, enabled = ?
         WHERE id = ?`
      ).run(
        name,
        emoji,
        ruleType,
        onceDate,
        weekdaysJson,
        monthDaysJson,
        yearlyJson,
        rangeStart,
        rangeEnd,
        scope,
        effectKind,
        effectValue,
        enabled ? 1 : 0,
        existing.id
      );
      writeSpecialTargets(existing.id, targetIds);
      pushToAll({ type: 'special_days_changed', action: 'update', specialDayId: existing.id });
      return { ok: true, detail: `已修改特殊日「${name}」` };
    }

    const r = db.prepare(
      `INSERT INTO special_days
        (name, emoji, rule_type, once_date, weekdays, month_days, yearly_md, range_start, range_end, scope, effect_kind, effect_value, enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name,
      emoji,
      ruleType,
      onceDate,
      weekdaysJson,
      monthDaysJson,
      yearlyJson,
      rangeStart,
      rangeEnd,
      scope,
      effectKind,
      effectValue,
      enabled ? 1 : 0,
      userId
    );
    writeSpecialTargets(Number(r.lastInsertRowid), targetIds);
    pushToAll({ type: 'special_days_changed', action: 'create' });
    return { ok: true, detail: `已新增特殊日「${name}」` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execCreateChild(payload: any): ExecResult {
  const db = getDb();
  const name = String(payload.name ?? '').trim().slice(0, 20);
  if (!name) return { ok: false, error: '孩子昵称不能为空' };
  const pin = String(payload.pin ?? '').trim();
  if (!isValidPin(pin)) return { ok: false, error: 'PIN 必须是 4~6 位数字' };
  const avatar = String(payload.avatar ?? '');
  if (!AVATAR_KEYS.has(avatar)) return { ok: false, error: 'avatar 必须是生肖 key' };
  const birthday = String(payload.birthday ?? '');
  if (!isDateArg(birthday)) return { ok: false, error: '生日格式应为 YYYY-MM-DD' };
  const sex = payload.sex === 'male' || payload.sex === 'female' ? payload.sex : null;
  if (!sex) return { ok: false, error: 'sex 只能是 male 或 female' };
  if (db.prepare("SELECT id FROM users WHERE pin = ? AND role = 'child'").get(pin)) {
    return { ok: false, error: '这个 PIN 已被其他孩子使用' };
  }
  try {
    const r = db.prepare(
      `INSERT INTO users (name, role, pin, avatar, birthday, sex, total_points)
       VALUES (?, 'child', ?, ?, ?, ?, 0)`
    ).run(name, pin, avatar, birthday, sex);
    return { ok: true, detail: `已创建孩子账号「${name}」（id=${r.lastInsertRowid}）` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execCreateParent(payload: any, userId: number): ExecResult {
  const db = getDb();
  const me = db.prepare("SELECT is_primary FROM users WHERE id = ? AND role = 'parent'").get(userId) as any;
  if (!me?.is_primary) return { ok: false, error: '只有主家长才能新建家长账号' };
  const name = String(payload.name ?? '').trim().slice(0, 30);
  if (!name) return { ok: false, error: '账号名不能为空' };
  const password = String(payload.password ?? '');
  if (password.length < 6 || password.length > 64) return { ok: false, error: '密码需要 6~64 位' };
  const identity = String(payload.identity ?? '').trim().slice(0, 20);
  if (!identity) return { ok: false, error: '请填写身份称谓（如妈妈 / 爸爸 / 奶奶）' };
  if (db.prepare("SELECT id FROM users WHERE role = 'parent' AND name = ?").get(name)) {
    return { ok: false, error: '这个账号名已被使用' };
  }
  try {
    const avatar = FEMALE_IDENTITIES.has(identity) ? 'rabbit' : 'dragon';
    db.prepare(
      `INSERT INTO users (name, role, password_hash, avatar, nickname, parent_identity, is_primary, total_points)
       VALUES (?, 'parent', ?, ?, ?, ?, 0, 0)`
    ).run(name, hashPasswordSync(password), avatar, identity, identity);
    return { ok: true, detail: `已创建家长账号「${name}」（${identity}）` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execAddGrowthRecord(payload: any, userId: number): ExecResult {
  const child = assertChildId(
    payload.childId != null ? Number(payload.childId) : undefined,
    payload.childName != null ? String(payload.childName) : undefined
  );
  const date = isDateArg(payload.date) ? payload.date : todayLocal();
  const heightCm = payload.heightCm == null || payload.heightCm === '' ? null : Number(payload.heightCm);
  const weightKg = payload.weightKg == null || payload.weightKg === '' ? null : Number(payload.weightKg);
  if (heightCm != null && (!Number.isFinite(heightCm) || heightCm < 30 || heightCm > 250)) {
    return { ok: false, error: '身高需在 30~250 厘米之间' };
  }
  if (weightKg != null && (!Number.isFinite(weightKg) || weightKg < 2 || weightKg > 200)) {
    return { ok: false, error: '体重需在 2~200 公斤之间' };
  }
  if (heightCm == null && weightKg == null) return { ok: false, error: '身高和体重至少填一项' };
  const note = payload.note != null ? String(payload.note).trim().slice(0, 100) || null : null;

  const r = recordGrowthRecord({ userId: child.id, recordDate: date, heightCm, weightKg, note, createdBy: userId });
  if (!r.ok) return { ok: false, error: r.error === 'not_found' ? '孩子不存在' : '身高和体重至少填一项' };

  const parts = [`已${r.updated ? '更新' : '记录'} ${child.name} ${date} 的成长记录`];
  if (heightCm != null) parts.push(`身高 ${heightCm}cm`);
  if (weightKg != null) parts.push(`体重 ${weightKg}kg`);
  if (r.growCm) parts.push(`较上次 ${r.growCm > 0 ? '+' : ''}${r.growCm}cm`);
  if (r.awarded) parts.push(`积分 ${r.awarded > 0 ? '+' : ''}${r.awarded}`);
  return { ok: true, detail: parts.join('，') };
}

/** 批量录入成长数据：先整体校验，再按日期从早到晚写入，保证基准与合计积分稳定 */
function execAddGrowthRecords(payload: any, userId: number): ExecResult {
  const child = assertChildId(
    payload.childId != null ? Number(payload.childId) : undefined,
    payload.childName != null ? String(payload.childName) : undefined
  );
  const rawList = Array.isArray(payload.records) ? payload.records : [];
  if (!rawList.length) return { ok: false, error: 'records 不能为空' };
  if (rawList.length > 100) return { ok: false, error: '一次最多 100 条' };

  const items: Array<{ date: string; heightCm: number | null; weightKg: number | null; note: string | null }> = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: '记录格式不对' };
    if (!isDateArg(raw.date)) return { ok: false, error: `日期格式须为 YYYY-MM-DD：${raw.date ?? ''}` };
    const heightCm = raw.heightCm == null || raw.heightCm === '' ? null : Number(raw.heightCm);
    const weightKg = raw.weightKg == null || raw.weightKg === '' ? null : Number(raw.weightKg);
    if (heightCm != null && (!Number.isFinite(heightCm) || heightCm < 30 || heightCm > 250)) {
      return { ok: false, error: `${raw.date} 的身高需在 30~250 厘米之间` };
    }
    if (weightKg != null && (!Number.isFinite(weightKg) || weightKg < 2 || weightKg > 200)) {
      return { ok: false, error: `${raw.date} 的体重需在 2~200 公斤之间` };
    }
    if (heightCm == null && weightKg == null) return { ok: false, error: `${raw.date} 身高和体重至少填一项` };
    const note = raw.note != null ? String(raw.note).trim().slice(0, 100) || null : null;
    items.push({ date: raw.date, heightCm, weightKg, note });
  }

  items.sort((a, b) => a.date.localeCompare(b.date));

  let totalAwarded = 0;
  const lines: string[] = [];
  for (const it of items) {
    const r = recordGrowthRecord({
      userId: child.id,
      recordDate: it.date,
      heightCm: it.heightCm,
      weightKg: it.weightKg,
      note: it.note,
      createdBy: userId,
    });
    if (!r.ok) {
      return { ok: false, error: r.error === 'not_found' ? '孩子不存在' : `${it.date} 记录失败` };
    }
    totalAwarded += r.awarded;
    const bits = [it.date];
    if (it.heightCm != null) bits.push(`身高 ${it.heightCm}cm`);
    if (it.weightKg != null) bits.push(`体重 ${it.weightKg}kg`);
    if (r.growCm) bits.push(`较上次 ${r.growCm > 0 ? '+' : ''}${r.growCm}cm`);
    bits.push(`积分 ${r.awarded > 0 ? '+' : ''}${r.awarded}`);
    lines.push(bits.join('，'));
  }

  return {
    ok: true,
    detail: `已记录 ${child.name} 共 ${items.length} 条成长数据：\n${lines.join('\n')}\n合计积分 ${totalAwarded > 0 ? '+' : ''}${totalAwarded}`,
  };
}

function execManageProductCategory(payload: any): ExecResult {
  const db = getDb();
  const action = String(payload.action ?? '');
  try {
    if (action === 'create') {
      const name = String(payload.name ?? '').trim().slice(0, 12);
      if (!name) return { ok: false, error: '分类名不能为空' };
      const icon = CATEGORY_ICONS.has(String(payload.icon ?? '')) ? String(payload.icon) : 'gift';
      const color = /^#[0-9a-fA-F]{6}$/.test(String(payload.color ?? '')) ? String(payload.color) : '#e8b4c8';
      const next = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM product_categories').get() as any).n;
      const r = db.prepare('INSERT INTO product_categories (name, icon, color, sort_order) VALUES (?, ?, ?, ?)').run(
        name,
        icon,
        color,
        next
      );
      pushToAll({ type: 'products_changed', action: 'category_created' });
      return { ok: true, detail: `已新增商品分类「${name}」（id=${r.lastInsertRowid}）` };
    }

    const id = Number(payload.categoryId);
    const cat = db.prepare('SELECT * FROM product_categories WHERE id = ?').get(id) as any;
    if (!cat) return { ok: false, error: '商品分类不存在' };

    if (action === 'delete') {
      if (cat.hidden === 1) return { ok: false, error: '「许愿单」是系统分类，不能删除' };
      db.transaction(() => {
        db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(id);
        db.prepare('DELETE FROM product_categories WHERE id = ?').run(id);
      })();
      pushToAll({ type: 'products_changed', action: 'category_deleted' });
      return { ok: true, detail: `已删除商品分类「${cat.name}」，原商品变为未分类` };
    }

    const sets: string[] = [];
    const vals: any[] = [];
    if (payload.name !== undefined) {
      const name = String(payload.name ?? '').trim().slice(0, 12);
      if (!name) return { ok: false, error: '分类名不能为空' };
      sets.push('name = ?');
      vals.push(name);
    }
    if (payload.icon !== undefined) {
      const icon = String(payload.icon ?? '');
      if (!CATEGORY_ICONS.has(icon)) return { ok: false, error: '图标只能是内置图标 key' };
      sets.push('icon = ?');
      vals.push(icon);
    }
    if (payload.color !== undefined) {
      const color = String(payload.color ?? '');
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { ok: false, error: '颜色格式应为 #RRGGBB' };
      sets.push('color = ?');
      vals.push(color);
    }
    if (!sets.length) return { ok: false, error: '没有要修改的字段' };
    db.prepare(`UPDATE product_categories SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    pushToAll({ type: 'products_changed', action: 'category_updated' });
    return { ok: true, detail: `已修改商品分类「${cat.name}」` };
  } catch (e) {
    return { ok: false, error: `执行失败：${(e as Error)?.message ?? e}` };
  }
}

function execSetCashRate(payload: any): ExecResult {
  const rate = Number(payload.rate);
  if (!Number.isInteger(rate) || rate <= 0) return { ok: false, error: '比例必须是正整数' };
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('cash_rate', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(String(rate), now);
  pushToAll({ type: 'products_changed', action: 'cash_rate' });
  return { ok: true, detail: `已设置 ${rate} 积分 = 1 元` };
}

/** 写类工具统一过看门层：返回 null = 可以执行；否则直接把结果/确认卡交回对话主循环 */
function writeGate(
  ctx: ToolCtx,
  moduleName: string,
  actionKey: string,
  kind: string,
  payload: unknown,
  summary: string
): { kind: 'result'; text: string } | { kind: 'confirm'; token: string; summary: string; detail: string } | null {
  if (ctx.bypassJudge) return null;
  const verdict = judge({
    taskId: ctx.taskId,
    ownerUserId: ctx.userId,
    risk: 'normal',
    actionKey,
    kind,
    payload,
    summary,
    moduleName,
    actor: ctx.actor,
  });
  if (verdict.verdict === 'deny') return { kind: 'result', text: verdict.reason };
  if (verdict.verdict === 'ask') return { kind: 'confirm', token: verdict.token, summary: verdict.summary, detail: verdict.detail };
  return null;
}

/* ── 执行入口 ──────────────────────────────────────────────────────────── */

export function executeBuiltinTool(name: string, argsJson: string, ctx: ToolCtx): ToolOutcome {
  let args: any = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return { kind: 'result', text: '工具参数不是合法 JSON' };
  }

  const moduleName = moduleNameOf(name);
  const auditRead = (text: string): ToolOutcome => {
    auditExec(ctx.actor, moduleName, `执行 ${name}`, text.slice(0, 200));
    return { kind: 'result', text };
  };

  try {
    switch (name) {
      case 'list_children':
        return auditRead(listChildren());

      case 'ask_user':
        // 面板由对话主循环拦截处理（要拿 WS 上下文与 await 家长回答）；
        // 流程技能里不会有人等候，直接告诉模型别用
        return { kind: 'result', text: 'ask_user 只能在对话中直接调用，流程技能里请改用文本说明需要家长补充的信息。' };

      case 'update_plan':
        // 计划由对话主循环记录并推给界面（需要回合状态上下文）
        return { kind: 'result', text: '计划已经记录并在界面上展示，继续执行下一步即可。' };

      case 'get_point_summary':
        return auditRead(pointSummary(args.childId, args.days));

case 'get_backpack':
        return auditRead(backpackOf(args.childId, args.childName));

      case 'list_tasks':
        return auditRead(tasksOverview(args.childId != null ? Number(args.childId) : undefined, Boolean(args.includeDone)));

      case 'list_point_items':
        return auditRead(pointItemsText(args.childId != null ? Number(args.childId) : undefined));

      case 'list_shop':
        return auditRead(shopText(args.keyword));

      case 'list_pending_reviews':
        return auditRead(pendingReviewsText());

      case 'list_calendar':
        return auditRead(calendarText(args.from, args.to));

      case 'list_special_days':
        return auditRead(specialDaysText());

      case 'list_accounts':
        return auditRead(accountsText());

      case 'list_growth_records':
        return auditRead(growthText(args.childId, args.childName, args.limit));

      case 'list_diaries':
        return auditRead(diariesText(args.childId, args.from, args.to, args.keyword, args.limit));

      case 'list_operation_logs':
        return auditRead(operationLogsText(args.from, args.to, args.module, args.role, args.actorId, args.limit));

      case 'web_search':
      case 'web_fetch':
        // 网络请求是异步的，由对话主循环拦截执行；流程技能里没有联网通道
        return { kind: 'result', text: '联网检索只能在对话中直接调用，流程技能里请改用文本说明。' };

      case 'memory_search': {
        const q = String(args.query ?? '');
        const hits = searchMemory(q, 5);
        const text = hits.length
          ? `检索「${q}」命中 ${hits.length} 条记忆：\n${hits.map((h) => `- 【${h.title}】${h.snippet}`).join('\n')}`
          : `记忆里没有关于「${q}」的内容。`;
        return auditRead(text);
      }

      case 'memory_save': {
        const title = String(args.title ?? '').trim();
        if (!title) return { kind: 'result', text: '笔记标题不能为空' };
        const observations = (Array.isArray(args.observations) ? args.observations : []).map((o: any) => [
          String(o.category ?? '事实').slice(0, 20),
          String(o.text ?? '').slice(0, 300),
        ]) as [string, string][];
        const r = saveMemoryNote({
          title,
          tags: Array.isArray(args.tags) ? args.tags.map((x: unknown) => String(x)).slice(0, 8) : [],
          observations,
          relations: Array.isArray(args.relations) ? args.relations.map((x: unknown) => String(x)).slice(0, 8) : [],
        });
        auditExec(ctx.actor, moduleName, r.merged ? '更新记忆' : '新建记忆', `【${title}】+${observations.length} 条观察`);
        return { kind: 'result', text: `已${r.merged ? '更新' : '写入'}记忆笔记「${title}」（${observations.length} 条观察记录）。` };
      }

      case 'add_point_records': {
        const records = Array.isArray(args.records) ? args.records : [];
        if (!records.length) return { kind: 'result', text: 'records 为空，没有可导入的记录' };
        const prepared: { childId: number; childName: string; delta: number; note: string; date: string | null }[] = [];
        for (const r of records) {
          const child = assertChildId(r.childId, r.childName);
          const delta = Number(r.delta);
          if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000) {
            return { kind: 'result', text: `记录「${r.note ?? ''}」的 delta 必须是非零整数（±10000 以内）` };
          }
          const note = String(r.note ?? '').trim().slice(0, 200);
          if (!note) return { kind: 'result', text: '每条记录都需要一句话 note 说明原因' };
          const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
          prepared.push({ childId: child.id, childName: child.name, delta, note, date });
        }
        const summary = `AI 导入 ${prepared.length} 条积分记录：${prepared
          .map((p) => `${p.childName} ${p.delta > 0 ? '+' : ''}${p.delta}分（${p.note}）`)
          .join('；')}${args.reason ? `（来源：${args.reason}）` : ''}`;
        const verdict = ctx.bypassJudge ? ({ verdict: 'allow' } as SentinelVerdict) : judge({
          taskId: ctx.taskId,
          ownerUserId: ctx.userId,
          risk: 'normal',
          actionKey: 'add_point_records',
          kind: 'add_point_records',
          payload: { records: prepared },
          summary,
          moduleName,
          actor: ctx.actor,
        });
        if (verdict.verdict === 'deny') return { kind: 'result', text: verdict.reason };
        if (verdict.verdict === 'ask') {
          return { kind: 'confirm', token: verdict.token, summary: verdict.summary, detail: verdict.detail };
        }
        const exec: ExecResult = execAddPointRecords({ records: prepared }, ctx.userId);
        return exec.ok
          ? { kind: 'result', text: `已执行：${exec.detail}` }
          : { kind: 'result', text: exec.error };
      }

      case 'create_tasks': {
        const tasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (!tasks.length) return { kind: 'result', text: 'tasks 为空' };
        const prepared: { childId: number; childName: string; name: string; points: number; deadline: number | null }[] = [];
        for (const t of tasks) {
          const child = assertChildId(t.childId, t.childName);
          const name = String(t.name ?? '').trim().slice(0, 60);
          if (!name) return { kind: 'result', text: '任务名不能为空' };
          const points = Number(t.points);
          if (!Number.isInteger(points) || points <= 0 || points > 10000) {
            return { kind: 'result', text: `任务「${name}」的积分必须是 1~10000 的整数` };
          }
          const deadline =
            typeof t.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.deadline)
              ? Math.floor(new Date(`${t.deadline}T23:59:59`).getTime() / 1000)
              : null;
          prepared.push({ childId: child.id, childName: child.name, name, points, deadline });
        }
        const summary = `AI 创建 ${prepared.length} 个任务：${prepared
          .map((p) => `「${p.name}」${p.childName} +${p.points}分`)
          .join('；')}`;
        const verdict = ctx.bypassJudge ? ({ verdict: 'allow' } as SentinelVerdict) : judge({
          taskId: ctx.taskId,
          ownerUserId: ctx.userId,
          risk: 'normal',
          actionKey: 'create_tasks',
          kind: 'create_tasks',
          payload: { tasks: prepared },
          summary,
          moduleName,
          actor: ctx.actor,
        });
        if (verdict.verdict === 'deny') return { kind: 'result', text: verdict.reason };
        if (verdict.verdict === 'ask') {
          return { kind: 'confirm', token: verdict.token, summary: verdict.summary, detail: verdict.detail };
        }
        const exec: ExecResult = execCreateTasks({ tasks: prepared }, ctx.userId);
        return exec.ok
          ? { kind: 'result', text: `已执行：${exec.detail}` }
          : { kind: 'result', text: exec.error };
      }

      case 'manage_adhoc_task': {
        const taskId = Number(args.taskId);
        const task = getDb().prepare('SELECT name FROM adhoc_tasks WHERE id = ?').get(taskId) as any;
        if (!task) return { kind: 'result', text: '任务不存在' };
        if (args.action !== 'update' && args.action !== 'delete') return { kind: 'result', text: 'action 只能是 update 或 delete' };
        const summary =
          args.action === 'delete'
            ? `AI 删除临时任务「${task.name}」`
            : `AI 修改临时任务「${task.name}」${args.points != null ? `，积分改为 ${args.points}` : ''}${args.name ? `，改名为「${args.name}」` : ''}`;
        const gate = writeGate(ctx, moduleName, `task:${taskId}:${args.action}`, 'manage_adhoc_task', { ...args, taskId }, summary);
        if (gate) return gate;
        const exec = execManageAdhocTask({ ...args, taskId });
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'review_task_completion': {
        const completionId = Number(args.completionId);
        const tc = getDb()
          .prepare(
            `SELECT tc.status, t.name as task_name, u.name as child FROM task_completions tc
             JOIN adhoc_tasks t ON t.id = tc.task_id JOIN users u ON u.id = tc.user_id WHERE tc.id = ?`
          )
          .get(completionId) as any;
        if (!tc) return { kind: 'result', text: '找不到这条完成申请' };
        if (tc.status !== 'pending') return { kind: 'result', text: '这条申请已经审核过了' };
        const decision = args.decision === 'reject' ? 'reject' : 'approve';
        if (decision === 'reject' && !String(args.reason ?? '').trim()) return { kind: 'result', text: '拒绝需要写原因' };
        const summary =
          decision === 'approve'
            ? `AI 通过「${tc.task_name}」的完成申请（${tc.child}）`
            : `AI 拒绝「${tc.task_name}」的完成申请（${tc.child}）：${String(args.reason).slice(0, 60)}`;
        const gate = writeGate(ctx, moduleName, `completion:${completionId}`, 'review_task_completion', { ...args, completionId, decision }, summary);
        if (gate) return gate;
        const exec = execReviewTaskCompletion({ ...args, completionId, decision }, ctx.userId);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'manage_point_item': {
        const action = String(args.action ?? '');
        if (!['create', 'update', 'delete', 'toggle'].includes(action)) return { kind: 'result', text: 'action 只能是 create / update / delete / toggle' };
        let itemName = String(args.name ?? '');
        if (action !== 'create') {
          const item = getDb().prepare('SELECT name FROM point_items WHERE id = ?').get(Number(args.itemId)) as any;
          if (!item) return { kind: 'result', text: '积分项不存在' };
          itemName = item.name;
        }
        const verb = action === 'create' ? '新增' : action === 'delete' ? '删除' : action === 'toggle' ? '启停' : '修改';
        const gate = writeGate(ctx, moduleName, `point_item:${args.itemId ?? itemName}:${action}`, 'manage_point_item', args, `AI ${verb}积分项「${itemName}」`);
        if (gate) return gate;
        const exec = execManagePointItem(args);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'manage_product': {
        const action = String(args.action ?? '');
        if (!['create', 'update', 'delete', 'toggle'].includes(action)) return { kind: 'result', text: 'action 只能是 create / update / delete / toggle' };
        let productName = String(args.name ?? '');
        if (action !== 'create') {
          const p = getDb().prepare('SELECT name FROM products WHERE id = ?').get(Number(args.productId)) as any;
          if (!p) return { kind: 'result', text: '商品不存在' };
          productName = p.name;
        }
        const verb = action === 'create' ? '新增' : action === 'delete' ? '删除' : action === 'toggle' ? '上下架' : '修改';
        const gate = writeGate(ctx, moduleName, `product:${args.productId ?? productName}:${action}`, 'manage_product', args, `AI ${verb}商品「${productName}」`);
        if (gate) return gate;
        const exec = execManageProduct(args);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'handle_exchange': {
        const requestId = Number(args.requestId);
        const r = getDb()
          .prepare(
            `SELECT r.status, r.type, r.points, u.name as child FROM exchange_requests r
             JOIN users u ON u.id = r.user_id WHERE r.id = ?`
          )
          .get(requestId) as any;
        if (!r) return { kind: 'result', text: '找不到这条兑换申请' };
        if (r.status !== 'pending') return { kind: 'result', text: '这条兑换申请已经处理过了' };
        const decision = args.decision === 'reject' ? 'reject' : 'approve';
        if (decision === 'reject' && !String(args.reason ?? '').trim()) return { kind: 'result', text: '拒绝需要写原因' };
        const summary =
          decision === 'approve'
            ? `AI 通过 ${r.child} 的兑换申请（扣 ${r.points} 分）`
            : `AI 拒绝 ${r.child} 的兑换申请：${String(args.reason).slice(0, 60)}`;
        const gate = writeGate(ctx, moduleName, `exchange:${requestId}`, 'handle_exchange', { ...args, requestId, decision }, summary);
        if (gate) return gate;
        const exec = execHandleExchange({ ...args, requestId, decision }, ctx.userId);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'create_calendar_event': {
        const payload = { ...args, action: 'create' };
        const when = args.start_time ? `${args.event_date} ${args.start_time}-${args.end_time ?? ''}` : String(args.event_date ?? '');
        const summary = `AI 创建日程「${args.title ?? ''}」（${when}）`;
        const gate = writeGate(ctx, moduleName, 'calendar:create', 'calendar_event', payload, summary);
        if (gate) return gate;
        const exec = execCalendarEvent(payload, ctx.userId);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'manage_calendar_event': {
        const action = String(args.action ?? '');
        if (action !== 'update' && action !== 'delete') return { kind: 'result', text: 'action 只能是 update 或 delete' };
        const eventId = Number(args.eventId);
        const row = getDb().prepare('SELECT title FROM calendar_events WHERE id = ?').get(eventId) as any;
        if (!row) return { kind: 'result', text: '日程不存在' };
        const summary = action === 'delete' ? `AI 删除日程「${row.title}」` : `AI 修改日程「${row.title}」`;
        const gate = writeGate(ctx, moduleName, `calendar:${action}:${eventId}`, 'calendar_event', { ...args, action, eventId }, summary);
        if (gate) return gate;
        const exec = execCalendarEvent({ ...args, action, eventId }, ctx.userId);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'manage_special_day': {
        const action = String(args.action ?? '');
        if (!['create', 'update', 'delete', 'toggle'].includes(action)) {
          return { kind: 'result', text: 'action 只能是 create / update / delete / toggle' };
        }
        let label = String(args.name ?? '');
        if (action !== 'create') {
          const row = getDb().prepare('SELECT name FROM special_days WHERE id = ?').get(Number(args.specialDayId)) as any;
          if (!row) return { kind: 'result', text: '特殊日不存在' };
          label = row.name;
        }
        const verb = action === 'create' ? '新增' : action === 'delete' ? '删除' : action === 'toggle' ? '启停' : '修改';
        const gate = writeGate(ctx, moduleName, `special_day:${args.specialDayId ?? label}:${action}`, 'special_day', args, `AI ${verb}特殊日「${label}」`);
        if (gate) return gate;
        const exec = execSpecialDay(args, ctx.userId);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'create_child': {
        const summary = `AI 新建孩子账号「${args.name ?? ''}」（生日 ${args.birthday ?? ''}）`;
        const gate = writeGate(ctx, moduleName, 'account:child:create', 'create_child', args, summary);
        if (gate) return gate;
        const exec = execCreateChild(args);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'create_parent': {
        const summary = `AI 新建家长账号「${args.name ?? ''}」（${args.identity ?? ''}）`;
        const gate = writeGate(ctx, moduleName, 'account:parent:create', 'create_parent', args, summary);
        if (gate) return gate;
        const exec = execCreateParent(args, ctx.userId);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'add_growth_record': {
        const child = assertChildId(
          args.childId != null ? Number(args.childId) : undefined,
          args.childName != null ? String(args.childName) : undefined
        );
        const date = isDateArg(args.date) ? args.date : todayLocal();
        const values = [
          args.heightCm != null ? `身高 ${args.heightCm}cm` : '',
          args.weightKg != null ? `体重 ${args.weightKg}kg` : '',
        ]
          .filter(Boolean)
          .join('、');
        const summary = `AI 记录 ${child.name} ${date} 的成长数据（${values}）`;
        const gate = writeGate(ctx, moduleName, `growth:${child.id}`, 'add_growth_record', args, summary);
        if (gate) return gate;
        const exec = execAddGrowthRecord(args, ctx.userId);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'add_growth_records': {
        const child = assertChildId(
          args.childId != null ? Number(args.childId) : undefined,
          args.childName != null ? String(args.childName) : undefined
        );
        const list = Array.isArray(args.records) ? args.records : [];
        const dates = list.map((r: any) => String(r?.date ?? '')).filter(isDateArg).sort();
        const span = dates.length ? `（${dates[0]} ~ ${dates[dates.length - 1]}）` : '';
        const summary = `AI 批量记录 ${child.name} 的 ${list.length} 条成长数据${span}`;
        const gate = writeGate(ctx, moduleName, `growth:${child.id}:batch`, 'add_growth_records', args, summary);
        if (gate) return gate;
        const exec = execAddGrowthRecords(args, ctx.userId);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'manage_product_category': {
        const action = String(args.action ?? '');
        if (!['create', 'update', 'delete'].includes(action)) {
          return { kind: 'result', text: 'action 只能是 create / update / delete' };
        }
        let label = String(args.name ?? '');
        if (action !== 'create') {
          const row = getDb().prepare('SELECT name FROM product_categories WHERE id = ?').get(Number(args.categoryId)) as any;
          if (!row) return { kind: 'result', text: '商品分类不存在' };
          label = row.name;
        }
        const verb = action === 'create' ? '新增' : action === 'delete' ? '删除' : '修改';
        const gate = writeGate(
          ctx,
          moduleName,
          `product_category:${args.categoryId ?? label}:${action}`,
          'product_category',
          args,
          `AI ${verb}商品分类「${label}」`
        );
        if (gate) return gate;
        const exec = execManageProductCategory(args);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'set_cash_rate': {
        const summary = `AI 设置现金兑换比例：${args.rate} 积分 = 1 元`;
        const gate = writeGate(ctx, moduleName, 'shop:cash_rate', 'set_cash_rate', args, summary);
        if (gate) return gate;
        const exec = execSetCashRate(args);
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'create_skill': {
        const folder = String(args.folder ?? '').trim();
        const summary = `AI ${listSkills().skills.some((s) => s.folder === folder) ? '更新' : '创建'}技能「${args.name ?? folder}」并写入技能目录`;
        const verdict = ctx.bypassJudge ? ({ verdict: 'allow' } as SentinelVerdict) : judge({
          taskId: ctx.taskId,
          ownerUserId: ctx.userId,
          actionKey: 'skill_create',
          kind: 'skill_create',
          payload: { folder, name: args.name, description: args.description, instructions: args.instructions, enabled: args.enabled !== false },
          summary,
          moduleName,
          actor: ctx.actor,
        });
        if (verdict.verdict === 'deny') return { kind: 'result', text: verdict.reason };
        if (verdict.verdict === 'ask') {
          return { kind: 'confirm', token: verdict.token, summary: verdict.summary, detail: verdict.detail };
        }
        const exec: ExecResult = execSkillCreate({ folder, name: args.name, description: args.description, instructions: args.instructions, enabled: args.enabled !== false });
        return exec.ok ? { kind: 'result', text: `已执行：${exec.detail}` } : { kind: 'result', text: exec.error };
      }

      case 'run_skill': {
        const skillName = String(args.skill ?? '').trim();
        const all = listSkills();
        const skill = all.skills.find((s) => s.folder === skillName || s.name === skillName);
        if (!skill) {
          return { kind: 'result', text: `找不到技能「${skillName}」。可用技能：${all.skills.map((s) => s.folder).join('、') || '（无）'}` };
        }
        if (!skill.flow || !skill.flow.steps.length) {
          return { kind: 'result', text: `技能「${skill.name}」没有配置 flow.yaml 流程；它的使用说明已在对话中生效。` };
        }
        const steps = skill.flow.steps.map((s) => ({ tool: s.tool, argsJson: JSON.stringify(s.args ?? {}) }));
        const summary = `AI 执行技能流程「${skill.name}」（${steps.length} 步：${steps.map((s) => s.tool).join(' → ')}）${args.input ? `，目标：${args.input}` : ''}`;
        const verdict = ctx.bypassJudge ? ({ verdict: 'allow' } as SentinelVerdict) : judge({
          taskId: ctx.taskId,
          ownerUserId: ctx.userId,
          actionKey: `flow:${skill.folder}`,
          kind: 'skill_flow',
          payload: { flowName: skill.name, folder: skill.folder, steps, startIndex: 0, taskId: ctx.taskId },
          summary,
          moduleName,
          actor: ctx.actor,
        });
        if (verdict.verdict === 'deny') return { kind: 'result', text: verdict.reason };
        if (verdict.verdict === 'ask') {
          return { kind: 'confirm', token: verdict.token, summary: verdict.summary, detail: verdict.detail };
        }
        // 策略放行：逐步执行（流程内写步骤已整体放行）
        const exec: ExecResult = execSkillFlow({ flowName: skill.name, folder: skill.folder, steps, startIndex: 0, taskId: ctx.taskId }, ctx.actor);
        return exec.ok ? { kind: 'result', text: exec.detail } : { kind: 'result', text: exec.error };
      }

      default:
        return { kind: 'result', text: `未知工具 ${name}` };
    }
  } catch (e) {
    return { kind: 'result', text: `工具执行出错：${(e as Error)?.message ?? e}` };
  }
}

/* ── 确认派发（家长在确认卡上作出三选决定后） ──────────────────────────── */

export async function confirmAction(
  token: string,
  userId: number,
  choice: PendingChoice,
  actorName: string
): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const action = resolvePending(token, userId, choice);
  if (!action) return { ok: false, error: '确认单不存在或已过期' };
  const actor: ActorInfo = { userId, role: 'parent', name: actorName };

  if (choice === 'deny') {
    auditConfirm(actor, action, choice, '');
    return { ok: true, detail: '已拒绝该操作' };
  }

  // 允许执行：按动作类型派发
  let result: ExecResult;
  if (action.kind === 'mcp_call') {
    const { server, toolName, argsJson } = action.payload as { server: string; toolName: string; argsJson: string };
    const entry = getAiMcp()[server];
    if (!entry) {
      auditConfirm(actor, action, choice, 'MCP 服务器已不存在');
      return { ok: false, error: `MCP 服务器「${server}」已不存在` };
    }
    const outcome = await callMcpTool(server, entry, toolName, argsJson);
    result = outcome.ok ? { ok: true, detail: outcome.text } : { ok: false, error: outcome.error };
  } else {
const actorInfo = { ...actor };
    let exec: ExecResult;
    switch (action.kind) {
      case 'add_point_records':
        exec = execAddPointRecords(action.payload, userId);
        break;
      case 'create_tasks':
        exec = execCreateTasks(action.payload, userId);
        break;
      case 'skill_create':
        exec = execSkillCreate(action.payload);
        break;
      case 'skill_flow':
        exec = execSkillFlow({ ...(action.payload as any), taskId: 'confirmed' }, actorInfo);
        break;
      case 'manage_adhoc_task':
        exec = execManageAdhocTask(action.payload);
        break;
      case 'review_task_completion':
        exec = execReviewTaskCompletion(action.payload, userId);
        break;
      case 'manage_point_item':
        exec = execManagePointItem(action.payload);
        break;
      case 'manage_product':
        exec = execManageProduct(action.payload);
        break;
      case 'handle_exchange':
        exec = execHandleExchange(action.payload, userId);
        break;
      case 'calendar_event':
        exec = execCalendarEvent(action.payload, userId);
        break;
      case 'special_day':
        exec = execSpecialDay(action.payload, userId);
        break;
      case 'create_child':
        exec = execCreateChild(action.payload);
        break;
      case 'create_parent':
        exec = execCreateParent(action.payload, userId);
        break;
      case 'add_growth_record':
        exec = execAddGrowthRecord(action.payload, userId);
        break;
      case 'add_growth_records':
        exec = execAddGrowthRecords(action.payload, userId);
        break;
      case 'product_category':
        exec = execManageProductCategory(action.payload);
        break;
      case 'set_cash_rate':
        exec = execSetCashRate(action.payload);
        break;
      default:
        exec = { ok: false, error: '未知的动作类型' };
    }
    result = exec;
  }

  auditConfirm(actor, action, choice, result.ok ? result.detail : result.error);
  return result.ok ? { ok: true, detail: result.detail } : { ok: false, error: result.error };
}

export function rejectAction(token: string, userId: number): boolean {
  const action = resolvePending(token, userId, 'deny');
  return Boolean(action);
}

/** MCP 工具调用过 Sentinel：entry 的 confirm 策略决定要不要走全局判定 */
export async function executeMcp(
  server: string,
  entry: { title?: string; confirm?: 'writes' | 'all' | 'none' },
  toolName: string,
  argsJson: string,
  ctx: ToolCtx
): Promise<ToolOutcome> {
  const moduleName = `MCP:${server}`;
  // none = 家长明确说这服务器不用问：直接执行（仍写审计）
  if (entry.confirm !== 'none') {
    const writeLike = !/^(get|list|search|query|read|fetch|find|describe|lookup|history|count)/i.test(toolName);
    if (entry.confirm === 'all' || writeLike) {
      let argsPreview = '';
      try {
        argsPreview = JSON.stringify(argsJson ? JSON.parse(argsJson) : {});
      } catch {
        argsPreview = argsJson ?? '';
      }
      if (argsPreview.length > 300) argsPreview = argsPreview.slice(0, 300) + '…';
      const summary = `调用 MCP「${entry.title || server}」的 ${toolName} 工具，参数：${argsPreview || '（无）'}`;
      const verdict = judge({
        taskId: ctx.taskId,
        ownerUserId: ctx.userId,
        risk: 'high',
        actionKey: `mcp:${server}:${toolName}`,
        kind: 'mcp_call',
        payload: { server, toolName, argsJson },
        summary,
        moduleName,
        actor: ctx.actor,
      });
      if (verdict.verdict === 'deny') return { kind: 'result', text: verdict.reason };
      if (verdict.verdict === 'ask') {
        return { kind: 'confirm', token: verdict.token, summary: verdict.summary, detail: verdict.detail };
      }
    }
  }
  const outcome = await callMcpTool(server, entry as any, toolName, argsJson);
  if (outcome.ok) {
    auditExec(ctx.actor, moduleName, `执行 ${toolName}`, outcome.text.slice(0, 200));
    return { kind: 'result', text: outcome.text };
  }
  return { kind: 'result', text: `MCP 工具调用失败：${outcome.error}` };
}

/** 工具名清单，agent 侧判断内置/外部用 */
export const builtinToolNames = new Set(builtinToolSpecs.map((t) => t.name));
