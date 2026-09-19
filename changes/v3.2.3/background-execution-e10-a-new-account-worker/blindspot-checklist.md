# E10-A Blindspot / Reconciliation Closeout

## Blindspot findings

### [Important / 已覆盖] generationPath 与 final target/template 别名

- 事实：Worker input 不含 final target，但 Main 同时持有 FilePlan output 与 generationPath；初版只校验 generationPath 位于 staging root。
- 推断/未知：若两者互为路径/平台 alias，E10-B 接 Publisher 时可能把 generation 当正式目标，破坏 staging/final 边界。
- 影响：Publisher 边界、失败清理与正式文件身份会混淆。
- 证据：`src/main-process/new-account/generation-validator.js:createNewAccountWorkerInput`。
- 最便宜验证：final target 直接等于 generationPath 的反例。
- 处置：已覆盖；Main 在启动 Worker 前用平台 alias 规则拒绝 generationPath 与模板/final target 别名，测试锁定。

### [Important / 已覆盖] 必填失败不得改变 legacy 可导出状态

- 事实：legacy 原实现的必填失败发生在 generation `try/catch` 之前，因此不会执行 catch 中的 `lastGeneratedExports.newAccount=null`。
- 推断/未知：若抽取后把必填验证放入同一 catch，会静默改变旧结果生命周期。
- 影响：用户输错新表单后，之前已生成的可导出文件会被意外失效。
- 证据：`src/main.js:registerNewAccountHandlers` 的早返回与 generation catch。
- 最便宜验证：静态检查 validation 位于 generation try 之前。
- 处置：已覆盖；必填仍调用唯一 core validator，但保持 legacy 早返回边界。

### [Important / 已覆盖] 模板 allowlist 与 TOCTOU

- 事实：legacy 只做 `existsSync`；E10-A Worker 运行在独立线程并持有模板路径。
- 推断/未知：任意路径或 Main 快照后替换会改变列序、样式和记录解释。
- 影响：错误模板可造成账户/币种/日期列错位或不可审计输出。
- 证据：`generation-core.js:assertTemplateEvidence`；`generation-validator.js:createNewAccountWorkerInput`。
- 最便宜验证：非 allowlist 同名模板、错误 SHA、snapshot 变化。
- 处置：已覆盖；固定应用内路径，Main FilePlan snapshot + SHA，Worker 写前写后复核 path/snapshot/hash。

### [Important / 已覆盖] 同步 XLSX 阻塞 running Worker 的 shutdown cancel

- 事实：修复前的 `executeNewAccountGeneration` 在同步写前/写后只读 `signal.aborted`；Worker 消息循环未让出，`job:cancel` 不能更新 AbortController。
- 推断/未知：已被 Supervisor 接受的 shutdown cancel 可被 Worker 紧随的 `job:done` 覆盖。
- 影响：取消被伪报为 `completed`，Main 生成 artifact handle，未发布 staging 残留。
- 证据：替代 Reviewer 用例与本地修复前回放；等 `control.ready/state=running` 后 shutdown，actual 为 `completed`。
- 最便宜验证：同一真实 runtime 用例锁定 cancellation terminal、handle 和 staging 数量；反向用例先 await 真实 completion 再 shutdown。
- 处置：已覆盖；core 在同步 writer 前后及readback/hash各批次让出消息循环，entry 发 `job:done` 前再过 cancel gate。取消终态仍由 Supervisor 认定，只有 Main/client 删 task-private staging；Worker/core 不删，不存在双清理 owner。

### [Important / 已覆盖] 最大合法 workbook 的 readback 内部仍有超过 cooperative timeout 的连续同步窗口

- 事实：上轮只在整个 `readBackAndValidate` 前后让出；250k旧链回读约7.5秒，包含 `readFile`、sheet materialize和actual/expected四digest多个连续同步阶段。
- 推断/未知：shutdown即使在workbook写完后到达，也要等整个readback结束才可被Worker message handler观察；约4997ms到达时会触发Supervisor的正确5秒cancel-timeout。
- 影响：正常合法任务被伪报 `transport-lost` 而非 `cancelled`；取消终态、staging恢复与可观测性失真。
- 证据：第二替代Reviewer真实250k回放；本机分段计时；`scripts/perf/new-account-e10-a-readback-cancellation.js` 六场景/五个真实阶段反例。
- 最便宜验证：分别在 workbook-opened、row batch、row-scan-complete（旧readFile后等价边界）、expected evidence batch、Worker发送job:done前暂停真实Worker，再调用原Supervisor shutdown；至少两轮250k workbook-opened。
- 处置：已覆盖；实际落盘XLSX通过ZIP entry与worksheet XML流式扫描，row/evidence各1024行一批yield+signal check，artifact SHA改异步stream；四digest由共享incremental canonical数组hasher计算并与旧oracle逐字节对照。测试stage端口不进入Protocol/DTO，取消仍只有Main cleanup恰好一次。

### [Important / 已覆盖] generic scanner 的字符串值与宽松坐标使业务回读 fail-open

- 事实：修复前E10流式路径使用generic import `row-scanner`；该scanner把无type/`n`/`b`/`d`/`e`的`<v>`统一返回字符串，重复坐标后值覆盖，并按outer row发射而不校验cell ref行号；流尾未闭合行可丢弃。
- 推断/未知：numeric `00123`可保住错误前导零、boolean `1`可冒充文本，outer `row r=2`内`cell r=D3`可被并入第2行，使streaming digest与预期自洽而旧raw oracle拒绝。
- 影响：账号、日期、币种、金额与行位置血缘不可审计，命中资金红线。
- 证据：Reviewer三个反例；`row-scanner.js:cellValueFromBody/parseRowInline/scanSheetRows`；一次性SheetJS raw XML probe。
- 最便宜验证：独立oracle差分矩阵先锁定三反例红测，再覆盖所有cell type、formula cached、sparse/blank、重复/乱序/错位/截断/实体。
- 处置：已覆盖；E10专用strict projection按SheetJS raw解码shared/inline/str/number/boolean/date/error/formula cached并排除rich text `rPh`，逐row/cell验证完整坐标、顺序/唯一/XLSX范围，截断XML/未知实体/非法payload fail closed；独立oracle矩阵8/8、focused476/476、250k/60,416四digest与六阶段cancel通过。保留ZIP streaming、1024行yield和cancel gate，不修改generic scanner消费者。

### [Important / 已覆盖] worksheet dimension 与实际cell/merge used range冲突被忽略

- 事实：修复前E10 strict scanner不读取`<dimension ref>`；把真实1-row writer的`A1:I2`截为`A1:I1`，旧SheetJS `!ref/raw`只回读header并拒绝，streaming仍扫描第2行并接受。旧库另会宽松回算missing/duplicate或规范化reversed/absolute，expanded甚至通过业务回读。
- 推断/未知：仅校验cell自身坐标不足以证明worksheet元数据、实际物理范围和业务记录一致；扩张/偏移也可能隐藏账户、日期、币种或余额列异常。
- 影响：Sheet/header/rowCount与四digest可对一个旧oracle会不同解释的workbook自洽，命中资金血缘红线。
- 证据：Reviewer `A1:I1`反例；`writeBalanceWorkbook`固定`!ref`；JSZip真实XLSX probe。
- 最便宜验证：先锁定截断红测，再覆盖missing/duplicate/expanded/shifted/reversed/out-of-range/absolute/multi-area，以及empty/header-only/1row/styled blank/merge/formula/multi-letter/大边界。
- 处置：已覆盖；E10专用canonical dimension parser要求唯一dimension在sheetData前出现，只接受uppercase相对`A1`/`A1:END`、有序且在XLSX范围；累计全部cell refs与merge ranges used bounds并要求exact，冻结header-only尾随空第2行是唯一例外。红测10/12准确命中截断/missing，修复后oracle 12/12、focused480/480、250k/60,416 digest与取消、full integration/smoke/static均通过；不改generic scanner或同步回退。

### [Important / 已覆盖] `t=d` 原始空白被trim后改变旧raw日期解释

- 事实：strict decoder曾调用`sheetJsDateSerial(rawValue.trim())`；非UTC真实1-row中带空白`t=d`被legacy解析为不同serial而mismatch，trim后的strict却接受。2026-09-01 exact Windows UTC job `99720940244`进一步证明legacy会接受6种带首尾/tab/newline空白的ISO日期；当前strict对这6种及empty/whitespace-only仍全部返回`NEW_ACCOUNT_WORKBOOK_CELL_INVALID`。
- 推断/未知：异常日期词法可被trim静默修复；同时把legacy拒绝写成跨宿主断言会制造与生产门禁无关的时区失败。#206/#207同因仍是基于相同测试块的推断，integration尚未执行。
- 影响：生产若trim会破坏开户日期raw血缘；测试若依赖legacy宿主结果会阻断Windows CI并掩盖真正的strict合同状态。
- 证据：SheetJS `parse_ws_xml_data`的`t=d -> datenum(parseDate(p.v,1))`、真实JSZip差分probe、#205上海时区16/16与`TZ=UTC` 15/16、UTC逐值probe。
- 最便宜验证：canonical/Zulu对legacy与strict保持等价；上海与UTC分别覆盖leading/trailing/both/tab/newline、empty/whitespace-only，安全断言只绑定strict raw gate。
- 处置：已覆盖；production strict直接验证未修改raw值且无legacy旁路。回归仅要求strict对8种异常词法fail closed，empty/whitespace-only另保持legacy双拒绝；不修改src、正常writer或streaming编排。

### [Important / 已覆盖] cell/dimension/merge前导零绕过canonical坐标

- 事实：`parseCellReference`以Number解释row digits，`D02`被strict当D2；旧SheetJS却保留物理key`D02`，canonical D2缺失并业务mismatch。dimension `A01:I02`与merge `A01:A02`也被数值化接受；outer row `r=02`配canonical cells时旧raw与strict都正常通过。
- 推断/未知：统一收紧outer row会制造兼容误拒，但不收紧cell/range会让物理key或元数据血缘漂移。
- 影响：账户cell可从旧oracle的D2消失但strict仍接受；dimension/merge唯一canonical合同失效。
- 证据：真实1-row JSZip probe、SheetJS `decode_cell/encode_cell`回比与Reviewer反例。
- 最便宜验证：D02及长前导零cell、A01/I02 dimension、merge端点红测；outer `r=02`正常控制。
- 处置：已覆盖；只对cell ref及dimension/merge端点做canonical re-encode equality并限制row lexeme最大7位；`D02`/`D0002`/超长前导零及range两端均拒绝，outer `r=02`继续与旧业务结果deep-equal。generic scanner不改，正常250k/60,416 digest与取消保持。

### [Important / 已覆盖] Worker crash/late done 的 staging 生命周期

- 事实：partial/final staging 可能已出现，迟到 done 不得恢复 handle。
- 推断/未知：Worker crash 后 transport 与 Main cleanup 的终态顺序必须保持 first-terminal-wins。
- 影响：错误发布、残留文件、transport/resource 泄漏。
- 证据：`worker-entry.js` canonical Protocol v1；`generation-validator.js:generateAndValidateNewAccount`；focused crash/late-message test。
- 最便宜验证：Fake transport 写 partial 后 `unexpected-exit`，随后发送合法迟到 `job:done`。
- 处置：已覆盖；非 completed 结果无 handle并清理已授权普通单链接文件；Supervisor 忽略 late terminal；shutdown 报告无泄漏。

### [Minor / 已覆盖] bounded DTO 与输出规模

- 事实：legacy 无账户/币种/预计记录数硬上限。
- 推断/未知：64×64×3650 可产生千万级记录并耗尽 Worker 内存。
- 影响：OOM/长时间无响应。
- 证据：`generation-contract.js` input bytes/account/currency/projected records bounds。
- 最便宜验证：64 账户 × 64 币种 × 近 10 年反例。
- 处置：已覆盖；Worker contract 最大 256 KiB、64 账户、每账户 64 币种、250,000 记录；live legacy 不新增该限制。

## Reconciliation lineage

```text
payload account rows
  -> core normalization (stable account order; per-account currency first-seen dedupe)
  -> each account: openingDate..yesterday inclusive
  -> cartesian rows in account -> date -> currency order
  -> template exact header projection
  -> 期末余额=0; other balance fields blank
  -> staging workbook
  -> Worker strict streaming readback (canonical dimension + physical used range + raw typed cells + exact coordinates -> sheet/header/row count/full record/date/account/currency digests)
  -> Main ownership + size + SHA technical validation
```

- 行数守恒：`Σ(account dayCount × account uniqueCurrencyCount) = output rowCount`；没有过滤、拆分、合并或 fallback。
- 账户：原账号只进入 workbook；结果 DTO 只含 digest 与文件名末四位，不回传完整账号。
- 币种：按每账户输入顺序去重；不做映射、汇率或跨账户归并。
- 日期：本地日历沿用 legacy；开户日至昨日均包含；晚于昨日、超过 3650 天拒绝。
- 金额：没有 Credit/Debit/汇率/舍入；每行期末余额固定数值 `0`，其余余额字段为空。
- 文件名：单账户 `银行-地点-末四位-币种或多币种-NEW_BALANCE.xlsx`；多账户固定 `多账号-多币种`；contract 拒绝路径分隔符和非 xlsx。
- 回读守恒：strict streaming projection只读取workbook声明顺序的首sheet，先校验唯一canonical dimension、cell/range re-encode与全部cell/merge used bounds，再按SheetJS raw类型解释且不trim `t=d`，并校验worksheet根、outer row与每个cell完整坐标；outer row词法按旧raw数值语义兼容，空物理行仍按旧`blankrows:false`跳过，业务行按原序逐行进入同一canonical accumulator；250k/60,416已与旧同步oracle四digest全等。
- 取消守恒：shutdown不改变records或digest；只在未完成阶段产生`NEW_ACCOUNT_GENERATION_CANCELLED`，result/generated均为null，由Main按冻结generationPath清理一次；已completed后shutdown保持正常artifact。

## 资金红线人工复核

⚠️ 资金红线，请人工复核：NewAccount 日期、账户、币种、行数和输出记录仍需业务/财务 owner 用真实样本复核；自动化 golden 不能替代人工放行。

## Remaining boundaries

1. E10-B 才实现 Publisher、async copy、source/target evidence 与正式 artifact handle；E10-A 没有发布路径。
2. 完整应用进程崩溃后的持久 task-staging 扫描/Publisher journal 由 E10-B/R3.2.3 接线；E10-A 已覆盖进程存活时 Worker crash/cancel cleanup，且 production=false。
3. Windows Setup/portable 的 Worker assets 路径、RSS、app quit 与文件系统能力必须在 R3.2.3 人工/packaged gate 验证。
4. #205 raw-date测试修复后仍须等待新exact Windows unit/integration；#206/#207因相同测试块而同因仅为推断，不能用旧绿或本地绿代偿。

## 已反证候选

- “Worker 会收到 final target”：input exact keys 与测试证明没有。
- “新实现改变 live 路径”：Main 没有 `isProductionEnabled('new-account:generate')` 分支，policy 保持 false/legacy/0。
- “Worker 会并行多个 workbook”：policy `thread-single/job` 且 maxArtifacts=1，没有 pool/child topology。
- “E10-A 已实现另存为/复制/Publisher”：新目录无 copy/Publisher 调用，明确留给 E10-B。
