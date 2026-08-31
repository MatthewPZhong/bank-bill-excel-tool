# v3.2.1 Release Metadata Closeout — Preflight

## Task Brief

- Goal：让最终 v3.2.1 分支包含 v3.2.0 正式收口祖先，并携带正确的 package 元数据、权威 Spec/TechDoc 与三份同步发布文档。
- Context：功能 PR #176～#183 已按序合并，但 `package.json`/`package-lock.json` 和三份当前发布文档仍停留在 `3.1.14`；E04-C 第二 Writer gate 已按证据明确拒绝，不是待补功能。
- Constraints：不新增第二 Writer，不改业务 SQL、金额/币种/Workbook/事务/幂等/恢复合同；不启用 production；不合并 main、不创建 tag；按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：v3.2.0 收口为真实祖先；两处 package 版本均为 `3.2.1`；顶层 Spec/TechDoc 与冻结来源逐字节一致；三份发布文档同步记录本版能力、E04-C 拒绝决策与未解除人工门禁；相关定向测试、完整单测与静态校验通过。

## Unknowns Register

| 未知 | 处理 | 当前决定 |
| --- | --- | --- |
| v3.2.0 收口能否只靠文案引用而不进入祖先链 | BLOCK | 不能；使用 merge commit 保留真实祖先。 |
| E04-C 第二 Writer 是否应在收口阶段补做 | BLOCK | 不做；已审查证据明确拒绝，Toolbox 保持单 Writer/FIFO Publisher。 |
| 自动证据能否解除 PreFund 资金/恢复或 Windows 门禁 | BLOCK | 不能；发布文档必须保留人工复核与 production disabled。 |
| 顶层文档是否允许使用主工作区旧 proposal | PROBE | 不允许；只同步冻结基线并记录来源。 |

## 风险优先计划

1. 把最终 v3.2.0 收口以真实 merge 祖先纳入 v3.2.1。
2. 核对 #176～#183 功能/R3/R4 证据及 E04-C 拒绝边界。
3. 同步 package 元数据、权威 Spec/TechDoc 与三份发布文档。
4. 运行字节、JSON、diff、文档交叉校验和适当完整单测；保留人工门禁。
