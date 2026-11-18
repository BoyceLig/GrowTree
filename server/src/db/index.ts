import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

let db: Database.Database;

/**
 * 数据访问装饰器（可选扩展点）。
 *
 * 装上去之后，业务代码通过 getDb() 拿到的是装饰过的句柄（扩展可以在 prepare
 * 这一层做审计、按请求上下文过滤等）；迁移、引导数据这类「还没有上下文」的代码
 * 继续用 getRawDb() 拿原生句柄。
 *
 * 默认不装：此时 getDb() 与 getRawDb() 返回同一个原生句柄，行为与没有这个功能时完全一致。
 */
let decorateDb: ((raw: Database.Database) => Database.Database) | null = null;
let decoratedDb: Database.Database | null = null;

/** 是否跳过引导数据写入。默认不跳过；自建版行为不变。 */
function skipBootstrap(): boolean {
  return process.env.PIGGY_SKIP_BOOTSTRAP === '1';
}

function findSchemaPath(): string {
  // 优先从源码目录加载（开发模式），其次从编译产物旁边（生产Docker模式）
  const candidates = [
    join(process.cwd(), 'server', 'src', 'db', 'schema.sql'),
    join(__dirname, 'schema.sql'),
    join(__dirname, '..', 'src', 'db', 'schema.sql'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('schema.sql not found in any expected location');
}

/** schema.sql 执行前的补列迁移：旧库缺列时 CREATE INDEX 会报 no such column */
function ensureColumnsBeforeSchema(database: Database.Database): void {
  try {
    const hasTable = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calendar_events' LIMIT 1")
      .get();
    if (!hasTable) return; // 新库：schema 会直接建新结构

    const cols = database.prepare("SELECT name FROM pragma_table_info('calendar_events')").all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === 'end_date')) {
      database.exec('ALTER TABLE calendar_events ADD COLUMN end_date TEXT');
      database.exec('UPDATE calendar_events SET end_date = event_date WHERE end_date IS NULL');
      console.log('[migration] Added column before schema: calendar_events.end_date');
    }
  } catch (e) {
    console.warn('[migration] pre-schema column check failed:', e);
  }
}

export function initDb(dataDir: string): Database.Database {
  const dbPath = join(dataDir, 'money-jar.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 加载 schema
  const schemaPath = findSchemaPath();
  const schema = readFileSync(schemaPath, 'utf-8');
  // 旧库必须先补齐 schema.sql 里索引引用的新列，否则 CREATE INDEX 会直接失败
  ensureColumnsBeforeSchema(db);
  db.exec(schema);

  // 迁移：为旧版 adhoc_task_assignees 添加 accepted_at 字段
  runMigrations(db);

  // 引导数据：默认家长账号 + 默认加分项 + 默认设置
  // PIGGY_SKIP_BOOTSTRAP=1 时整段跳过 —— 账号由外部注册流程建立的部署形态不需要它
  if (skipBootstrap()) {
    console.log('[db] PIGGY_SKIP_BOOTSTRAP=1：跳过引导数据写入');
  } else {
    initParentAccount();
    initDefaultPointItems();
    initDefaultSettings();
  }

  // 装饰器可能在 initDb 之前就装好了，这里补上
  decoratedDb = decorateDb ? decorateDb(db) : null;

  // 始终返回原始句柄：迁移与扩展要的就是它
  return db;
}

/**
 * 业务代码统一用这个拿句柄。
 *
 * 没装装饰器时就是原生句柄；装了之后扩展可以在 get()/prepare() 这一层介入。
 */
export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return decoratedDb ?? db;
}

/**
 * 原始句柄：**不经过任何装饰**。
 *
 * 只给这几类代码用：
 *   · 迁移与建表
 *   · 引导数据（此刻还没有任何请求上下文）
 *   · 按主键 / 唯一键做的全局查找
 *   · 扩展自己的平台级逻辑
 * 业务路由不要用它 —— 用了就等于绕过扩展。
 */
export function getRawDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * 装/换数据库句柄装饰器（可选扩展点）。
 *
 * initDb() 之前调用、之后调用都可以：之后调用会立刻对已建好的句柄生效。
 */
export function setDbDecorator(fn: (raw: Database.Database) => Database.Database): void {
  decorateDb = fn;
  if (db) decoratedDb = fn(db);
}

// 迁移：为旧版数据库补字段
function runMigrations(db: Database.Database): void {
  // adhoc_tasks 加 user_id 字段（新版任务系统）
  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('adhoc_tasks') WHERE name='user_id'").get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE adhoc_tasks ADD COLUMN user_id INTEGER');
      console.log('[migration] Added column: adhoc_tasks.user_id');
      // 将旧 scope='assignee' 的任务迁移：从 assignees 表取 user_id
      try {
        db.exec(`
          UPDATE adhoc_tasks SET user_id = (
            SELECT user_id FROM adhoc_task_assignees
            WHERE adhoc_task_assignees.task_id = adhoc_tasks.id
            ORDER BY accepted_at DESC LIMIT 1
          )
        `);
        console.log('[migration] Migrated user_id from adhoc_task_assignees');
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* skip */ }

  // 删除旧表（已无用）
  try { db.exec('DROP TABLE IF EXISTS adhoc_task_assignees'); } catch (e) { /* skip */ }

  // task_completions 去掉 UNIQUE 约束（允许重新提交）
  try {
    const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_completions'").get() as any;
    if (info?.sql?.includes('UNIQUE')) {
      db.exec('DROP TABLE IF EXISTS task_completions');
      // 重新创建（schema.sql 会重新创建）
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_completions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES adhoc_tasks(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
          reason TEXT,
          reviewed_by INTEGER REFERENCES users(id),
          reviewed_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      console.log('[migration] Rebuilt task_completions table');
    }
  } catch (e) { /* skip */ }

  // point_logs.source/ref_id 字段
  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('point_logs') WHERE name='source'").get() as { c: number };
    if (c === 0) {
      db.exec("ALTER TABLE point_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'adjust' CHECK (source IN ('daily', 'adhoc', 'exchange', 'adjust'))");
    }
    const { c: c2 } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('point_logs') WHERE name='ref_id'").get() as { c: number };
    if (c2 === 0) {
      db.exec('ALTER TABLE point_logs ADD COLUMN ref_id INTEGER');
    }
  } catch (e) { /* skip */ }

  // point_items.owner_id 字段
  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('point_items') WHERE name='owner_id'").get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE point_items ADD COLUMN owner_id INTEGER');
      console.log('[migration] Added column: point_items.owner_id');
    }
  } catch (e) { /* skip */ }

  // products.icon 字段（商品分类图标）
  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('products') WHERE name='icon'").get() as { c: number };
    if (c === 0) {
      db.exec("ALTER TABLE products ADD COLUMN icon TEXT NOT NULL DEFAULT 'gift'");
      console.log('[migration] Added column: products.icon');
    }
  } catch (e) { /* skip */ }

  // users.birthday / users.sex（成长记录模块：生长曲线需按「年龄段+性别」查标准）
  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('users') WHERE name='birthday'").get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE users ADD COLUMN birthday TEXT');
      console.log('[migration] Added column: users.birthday');
    }
  } catch (e) { /* skip */ }

  try {
    const { c: cs } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('users') WHERE name='sex'").get() as { c: number };
    if (cs === 0) {
      db.exec("ALTER TABLE users ADD COLUMN sex TEXT CHECK (sex IN ('male', 'female'))");
      console.log('[migration] Added column: users.sex');
    }
  } catch (e) { /* skip */ }

  // recurring_tasks.child_ids（周期任务指定小孩；NULL=所有小孩）
  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('recurring_tasks') WHERE name='child_ids'").get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE recurring_tasks ADD COLUMN child_ids TEXT');
      console.log('[migration] Added column: recurring_tasks.child_ids');
    }
  } catch (e) { /* skip */ }

  // products.limit_days / limit_count（每 N 天限兑 M 次；0=不限）
  for (const [col, def] of [
    ['limit_days', 'ALTER TABLE products ADD COLUMN limit_days INTEGER NOT NULL DEFAULT 0'],
    ['limit_count', 'ALTER TABLE products ADD COLUMN limit_count INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    try {
      const { c } = db.prepare('SELECT COUNT(*) as c FROM pragma_table_info(\'products\') WHERE name=?').get(col) as { c: number };
      if (c === 0) {
        db.exec(def);
        console.log(`[migration] Added column: products.${col}`);
      }
    } catch (e) { /* skip */ }
  }

  // products.max_per_exchange（单次最多兑换件数）
  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('products') WHERE name='max_per_exchange'").get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE products ADD COLUMN max_per_exchange INTEGER NOT NULL DEFAULT 1');
      console.log('[migration] Added column: products.max_per_exchange');
    }
  } catch (e) { /* skip */ }

  // exchange_requests.quantity（商品兑换件数）
  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('exchange_requests') WHERE name='quantity'").get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE exchange_requests ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');
      console.log('[migration] Added column: exchange_requests.quantity');
    }
  } catch (e) { /* skip */ }

  // growth_records.grow_cm / growth_records.awarded（记录每次测量的身高增减与积分增减）
  for (const [col, def] of [
    ['grow_cm', 'ALTER TABLE growth_records ADD COLUMN grow_cm REAL'],
    ['awarded', 'ALTER TABLE growth_records ADD COLUMN awarded INTEGER'],
  ] as const) {
    try {
      const { c } = db
        .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('growth_records') WHERE name=?`)
        .get(col) as { c: number };
      if (c === 0) {
        db.exec(def);
        console.log(`[migration] Added column: growth_records.${col}`);
      }
    } catch (e) { /* skip */ }
  }

  // exchange_requests.variant_id / variant_name（商品规格兑换）
  for (const [col, def] of [
    ['variant_id', 'ALTER TABLE exchange_requests ADD COLUMN variant_id INTEGER'],
    ['variant_name', 'ALTER TABLE exchange_requests ADD COLUMN variant_name TEXT'],
  ] as const) {
    try {
      const { c } = db
        .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('exchange_requests') WHERE name=?`)
        .get(col) as { c: number };
      if (c === 0) {
        db.exec(def);
        console.log(`[migration] Added column: exchange_requests.${col}`);
      }
    } catch (e) { /* skip */ }
  }

  // recurring_tasks.valid_from / valid_to（任务有效时间段）
  for (const [col, def] of [
    ['valid_from', 'ALTER TABLE recurring_tasks ADD COLUMN valid_from TEXT'],
    ['valid_to', 'ALTER TABLE recurring_tasks ADD COLUMN valid_to TEXT'],
  ] as const) {
    try {
      const { c } = db
        .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('recurring_tasks') WHERE name=?`)
        .get(col) as { c: number };
      if (c === 0) {
        db.exec(def);
        console.log(`[migration] Added column: recurring_tasks.${col}`);
      }
    } catch (e) { /* skip */ }
  }

  // recurring_tasks.once_only（单次任务：不选重复频率时发布的任务，一生只有一期）
  // 用新增列而不是往 freq_type 的 CHECK 里加 'once' —— 改 CHECK 必须重建表，
  // 而重建要 DROP 掉被 recurring_claims 外键引用的父表，风险远高于加一列。
  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('recurring_tasks') WHERE name='once_only'").get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE recurring_tasks ADD COLUMN once_only INTEGER NOT NULL DEFAULT 0');
      console.log('[migration] Added column: recurring_tasks.once_only');
    }
  } catch (e) { /* skip */ }

  // recurring_tasks.weekly_once（每周多天只完成一次，2026-10-24 用户要求）：
  // 开启后选中的星期几合起来算一期，孩子哪一天做完都算、一周只领一次。
  // 默认 0 = 关，老任务行为完全不变。同样不改 CHECK —— 加一列最稳。
  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('recurring_tasks') WHERE name='weekly_once'").get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE recurring_tasks ADD COLUMN weekly_once INTEGER NOT NULL DEFAULT 0');
      console.log('[migration] Added column: recurring_tasks.weekly_once');
    }
  } catch (e) { /* skip */ }

  // recurring_claims 的计时列（孩子端「已领取」里的计时按钮）
  for (const [col, def] of [
    ['timer_accum_ms', 'ALTER TABLE recurring_claims ADD COLUMN timer_accum_ms INTEGER NOT NULL DEFAULT 0'],
    ['timer_started_at', 'ALTER TABLE recurring_claims ADD COLUMN timer_started_at INTEGER'],
    ['timer_paused_ms', 'ALTER TABLE recurring_claims ADD COLUMN timer_paused_ms INTEGER NOT NULL DEFAULT 0'],
    ['timer_paused_at', 'ALTER TABLE recurring_claims ADD COLUMN timer_paused_at INTEGER'],
    ['timer_total_ms', 'ALTER TABLE recurring_claims ADD COLUMN timer_total_ms INTEGER'],
  ] as const) {
    try {
      const { c } = db
        .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('recurring_claims') WHERE name=?`)
        .get(col) as { c: number };
      if (c === 0) {
        db.exec(def);
        console.log(`[migration] Added column: recurring_claims.${col}`);
      }
    } catch (e) { /* skip */ }
  }

  // users.diary_visible（成长日记对孩子的可见开关，家长按孩子单独控制）
  // 默认 1 = 可见：老库升级后行为不变，家长主动关掉才生效
  try {
    const { c } = db
      .prepare("SELECT COUNT(*) as c FROM pragma_table_info('users') WHERE name='diary_visible'")
      .get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE users ADD COLUMN diary_visible INTEGER NOT NULL DEFAULT 1');
      console.log('[migration] Added column: users.diary_visible');
    }
  } catch (e) { /* skip */ }

  // growth_diaries.updated_by（最后编辑人，卡片署名显示「创建者、编辑者」）
  try {
    const { c } = db
      .prepare("SELECT COUNT(*) as c FROM pragma_table_info('growth_diaries') WHERE name='updated_by'")
      .get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE growth_diaries ADD COLUMN updated_by INTEGER');
      console.log('[migration] Added column: growth_diaries.updated_by');
    }
  } catch (e) { /* skip */ }

  // 许愿单：商品的许愿开关/天数/连续、许愿专用商品、分类隐藏、兑换来源心愿 id
  // 老库的 products / product_categories / exchange_requests 都是既有表，
  // schema.sql 的 CREATE TABLE IF NOT EXISTS 补不了列，必须在这里逐个加。
  for (const [table, col, def] of [
    ['products', 'wish_enabled', 'ALTER TABLE products ADD COLUMN wish_enabled INTEGER NOT NULL DEFAULT 0'],
    ['products', 'wish_days', 'ALTER TABLE products ADD COLUMN wish_days INTEGER NOT NULL DEFAULT 7'],
    ['products', 'wish_consecutive', 'ALTER TABLE products ADD COLUMN wish_consecutive INTEGER NOT NULL DEFAULT 0'],
    ['products', 'wish_daily_count', 'ALTER TABLE products ADD COLUMN wish_daily_count INTEGER NOT NULL DEFAULT 0'],
    ['products', 'wish_only', 'ALTER TABLE products ADD COLUMN wish_only INTEGER NOT NULL DEFAULT 0'],
    ['product_categories', 'hidden', 'ALTER TABLE product_categories ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0'],
    ['exchange_requests', 'wish_id', 'ALTER TABLE exchange_requests ADD COLUMN wish_id INTEGER'],
  ] as const) {
    try {
      const { c } = db
        .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('${table}') WHERE name=?`)
        .get(col) as { c: number };
      if (c === 0) {
        db.exec(def);
        console.log(`[migration] Added column: ${table}.${col}`);
      }
    } catch (e) { /* skip */ }
  }

  // 背包（2026-11-13）：商品增加「道具」类型与使用说明。
  // 老库的 products 是既有表，schema.sql 的 CREATE TABLE IF NOT EXISTS 补不了列。
  for (const [col, def] of [
    ['kind', "ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'goods'"],
    ['prop_desc', "ALTER TABLE products ADD COLUMN prop_desc TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    try {
      const { c } = db
        .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('products') WHERE name=?`)
        .get(col) as { c: number };
      if (c === 0) {
        db.exec(def);
        console.log(`[migration] Added column: products.${col}`);
      }
    } catch (e) { /* skip */ }
  }

  // 背包（2026-11-14）：来源标记 + 拿走不再删除（保留被拿走物品与理由）。
  // backpack_logs 新表由 schema.sql 的 CREATE TABLE IF NOT EXISTS 直接补上；
  // 这里只给已存在的 backpack_items 补列。
  for (const [col, def] of [
    ['source', "ALTER TABLE backpack_items ADD COLUMN source TEXT NOT NULL DEFAULT 'exchange'"],
    ['taken_at', 'ALTER TABLE backpack_items ADD COLUMN taken_at INTEGER'],
    ['take_reason', 'ALTER TABLE backpack_items ADD COLUMN take_reason TEXT'],
    ['take_refund', 'ALTER TABLE backpack_items ADD COLUMN take_refund INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    try {
      const { c } = db
        .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('backpack_items') WHERE name=?`)
        .get(col) as { c: number };
      if (c === 0) {
        db.exec(def);
        console.log(`[migration] Added column: backpack_items.${col}`);
      }
    } catch (e) { /* skip */ }
  }

  // 日历（2026-11-16）：跨天日程 end_date；可见性只保留 public / private。
  //   SQLite 改不了老表的 CHECK 约束（要重建表），但旧值 parents_only 会被统一转成 private，
  //   仍然落在原 CHECK 允许范围内，所以不需要重建；新库由 schema.sql 直接建新结构。
  try {
    const { c } = db
      .prepare("SELECT COUNT(*) as c FROM pragma_table_info('calendar_events') WHERE name='end_date'")
      .get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE calendar_events ADD COLUMN end_date TEXT');
      db.exec('UPDATE calendar_events SET end_date = event_date WHERE end_date IS NULL');
      console.log('[migration] Added column: calendar_events.end_date');
    }
    const r = db.prepare("UPDATE calendar_events SET visibility = 'private' WHERE visibility = 'parents_only'").run();
    if (r.changes > 0) {
      console.log(`[migration] calendar_events: ${r.changes} 条 parents_only → private`);
    }
  } catch (e) { /* skip */ }

  // users.skin（2026-10-20）：皮肤选择。NULL = 跟随默认（家长绿 / 孩子按性别）
  try {
    const { c } = db
      .prepare("SELECT COUNT(*) as c FROM pragma_table_info('users') WHERE name='skin'")
      .get() as { c: number };
    if (c === 0) {
      db.exec("ALTER TABLE users ADD COLUMN skin TEXT CHECK (skin IN ('peach', 'ice', 'forest'))");
      console.log('[migration] Added column: users.skin');
    }
  } catch (e) { /* skip */ }

  // mailbox_messages.parent_id（2026-10-20）：孩子可以选「这句话说给哪个家长听」。
  //   NULL = 发给全家 —— 这一列上线前的历史消息、以及孩子在「名额到期」页
  //   发的那句求助都留 NULL，两端把它当「每位家长都能看」处理。
  //   不在这里回填成某个家长：回填需要知道每条消息属于哪个家庭（family_id
  //   是扩展层后补的列，这个函数跑在它之前），跨家庭猜一个 parent 反而更错。
  try {
    const { c } = db
      .prepare("SELECT COUNT(*) as c FROM pragma_table_info('mailbox_messages') WHERE name='parent_id'")
      .get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE mailbox_messages ADD COLUMN parent_id INTEGER');
      console.log('[migration] Added column: mailbox_messages.parent_id');
    }
    // 索引跟着列一起在这里建：schema.sql 跑在迁移之前，那时老表还没有这一列
    db.exec('CREATE INDEX IF NOT EXISTS idx_mailbox_messages_parent ON mailbox_messages(parent_id, id DESC)');
  } catch (e) { /* skip */ }

  // 家庭贡献值（晒娃时刻）：point_logs 要加 'contribution' 来源 + biz_date 列，
  // CHECK 约束改不了，和老 wish_items 一样重建一次表，数据原样搬。
  migratePointLogs(db);

  // 许愿单：状态机多了 'confirming'（家长通过申请 → 等孩子确认），
  // 每天考核标准多了 mode / daily_count。老表的 CHECK 约束不允许新状态，
  // 只能重建一次表（SQLite 改不了 CHECK）。数据原样搬过去。
  migrateWishItems(db);

  // wish_items.rule_changed_at（2026-11-03）：许愿规则热更新。
  // 家长在商城改了商品的许愿考核标准（天数/每天几项/连不连续）时，把新规则
  // 传导到引用该商品的进行中心愿，并记下变更日 —— 进度从变更日起按新规则重算。
  // ⚠️ 必须放在 migrateWishItems 之后：老库的 wish_items 重建（只搬旧列清单）
  //    会把这里先加上的列丢掉。
  try {
    const { c } = db
      .prepare("SELECT COUNT(*) as c FROM pragma_table_info('wish_items') WHERE name='rule_changed_at'")
      .get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE wish_items ADD COLUMN rule_changed_at INTEGER');
      console.log('[migration] Added column: wish_items.rule_changed_at');
    }
    // carried_days（2026-11-03 用户反馈）：改规则不能把孩子已完成的天清零 ——
    // 改规则那天用旧规则算出已完成的 done/streak 冻结进这一列，
    // 之后的进度 = carried_days + 从变更日起按新规则算出的天数。
    const c2 = db
      .prepare("SELECT COUNT(*) as c FROM pragma_table_info('wish_items') WHERE name='carried_days'")
      .get() as { c: number };
    if (c2.c === 0) {
      db.exec('ALTER TABLE wish_items ADD COLUMN carried_days INTEGER NOT NULL DEFAULT 0');
      console.log('[migration] Added column: wish_items.carried_days');
    }
  } catch (e) { /* skip */ }

  // users.nickname / parent_identity / is_primary（2026-11-12 多家长账号）
  // 孩子账号保持 NULL / 0；老库里的家长按「第一个家长=主账号」平滑升级，
  // 昵称先沿用账号名，身份先给一个默认值（主账号登录后可自己改）。
  for (const [col, def] of [
    ['nickname', 'ALTER TABLE users ADD COLUMN nickname TEXT'],
    ['parent_identity', 'ALTER TABLE users ADD COLUMN parent_identity TEXT'],
    ['is_primary', 'ALTER TABLE users ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    try {
      const { c } = db
        .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('users') WHERE name=?`)
        .get(col) as { c: number };
      if (c === 0) {
        db.exec(def);
        console.log(`[migration] Added column: users.${col}`);
      }
    } catch (e) { /* skip */ }
  }

  // 早期版本 parent_identity 只允许 dad/mom，SQLite 改不了 CHECK，需要重建 users。
  migrateParentIdentity(db);

  try {
    db.exec(`
      UPDATE users SET nickname = name
        WHERE role = 'parent' AND (nickname IS NULL OR nickname = '');
      UPDATE users SET parent_identity = CASE parent_identity
          WHEN 'dad' THEN '爸爸'
          WHEN 'mom' THEN '妈妈'
          ELSE parent_identity
        END
        WHERE role = 'parent' AND parent_identity IS NOT NULL;
      UPDATE users SET parent_identity = '爸爸'
        WHERE role = 'parent' AND parent_identity IS NULL;
      UPDATE users SET avatar = 'dragon'
        WHERE role = 'parent' AND (avatar IS NULL OR avatar = '');
      UPDATE users SET is_primary = 1
        WHERE role = 'parent'
          AND id = (SELECT MIN(id) FROM users WHERE role = 'parent')
          AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'parent' AND is_primary = 1);
    `);
  } catch (e) { /* skip */ }

  // 默认商品分类同属引导数据，与家长账号/加分项/设置一起受 PIGGY_SKIP_BOOTSTRAP 控制
  if (!skipBootstrap()) migrateProductCategories(db);
}

/**
 * 重建 users：去掉 parent_identity 上的 CHECK (dad/mom)。
 *
 * 身份现在支持「妈妈/爸爸/奶奶…」和用户自定义文本，旧 CHECK 会让新值写不进去，
 * 而 SQLite 不能直接删除 CHECK，只能重建表。判断依据是建表语句里是否还有
 * `parent_identity TEXT CHECK`；没有就说明已经是新表，直接跳过。
 *
 * 注意：不能先把 users 改名——SQLite 会连带改写其他表里 REFERENCES users 的外键。
 * 这里按标准流程：外键关掉 → 建 users_new → 拷数据 → 删旧表 → 改名 → 打开外键。
 * ⚠️ users_new 的列必须与 schema.sql 里的 users 保持一致。
 */
function migrateParentIdentity(db: Database.Database): void {
  const info = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
    .get() as { sql?: string } | undefined;
  if (!info?.sql) return;
  if (!/parent_identity\s+TEXT\s+CHECK/i.test(info.sql)) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS users_new');
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('parent', 'child')),
          pin TEXT,
          password_hash TEXT,
          avatar TEXT,
          nickname TEXT,
          parent_identity TEXT,
          is_primary INTEGER NOT NULL DEFAULT 0,
          birthday TEXT,
          sex TEXT CHECK (sex IN ('male', 'female')),
          diary_visible INTEGER NOT NULL DEFAULT 1,
          hidden INTEGER NOT NULL DEFAULT 0,
          total_points INTEGER NOT NULL DEFAULT 0,
          skin TEXT CHECK (skin IN ('peach', 'ice', 'forest')),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          CHECK (
            (role = 'parent' AND password_hash IS NOT NULL) OR
            (role = 'child' AND pin IS NOT NULL)
          )
        )
      `);
      db.exec(`
        INSERT INTO users_new (
          id, name, role, pin, password_hash, avatar, nickname, parent_identity,
          is_primary, birthday, sex, diary_visible, hidden, total_points, skin, created_at
        )
        SELECT
          id, name, role, pin, password_hash, avatar, nickname,
          CASE parent_identity
            WHEN 'dad' THEN '爸爸'
            WHEN 'mom' THEN '妈妈'
            ELSE parent_identity
          END,
          is_primary, birthday, sex, diary_visible, hidden, total_points, skin, created_at
        FROM users
      `);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
    })();

    const fkErrors = db.pragma('foreign_key_check') as unknown[];
    if (fkErrors.length) {
      console.error('[migration] users 重建后存在外键异常', fkErrors);
    }
    console.log('[migration] Rebuilt users table (free-form parent_identity)');
  } catch (e) {
    console.error('[migration] users 重建失败', e);
    throw e;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * 重建 wish_items：给状态机补上 'confirming'，并补 mode / daily_count 两列。
 *
 * 为什么要重建而不是 ALTER：老表的 `CHECK (status IN (...))` 里没有新状态，
 * 而 SQLite 改不了 CHECK 约束。判断依据是建表语句里有没有 'confirming' ——
 * 有就说明已经是新表，直接跳过（这个函数每次启动都会跑）。
 *
 * ⚠️ 下面的建表语句必须与 schema.sql 里的 wish_items 保持一致。
 */
function migrateWishItems(db: Database.Database): void {
  try {
    const info = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wish_items'")
      .get() as { sql?: string } | undefined;
    if (!info?.sql) return; // 老库没有这张表：schema.sql 已经按新定义建好了
    if (info.sql.includes("'confirming'")) return;

    // ⚠️ family_id 是扩展层（server/src/ext/migrate.ts）在 schema 之后补的列，
    // 这个函数跑在它前面 —— 必须自己判断有没有、有就原样搬过去，
    // 否则重建一次就把每一行属于哪个家庭抹掉了（数据等于全丢）。
    const cols = db.prepare("SELECT name FROM pragma_table_info('wish_items')").all() as { name: string }[];
    const hasFamily = cols.some((c) => c.name === 'family_id');

    // 索引跟着旧表走，先删掉，否则新表建同名索引会被 IF NOT EXISTS 跳过，最后连带被删
    db.exec('DROP INDEX IF EXISTS idx_wish_items_child');
    db.exec('DROP INDEX IF EXISTS idx_wish_items_status');
    db.exec('ALTER TABLE wish_items RENAME TO wish_items_old');

    db.exec(`
      CREATE TABLE IF NOT EXISTS wish_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        description TEXT,
        photo TEXT NOT NULL DEFAULT '',
        task_id INTEGER REFERENCES recurring_tasks(id) ON DELETE SET NULL,
        days_required INTEGER NOT NULL DEFAULT 7,
        require_consecutive INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'all' CHECK (mode IN ('all', 'count')),
        daily_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirming', 'active', 'completed', 'claimed', 'cancelled')),
        exchange_id INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        activated_at INTEGER,
        claimed_at INTEGER
      )
    `);
    if (hasFamily) db.exec('ALTER TABLE wish_items ADD COLUMN family_id INTEGER');

    const base = 'id, child_id, product_id, name, description, photo, task_id, days_required, require_consecutive';
    const statusOn = 'status, exchange_id, created_at, activated_at, claimed_at';
    db.exec(`
      INSERT INTO wish_items (${base}, mode, daily_count, ${statusOn}${hasFamily ? ', family_id' : ''})
      SELECT ${base}, 'all', 0, ${statusOn}${hasFamily ? ', family_id' : ''}
      FROM wish_items_old
    `);
    db.exec('DROP TABLE wish_items_old');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wish_items_child ON wish_items(child_id, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wish_items_status ON wish_items(status, created_at DESC)');
    console.log('[migration] Rebuilt wish_items table (status + mode + daily_count)');
  } catch (e) {
    console.error('[migration] wish_items 重建失败', e);
  }
}

/**
 * 重建 point_logs：给 source CHECK 加 'contribution'（家庭贡献值），并补 biz_date 列。
 *
 * 为什么要重建：source 上的 CHECK 约束 SQLite 改不了（同 wish_items 的 'confirming'）。
 * 判断依据：建表语句里有没有 'contribution' —— 有就跳过（本函数每次启动都会跑）。
 * biz_date：家庭贡献值记在孩子**做任务**的那天（家长可能隔天审核），其余流水为 NULL。
 *
 * ⚠️ 建表语句必须与 schema.sql 里的 point_logs 保持一致。
 * ⚠️ family_id 是扩展层（ext/migrate.ts）在 schema 之后补的列，本函数跑在它前面，
 *    必须判断有没有、有就原样搬过去，否则重建会把每一行属于哪个家庭抹掉。
 */
function migratePointLogs(db: Database.Database): void {
  try {
    // 贡献值索引放这里而不是 schema.sql：老库跑 schema 时还没有 biz_date 列。
    // 新库/已重建的库一次建好；老库这条会失败，落到下面的重建分支里补。
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_point_logs_contribution ON point_logs(user_id, source, biz_date)');
    } catch { /* 老表还没有 biz_date，重建后再建 */ }

    const info = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='point_logs'")
      .get() as { sql?: string } | undefined;
    if (!info?.sql) return; // 老库没有这张表：schema.sql 已经按新定义建好了
    if (info.sql.includes("'contribution'")) return;

    const cols = db.prepare("SELECT name FROM pragma_table_info('point_logs')").all() as { name: string }[];
    const hasFamily = cols.some((c) => c.name === 'family_id');

    // 索引跟着旧表走，先删掉（否则新表建同名索引会被 IF NOT EXISTS 跳过，最后连带被删）
    db.exec('DROP INDEX IF EXISTS idx_point_logs_user');
    db.exec('DROP INDEX IF EXISTS idx_point_logs_family');
    db.exec('DROP INDEX IF EXISTS idx_point_logs_contribution');
    db.exec('ALTER TABLE point_logs RENAME TO point_logs_old');

    db.exec(`
      CREATE TABLE IF NOT EXISTS point_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('daily', 'adhoc', 'exchange', 'adjust', 'contribution')),
        ref_id INTEGER,
        note TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        biz_date TEXT
      )
    `);
    if (hasFamily) db.exec('ALTER TABLE point_logs ADD COLUMN family_id INTEGER NOT NULL DEFAULT 1');

    const colsList = cols.map((c) => c.name);
    // 老表没有 biz_date（这正是本次重建的原因之一），原样搬其它所有列
    const carry = colsList.filter((c) => c !== 'biz_date');
    db.exec(`
      INSERT INTO point_logs (${carry.join(', ')})
      SELECT ${carry.join(', ')}
      FROM point_logs_old
    `);
    db.exec('DROP TABLE point_logs_old');
    db.exec('CREATE INDEX IF NOT EXISTS idx_point_logs_user ON point_logs(user_id, created_at DESC)');
    if (hasFamily) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_point_logs_family ON point_logs(family_id)');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_point_logs_contribution ON point_logs(user_id, source, biz_date)');
    console.log('[migration] Rebuilt point_logs table (source + contribution, biz_date)');
  } catch (e) {
    console.error('[migration] point_logs 重建失败', e);
  }
}

/** 内置图标 key —— 与老版 products.icon 的取值域完全一致，迁移时按它对齐 */const BUILTIN_ICON_KEYS = ['snack', 'toy', 'activity', 'game', 'study', 'privilege', 'food', 'gift'] as const;

/** 默认分类（首次建库 / 老库升级时 seed 一份，之后完全由家长增删改） */
const DEFAULT_CATEGORIES: Array<{ name: string; icon: string; color: string }> = [
  { name: '零食', icon: 'snack', color: '#ff9bb0' },
  { name: '玩具', icon: 'toy', color: '#84c5ff' },
  { name: '活动', icon: 'activity', color: '#ffb454' },
  { name: '游戏', icon: 'game', color: '#7ed4b9' },
  { name: '学习', icon: 'study', color: '#b39ddb' },
  { name: '特权', icon: 'privilege', color: '#ffd166' },
  { name: '美食', icon: 'food', color: '#ffab91' },
  { name: '其他', icon: 'gift', color: '#e8b4c8' },
];

/**
 * 商品分类：建表由 schema.sql 负责，这里只做「seed 默认分类」和「老数据搬迁」。
 *
 * 老版本 products.icon 一个字段同时承担「分类图标」和「商品图片」两件事，
 * 新版本拆成 products.category_id（分类）+ products.icon（仅自定义图片，
 * 空串表示回落到分类图标）。搬迁规则：
 *   - icon 是内置图标 key → 找到同 key 的分类当 category_id，并把 icon 清空
 *     （视觉上没变化：分类图标就是原来那个 key 的图标）
 *   - icon 是 /uploads/... 自定义图片 → 保留图片，分类补一个「其他」
 */
function migrateProductCategories(db: Database.Database): void {
  try {
    const seeded = db.prepare('SELECT COUNT(*) as c FROM product_categories').get() as { c: number };
    if (seeded.c === 0) {
      const ins = db.prepare(
        'INSERT INTO product_categories (name, icon, color, sort_order) VALUES (?, ?, ?, ?)'
      );
      DEFAULT_CATEGORIES.forEach((c, i) => ins.run(c.name, c.icon, c.color, i));
      console.log('[migration] Seeded default product categories');
    }
  } catch (e) { /* skip */ }

  try {
    const { c } = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('products') WHERE name='category_id'").get() as { c: number };
    if (c === 0) {
      db.exec('ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES product_categories(id) ON DELETE SET NULL');
      console.log('[migration] Added column: products.category_id');

      const move = db.prepare(
        "UPDATE products SET category_id = (SELECT id FROM product_categories WHERE icon = ?), icon = '' WHERE icon = ?"
      );
      for (const key of BUILTIN_ICON_KEYS) {
        const r = move.run(key, key);
        if (r.changes > 0) console.log(`[migration] Moved ${r.changes} product(s) into category "${key}"`);
      }
      // 剩下的（自带 /uploads 图片或其它历史值）统一落到「其他」
      const rest = db.prepare(
        "UPDATE products SET category_id = (SELECT id FROM product_categories WHERE icon = 'gift') WHERE category_id IS NULL"
      ).run();
      if (rest.changes > 0) console.log(`[migration] Assigned ${rest.changes} product(s) to default category`);
    }
    // 索引必须等列存在之后再建（老库的 products 表是既有表，schema.sql 补不了列）
    db.exec('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)');
  } catch (e) { /* skip */ }
}

function initParentAccount(): void {
  const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('parent');
  if (existing) return;

  const hash = bcrypt.hashSync(config.adminPassword, 10);
  db.prepare(
    `INSERT INTO users (name, role, password_hash, avatar, nickname, parent_identity, is_primary, total_points)
     VALUES (?, 'parent', ?, 'dragon', ?, '爸爸', 1, 0)`
  ).run(config.adminUsername, hash, config.adminUsername);
}

function initDefaultPointItems(): void {
  const count = db.prepare('SELECT COUNT(*) as c FROM point_items WHERE is_default = 1').get() as { c: number };
  if (count.c > 0) return;

  const defaults: Array<{ name: string; type: 'gain' | 'loss'; points: number; daily_limit: number }> = [
    { name: '完成作业', type: 'gain', points: 10, daily_limit: 1 },
    { name: '早睡早起', type: 'gain', points: 10, daily_limit: 1 },
    { name: '帮忙做家务', type: 'gain', points: 5, daily_limit: 3 },
    { name: '未完成作业', type: 'loss', points: -10, daily_limit: 1 },
    { name: '未早睡早起', type: 'loss', points: -10, daily_limit: 1 },
    { name: '发脾气', type: 'loss', points: -5, daily_limit: 2 },
  ];

  const stmt = db.prepare(
    `INSERT INTO point_items (name, type, points, daily_limit, sort_order, enabled, is_default)
     VALUES (?, ?, ?, ?, ?, 1, 1)`
  );
  defaults.forEach((d, i) => stmt.run(d.name, d.type, d.points, d.daily_limit, i));
}

function initDefaultSettings(): void {
  const defaults: Array<[string, string]> = [
    ['cash_rate', '10'],
    ['growth_record_reward', '2'],   // 每次测量记录奖励积分，0 表示不奖励
    ['growth_reward_per_cm', '10'],  // 每比上次长高 1cm 额外奖励积分，0 表示不奖励
  ];
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of defaults) {
    const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!existing) stmt.run(key, value);
  }
}
