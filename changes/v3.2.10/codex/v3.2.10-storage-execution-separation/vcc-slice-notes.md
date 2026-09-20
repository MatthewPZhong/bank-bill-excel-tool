# G6 VCC 切片证据

本文件由[本功能实施记录](implementation-notes.md)索引，记录 A1–A3 的独立实施与验证事实，不替代 Spec / TechDoc。功能完整实现状态以主实施记录为准。

代码状态：`codex/v3.2.10-storage-execution-separation`，基线与当前 HEAD 均为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`；本次代码与测试未提交。最终内容指纹见 [vcc-code-state.txt](evidence/vcc-code-state.txt)，代码差异见 [vcc-code.diff](evidence/vcc-code.diff)。平台：macOS，Node `v25.8.0`，依赖复用主工作区 node_modules；全部测试仅使用自建临时数据库/文件。

## A1：锁定 hash、raw contract、lineage 基线

- 实现状态：已实现；验证状态：通过；集成状态：未集成。
- 职责与边界：只新增固定 fixture 与回归测试，运行时生产实现仍为原 row-mapper 和 dataset writer。fixture 在改动生产文件前由基线实际生成，后续测试只读取固定内容，不重新生成期望值。
- 调用方与兼容：A1 测试经原 row-mapper 与 writer 公共导出运行；无消费者迁移，也未移除接口。
- 业务行为：覆盖 [G6-AC-02](spec.md)：recharge、fee、channel v1/v2，Pending v2/v3；raw v1/v2 的字段重排及长度错误；CHANNEL 主体空值/空白/数值；CNH 输入原值与当前规范 hash；中文、CRLF、字面转义字符串；disposition、键、内容与未知版本，以及异常优先级。无业务变更。
- 验证：`node --test tests/unit/backend/vcc-financial-op/mapped-lineage-contract.test.js tests/unit/backend/vcc-financial-op/row-mapper.test.js tests/unit/main-process/vcc-financial-op-dataset-writer.test.js tests/unit/main-process/vcc-financial-op-review-export.test.js`，**70/70 PASS**，退出码 0，见 [A1 基线日志](evidence/vcc-a1-baseline.txt)。该记录只证明提取前基线；后续提取由 A2/A3 最终日志证明。
- 当前规则入口：本切片未改变生产职责，无需新增运行规则或 G8 配置；A2/A3 再落地模块 README。
- 剩余项与回退：A1 无运行时行为，保留固定 fixture；测试最终入口迁至纯模块属于 A2/A3。

## A2：提取 hash 与 lineage 纯模块

- 实现状态：已实现；验证状态：通过；集成状态：未集成。
- 职责与边界：row-mapper 的三 hash 函数/两个版本常量提取到 `content-hash-contract.js`；writer 的版本选择及完整性校验提取到 `mapped-lineage-contract.js`。后者只依赖前者与 definitions，前者只依赖 node:crypto 与 definitions；不加载 IO、DB、worker、Electron 或 Excel。
- 调用方与兼容：row-mapper 保留原名称并直接重导出同一函数对象，保留其 detail importer、数据库迁移、writer/review plan 和测试消费者；writer 的旧 `assertMappedLineage` 导出也指向同一函数对象。未引入 wrapper 或第二份正文；移除旧入口须完成全仓调用清点与兼容评估，本阶段不移除。
- 业务行为：对应 G6-AC-01/02/03。常量、payload 序列化、Pending 顺序/长度及原中文错误完全保留；writer 不再持有 legacy hash 分支正文。无存储 hash 重写，无 schema 或版本迁移。
- 验证：首次提取后固定 fixture **14/14 PASS**，见 [A2 提取日志](evidence/vcc-a2-extraction.txt)。最终冷加载/identity/历史管线补充后的专项测试 **78/78 PASS**，退出码 0，见 [A2/A3 最终 unit 日志](evidence/vcc-a2-a3-final-unit.txt)。冷加载探针在新进程拒绝除 node:crypto、definitions 和两合同之外的所有依赖，实际运行两个纯入口。
- 当前规则入口：[VCC README](../../../../src/backend/vcc-financial-op/README.md) 的“当前入口与边界”“保持的行为与兼容”“验证与后续维护”；根 AGENTS 的“模块现行说明”已增加本 README 导读导航。G8 未集成、机器配置尚不存在；本分支已执行运行时闭包检查，由后续 G8 集成登记边界。原存储/财务专项语义未变，无需改写其正文。
- 剩余项与回退：G8、release 集成及平台验收未进行；A 阶段回退要同时恢复 hash/lineage 来源与所有消费者，禁止只回退纯模块文件。

## A3：切换 writer / review plan 与管线验证

- 实现状态：已实现；验证状态：通过；集成状态：未集成。
- 职责与边界：writer 与 review plan 直接从 mapped-lineage-contract 导入校验，原校验调用点与调用次数未增加。review plan 不再依赖 dataset writer；文件读取、暂存、发布和关闭仍由原编排路径负责。
- 调用方与兼容：生产 assertMappedLineage 的消费者只有 writer 与 review plan，均已迁移；writer 公共导出兼容保留。冷加载 review plan 时封禁 writer 加载并通过。全仓调用清点见 [vcc-callers.txt](evidence/vcc-callers.txt)，原有测试与脚本使用兼容 hash 路径仍通过。
- 业务行为：对应 G6-AC-01/02/03。真实旧版 CNH/CNY 原始数据、Pending 48/46 列、原件篡改、fallback 拒绝、审计原值与导出结果均沿用原路径；未改变金额、币种、取消、归档与输出合同。
- 验证：最终命令 `node --test tests/unit/backend/vcc-financial-op/mapped-lineage-contract.test.js tests/unit/backend/vcc-financial-op/row-mapper.test.js tests/unit/backend/vcc-financial-op/pending-contract-migration.test.js tests/unit/main-process/vcc-financial-op-dataset-writer.test.js tests/unit/main-process/vcc-financial-op-review-export.test.js`，**78/78 PASS**。`node scripts/integration/vcc-financial-op-adjustment-archive-chain.js`，**226/226 PASS**，退出码 0，见 [真实管线日志](evidence/vcc-a3-pipeline.txt)。对五个 VCC 生产文件定向 ESLint 通过、退出码 0，见 [vcc-lint.txt](evidence/vcc-lint.txt)。完整 release-check 不作为每切片重复要求，由主实施记录报告本次实际执行范围；Windows、Excel/WPS、安装包、GUI 未执行，不宣称正式交付验收完成。
- 当前规则入口：同 A2 的 VCC README，并记录实际 writer/review plan 入口、兼容条件、代表性测试与 G8 后续归属。版本设计状态保留为设计来源，实施事实由本记录记录。
- 剩余项与回退：G4 在另一 worktree 仅迁移 writer/review plan 的 rich reader/公共读取 imports、effective reader options 与预算配置；本 G6 仅提取 hash/lineage。G4 已确认不修改这些函数。当前未跨分支合并；后续集成同时保留双方 imports，并重跑合并后受影响测试。A 阶段整体回退按 TechDoc §8，无历史数据迁移或清库动作。
