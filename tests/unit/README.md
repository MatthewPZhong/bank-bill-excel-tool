# `tests/unit/` — 单元测试套件（v2.1.8 G1 引入）

> 用 Node 22+ 内置 `node:test` + `node:assert`，零 devDependencies 新增。
> 运行：`npm run test:unit`（覆盖率：`npm run test:unit:coverage`）

## 跑测试

```bash
npm run test:unit             # 跑全部 unit case
npm run test:unit:coverage    # 跑全部 + 输出覆盖率
node --test tests/unit/backend/file-service/normalizers.test.js   # 跑单个文件
```

**关于 npm script 的 `$(find ...)` 写法**：Node 24 `--test <dir>` 行为有坑（会把目录路径当 module 解析报 `Cannot find module`），因此用 `$(find tests/unit -name '*.test.js' -type f)` 把所有测试文件列表展开为参数传给 node。Node 22 不带参数的自动发现模式在大型仓库会扫描整个 cwd 卡住，也不能用。

## 目录结构（镜像 src/）

```
tests/unit/
├── backend/
│   ├── file-service/                  → src/backend/file-service/*
│   ├── database/                      → src/backend/database/*-repository.js
│   ├── acquiring-bill-currency-db/    → src/backend/acquiring-bill-currency-db/*
│   ├── acquiring-bill-currency-import/→ src/backend/acquiring-bill-currency-import/*
│   ├── bank-bu-recon-db/              → src/backend/bank-bu-recon-db/*
│   ├── bank-bu-recon-import/          → src/backend/bank-bu-recon-import/*
│   ├── biz-op-recon-db/               → src/backend/biz-op-recon-db/*
│   ├── biz-op-recon-import/           → src/backend/biz-op-recon-import/*
│   ├── pending-db/                    → src/backend/pending-db/*
│   ├── pending-import/                → src/backend/pending-import/*
│   └── pending-export/                → src/backend/pending-export/*
├── main-process/
│   └── scenario-engines/              → src/main-process/scenario-engines/*
├── constants/                         → src/constants/*
├── fixtures/                          → 单元测试专用 fixture（小样本）
└── helpers/                           → 测试工具（如 in-memory sqlite setup / tmpdir）
```

**对应的 src/ 范围**：覆盖第 1 层（纯函数）+ 第 2 层（带轻副作用）。第 3 层（main.js / renderer / session 状态机）**明确不做 unit**，依赖 smoke + preview + 手动测试。详见 `docs/iterations/v2.1.8/PRD-v2.1.8.md` §七 G1。

## 命名规范

- 测试文件名：与被测文件同名 + `.test.js` 后缀
  - 例：`src/backend/file-service/normalizers.js` → `tests/unit/backend/file-service/normalizers.test.js`
- 测试套件：用 `describe()` 包裹一组相关 case
- 单个 case：用 `test('描述 — 输入 → 期望输出', () => {...})`

## 基本模板

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { someFunction } = require('../../../src/backend/some-module');

test.describe('someFunction', () => {
  test('正常输入 → 预期输出', () => {
    assert.equal(someFunction('input'), 'expected');
  });

  test('边界 — 空字符串 → null', () => {
    assert.equal(someFunction(''), null);
  });
});
```

## 已有 case 示例

| 模块 | 测试文件 | case 数 |
|---|---|---|
| 金额 / 币种 / 日期 / 正则归一 | `backend/file-service/normalizers.test.js` | 68 |

跑 `npm run test:unit` 当前预期：`tests 68 / suites 17 / pass 68 / fail 0`。

## fixture 复用

- **F5 算法 fixture**：放在仓库根 `scripts/fixtures/v2.1.8/`（完整原文件，smoke 也用）
- **unit 专用裁剪样本**：放本目录 `fixtures/`（小、专注、可手写）
- 引用方式：用 `path.join(__dirname, '../../../scripts/fixtures/v2.1.8/F5-TEST.xlsx')`

## 与 smoke 的边界

| 层 | 覆盖范围 | 工具 |
|---|---|---|
| **unit**（本目录） | 纯函数 + 带轻副作用模块；ms 级 | `node:test` |
| **smoke**（`scripts/test-*.js` + `scripts/smoke-test.js`） | 端到端集成 / 跨模块流程 / IPC 链路 | 手写 Node 脚本 |
| **preview** | UI 渲染回归 | `npm run preview:*` |
| **手动** | UI 交互 / Electron 主进程生命周期 | 启动 app 测 |

**不要在 unit 里**：跑 Electron / 起子进程 / 真实文件系统大文件 IO / 真实 SQLite 文件落盘（用 `:memory:`）。

## 维护约定

- 新加纯函数 / 带轻副作用模块 → **必须**同步写 unit case
- 修改已有函数 → unit case 一起改；case 失败先想清楚是 case 错了还是实现错了
- case 失败 = 契约不一致；不要为了让 case 过而软化期望值
- PR body 触及第 1/2 层模块时，加"unit case 列表"段落

详见 `docs/iterations/v2.1.8/PRD-v2.1.8.md` §七 G1 + `spec.md` §七 升格 11 条 important-variables。
