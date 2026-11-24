# Spec：backlog 低风险小修一批（B114、B19、B17、B5、B60）

> status: done
> created: 2026-11-23
> 目标版本：v3.2.22（暂定，发版时按 weekly-release 调整）
> 适用分支：`fix/backlog-low-risk-batch`
> 分支基线：正式标签 `v3.2.21`（`0e996340`）
> 依据：`knowledge/backlog.md` 各条目的关闭条件；2026-11-23 用户选定本轮修复范围。B55 原在本批，Codex 第一轮审查发现共享日期函数收紧影响 VCC 历史归档导出等，用户决定撤出本轮（见 §4）

## 1. 决策

| 编号 | 条目 | 决策 | 依据 |
| --- | --- | --- | --- |
| D1 | B114 | 在日志共同出口 `logger.js` 新增 `normalizeLogLevel`，`appendStructuredLog` 与 `getLogFilePath` 都把 `warn` 归为 `warning`（记录里的 level 同为 warning），主进程 `appendActivityLogEntry` 与模块 `appendModuleLog` 两条入口都经过；原有 12 处 `'warn'` 调用（`main.js` 8、`database.js` 1、`template-resources/service.js` 2、`own-accounts-migration.js` 1）同时改为 `'warning'`；别名只认别名表自身的键，调用方透传的其他级别（含 `constructor`、`__proto__`）原样保留 | 关闭条件二选一，两者都做：出口兜底防止今后再漏 |
| D2 | B19 | `isMemoryLimitError` 删除「任意 RangeError 即为容量类」，只认 message 关键字（原正则不变）与 Node 容量类错误码 `ERR_FS_FILE_TOO_LARGE` / `ERR_STRING_TOO_LONG` / `ERR_BUFFER_TOO_LARGE` | backlog 推荐「message 关键字命中优先于裸类型判定」；V8 / Node 的容量类错误（ArrayBuffer 分配失败、字符串 / 数组长度上限、文件超过 2 GiB）均能由关键字或错误码识别 |
| D3 | B17 | `buildLinkedUpsertContext` 在幂等键列与展示键列相同（fx：`transaction_no`）时只写一次该列，取归一后的幂等键；SET 子句去掉该列。网关、入金（两列不同）SQL 不变 | backlog 推荐；与修复前 node:sqlite「重复列取第 1 个值」的实际结果相同 |
| D4 | B5 | `buildScenariosSnapshot` 改用同一闭包内已有的 `stableJsonStringify`（C4 已在用），不另抽共享模块 | 两个函数同在 `registerAppHandlers` 内，直接复用即可；backlog 推荐的抽共享工具不是关闭的必要条件 |
| D5 | B60 | 统一拒绝：`import-handoff.js` 导出 `hasHandoffControlCharacter`（与交接 `nonempty` 同一正则 U+0000–U+001F、U+007F）；`contracts.js` `vccHeaderControlColumns` 对 `group === 'vcc-sources'` 的表头（去除首尾空白后，即交接收到的列名）判定。① 导入新版本的预检（`prepareImport` 传 `importingNewVersion`）「表头」报 fail：「第 N 列表头含换行、制表符等控制字符，请改为单行文本」；② 切换到已存版本（`setCurrentVersion`）时同样拒绝，表头按运行期（`currentInputStructure`）相同的取值顺序：逐表描述的表头，没有时用 `comparableValues`；③ 已存版本的兼容复核（升级后选文件时逐张核对 VCC 来源）不执行此项 | 交接阶段的规则是身份契约的一部分，不放宽；首尾空白在读取与交接时都会去掉，不会导致交接失败。若复核也执行，v3.2.22 之前已启用的此类版本会被判不可用，选文件时五种来源一起中止（Codex 第一轮 P2）；不复核时该来源导入仍按交接规则失败，与升级前相同，其他来源照常。其他输入原表（如网关对账单）的表头含换行很常见，且不经过 VCC 交接，不受影响 |
## 2. 行为变化（用户可见）

- B114：这些告警今后写入 `logs/<月>/<日>/warning.log`，不再出现在 info.log。
- B19：小型损坏文件抛出的非容量类 RangeError 不再提示「文件过大，超出处理能力，请拆分后再试」，改走各读取入口原有的「无法读取」类提示。
- B60：VCC 原表模板的表头含换行、制表符等控制字符时预检不通过、不能启用（此前可启用但导入时必然报「VCC 导入交接身份不符」）。升级前已启用的此类版本保持当前版本，该来源导入时仍失败（与升级前相同），其他来源不受影响；恢复默认后不能再启用它，需改为单行表头后重新导入模板。
- B17、B5：无用户可见变化（B5 只消除「同语义配置 key 顺序不同」造成的误判已变化）。

## 3. 残余风险

- B19：`Invalid typed array length` 类 RangeError 不再判为容量类（正值巨大时也可能来自损坏文件声明的错误长度，无法区分），真实超大文件的常见失败形态仍由关键字或错误码识别。
- B60：升级前已启用的含控制字符表头版本不自动切回内置，该来源导入失败的提示仍是「VCC 导入交接身份不符」。

## 4. 撤出本轮：B55

Codex 第一轮审查（2026-11-23）指出共享日期函数收紧的影响面超出本批：VCC 已归档明细升级后按新口径重读会报完整性失败、整份导出失败；文本型 `.xls` 在读取阶段 SheetJS 已把日期转成序列号，共享函数管不到；带星期标注的有效日期（如 `2026/03/01(日)`）被误拒；平盘生产走 streaming 导入路径，旧 reader 用例覆盖不到。用户决定撤出本轮，B55 留在 backlog「未实施」并补记上述影响面，日后单独立项。

## 5. 验收

- 单测：
  - `tests/unit/backend/logger.test.js`：两条入口传 `warn` / `WARN` 均写入 warning.log、level 为 warning；`getLogFilePath` 其他未知值仍兜底 info；`constructor`、`__proto__` 等原样写入 level。
  - `tests/unit/backend/file-service/readers-memory-error.test.js`：非容量类 RangeError 为 false，容量类错误码为 true。
  - `tests/unit/backend/database/linked-fx-settlement-upsert.test.js` UT-FX-UPSERT-8：截获 SQL 断言无重复列、占位符与列数一致；UT-FX-UPSERT-7 补断言交易编号列为归一键；网关 / 入金 upsert 用例作回归。
  - `tests/unit/main-process/bank-statement-scenarios-snapshot.test.js`：从 `main.js` 抽取嵌套函数，断言 key 顺序不同的同语义配置快照相同、真实变化快照不同。
  - `tests/unit/main-process/template-resources-vcc-sources.test.js`：真实 XLSX 表头含 LF、CRLF、Tab、DEL 时预检 fail、不能启用；模拟升级前已启用含换行表头的版本，升级后兼容复核不阻断识别、恢复默认后不能再启用（含只有 `comparableValues` 的早期快照），重新选择同一文件时提示内容相同但不引导启用；`template-resources-input-structures.test.js`：网关表头含换行时表头检查照常通过。
- 集成 `scripts/integration/vcc-input-template-version.js`：升级前已启用的含换行表头版本保持当前，费用及换汇明细照常完成交接，该来源仍在写入前以 `vcc-import-handoff-mismatch` 被拒。
- `npm run release-check` 通过。
