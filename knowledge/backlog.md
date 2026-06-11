# 项目 Backlog（待办候选 / 非阻塞改进）

> 收集已识别但暂不实施的改进项。版本 bump 前过一遍，决定是否升优先级到下一个 PR 的 spec。

## 维护约定

- **添加**：识别到非阻塞改进 → 在 "未实施" 段 append（按时间倒序，最新在上）
- **每条记录格式**：来源（哪个 PR / 哪轮 review）+ 严重等级（P0~P3）+ 影响范围 + 推荐实施时机
- **完成**：单独 PR 落地后从 "未实施" 段移到 "已完成"，引用对应 PR 编号 + commit
- **过期**：明确不再做（如方案被推翻）→ 移到 "已废弃"，写废弃理由

## 未实施

### B16（P4）xlsx-size-preflight 复用 zip-reader 的 openZipWithEntries

- **来源**：2026-06-11 v3.0.4 PR #71 self-review（R-reuse 角度 CONFIRMED）
- **影响**：`src/backend/pending-import/xlsx-size-preflight.js` 自写一套 yauzl open + entry 枚举；`src/backend/big-table-import/zip-reader.js` 已导出 `openZipWithEntries`（entries Map 自带 uncompressedSize），可复用后取 size 再 close
- **现状**：v3.0.4 不改（块 A 已带 4 态单测全绿，重构收益小于回归风险）
- **触发实施**：下次动 preflight 或 zip-reader 时一并收敛

### B15（P4）toIsoDate「normalizeDateExportValue→本地分量 YYYY-MM-DD」三份拷贝收敛

- **来源**：2026-06-11 v3.0.4 PR #71 self-review（R-reuse 角度 CONFIRMED）
- **影响**：`jpm-dispatch-order-fix.js:42 toIsoDate`、`adm-bank-deposit-builder.js:38 normalizeBillDateIso`、`boc-fx-link-builder.js:53 toIsoDate` 三份同口径实现（注释互引「同口径」），未抽进共享模块
- **现状**：v3.0.4 不改（JPM/ADM 属冻结链路，抽取需三链路回归；各自单测已锁口径）
- **推荐**：抽到 engine-date-utils 或新建 date-iso 工具 + 三处替换 + 加载期断言
- **触发实施**：下次动这三个 builder 任一时一并收敛

### B14（P3）`ADM_FUND_TYPES` 'Fundtransfer-out' 小写 t 与资产表不一致疑点

- **来源**：2026-06-11 v3.0.4 块 F（Payment线下调拨订单回填）spec §2.3 实读核验
- **影响**：`src/main-process/scenario-engines/adm-bank-deposit-fields.js:24-26` `ADM_FUND_TYPES` 含 `'Fundtransfer-out'`（小写 t）变体，而资产表 `assets/FundType枚举值.xlsx` 实测含 `'FundTransfer-in'`（大写 T），未见小写 t 变体——既有疑点，可能导致 ADM 派生对 out 方向枚举匹配漂移
- **现状**：v3.0.4 块 F 取大写 T（资产表实证），**不顺手改 ADM**（避免 ADM/JPM 链路连带回归）；R5s2 既有 seed（`migrations.js:1508-1509`）与 R5s2b 新引擎均用大写 T
- **推荐**：抽样核对真实导入数据中 ADM out 方向行的 FundType 实际拼写 → 确认是否需统一为大写 T + 对应 migration / 加载期断言
- **风险**：资金对账 ADM 派生匹配 —— 改动需 byte-identical parity 验证 + 人工复核
- **触发实施**：用户反馈 ADM out 方向派生漏匹配 / 下次动 adm-bank-deposit-fields.js 时一并核

### B13（P3）C3 extraFee smoke 端到端真实账单用例

- **来源**：2026-06-11 v3.0.4 块 D（bank-recon-output-fixes）spec §9.5 第 3 条
- **影响**：块 D F1（C3 Extra Fee 写盘取相反数，🔴 资金红线）当前由 `c3-gateway-recon-join.test.js` 单测矩阵（取反/负输入对称/-0 边界/迁移边界）+ DS1-DS9 语义不变回归覆盖；缺一条用真实账单 + 网关账单跑完整 C3 流程、断言主输出 Extra Fee 列取反值的 smoke 端到端用例
- **现状**：F1 改动点单一（写盘点 `normalizeCellValue(-fee)`），单测覆盖充分；端到端只靠手测（spec §9.3）人工核对一份样本三出口符号
- **推荐**：在 `scripts/smoke/` 加 C3 extraFee 真实账单端到端用例，断言主输出/命中明细文本/命中场景行报表三出口符号一致取反
- **触发实施**：下次动 C3 引擎 / 块 D 后续迭代时一并补

### B12（P3）命中场景行报表路径的状态框展示

- **来源**：2026-06-11 v3.0.4 块 D（bank-recon-output-fixes）spec §9.5 第 2 条
- **影响**：块 D F2 目录互换后，命中场景行报表落 `bank-statement-process/{date}/`，但 `writeScenarioHitRows` 返回的 `hitRowsReportPath/Name` renderer 零消费（`main.js` 状态框提示从未实现，原 `:3830` stale 注释已在 F2 改写）——用户在 UI 看不到命中场景行报表生成位置
- **现状**：报表正常生成，仅状态框不展示路径；与错误报告 cancel 路径同属「UI 无提示，只能查文件系统」
- **推荐**：状态框「已导出」行追加命中场景行报表文件名展示（对照 hitScenarios 契约）
- **触发实施**：用户反馈「找不到命中场景行报表」/ 下次动资金对账状态框时一并加

### B11（P2）`error-causes.js` CAUSE_MAP 缺 R1/R5/C3 新 code → 「可能原因」列显示「未知错误」

- **来源**：2026-06-11 v3.0.4 块 D（bank-recon-output-fixes）spec §9.5 第 1 条（与既有 B3「CAUSE_MAP 新增 code 自动 smoke 校验」互补：B3 是守卫机制，本条是具体未映射 code 清单）
- **影响**：`src/backend/file-service/error-causes.js:48-49` 的 `CAUSE_MAP` 缺 R1（multi-bank-match-r1）/ R5（R5s2/R5s4 各 code）/ C3（部分）等 warning code 的「可能原因」中文映射 → error-report「可能原因」列回退显示「未知错误」，对用户无指导价值。v3.0.4 块 F（payment）F6 已补 R5s2b 全部新 code，块 E（BOC）F3.4 引擎 warnings 带中文 message 直显前端（不走 CAUSE_MAP），但 R1/R5s2/R5s4 既有 code 仍缺
- **现状**：error-report 第 3 列已在块 D F3 换为「对账ID」；「可能原因」列对未映射 code 仍兜底「未知错误」
- **推荐**：补全 R1/R5s2/R5s4/C3 各 warning code 的 CAUSE_MAP 条目；配合 B3 的自动 smoke 校验一并落地（扫 `code: '...'` 与 CAUSE_MAP keys 比对，未映射报告）
- **触发实施**：与 B3 同窗口 / 下次新增场景算法时一并补

### B10（P2）vcc-op-calc 导入主进程同步卡 UI（78.7w 行实测 7.8s）→ 挪 worker 独立小迭代

- **来源**：2026-06-11 通用引擎适用模块调研（结论沉淀于 `changes/v3.0.4/spec.md` §一.1/§一.2）
- **现状**：`vcc-op-calc-session.js` `streamScanAndCompute` 在主进程同步流式聚合（无 worker、无 cancel），实测 78.7w 行 / 811MB 解压 跑 7.8s 整段卡 UI（`vcc-op-calc-import/reader.js:8-9` 注释实测）
- **裁定（调研结论）**：**不上 big-table 引擎** —— vcc 本质是聚合器（只落 runs/run_files 汇总、不存原始行，`vcc-op-calc-session.js:380`），且依赖"遍历多 sheet 找表头匹配"（`reader.js:195-202`），与引擎"行级 INSERT + rels 正解唯一 sheet"范式双重冲突。优化方向 = 独立小迭代挪 worker（W4 式），顺带补 cancel
- **关联**：JSZip 2^31 崩点暴露由 v3.0.4 PR-A 入口预检兜底（见 B9）；vcc 当前实证 811MB ≈ 阈值 38%，量级暂安全
- **触发实施**：用户反馈 vcc 导入卡顿 / 量级接近 1.5GB 时立项

### B9（P1）JSZip 流式基座 2^31 解压上限：链接表 ≥82w 行 xlsx 导入必崩 "uncompressed data size mismatch"（→ v3.0.4 部分立项）

- **来源**：2026-06-10 用户实证（98 万行 xlsx 链接表导入报错含 mismatch）+ 同日多 agent 根因诊断（4 线调查 + 交叉验证，confidence: high）
- **根因**：JSZip 3.10.1 int32 符号溢出 —— `jszip/lib/reader/DataReader.js:64` `readInt` 用 `(result << 8) + byte` 有符号累加，sheet1.xml 解压体积 ≥2^31 字节（2.147GB）时 uncompressedSize 读成负数，解压结束在 `jszip/lib/compressedObject.js:38` 与实测长度比对必不等 → 抛 `Bug : uncompressed data size mismatch`。zip64 救不了（readInt(8) 同样溢出）。**真实阈值 2.147GB，POC 注释的 ~3.8GB 只是样本点**；65.7w 行（1.72GB）通过 / 98w 行（≈2.56GB）崩、临界 ≈82w 行（本表密度 ~2.6KB/行），全部自洽
- **触发链路**：`linked-table:import`（`src/main.js:11274`）→ detector 判单 sheet xlsx 走流式（头部 200 行早停不触雷）→ `streaming-xlsx-reader.js:213` JSZip 全量解压 sheet1.xml → 解压完最后一刻抛错 → 事务 ROLLBACK（旧数据无损）→ per-file `write-error`
- **影响面**：链接表 4 张可导入表全部命中；`pending-import`（`worker.js:21`）、`biz-op-recon-import`（`reader-streamed.js:35`）、`vcc-op-calc-import`（`reader.js:18`）共用同一 JSZip 基座，同等暴露。收单（reader-handrolled，yauzl）与 big-table-import 新引擎（zip-reader.js，yauzl）免疫
- **伴生问题（报错信息丢失）**：该失败全链路零落盘——handler 不写日志，链接表管理弹窗显式 `skipLogReport:true`（`renderer-dialogs.js:6399`）绕开 alert 默认 error 日志，C3/运行前提醒两个入口（`renderer.js:3738/3885`）直接丢弃返回值完全静默；用户关掉弹窗后报错文本永久丢失、任何日志找不回
- **修复方案**（按推荐顺序）：
  - A. **短期止血（半天）**：导入入口用无符号读取预检 sheet1.xml/sharedStrings.xml 解压尺寸，≥2^31 直接报明确中文错误（「文件约 X 行过大，请拆分为 80 万行以内分批导入」）；同时去掉 `skipLogReport` 或 handler 补 error 日志，解决报错丢失
  - B. **根治（1-2 天）**：`streaming-xlsx-reader.js` zip 层 JSZip → yauzl（上层行扫描逻辑不动），项目已有两个先例（`reader-handrolled.js`、`big-table-import/zip-reader.js`）；一处改、链接表/pending/biz-op 共同受益
  - C. **长线**：链接表接入 big-table-import 引擎（acquiring spec §8.5 已列为潜在用户），需独立迭代完整 spec
- **风险**：🔴 资金红线 —— 链接表整表覆盖落库是 bank-deposit→ADM 派生链 / gateway-bill C3 的入库真理源，方案 B/C 必须 byte-identical parity 验证（`scripts/test-v3.0.0-linked-streaming-parity.js --deep` 现成）+ 人工复核
- **spec 已同步**：`changes/linked-table-large-file-streaming/spec.md` R-5 阈值已由 ~3.8GB 修正为 2^31（原预警线 ≥100w 行已失效）
- **触发实施**：→ **v3.0.4 已立项**（`changes/v3.0.4/spec.md`，2026-06-11）：方案 A = PR-A（预检 + 报错可见性）；方案 B **不实施**（被 pending/biz-op 直接迁引擎 + PR-A 护栏组合替代，链接表/vcc 留 JSZip 基座由护栏兜底）；方案 C **部分推进**（pending = PR-C、biz-op flow = PR-D 本轮迁引擎；linked-table 迁移仍留本条待独立迭代——缺口为引擎表头扫描模式 + 多表混选分组 dispatch + B8 合并语义）

### B8（P2）链接表 bank-deposit 等四表多选多文件互相覆盖丢数据（v3.0.3 候选）

- **来源**：2026-06-10 链接表导入排查（v3.0.2 会话，用户问"bank-deposit 支持批量导入吗"）
- **影响**：链接表统一导入入口 `linked-table:import`（`src/main.js:11274` 附近）文件对话框带 `multiSelections`，逐文件按表头识别归属表；但 bank-deposit 等四张表落库仍是「整表覆盖」（`replaceLinkedTable` = DELETE 全表 + INSERT，`src/backend/database/linked-table-repository.js:249`）。一次多选 N 个同表文件 → 依次整表覆盖 → **只有最后一个文件的数据留存，前 N-1 个静默丢失**。五张表里仅 gateway-bill 在 v3.0.1（需求1）改成按 ReconBillBizId 幂等累加，其余四张（含银行对账单入金表，资金相关）未改。多选的设计意图是"一次导多张不同的表"，不是"一张表多个文件合并"，但 UI 不阻止也不提示
- **推荐**（按改动量从小到大）：
  - A. **最小止血（推荐先做）**：导入前按表头归类，若同一张表命中 ≥2 个文件 → 弹确认提示「该表为整表覆盖语义，多文件将只保留最后一个，是否继续？」或直接拒绝该组合
  - B. 多选同表文件时在内存合并后一次覆盖（语义变更小，但需定义跨文件去重/排序规则）
  - C. 对齐 gateway-bill 的幂等累加（彻底，但四张表各需定义业务主键，属大改，需单独 spec）
- **风险**：资金相关数据（银行对账单入金表）丢失场景 —— 实施任一方案均需人工复核
- **触发实施**：v3.0.3 收尾窗口带上方案 A；方案 B/C 待用户确认业务主键后单独 spec

### B7（P1）主库膨胀治理（run 级数据出主库）+ 启动窗口先行

- **spec 已落**：`changes/size-startup-optimization/spec.md` Part B（2026-06-10 落档、2026-06-11 与 B6 合并为单一 change，status: propose，8 个拍板点 B-D1~D8 待用户确认；原 `changes/db-bloat-governance-startup-first/` 已并入删除）
- **来源**：2026-06-10 性能/体积调研（v3.0.2 会话，用户报告"打包后体积越来越大、点击后页面显示越来越慢"）；即「change B」
- **影响**：本机实测 `tool-data.sqlite` **15GB**，`PRAGMA freelist_count` = 240 万页 ≈ **9.9GB（61%）为删除后未回收空洞**；`acquiring_bill_currency_bill_imports` 历史累计写入 1846 万行、`diff_rows` 2077 万行 —— run 级原始数据写主库、run 后 DELETE，但**全代码无任何 VACUUM/auto_vacuum 机制**。一次性迁移前 `VACUUM INTO` 全量备份 15GB → 升级后首启实测 **28530ms / 38126ms**（activity log 实证）；`backups/` 已积 31GB + 一份 15GB `.bak`，无清理策略，本机合计 ~62GB。启动链：`src/main.js` whenReady 在 `createWindow()` **之前**同步做 activity log / usage-stats / `database.init()`（106 条 DDL）/ pendingDb（1.5GB）/ own-accounts 迁移 / 模板库同步 → 基线 1.2~1.5s；渲染层初始化仅 ~50ms、建窗到可见 ~110ms（前端不是瓶颈）
- **推荐**：
  1. run 级大表挪 **per-run 独立 SQLite 文件**，run 结束直接删文件（结构性根治：零碎片、零 VACUUM、主库恒小）；**范围必须覆盖全部 run-scoped 表**——acquiring_bill_currency + biz_op_recon（imports 已 166 万行）+ bank_bu_recon，只做 acquiring 会从其他模块缓慢复发
  2. `backups/` 保留最近 2 份 + 启动后台清理
  3. `createWindow()` 提前到 `database.init()` 之前（先出窗口 + loading 态）→ 显示速度与 DB 大小**永久解耦**
  4. 防复发守卫：落 `rules/` 约定「新对账模块 run 级批量数据禁止写主库，必须走 per-run 侧库」
  5. 未来对百万行级持久表（`linked_bank_deposit` 已 131 万行）的迁移避免全表 rebuild，备份按保留策略走
- **临时止血**（用户侧/本机均适用，应用未运行时）：删旧 `.bak` 与 `backups/` 旧份 + 手动 `VACUUM`（15GB→约 6GB），立即恢复启动速度
- **风险**：资金对账数据删除、迁移时序、状态机 —— 必须完整 spec + PRD，分阶段 PR，人工复核
- **触发实施**：单独大 change（建议下个 minor 版本），PM PRD → spec → dev 流程

### B6（P2）打包体积瘦身：files 白名单 + canvas 移 devDeps + 体积断言守卫

- **spec 已落**：`changes/size-startup-optimization/spec.md` Part A（2026-06-10 落档、2026-06-11 与 B7 合并为单一 change，status: propose，3 个拍板点 A-D1~D3 待用户确认；原 `changes/dist-size-slim/` 已并入删除）
- **来源**：同 B7 调研；即「change A」
- **影响**：安装包 135MB，`app.asar` **101MB**（同类应用正常 ~15MB）。构成：`docs/**/*` 42MB（`docs/previews/` 截图 36MB；运行时只有 `docs/USER_GUIDE.md` 被 `src/main.js:4212` 帮助页读取）+ 生产依赖 ~47MB（**`@napi-rs/canvas` 25MB 在 dependencies 但 src/ 零引用**，仅 preview 脚本用；`xlsx` 7.2MB 与 `xlsx-js-style` 9.5MB 双份 SheetJS 并存、各带一份 codepage ~5.9MB）+ `scripts/**/*` 2MB（纯测试/预览脚本）+ `assets/app-icon-source.png` 1.3MB（无运行时引用）
- **推荐**：
  1. `package.json` build.files 改**白名单**（src / index.html / 必要 assets / `docs/USER_GUIDE.md` / COMMON枚举.xlsx），不要黑名单——黑名单下次新增大文件仍会静默进包
  2. `@napi-rs/canvas` → devDependencies
  3. 防复发守卫：dist 后加体积断言脚本（asar 超阈值如 25MB、或包内出现 `docs/previews`/`scripts/` 即 FAIL），挂进打包流程
  4. （独立后续 PR）xlsx 统一到 xlsx-js-style，再 −13MB 原始体积；涉及 8 个 src 文件需回归
- **预期收益**：安装包 135MB → ~85-90MB
- **风险/回归点**：帮助页（USER_GUIDE.md 运行时读取）、win 打包冒烟、preview 脚本仍可用（devDeps 在开发机不受影响）
- **触发实施**：下个发版窗口单独 PR（纯配置改动，低风险）

### B5（P3）`buildScenariosSnapshot`（银行对账单模块）JSON.stringify key 顺序依赖

- **来源**：PR #36 self-review（commit `42e0588`），dev 顺手发现
- **影响**：`src/main.js:2898` `buildScenariosSnapshot`（银行对账单 / C1/C2/C3 资金红线 defense in depth）仍用 `JSON.stringify(s.config || {})`，与 PR #36 P3-C 已修的 C4 同名风险完全镜像 — 同语义 config 在 DB round-trip 前后 key 顺序不同 → 误报 stale-snapshot 拒导出
- **现状**：实际可能性低（Node V8 JSON.parse + stringify round-trip 通常稳定），但 spec 不保证；C4 已用 `stableJsonStringify` 规范化，C1/C2/C3 未对齐
- **推荐**：单独 PR 把 `stableJsonStringify` 提到共享工具（如 `src/main-process/snapshot-utils.js`），让 C1/C2/C3/C4 复用同一规范化逻辑
- **触发实施**：发现银行对账模块出现"明明没改场景但导出被拒（stale-snapshot）"的实际事故；或下次 v2.0.x patch 时一并修

### B4（P3）`recon-id-fix-scenario-ipc` smoke simulator 与真实 main.js 漂移

- **来源**：PR #35 self-review（commit `7327b43`）
- **影响**：`scripts/smoke/recon-id-fix-scenario-ipc.js` 用 simulator 跑 IPC handler 行为，不是真 `ipcMain.handle` 路径。修分流逻辑时如果忘了同步 simulator 会让测试假绿。
- **现状**：simulator 是手工拷贝的 main.js handler 逻辑（含 round 3 的 `clearResultCacheForCategory` 分流）；和真实代码两份维护
- **推荐**：补 simulator-vs-real 一致性断言；或 PR-D 加 electron e2e（spawn electron + IPC roundtrip）做兜底验证
- **触发实施**：v2.1.0-beta.1 PR-D（收尾 + 文档三件套）一并加 e2e；或第二次出现"smoke 绿但真实跑挂"时优先

### B1（P3）`streaming-xlsx-writer.js` 流式 archive 表头字号

- **来源**：PR #34 self-review（commit `9952255`）
- **影响**：121 万行流式 archive xlsx（月度 Pending 留底文件）表头字号未设 10pt；其他 4 处 writer 已统一（`exceljs-writer.js` / `pending-export/writer.js` / `pending-session.js` / `writers.js`）
- **现状**：`src/backend/pending-import/streaming-xlsx-writer.js` 是自定义 OOXML XML writer（绕过 SheetJS 解决 121 万行 × 31 列内存峰值 2-3GB 问题），要在生成的 styles.xml 加 fonts 节
- **推荐**：单独 PR 实施前先做 spike — 验证 OOXML font + styles.xml 兼容（Excel / WPS / Numbers）；流式逻辑本身是性能优化，不能为了表头字号破坏内存收益
- **触发实施**：用户报怨"为什么 archive 文件表头字号不一致" / 流式 writer 因别的原因要重构时

### B2（P3）`FUNCTION_REGISTRY` 与 IPC handler 元数据合并

- **来源**：PR #34 self-review（commit `9952255`）
- **影响**：`FUNCTION_REGISTRY`（`src/backend/usage-stats.js`）和 25 处 `trackedIpcHandle('m', 'f', ...)` 调用（`src/main.js`）两份字符串硬编码维护；未来重命名功能时若漂移 → tickUsageStats 静默忽略 + console.warn，统计偏低且难发现
- **现状**：每次新增"用户感知功能"需要同步两处，靠人工保证不漏
- **推荐**：把功能元数据集中到一处。备选方案：
  - A. IPC channel name → moduleKey/fnKey 映射表（trackedIpcHandle 改为 `trackedIpcHandle(channel, handler)`，从 map 推导）
  - B. usage-stats 模块导出一个 `defineFunction(moduleKey, fnKey)` 工厂，trackedIpcHandle 接收 token 而非字符串
- **触发实施**：第二次出现"漂移导致计数丢失"的实际事故 / 新加 ≥5 个用户感知功能时

### B3（P3）`error-causes` CAUSE_MAP 新增 code 自动 smoke 校验

- **来源**：PR #34 self-review（commit `9952255`）
- **影响**：未来加新 warning code 时若漏映射，`errorCodeToCause` 返回 fallback `未知错误`；当前 smoke E5 仅校验代表性 code（7 个），非全量
- **现状**：`src/main-process/scenario-engines/c1/c2/c3*.js` 等处 `code: 'xxx'` 字符串可被 grep 出来；`CAUSE_MAP`（`src/backend/file-service/error-causes.js`）也是静态对象
- **推荐**：smoke 加一段自动校验
  - 扫 `src/**/*.js` 提取所有 `code: '...'` 字符串
  - 与 `CAUSE_MAP` keys 比对
  - 未映射的 code 报告（默认 fail，可加白名单 escape）
- **触发实施**：下次新增场景算法（C4 / C5 等新场景类）时一并加

## 已完成

（暂无）

## 已废弃

（暂无）
