# VCC v3.2.9 分支审查

结论：发现 5 个可复现 P2，建议修复后重新审查。

审查对象：`codex/v3.2.9-vcc-fin-op-multisheet-review-export`，HEAD 与本地 main 均为 `2ba9ef14fe972363b604955636cff0c9ac53700f`。功能位于未提交工作区。以 git archive HEAD 加 77 个修改/新增文件建立本目录快照，结束时复核原工作区文件 SHA-256，未发生变化。本次未修改实现、提交或操作真实业务数据库。

依据：`changes/3.2.9/codex/v3.2.9-vcc-fin-op-multisheet-review-export/v3.2.9_VCC_Spec.md` 和 `v3.2.9_VCC_TechDoc.md`（R3）。

## 1. [P2] 带 CRLF 的合法 Pending 备注导致待确认导出失败

位置：`src/backend/vcc-financial-op/review-export-plan.js:328–330`。

真实输入仅将 Pending 备注设为 `第一行\r\n第二行`。SheetJS 正常编码为 `_x000d_` 加 LF，五组导入均 success，计算成功且原件未变。待确认导出提取时却报 `archive-row-integrity-failure`，提示幂等键或内容哈希不一致。新 rich reader 解码了 OOXML 文本转义，但既有导入哈希保留转义 token；将解码后的输出值直接用于原哈希核验产生误报。应分别构建既有 hash 版本的核验值与实际导出值。

对照：TechDoc §7.3、§7.4。复现：`node probe-export-text.js`。

## 2. [P2] 合法 OOXML 日期类型在新系统 OP Reader 中失效

位置：`src/backend/vcc-financial-op/system-op-importer.js:801–807`。

系统 OP 的账单日期使用合法 `t="d"` 单元格时，rich reader 返回日期分量对象。此处未转换日期，将对象直接存入 rawMatrix 并转成 `[object Object]` 展示值。相同文件旧 Reader 返回 1 个完整快照、0 个错误；新预检 ready，提交后 0 个快照、9 个日期错误，完整主体被过滤。需要保留原日期解析合同。

对照：Spec §2.5、AC01；TechDoc §2.2。复现：`node review-import-probe.cjs`，以及 `node --test tests/unit/backend/vcc-financial-op/review-import-probe.test.js` 的第一个失败用例。

## 3. [P2] 系统 OP 提交阶段重新限制前 220 个非空行

位置：`src/backend/vcc-financial-op/system-op-importer.js:817–818`。

Sheet 含 220 行说明、正式表头在第 221 行时，完整预检返回 ready 和准确 headerRow，但提交重新调用只扫描前 220 个非空行的 findSystemHeader。混合工作簿中充值组已成功提交 1 条，系统组随后却报未找到正式表头。应验证和使用预检定位，而非重新套用旧预览窗口。

对照：Spec §2.2；TechDoc §2.2、§2.2.1。复现：`node --test tests/unit/backend/vcc-financial-op/review-import-probe.test.js` 的第二个失败用例。

## 4. [P2] 已导入明细的原表重建没有传递持久表头定位

位置：`src/main-process/vcc-financial-op-dataset-writer.js:821–822`。

充值 Sheet 含 221 行说明、表头在第 222 行时，预检 ready，正式导入 success / insertedCount=1。随后导出原表和校验表均失败，提示指定 Sheet 表头与导入计划不一致。这里仅传 sheetName，导致 streamStoredDetailRows 回退前 220 个非空行预览。需从已验证的持久成员读取该 Sheet 的 headerRow 并交给重建 Reader。

对照：Spec §2.6、AC29；TechDoc §2.2 的原表重建调用方适配要求。复现：`node probe-storage-late-header.js`。

## 5. [P2] 丢失来源关联可绕过已绑定原件校验

位置：`src/backend/vcc-financial-op/review-export-plan.js:144–147`。

故障注入：真实导入及计算后，仅将系统快照的 import_source_id 置 NULL；对应 import record 的 ready 来源和 artifact 元数据仍存在。破坏该绑定原件，再导出只需系统原表的差异坐标，prepare/extract/write/validate 仍成功，来源被判为 legacy，scannedFiles=0，生成两张 Sheet。这里只依据缺失的来源 ID 选择历史 raw_json，没有排查同一导入审计下已有绑定证据。损坏的关系不应被认定为合法历史来源。

对照：Spec §3.5；TechDoc §7.3 明确禁止仅凭 NULL 来源 ID 判定合法旧记录。复现：`node probe-export-source.js`。

## 验证范围

- Main/Service/IPC/target/renderer 专项：62 项通过，日志 `review-root-tests.log`。
- 存储迁移、COW、reset、lineage、多 Sheet 导入专项：63 项通过，日志 `probe-storage-tests.log`。
- 导入及工作簿计划专项：85 项通过，日志 `/private/tmp/vcc-import-review-tests.log`。
- 待确认导出、投影、共享 Writer、Biz OP 导出专项：25 项通过。
- 上述分组有重复覆盖，不相加作为独立测试总数。主审独立复跑了全部问题探针；两个端到端导入回归的成功断言均失败，日志 `review-root-import-probes.log`。
- 原工作区 `git diff --check` 通过；结束时 77 个审查文件指纹仍与快照一致。
- 未重跑完整 release-check，未进行 Windows 安装版、Excel/WPS 或 PF01–PF05 人工/规模验收。实施报告中的既有通过记录不是本次重新执行的结果。
