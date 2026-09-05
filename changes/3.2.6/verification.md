# v3.2.6 验证记录

日期：2026-09-05。环境：macOS、Node 24.13.0。基线：`e50478314670f52ba2b400f574f82358ece20739`；验证对象为本次 3.2.6 实现及 PR #229 的逐条对账字段方向、交叉候选计数、空分段提示定位修复。

## PR #229 空分段定位回归（本轮）

在 head `1b3363b0ab94f0875d73432b2ef269e218e53825` 的未经修改生产源码上添加 5 项回归，先取得 **3 PASS / 2 FAIL**，再调整维护证据的行号优先级，修复后 **5/5 PASS**。

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 首段为空，表头第 2 行，后段首条交易第 5 行 | FAIL，定位第 5 行 | PASS，定位本段第 2 行 |
| 中间段为空，表头第 5 行，后段首条交易第 8 行 | FAIL，定位第 8 行 | PASS，定位本段第 5 行 |
| 末尾段为空，表头第 8 行 | PASS | PASS，定位本段第 8 行 |
| 无冻结表头，有预览行号 | PASS | PASS，保留预览行号 23 |
| 表头和预览行号均缺失 | PASS | PASS，保留 0 |

前三项会创建并读取临时 XLSX，账号说明在 A 列、交易表在 B:D，实际执行 `buildMappedRows` / reader、账号识别与桥接冻结、`identifyAccountBlocks`、选择行构建、证据生成和提取函数。原值、行元数据、重复表头和空段均来自上述链路，未手工伪造冻结识别结果。提取前删除本测试的源文件，确认仅凭冻结证据仍能给出正确账号、文件、分段与行号，不返回部分 accounts，也不改变导入上下文。

本轮账号链路、C2 引擎／操作符／方向／交叉候选及 dispatcher 共 **154/154 PASS**；`npm run lint`、`npm run smoke` 均退出 **0**。新增 5 项包含于 154 项中。真实取消函数和旧上下文／历史结果回归继续通过。

本轮未重复完整 `release-check` 或 Electron 界面验收：生产改动仅为维护提示定位优先级及注释。下文完整回归属于上一提交 **1b3363b**，不能记为本轮 head 的完整回归通过；远端 CI 以当前 head 的 workflow 为准。未执行用户审查附件或 4×4 图枚举脚本，未读取真实账单或运行中用户数据库。

## PR #229 交叉候选回归

按上轮审查示例，在未经修改的引擎 head `b329f803d6ff59f32e93bbe55c3d2d4cf09857a6` 上先复现，再验证修复：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| L1 → R1/R2、L2 → R1 的交叉歧义 | FAIL，误赋值 R1 并锁定 L2/R1 | PASS，无赋值／锁定，告警包含 L1 一对多和 R1 多对一 |
| 交叉候选下反向 AND 换序 | FAIL，修改与锁定对象改变 | PASS，两种顺序均不接受歧义配对 |
| 歧义组与独立合法配对混合 | FAIL，歧义组也被赋值／锁定 | PASS，仅独立合法配对赋值／锁定 |

这三项从 **0 PASS / 3 FAIL** 变为 **3/3 PASS**。本次新增候选文件共 **6 项**，另覆盖独立合法配对同值锁定、歧义行的后续场景归属／异常来源／行数守恒，以及 3×3 全部 **512 种候选关系**。穷举结合条件顺序、输入行顺序及左右赋值共 **4096 次执行**，均只接受没有共享端点的配对，循环不另计单测数量。

本次候选回归与既有方向、操作符／仓储、C2 引擎及 dispatcher 合计 **110/110 PASS**，上次四项方向回归仍全部通过。复现只使用合成内存行；没有执行用户审查附件中的脚本，也未读取真实账单或运行中数据库。

## PR #229 方向回归

按用户审查示例新增合成内存行测试，在未经修改的引擎 head `f8ae6a4d2761b9bf13608bc680caf015cb097730` 上先复现，再验证修复：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 同向包含对照 | PASS | PASS |
| 后续反向包含不成立，不赋值、不锁定 | FAIL，误赋值并锁定两行 | PASS |
| 后续反向包含成立，赋值正确类型并锁定双方 | FAIL，漏匹配 | PASS |
| 同一类型对的 AND 条件换序 | FAIL，结果改变 | PASS |

上述四项从 **1 PASS / 3 FAIL** 变为 **4/4 PASS**。新增方向文件共 10 项，还覆盖反向等于的异字段数值比较、同类型取值、重叠类型、配对外类型不借值及后续场景处理。与既有 C2 引擎、操作符／仓储及 dispatcher 测试合计 **104/104 PASS**。未读取用户账单或运行中数据库。

## 上一提交的完整回归（1b3363b）

交叉候选修复提交 `1b3363b` 的本地 `npm run release-check` 退出码 **0**，完整执行 lint、smoke、unit、integration。此表为历史结果，未合并本轮新增定位测试。

| 检查 | 结果 |
| --- | --- |
| lint / smoke | PASS |
| unit | 443 个文件；6942 PASS、3 SKIP、0 FAIL，共 6945 项 |
| integration | 全部 53 个脚本通过，2488/2488 断言 |
| 隔离 Electron 界面 | 此前 `f8ae6a4` 实现通过 `node scripts/verify-v3-2-6-dialogs.js`；1080×760，包含下拉 change、布局、长列表滚动及确认取消。此后的修复均未重复执行 |
| scan:vars | PASS；版本调整前、收尾、方向及交叉候选修复后均已刷新统计 |
| check:vars | 版本调整前、收尾和更新 PR 前均已执行；退出码 2 为变量命中，逐项复核见 [关联功能 review](check-vars.md) |
| git diff --check | PASS |

3 个跳过项是现有的 Windows PowerShell / packaged canary 专用探针，未在 macOS 伪造执行结果。真实业务样本、资金归属及运行中应用的人工验收待完成。

## 提 PR 前的重要变量检查

本轮重新执行 `npm run check:vars -- --since e50478314670f52ba2b400f574f82358ece20739 --include-minor`，退出码 2 为变量命中，范围与实现收尾一致。本轮没有版本调整或合并，未重复 scan:vars；最近一次统计刷新属于 1b3363b。

- Important-skeleton：`normalizeCell`。
- Runtime-state：`dialog`、`elements`、`setStatus`；`dialog` 为 renderer 局部 DOM 同名项。
- 按定义文件补充复核 Risk-sensitive 的 `runC2Scenario`、C2 配置链及历史导入状态，见 review 文档。

## 重现命令

```bash
node --test --test-name-pattern='空分段定位' tests/unit/main-process/statement-big-account-maintenance.test.js
node --test tests/unit/main-process/statement-big-account-maintenance.test.js tests/unit/main-process/statement-big-account-preview.test.js tests/unit/main-process/big-account-recognition.test.js tests/unit/main-process/scenario-engines/c2-offset-bill-mark.test.js tests/unit/main-process/scenario-engines/c2-recon-operators.test.js tests/unit/main-process/scenario-engines/c2-recon-field-direction.test.js tests/unit/main-process/scenario-engines/c2-candidate-conflicts.test.js tests/unit/main-process/scenario-dispatcher.test.js
npm run lint
npm run smoke
node --test tests/unit/main-process/scenario-engines/c2-candidate-conflicts.test.js
node --test tests/unit/main-process/scenario-engines/c2-recon-field-direction.test.js
node --test tests/unit/main-process/scenario-engines/c2-candidate-conflicts.test.js tests/unit/main-process/scenario-engines/c2-recon-field-direction.test.js tests/unit/main-process/scenario-engines/c2-recon-operators.test.js tests/unit/main-process/scenario-engines/c2-offset-bill-mark.test.js tests/unit/main-process/scenario-dispatcher.test.js
npm run release-check
node scripts/verify-v3-2-6-dialogs.js
npm run scan:vars
npm run check:vars
```

完整原始日志按仓库 `*.log` 忽略规则保留在本地 `changes/3.2.6/` 下：最初实现的 `release-check.log`、`scan-vars.log`、`check-vars.log`、`check-vars-before-version.log`；方向修复的 `pr229-direction-*.log`；交叉候选修复的 `pr229-candidates-before.log`、`pr229-candidates-targeted.log`、`pr229-candidates-release-check.log`、`pr229-candidates-scan-vars.log`、`pr229-candidates-check-vars.log`。本记录用于 PR 中查看验证结论，日志没有作为代码变更提交。

空分段定位修复的本地日志：`pr229-location-before.log`、`pr229-location-targeted.log`、`pr229-location-lint.log`、`pr229-location-smoke.log`、`pr229-location-check-vars.log`。
