# Tasks — v2.0.0-beta.3 阶段 1：数据底座

## Task 1 — migrations 加 scenarios 表 + seed
- 涉及文件：`src/backend/database/migrations.js`
- 操作：
  1. 新增函数 `ensureScenariosSupport(db)`，含 `CREATE TABLE IF NOT EXISTS scenarios (...)`
  2. 表创建后查 `SELECT COUNT(*) FROM scenarios`，若 0 则插入 3 条内置场景（PRD §7.6）
  3. exports 加 `ensureScenariosSupport`
- 状态：done

## Task 2 — scenarios-repository.js 新建
- 涉及文件：`src/backend/database/scenarios-repository.js`（新文件）
- 操作：
  1. 6 个函数：list / get / create / update / delete / toggleEnabled
  2. 校验 category / priority / enabled / config
  3. name 唯一约束破坏时抛 `Error('场景名 "X" 已存在，请换一个名字')`
- 状态：done

## Task 3 — database.js facade 暴露
- 涉及文件：`src/backend/database.js`
- 操作：
  1. import `scenariosRepository`
  2. init 中加 `this.ensureScenariosSupport()`
  3. AppDatabase class 加 6 个 method 转调 repository
- 状态：done

## Task 4 — main.js 注册 IPC
- 涉及文件：`src/main.js`
- 操作：注册 6 个 `scenarios:*` IPC handler，统一 try/catch 返回 `{status, ...}`
- 状态：done

## Task 5 — preload.js 暴露 API
- 涉及文件：`src/preload.js`
- 操作：在 desktopApi 中加 `scenarios` 对象，含 6 个 wrapper
- 状态：done

## Task 6 — 单元测试
- 涉及文件：临时 node 脚本
- 操作：in-memory SQLite 模拟：
  - 空库 init → 3 条内置场景存在
  - 老库二次 init → 不重复 seed
  - create / update / delete / toggle 各路径
  - name 重复 / category 非法 / priority 越界 校验
- 状态：done

## Task 7 — smoke + check-vars
- 操作：`npm run smoke`（不退化）+ `npm run check:vars`
- 状态：done

## Task 8 — 提 PR #29
- 操作：commit + push + gh pr create + Codex review 处理
- 状态：done
