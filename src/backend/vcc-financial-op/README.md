# VCC 纯 hash 与映射血缘合同

本页记录已经落地的纯合同入口；VCC 文件读取、数据存储、行映射和导出仍由各自模块负责。设计与阶段证据分别见 [G6 Spec](../../../changes/v3.2.10/codex/v3.2.10-storage-execution-separation/spec.md)、[TechDoc](../../../changes/v3.2.10/codex/v3.2.10-storage-execution-separation/techdoc.md) 和[实施记录](../../../changes/v3.2.10/codex/v3.2.10-storage-execution-separation/implementation-notes.md)。

## 当前入口与边界

| 入口 | 唯一职责与允许依赖 | 副作用与限制 |
| --- | --- | --- |
| [content-hash-contract.js](content-hash-contract.js) | 导出 `HASH_VERSION`、`PENDING_HASH_VERSION`、`contentHash`、`pendingCanonicalValues`、`pendingContentHash`；只依赖 `node:crypto` 与 [definitions.js](definitions.js)。 | 输入值计算与复制；不得依赖 row-mapper、文件系统、数据库、worker、Electron、Excel 库。 |
| [mapped-lineage-contract.js](mapped-lineage-contract.js) | 导出 `assertMappedLineage(expected, mapped)` 与 `mappedContentHashForStoredVersion(expected, mapped)`；只依赖 content-hash-contract 与 definitions。 | 不写入状态、不重算或更新存储中的 hash；不读取原文件，不打开数据库，不执行导出。 |
| [row-mapper.js](row-mapper.js) | 保留日期、币种、金额映射及业务行构造，使用并直接重导出 hash 合同函数和常量。 | 此模块仍可能通过日期规范化加载 Excel 库；只需纯 hash 的新调用方应直接引用 content-hash-contract。 |
| [dataset writer](../../main-process/vcc-financial-op-dataset-writer.js) / [review-export-plan.js](review-export-plan.js) | 原路径负责读取/重建及导出编排，直接调用同一个 assertMappedLineage。 | IO/DB 权限仍属于原编排模块；纯校验不获得读取、发布、存储或资源关闭权限。review plan 不再为校验加载 writer。 |

## 保持的行为与兼容

普通 hash 版本仍为 `2`，Pending hash 版本仍为 `3`。普通旧版本 `1` 与 Pending 旧版本 `2` 按原算法重建；Pending 原始合同 `1`/`2` 保留各自字段数量与映射顺序。CHANNEL 主体仍以原有空值转空串、`String`、`trim` 规则进入 JSON payload；原值、金额和币种规范化顺序未调整。

`assertMappedLineage` 成功返回 `undefined`；失败保留 `archive-row-integrity-failure` 及原中文信息。存在 `disposition` 时先报告不一致；无 disposition 时先识别 hash 版本/重建旧 hash，再比较幂等键与内容，保留原错误优先级。

row-mapper 的旧导出及 dataset writer 的 `assertMappedLineage` 直接引用新模块函数对象，保留现有生产、测试和脚本调用兼容。迁移前先清点这些消费者；没有完成调用方迁移与兼容评估时不能删除。纯合同没有第二份兼容函数正文，也不会通过兼容导出重复校验。

## 验证与后续维护

- [固定 hash/lineage 合同测试](../../../tests/unit/backend/vcc-financial-op/mapped-lineage-contract.test.js)：固定基线输出、所有旧新版本、Pending 字段错误、异常优先级、兼容对象 identity、纯依赖冷加载，以及 review plan 不加载 writer。
- [row mapper 测试](../../../tests/unit/backend/vcc-financial-op/row-mapper.test.js)、[Pending 历史迁移测试](../../../tests/unit/backend/vcc-financial-op/pending-contract-migration.test.js)：验证既有映射及历史兼容路径。
- [dataset writer 测试](../../../tests/unit/main-process/vcc-financial-op-dataset-writer.test.js)、[review export 测试](../../../tests/unit/main-process/vcc-financial-op-review-export.test.js)：真实临时 SQLite/XLSX 的导出、原件血缘、旧版本和异常路径。
- [调整及归档链集成测试](../../../scripts/integration/vcc-financial-op-adjustment-archive-chain.js)：保留真实导入、归档和 dataset 导出管线；实际执行结果见实施记录。

本分支尚未集成 G8，`architecture/boundaries.json` 与 `legacy-allowlist.json` 尚不存在；当前冷加载检查已经约束纯模块的实际依赖。G8 集成时由其维护者登记已落地的两纯模块及传递依赖，不将本页作为机器规则已激活的证据。

G4 并行改动由 XLSX 公共入口负责读取机制及资源/预算；G6 负责 hash/lineage 函数及其 imports。合并两个分支时同时保留上述改动，并针对合并内容重跑相关管线；本分支没有预先合入 G4。
