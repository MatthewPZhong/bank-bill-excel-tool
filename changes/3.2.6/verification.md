# v3.2.6 验证记录

日期：2026-09-05。环境：macOS、Node 24.13.0。基线：`e50478314670f52ba2b400f574f82358ece20739`；验证对象为本次 3.2.6 实现。

## 自动化结果

`npm run release-check` 退出码 **0**，完整执行 lint、smoke、unit、integration。

| 检查 | 结果 |
| --- | --- |
| lint / smoke | PASS |
| unit | 441 个文件；6926 PASS、3 SKIP、0 FAIL，共 6929 项 |
| integration | 全部 53 个脚本通过，2488/2488 断言 |
| 隔离 Electron 界面 | `node scripts/verify-v3-2-6-dialogs.js` PASS；1080×760，包含下拉 change、布局、长列表滚动及确认取消 |
| scan:vars | PASS；版本调整前和收尾均已刷新统计 |
| check:vars | 版本调整前、收尾和提 PR 前均已执行；退出码 2 为变量命中，逐项复核见 [关联功能 review](check-vars.md) |
| git diff --check | PASS |

3 个跳过项是现有的 Windows PowerShell / packaged canary 专用探针，未在 macOS 伪造执行结果。真实业务样本、资金归属及运行中应用的人工验收待完成。

## 提 PR 前的重要变量检查

自动扫描命中与实现收尾一致：

- Important-skeleton：`normalizeCell`。
- Runtime-state：`dialog`、`elements`、`setStatus`；`dialog` 为 renderer 局部 DOM 同名项。
- 按定义文件补充复核 Risk-sensitive 的 `runC2Scenario`、C2 配置链及历史导入状态，见 review 文档。

## 重现命令

```bash
npm run release-check
node scripts/verify-v3-2-6-dialogs.js
npm run scan:vars
npm run check:vars
```

完整原始日志按仓库 `*.log` 忽略规则保留在本地 `changes/3.2.6/` 下：`release-check.log`、`scan-vars.log`、`check-vars.log`、`check-vars-before-version.log`。本记录用于 PR 中查看验证结论，日志没有作为代码变更提交。
