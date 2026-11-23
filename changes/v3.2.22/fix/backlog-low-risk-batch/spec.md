# Spec：backlog 低风险小修一批（B114、B19、B17、B5、B60、B55）

> status: done
> created: 2026-11-23
> 目标版本：v3.2.22（暂定，发版时按 weekly-release 调整）
> 适用分支：`fix/backlog-low-risk-batch`
> 分支基线：正式标签 `v3.2.21`（`0e996340`）
> 依据：`knowledge/backlog.md` 各条目的关闭条件；2026-11-23 用户选定本轮修复范围

## 1. 决策

| 编号 | 条目 | 决策 | 依据 |
| --- | --- | --- | --- |
| D1 | B114 | 在日志共同出口 `logger.js` 新增 `normalizeLogLevel`，`appendStructuredLog` 与 `getLogFilePath` 都把 `warn` 归为 `warning`（记录里的 level 同为 warning），主进程 `appendActivityLogEntry` 与模块 `appendModuleLog` 两条入口都经过；原有 12 处 `'warn'` 调用（`main.js` 8、`database.js` 1、`template-resources/service.js` 2、`own-accounts-migration.js` 1）同时改为 `'warning'` | 关闭条件二选一，两者都做：出口兜底防止今后再漏 |
| D2 | B19 | `isMemoryLimitError` 删除「任意 RangeError 即为容量类」，只认 message 关键字（原正则不变）与 Node 容量类错误码 `ERR_FS_FILE_TOO_LARGE` / `ERR_STRING_TOO_LONG` / `ERR_BUFFER_TOO_LARGE` | backlog 推荐「message 关键字命中优先于裸类型判定」；V8 / Node 的容量类错误（ArrayBuffer 分配失败、字符串 / 数组长度上限、文件超过 2 GiB）均能由关键字或错误码识别 |
| D3 | B17 | `buildLinkedUpsertContext` 在幂等键列与展示键列相同（fx：`transaction_no`）时只写一次该列，取归一后的幂等键；SET 子句去掉该列。网关、入金（两列不同）SQL 不变 | backlog 推荐；与修复前 node:sqlite「重复列取第 1 个值」的实际结果相同 |
| D4 | B5 | `buildScenariosSnapshot` 改用同一闭包内已有的 `stableJsonStringify`（C4 已在用），不另抽共享模块 | 两个函数同在 `registerAppHandlers` 内，直接复用即可；backlog 推荐的抽共享工具不是关闭的必要条件 |
| D5 | B60 | 统一拒绝：`import-handoff.js` 导出 `hasHandoffControlCharacter`（与交接 `nonempty` 同一正则 U+0000–U+001F、U+007F）；模板文件预检的表头检查只对 `group === 'vcc-sources'` 调用，含控制字符时「表头」报 fail：「第 N 列表头含换行、制表符等控制字符，请改为单行文本」 | 交接阶段的规则是身份契约的一部分，不放宽；其他输入原表（如网关对账单）的表头含换行很常见，且不经过 VCC 交接，不受影响 |
| D6 | B55 | 在共享 normalizer 侧收紧：`normalizeDateExportValue` 的 `new Date` 兜底结果须能与原文三段数字一一对应（年按全值，或一两位的年份按末两位），否则为空 | 显式分支已覆盖所有日历有效的常见写法（年在前 / 年在后四位 / 两位年），走到兜底的数字三段式要么日历无效、要么是非常规位数；只拒绝「对不上原文」的结果，非常规但能对上的写法（`2026-03-001`、`99-1-1`）保持原结果 |

## 2. 行为变化（用户可见）

- B114：这些告警今后写入 `logs/<月>/<日>/warning.log`，不再出现在 info.log。
- B19：小型损坏文件抛出的非容量类 RangeError 不再提示「文件过大，超出处理能力，请拆分后再试」，改走各读取入口原有的「无法读取」类提示。
- B60：VCC 原表模板的表头含换行、制表符等控制字符时预检不通过、不能启用（此前可启用但导入时必然报「VCC 导入交接身份不符」）。已启用的此类版本不在本次处理范围：它们本来就无法导入，用户需按预检提示改为单行表头后重新导入模板。
- B55：`02-29-2026`、`02/31/2026`、`04.31.2026`、`2-30-26` 等日历上不存在的日期不再被滚动成下月，按无效日期处理：
  - 网银生成：BillDate 报「账单日期无效：第 N 行」，不生成；ValueDate 导出为空（两者均与 `2026-02-31` 现有口径一致）；
  - 平盘：银行对账单与源表该行报「BillDate / 日期字段 无法解析」，整批拒绝，不再参与月份替换；
  - 工具箱、明细写出的日期格式化：该单元格保持原文本，不再写成下月的日期；
  - 余额种子导入、人工补录预检、对账场景引擎（`toDate`）同口径视为无效。
- B17、B5：无用户可见变化（B5 只消除「同语义配置 key 顺序不同」造成的误判已变化）。

## 3. 残余风险

- B55：此前已按滚动后的日期导出的账单、平盘月份替换不会自动修正；如有用户反映，需按原始文件复核。
- B19：`Invalid typed array length` 类 RangeError 不再判为容量类（正值巨大时也可能来自损坏文件声明的错误长度，无法区分），真实超大文件的常见失败形态仍由关键字或错误码识别。

## 4. 验收

- 单测：
  - `tests/unit/backend/logger.test.js`：两条入口传 `warn` / `WARN` 均写入 warning.log、level 为 warning；`getLogFilePath` 其他未知值仍兜底 info。
  - `tests/unit/backend/file-service/readers-memory-error.test.js`：非容量类 RangeError 为 false，容量类错误码为 true。
  - `tests/unit/backend/database/linked-fx-settlement-upsert.test.js` UT-FX-UPSERT-8：截获 SQL 断言无重复列、占位符与列数一致；UT-FX-UPSERT-7 补断言交易编号列为归一键；网关 / 入金 upsert 用例作回归。
  - `tests/unit/main-process/bank-statement-scenarios-snapshot.test.js`：从 `main.js` 抽取嵌套函数，断言 key 顺序不同的同语义配置快照相同、真实变化快照不同。
  - `tests/unit/main-process/template-resources-vcc-sources.test.js`：真实 XLSX 表头含 LF、CRLF、Tab、DEL 时预检 fail、不能启用；`template-resources-input-structures.test.js`：网关表头含换行时表头检查照常通过。
  - `tests/unit/backend/file-service/normalizers.test.js`：各分隔符、闰日 / 非闰日、超出当月天数、两位年、带时间后缀在三种日期顺序下均为空；闰年 2 月 29 日与能对上原文的兜底写法照常解析。
  - `tests/unit/main-process/position-reconciliation-readers.test.js`：独立 BizId 的不存在日期整批拒绝并列出原文，闰年日期照常读取。
- `npm run release-check` 通过。
