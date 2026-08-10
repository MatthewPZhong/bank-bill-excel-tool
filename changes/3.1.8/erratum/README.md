# v3.1.8 上线后纠错补遗索引

> 仓库采用日期：2026-08-11<br>
> 实现版本：v3.1.9<br>
> adoption baseline：`codex/v3.1.9-pr2-task-lifecycle@54b6c01fa93751cd723be53af70af726037343b5`

## 1. 合同文件与来源

| 文件 | document version / date | 原始来源文件名 | raw source SHA-256 | repository copy SHA-256 |
| --- | --- | --- | --- | --- |
| [纠错 Spec v2](./VCC财务OP-3.1.8卡顿与旧归档兼容纠错Spec-v2.md) | `2.0` / `2026-08-10` | `VCC财务OP-3.1.8卡顿与旧归档兼容纠错Spec-v2.md` | `34778f235705ceea9f5a00d732ab3e97d1873d5105e0e4b55908f2ef5917fcf1` | `c4354aa47bf900b7326914db7283034accdf22cb16e89ba20ae2d377f8fc1773` |
| [纠错 TechDoc v1.1](./VCC财务OP-3.1.8卡顿与旧归档兼容纠错TechDoc-v1.1.md) | `1.1` / `2026-08-10` | `VCC财务OP-3.1.8卡顿与旧归档兼容纠错TechDoc-v1.1.md` | `08e9f90600ec81dd881fdb12e4e2fb8a10b39baa9ec01918a08a05509ee84549` | `36353336d23b3c159c983f23081bfd636e0f57709281c201ad04befa24485b3c` |

仓库化只做一项显式等价格式规范化：每份 raw source 的 6 个 metadata header Markdown hard-break（行尾两个空格）改为 `<br>`，共 12 处，以通过全量 `git diff --check`；除此之外内容一致。验证必须先对 raw source 应用同一只读规范化，再与 repository copy 比较，不能用 raw `cmp` 冒充一致性证据。

Spec v2 是产品纠错合同，TechDoc v1.1 是该 Spec 的实施合同；两者必须配套阅读，任何实现偏差先反向同步对应合同，不得静默放宽分类、操作保护或失败关闭边界。

## 2. 历史边界与前向效力

- 已发布的 [`changes/3.1.8/spec.md`](../spec.md) 继续以规范化 SHA-256 `1f5f0663ee35436c8b1f7da628822a4f83a3f70db215cd5ebd60a6720bae367d` 冻结；本目录不改写该文件，也不改写 v3.1.8 的 `6/6 PASS` 发布历史证据。
- 本补遗描述 v3.1.8 上线后发现的问题，但只前向约束 v3.1.9 的实现、验收和发布；不得据此声称已发布的 v3.1.8 installer、portable 或 tag 已包含这些修复。
- v3.1.9 仅将“VCC 归档兼容、操作保护和性能路径”交由本补遗取代；v3.1.9 的其他 C01—C14、PR1 和 PR2 合同保持不变。
- TechDoc 原文中的 `implementation-baseline-candidate` 是文档形成时的来源事实。仓库实际采用基线以上方 `54b6c01f...` 为准；PR2 核心合同若发生变化，后续整条堆叠链必须从新的冻结头 rebase 后再评审。

## 3. 发布门禁

真实 v3.1.7 fixture、目标生产库 legacy-four 分类、Windows packaged SQLite runtime、目标生产 trigger、约 16 GB 性能和财务人工复核均继续是 PROBE。任一 PROBE 失败都不得放宽 classifier/guard、伪造 Pending、绕过 mutation guard 或引入 fallback。
