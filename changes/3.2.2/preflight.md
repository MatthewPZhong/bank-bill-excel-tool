# v3.2.2 Release Metadata Closeout — Preflight

## Task Brief

- Goal：让最终 v3.2.2 分支携带正确的 package 元数据、权威 Spec/TechDoc 与三份同步发布文档。
- Context：功能 PR #184～#191 已按序合并，但 `package.json`/`package-lock.json` 仍为 `3.1.14`，顶层 `changes/3.2.2` 尚未进入版本分支；审计同时发现最终 v3.2.0/v3.2.1 分支也遗漏各自元数据收口，因此必须先形成对应收口提交，再作为真实祖先进入 v3.2.2。
- Constraints：不改业务代码、金额/币种/Workbook/事务/幂等/恢复合同；不启用 production；不合并 main、不创建 tag；按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：最终 v3.2.0/v3.2.1 收口是当前分支真实祖先；两处 package 版本均为 `3.2.2`；v3.2.0～v3.2.2 顶层 Spec/TechDoc 与各自冻结来源逐字节一致；`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md` 按版本顺序同步记录能力与未解除的人工门禁；定向与完整验证通过。

## Unknowns Register

| 未知 | 处理 | 当前决定 |
| --- | --- | --- |
| 功能链合并后是否仍存在代码实现缺口 | PROBE | 复用 #184～#191 的精确合并与 release evidence；本节点不补业务实现。 |
| 补齐旧版本元数据时能否只复制文案而不建立祖先关系 | BLOCK | 不能；v3.2.0、v3.2.1 收口必须依次成为 v3.2.2 的真实 Git 祖先，后续版本也必须基于最终 v3.2.2 重新叠栈。 |
| 自动证据能否解除资金/恢复或 Windows 门禁 | BLOCK | 不能；发布文档必须保留人工复核与 production disabled。 |
| 顶层文档是否允许重写冻结语义 | PROBE | 不允许；只做逐字节同步并记录来源。 |

## 风险优先计划

1. 核对最终 v3.2.0、v3.2.1 收口提交，并依次建立到 v3.2.2 的真实祖先链。
2. 同步 v3.2.2 package 元数据和权威 Spec/TechDoc。
3. 同步三份发布文档并保留三代历史，不把 dormant capability 表述为 production enabled。
4. 做祖先、字节、JSON、diff、文档交叉与适当完整验证；保留人工门禁。
