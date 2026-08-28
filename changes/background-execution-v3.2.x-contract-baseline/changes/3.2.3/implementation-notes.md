# Implementation Notes

## Baseline

- Goal/spec: [`spec.md`](./spec.md) 与 [`techdoc.md`](./techdoc.md) 的 E09-C current/all generation。
- Initial plan: 先取证 session scope、legacy generation seam 与 Publisher，再实现 dormant Service generation、Main validation/publication seam 和专项回归。
- Done when: Service 仅从私有 session 选择 entries，复用既有 generation seam 写 task staging，Main 只接收 bounded manifest 并在全部校验通过后 all-or-none 发布；production 仍 disabled/legacy/0 workers，专项和既有回归通过。

## Task Brief / Unknowns Register

### Goal / Context / Constraints / Done when

- Goal: 实现 `statement:generate-current` / `statement:generate-all` 的 dormant canonical execution。
- Context: E09-P0/A/B 已冻结 DTO、Service session、token reservation 与 waiting-user 生命周期；当前 HEAD 是 `654393e9a24c772f51db9114888a2114382ce39d`。
- Constraints: 不接 live Renderer/IPC，不启用 production，不实现 E09-D manual seed settlement 或 E10；不把 detail rows/prepared batch/大 workbook 状态带回 Main；warning 与业务顺序保持 legacy。
- Done when: 真实临时 XLSX/SQLite/worker/service 链路、current/all 与四金额/余额 golden、artifact tamper/all-or-none/crash-cleanup 等专项证据及 E09-P0/A/B/platform 回归通过。

| 未知 | 处理 | 当前证据 | 当前决定 |
| --- | --- | --- | --- |
| current/all 的 entries 选择与顺序 | PROBE | `statement-session.js#getStatementSessionEntries`；E09-P0 golden | current 使用 `currentBatchId.entryIds` 顺序，all 使用 `fileEntries` 插入顺序；不另建排序规则 |
| 四金额、余额、多币种、warning 与 writer 的单一真相 | PROBE | `statement-generation.js#createStatementGenerationHelpers`；`statement-legacy-golden-e09-p0.test.js` | Service 复用同一 helper seam，不复制金额/余额算法，不并行 detail/balance |
| worker 如何只写 task staging | PROBE | generation helper 的 `buildStatementOutputFilePath` 是注入依赖 | worker 绑定 staging output planner；请求不允许 final target |
| Main all-or-none Publisher 能力 | PROBE → CLOSED | `toolbox-output-publication.js` 的 prepare/publish/dispose 与 journal fault tests | 复用既有 journal Publisher；全部 technical/business readback 先完成，Publisher 只调用一次 |
| generation token、revision、input evidence 的绑定形态 | PROBE → CLOSED | E09-B token store、Service 私有 session、import template/source evidence | scope prompt token 私有绑定 current/all 两个 evidence hash；continuation 按实际 action scope 复核，再 single-use consume |
| manual balance prompt | BLOCK for E09-D, observable in E09-C | Spec 明确 E09-D 后续；legacy helper 以 warning 返回 prompt | E09-C 仅返回 bounded warning summary 并拒绝发布不完整 artifact set，不写 seed、不结算 prompt |

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| entries 选择委托现有 `getStatementSessionEntries` | legacy golden 已冻结 current/all batch identity 与 remove 回退语义 | 在 generation 模块重新筛选或排序 | scope/order 与 legacy 同源 |
| generation 继续调用 `createStatementGenerationHelpers`，并把 Main 原余额 helper 抽到 `statement-generation-business.js` | helper 已承载 mapped-row merge、四金额、余额、warning、writer；legacy 与 Worker 现共用同一份 balance/date/seed-scan 函数 | 在 Worker 复制业务算法 | Main/Worker 单一真相；既有 golden 改为直接加载共享 production module |
| Worker 只接受 task staging + artifact plans | TechDoc 禁止 Worker 接 final target，且 Main 只持 FilePlan/manifest | Worker 直接写正式 exports 或 Main 传大行数据 | 维持单 Publisher 与 Main heap 边界 |
| detail/balance 严格串行，任一缺失即删除全组 staging | legacy helper 的 warning/output 顺序是业务合同；manifest 是 all-or-none | 并行 writer 或返回 partial manifest | 保持 warning/order，partial writer/manual-seed-required 时 Publisher=0 |
| generation Worker 不持久化 balance seed | Worker 只能写 task-private FilePlan staging，manifest 不承载 seed mutation；manual seed 属 E09-D | Worker 直接改共享 balance-seeds | dormant 路径只生成 workbook；seed settlement 继续由后续独立门禁负责 |
| Main 对 journal manual-recovery 保留 generation | 既有 Publisher 的 `preserveTemporaryFiles=true` 是人工恢复证据 | finally 无条件删除 generation | 普通成功/失败清 staging，uncertain/manual-recovery 保留证据 |
| Main descriptor 以 cell-contract digest 绑定 writer 持久化语义 | Round 2 证明业务值 digest 会把非特殊字段的 string/number 归一为同值，且原 style gate 未覆盖 data font 与 header bold/color | 把 raw rows/完整 style XML 放入 descriptor，或校验 XF id/apply flags 等默认噪声 | descriptor 只增加定长 `cellCount/cellsSha256`；逐格绑定 writer 实际 t/z 和有意义 style，仍不携带 raw rows |
| style evidence 按 workbook relationship 解析实际 worksheet part | Round 3 证明硬编码 `sheet1.xml` 与正则扫描任意 `<c>` 可被 relationship decoy、注释和属性语法旁路 | 继续硬编码 part、扩大 raw XF 摘要或引入第二套 ZIP reader | 复用现有 `sax` 结构化解析 `workbook.xml`/rels/`worksheet/sheetData/row/c`；重复坐标及显式 style 不可解析时 fail closed，只有缺失 `s` 使用 style 0 |
| workbook 公式使用单一 sheet-wide gate | 原实现只在 data record loop 检查 `cell.f`，header 正确缓存值可旁路 | 在每类 header/data validator 分散补检查 | bounded range 确认后统一拒绝所有正式输出 cell 的 formula，再执行业务 readback |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 现有 journal publisher 可在不接 live IPC 的情况下复用 | 其核心 API 已模块化并有 fault tests | 已通过双 artifact 第二项失败回滚、成功发布及 generation cleanup 验证 | production 保持 false，可独立回滚新增 dormant seam |

## Deviations

### Reviewer Round 1 contract clarification

Round 1 证明原实现的“Main business validator”只有单 sheet/行数回读，且
`FilePlan + Worker manifest` 不能独立绑定 artifact kind 与业务内容。为闭合既有
“全部 technical/business validation 后才 Publisher”的合同，本 change 增加
`MainExpectedArtifactDescriptorV1`：由 Main 持有并在调用 publication seam 时传入，
绑定 artifactKey、kind、冻结顺序、task-owned staging resource、sheet/header、行守恒、
有序记录及日期/账户/币种/金额摘要、writer/style/watermark/template lineage。该 descriptor
不进入 Worker manifest，也不携带 raw rows/prepared batch；manifest 冻结字段保持不变。
`spec.md`/`techdoc.md` 已同步此验证与清理边界，属于原合同的安全澄清，不改变 legacy 业务输出。

此外，Round 1 的四个 P1 已由项目负责 Agent 接受为真实可达：

| Finding | 分类 | 决定 |
| --- | --- | --- |
| staging 中间祖先 symlink 可越界发布/清理 | PROBE → CLOSED | technical、默认 Publisher 前、restart cleanup 共用逐级 `lstat` + `realpath` + inode/alias 的 task-owned validator |
| invalid/outside manifest 可驱动 finally 删除外部文件 | PROBE → CLOSED | 清理只从 Main-owned descriptor 解析且通过归属验证的资源；不再把未验证 manifest 交给通用 disposer |
| detail/balance resource alias 可先后覆盖 | PROBE → CLOSED | request 拒绝 dot/parent，Worker 写入前对完整集合做平台 alias 检查，Main 再做集合 alias 与 kind/order 绑定 |
| 自洽 manifest 可用错误 workbook 冒充业务 artifact | PROBE → CLOSED | Main 按 descriptor 做完整 bounded readback；任一内容/type/format/style/lineage 不符时 Publisher=0 |

最终 blindspot pass 另关闭两个同边界可达缺口：journal Publisher 只白名单接受
`checkpoint/now/randomUUID` test runtime，不允许 `publisherOptions` 覆盖 Main-owned task/artifact/target/
validation 参数；余额 0 输出模板占位行必须为空，禁止在自洽 `rowCounts.output=0` 下夹带业务记录。

### Reviewer Round 2 contract closure

Round 2 的两个 finding 均由项目负责 Agent 裁决为真实可达：header 公式可用正确缓存值绕过原
data-only formula gate；非特殊文本 string→numeric、data font、以及保持 Courier New 10 的
header bold/color 变化均可保持 manifest/hash/业务值摘要自洽。修复沿既有 frozen spec 的
“cell type/format/style 摘要证据”收口，不扩充 Worker manifest，也不改变业务值或 writer 输出。

`MainExpectedArtifactDescriptorV1` 新增定长 `cellContractEvidence`，按正式 grid 顺序摘要每个
header/data cell 的预期 `t/z` 与 legacy writer 真实持久化的 font 语义；header 固定 Courier New 10
且无额外 bold/color，data 使用 writer 的 Calibri 11 默认语义，balance header 的持久 number
format 来自受信模板。既有 header/template lineage validator 继续负责 writer 已冻结的 fill/border，
本轮不把 data alignment/protection、raw XF id、apply flags 或未持久化对象字段升格成新合同。
金额 cell 复用 writer 的 `buildNumericCellValue`，日期格式复用 normalizer，避免复制金额/日期格式
分支。现有 spec/techdoc 已明确要求该摘要 readback，因此本轮无需反向改写合同文本，仅在 notes
记录实现闭环。

### Reviewer Round 3 parser/font closure

Round 3 的两个 P2 均由项目负责 Agent 裁决为真实可达。原 style evidence 固定读取
`xl/worksheets/sheet1.xml`，并以正则扫描整个 XML 的 `<c>` 开标签：workbook relationship 可指向
另一个实际 worksheet part，注释内伪造 cell 可覆盖真实坐标，单引号与属性空白不能按 XML 语义解析，
重复坐标则静默 last-wins。修复通过 workbook sheet 的 relationship id 解析内部 worksheet target，
再用现有 `sax` 依赖只遍历根 `worksheet/sheetData/row/c`。cell coordinate 重复/非法、显式 `s`
不是非负安全整数或不能解析到 `CellXf` 时统一 fail closed；只有完全缺失 `s` 才按 OOXML style 0。

font 摘要只在 normalized/expected 两侧加入 legacy writer 已持久化为 false 的
`outline/shadow/condense/extend` 四个布尔字段。未增加 raw XF id、apply flags、alignment、protection
或其它 style 字段；公式/type/format、token/revision/evidence/single-use、staging/Publisher、manual seed
及 production=false/legacy/0 均保持不变。Round 3 没有改变用户可见行为、数据契约或验收口径，
因此无 spec/techdoc 偏差。

除上述合同澄清外无业务偏差；production policy、manual seed 与 live IPC 范围均不变。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `git merge-base HEAD 654393e9...` / reviewer rework parents | merge-base `654393e9a24c772f51db9114888a2114382ce39d`；Round 1 parent `78d9a19777e9680907413194195a00741c6037f2`；Round 2 parent `3edd474c15d40c8a1187b60760f9054cb92593df` | 精确 base/堆叠边界 |
| E09-C 专项 `node --test ...statement-generation-e09-c.test.js ...error-codec.test.js` | 20/20 PASS | 真实 Supervisor/ServiceHost/Worker、临时 XLSX/SQLite、current/all、stale/replay/revision/evidence、Round 1/2/3 findings、tamper、all-or-none、四金额、混币余额、0 输出、partial writer、manual prompt、bounded manifest |
| Round 2/3 自洽 workbook mutations | formula、type/format、font 及其四个扩展布尔、single-quote style、comment spoof、relationship decoy、duplicate coordinate、非法显式 style 全部 Publisher=0 | 实际 worksheet relationship/结构化 cell style、全 grid t/z 与 writer-owned font 摘要 readback；manifest size/hash/rowCounts 均按篡改后文件重算 |
| E09-P0/A/B + Supervisor/ServiceHost/Governor 聚焦回归 | 228/228 PASS | 既有 token/session/取消/crash/资源生命周期、legacy golden 与 dormant policy 基线 |
| `node scripts/integration/statement-generation-pipeline.js` | 45/45 PASS | legacy generation pipeline 业务等价 |
| `npm run test:integration` | 51/51 scripts、2455/2455 PASS | 全仓集成、Publisher/cleanup 与资金相关输出回归；runner 自动清单的本地耗时刷新已回退，不纳入 change |
| 全量 `npm run test:unit` | 6246 PASS，2 FAIL，3 SKIP（6251 total） | 两个失败均为 `windows-build-contract.test.js` 直接读取隔离 worktree 缺失的 `node_modules/app-builder-lib/templates/nsis/multiUser.nsh`；共享安装为 26.8.1、lockfile 为 26.15.7，属于既有依赖环境漂移，未改依赖掩盖 |
| changed JS ESLint + `node --check` + parent/overall `git diff --check` | PASS | 静态质量与 diff 完整性 |
| `statement-legacy-golden-e09-p0.test.js` 与真实 descriptor readback | current/all、四金额、混合币种/余额、manual prompt、sheet/header/type/style/watermark/template lineage 已冻结且回归通过 | 业务等价与资金输出防冒充基线 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 真实脱敏资金样本的逐行金额方向、币种、余额与 Excel/WPS 展示 | BLOCK production/release gate | 资金负责人按 current/all、四金额、混合币种、0 输出和余额提示逐项人工复核 | 自动化业务等价不替代人工资损验收；不阻塞 dormant E09-C，阻止 production 启用 |
| Windows packaged durable publication | BLOCK release gate | R3.2.3 人工/packaged 门禁 | 不阻塞 dormant E09-C 合并，production 必须保持 false |
| balance seed durable settlement（含自动派生 seed 的最终 owner） | BLOCK production gate | E09-D/后续合同按 Main-owned settlement 闭环 | E09-C 不允许 Worker 修改共享 seed；不阻塞 dormant 合并，阻止 production 启用 |
