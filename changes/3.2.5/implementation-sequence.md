# v3.2.5 Implementation Sequence

## Authority

- 冻结产品与技术合同：本目录 [spec.md](./spec.md)、[techdoc.md](./techdoc.md)，逐字节来源见 [DOCUMENT-SOURCE.md](./DOCUMENT-SOURCE.md)。
- 版本拆分边界：`changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/v3.2.x-version-split-plan.md`。
- 编码前证据状态：[preflight.md](./preflight.md) 与 [preflight-baseline-validation.json](./preflight-baseline-validation.json)。
- 本文档 bootstrap 作为 v3.2.5 base/E13-A 的祖先，不新增独立功能 PR，不改变既定 8 PR 数量。

## Strict PR Chain

| 顺序 | PR | 范围 | 必须证明 | 明确非目标 |
| --- | --- | --- | --- | --- |
| 1 | E13-A | Pending/BizOP 只读导出 | workbook、列、排序、warning/error 样本与 legacy golden 等价 | 不统一业务 writer，不改 SQL/金额/币种。 |
| 2 | E13-B | PreFund/Position/VCCFin 只读导出 | run/revision/审计血缘与只读 authority 等价 | 不消费 partial/stale run，不改资金匹配算法。 |
| 3 | E13-C | Acquiring copy/regenerate 分类 | actionKey、输入来源、copy/regenerate 静态分离 | 不用文件名或共享 exporter 猜 action。 |
| 4 | E13-D | Pending/BizOP adapters | 无额外 spawn，事务、幂等、取消、恢复零漂移 | 不重写现有模块池。 |
| 5 | E13-E | Acquiring adapter | pool/gate/resume、artifact/receipt 与 legacy 行为等价 | 不泛化为万能 adapter。 |
| 6 | E13-F | Position utility adapter | grant/critical/cancel 映射与 utility process 拓扑等价 | 不改变 position 业务计算。 |
| 7 | E13-G | Manifest/AST coverage 与策略快照 | current-tree validation 29/29、package checksum 精确覆盖 checksum 自身外全部 74 个普通文件、静态 coverage 100%，Capability 与 Effective Production Strategy 分离 | 不自动启用 action，不删除 legacy seam。 |
| 8 | R3.2.5 | 全系列 release evidence、版本元数据与三份发布文档 | 适当完整测试、Windows/观察/人工状态可审计，package/version/docs 一致 | 不合并 main、不创建 tag、不发布 production。 |

## Propagation Rule

每张 PR 必须基于最终前序 head；修复后逐张传播并等待精确新 head CI。旧 head、旧 base 或下游偶然包含前序代码的绿色结果不能替代当前叠栈验证。

每个 action 默认保持 `legacy-preserved` / production disabled。只有本 action 的 capability、receipt/recovery、资源、观察窗口和人工门禁独立满足时，release owner 才能在本实施范围外决定 production strategy。

## Permanent Gates

- 业务 SQL、稳定排序、金额/币种、Workbook、事务、幂等、取消、恢复和进程拓扑零漂移。
- read-only action 不得读取 partial/stale run，也不得绕过 active Recovery Hold。
- unknown/partial inspection 继续进入 `interrupted + Hold`，不能降级为普通 failed。
- 不自动删除 legacy seam；至少一个后续稳定观察版本、无 open Hold/P0、Windows/真实样本充分且有独立 rollback PR 后再评估。
- 资金/恢复红线必须人工复核，自动测试不能替代。
- 按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；任何文档不得把它们写成 PASS。
