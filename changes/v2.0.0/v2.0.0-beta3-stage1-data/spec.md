# Spec — v2.0.0-beta.3 阶段 1：数据底座

> status: apply
> owner: team-lead
> created: 2026-04-28
> updated: 2026-04-28
> 上游 PRD：`docs/iterations/v2.0.0-beta.3/PRD-v2.0.0-beta.3.md` §十二 阶段 1

## 1. 背景

- v2.0.0-beta.3 主体迭代「银行对账单处理新模块」分 8 阶段（PRD §十二）
- 本 PR（PR #29）= 阶段 1 = **数据底座**：`scenarios` 表 + 迁移 + 内置 3 场景 seed + repository CRUD + 6 个 IPC + preload API
- 不含 UI、算法引擎、文件读写（这些属阶段 2-7）

## 2. 代码现状（必须有出处）

- `src/backend/database/migrations.js:307-320` — 现有 11 个 `ensureXxxSupport(db)` 幂等迁移函数 + 统一 exports
- `src/backend/database.js:97-107` — `init()` 内顺序调用所有迁移
- `src/backend/database.js:286-321` — `settingsRepository` facade 已示范 key/value setting 的 8 个方法暴露模式
- `src/backend/database/settings-repository.js:90-114`（PR #27）— `current_module` setting 三件套是 setting 持久化范式参考
- `src/main.js:2657-2696`（PR #27）— `app:get-info` 字段 + 单独 setter handler 是 IPC 注册模式
- `src/preload.js:17-22`（PR #27）— `desktopApi.settings.setCurrentModule` 是 preload 暴露模式

## 3. 目标

- 必做：
  1. SQLite 新增 `scenarios` 表（schema 见 PRD §8.1）
  2. 迁移函数 `ensureScenariosSupport(db)` 幂等创建表 + 仅当表为空时 seed 3 条内置场景
  3. 新增 `src/backend/database/scenarios-repository.js`：6 个 CRUD 函数
  4. `database.js` facade 暴露 6 个 method
  5. `main.js` 注册 6 个 IPC handler：`scenarios:list / get / create / update / delete / toggle-enabled`
  6. `preload.js` 暴露 `desktopApi.scenarios`：6 个 wrapper
- 可不做：
  - 不暴露任何 UI 入口（阶段 2 才接入模块面板）
  - 不接入文件 import/export（阶段 7）
- 明确不做：
  - 不 bump 版本号（v2.0.0-beta.3 系列发版前才 bump）
  - 不更新 CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE

## 4. 功能点

### 功能点 1 — `scenarios` 表
- schema：
  ```sql
  CREATE TABLE IF NOT EXISTS scenarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL CHECK (category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join')),
    name TEXT NOT NULL,
    priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    config_json TEXT NOT NULL,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (name)
  );
  ```
- 验收：表存在 + 老库再次启动不重复创建（幂等）

### 功能点 2 — 内置 3 场景 seed
- 仅当表为空时插入（用 `SELECT COUNT(*) FROM scenarios` 判定）
- 3 条内置场景的 JSON 配置完全按 PRD §7.6 写死
- 验收：空库启动 → `listScenarios()` 返回 3 条；非空库不改动

### 功能点 3 — repository CRUD
- 6 个函数（in `scenarios-repository.js`）：
  - `listScenarios(db)` → `[{id, category, name, priority, enabled, isBuiltin, createdAt, updatedAt}]`（不含 config_json，列表轻量）
  - `getScenario(db, id)` → 完整对象（含 `config: parsed JSON`）；不存在返回 `null`
  - `createScenario(db, { category, name, priority, enabled, config, isBuiltin? })` → `{id}`
  - `updateScenario(db, id, fields)` → 修改某些字段（name / priority / enabled / config）；id / category / is_builtin 不可改
  - `deleteScenario(db, id)` → 不论 isBuiltin 都允许删（D14：is_builtin 仅记录用）
  - `toggleScenarioEnabled(db, id, enabled)` → 单独切换 enabled（专用 fast path）
- 校验：
  - category 必须是 3 枚举之一
  - priority 必须 0-3
  - enabled 必须 0 / 1
  - name 唯一约束（DB 层 UNIQUE + repository 层友好错误信息）
  - config 必须可 JSON.stringify（创建/更新时序列化）
- 验收：单测覆盖每个 CRUD + 校验失败路径

### 功能点 4 — IPC + preload
- 6 个 IPC channel（PRD §九）：
  - `scenarios:list` → 返回 listScenarios 结果
  - `scenarios:get` (id) → 返回 getScenario 结果
  - `scenarios:create` (payload) → 返回 `{status:'ok', id}` 或 `{status:'failed', message}`
  - `scenarios:update` (id, fields) → `{status}`
  - `scenarios:delete` (id) → `{status}`
  - `scenarios:toggle-enabled` (id, enabled) → `{status, enabled}`
- preload 对应 6 个 wrapper

## 5. 影响范围

- 后端：
  - 新文件：`src/backend/database/scenarios-repository.js`
  - 修改：`src/backend/database/migrations.js`（加 `ensureScenariosSupport`）、`src/backend/database.js`（init 顺序 + facade）、`src/main.js`（IPC handlers）
  - 修改：`src/preload.js`（暴露 desktopApi.scenarios）
- 前端：无（阶段 1 不接入 UI）
- 脚本 / 配置 / 数据：
  - **schema 变更**：新增 `scenarios` 表（不影响现有表）
  - 旧库升级路径：启动时 `ensureScenariosSupport(db)` 自动建表 + seed 3 内置
- 对外接口影响：
  - 新增 6 个 IPC channel（向后兼容）
  - 不修改现有 channel
- 兼容性影响：
  - 旧版本数据库无 `scenarios` 表 → 启动后自动创建 + seed
  - 老版本应用无法识别 `scenarios` 表（但本表不影响其他功能）

## 6. 技术决策

- **方案 A**（PRD §8.1 / D6）：单表 `scenarios` + JSON blob，与 amount-split / bill-split / settings 风格一致
- **不用方案 B**（每类一张子表）：3 类 schema 差异巨大但 CRUD 模式完全相同，JSON blob 比 7 张表简单
- **不用方案 C**（多列 + 类型字段）：列爆炸，不可读
- **seed 时机**：迁移 `ensureScenariosSupport` 内只做"建表 + seed-if-empty"，不在 app 启动单独写 seed 入口，与现有迁移风格一致
- **API 设计**：listScenarios 不返 config_json（轻量，列表只展示元数据）；getScenario(id) 才返 config（详情时拉）

## 7. 数据 / 状态 / 安全影响

- **数据结构**：新表 `scenarios`，独立于现有表，无外键
- **迁移幂等**：`CREATE TABLE IF NOT EXISTS` + `SELECT COUNT(*) === 0 才 seed`，重启不重复
- **状态流转**：N/A（仅持久化层，无运行时状态）
- **权限 / 安全**：本地 SQLite，无外部接口
- **回滚策略**：
  - 代码层：revert commit
  - 数据层：用户自己删 scenarios 表（无外键，删表无副作用）；或保留表（不影响其他模块）
- **资金红线**：无（本阶段仅持久化层；算法引擎在阶段 4-7 实施时高亮）

## 8. 待澄清问题

- [x] config_json 可 NULL 还是 NOT NULL？→ NOT NULL（每条场景必有配置）
- [x] is_builtin 是否影响删除？→ 不影响（D14：仅记录）
- [x] name UNIQUE 约束破坏时返回什么？→ 抛 friendly error（"场景名 X 已存在"）
- [x] listScenarios 默认排序？→ `(priority desc, id asc)`（与 PRD §7.4 调度顺序一致，方便调试）
