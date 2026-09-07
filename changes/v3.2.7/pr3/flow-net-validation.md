# 合计流水净额改动验证（2026-09-07）

基线：`1479fc937ad6ae65f5477689edc29d0b108d5c54`。用户已确认允许第 13 列改为入账合计减出账合计，第 14 列改为终止期末减合计；其余业务列、差额和核对结论不变。该确认是范围确认，不是实际业务验收 PASS。

## 自动回归

| 命令（node --test 后的文件） | 通过 | 失败 / 跳过 | 主要覆盖 |
| --- | ---: | --- | --- |
| tests/unit/main-process/biz-op-v327-compute.test.js | 28 | 0 / 0 | 保留原 17 例，独立新 19 列 oracle；其余 18 列、原因和差异集合保持；正负冲正、零、大数和高精度 |
| tests/unit/main-process/biz-op-v327-export-rule-version.test.js | 6 | 0 / 0 | 新旧表头/证据、显式版本错配、未知合同、混入分片拒绝及封存字节不变 |
| tests/unit/main-process/biz-op-v327-export.test.js | 8 | 0 / 0 | 六类输出、72 个损坏反例、精度、零差异及完整原表说明 |
| tests/unit/main-process/biz-op-v327-compute-main.test.js 与 biz-op-v327-export-main.test.js | 26 | 0 / 0 | 真实临时 XLSX / SQLite / worker / Task / Publisher / Archive，取消、来源保留及提交前后进程退出恢复 |
| 合计 | 68 | 0 / 0 | 不累计重复执行轮次 |

`npm run lint`、`git diff --check` 通过。上述测试使用 macOS / Node 24.13.0，实际 SQLite 和后台 worker；没有启动真实数据应用。

## 真实跨版本回放

使用 `git archive 1479fc93 src tests/helpers tests/fixtures package.json assets` 提取未修改的旧代码到独立临时目录，共用已安装依赖。执行：

```bash
node scripts/biz-op-v327/verify-flow-net-upgrade.js /tmp/bizop-flow-net-baseline-gaiOQ3 /tmp/bizop-flow-net-upgrade-evidence
```

脚本每次只在临时目录新建带标记的 Host。基线和当前代码分别运行于独立子进程，正常关闭后重开同一临时数据库。基线用 17 个原批准样例生成真实 XLSX 并导入、计算和导出；当前代码先导出旧结果，再复用原输入计算新结果。逐项 PASS：

- 基线全部 19 列符合原 oracle；原验收夹具未修改。
- 17 行全量和 12 行差异保持；共生成旧 FULL/DIFF、升级后旧 FULL/DIFF、新 FULL/DIFF 六份 XLSX。
- 升级前后旧导出的所有工作表按单元格值、类型、格式及公式逐格相同；旧 rows、notes、manifest 与分片文件 SHA256 均相同。
- 新结果业务行仅第 13 列按入减出变号；第 14/15 列、原因、结论、差异标志和差异集合保持。新 FULL/DIFF 第 14 列使用减法表头；说明页允许记录新计算版本和公式。
- 输入 heads 不变、无重新导入；新指纹生成结果版本 2，未复用版本 1；再次运行复用版本 2、相同 run 和发布时间，结果仍只有两个版本。
- 结束时读取 pin 为 0。

机器记录归档于 [flow-net-upgrade-validation.json](flow-net-upgrade-validation.json)。临时完整证据目录为 `/private/tmp/bizop-flow-net-upgrade-evidence/bizop-flow-net-upgrade-GLSWrh`，包含基线快照、两阶段日志及六份导出文件；临时文件可能被系统回收，可用上述脚本重建。

## 关联功能与边界

check-vars 本轮仅词法命中 Runtime-state `state`，实际是 `export-source.js` 的 SQLite `part_meta.state`，未修改登记的 renderer 全局 state。清单原 review 要点为“任何子字段改动都可能引起 UI 重渲染失效”，要求检查“模板列表 / 当前模块 / 导出可用性”三联动；此次不涉及这些前端状态，新增分片校验已由两版本反例与真实回放验证。无 Critical / Important-skeleton / Risk-sensitive 实际命中。

新规则允许与历史结果共存，保留导入合同和数据库结构。回退旧代码不能解释新版结果，代码回退须先处理新版结果的兼容性，不能将其标作旧版结果。真实输入文件、用户数据库、历史封存结果和安装包均未改写；版本号未变。

本次未重新运行完整 release-check、远端 Windows 成功链、Excel/WPS 人工验收、真实资金或 2200 万行目标规模验收。已有 PR 的历史验证须按各自提交归属解读，不能计为本次 PASS。
