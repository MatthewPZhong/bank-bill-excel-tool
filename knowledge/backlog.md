# 项目 Backlog（待办候选 / 非阻塞改进）

> 收集已识别但暂不实施的改进项。版本 bump 前过一遍，决定是否升优先级到下一个 PR 的 spec。

## 维护约定

- **添加**：识别到非阻塞改进 → 在 "未实施" 段 append（按时间倒序，最新在上）
- **每条记录格式**：来源（哪个 PR / 哪轮 review）+ 严重等级（P0~P3）+ 影响范围 + 推荐实施时机
- **完成**：单独 PR 落地后从 "未实施" 段移到 "已完成"，引用对应 PR 编号 + commit
- **过期**：明确不再做（如方案被推翻）→ 移到 "已废弃"，写废弃理由

## 未实施

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

- **spec 已落**：`changes/db-bloat-governance-startup-first/spec.md`（2026-06-10，status: propose，8 个拍板点待用户确认）
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

- **spec 已落**：`changes/dist-size-slim/spec.md`（2026-06-10，status: propose，3 个拍板点待用户确认）
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
