# Implementation Notes — v3.0.17

## Baseline

- 基线：`main@b599496`，版本 `3.0.16`，PR #89 已合并并归档。
- 最终范围：见 `changes/3.0.17/spec.md`。

## Decisions

| 决定 | 原因 |
|---|---|
| 退款新规则在 S1-S4 后执行 | 不推翻既有高优先级结论 |
| 只救回普通未命中 | 日期异常、多候选等人工结论仍有业务意义 |
| 双向 1:1 先建全局候选关系再决定 | 禁止 first-wins 和金额最接近抢占 |
| 多文件最多 8 组 | 用户确认的界面与资源上限 |
| 新模式目录只选一次、冲突一次确认 | 避免逐文件打断且保证取消零写入 |
| 所有文件临时生成后批量发布 | 保证失败不留下部分结果 |
| 非法金额候选也进入反向未决关系图 | 防止另一条金额正常银行行静默抢占同一退款单 |
| writer abort 等待句柄关闭并重试删除 | 避免 Windows 文件锁导致临时产物残留 |
| 原文件恢复失败时保留备份目录 | 唯一恢复副本优先于“无临时文件”外观 |
| 不新增数据库迁移 | 退款开关进入现有 `config_json`，拆分状态只在弹窗生命周期内 |

## Assumptions

- 文件名校验按 Windows 最严格公共子集执行，使 macOS 生成结果可在目标 Windows 环境使用。
- 文件名扩展名输入大小写不敏感，最终统一为一个 `.xlsx`。
- 多文件分组值仍沿用既有字符串比较语义，不新增模糊或类型转换。

## Deviations

- 原计划要求任一失败都清理临时目录；当操作系统持续阻止被覆盖原文件恢复时，强制清理会删除唯一备份。实现改为返回备份路径并保留恢复目录，已同步 `spec.md` 和 `test-spec.md`。
- 退款公式同时读取 Credit/Debit；现有退款模板只包含 Debit。引擎记录两列为参与匹配候选，最终标黄投影按既有模板列过滤，因此 Credit 不新增到模板、不改变列契约。

## Evidence

- 精确十进制、退款模糊匹配、双向多候选、非法金额未决关系专项：`9/9 PASS`。
- 多 writer、文件名校验、目标目录拒绝、发布回滚与备份保留专项：`59/59 PASS`（`46/46` stream tests 与 `13/13` publish/IPC tests）。
- 退款输出标黄集成回放：`258/258 PASS`。
- 工具箱 XLSX/CSV/XLS/多 sheet worker 回放：`17/17 PASS`。
- 预览：`docs/previews/builtin-fixed-channel-manage-refund.png`、`docs/previews/toolbox-split-field-picker-multiple.png`，已检查桌面尺寸、滚动、控件对齐和浮动值面板。
- 完整 `npm run release-check` 通过：lint、smoke、unit `3625/3625 PASS`，41 个 integration 脚本 `1939/1939 PASS`。
- `npm run scan:vars` 通过：`src/` 193 个 JS 文件、2144 个顶层声明；A-share 338 / A-pair 557 / A-local 1115 / B 895。
- `npm run check:vars -- --include-minor` 完成；命中 `FileValidationError`、`unmatchedRows`、`normalizeCell`、`readRows`、`MODULES`、`dialog`、`elements`、`state`、`bankPaymentSerialFuzzyMatchEnabled`、`normalizeMultiSplitGroups`，已按 `rules/important-variables.md` v22 逐项复核并补充两个契约锚点。
- `npm run startup:measure` 通过：平均 total 736.292 ms、ready-to-show 161.545 ms、window-visible 92.787 ms、renderer init 40.640 ms。

## Remaining Unknowns

- 真实脱敏退款样本尚未提供；最终资金人工复核不能由自动测试替代。
