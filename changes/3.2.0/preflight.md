# v3.2.0 Release Metadata Closeout — Preflight

## Task Brief

- Goal：让最终 v3.2.0 分支携带正确的 package 元数据、权威 Spec/TechDoc 与三份同步发布文档。
- Context：功能 PR #168～#175 已按序合并，但 `package.json`/`package-lock.json` 和三份当前发布文档仍停留在 `3.1.14`，顶层 `changes/3.2.0` 尚未进入版本分支。
- Constraints：不改业务代码、金额/币种/Workbook/事务/幂等/恢复合同；不启用 production；不合并 main、不创建 tag；按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：两处 package 版本均为 `3.2.0`；顶层 Spec/TechDoc 与冻结来源逐字节一致；`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md` 同步记录本版能力与未解除的人工门禁；相关定向测试、完整单测与静态校验通过。

## Unknowns Register

| 未知 | 处理 | 当前决定 |
| --- | --- | --- |
| 功能链合并后是否仍存在代码实现缺口 | PROBE | 复用 #168～#175 的精确合并与 R3/R4 evidence；本节点不补业务实现。 |
| 自动证据能否解除资金/恢复或 Windows 门禁 | BLOCK | 不能；发布文档必须保留人工复核与 production disabled。 |
| 顶层文档是否允许使用主工作区旧 proposal | PROBE | 不允许；只同步冻结基线并记录来源。 |
| v3.1.14 历史测试能否永久锁死当前 package/header | PROBE | 不能；历史证据继续严格校验，当前 header 跟随稳定 package version。 |

## 风险优先计划

1. 核对最终 v3.2.0 分支、冻结文档来源和旧版本元数据缺口。
2. 同步 package 元数据和权威 Spec/TechDoc。
3. 同步三份发布文档，不把 dormant capability 表述为 production enabled。
4. 修正仅针对“当前版本”的旧测试锁定，同时保留 v3.1.14 历史发布证据。
5. 做字节、JSON、diff、文档交叉校验和适当完整单测；保留人工门禁。
