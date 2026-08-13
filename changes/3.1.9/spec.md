# v3.1.9 Codex Spec — 存档中心全局批次服务、全任务接入、目录化与设置优化

> - status: `PR1—PR7 本地实现与自动门禁证据完成 / 待独立评审、用户人工验收、合并与正式发布`
> - target-version: `3.1.9`
> - repository: `MatthewPZhong/bank-bill-excel-tool`
> - baseline-policy: 基于 **GitHub 默认分支 `main` 的 v3.1.8 当前代码** 开发；开工时再次锁定实际 HEAD SHA
> - audited-baseline: `main`（`package.json` = `3.1.8`，2026-08-09 复审）
> - audited-at: `2026-08-09`
> - suggested-branch: `codex/v3.1.9-global-archive-batches`
> nature: 本迭代会改变批次身份分配时点、所有业务任务与存档中心的依赖关系、存档物理目录和存储根目录。除 §0.2 明确冻结的 VCC `CNH → CNY`、结果模板列名与异常数据处置外，不得改变任何模块的金额、其他币种、匹配、回填、业务归档或人工调整规则。

---

## 0. Codex 开工约束

1. **以当前默认分支 `main` 的 v3.1.8 为实施基线。** `package.json` 已为 `3.1.8`。Codex 开工时必须记录实际 `main` HEAD SHA；若此后 `main` 又发生业务变更，先重新运行任务策略审计和 `check-vars`，不得继续引用旧的 PR6 冻结头作为实现基线。
2. 本文第 1 章产品决策已全部确认；Codex 不得再次在 A/B 方案之间自行切换。仅当最新代码出现无法归类的新业务 action 或数据安全冲突时才允许提问。
3. 不得把“所有任务执行前来存档中心拿批次号”实现为：
   - 先查询当前最大值，再由调用方自行 `+1`；
   - 各模块各自缓存序号；
   - renderer 生成批次号；
   - 失败时退回旧的模块内序号。
4. 必须由存档中心在单一数据库事务中**原子预留下一批次号**。读取“最新批次”与“申请新批次”必须是两个不同接口。
5. 不得为了可浏览目录删除现有 SHA-256 内容校验、Blob 去重、源文件变化检测、持久 outbox、失败重试、锁定、保留期、只读打开和安全另存为能力。
6. 批次预留不得绕过现有业务操作注册表、退出闸门、更新安装闸门和 worker 取消机制。
7. 存档失败不得静默改变业务计算结果。业务是否允许继续取决于失败阶段：
   - **批次预留失败**：任务不得开始，因为没有合法批次身份；
   - **批次已预留、文件归档失败**：业务结果按现有规则保留，批次标记为不完整并进入持久重试。
8. 所有历史批次、业务事实和审计记录必须可读；不得通过重编号、删除旧表或重写旧 operation key 来“简化”迁移。
9. 所有新 IPC 都必须经过 preload 白名单、主进程参数校验和退出/迁移互斥；renderer 不得传入任意文件系统路径来绕过 Electron 文件夹选择器。
10. 完成后必须反向同步：Spec、tasks、test-spec、implementation-notes、CHANGELOG、用户手册、版本功能历史、重要变量清单、预览和发布证据。PR1—PR6 本地实现完成后可标记“本地实现与自动证据完成”，但代码合并前必须保持“本地发布候选 / 待独立评审、用户人工验收、合并与正式发布”。

## 0.1 VCC 财务 OP 纠错补遗窄范围 Erratum

自 PR2 冻结头 `54b6c01fa93751cd723be53af70af726037343b5` 起，v3.1.9 的以下三类合同由 v3.1.8 上线后[纠错补遗](../3.1.8/erratum/README.md)中的 [Spec v2.1](../3.1.8/erratum/VCC财务OP-3.1.8卡顿与旧归档兼容纠错Spec-v2.md) 和 [TechDoc v1.2](../3.1.8/erratum/VCC财务OP-3.1.8卡顿与旧归档兼容纠错TechDoc-v1.1.md)取代：

1. 标准 v3.1.7 四数据集归档的结构分类与兼容边界；
2. VCC adjustment、archive、unarchive 和 delete 的操作保护路径；
3. 数据管理、归档枚举、删除目标和受保护写操作的性能路径。

本 erratum 原有窄效力保持。第 1 章 C01—C14、PR1 的批次身份合同和 PR2 的 TaskLifecycle/七字段 worker context/终态 CAS 合同不变；金额、主体、九币种余额公式、调整公式和五表计算规则不变。币种集合、结果模板币种列及导入异常处置以后续 §0.2 和补遗 Spec v2.1/TechDoc v1.2 为准。

补遗只前向约束 v3.1.9，不追溯改写 v3.1.8 已发布二进制、tag、冻结 Spec/hash 或人工 `6/6 PASS` 历史证据。分类、runtime 或性能 PROBE 失败时必须阻断后续合并/发布，不得放宽 classifier/guard、伪造 Pending、启用无保护提交或新增 fallback。

## 0.2 VCC CNY 与异常数据过滤合同（2026-08-13）

用户确认并已完成本地实现/自动验证：

1. VCC 九币种唯一集合为 `AUD/CAD/CNY/EUR/GBP/HKD/JPY/SGD/USD`；结果表、校验表、期初、归档和导出用 CNY，不再生成 CNH。
2. “系统财务OP”取消 `CNY → CNH`。新 CNY 原样落库；新 CNH 为不支持币种，按异常主体快照过滤，不自动改写。
3. 结果模板固定币种列由 CNH 改为 CNY；模板 SHA-256 固定为 `48c8161484128e63a6e3e60724336f2433a8f23687695d980720c59a9dec2053`。
4. 明细按行过滤 `invalid_key/format_error/idempotent_conflict`；系统财务 OP 按“主体 × 精确九币种快照”过滤。可信范围内的其他正常行/主体必须继续落库并可审计。
5. 工作簿/Sheet/表头结构不可信、取消、数据库错误、归档门禁等 hard failure 仍整组失败关闭；不得滥用局部过滤。
6. 历史精确 CNH 兼容采用“小型派生事实原子迁移 + 大表读取/导出边界投影 CNY”；原始大表和 raw_json 不批量改写。CNH/CNY 资金坐标冲突以 `vcc-currency-migration-blocked` 零部分提交失败关闭。
7. 顶层 lifecycle 非成功或成功但无结构化 import record 必须显示失败；不得兜底成“新增 0、幂等跳过 0”的假成功。

完整产品/技术合同由补遗 [Spec v2.1](../3.1.8/erratum/VCC财务OP-3.1.8卡顿与旧归档兼容纠错Spec-v2.md) §15 与 [TechDoc v1.2](../3.1.8/erratum/VCC财务OP-3.1.8卡顿与旧归档兼容纠错TechDoc-v1.1.md) §22 承载。已发布的 `changes/3.1.8/spec.md` 继续保持冻结，不用当前修订追溯重写历史。

---

# 1. 已确认产品决策

> 2026-08-09 用户确认：C01—C14 全部采用推荐方案；其中 C14 另行修订为“保留时限下拉框收起即保存”，C02 增加 `parentRunId` 关联任务展示规则。以下均为正式实施决策。

| ID | 优先级 | 需要确认的问题 | 方案 A | 方案 B | 推荐口径 | 影响 | 状态 |
|---|---:|---|---|---|---|---|---|
| C01 | P0 | “拿最新批次号”究竟是读取现有最新号，还是申请下一个新号？ | 原子申请并占用下一个新批次号 | 只读取当前最新批次号 | **A**。只读最新号会让并发任务共用批次，无法保证唯一性 | 决定批次服务 API 和并发正确性 | 已确认 |
| C02 | P0 | 批次粒度是什么？ | 每次实际业务任务调用一个新批次；导入、运行、导出通常分别计次 | 一个完整业务流程共用一个批次；导入、运行、导出可续写 | **A（受 C04 两项窄例外约束）**。凡产生存档 artifact 或独立审计状态的实际任务仍各自计次；`bank-statement:run`、`template:save-mappings` 不计次 | 会改变现有部分模块将导入/运行/导出合并到同批次的行为 | 已确认 |
| C03 | P0 | “所有任务”是否包含只读查询、文件选择、预览和取消按钮？ | 仅实际处理/写入/导出/删除等任务分配批次；只读查询、选择器、预览不分配 | 所有 IPC/按钮动作都分配 | **A**。避免打开页面、刷新列表也增加运行次数 | 决定运行次数、空批次数量及覆盖清单 | 已确认 |
| C04 | P0 | 没有输入/输出文件但会改变业务状态的任务是否建批？例如归档、解归档、人工调整、删除 | 建立“仅任务元数据”的批次；无文件时不强制创建物理目录 | 不建批，仅文件处理任务建批 | **A（2026-08-12 窄化）**。归档、解归档、人工调整、删除等可审计业务状态动作仍建批；`bank-statement:run` 与 `template:save-mappings` 仅产生会话中间结果/配置且无存档文件，不建批、不占号，实际导入/导出仍各自建批 | 决定存档中心是否同时承担任务审计中心职责，并避免无文件中间动作产生空批次 | 已确认 |
| C05 | P0 | 工具箱在存档中心如何归类？ | 新增 archive scope `toolbox`，显示名“工具箱”，出现在存档筛选，但不进入主模块切换菜单 | 归到现有某个业务模块 | **A**，避免污染任一业务模块统计 | 决定模块注册表是“13 个主模块 + 1 个工具范围” | 已确认 |
| C06 | P0 | 批次已预留后任务失败或被取消，是否保留批次号？ | 保留失败/已取消批次，序号永不复用；文件选择阶段取消则不预留 | 删除批次并允许复用序号 | **A**，保证审计和并发安全 | 决定状态机和“最新批次”含义 | 已确认 |
| C07 | P1 | 设置里的“最新批次”显示哪一个？ | 全局最近一次已发放批次，包含成功、失败和取消 | 最近一次成功完成的批次 | **A**，与“最新批次号”及全局序号一致 | 决定统计查询和用户预期 | 已确认 |
| C08 | P1 | 历史批次号是否重写为新格式？ | 历史保持原号，仅 v3.1.9 新任务用新格式 | 全量重编号 | **A**，历史批次是审计身份，不应改写 | 决定迁移风险和旧链接兼容性 | 已确认 |
| C09 | P1 | “文件总大小”的统计口径是什么？ | 所有 ready 运行文件的显示大小之和；同一内容被两个批次引用时计两次 | 实际 Blob 去重后的物理占用 | **A**，最接近用户看到的运行文件总量 | 决定数字是否等于现有 `logicalBytes` 或 `uniqueBytes` | 已确认 |
| C10 | P1 | 点击【变更】后是否迁移历史存档？ | 完整复制、校验并原子迁移全部历史存档后切换 | 仅新批次写新地址，旧批次仍留旧地址 | **A**，保持单一存档位置和可解释性 | 决定迁移状态机、耗时和磁盘空间要求 | 已确认 |
| C11 | P1 | 年/月/日/批次目录与现有去重 Blob 如何共存？ | 保留内部 Blob 真相，批次目录始终使用独立 copy；历史 hardlink 只识别并脱钩 | 删除 Blob 去重，全部改为无 canonical 真相的普通副本 | **A**，保留完整性、重试和共享引用能力，同时避免批次文件与 canonical 共享 inode | 决定磁盘占用、篡改隔离和删除语义 | 已确认（review 收口） |
| C12 | P2 | 设置页文案和按钮状态细节 | “版本管理”只改导航及页标题；内部“自动更新”开关仍保留；锁定后反向按钮显示 `🔓` | 页面内所有“自动更新”都改名；锁定/解锁始终显示 `🔒` | **A**，语义清晰且不改变功能名称 | 主要影响 UI 和无障碍文案 | 已确认 |
| C13 | P2 | 用户选择的地址如何解释？ | 选中的文件夹本身就是存档根目录 | 在选中目录下再自动创建“存档中心”子目录 | **A**，地址显示与实际目录一致 | 决定路径展示和迁移目标 | 已确认 |
| C14 | P2 | 保留期限如何保存？ | 下拉框选择值后，在下拉框收起/完成选择时立即保存；【返回】仅返回 | 点击【返回】时再保存 | **A（经用户修订）**。即时保存，失败时恢复最近一次已保存值并提示 | 决定设置页保存触发点与失败恢复 | 已确认 |

### 1.0.1 C02 关联任务显示补充决策

同一业务流程内的多个独立批次使用持久化 `parentRunId` 关联。`parentRunId` 为内部字段，不直接显示给用户。批次详情页标题区固定展示规则：

```text
2026-08-09-002    关联任务：2026-08-09-001/002/003
VCC财务OP校验
```

规则：

1. “关联任务”显示在批次号右侧，不另起第三行。
2. 仅同一 `parentRunId` 下存在至少 2 个当前可见批次时显示；仅 1 个批次时隐藏。
3. 包含当前批次本身，不显示“导入/运行/导出/调整”等具体任务名称。
4. 同一天批次按 `global_daily_sequence` 升序并压缩日期前缀，例如 `2026-08-09-001/002/003`。
5. 跨自然日时按日期分组，例如 `2026-08-09-126/127 · 2026-08-10-001/002`；禁止把不同日期错误压缩成同一前缀。
6. 每个显示出的批次号可点击并切换到对应批次详情；当前批次也可显示但点击为 no-op。
7. 历史 v1 批次没有 `parentRunId` 时不显示关联任务。
8. 删除某个关联批次后，刷新详情必须只显示仍存在的关联批次；批次号本身不得因删除而重排或复用。
9. 应用重启后关联关系必须保持，不允许依赖 renderer 内存。

## 1.1 可直接锁定、无需再确认的技术约束

以下不是产品偏好，而是由需求和现有数据模型共同决定：

1. 新批次号去掉模块代码后，当日序号必须在所有模块和工具范围之间共享；否则不同模块会同时生成 `2026-08-08-001`。
2. 新批次号固定为 `YYYY-MM-DD-NNN`，日期来自应用所在机器的本地自然日。
3. 序号至少补齐 3 位；达到 1000 后显示 `1000`，不得截断或回绕。
4. “申请新批次”必须是数据库原子操作；`getLatestBatch()` 不能承担分配职责。
5. 历史兼容、并发唯一性、操作幂等和任务状态必须有自动化测试，不得只做前端字符串替换。
6. `parentRunId` 表示“一次业务流程实例”，不是月份、模块、源文件 hash 或永久业务实体 ID；任何模块都不得自行按“同月=同流程”推断。
7. 新业务流程创建新的 `parentRunId`；同一流程的后续运行/导出/状态动作继承；存档重试不创建新 `parentRunId`，用户明确重新开始一轮业务流程时必须创建新值。
8. “最新批次”是最后一次**已发放**的 v2 批次号；即使该批次后来被永久删除，latest issuance 仍不得倒退，下一号仍从历史游标继续递增。

---

# 2. 迭代目标与非目标

## 2.1 目标

v3.1.9 完成以下能力：

1. 批次号从 `{模块代码}-{日期}-{当日序号}` 改为 `{日期}-{全局当日序号}`。
2. 存档中心升级为全局批次服务：为全部业务模块及工具箱在任务开始前分配批次身份。
3. 建立机器可验证的“任务—批次策略注册表”，任何新增业务任务未声明策略时 CI 失败。
4. 存档中心覆盖全部 13 个主业务模块，并补齐当前缺失的 VCC财务OP校验；工具箱作为独立工具范围接入。
5. 批次列表改为严格两行布局；详细页按钮改为 `🔒/🔓`、【打开】和 `💾`。
6. UI 移除“唯一文件”“逻辑文件”“文件引用”等技术术语，改为“文件总大小”“运行次数”“最新批次”。
7. 支持通过【变更】选择并安全切换存档位置。
8. 运行文件按“年份 / 月份 / 日期 / 批次号”目录存放。
9. 设置页右下角【确认】改为【返回】；导航和对应页标题“自动更新”改为“版本管理”。

## 2.2 非目标

本迭代不提供：

- 从存档中心恢复业务数据库或覆盖原业务文件；
- 在存档中心直接编辑 Excel；
- 云端同步、加密盘、跨设备共享或批量压缩下载；
- 修改业务计算、匹配、金额、币种、余额、归档或人工调整规则；
- 将日志、应用数据库、缓存、模板、更新包本身作为普通运行文件归档；
- 修改工具箱合并/拆分的格式保真、Sheet 选择、日期系统或大文件算法；
- 把工具箱加入左上角主业务模块启用列表。

---

# 3. 基线审计结论

## 3.1 版本基线

- 当前默认分支 `main` 的 `package.json` 已为 **v3.1.8**；3.1.9 可直接以当前 `main` 为基线。
- v3.1.8 已把 VCC财务OP校验的输入门禁、完整结果/人工调整、受控解归档、删除边界、历史月份导出和正式结果模板带入主分支。
- 旧的 `codex/v3.1.8-pr6-release@9eabde3...` 仅保留为历史审计证据，不再作为 3.1.9 开工基线。

## 3.1.1 v3.1.8 对本 Spec 的影响结论

1. **基线变化**：原 Spec 假设 `main` 仍为 v3.1.7，现已失效；v3.1.9 直接基于当前 v3.1.8 `main`。
2. **VCC 财务OP接入范围扩大但总体架构不变**：v3.1.8 已形成“导入 → 双层预检 → 计算 → 一次性调整 → 归档/解归档 → 删除 → 历史导出”的持久状态机，因此 3.1.9 必须按真实 action 分类，而不是只接“导入/运行/导出”。
3. **只读动作必须排除**：`run:preflight`、月份/记录/详情查询、adjustment options、unarchive preview、delete/export preview 等不产生新批次；否则仅打开弹窗就会污染“运行次数”。
4. **可独立审计的无文件业务状态动作必须建批**：opening initialize、adjustment add、archive、unarchive、resolve、delete 等按 C04 建“元数据批次”，但不强制创建空物理批次目录。`bank-statement:run` 只是当前会话导出的中间计算，`template:save-mappings` 只是模板配置保存；两者不生成存档 artifact，按 2026-08-12 用户裁决不建批、不占用批次号。银行对账实际输入与最终输出仍分别由导入、导出动作建批。
5. **历史导出必须建独立批次**：v3.1.8 支持历史已归档月份导出；每次真实生成结果文件均是新任务、新批次，输出文件归档到该批次。
6. **取消语义需复用当前受保护后台任务**：`task:cancel` 不创建新批次，只终结当前 active batch 为 cancelled；不得破坏 v3.1.8 worker/租约/退出保护。
7. **关联任务必须可跨重启恢复**：v3.1.8 已支持重启后恢复已归档结果入口，故 `parentRunId` 必须持久化并尽量绑定业务 run/operation identity。
8. **资金红线不变**：3.1.9 只包裹批次生命周期和文件存档，不得修改 v3.1.8 的 46 列 Pending 契约、金额精度、九币种计算、adjustment lineage、revision gate、解归档尾月限制、删除 allowset、结果模板或审计事实。

因此：**3.1.8 对 3.1.9 有中等程度实现影响，但没有需求冲突，也不需要推翻全局批次服务方案。**

## 3.2 当前模块与任务覆盖

主模块注册表共有 13 个模块：

| # | moduleId | 显示名 | 当前存档策略 |
|---:|---|---|---|
| 1 | `statement-generator` | 网银账单生成 | 已有 |
| 2 | `new-account-generator` | 新开账户余额账单生成 | 已有 |
| 3 | `pending-reconciliation` | 月度Pending数据核对 | 已有 |
| 4 | `bank-statement-process` | 资金对账数据处理 | 已有 |
| 5 | `recon-id-fix` | 对账单修复 | 已有 |
| 6 | `bank-bu-recon` | 月度银行对账单BU回填校验 | 已有 |
| 7 | `biz-op-recon` | 业务OP数据核对 | 已有 |
| 8 | `acquiring-bill-currency` | 收单单据币种校验 | 已有 |
| 9 | `vcc-op-calc` | VCC业务OP计算 | 已有 |
| 10 | `vcc-financial-op` | VCC财务OP校验 | **缺失；renderer 还显式从存档筛选初始集合中排除** |
| 11 | `pre-fund-reconciliation` | 前置资金对账 | 已有 |
| 12 | `duplicate-inbound-match` | 重复入金匹配 | 已有 |
| 13 | `position-reconciliation-process` | 平盘对账数据处理 | 已有，含内部别名流程 |

工具箱当前通过独立 API 暴露：

```text
toolbox:merge
toolbox:split:read
toolbox:split:export
```

现有 `operation-tracker.js` 没有 `vcc-financial-op`，也没有工具箱通道。

## 3.3 当前批次创建时点

现有 tracker 主要在任务成功后：

- 收集导入文件；
- 运行成功后创建批次；
- 导出成功后追加输出；
- 或对部分即时文件操作在成功后单独建批。

因此当前实现不满足“任务执行前先由存档中心分配批次号”。本迭代必须从单纯的 after-operation 文件跟踪器升级为 before/after 成对的任务生命周期。

## 3.4 当前批次号与序号

当前实现：

```text
批次号：{MODULE_CODE}-{YYYYMMDD}-{NNN}
序号作用域：(module_code, local_date)
序号表：archive_batch_sequences
批次号：archive_batches.batch_number 全局唯一
```

去掉模块代码但继续按模块计数会发生全局重复，因此必须新增全模块共享的日流水。

## 3.5 当前物理存储

当前存档根主要包含：

```text
存档中心/
├─ blobs/sha256/{前2位}/{64位sha256}
├─ .staging/
└─ .readonly/
```

批次仅通过 artifact 引用 SHA-256 Blob，尚无用户可浏览的年/月/日/批次目录。

## 3.6 当前统计与设置

当前统计包含：

- `uniqueBytes`；
- `logicalBytes`；
- `batchCount`；
- `logicalFileCount`；
- 失败文件等内部诊断字段。

当前根目录由主进程固定为：

```js
path.join(ensureStorageRoot(), '存档中心')
```

尚无存档地址设置、文件夹选择器、迁移 journal 或运行时切换机制。

## 3.7 当前 UI

当前界面仍包含：

- “唯一文件”“逻辑文件”“文件引用”“批次”；
- 批次列表为批次号、模块、状态/时间三段式；
- 锁定标识/按钮使用菱形或旧图标；
- 打开为 `↗`，另存为 `↓`；
- 设置导航及页面标题为“自动更新”；
- 底部按钮为【确认】。

---

# 4. 核心领域模型

## 4.1 区分三个概念

### 4.1.1 最新批次

只读查询结果，用于设置页展示：

```text
latest issued batch = 全局最后一次成功提交的批次预留记录
```

不得用于计算下一编号。

### 4.1.2 预留批次

任务开始前由存档中心原子创建：

```text
reserveTaskBatch(...)
  -> batchId
  -> batchNumber
  -> localDate
  -> sequence
  -> taskStatus = reserved
```

批次一经成功预留，编号永不复用。

### 4.1.3 运行文件

本次任务实际读取、处理或生成的文件。文件归档可以在任务执行前后分阶段完成，但必须归属于已经预留的 `batchId`。

## 4.2 新批次格式

```text
{YYYY-MM-DD}-{SEQUENCE}
```

示例：

```text
2026-08-08-001
2026-08-08-002
2026-08-08-999
2026-08-08-1000
```

规则：

1. 日期取批次预留提交时的本地日期。
2. 序号在 13 个主模块与工具箱范围之间共享。
3. 同一 task operation key 的幂等重放返回原批次，不增加序号。
4. 事务失败回滚序号；批次提交后即使任务失败、取消或批次被删除也不得复用。
5. 模块代码继续保留为元数据，但不再进入新批次号。

## 4.3 批次状态

业务任务状态与文件存档状态必须分离：

```text
taskStatus:
  reserved
  running
  succeeded
  failed
  cancelled

archiveStatus:
  staging
  complete
  incomplete
```

典型组合：

| 场景 | taskStatus | archiveStatus |
|---|---|---|
| 已预留，尚未执行 | `reserved` | `staging` |
| 业务执行中 | `running` | `staging` |
| 业务成功、文件完整 | `succeeded` | `complete` |
| 业务成功、一个文件存档失败 | `succeeded` | `incomplete` |
| 业务失败、输入已留档 | `failed` | `complete` 或 `incomplete` |
| 用户在任务开始后取消 | `cancelled` | 按已登记文件计算 |

不得把 VCC 等业务模块自己的 `archived/calculated` 状态映射为存档中心 `archiveStatus`。

---

# 5. 全局批次服务设计

## 5.1 服务职责

新增稳定单例，例如：

```text
ArchiveBatchRuntime
├─ BatchAllocator
├─ ArchiveService delegate
├─ TaskPolicyRegistry
├─ maintenance lock
└─ active storage root
```

职责：

- 原子分配批次号；
- 查询最新批次；
- 维护任务状态；
- 接收输入/输出 artifact；
- 在存储根迁移后原子切换 delegate；
- 为主进程 handler 和 worker 提供统一任务上下文。

### 5.1.1 TaskPolicyRegistry 必须覆盖“未知 action”

CI 不能只验证“已经被登记到 registry 的 action”。所有有业务副作用的 IPC 必须统一经受控 helper 注册，或由静态扫描纳入 action inventory。

硬规则：

1. 新增 mutating/action IPC 若没有 `reserve | exclude(reason)` policy，测试/CI 直接失败。
2. 允许裸 `ipcMain.handle` 的通道必须位于显式 query/picker/navigation allowlist，并写明理由；禁止 wildcard。
3. CI 扫描 `src/main.js` 及拆分 service 注册点，对照 preload 暴露通道、business operation registry 和 task policy 三方集合。
4. worker 内部真实副作用不得因为“没有单独 IPC”逃过父 action 的 batch context。
5. action inventory 的新增/删除必须有快照/契约测试，防止以后新增按钮绕过批次服务。

## 5.2 内部 API

建议最小接口：

```js
reserveTaskBatch({
  moduleId,
  moduleName,
  moduleCode,
  taskKey,
  operationKey,
  parentRunId,
  metadata
})

markTaskStarted(batchId)
appendTaskFiles({ batchId, files, sourceOperation, metadata })
completeTaskBatch(batchId, options)
failTaskBatch(batchId, failure)
cancelTaskBatch(batchId, cancellation)
getLatestBatch({ moduleId? })
```

三个 terminal 接口以 positional `batchId` 为唯一调用形态；第二参数承载对应完成、失败或取消上下文。PR1 仅实现当前所需字段，后续 PR 可在同一 positional 契约的 options/metadata 内追加字段，不增加 object-form overload。

返回 DTO 至少包含：

```js
{
  batchId,
  batchNumber,
  localDate,
  dailySequence,
  taskStatus,
  archiveStatus
}
```

### 5.2.1 `parentRunId` / 业务流程身份契约

新增统一 `BusinessFlowResolver`（可内置于 runtime，但职责必须独立可测），负责决定一个 action 是“新流程”还是“继承已有流程”。模块调用方不得自己拼接或猜测 `parentRunId`。

统一规则：

- 新导入/新计算链首次进入实际业务副作用前创建一个新的稳定 ID，例如 UUID；
- 同一次用户流程中后续 run/export/adjust/archive 等 action 继承该 ID；
- 已有稳定业务 `runId` / `operationToken` 时，可作为 resolver 的证据，但不得直接把“月份”或“源文件 hash”当成 `parentRunId`；
- 用户明确重新运行、重新导入并形成新的业务流程时创建新 ID，即使月份和源文件相同；
- 仅存档重试、打开、另存为、查询、preview 不创建也不改变 `parentRunId`；
- 应用重启后，通过持久业务 identity / `archive_batches.parent_run_id` 恢复关联；不得靠 renderer state；
- 无法证明应该继承时默认创建新流程，禁止把不确定任务错误串入旧流程。

建议 API：

```js
resolveBusinessFlow({
  moduleId,
  taskKey,
  businessRunId,
  operationToken,
  explicitParentRunId,
  startsNewFlow
}) -> { parentRunId, source }
```

`source` 仅用于日志/测试，可为 `new | business-run | operation-token | inherited`。

## 5.3 明确禁止的 API 用法

```js
const latest = await getLatestBatch();
const next = latest.sequence + 1; // 禁止
```

调用方只能：

```js
const batch = await reserveTaskBatch(...);
```

## 5.4 任务执行顺序

对需要分配批次的动作，统一顺序：

```text
1. 完成纯 UI 输入收集、文件选择和危险操作确认
2. businessOperationRegistry.begin(...)
3. reserveTaskBatch(...)
4. 捕获/绑定输入文件快照或受保护 staging
5. markTaskStarted(batchId)
6. 执行业务副作用或 worker
7. 追加实际输入/输出文件
8. complete / fail / cancel batch
9. businessOperationRegistry.end(...)
```

关键规则：

- 文件选择器取消发生在第 3 步之前，不产生批次。
- 第 3 步失败时，业务不得开始。
- 第 3 步完成后，任何失败都要终结该批次，不得删除后复用序号。
- worker 由主进程预留批次，再把只读 `batchContext` 传给 worker；worker 不得自行分配。
- 已有 `AsyncLocalStorage` 可继续用于进程内传播，但持久 operation key 不能只存在于内存。

## 5.5 幂等与重试

- 同一业务任务恢复/重放使用稳定 `operationKey`，返回原批次。
- 用户主动重新执行一次相同参数的任务，应生成新的 `taskRunId`，从而获得新批次。
- 文件存档重试复用原 `batchId`，不得创建新批次。
- 业务重跑是新任务，必须创建新批次，并在 metadata 中记录 `retryOfBatchId`。

---

# 6. 数据库设计与迁移

## 6.1 新增全局日流水表

```sql
CREATE TABLE IF NOT EXISTS archive_daily_sequences (
  local_date TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
  updated_at TEXT NOT NULL
);
```

首次迁移 seed：

```text
global_seed(date)
  = SUM(archive_batch_sequences.last_sequence for date)
```

使用历史游标之和，而不是当前可见批次数，避免已删除批次的序号被复用。

## 6.2 `archive_batches` 加法迁移

建议新增：

```text
batch_format_version INTEGER NOT NULL DEFAULT 1
global_daily_sequence INTEGER NULL
task_key TEXT NULL
task_run_id TEXT NULL
parent_run_id TEXT NULL
task_status TEXT NOT NULL DEFAULT 'succeeded'
reserved_at TEXT NULL
started_at TEXT NULL
finished_at TEXT NULL
failure_code TEXT NULL
failure_message TEXT NULL
```

索引：

```sql
CREATE UNIQUE INDEX ...
ON archive_batches(local_date, global_daily_sequence)
WHERE global_daily_sequence IS NOT NULL;

CREATE UNIQUE INDEX ...
ON archive_batches(module_id, operation_key)
WHERE operation_key IS NOT NULL AND operation_key <> '';

CREATE INDEX ...
ON archive_batches(parent_run_id, local_date, global_daily_sequence)
WHERE parent_run_id IS NOT NULL AND parent_run_id <> '';
```

说明：

- 旧行：`batch_format_version=1`、`global_daily_sequence=NULL`；原 `daily_sequence` 保持历史模块内序号。
- 新行：`batch_format_version=2`，并固定 `daily_sequence = global_daily_sequence`。这样旧代码/DTO 读取 `dailySequence` 仍有有效值，同时保留旧 `(module_code, local_date, daily_sequence)` 唯一约束。
- 旧 `(module_code, local_date, daily_sequence)` 数据和约束保留；不要高风险重建旧表。
- `parent_run_id` 只对可证明同一业务流程的新批次写入；历史行不回填猜测值。
- 旧行默认 `task_status='succeeded'` 仅用于兼容展示，不伪造新的任务时间线。

## 6.3 预留事务

```text
BEGIN IMMEDIATE
  1. 按 module_id + operation_key 查幂等批次；存在则返回。
  2. UPSERT archive_daily_sequences(local_date)，last_sequence + 1。
  3. 读取新全局序号。
  4. batch_number = formatBatchNumber(local_date, sequence)。
  5. INSERT archive_batches(... task_status='reserved')。
COMMIT
```

任一步失败必须整体回滚。

## 6.4 artifact 目录字段

建议为 `archive_artifacts` 增加：

```text
storage_relative_path TEXT NULL
storage_mode TEXT NULL      -- copy；hardlink 仅用于识别并脱钩历史候选
storage_layout_version INTEGER NOT NULL DEFAULT 1
safe_file_name TEXT NULL
artifact_order INTEGER NULL
materialization_error_code TEXT NULL
materialization_error_message TEXT NULL
materialization_failed_at TEXT NULL
```

`original_name` 继续保留业务文件名；安全目录名不得覆盖原始显示名。
`storage_relative_path` 是 layout v2 materialized 文件在存档根下的相对路径，不再新增同义路径列。目录化状态由既有 canonical 状态和上述字段派生，不新增第二套状态列：

- `legacy/pending`：artifact 为 `ready`，但仍是 layout v1/无有效路径，且目录化错误为空；
- `materialized`：artifact 为 `ready`，layout v2 的 path/mode/name/order 完整，且目录化错误为空；
- `repair-pending`：artifact 为 `ready`，但目录化错误非空，或启动/读取校验发现 v2 证据无效后写入错误。

`last_error_code/last_error_message` 只描述 canonical ingest；目录化失败不得改写 canonical `status/blob_id`。修复成功清空三个 `materialization_error_*` 字段。

## 6.5 新设置项

```text
archive_center_storage_root
archive_center_instance_id
```

- 未设置时使用当前默认根。
- 成功迁移后保存规范化绝对路径。
- 配置路径暂时离线时不得静默改回默认路径。
- `archive_center_instance_id` 由数据库以 conflict-safe get-or-create 语义先持久化稳定 UUID；根 marker 的 `archiveInstanceId` 只能来自该 setting，迁移不得改变它，marker 也不得反向成为实例 ID 的来源。

---

# 7. 任务策略注册与全模块覆盖

## 7.1 统一注册表

新增机器可读注册表，例如：

```js
ARCHIVE_TASK_POLICIES = {
  [channel]: {
    scopeId,
    taskKey,
    batchPolicy: 'reserve' | 'exclude',
    excludeReason,
    inputResolver,
    outputResolver,
    idempotencyResolver
  }
}
```

## 7.2 CI 契约

必须自动比较：

```text
全部已注册业务 action IPC
= 有 reserve 策略的 action
  ∪ 有明确 exclude 策略及原因的 action
```

禁止：

- 未注册时静默 `handled:false`；
- 新模块通过前端过滤隐藏；
- 用通配符把所有未知通道自动排除；
- 仅维护手工文档而无可执行测试。

允许的排除原因枚举：

```text
read-only-query
file-picker-only
preview-only
cancel-active-task
archive-center-maintenance
ui-navigation
```

## 7.3 范围注册表

主业务模块保持 13 个；新增一个 archive-only 工具范围：

```js
{
  id: 'toolbox',
  code: 'TOOLBOX',
  name: '工具箱',
  kind: 'utility'
}
```

契约：

```text
主模块注册表 13 个
+ archive utility scopes 1 个
= 存档中心筛选可见范围 14 个
```

内部别名 `LINKED`、`PREFUNDTEMP`、`POSITIONLINK` 不作为额外筛选模块。

## 7.4 现有模块迁移原则

现有 12 个已接入模块：

- 保留输入文件识别、第一次结果、失败重试、源变化检测和业务幂等规则；
- 只把“成功后新建批次”改为“执行前预留、成功/失败后终结”；
- 不得借此次重构改变导入事务粒度、worker 恢复点或导出内容。

## 7.5 VCC财务OP校验任务策略

v3.1.8 暴露的通道应逐项登记。按 C03/C04 推荐口径：

### 7.5.1 `reserve`

| 通道 | 任务名 | 文件角色 |
|---|---|---|
| `vccFinancialOp:import:apply` | 导入文件 | 实际成功处理的源文件为 input |
| `vccFinancialOp:run:calculate` | 计算 | 通常无文件；记录任务元数据和 runId |
| `vccFinancialOp:opening:initialize` | 初始化首月期初 | 通常无文件 |
| `vccFinancialOp:run:archive` | 业务归档 | 通常无文件；不得与存档中心状态混用 |
| `vccFinancialOp:run:adjustment-add` | 添加人工调整 | 通常无文件；记录 adjustmentId/revision，不记录敏感明细到通用日志 |
| `vccFinancialOp:run:unarchive` | 解归档 | 通常无文件 |
| `vccFinancialOp:imports:resolve` | 处理导入记录 | 按真实动作决定是否有 input |
| `vccFinancialOp:data-manager:delete` | 删除数据 | 无文件或保存既有审计导出，按实际结果登记 |
| `vccFinancialOp:export:result` | 导出结果 | writer 返回的全部结果文件为 output |
| `vccFinancialOp:data-manager:export` | 导出数据 | 实际生成文件为 output |
| `vccFinancialOp:export:import-audit` | 导出导入审计 | 实际生成文件为 output |

### 7.5.2 `exclude`

| 通道 | 原因 |
|---|---|
| `vccFinancialOp:import:pick-files` | `file-picker-only` |
| `vccFinancialOp:task:cancel` | `cancel-active-task`，应终结当前批次而非创建新批次 |
| `vccFinancialOp:run:preflight` | `preview-only` / 只读校验 |
| `vccFinancialOp:run:adjustment-options` | `read-only-query` |
| `vccFinancialOp:run:archived-months` | `read-only-query` |
| `vccFinancialOp:run:unarchive-preview` | `preview-only` |
| `vccFinancialOp:run:get` | `read-only-query` |
| `vccFinancialOp:run:latest-archived` | `read-only-query` |
| `vccFinancialOp:imports:list-months` | `read-only-query` |
| `vccFinancialOp:imports:list-records` | `read-only-query` |
| `vccFinancialOp:imports:get-detail` | `read-only-query` |
| `vccFinancialOp:data-manager:overview` | `read-only-query` |
| `vccFinancialOp:data-manager:delete-targets` | `read-only-query` |
| `vccFinancialOp:data-manager:delete-preview` | `preview-only` |
| `vccFinancialOp:data-manager:export-preview` | `preview-only` |

最终以 v3.1.8 合并代码的真实通道为准；缺失或新增通道必须在 CI 报错，不能从表中猜测后忽略。

## 7.6 工具箱任务策略

### 7.6.1 合表

通道：`toolbox:merge`

流程：

1. 完成多文件选择与输出位置确认；取消则不预留。
2. 预留工具箱批次。
3. 对全部输入捕获稳定快照/受保护 staging。
4. 执行现有合表算法。
5. 成功后归档全部实际输入和最终输出。
6. 业务成功但存档失败时，输出仍返回成功，批次为 `incomplete`。

### 7.6.2 拆表准备

通道：`toolbox:split:read`

按推荐口径为 `file-picker-only/preview-only`，不单独预留批次；其选择的源文件信息只作为后续 `split:export` 的准备上下文，不能被当作可信字节摘要。

### 7.6.3 拆表导出

通道：`toolbox:split:export`

1. 在字段和值选择完成、输出路径确认后预留批次。
2. 重新验证源文件与 `split:read` 时一致；若不一致，失败关闭并要求重新选择。
3. 归档源文件和最终输出。
4. 大文件 worker 与普通路径使用同一批次策略，不得因引擎分支产生两个批次。

## 7.7 任务上下文

统一传递：

```js
{
  batchId,
  batchNumber,
  taskRunId,
  taskKey,
  moduleId
}
```

- 主进程、worker、writer、outbox 和日志关联使用 `batchId`。
- 不强制把批次号写入 Excel 单元格或业务输出文件名；本迭代只要求存档目录和任务元数据使用批次号。
- 通用日志可以记录批次号，但不得记录完整用户源路径或表格内容。

---

# 8. 存档目录结构

## 8.1 目标结构

```text
{archiveRoot}/
├─ 2026/
│  └─ 2026-08/
│     └─ 2026-08-08/
│        └─ 2026-08-08-001/
│           ├─ 输入文件.xlsx
│           └─ 结果文件.xlsx
├─ blobs/
│  └─ sha256/{前2位}/{64位sha256}
├─ .staging/
└─ .readonly/
```

层级：

| 层级 | 格式 | 示例 |
|---|---|---|
| 母文件夹 | `YYYY` | `2026` |
| 子文件夹 | `YYYY-MM` | `2026-08` |
| 孙文件夹 | `YYYY-MM-DD` | `2026-08-08` |
| 子孙文件夹 | 真实批次号 | `2026-08-08-001` |

目录日期必须来自 `archive_batches.local_date`，不得从文件名或 UTC 时间字符串截断推断。

## 8.2 运行文件物化

每个 ready artifact 在批次目录中提供可读取文件：

1. SHA-256 Blob 仍是完整性真相。
2. materialized 文件必须与 canonical Blob 拥有独立 inode；不得从 Blob 建 hardlink。
3. 使用 staging 流式复制，校验成功后再原子发布到批次目录。
4. copy 完成后复核大小与 SHA-256。
5. 目录化失败不得把已成功 Blob 误标为丢失；读取可回退 canonical Blob，批次标记待修复。
6. 用户点击【打开】仍生成只读副本，不直接把内部运行文件交给 Excel/WPS 编辑。
7. `另存为` 继续走安全复制。
8. materialized copy 完成后设置只读属性/权限；应用自身不得原地写入。
9. 打开详情、启动一致性检查和 repair 路径发现 materialized 文件大小/hash 与 canonical Blob 元数据不一致时，必须 fail-closed，禁止把 materialized 文件反向吸收为新 Blob。
10. 历史 `storage_mode=hardlink` 或检测到与 canonical 共享 inode 时，必须先验证 canonical，再在有界前台/后台 repair 队列中脱钩为独立 copy；不得继续把共享 inode 交给用户入口。
11. materialized copy 被改写时，只删除并从 canonical Blob 重新物化即可；不得改变 artifact identity，也不得影响引用同一 Blob 的其它批次。
12. Windows/Excel/WPS 人工验收必须验证批次目录文件不能被应用原地保存覆盖；需要编辑时只能通过【打开】产生的只读副本或【另存为】导出副本。

## 8.3 文件名

- 首选 `original_name`。
- Windows 非法字符替换为 `_`。
- 处理 `CON`、`PRN`、`AUX`、`NUL`、`COM1` 等保留名。
- 尾随点、尾随空格和超长路径必须安全处理。
- 同批次同名文件稳定命名：

```text
文件.xlsx
文件 (2).xlsx
文件 (3).xlsx
```

- 保留扩展名；必要时缩短主体并附短 hash。
- 重启或历史迁移后命名不得漂移。

## 8.4 无文件批次

按 C04 推荐口径：

- 数据库保留批次及任务元数据；
- 没有 ready artifact 时不创建空物理目录；
- 存档中心详情显示“本次任务无运行文件”，而不是“文件存档失败”；
- 后续若该批次追加文件，再创建目录。

例外：`bank-statement:run` 与 `template:save-mappings` 不属于本节的元数据批次。它们经过业务退出/升级互斥闸门执行，但不进入 TaskLifecycle、不预留批次号。历史已经发放的空批次保留原号，不删除、不重排、不复用。

## 8.5 历史目录化

- 历史批次号不改写。
- 历史 ready artifact 通过可恢复迁移逐步物化到：

```text
YYYY/YYYY-MM/YYYY-MM-DD/{旧批次号}/
```

- 旧批次号含模块前缀也直接作为目录名。
- 迁移可中断续跑；未物化期间继续从 Blob 打开和另存。
- 普通应用启动的前台预算必须同时限制 v2 artifact metadata 扫描、repair-pending 证据持久化和实际 repair；默认最多处理 64 个 artifact 就允许 runtime delegate/UI 可用。未扫到的剩余 artifact 由同一 root serialization 后台分块续跑，不得在 `initialize()` 返回前全量 `lstat`/写 failure。
- 按需打开/另存仍对目标 artifact 强校验并可就地修复；存储根迁移切换前的 `verifyHashes=true` 仍必须对权威全集做全量 SHA-256/size 校验，不受 64 条启动预算限制。

## 8.6 删除与保留期自动清理的目录生命周期

永久删除批次与 `cleanupExpired()` 必须共用同一套物理回收编排，禁止各自实现一份：

```text
删除/到期批次元数据授权
  -> 删除该 batch 的 materialized files
  -> 删除空 batch 目录
  -> 逐级删除空 日期/月/年 目录
  -> 计算 Blob 引用
  -> 最后引用消失时删除 canonical Blob
```

规则：

- 锁定批次仍不得被 `cleanupExpired()` 删除；
- 物理目录删除失败不得复活已经授权删除的业务元数据，应进入单一 `archive_cleanup_jobs` cleanup-pending 重试证据；
- 不允许因为某一批次到期而删除仍被其他批次引用的 Blob；
- 自动清理、手工删除、存档重试和存储根迁移必须受 maintenance/runtime 锁协调；
- 空目录回收失败只记清理告警，不得影响其它批次读取。

`archive_cleanup_jobs` 每个原批次最多一条，payload 只保存数据库权威的相对路径：batch id/number/local date/layout dir、materialized relative paths，以及仅最后引用 canonical Blob 的 relative path/hash/size；不得保存绝对路径、`source_path` 或目录扫描猜出的项目。job 插入、issuance tombstone、batch/artifact 删除和最后引用 Blob 元数据删除必须处于同一事务；任一步失败整体回滚。

手工删除、`cleanupExpired()` 与启动续跑共用同一个幂等 executor：先删 job 记录的 materialized files 并尝试 `rmdir` 空 batch/date/month/year，再删最后引用 canonical Blob，最后删除 job。materialized 删除未完成时不得提前删除 canonical fallback。`ENOTEMPTY` 仅表示该层仍被占用；其它失败更新同一 job 的 attempt/error 并在重启后续跑，不递归、不猜目录、不复活元数据。

---

# 9. 存储位置变更

## 9.1 UI 与 IPC

设置页：

```text
存档位置：D:\Finance\Archive                         [变更]
```

新增 preload API：

```js
archiveCenter.changeStorageLocation()
```

IPC：

```text
archive-center:change-storage-location
```

主进程打开：

```js
showOpenDialog({
  title: '选择存档位置',
  buttonLabel: '选择文件夹',
  properties: ['openDirectory', 'createDirectory']
})
```

renderer 不传目标路径。

## 9.2 目标校验

允许：

- 空目录；
- 当前应用创建、marker 与当前 archive instance 一致的根目录；
- 经原子写入探针验证的本地盘、移动盘或网络目录。

拒绝：

- 当前根的祖先或子目录；
- 应用安装目录、数据库目录、临时目录及内部技术子目录；
- 非空且不属于本应用的普通目录；
- 属于另一个 archive instance 的根；
- 只读目录；
- symlink/junction 绕过后的被拒位置；
- 空间明显不足的卷；容量预估必须覆盖全部缺失 canonical Blob 与全部缺失/需脱钩 materialized copy 的额外空间，不得依赖 hardlink 节省空间或只按源目录表面大小估算；
- 无法完成“创建→写入→flush→重命名→读取→删除”探针的目录。

## 9.3 根标记

例如：

```json
{
  "type": "bank-bill-excel-tool-archive-root",
  "schemaVersion": 2,
  "archiveInstanceId": "stable-uuid"
}
```

marker 不得含业务数据或源文件绝对路径。
marker 文件名固定为 `.archive-root.json`；内容只允许上述 `type/schemaVersion/archiveInstanceId` 三个身份字段。

### 9.3.1 v3.1.8 legacy 根首次启动 bootstrap

v3.1.8 及更早的默认存档根没有 v2 marker。首次运行 v3.1.9 时不得仅因 marker 缺失就把自己的历史根判为“未知目录”。满足以下全部条件时，可在 maintenance lock 内原子补写 marker：

1. 路径等于当前已配置/默认 archive root；
2. 当前数据库 `archive_blobs.relative_path`、现有 Blob 和 artifact 引用能够通过一致性检查；
3. 目录中不存在另一 instance marker；
4. 不存在无法解释的冲突性内部结构；普通用户额外文件按安全规则拒绝或要求人工选择新根，不得自动删除。

补写 marker 前后都要有崩溃恢复测试；该 bootstrap 只建立根身份，不改历史 batch number、Blob hash 或 operation key。

## 9.4 迁移状态机

journal 位于存档根之外，例如：

```text
{userData}/run-data/archive-center/storage-migration.json
```

阶段：

```text
prepared
  -> copying
  -> materializing-layout
  -> verifying
  -> switched
  -> cleanup-pending
  -> done
```

流程：

1. 获取 archive maintenance lock。
2. 等待当前批次写入和 outbox 到安全点，拒绝新存档写操作。
3. 校验源、目标、空间和 marker。
4. 原子写 journal `prepared`。
5. **只流式复制 canonical Blob 与根身份所需 marker；不得递归复制旧批次 materialized files。** `.readonly/` 不迁移，`.staging/` 必须在进入 copying 前清空/恢复到可证明安全状态。
6. 在目标根根据数据库 ready artifact **重新 materialize** 年/月/日/批次目录；无论同卷或跨卷均生成与 canonical 独立的 copy。
7. 逐 canonical Blob 和重新物化文件校验大小与 SHA-256。
8. 用目标根初始化新 service 并执行一致性检查。
9. 在单一提交点保存 `archive_center_storage_root` 并切换 runtime delegate。
10. `switched` 后所有新任务只写新根。
11. 尝试清理旧根；失败进入 `cleanup-pending`，不得回滚已成功切换的新根。
12. 完成后清理 journal。

失败规则：

- `switched` 前失败：旧根继续唯一有效，设置值不变。
- `switched` 后失败：新根继续有效，只重试旧根清理。
- 任何阶段不得双写两个根。
- 异常退出后按 journal 恢复，不得猜测。

## 9.5 迁移期间 UI

- 【变更】显示【变更中…】并禁用。
- 展示阶段和已处理文件数/总数，不展示完整文件路径。
- 禁止第二次迁移、永久删除、批次重试和新存档任务。
- 读取既有详情可继续；若实现无法安全并发，显示明确维护提示。
- 用户不能通过关窗或更新安装跳过保护阶段。

---

# 10. 统计 DTO 与 UI

## 10.1 新统计 DTO

```js
{
  storagePath,
  fileTotalBytes,
  runCount,
  latestBatchNumber,
  latestBatchId,
  latestBatchStatus,
  migrationStatus
}
```

内部仍可保留：

```text
uniqueBytes
uniqueFileCount
logicalFileCount
failedFileCount
```

但普通 UI 不显示。

## 10.2 统计规则

按推荐口径：

- `fileTotalBytes`：全部 ready artifact 的 size 之和；同内容被两个批次引用时计两次。
- failed/pending artifact 不计入。
- `runCount`：当前未删除批次数，包含无文件任务、失败和取消批次。
- `latestBatchNumber`：全局最近发放批次号，必须来自不可回退的 issuance 游标/发行记录，而不是当前可见 `archive_batches` 的最大行。
- 删除批次后 `runCount` 减少，但 `latestBatchNumber` **不倒退**；例如已发放 `001/002/003` 后删除 `003`，仍显示 `003`，下一次发放为 `004`。
- 全局序号游标不回退。

## 10.3 存档中心顶部

原：

```text
唯一文件 12.3 GB
```

改：

```text
文件总大小 12.3 GB
```

## 10.4 存档设置

推荐布局：

```text
存档位置：D:\Finance\Archive                         [变更]

文件总大小      12.34 GB
运行次数        128                  最新批次  2026-08-08-128
```

要求：

- 删除唯一/逻辑比例进度条。
- 删除“唯一文件”“逻辑文件”“文件引用”。
- “运行次数”左，“最新批次”右。
- 长路径单行省略，hover/title 显示完整值。
- 无批次时最新批次显示 `-`。

---

# 11. 前端详细要求

## 11.1 批次列表两行布局

```text
第一行：模块名                               批次号
第二行：存档状态                             时间
```

建议 DOM：

```html
<button class="archive-center-batch-item">
  <span class="archive-center-batch-row archive-center-batch-row-primary">
    <strong data-role="archive-batch-module">模块名</strong>
    <span data-role="archive-batch-number">2026-08-08-001</span>
  </span>
  <span class="archive-center-batch-row archive-center-batch-row-secondary">
    <span data-role="archive-batch-status">已完成</span>
    <time data-role="archive-batch-time">14:36:08</time>
  </span>
</button>
```

规则：

1. 左列左对齐，右列右对齐。
2. 第一行左侧使用正式模块/工具范围名称。
3. 批次号不换行；空间不足省略，title 保留完整值。
4. 已锁定标记可紧跟批次号，不能增加第三行。
5. 第二行继续使用现有状态颜色。
6. 时间按本地 `HH:mm:ss`；详情可显示完整日期时间。
7. 新旧批次号布局一致。
8. hover、选中、焦点和 `aria-current` 不回归。

## 11.2 批次详情标题区与关联任务

标题区固定为同一行的“当前批次号 + 关联任务”，模块名仍显示在下一行：

```text
2026-08-09-002    关联任务：2026-08-09-001/002/003
VCC财务OP校验
```

DTO 必须提供结构化关联数据，不允许 renderer 根据字符串猜测：

```js
{
  batchNumber: '2026-08-09-002',
  parentRunId: '...',          // 内部字段，不渲染
  relatedBatches: [
    { batchId: 101, batchNumber: '2026-08-09-001', localDate: '2026-08-09', globalDailySequence: 1 },
    { batchId: 102, batchNumber: '2026-08-09-002', localDate: '2026-08-09', globalDailySequence: 2 },
    { batchId: 103, batchNumber: '2026-08-09-003', localDate: '2026-08-09', globalDailySequence: 3 }
  ]
}
```

渲染规则严格执行 §1.0.1；同日压缩日期、跨日分组、至少 2 个才显示、不显示任务名、不显示 `parentRunId`。点击关联号调用已有详情加载链切换 `selectedBatchId`，不得重新请求/生成业务任务。

### 11.2.1 详细页按钮

#### 锁定

- 未锁定时动作按钮：`🔒`，title/aria-label 为“锁定批次”。
- 已锁定时反向动作：`🔓`，title/aria-label 为“解除锁定”。
- 锁定不参与自动清理、删除禁用等现有行为不变。

#### 打开

旧图标按钮“打开只读副本”改为可见文字按钮：

```text
打开
```

- title/aria-label 可保留“打开只读副本”。
- 行为仍是创建并打开只读副本。

#### 另存为

按钮内容改为：

```text
💾
```

- title/aria-label 为“另存为”。
- 行为不变。

## 11.3 设置页

- 左侧导航“自动更新”改为“版本管理”。
- 对应 pane 标题改为“版本管理”。
- 页面内部开关仍叫“自动更新”。
- 右下角【确认】改为【返回】。
- 保留期限下拉框采用即时保存：用户完成选择并收起下拉框后立即调用 `setRetentionDays`；成功后更新 `savedRetentionValue`，失败时恢复最近一次已保存值并显示错误。
- 即时保存必须使用递增 request token / latest-intent 语义：快速 `60→90→180` 时，只允许最后一次用户意图 `180` 更新 UI；旧请求晚返回不得覆盖新值。
- 保存请求进行中再次选择时记录最新 pending value，并在当前请求结束后继续保存最新意图；不得并发产生顺序不确定的 DB 最终值。
- 【返回】只负责返回上一层，不承担保存职责；若仍有未完成保存请求则临时禁用【返回】或等待最后一次保存 settle 后返回，禁止关闭后旧 Promise 再修改已销毁 DOM。

## 11.4 无障碍和缩放

至少验证：

- 键盘 Tab 顺序；
- Enter/Space 激活；
- `aria-label` 与图标动作一致；
- 100%、125%、150% 缩放；
- 最小窗口；
- 长模块名、长路径、旧批次号；
- 中文 Windows 字体回退。

---

# 12. 兼容、回滚与数据安全

## 12.1 历史兼容

- 旧批次号不改写。
- 搜索、列表、详情、锁定、删除、重试、打开和另存同时支持新旧格式。
- 旧批次缺少 task 元数据时，详情显示现有 source operation 或“历史任务”。
- 旧 outbox 记录重放后继续绑定原 operation key；不得意外分配新批次。
- 启动重放后仍留存的普通 retry outbox（例如源文件/存档盘临时不可用、终态冲突）必须继续保护原 batch 和源文件，但不得阻止整个应用/UI 启动；用户需能进入存档中心诊断或重试。
- 只有无法安全接管的 owner/committed receipt，或无法验证 owner 批次保护集的状态，可以 fail-closed 阻止新业务。Toolbox committed receipt 只能在原 exact7 batch 的全部输入/输出 artifact ready 且 terminal 耐久后明确 ack/删除；普通 outbox `remaining > 0` 不得代替该 owner 证明。

## 12.2 读取回退

```text
1. layout v2 运行文件存在且有效 -> 使用
2. 否则 canonical Blob -> 使用并安排目录修复
3. 两者都失效 -> 沿用 ARCHIVE_BLOB_INVALID / 重试流程
```

## 12.3 业务与存档隔离

- 批次已预留后，文件存档失败不得回滚已提交业务结果。
- 但批次预留本身失败时，任务不得开始。
- 任何模块不得因存档重构改变金额、匹配、1:1 消费、月份状态、adjustment revision 或导出模板。

## 12.4 回滚

- schema 迁移全部加法，旧表和旧字段保留。
- 地址迁移 `switched` 前可继续旧根。
- `switched` 后以新根为真相，不自动反向搬迁。
- 历史批次不重编号，因此代码回滚不需要恢复身份。
- 已使用新根或新格式批次后，不支持无准备降级到不认识这些字段的旧版本；发布说明必须明确备份和回迁步骤。

---

# 13. 预计修改范围

## 13.1 必改

```text
package.json
package-lock.json
CHANGELOG.md
docs/USER_GUIDE.md
docs/VERSION_FEATURE_HISTORY.md
changes/3.1.9/spec.md
changes/3.1.9/tasks.md
changes/3.1.9/test-spec.md
changes/3.1.9/implementation-notes.md

src/backend/database/archive-repository.js
src/backend/database/migrations.js
src/backend/database/settings-repository.js
src/main-process/business-operation-registry.js
src/main-process/archive-center/archive-service.js
src/main-process/archive-center/controller.js
src/main-process/archive-center/operation-tracker.js
src/main-process/archive-center/outbox-store.js
src/main.js
src/preload.js
src/renderer.js
src/styles-gemini-extra.css
```

## 13.2 建议新增

```text
src/main-process/archive-center/archive-runtime.js
src/main-process/archive-center/batch-allocator.js
src/main-process/archive-center/task-policy-registry.js
src/main-process/archive-center/module-scope-registry.js
src/main-process/archive-center/storage-layout.js
src/main-process/archive-center/storage-materializer.js
src/main-process/archive-center/storage-location-manager.js
```

允许按现有架构合并文件，但职责必须等价；禁止把全部逻辑继续堆入 `src/main.js`。

## 13.3 重点业务接线

```text
VCC财务OP主进程 handlers / service / worker
工具箱 merge/split handlers 与大文件 worker
平盘对账 operation lifecycle
现有 archive source snapshot / outbox 保护链
```

---

# 14. 规范 PR 拆分与串行顺序

冻结顺序为：`PR2 → PR2.5-0 → PR2.5-A → PR2.5-B → PR2.5-C1 → PR2.5-C2 → PR3-VCC → PR3-Toolbox → PR4 → PR5 → PR6 → PR7`。所有 PR 串行，从直接前序冻结头建立；不得并行合并、跨过中间合同，或让后续 PR 依赖未提交的本地文件。PR2 人工 GUI/资金验收仍是整组 merge gate；若验收改变 PR2 核心合同，PR2.5 及后续整链必须 rebase 到新的 PR2 冻结头。

## PR1 — 批次身份与数据库迁移

- 全局日流水；
- batch format v2；
- task 状态字段；
- 原子 `reserveTaskBatch()`；
- 最新批次查询；
- 历史 seed 与兼容测试；
- `parent_run_id` 索引、latest issuance 不倒退、v2 `daily_sequence=global_daily_sequence`。

## PR2 — 任务生命周期与策略注册表

- before/after task wrapper；
- business operation registry 接线；
- policy coverage CI；
- worker batch context；
- 现有 12 模块迁移，不改业务算法；
- `BusinessFlowResolver` / `parentRunId` 创建、继承、重跑与跨重启契约。

## PR2.5-0 — Spec / TechDoc 合同冻结

- 仓库内 v3.1.8 纠错补遗与来源证据；
- v3.1.9 本窄范围 erratum；
- Unknowns Register、测试矩阵和发布门禁；
- 纯文档，不修改生产或测试代码。

## PR2.5-A — Compat foundation

- ArchiveEvidenceV2 与生效结果纯校验器；
- pure classifier 与 gate 分离；
- 真实 v3.1.7 fixture 及分类测试；
- 不切换现有生产入口。

## PR2.5-B — Read performance

- read worker、schema-ready、snapshot/token v2；
- 集合化 archive/result evidence；
- active month visibility、delete target one-shot preview；
- data manager shell/cache、SQL trace 与读取性能。

## PR2.5-C1 — Guard + adjustment/archive

- mutation guard、table/SQL step registry、largeTableScopeProof；
- adjustment/archive 固定预算与受保护失败审计；
- adjustment/archive 写 worker 和确认归档性能验收。

## PR2.5-C2 — Unarchive/delete

- current/legacy unarchive 固定计划；
- opening/result/source delete 固定计划；
- audit materialization、progress/cancel、故障注入与约 16 GB 删除验收。

## PR3-VCC — VCC 财务 OP TaskLifecycle 接线

- VCC 全通道 reserve/exclude 登记；
- 七字段 worker context、BOR、cancel 与 terminal CAS；
- metadata/artifact 登记；
- 不修改本纠错业务合同。

## PR3-Toolbox — 工具箱独立接线

- 工具箱 archive scope；
- merge/split 输入输出归档；
- 不触碰 VCC classifier、token 或 guard。

## PR4 — 年/月/日/批次目录化

- layout builder；
- artifact 物化字段；
- 独立 copy 与历史 hardlink 脱钩；
- 历史目录化；
- 删除、读取回退和修复测试；
- copy 只读/篡改 repair、历史 hardlink 脱钩、retention 自动目录清理。

## PR5 — 存储地址变更

- 设置键；
- root marker；
- maintenance lock/runtime delegate；
- journal、复制、验证、切换和恢复；
- IPC 与进度 UI；
- legacy root marker bootstrap；迁移只复制 canonical Blob 并在目标重新 materialize。

## PR6 — 前端和统计

- 两行列表；
- `🔒/🔓`、【打开】、`💾`；
- 文件总大小、运行次数、最新批次；
- 【变更】、【返回】、版本管理；
- CSS、无障碍和预览；
- 批次号右侧“关联任务”展示、点击切换、跨日格式；
- 保留期限即时保存 latest-intent 竞态保护。

## PR7 — 发布收口

- 版本号 3.1.9；
- 文档和实施偏差反向同步；
- release-check、设置布局/预览已完成；变量门禁改为 peeled v3.1.8 baseline review，Windows 最终静态证据须在 release tooling 修复 commit 后由 clean isolated checkout 生成；
- 独立评审、Windows/Excel/WPS/资金人工门禁和正式发布证据仍待完成。

每个 PR 必须可独立评审；后续 PR 不得依赖未提交的本地文件。

---

# 15. 自动化测试矩阵

## 15.1 批次号和分配器

1. 同日同模块连续分配：`001`、`002`。
2. 同日不同模块和工具箱交错：全局 `001`、`002`、`003`。
3. 14 个可见范围并发 100 次，无重复、无丢号。
4. 相同 operation key 重放返回同批次，不增加序号。
5. 新用户任务即使参数相同也因新 taskRunId 获得新批次。
6. 预留事务中途失败，序号和批次同时回滚。
7. 批次提交后任务失败，序号不回退。
8. 批次删除后序号不复用。
9. 本地日期跨天后从 `001` 开始。
10. 999、1000、1001 格式正确。
11. 旧库按历史游标之和 seed，已删除历史仍计入。
12. `getLatestBatch()` 只读，不产生序号。
13. 任一调用方试图自行传 batchNumber 被拒绝。
14. 应用重启后继续递增。
15. v2 新行满足 `daily_sequence === global_daily_sequence`；v1 历史行原 `daily_sequence` 不改。
16. 已发放 `001/002/003` 后删除 `003`，`latestBatchNumber` 仍为 `003`，下一批次为 `004`。
17. `archiveStatus` 仅允许 `staging/complete/incomplete`；`taskStatus=failed` 不要求扩展旧 CHECK。

## 15.2 任务生命周期

1. 文件选择取消：无批次。
2. 危险确认取消：无批次。
3. 预留失败：业务 handler/worker 未执行。
4. 预留成功后业务成功：task succeeded。
5. 业务失败：task failed，批次保留。
6. 运行中取消：原批次 cancelled，不建第二批次。
7. 业务成功、文件归档失败：task succeeded + archive incomplete。
8. outbox 重放修复原批次，不建新批次。
9. worker 崩溃后恢复复用原 operation key。
10. 更新安装/退出闸门与预留顺序正确。
11. 一次新流程创建新 `parentRunId`，同流程后续动作继承。
12. 同月份/同源文件的第二次明确重跑创建新的 `parentRunId`，不得串入前一流程。
13. 存档重试复用原 batch/parent，不创建新流程；重启后可从持久 identity 恢复。

## 15.3 策略覆盖

1. 全部业务 action IPC 均有 reserve 或明确 exclude。
2. 未登记新通道时 CI 失败。
3. 不允许 wildcard exclude。
4. 静态扫描发现新的裸 `ipcMain.handle` 且不在显式 query/picker/navigation allowlist 时 CI 失败。
5. preload 暴露通道、主进程注册通道、business operation registry 与 TaskPolicyRegistry 的集合差异必须可解释且有快照测试。
6. 13 主模块各有 primary scope。
7. 工具箱有 utility scope，出现在存档筛选但不出现在主模块启用列表。
8. renderer 不再排除 VCC财务OP。
9. 内部别名不增加重复筛选项。
10. worker 内部副作用必须继承父 action `batchId/parentRunId`，不能另建幽灵批次或无批次执行。

## 15.4 VCC财务OP

1. 五类输入文件成功导入均归属本次预留批次。
2. 取消、格式失败、worker 异常均正确终结批次。
3. calculate、opening、archive、adjustment、unarchive、delete 等无文件动作按 C04 口径记录。
4. 结果导出包含 writer 返回的全部文件。
5. 数据导出和导入审计导出分别建立任务批次。
6. preview/list/get 不增加运行次数。
7. task cancel 只取消活动批次。
8. 除 §0.2 的 CNY/异常处置修订外，VCC 金额、九币种余额公式、revision、调整序列、业务归档和历史导出语义与 v3.1.8 一致。
9. 当前九币种精确为 `AUD/CAD/CNY/EUR/GBP/HKD/JPY/SGD/USD`；新系统财务 OP 的 CNY 不再转 CNH，新 CNH 不接受。
10. 明细混合正常/异常行时正常行进入 effective，异常行留审计；系统混合完整/异常主体时只提交完整主体九币种快照。
11. 导入摘要分别报告新增、幂等跳过与异常过滤；failed/busy/空 records 不显示零行假成功。
12. 历史 CNH 升级不得合并冲突资金坐标、批量改写大表或丢失 raw 审计；结果/归档/导出统一投影为 CNY。

## 15.5 工具箱

1. merge 选择 N 个输入，产生一个工具箱批次，含 N input + 1 output。
2. merge 文件选择/另存取消不建批。
3. split:read 不建批。
4. split:export 建一个批次，含源文件和输出。
5. split:read 后源文件变化，split:export 失败关闭。
6. 普通/大文件 worker 路径均只建一个批次。
7. Excel/WPS 打开结果无新回归；格式保真和日期系统行为不变。
8. 业务成功但存档失败仍返回输出路径，批次可重试。

## 15.6 目录结构

1. 精确生成 `2026/2026-08/2026-08-08/2026-08-08-001`。
2. 输入和输出进入同一任务批次目录。
3. 无文件批次不误报失败。
4. 同名文件稳定追加 `(2)`。
5. Windows 非法字符、保留名、尾随点/空格、长路径安全。
6. materialized copy 与 canonical 内容一致且 inode 独立。
7. copy 完成后 hash/大小一致并设置只读。
8. 目录文件损坏可回退 Blob 并标记修复。
9. 历史批次保持旧号并可目录化。
10. 删除批次只删除对应运行文件；共享 Blob 仍被其它批次使用。
11. 最后引用删除后 Blob 清理。
12. 空年份/月/日目录安全清理。
13. 启动修复 orphan、断链和 staging。

## 15.7 地址迁移

1. 取消选择零变化。
2. 选择当前目录 no-op。
3. 空目录完整迁移。
4. 同 instance 根恢复。
5. 非空普通目录拒绝。
6. 另一 instance 拒绝。
7. 源根祖先/子目录拒绝。
8. symlink/junction 绕过拒绝。
9. 只读目录探针失败，旧根继续。
10. 空间不足在复制前失败。
11. 跨卷 copy 成功。
12. 网络目录按探针决定是否允许。
13. 第 N 个 Blob 复制失败，设置未切换。
14. 第 N 个 artifact 物化失败，设置未切换。
15. hash 校验失败，设置未切换。
16. 每个 journal 阶段模拟崩溃，重启后结果唯一。
17. switched 后旧根删除失败，新根仍有效。
18. 配置根离线时不静默回默认。
19. 迁移期间新任务、删除、重试和第二次迁移被互斥。
20. 迁移期间退出/更新安装受保护。
21. 容量预估始终计入缺失 canonical Blob 与 materialized copy 最坏空间；历史 hardlink 脱钩也计入额外副本空间。
22. 跨卷迁移只读取源 canonical；目标侧先复制 canonical Blob，再重新生成独立 materialized copy。
23. `.readonly/` 不迁移；`.staging/` 未清理到安全状态时不得进入 copying。

## 15.8 统计与 UI

1. fileTotalBytes 按 C09 口径。
2. runCount 与批次数一致。
3. latestBatchNumber 按 C07 口径。
4. UI 无“唯一文件”“逻辑文件”“文件引用”。
5. 顶部和设置页显示文件总大小。
6. 运行次数右侧显示最新批次。
7. 批次列表严格两行。
8. 锁定/解锁为 `🔒/🔓`。
9. 打开为文字【打开】。
10. 另存为为 `💾`。
11. 底部为【返回】。
12. 导航和 pane 标题为“版本管理”。
13. 自动更新开关仍叫“自动更新”。
14. 100%/125%/150%、最小窗口和长文本通过截图/布局断言。
15. 单批次无关联时不显示“关联任务”。
16. 同一 `parentRunId` 三个同日批次显示 `2026-08-09-001/002/003`，包含当前批次且不显示任务名。
17. 不同 `parentRunId` 不串联；历史无 `parentRunId` 不显示。
18. 跨日关联显示分组日期格式；点击关联批次号切换详情且不创建新批次。
19. 重启后 relatedBatches 与显示保持；删除其中一项后只刷新剩余关联。
20. 保留期限快速连续选择仅最后一次用户意图生效，旧 Promise 不反写 UI。

## 15.8.1 copy isolation / cleanup / legacy root 专项

- materialized copy 只读保护生效；应用不原地写入，且与 canonical inode 独立。
- copy 被外部修改后从 canonical Blob 可恢复；canonical 与引用同 Blob 的其它批次保持不变。
- 历史 hardlink 在 canonical 可信时脱钩为 copy；canonical hash 与 DB 记录不符时仍 fail-closed，不接受新 hash。
- `cleanupExpired()` 删除 materialized batch 目录并逐级清空空日期/月/年目录。
- 一个 Blob 被多个批次引用时，删除/到期单一批次不删除共享 Blob；最后引用消失才删除。
- v3.1.8 legacy 默认根无 marker 时可在一致性证明成立后 bootstrap；未知/冲突目录不能自动认领。
- 存储根迁移只从源 canonical 读取内容；目标目录重新生成独立 materialized copy。

## 15.9 既有能力回归

- 保留期限 30/60/90/180/365/永久；
- 锁定批次不自动清理；
- 永久删除二次确认；
- source changed 防错存；
- 同字节替代源重试；
- 持久 outbox；
- 正常退出等待；
- 只读打开；
- 安全另存为；
- 平盘异常报告恢复；
- 自动更新与重启安装；
- 数据库迁移幂等；
- 大文件内存稳定。

---

# 16. 自动门禁与人工验收

## 16.1 自动门禁

至少执行：

```bash
npm run release-check
npm run verify:app-settings-layout
npm run preview:archive-center
npm run scan:vars
npm run check:vars:release
npm run check:dist
```

新增/等价专项：

```bash
node --test tests/unit/archive-batch-allocator.test.js
node --test tests/unit/archive-task-policy-registry.test.js
node --test tests/unit/archive-operation-tracker.test.js
node --test tests/unit/archive-storage-layout.test.js
node --test tests/unit/archive-storage-location-manager.test.js
node --test tests/unit/archive-center-ui-contract.test.js
node --test tests/unit/toolbox-archive-integration.test.js
node --test tests/unit/vcc-financial-op-archive-integration.test.js
```

禁止通过以下方式让测试通过：

- 删除旧格式兼容断言；
- 把失败/取消批次过滤出运行次数；
- mock 掉全部真实复制/hash；
- 只测空目录迁移；
- 跳过 Windows 路径；
- 把工具箱或 VCC财务OP从期望范围移除；
- 用 wildcard 把未知 action 排除；
- 仅检查 UI 字符串存在而不验证行为。

## 16.2 Windows 人工验收

- [ ] 安装版和便携版均可选择新目录。
- [ ] 系统盘到另一盘符迁移成功。
- [ ] 中文、空格和长目录成功。
- [ ] 大存档迁移有进度且应用不假死。
- [ ] 迁移后旧批次可打开、另存、锁定、删除、重试。
- [ ] 迁移失败时旧路径完整可用。
- [ ] 文件资源管理器可见年/月/日/批次及运行文件。
- [ ] Excel/WPS 可打开批次目录副本和【打开】生成的只读副本。

## 16.3 产品验收

- [ ] 同日跨模块/工具箱批次号连续且不重复。
- [ ] 除 C04 明确的 `bank-statement:run`、`template:save-mappings` 两项 no-archive-artifact 例外外，所有实际归档任务执行前已拿到批次号。
- [ ] 查询、预览、文件选择是否计次与 C03 一致。
- [ ] 无文件状态任务是否计次与 C04 一致。
- [ ] 13 个主模块和工具箱均可在存档中心筛选。
- [ ] 批次列表、详情按钮、统计和设置文案符合需求。
- [ ] 最新批次和运行次数口径符合确认结果。
- [ ] 存档地址变更与历史迁移符合确认结果。
- [ ] 批次详情批次号右侧按规则显示“关联任务：2026-08-09-001/002/003”，不显示具体任务名和内部 `parentRunId`。
- [ ] 同流程关联可跨重启恢复；重新开始一轮业务流程不会串入旧关联。
- [ ] materialized copy 不与 canonical 共享 inode且不可被应用原地修改；外部篡改有完整性告警/修复路径。
- [ ] 删除最新批次后“最新批次”不倒退，下一次发号不复用。
- [ ] 保留期限快速连续修改最终值等于最后一次选择，【返回】不承担保存。

---

# 17. 验收标准

v3.1.9 只有同时满足以下条件才可标记完成：

1. 新批次号是真实数据库身份，不是前端裁剪。
2. 所有需要分配的任务在业务副作用前完成原子预留。
3. 并发、失败、取消、恢复和重试不会重复或复用批次号。
4. 13 个主模块和工具箱均有机器可验证的任务策略。
5. VCC财务OP和工具箱已真实接入，不是仅加入筛选枚举。
6. 年/月/日/批次目录内存在可读取运行文件，同时完整性和重试能力不退化。
7. 地址变更在失败、取消和异常退出下不会丢失或分叉存档。
8. UI 完成全部文案、布局和按钮要求。
9. 自动化、Windows/Excel/WPS 和业务回归门禁通过。
10. 所有确认项已形成正式决策记录，Spec 与实现无未解释偏差。
11. `parentRunId` 的创建、继承、重跑、删除和跨重启行为均有契约测试，关联任务 UI 不串流程。
12. copy 隔离/历史 hardlink 脱钩、retention cleanup、legacy root bootstrap 和跨卷迁移均通过真实文件系统专项测试。
13. `archiveStatus` 继续严格兼容现库三态 `staging/complete/incomplete`；业务失败只由 `taskStatus=failed` 表达，不偷偷重建旧表扩枚举。
14. VCC CNY 合同、结果模板 hash、异常过滤单位、数量守恒和历史 CNH fail-closed 迁移符合 §0.2 及补遗 Spec v2.1/TechDoc v1.2。

---

# 18. Codex 完成清单

- [x] C01—C14 已确认并回写（C14=下拉框收起即保存）。
- [x] 开工时已记录 v3.1.8 `main@63c1ce46357587643e506768f712352cbb6c7127` 基线；各串行 PR 的精确冻结头与证据见 preflight/implementation-notes。
- [x] 全局日流水、batch format v2 与原子任务批次分配完成。
- [x] task 状态与 archive 状态分离，archiveStatus 保持现库三态。
- [x] `parentRunId` / BusinessFlowResolver 生命周期和关联详情 DTO 完成。
- [x] 全 action policy registry、裸 IPC 静态 inventory 与 CI 契约完成。
- [x] 13 主模块 + 工具箱范围完成。
- [x] VCC财务OP真实任务全通道登记完成。
- [x] 工具箱 merge/split 真实输入与最终输出接入完成。
- [x] 历史批次、标准 v3.1.7 四数据集旧归档兼容完成；未知结构继续阻断。
- [x] 年/月/日/批次目录、Blob 完整性/去重/重试、独立 copy、历史 hardlink 脱钩、只读、repair/fail-closed 与 retention 目录清理的本地实现和自动证据完成。
- [x] 存储地址选择、marker、journal、迁移/恢复与 legacy root bootstrap 的本地实现和自动证据完成。
- [x] 统计 DTO、两行列表、关联任务、按钮、【返回】、“版本管理”和保留期限 latest-intent 的本地实现和自动证据完成。
- [x] PR1—PR6 聚焦测试、各阶段完整自动门禁和 PR6 预览/布局证据完成，结果见 test-spec/implementation-notes。
- [x] PR7 `release-check`、设置布局、预览与 peeled v3.1.8 baseline important-vars review 完成；旧 clean-worktree false-green 与 dirty/pre-commit 四资产证据已撤回。
- [x] 打包入口的 `build.files` dirty/untracked fail-closed 和包内 build-info/source HEAD 一致性门禁已实现并有定向回归。
- [ ] 本轮最终 commit 后由 clean isolated checkout 完成唯一 Windows x64 build、`check:dist` 与 updater staging；本项即使通过也不替代 Windows runtime 人工验收。
- [ ] 独立 Sol Ultra 评审、用户 P0/P1 人工验收、合并、tag 和正式发布。
- [ ] Windows installer/portable runtime、目标生产 legacy/trigger、约 16 GB、约 700 万行、跨卷/网络盘、Excel/WPS 与资金人工复核。
- [x] Spec、tasks、test-spec、implementation-notes 和三份用户发布文档已反向同步为本地候选状态；PR7 本地自动门禁与静态构建证据已追加。

## askUserQuestion 门槛

C01—C14 已确认。只有以下情况允许 Codex 再次询问：

1. v3.1.8 最终合并代码出现本文未覆盖的新业务 action，且无法判定其是否应分配批次；
2. 真实历史存档根被外部程序混入文件，无法通过 marker、数据库和 hash 判断归属；
3. 目标 Windows 环境无法完成安全流式 copy，且复制会违反已确认容量约束；
4. 某业务任务在“预留批次前”已经发生不可逆副作用，无法通过重排或兼容层满足需求。

提问前必须给出代码路径、最小复现场景、数据/审计影响和推荐解决方案，不得只说“需求不清楚”。
