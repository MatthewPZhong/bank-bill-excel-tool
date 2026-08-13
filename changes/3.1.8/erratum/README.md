# v3.1.8 上线后纠错补遗索引

> 仓库采用日期：2026-08-11；合同修订日期：2026-08-13<br>
> 实现版本：v3.1.9<br>
> adoption baseline：`codex/v3.1.9-pr2-task-lifecycle@54b6c01fa93751cd723be53af70af726037343b5`

## 1. 合同文件与来源

| 文件 | document version / date | 原始来源文件名 | raw source SHA-256 | repository copy SHA-256 |
| --- | --- | --- | --- | --- |
| [纠错 Spec v2.1](./VCC财务OP-3.1.8卡顿与旧归档兼容纠错Spec-v2.md) | `2.1` / `2026-08-13` | `VCC财务OP-3.1.8卡顿与旧归档兼容纠错Spec-v2.md` | `34778f235705ceea9f5a00d732ab3e97d1873d5105e0e4b55908f2ef5917fcf1`（v2.0 原始来源） | `89906e2991341aec70883170225c7f57cdebdccbd3c0835d09de1fe1a50469b0`（v2.1 当前合同） |
| [纠错 TechDoc v1.2](./VCC财务OP-3.1.8卡顿与旧归档兼容纠错TechDoc-v1.1.md) | `1.2` / `2026-08-13` | `VCC财务OP-3.1.8卡顿与旧归档兼容纠错TechDoc-v1.1.md` | `08e9f90600ec81dd881fdb12e4e2fb8a10b39baa9ec01918a08a05509ee84549`（v1.1 原始来源） | `5970faae090ab891e0cdd55001e6cbb701822266177c67ec1da60341865f4c67`（v1.2 当前合同） |

v2.0/v1.1 首次仓库化只做一项显式等价格式规范化：每份 raw source 的 6 个 metadata header Markdown hard-break（行尾两个空格）改为 `<br>`，共 12 处。2026-08-13 起，仓库副本已由用户新需求正式修订为 Spec v2.1/TechDoc v1.2，不再与原始来源逐字节等价；原 raw SHA 仅保留 provenance，当前 repository SHA 才代表有效前向合同。

Spec v2.1 是产品纠错合同，TechDoc v1.2 是该 Spec 的实施合同；两者必须配套阅读，任何实现偏差先反向同步对应合同，不得静默放宽分类、操作保护、币种/行数守恒或失败关闭边界。文件名为兼容既有仓库链接不改名，正文 metadata 是版本真相。

## 2. 历史边界与前向效力

- 已发布的 [`changes/3.1.8/spec.md`](../spec.md) 继续以规范化 SHA-256 `1f5f0663ee35436c8b1f7da628822a4f83a3f70db215cd5ebd60a6720bae367d` 冻结；本目录不改写该文件，也不改写 v3.1.8 的 `6/6 PASS` 发布历史证据。
- 本补遗描述 v3.1.8 上线后发现的问题，但只前向约束 v3.1.9 的实现、验收和发布；不得据此声称已发布的 v3.1.8 installer、portable 或 tag 已包含这些修复。
- v3.1.9 将“VCC 归档兼容、操作保护、性能路径，以及 2026-08-13 CNY/异常数据过滤修订”交由本补遗取代；v3.1.9 的其他 C01—C14、PR1 和 PR2 合同保持不变。
- TechDoc 原文中的 `implementation-baseline-candidate` 是文档形成时的来源事实。仓库实际采用基线以上方 `54b6c01f...` 为准；PR2 核心合同若发生变化，后续整条堆叠链必须从新的冻结头 rebase 后再评审。

## 3. 发布门禁

真实 v3.1.7 fixture、目标生产库 legacy-four 分类、Windows packaged SQLite runtime、目标生产 trigger、约 16 GB 性能和财务人工复核均继续是 PROBE。任一 PROBE 失败都不得放宽 classifier/guard、伪造 Pending、绕过 mutation guard 或引入 fallback。

CNY 修订另要求真实主体九币种、混合异常文件、历史 CNH 月迁移前后金额守恒、结果模板及 Excel/WPS 显示的财务人工复核；本地自动化和用户样本临时库导入不能替代该门禁。
