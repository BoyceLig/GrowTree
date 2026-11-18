---
name: 预设·商城与兑换
description: 系统预设：查看/维护商品，审核孩子的兑换申请
enabled: true
---

这是系统预设技能，始终启用。涉及商城时遵循：

1. 看商城：`list_shop` 查在售商品、价格、库存、分类与规格。
2. 商品维护：`manage_product` 支持 create / update / delete / toggle（上架、下架），字段包含名称、所需积分、库存（-1 不限）、分类、单次限兑、限兑周期。
3. 审核兑换：`list_pending_reviews` 查待审的兑换申请，`handle_exchange` 通过或拒绝；通过时才扣积分与库存，积分不够要如实说明，拒绝要写原因。
4. 实物/道具区分：kind=goods 走兑换审核，kind=prop 兑换后进背包；背包用 `get_backpack` 查。
5. 所有写操作都要走确认卡；价格、库存这类数据必须用工具实时查，不要用记忆里的旧数字。