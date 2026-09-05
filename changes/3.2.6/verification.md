# v3.2.6 验证记录

日期：2026-09-05。环境：macOS、Node 24.13.0。基线：`e50478314670f52ba2b400f574f82358ece20739`；验证对象为本次 3.2.6 实现及 PR #229 的逐条对账字段方向、交叉候选计数修复。

## PR #229 交叉候选回归

按本轮审查示例，在未经修改的引擎 head `b329f803d6ff59f32e93bbe55c3d2d4cf09857a6` 上先复现，再验证修复：

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

## 自动化结果

交叉候选修复后重新执行 `npm run release-check`，退出码 **0**，完整执行 lint、smoke、unit、integration。

| 检查 | 结果 |
| --- | --- |
| lint / smoke | PASS |
| unit | 443 个文件；6942 PASS、3 SKIP、0 FAIL，共 6945 项 |
| integration | 全部 53 个脚本通过，2488/2488 断言 |
| 隔离 Electron 界面 | 此前 `f8ae6a4` 实现通过 `node scripts/verify-v3-2-6-dialogs.js`；1080×760，包含下拉 change、布局、长列表滚动及确认取消。本次方向修复未改 UI，未重复执行 |
| scan:vars | PASS；版本调整前、收尾、方向及交叉候选修复后均已刷新统计 |
| check:vars | 版本调整前、收尾和更新 PR 前均已执行；退出码 2 为变量命中，逐项复核见 [关联功能 review](check-vars.md) |
| git diff --check | PASS |

3 个跳过项是现有的 Windows PowerShell / packaged canary 专用探针，未在 macOS 伪造执行结果。真实业务样本、资金归属及运行中应用的人工验收待完成。

## 提 PR 前的重要变量检查

自动扫描命中与实现收尾一致：

- Important-skeleton：`normalizeCell`。
- Runtime-state：`dialog`、`elements`、`setStatus`；`dialog` 为 renderer 局部 DOM 同名项。
- 按定义文件补充复核 Risk-sensitive 的 `runC2Scenario`、C2 配置链及历史导入状态，见 review 文档。

## 重现命令

```bash
node --test tests/unit/main-process/scenario-engines/c2-candidate-conflicts.test.js
node --test tests/unit/main-process/scenario-engines/c2-recon-field-direction.test.js
node --test tests/unit/main-process/scenario-engines/c2-candidate-conflicts.test.js tests/unit/main-process/scenario-engines/c2-recon-field-direction.test.js tests/unit/main-process/scenario-engines/c2-recon-operators.test.js tests/unit/main-process/scenario-engines/c2-offset-bill-mark.test.js tests/unit/main-process/scenario-dispatcher.test.js
npm run release-check
node scripts/verify-v3-2-6-dialogs.js
npm run scan:vars
npm run check:vars
```

完整原始日志按仓库 `*.log` 忽略规则保留在本地 `changes/3.2.6/` 下：最初实现的 `release-check.log`、`scan-vars.log`、`check-vars.log`、`check-vars-before-version.log`；上轮方向修复的 `pr229-direction-*.log`；本轮交叉候选修复的 `pr229-candidates-before.log`、`pr229-candidates-targeted.log`、`pr229-candidates-release-check.log`、`pr229-candidates-scan-vars.log`、`pr229-candidates-check-vars.log`。本记录用于 PR 中查看验证结论，日志没有作为代码变更提交。
