---
name: 预设·家庭概览
description: 系统预设：快速摸清家庭现状（孩子、余额、待办审核）
enabled: true
---

这是系统预设技能，始终启用。家长问「家里现在什么情况」「有什么要我处理的」时：

1. `list_children` 拿全部孩子与当前积分；
2. `get_point_summary` 看最近流水（默认 7 天，可指定 childId / days）；
3. `list_pending_reviews` 汇总待审核的任务完成申请与兑换申请；
4. `get_backpack` 看某个孩子背包里未使用的道具。
5. 用简短清单回答，先给结论再给细节；数据都是实时的，不需要记忆。涉及下一步操作时，建议用对应工具（如 `review_task_completion`、`handle_exchange`），并说明会弹确认卡。