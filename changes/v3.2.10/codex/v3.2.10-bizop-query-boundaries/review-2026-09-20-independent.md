# G5 BizOP 查询与归档数据边界：分支独立审查

审查日期：2026-09-20。目标分支：`codex/v3.2.10-bizop-query-boundaries`。

**结论：在本次冻结的未提交实现中，未发现可操作的新增缺陷或 G5 本分支范围内的必改项。** Q1–Q3 的查询迁移保持既有业务语义，Q4 的本地清点、合法命令说明及 G8 后续归属与设计一致。本轮独立重跑相关单测 **153/153 PASS**、基线等价集成 **9/9 PASS**，均为 0 skip；lint 通过。

本结论限定于当前 G5 实现及专项验证。完整 `release-check`、其他治理分支组合验证和平台验收尚未完成，不能据此宣布 PR-ready 或可发布。Action Manifest 检查仍有已复现的基线遗留失败，具体边界见下文。

**审查快照与授权边界**

| 项目 | 本轮事实 |
| --- | --- |
| 原工作区 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-bizop-query-boundaries` |
| HEAD、`main` merge-base、`v3.2.9^{commit}` | 均为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 提交边界 | `main..codex/v3.2.10-bizop-query-boundaries` 无额外提交；实际实现位于该分支 dirty 工作区 |
| 冻结方式 | `git archive HEAD` 后覆盖已修改及未跟踪文件；在独立临时快照运行测试，依赖复用现有 `node_modules` |
| 实现范围 | 7 个生产 JS 文件、模块 README、AGENTS 导航、相关单测、集成脚本及 3 份基线 fixture；实施清单共 18 个文件 |
| 依据 | 本分支 [Spec](spec.md)、[TechDoc](techdoc.md)、[实施记录](implementation-notes.md)、[总索引切片完成标准](../../README.md#slice-completion) |
| 收尾一致性 | 初始覆盖的 63 个文件全部与原工作区 SHA-256 匹配；HEAD 未变化。包含作为设计输入复制的其他文档，不将其视作本分支新增生产实现 |
| 本轮写入 | 仅新增本审查文档与 `review-2026-09-20-evidence/`；未修改生产代码、测试、Spec、TechDoc、原审查或实施记录，未提交、推送、合并、开 PR 或升版 |

完整 dirty 清单、逐文件摘要和初始状态保存在 [snapshot.json](review-2026-09-20-evidence/snapshot.json)。已跟踪差异保存为 [tracked-changes.patch](review-2026-09-20-evidence/tracked-changes.patch)；新增源码、测试、fixture 及所依据文档另存于 [reviewed-files.tar.gz](review-2026-09-20-evidence/reviewed-files.tar.gz)，避免只保存 tracked patch 而遗漏新 query 模块。

**需求与实现核对**

| 验收条件 | 结论与主要证据 |
| --- | --- |
| G5-AC-01：归档引用查询所有权 | `delete-preview.collect` 已委托 `ArchiveRepository.hasOtherArtifactForBlob`；SQL 保持 `blob_id=? AND id!=? LIMIT 1`，排除自身，计入其他任意状态、任意 owner 的引用。未改变删除资格或 hold 保护。归档新旧仓储单测及共享引用集成通过。 |
| G5-AC-02：计算输入等价 | ACTIVE head JOIN、完整 missing 清单、来源顺序、ready/hash/hold、rowCount、manifest 检查保持。每消费一条来源仍先计算 4096 元数据预算；BU/digest 排序、fingerprint、generation 与快照算法未迁走或改写。 |
| G5-AC-03：导出等价 | PUBLISHED / READY / ACTIVE+kind 过滤保持；RESULT 恰好两个起止端点及错误优先级保持。manifest owner、历史规则版本选择和 RAW 原件真实文件检查仍在 export coordinator。覆盖七类导出冻结输入、真实文件读回及 RAW 修复/双损坏拒绝。 |
| G5-AC-04：删除闭包与确认 | source/run 投影只装配原有闭包字段，新 query 的额外字段未进入 digest。原 selection、charge、TTL、generation、digest、复用和 exclusive bind 检查保持。两种删除模式、锁与其他 owner 保护的既有回归通过；精确预算边界与旧实现结果等价。 |
| G5-AC-05：导入诊断 | dispatch/diagnostic 读取保留原字段和类型；关闭屏障、唯一 carrier、producer、owner/digest 及真实样本验证顺序保持。成功导入空报告实测经过独立 maintenance task，达到 DONE / succeeded / DELETED 并删除实际诊断目录。 |
| G5-AC-06：资源及准入边界 | query 使用 catalog 原连接，同步即时执行；没有文件 IO、新连接、事务、锁或缓存，也不返回 DB/statement。计算 exclusive、导出整个异步 readTask、删除同步 read、导入关闭链未调整。query_only 与 iterator 关闭测试通过。 |
| G5-AC-07：合法命令与架构限制 | 原 catalog commands 和恢复路径保留；模块 README 逐项解释尚未迁移的 `catalog.db` 使用者。当前 AST 清点为 0 受保护 raw 访问、5 处合法 preview SQL。G8 机器规则未集成，后续归属已明确，符合总索引 §6.2；此项的完整机器强制仍待 G8 集成验证。 |
| G5-AC-08：迭代与负向等价 | 同步 generator 保持来源/原件顺序，`for...of` 的 break/throw/return 级联关闭 SQLite iterator。集成比较完整 JSON、序列化顺序与错误内容，覆盖 4096/4097、49152/49153、65536/65537 等边界。三份旧实现 fixture 与基线 Git blob 逐字节一致。 |

重点源码入口：[catalog-queries.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-bizop-query-boundaries/src/main-process/biz-op-v327/catalog-queries.js:6)、[compute-inputs.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-bizop-query-boundaries/src/main-process/biz-op-v327/compute-inputs.js:32)、[export-inputs.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-bizop-query-boundaries/src/main-process/biz-op-v327/export-inputs.js:8)、[delete-preview.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-bizop-query-boundaries/src/main-process/biz-op-v327/delete-preview.js:23)、[import-main.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-bizop-query-boundaries/src/main-process/biz-op-v327/import-main.js:19)、[archive-repository.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-bizop-query-boundaries/src/backend/database/archive-repository.js:2491)。

本轮另设 compute/export、delete/import/archive、验收覆盖三个独立只读审查范围。均未提出成立的新增缺陷；主审已汇总源码、运行证据和文档边界。各审查者重复运行的局部单测与主审 153 个用例重叠，不额外累加测试总数。

**本轮实际验证**

环境：macOS / Darwin arm64，Node `v25.8.0`；真实目录 fsync 能力为 supported。测试使用自建临时库、归档、worker 与文件，未使用用户真实数据库。

| 命令 / 检查 | 结果 | 本轮持久证据 |
| --- | --- | --- |
| `node --test --test-concurrency=2` + 11 个相关测试文件 | 153/153 PASS，0 fail、0 skip，exit 0；86.30 秒 | [完整参数](review-2026-09-20-evidence/unit-result.json)、[日志](review-2026-09-20-evidence/unit.txt) |
| `node scripts/integration/biz-op-query-boundary.js` | 9/9 PASS，0 skip，exit 0；10.33 秒 | [结果](review-2026-09-20-evidence/integration-result.json)、[日志](review-2026-09-20-evidence/integration.txt) |
| `npm run lint` | PASS，exit 0 | [结果](review-2026-09-20-evidence/lint-result.json)、[日志](review-2026-09-20-evidence/lint.txt) |
| `node changes/v3.2.10/codex/v3.2.10-bizop-query-boundaries/evidence/query-boundary-inventory.cjs` | exit 0；protectedRawAccesses=0，previewCommandSites=5，inventorySites=243 | [本轮清单](review-2026-09-20-evidence/query-boundary-inventory.json) |
| 原 worktree `git diff --check` | PASS，exit 0 | [验证汇总](review-2026-09-20-evidence/verification.json) |
| 基线 oracle 校验 / 收尾源码比对 | 3/3 fixture 逐字节相同；63/63 覆盖文件摘要未漂移 | [验证汇总](review-2026-09-20-evidence/verification.json) |
| Action Manifest 检查：当前快照及纯基线 | 两边均 FAIL，exit 1；详见下文 | [当前日志](review-2026-09-20-evidence/manifest-current.txt)、[基线日志](review-2026-09-20-evidence/manifest-baseline.txt) |

11 个单测文件覆盖 ArchiveRepository、新查询、compute、export、历史结果规则、delete、import、admission、诊断负向与自动报告兼容。集成计数为场景组，每组含多项断言，不与单测总数合并。现有实施记录的 18 个文件摘要及 integration snapshot 的 4 个文件摘要均与本次快照一致；原 worktree 中所引用的历史日志也实际存在。上表使用本轮新运行证据。

**基线遗留失败与后续验收边界**

`node scripts/check-background-execution-manifest.js` 在当前快照和不含 G5 改动的 `11086a3c` 纯基线均报 `E13-G Action Manifest drift`，历史清单为 54 个 action，当前生成结果要求 67 个。为避免仅凭相同错误名误判归因，本轮还在内存加载各自原检查器的 `buildArtifacts()`，比较完整的 manifest、capabilityInventory、productionStrategy、coverageReport（包含 sourceHashes）；四份产物全部深相等。见 [比较结果](review-2026-09-20-evidence/manifest-comparison.json)、[当前预期产物](review-2026-09-20-evidence/manifest-current-expected.json)、[基线预期产物](review-2026-09-20-evidence/manifest-baseline-expected.json)。本分支没有引入额外的清单或源码摘要漂移；未擅自刷新这些历史产物。该失败仍需在后续 release/G7 工作中处理。

本次未执行完整 `release-check`；本任务为分支审查，已执行与改动对应的单测、集成和 lint，且额外核实了已知清单失败。以下边界保持未验收：

- G2、G7、G8 及 release 的组合验证。G8 的别名、闭包、动态 SQL 正反例和 `ARCH-BIZOP-QUERY` 激活尚未交付；一次性 AST 清点不能替代。
- Windows、Excel/WPS、安装包和真实 Electron GUI。当前宿主 9 组集成全部执行，不能由此推断不支持目录 fsync 的宿主成功路径已验收。
- 4096 个真实 XLSX 的容量/性能验收。当前极值测试验证元数据条数、字节和 iterator 停止点。
- 新旧导出工作簿逐单元格金样比较。当前证据证明完整冻结输入和错误等价，并对生成文件所有工作表做读回；三份 oracle 不是整套旧应用回放。

本次审查无需新增代码修改项。原有 G8 集成、完整本地门禁及适用平台验收继续按既定计划落实。所有本轮证据文件的摘要见 [evidence-sha256.json](review-2026-09-20-evidence/evidence-sha256.json)。
