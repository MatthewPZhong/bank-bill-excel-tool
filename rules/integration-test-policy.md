# 集成测试约定（Integration Test Policy）

> 版本：v1（2026-05-26 v2.1.8 立项 D10-D15）
> 关联：CLAUDE.md §6 验证证据优先 / `rules/important-variables.md`

## 一、为什么有这层

项目测试有 3 层：

| 层 | 入口 | 用途 | 速度 |
|---|---|---|---|
| **Unit** | `npm run test:unit`（Node `node:test`）| 纯函数 / 隔离逻辑 / 边界 case | < 1 秒 |
| **Smoke** | `npm run smoke` | 单模块业务流程冒烟 + 子系统集成 | ~5 秒 |
| **Integration** | `npm run test:integration` | **跨模块联动 + 端到端契约 + 真实文件 IO** | < 5 秒 |

**Integration 不替代 Smoke，是补充**：
- Smoke 覆盖**业务规则**（C1/C2/C3 引擎 + 字段映射 + DB 迁移幂等等）
- Integration 覆盖**端到端契约**（reader→normalizer→writer→readback / migration 全流程 / 跨模块字段流转）

## 二、命名规范

文件位置：`scripts/integration/<module>-<feature>.js`

| 命名要求 | 例 |
|---|---|
| 按**业务模块**命名，**不带版本前缀** | `acquiring-bill-currency-n4-migration.js` ✓ / `test-v2.1.8-n4-e2e.js` ✗ |
| 模块名匹配 `src/main-process/` 或 `src/backend/` 下子目录 | `bank-statement-*` / `pending-*` / `acquiring-bill-currency-*` |
| feature 一般用功能 / 流程 / 改造代号 | `*-idle-cleanup` / `*-hit-scenario-sheet` / `*-pipeline` |

**反例**（不要这么命名）：
- ❌ `test-v2.1.8-xxx.js`（版本前缀 → 后续版本误以为是专属）
- ❌ `release-test-xxx.js`（不知道测什么）
- ❌ `e2e-everything.js`（粒度太粗）

## 三、脚本结构约定

每个集成脚本必须满足：

1. **独立可跑**：`node scripts/integration/<file>.js` 直接执行
2. **自包含 setup/cleanup**：自建 tmp 目录 / tmp DB，run 完清理
3. **stdout 含 `N/N PASS`**（**硬约束**，self-review SR4 强化）：
   - 必须输出形如 `==== 38/38 PASS ====` 的字符串
   - runner 用 regex `(\d+)\/(\d+) PASS` 抓数字汇总
   - **退出码（exit code 0/1）才是 PASS / FAIL 真理来源**，N/N 仅供汇总展示
   - 若用其他格式（如 `Pass: 18/18 ✓`），runner summary 显示 `(no count)`，不影响判定但损失可读性
4. **失败 `process.exit(1)` + 输出 FAILURES 列表**
5. **顶部注释说明目标 + 覆盖范围 + 用法**

模板：

```javascript
// 主功能 X「<模块中文名>」集成测试
//   覆盖：<3-5 条关键验证点>
//
// <长描述：模块核心 pipeline + 为什么这些点必须 e2e 验>
//
// 用法：node scripts/integration/<module>-<feature>.js

const fs = require('node:fs');
// ...

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) { /* ... */ }
function assertTrue(cond, label) { /* ... */ }

async function run() {
  console.log('==== <模块名> 集成验证 ====');
  // Step 1 / Step 2 / ...
  // 用 assertEq / assertTrue

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    failures.forEach((f) => console.error(`  - ${f.label}: ...`));
    process.exit(1);
  }
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
```

## 四、新模块的硬约束

**用户立项新业务模块时**，PM/Dev 必须：

- [ ] 在 `src/main-process/<module>-session.js` 或类似位置写业务逻辑
- [ ] 在 `scripts/smoke/<module>.js` 写 smoke（单模块业务规则）
- [ ] **在 `scripts/integration/<module>-pipeline.js` 写至少 1 个集成脚本**（端到端契约）
- [ ] 在 PR body 列出新加的 smoke + integration 文件名
- [ ] `npm run release-check` 自动包含新脚本（runner 自动发现）

**已有模块新增功能时**（如 v2.1.8 N4）：

- [ ] 若功能改了"用户可见的输出契约"（列结构 / migration 行为 / 数据保留语义）→ **必须**新加集成测试 `scripts/integration/<module>-<feature>.js`
- [ ] 若功能只改了内部算法（如 F5 算法重设）→ 优先在 smoke + unit 补 case；不强制新加 integration

## 五、Runner 工作方式

`scripts/integration-runner.js`：

- 自动扫 `scripts/integration/*.js`
- 按文件名字母序串行跑（`spawnSync` 进程隔离）
- 抓每个脚本 stdout 的 `N/N PASS` 字符串汇总
- 任一 fail → 整体 `exit 1`

**新加集成测试无需改 runner**：放到 `scripts/integration/` 下就自动被抓。

## 六、release-check 一键 gate

`npm run release-check` = `smoke && test:unit && test:integration`

**发版前 hard gate**：
- 任何一个 fail → 整个流程红 → 不能进入 GUI 手测 / 提 PR
- 全 PASS 才有资格进入 `docs/iterations/<version>/manual-test-checklist.md` 跑 GUI 验证

**版本号 bump 后必须跑一次**（与 `npm run scan:vars` + `/check-vars` 并列）。

**仅在开发机本地跑**（self-review SR4 备注）：
- 项目无 CI 配置；release-check 由开发者在 macOS / Windows / Linux 本地手动触发
- `&&` 串联在 npm scripts 中由 shell（macOS/Linux：sh；Windows：cmd.exe）执行，三平台均支持短路语义
- 跑完看「最后一行 `smoke test passed` + `tests N pass` + `全部 N 个集成脚本通过 ✓`」三段确认

## 七、当前集成测试清单（v2.1.8 起 6 个）

| 文件 | 主功能 | 用例数 |
|---|---|---|
| `acquiring-bill-currency-n4-migration.js` | 8 收单单据币种校验 | 127（含 SR2 fault injection 2 用例）|
| `acquiring-bill-currency-idle-cleanup.js` | 8 收单单据币种校验 | 38（含 SR3 多 run 串行 + Phase 2 FK 2 用例）|
| `bank-statement-hit-scenario-sheet.js` | 4 银行对账单处理 | 26 |
| `statement-generation-pipeline.js` | 1 生成网银账单 | 45 |
| `new-account-balance-statement.js` | 2 新开银行账户余额账单 | 36 |
| `pending-data-reconciliation.js` | 3 月度 Pending 数据核对 | 33 |

**合计 305 断言**（v2.1.8 self-review +32）；新加脚本时把行加进表，保持文档与代码同步。

⚠️ **手工维护提示**（self-review SR4 已记 v2.1.9 backlog）：未来考虑让 `integration-runner.js` 在末尾输出"当前清单 markdown 表"自动同步本节，避免手抖漏更新。

## 八、什么时候不写集成测试

- 纯内部 helper / 算法（用 unit）
- 单模块业务规则细节（用 smoke）
- UI / IPC / Dialog 流程（用 manual-test-checklist GUI 手测）
- 性能验证（独立性能脚本，如 `scripts/test-vN.M.P-perf-*.js`）

## 九、参考

- `CLAUDE.md` 第 6 条 "验证证据优先"
- `rules/important-variables.md` 跨文件变更 review 配套
- `docs/iterations/v2.1.8/manual-test-checklist.md` GUI 手测互补
- `package.json` scripts: `smoke` / `test:unit` / `test:integration` / `release-check`
