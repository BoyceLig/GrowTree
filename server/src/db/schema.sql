-- Money Jar 数据库 Schema v1.0
-- 单家庭模式，无 family_id 租户隔离

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 用户表（家长 + 小孩）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('parent', 'child')),
  pin TEXT,                          -- 小孩登录PIN（4-6位数字），家长账号为NULL
  password_hash TEXT,                 -- 家长密码哈希，小孩为NULL
  avatar TEXT,                        -- 生肖key，如 "rat"；家长也可是 /uploads/xxx 自定义头像
  -- 家长资料（2026-11-12 多家长账号）：孩子账号这三列为 NULL / 0
  nickname TEXT,                      -- 家长昵称，用于界面展示
  parent_identity TEXT,               -- 家长身份：妈妈/爸爸/奶奶… 或用户自定义（不限枚举）
  is_primary INTEGER NOT NULL DEFAULT 0,  -- 1=主家长（唯一），只有主家长能管理家长账号
  birthday TEXT,                      -- 出生日期 YYYY-MM-DD，生长曲线需按年龄查标准
  sex TEXT CHECK (sex IN ('male', 'female')),  -- 性别，生长标准男女不同；NULL=未填写
  -- 成长日记对该孩子的可见开关（家长按孩子单独控制）：1=孩子能看到，0=只有家长能看
  -- 默认 1（老库升级后行为不变，家长主动关掉才生效）
  diary_visible INTEGER NOT NULL DEFAULT 1,
  -- 家长端「隐藏」这个孩子（1=隐藏）：家长端各页面不再显示他/她的数据，
  -- 只有「我的 → 孩子」管理里还留着并标「已隐藏」。可逆，和删除是两件事。
  hidden INTEGER NOT NULL DEFAULT 0,
  total_points INTEGER NOT NULL DEFAULT 0,
  -- 皮肤（2026-10-20）：家长和孩子各自可以换「森林绿 / 冰川蓝 / 蜜桃粉」。
  -- NULL = 跟随默认（家长绿、孩子按性别粉/蓝），这样老账号升级后观感完全不变。
  -- 只管颜色，不影响任何业务判断，所以放在 users 上而不是单独的偏好表。
  skin TEXT CHECK (skin IN ('peach', 'ice', 'forest')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (
    (role = 'parent' AND password_hash IS NOT NULL) OR
    (role = 'child' AND pin IS NOT NULL)
  )
);

-- 日常任务（家长一键加减分项，可配置每日上限）
CREATE TABLE IF NOT EXISTS point_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('gain', 'loss')),
  points INTEGER NOT NULL,            -- 加分项为正数，扣分项为负数
  daily_limit INTEGER NOT NULL DEFAULT 1,  -- 每日上限次数，0表示无限
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER,                   -- NULL=通用项，否则为指定小孩专属项
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 日常任务完成记录（频次控制）
CREATE TABLE IF NOT EXISTS daily_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES point_items(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                 -- 格式 YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, item_id, date)
);

-- 临时任务（新版：一个任务对应一个小孩）
CREATE TABLE IF NOT EXISTS adhoc_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,                      -- 学习/生活/运动/其他
  points INTEGER NOT NULL,            -- 完成奖励积分
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired')),
  deadline INTEGER,                   -- unix时间戳秒，NULL表示无截止
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 指定小孩
  created_by INTEGER NOT NULL REFERENCES users(id),
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 任务完成申请（小孩提交，家长审核）
CREATE TABLE IF NOT EXISTS task_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES adhoc_tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reason TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_task_completions_task ON task_completions(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_completions_status ON task_completions(status, created_at DESC);

-- 积分流水（统一记录所有积分变动）
CREATE TABLE IF NOT EXISTS point_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,             -- 正负
  -- contribution = 家庭贡献值（晒娃时刻）：每天完成≥1项任务 +每日分、连续7天再 +连续奖励
  source TEXT NOT NULL CHECK (source IN ('daily', 'adhoc', 'exchange', 'adjust', 'contribution')),
  ref_id INTEGER,                     -- 关联任务/商品/兑换申请ID
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  -- 分数归属的「自然日」（YYYY-MM-DD，服务端本地时区）。一般流水为 NULL：
  -- 家长可能隔天审核，家庭贡献值必须记在孩子**做任务**的那天，而不是审核那天。
  biz_date TEXT
);

CREATE INDEX IF NOT EXISTS idx_point_logs_user ON point_logs(user_id, created_at DESC);
-- 贡献值索引（user_id, source, biz_date）在 db/index.ts 的 migratePointLogs 里建：
-- 老库跑 schema.sql 时 point_logs 还没有 biz_date 列，在这里建会直接炸。

-- 商品分类（家长可创建 / 改名 / 换图标；商城页按分类筛选）
-- icon 兼容两种值：内置图标 key（snack/toy/activity/game/study/privilege/food/gift），
-- 或自定义上传图片的站内路径 /uploads/xxx.png
CREATE TABLE IF NOT EXISTS product_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'gift',
  color TEXT NOT NULL DEFAULT '#e8b4c8',  -- 图标底色（圆形渐晕），#RRGGBB
  sort_order INTEGER NOT NULL DEFAULT 0,  -- 商城页筛选条里的排列顺序
  hidden INTEGER NOT NULL DEFAULT 0,      -- 1 = 不在孩子端商城筛选条出现（「许愿单」分类）
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 商品
-- icon 只存「自定义商品图片」：空串 = 没有单独上传，展示时回落到所属分类的图标
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cost INTEGER NOT NULL,              -- 所需积分
  stock INTEGER NOT NULL DEFAULT -1, -- -1表示不限库存
  icon TEXT NOT NULL DEFAULT '',      -- 自定义商品图片 /uploads/xxx.png；'' = 用分类图标
  category_id INTEGER REFERENCES product_categories(id) ON DELETE SET NULL,
  limit_days INTEGER NOT NULL DEFAULT 0,   -- 限兑周期天数，0 = 不限
  limit_count INTEGER NOT NULL DEFAULT 0,  -- 周期内最多兑换次数，0 = 不限
  max_per_exchange INTEGER NOT NULL DEFAULT 1,  -- 单次最多兑换件数
  -- 许愿单：这个商品是否允许孩子加入心愿（0/1）；加入后需要的打卡天数与是否连续
  wish_enabled INTEGER NOT NULL DEFAULT 0,
  wish_days INTEGER NOT NULL DEFAULT 7,
  wish_consecutive INTEGER NOT NULL DEFAULT 0,
  -- 考核标准：0 = 当天的任务要全部完成；>0 = 当天至少完成 N 项就算打卡成功
  wish_daily_count INTEGER NOT NULL DEFAULT 0,
  -- 1 = 只属于许愿单商品（家长完善心愿时选择「不加入商城」，或商品直接归入「许愿单」分类），
  -- 孩子端商城不展示
  wish_only INTEGER NOT NULL DEFAULT 0,
  -- 商品类型（2026-11-13）：goods = 普通礼物，走兑换申请 + 家长审核；
  -- prop = 道具（如打折券、免作业券），孩子兑换后直接进背包，可随时使用
  kind TEXT NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods', 'prop')),
  prop_desc TEXT NOT NULL DEFAULT '',  -- 道具使用说明，仅 kind='prop' 有意义
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- 注意：products(category_id) 的索引不在这里建 —— 老库的 products 表已存在，
-- CREATE TABLE IF NOT EXISTS 不会补列，此时建索引会因为缺列直接报错中断整个 schema。
-- 统一放到 db/index.ts 的 migrateProductCategories() 里，加完列之后再建。

-- 兑换申请（商品兑换 + 现金兑换共用表）
CREATE TABLE IF NOT EXISTS exchange_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('product', 'cash')),
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  variant_id INTEGER,                 -- 商品规格（SKU）ID；无规格商品为 NULL
  variant_name TEXT,                  -- 下单时的规格名快照（规格删了也能显示）
  points INTEGER NOT NULL,            -- 消耗积分（cash类型存兑换积分数；product类型 = 单价×数量）
  amount REAL NOT NULL DEFAULT 0,     -- 现金兑换时 = points / 10
  quantity INTEGER NOT NULL DEFAULT 1, -- 商品兑换件数
  wish_id INTEGER,                     -- 许愿单兑换：来源心愿 id（NULL = 普通兑换）
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reason TEXT,                         -- 拒绝原因
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 商品规格（SKU）：一个商品可以有多档规格，各自独立的价格与库存
-- 有规格的商品兑换时必须选规格；无规格商品仍走 products.cost / products.stock
CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                 -- 规格名，如「小杯」「大杯」「红色」
  cost INTEGER NOT NULL,              -- 该规格所需积分
  stock INTEGER NOT NULL DEFAULT -1,  -- -1 表示不限库存
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_exchange_requests_status ON exchange_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchange_requests_user ON exchange_requests(user_id, created_at DESC);

-- 背包（2026-11-13）：孩子兑换道具后直接存入这里，可以随时「使用」。
-- 道具属于孩子本人，家长端只读查看。商品名/图标/说明在下单时快照一份，
-- 之后家长改商品或删除商品都不会影响背包里的东西。
--   status = unused 未使用；used 已使用（保留历史，不删除）
-- 2026-11-14：拿走不再删除行，改用 taken_at 标记，保留被拿走物品与理由；
--   source 区分来源（exchange 孩子兑换 / gift 家长赠送）。
--   status 的 CHECK 保持不变（老库无法改 CHECK），拿走状态用 taken_at 表达。
CREATE TABLE IF NOT EXISTS backpack_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,                 -- 兑换时的道具名快照
  icon TEXT NOT NULL DEFAULT '',      -- 兑换时的展示图标快照（自定义图片路径或分类图标 key）
  description TEXT NOT NULL DEFAULT '', -- 兑换时的使用说明快照
  cost INTEGER NOT NULL DEFAULT 0,    -- 兑换时消耗的积分（0 = 免费）
  status TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'used')),
  acquired_at INTEGER NOT NULL DEFAULT (unixepoch()),
  used_at INTEGER,
  use_note TEXT,                      -- 使用时的备注（可空）
  source TEXT NOT NULL DEFAULT 'exchange', -- exchange = 孩子自己兑换；gift = 家长赠送
  taken_at INTEGER,                   -- 非 NULL = 已被家长拿走（行保留，不再 DELETE）
  take_reason TEXT,                   -- 拿走理由快照
  take_refund INTEGER NOT NULL DEFAULT 0 -- 拿走时返还给孩子的积分
);

CREATE INDEX IF NOT EXISTS idx_backpack_items_child ON backpack_items(child_id, status, acquired_at DESC);

-- 背包操作记录（2026-11-14）：家长端背包弹窗的历史记录，按孩子倒序。
--   action = gift 家长赠送 / exchange 孩子兑换入包 / use 孩子使用 / take 家长拿走
--   物品名/图标快照，不随 backpack_items 变化；建表前的历史操作没有记录。
CREATE TABLE IF NOT EXISTS backpack_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('gift', 'exchange', 'use', 'take')),
  item_name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  detail TEXT NOT NULL DEFAULT '',    -- 赠送理由 / 拿走理由 / 使用备注
  refund_points INTEGER NOT NULL DEFAULT 0, -- take 时返还的积分
  actor_role TEXT NOT NULL DEFAULT 'parent', -- parent / child
  actor_label TEXT NOT NULL DEFAULT '',      -- 操作人展示名（如「爸爸」）
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_backpack_logs_child ON backpack_logs(child_id, created_at DESC);

-- 成长记录（身高体重）
-- 同一天同一孩子只保留一条：重复录入按更新处理，避免"随时想量就量"产生脏数据
CREATE TABLE IF NOT EXISTS growth_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_date TEXT NOT NULL,          -- 格式 YYYY-MM-DD
  height_cm REAL,                     -- 身高 cm
  weight_kg REAL,                     -- 体重 kg
  grow_cm REAL,                       -- 相对上一条有效身高长高多少；可为负（测量误差/缩水）
  awarded INTEGER,                    -- 本次核算出的积分增减，可为负；null = 该记录未参与计分
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (user_id, record_date)
);

CREATE INDEX IF NOT EXISTS idx_growth_records_user_date ON growth_records(user_id, record_date);

-- 成长日记（家长像写日记一样记录孩子的成长过程，可带图片/视频）
-- 和 growth_records 的区别：增长曲线记的是「量出来的数」，日记记的是「发生的事」，
-- 所以是一张独立的表，允许同一天写多篇（不像 growth_records 有 UNIQUE(user_id, record_date)）。
CREATE TABLE IF NOT EXISTS growth_diaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  diary_date TEXT NOT NULL,           -- 发生日期 YYYY-MM-DD（由家长手填，可与创建时间不同）
  title TEXT,                         -- 标题，可空
  content TEXT,                       -- 正文，可空（允许只发一张照片）
  media TEXT,                         -- 附件 JSON 数组：[{"type":"image"|"video","url":"/uploads/xxx"}]
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),  -- 最后一个编辑人（用于卡片署名「创建者、编辑者」）
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_growth_diaries_user_date ON growth_diaries(user_id, diary_date DESC, id DESC);

-- 树洞信箱（孩子与家长互相留言）
-- child_id 是「这条对话属于谁」而不是「谁发的」——家长有多个孩子时，
-- 一对一的私密对话才能分开存放；sender_role 冗余存一份，方便两端渲染气泡方向。
-- parent_id 是「这条对话的对面那个家长」（2026-10-20）：
--   孩子可以说「这句话我只跟妈妈说」；NULL = 发给全家的旧消息（本字段上线前的历史，
--   以及孩子在「名额到期」页发的那句求助）—— 每位家长都能看到。
CREATE TABLE IF NOT EXISTS mailbox_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('parent', 'child')),
  content TEXT NOT NULL,
  read_by_child INTEGER NOT NULL DEFAULT 0,   -- 孩子是否已读（家长发的消息）
  read_by_parent INTEGER NOT NULL DEFAULT 0,  -- 家长是否已读（孩子发的消息）
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_child ON mailbox_messages(child_id, id DESC);
-- ⚠️ parent_id 的索引**不能**写在这里：老库执行 schema.sql 时还是旧表（没有这一列），
--    CREATE INDEX 会当场报 "no such column"，整个启动就挂了。
--    它由 db/index.ts 的 runMigrations 在补完列之后建（那里 ALTER 与索引同一个代码块）。

-- 悄悄话（家长 ↔ 孩子 的一对一私密会话）
-- 每个 (child_id, parent_id) 是一条独立会话：只有这位家长和这个孩子能看到，
-- 家里其他家长既看不到列表也读不到消息。
CREATE TABLE IF NOT EXISTS whisper_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('parent', 'child')),
  content TEXT NOT NULL,
  read_by_child INTEGER NOT NULL DEFAULT 0,   -- 孩子是否已读（家长发的悄悄话）
  read_by_parent INTEGER NOT NULL DEFAULT 0,  -- 这位家长是否已读（孩子发的悄悄话）
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_whisper_messages_thread
  ON whisper_messages(child_id, parent_id, id DESC);

-- 周期性任务（家长创建，孩子自己领取，家长审核）
-- 频率：daily=每天；weekly=每周选定星期几（可多天，每「天」为一期）；monthly=每月第 N 天
CREATE TABLE IF NOT EXISTS recurring_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  points INTEGER NOT NULL,            -- 完成奖励积分
  freq_type TEXT NOT NULL CHECK (freq_type IN ('daily', 'weekly', 'monthly')),
  once_only INTEGER NOT NULL DEFAULT 0, -- 1 = 单次任务（发布时不选重复频率）：一生只有一期，做完不再出现；
                                        -- 此时 freq_type 只是占位（沿用 'daily'），语义一律以 once_only 为准
  -- 1 = 每周多天只完成一次（2026-10-24）：选中的星期几合起来算一期，
  -- 孩子任选一天做完即算、一周只领一次。默认 0 = 每天各自一期（老行为）。
  weekly_once INTEGER NOT NULL DEFAULT 0,
  weekdays TEXT,                      -- weekly 专用：星期几 JSON 数组如 [1,3,5]（1=周一…7=周日）；其余为 NULL
  month_day INTEGER,                  -- monthly 专用：每月 1-28 号；其余为 NULL
  due_time TEXT,                      -- 期内最后完成时间 HH:MM；NULL = 当天 23:59
  child_ids TEXT,                     -- 指定小孩 ID JSON 数组如 [2,3]；NULL = 所有小孩
  valid_from TEXT,                    -- 生效起始日期 YYYY-MM-DD；NULL = 立即生效
  valid_to TEXT,                      -- 生效结束日期 YYYY-MM-DD；NULL = 长期有效
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 周期任务领取记录（孩子领取某一「期」，提交完成后由家长审核）
-- period_key：daily/weekly 为期次日期 YYYY-MM-DD；monthly 为 YYYY-MM
CREATE TABLE IF NOT EXISTS recurring_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES recurring_tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  due_at INTEGER,                     -- 本期最后完成时间 unix 秒
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'pending', 'approved', 'rejected')),
  claimed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  submitted_at INTEGER,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at INTEGER,
  reason TEXT,                        -- 拒绝原因
  -- 计时（孩子端「已领取」卡片上的计时按钮；家长端也能看到每条记录用了多久）
  -- 有效时长 = timer_accum_ms + (正在计时 ? now - timer_started_at : 0)
  timer_accum_ms INTEGER NOT NULL DEFAULT 0,   -- 已累计的有效计时毫秒（暂停时结算进去）
  timer_started_at INTEGER,                    -- 当前这段计时的开始 unix 秒；NULL = 没在计时
  timer_paused_ms INTEGER NOT NULL DEFAULT 0,  -- 已累计的暂停毫秒
  timer_paused_at INTEGER,                     -- 当前这段暂停的开始 unix 秒；NULL = 没在暂停
  timer_total_ms INTEGER,                      -- 定稿总用时（停止/提交时写入）；NULL = 还没结束
  UNIQUE (task_id, user_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_recurring_claims_status ON recurring_claims(status, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_recurring_claims_user ON recurring_claims(user_id, claimed_at DESC);

-- 孩子端「我的任务」自定义排序：每个孩子自己拖出来的顺序，互不影响。
-- 没排过的任务自然排在已排过的后面（按创建时间），所以不需要每个任务都有行。
CREATE TABLE IF NOT EXISTS child_task_orders (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES recurring_tasks(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_child_task_orders_user ON child_task_orders(user_id, sort_order);

-- 许愿单：孩子「许下心愿」→ 家长完善（商品 + 打卡任务）→ 孩子打卡 → 领取礼物
-- status 流转：
--   pending   孩子刚许愿，等家长完善（此时还没有任务）
--   active    家长已提交，任务开始，孩子按天打卡
--   completed 打卡天数够了，等孩子点「领取礼物」
--   claimed   已领取，兑换记录里有一条 wish_id 指向这里的商品兑换申请
--   cancelled 孩子/家长撤销
CREATE TABLE IF NOT EXISTS wish_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 心愿商品：来自商城（product_id 直接有值）或孩子自己写（家长完善时才建商品）
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  photo TEXT NOT NULL DEFAULT '',        -- 孩子上传的展示图 /uploads/...；'' = 礼物图标
  -- 旧实现遗留：早期版本会为每个许愿生成一个专属打卡任务，这里记它的 id。
  -- 现在考核的是「每天把所有可领取任务做完」（全勤），不再建任务，这一列不再写入。
  task_id INTEGER REFERENCES recurring_tasks(id) ON DELETE SET NULL,
  days_required INTEGER NOT NULL DEFAULT 7,
  require_consecutive INTEGER NOT NULL DEFAULT 0,
  -- 每天的考核标准：mode='all' 当天必做的任务全部完成才算成功；
  --              mode='count' 当天至少完成 daily_count 项就算成功
  mode TEXT NOT NULL DEFAULT 'all' CHECK (mode IN ('all', 'count')),
  daily_count INTEGER NOT NULL DEFAULT 0,
  -- pending 等家长完善 → confirming 家长已通过申请、等孩子确认 → active 进行中
  -- → completed 达标待领取 → claimed 已领取；cancelled 撤销
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirming', 'active', 'completed', 'claimed', 'cancelled')),
  exchange_id INTEGER,                  -- 领取时产生的兑换申请 id
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  activated_at INTEGER,
  claimed_at INTEGER,
  -- 规则变更日（unix 秒）：家长在商城改了商品的许愿考核标准时传导过来，
  -- 进度起算日 = max(activated_at, rule_changed_at) → 修改前的天数不追溯
  rule_changed_at INTEGER,
  -- 规则变更时已挣到的天数：改规则那天用旧规则算出 done/streak 冻结在这里，
  -- 之后的进度 = carried_days + 从变更日起按新规则算出的天数（已完成的天不归零）
  carried_days INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wish_items_child ON wish_items(child_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wish_items_status ON wish_items(status, created_at DESC);

-- 心愿单（2026-11-13）：孩子自由填写「想要什么 / 为什么 / 预计积分（选填）」，
-- 家长端由**一位**家长抢单审核，补充商品信息后直接上架商城。
--   同一时刻 status='reviewing' 只允许一个 reviewer_id；家长放弃/超时（10 分钟）
--   自动回到 pending，其他家长才能接手。
--   审核完成后 pending 队列不再显示，只保留在历史记录里（reviewer + reviewed_at + 上架内容）。
CREATE TABLE IF NOT EXISTS wish_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,                 -- 孩子写的：想要什么
  reason TEXT NOT NULL,                -- 孩子写的：为什么想要
  estimated_points INTEGER,            -- 孩子预估要扣多少积分；NULL = 选填未填
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewing', 'approved', 'rejected', 'cancelled')),
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  review_started_at INTEGER,           -- 抢单时间（超过 10 分钟视为放弃，别人可接手）
  reviewed_at INTEGER,                 -- 审核完成时间
  review_note TEXT,                    -- 家长留言 / 驳回原因
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  -- 审核结果快照（JSON）：商品名/积分/库存/分类名。商品之后被改/删，历史也还完整
  review_payload TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_wish_requests_status ON wish_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wish_requests_child ON wish_requests(child_id, created_at DESC);

-- 全局设置（键值对）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 日程（2026-11-14，2026-11-16 改版）：飞书式按参与人组织，任何成员可建，参与人是身份不是归属。
--   visibility = public 公开（所有人可见）/ private 私有（家长都可见；孩子只看到「私有日程」占位与时间）
--   跨天：event_date 为开始日期，end_date 为结束日期（不填=同一天；全天/时段均可跨天）。
--   私有规则见 docs/日历与特殊日功能方案.md §4.1：
--     创建者与参与的孩子看完整；其他孩子只看到占位卡（无标题/参与人/备注，保留时间）。
CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,           -- 开始日期 YYYY-MM-DD（本地时区）
  end_date TEXT,                      -- 结束日期 YYYY-MM-DD；NULL = 与 event_date 同一天
  is_all_day INTEGER NOT NULL DEFAULT 1,
  start_time TEXT,                    -- 'HH:MM'，全天为 NULL
  end_time TEXT,
  note TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS calendar_event_participants (
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(event_date);
CREATE INDEX IF NOT EXISTS idx_calendar_events_end ON calendar_events(end_date);

-- 特殊日（2026-11-14）：家长专属，重复规则 + 当天积分效果（获得倍率/消耗倍率）。
--   rule_type = once 单天 / weekly 每周几 / monthly 每月几号 / yearly 每年几月几号
--   weekdays 1=周一…7=周日；month_days 1-31（小月自动跳过）；yearly_md 'MM-DD'
--   effect_kind = earn 获得（倍率>1）/ spend 消耗（倍率<1）；NULL = 纯纪念日无积分效果
CREATE TABLE IF NOT EXISTS special_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🎉',
  rule_type TEXT NOT NULL CHECK (rule_type IN ('once', 'weekly', 'monthly', 'yearly')),
  once_date TEXT,
  weekdays TEXT,
  month_days TEXT,
  yearly_md TEXT,
  range_start TEXT,
  range_end TEXT,
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'custom')),
  effect_kind TEXT CHECK (effect_kind IN ('earn', 'spend')),
  effect_value REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS special_day_targets (
  special_day_id INTEGER NOT NULL REFERENCES special_days(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (special_day_id, user_id)
);

-- ============================================================================
-- AI 助手（2026-11-17）：家长端 AI 对话
--
-- 会话与消息都挂在家长账号下（user_id = 发起对话的家长），孩子端不出现在 AI 里。
-- ai_messages.role 三种：user / assistant / tool。
--   tool 行存的是 agent 工具循环里「工具结果」（meta.tool_call_id 对应上一条
--   assistant 的 tool_calls），重放历史时按 OpenAI 协议拼回 messages 数组。
-- attachments / meta 都是 JSON 字符串，读出来 JSON.parse 即可。
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT,                    -- JSON 数组 [{kind:'image'|'file', url, name, mime, size, extracted?}]
  meta TEXT,                           -- JSON：assistant 存 tool_calls；tool 存 tool_call_id/tool_name/确认信息
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_user ON ai_sessions(user_id, updated_at DESC);

-- 消息排队（2026-11-18）：回合进行中家长再发的消息先存这里，按 sort_order 依次自动执行；
-- 「引导」会把某条消息立刻补进当前回合并从队列删除。放数据库里，切页面/刷新都不会丢。
CREATE TABLE IF NOT EXISTS ai_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT,                    -- JSON 数组，结构同 ai_messages.attachments
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ai_queue_session ON ai_queue(session_id, sort_order, id);

-- ============================================================================
-- 上传文件元数据（2026-11-18）
--
-- 磁盘上的文件名是随机生成的唯一 ID（`<时间戳base36>-<随机hex>.<扩展名>`），
-- 用户上传时看到的原始文件名（可能是中文、可能和别的家庭重名）只存在这张表里。
-- 下载走 /api/uploads/:name/download，由服务端把 original_name 写进
-- Content-Disposition，用户拿到的就是自己上传时那个名字。
--
-- 同一份内容按哈希去重后，多个业务记录会指向同一个 name（物理文件只有一份），
-- 因此这里的 original_name 只是「最先上传时的名字」的兜底；
-- 节点自身（日记 HTML 的 data-name）保留各自的原始名，下载时优先用它。
-- kind: image / video / file（AI 附件里的文档）
-- ============================================================================
CREATE TABLE IF NOT EXISTS upload_files (
  name TEXT PRIMARY KEY,              -- 磁盘文件名（含扩展名），即 URL /uploads/<name>
  original_name TEXT NOT NULL,        -- 上传时的原始文件名
  mime TEXT,
  size INTEGER,
  kind TEXT,                          -- image | video | file
  width INTEGER,                      -- 图片/视频像素宽（可空）
  height INTEGER,
  duration REAL,                      -- 视频时长（秒，可空）
  user_id INTEGER,                    -- 上传者（家长），不做外键：删号后文件仍可能被日记引用
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_upload_files_created ON upload_files(created_at DESC);
