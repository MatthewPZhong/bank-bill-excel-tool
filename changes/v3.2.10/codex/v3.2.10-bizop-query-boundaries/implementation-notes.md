# G5 BizOP 查询边界实施记录

本文件是 Q1–Q4 的唯一实施索引。需求与验收见 [Spec](spec.md)，接口与切片见 [TechDoc](techdoc.md)，完成标准见[总索引 §6.2–§6.4](../../README.md#slice-completion)。设计文档从主工作区复制，保留原设计状态；下列状态单独记录实际实现和证据。

## 基线与工作边界

- 分支：`codex/v3.2.10-bizop-query-boundaries`。
- 独立 worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-bizop-query-boundaries`。
- 基线与当前 HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`（本地 `main` / `v3.2.9`）。所有实现暂为未提交差异；未提交、推送、合并、开 PR、升版或发布。
- 主工作区未提交的 G1–G8 设计及耦合审查引用作为设计输入复制；未将其他分支源码带入。G2、G8 不在本 worktree 中，集成状态为未集成。
- G2 兼容策略：ArchiveRepository 只追加 `hasOtherArtifactForBlob`，保留构造、导出、装配及其他方法；集成时按方法合并，不覆盖其归档装配成果。

## 决策与范围

- 查询沿用同一个 catalog 连接，同步即时执行，不缓存、不另建事务或准入。迭代器在原同步回调内消费，提前退出由 `for...of` 关闭。
- compute/export/import 的事实读取及 delete `collect` 迁到 query；业务校验、指纹、预算、准入与原命令所有者不变。
- delete 的 `get/create/bind` 自有预览表命令及附属读取合法保留；catalog 命令、恢复与其他本域实现不扩大迁移。
- G8 尚未接入；本分支记录迁移作用域、合法保留项与证据，后续由 G8 集成者登记 Q1/Q2/Q3 子边界，不能把本地扫描写成机器规则 active。

## 切片状态

| 切片 | 实现 | 验证 | 集成 |
| --- | --- | --- | --- |
| Q1 归档引用查询 | 已实现 | 通过 | 未集成 |
| Q2 compute/export 查询入口 | 已实现 | 通过 | 未集成 |
| Q3 delete/import 事实读取 | 已实现 | 通过 | 未集成 |
| Q4 边界复核及合法命令清单 | 已实现（本分支范围） | 本分支检查通过；G8 待集成 | 未集成 |

Q1–Q3 已完成本分支实现及必要验证；Q4 已完成迁移清点、现行规则入口和合法命令登记。G8 机器规则激活、G2/release 组合验证仍是明确后续项，当前不标为已集成或 PR-ready。

## Q1：归档引用存在性查询

- 代码状态：上述 HEAD + 未提交差异；最终逐文件摘要及完整代码差异见 `evidence/implementation-snapshot.json`、`evidence/implementation.patch`。
- 职责与边界：`delete-preview.collect` 原跨域 `archive_artifacts` SELECT → `catalog.archive.hasOtherArtifactForBlob`；SQL 由 `src/backend/database/archive-repository.js` 持有。新增方法只有同步 `Boolean(get(...))`，没有写权限、状态过滤或删除授权。
- 调用方与兼容：唯一生产消费者是 collect；本分支未修改 ArchiveRepository 构造、exports、schema 或其他方法。保留 `listArtifactsByBlob` 给原消费者，不用于此计数。G2 归档装配尚未集成，之后按方法合并，禁止整文件覆盖。
- 业务行为：G5-AC-01；排除自身、其他任意状态/owner 引用及无 blob 短路保持；不改变 managed-only、hold 或删除资格。
- 验证：`node --test tests/unit/backend/archive-blob-reference-query.test.js tests/unit/backend/database/archive-repository.test.js`，35/35 PASS（新增 5、原仓储 30，0 skip）。真实临时磁盘库覆盖 ready/pending/failed、跨 owner、无引用、自身排除；20,000 引用下确认只用 LIMIT 1/get，禁止 all/iterate/run/exec。完整删除保护等价另见集成证据。
- 当前规则入口：`AGENTS.md` 架构摘要 → `src/main-process/biz-op-v327/README.md`「已落地入口与所有权」。G8 Archive 子边界未接入；集成 G8 时登记 archive 查询方法、collect 消费者及上述测试。不改 `run-scoped-data-policy.md`，因为未新增存储或改生命周期。
- 剩余项与回退：G2/release 组合验证待后续集成。整体回退该方法和 collect 调用，不移除其他 Archive 方法；无需数据迁移。

## Q2：领域查询与 compute/export

- 代码状态：同一 HEAD + dirty；新增 `catalog-queries.js`，`catalog.js` 公开 frozen queries，compute/export 接入。
- 职责与边界：同一个 db 上的 SQL 与行投影归 query；compute 的 required/missing、hold/hash/manifest、预算、fingerprint，export 的 schema/owner/manifest/历史规则/RAW 文件校验保留在原模块。query 不返回连接或 statement，也不增加准入、事务、文件 IO 或结果缓存。
- 调用方与兼容：已迁 collectInputs/freezeExportSource；`catalog.db` 和原 catalog commands 保留，尚未迁移者见模块 README 与 Q4 逐 SQL 清单。`export-rule-version.test.js` 的手工 catalog fixture 显式注入真实 queries；自动报告 beforeStart 故障夹具改为 query 抛错，原 raw DB 夹具在迁移后已复现失败，修订后该套件 46/46 PASS；生产不提供 raw DB fallback。旧内部函数导出名不变。
- 业务行为：G5-AC-02/03/06/08；ACTIVE/PUBLISHED/READY、RESULT 恰好两个端点、诊断 Boolean 投影、源顺序、错误优先级不变。来源 generator 在预算失败、break/throw/return 时关闭原 SQLite iterator。快照依旧由 canonicalJsonSnapshot 排序编码，未加入 query 内部字段。
- 验证：`node --test tests/unit/main-process/biz-op-v327-catalog-queries.test.js`，11/11 PASS、0 skip；真实 SQLite 状态/投影/无缓存/query_only、端点不完整、iterator 释放、4096 预算和完整导出 JSON。既有 compute/export/rule-version/phase-admission 包含于下方 58/58 协调器回归；冻结 JSON、fingerprint 和负例还与三份固定基线 oracle 完整对比。
- 当前规则入口：模块 README「已落地入口与所有权」「边界检查与兼容」。G8 compute/export 子边界未接入，后续 required consumers 为这两个实际文件；不能把未迁移 metadata/ipc 当作受保护文件的豁免。
- 剩余项与回退：后续 G8 登记；回退整个 query 接口及消费者切片，保留原任务排空要求。未更改业务算法或持久化版本。

## Q3：删除事实读取与导入诊断

- 代码状态：同一 HEAD + dirty；修改 delete-preview/import-main，复用 Q2 queries。
- 职责与边界：collect 的 dataset/source/run/artifact 事实走 query，Archive 引用走仓储；selection、Set 顺序、charge、闭包、输出名称与保护计数仍在 collect。get/create/bind 继续拥有预览表命令。import 的 dispatch/diagnostic 读取走 query，关闭链、唯一 producer、样本核验、register/retireDiagnostic 留在原编排/保护模块。
- 调用方与兼容：迁移 restoreDiagnostic 的 dispatch/existing 以及 runImport 的 manifest_digest/sample_count 读取。诊断保留 snake_case 原值，不作隐式数值/Boolean 转换；query 返回空时不删除文件。delete 五处自有表 SQL 和同域未迁移 commands/recovery 保留，清单在 Q4。
- 业务行为：G5-AC-04/05/06/08；闭包只装配原字段，新 source 投影字段不加入 digest；selection 4096、charge 4096/49152、closure 65536、response 131072、TTL 10分钟与未确认 64 个不变。确认仍检查 generation、完整闭包、过期、模式、复用，bind 仍 assertExclusive。保留两种删除模式、历史结果保护与成功空诊断原维护回收。
- 验证：既有 delete-main/import-main 包含于 58/58；新增 `node --test tests/unit/main-process/biz-op-v327-import-query.test.js` 为 3/3 PASS、0 skip，见 [日志](evidence/import-query-tests.log)。实测 producer job/session/digest 变化重读拒绝、关闭先于 query、producer 缺失先于 existing 报告读取、真实样本损坏先于登记；读取协调器索取 db 会抛错。新集成精确触发字节/条数边界及过期/复用/保护变化，不只比较前缀；空诊断实测 RETIRED/PENDING → 独立 maintenance reclaim Task → DONE/succeeded/DELETED 及真实目录消失。
- 当前规则入口：模块 README 对应职责和合法预览命令章节；G8 collect/import 子边界未接入，后续合法 allowedSites 应是 get/create/bind 五个语句位置，不能豁免整个 delete-preview。
- 剩余项与回退：G8/release 组合验证；按完整调用切片回退，不改 schema、hold、资格或恢复策略。

## Q4：剩余 SQL、规则入口与实现审查

- 代码状态：同一 HEAD + dirty；生产代码不再扩大范围。新增模块 README，根 AGENTS 只加导航；本 worktree 总索引 §6.4 仅把 G5 入口改成“已建立”，其他项仍是设计输入。
- 职责与边界：AST 清点受保护读取作用域 raw 属性调用为 0；delete-preview 的五处 SQL 均仅访问自有预览表。整个 BizOP 目录清点到 243 处 prepare/exec 调用，包含 query、本域命令/恢复，以及候选/工作/封存 part 的非 catalog SQLite；不把所有 SQL 误判成旁路。
- 调用方与兼容：逐位置、具名函数、SQL 表达式见 [query-boundary-inventory.json](evidence/query-boundary-inventory.json)，每个保留模块的责任和移除条件见模块 README。范围外明确包括 compute-main 的重复运行查询、metadata、IPC 命名预检、auto-error-report、protection、preservation、reclaim、publication、recovery、archive-owner 与 upgrade，不让它们成为新跨域入口。
- 业务行为：G5-AC-07；当前命令仍可工作，无 public API/schema/state 变化；本次不发明新的统一 command 框架。
- 验证：`node changes/v3.2.10/codex/v3.2.10-bizop-query-boundaries/evidence/query-boundary-inventory.cjs`，输出 `protectedRawAccesses=0, previewCommandSites=5, inventorySites=243`、退出码 0。该脚本是一次性清点，只覆盖明确属性位置，不声称等价于 G8 的 alias/闭包/动态 SQL 正反例。实现审查见 [review.md](review.md)：未发现需修改的 P1/P2；Q1 作者自核、Q2/Q3 非实现者复核的来源分别标明。
- 当前规则入口：人读入口已经落地；`architecture/boundaries.json`、`legacy-allowlist.json` 和 `check:architecture` 在此基线不存在，不能伪造 active。按总索引 §6.2，G8 集成者负责把 Q1/Q2/Q3 实际边界逐项登记、补合法命令 AST 指纹和别名正反例。G5 提供消费者/接口/测试/清单，不把此义务解释成“不适用”。
- 剩余项与回退：G8 联动属于后续集成，不宣称 ARCH-BIZOP-QUERY 全套机器规则已经交付；文档随实际回退切片同步。

## 验证汇总与验收映射

所有命令均显式以本 worktree 为工作目录。环境为 macOS / Darwin arm64，Node v25.8.0；测试只使用自建临时库、归档与文件。未打开用户真实数据库。

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 新归档 query + 原 ArchiveRepository 单测 | 35/35 PASS，0 skip | [实现审查记录](review.md)，[汇总](evidence/test-results.json) |
| 新领域 query 单测 | 11/11 PASS，0 skip | [汇总](evidence/test-results.json) |
| compute-main/export-main/export-rule-version/delete-main/import-main/phase-admission 六组 | 58/58 PASS，0 skip | [完整运行日志](evidence/coordinator-tests.log) |
| 自动报告与 beforeStart 故障回归 | 46/46 PASS，0 skip | [修订前失败](evidence/auto-report-fixture-before.log)、[修订后日志](evidence/auto-report-tests.log) |
| 新 import-query 负向单测 | 3/3 PASS，0 skip | [完整运行日志](evidence/import-query-tests.log) |
| G5 基线等价集成 | 9/9 PASS、0 skip、exit 0 | [日志](evidence/integration-tests.log)、[快照](evidence/integration-snapshot.json) |
| `npm run lint` | PASS | [日志](evidence/lint.log) |
| 本分支 Q4 AST 清点 | PASS，0 受保护 raw 访问，5 合法 preview 命令 | [清单与范围限制](evidence/query-boundary-inventory.json) |
| `node scripts/check-background-execution-manifest.js` | FAIL：基线遗留 E13-G Action Manifest drift | [当前失败](evidence/action-manifest.log)、[纯基线复核](evidence/baseline-action-manifest.json) |

单测合计 153/153；集成以场景组计数，每组包含完整数据及多项断言，不混充单测数。G5-AC-01 对应 Q1 与真实共享引用集成，AC-02/03/06/08 对应 query/coordinator/完整基线等价，AC-04/05 对应删除与诊断回归，AC-07 的本分支迁移清点/合法命令完成；G8 机器执行规则需后续集成。

### 基线问题与验证边界

- 未修改的 `11086a3c` 通过 `git archive` 放入隔离临时源码快照后，执行原 action-manifest 检查同样失败（exit 1）。旧清单 54 个 action，而当前代码要求 67 个；本项未动生成器、策略或装配。保留失败证据，未顺带刷新历史 artifact。该问题需 release/G7 受控刷新与完整门禁处理。
- 未执行完整 `release-check`；本次是功能实现交付，未请求 PR-ready/发布，且上述已有 gate 失败已知。局部 153 单测与集成结果不代替完整 release-check。
- 未执行 Windows/Excel/WPS、安装包或真实 Electron GUI 验收；没有 UI/文件列合同变更。后续平台验收与 release 组合验证仍须运行实际环境。
- 预算极值采用真实 SQLite 元数据夹具，不代表导入 4096 个 XLSX 的性能验收。七类导出的基线等价针对完整冻结输入；生成文件另做全工作表读回，未声称新旧导出文件逐单元格金样等价。
- 固定 oracle 只包含被迁移的三个旧协调器，逐字节对应 `11086a3c`，依赖按当前未改动实现解析；不把它称为整套旧应用回放。生产没有双读。
- 独立测试审查要求补强 JSON 序列化顺序比较、RAW 修复前相同故障初态；修订和最终重跑结果保存在集成证据。目录持久化能力不足的平台必须明确区分未执行场景，不模拟 fsync 成功。

- 集成脚本的 5 组持久化成功场景按宿主真实 fsync 能力分流，4 组 SQL/预算场景继续运行，skip 不计入 PASS；本机 9 组全部执行。尚未扩展现有仅覆盖早期分支的 POSIX CI 条件，发布集成时需保证成功路径在实际受支持宿主执行，不能仅靠 Windows 上的跳过结果。
