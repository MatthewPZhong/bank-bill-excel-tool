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

### [Important / 已覆盖] Worker crash/cancel/late done 的 staging 生命周期

- 事实：生成是同步 XLSX 写；cooperative cancel 可能需要 Supervisor terminate 才结束。
- 推断/未知：partial/final staging 可能已出现，迟到 done 不得恢复 handle。
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
  -> Worker readback (sheet/header/row count/full record digest/date/account/currency digests)
  -> Main ownership + size + SHA technical validation
```

- 行数守恒：`Σ(account dayCount × account uniqueCurrencyCount) = output rowCount`；没有过滤、拆分、合并或 fallback。
- 账户：原账号只进入 workbook；结果 DTO 只含 digest 与文件名末四位，不回传完整账号。
- 币种：按每账户输入顺序去重；不做映射、汇率或跨账户归并。
- 日期：本地日历沿用 legacy；开户日至昨日均包含；晚于昨日、超过 3650 天拒绝。
- 金额：没有 Credit/Debit/汇率/舍入；每行期末余额固定数值 `0`，其余余额字段为空。
- 文件名：单账户 `银行-地点-末四位-币种或多币种-NEW_BALANCE.xlsx`；多账户固定 `多账号-多币种`；contract 拒绝路径分隔符和非 xlsx。

## 资金红线人工复核

⚠️ 资金红线，请人工复核：NewAccount 日期、账户、币种、行数和输出记录仍需业务/财务 owner 用真实样本复核；自动化 golden 不能替代人工放行。

## Remaining boundaries

1. E10-B 才实现 Publisher、async copy、source/target evidence 与正式 artifact handle；E10-A 没有发布路径。
2. 完整应用进程崩溃后的持久 task-staging 扫描/Publisher journal 由 E10-B/R3.2.3 接线；E10-A 已覆盖进程存活时 Worker crash/cancel cleanup，且 production=false。
3. Windows Setup/portable 的 Worker assets 路径、RSS、app quit 与文件系统能力必须在 R3.2.3 人工/packaged gate 验证。

## 已反证候选

- “Worker 会收到 final target”：input exact keys 与测试证明没有。
- “新实现改变 live 路径”：Main 没有 `isProductionEnabled('new-account:generate')` 分支，policy 保持 false/legacy/0。
- “Worker 会并行多个 workbook”：policy `thread-single/job` 且 maxArtifacts=1，没有 pool/child topology。
- “E10-A 已实现另存为/复制/Publisher”：新目录无 copy/Publisher 调用，明确留给 E10-B。
