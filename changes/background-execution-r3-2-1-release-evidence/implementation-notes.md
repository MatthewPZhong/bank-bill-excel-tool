# R3.2.1 Release Evidence — Implementation Notes

## Baseline

- Goal/spec：冻结 v3.2.1 Spec §8-§11、TechDoc §13-§15 与 implementation sequence 的最终 `R3.2.1` action 独立 enable/rollback。
- Exact base：`4598b9c67787ef1736831a186a199bd6fe9ae626`（E05-C reviewed head）。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：7-action snapshot 与 production authority、benchmark/gate evidence 一致；5 个 native action 保持 disabled/legacy/0；2 个 inherited existing-dispatch action 原状态不变；人工与 Windows 门禁不被自动测试升级。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 使用 tracked JSON snapshot + 只读 validator + unit tamper cases，不改业务 runtime。 | release evidence 需要防漂移，但无需新生产抽象；当前业务 capability 已在 E04/E05 完成。 | 在 `src/` 新增 release registry；把 decision 写回 production policy。 | 产品金额、币种、receipt、sequence、Publisher 与 recovery 行为零变化。 |
| inherited two 以 canonical full-policy fixture 为 authority；native five 以 runtime policy exports 为 authority。 | runtime.js 只聚合本版本 native action，不能代表 inherited existing-dispatch production snapshot。 | 将 inherited action 因 runtime 缺席误记为 disabled；复制一份不可校验的 policy。 | validator 分别锁定 `true/thread-single/1` 与 `false/legacy/0`。 |
| E04-C/E05-C 失败只表达为 release decision、reason和 evidence ref。 | schema 没有 `benchmark-fail`，伪造 `benchmark-pass/release-pass` 会抬高证据。 | 修改 policy schema；把 small fixture 收益当 representative pass。 | policy canonical enum 保持合法，production拒绝原因可审计。 |
| 不 bump `package.json.version`，不更新 release 用户文档三件套。 | R3.2.0 release-evidence precedent 未 bump；本 PR 无用户可见功能或版本发布。 | 猜测 bump 到 3.2.1；只改三件套中的一份。 | 保持当前 `3.1.14`；若后续负责人决定版本迭代，三件套必须一起更新。 |
| 每个 action 单列 `realProcessTermination` gate。 | blindspot pass 发现首版仅在部分 reason code 提及真实终止，没有形成逐 action machine-check 字段。 | 用 Windows packaged 或 deterministic fault injection 代替真实进程终止证据。 | 7 action 均固定 `NOT_RUN`，不得由自动测试升级。 |
| 唯一一次完整 `release-check` 的失败是最终证据，不得重跑或改写为PASS。 | Lead在reviewed HEAD `c9e89db7`运行一次，lint/smoke通过，unit `6166/6171`且2 fail，`&&`使integration未执行。 | 修复后再次运行完整链；只记录修复后定向PASS并隐去初始失败。 | snapshot固定run authority、HEAD、phase结果、两个root cause及`rerunAllowed=false`。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| snapshot 是本地 release review artifact，不是运行时动态配置。 | 所有 enablement authority 已存在于 policy/fixture；需求禁止本 PR 启用 production。 | 若被误用作运行时开关，会形成双 authority。 | validator 与文档明确只读；不从 `src/main.js` 或 runtime require snapshot。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 无。 | 按 preflight 实现 tracked snapshot、只读 validator 与 tamper tests。 | — | 无用户行为、数据合同或验收口径变化。 | 不适用 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 冻结合同、R3.2.0、E04/E05 notes 与 current policy/runtime preflight | PASS | authority 分层、版本策略、benchmark与人工门禁边界。 |
| `node scripts/validate-v3-2-1-release-evidence.js` | PASS：7 action、native production enabled 0、inherited state changes 0 | current policy/live mode/worker、action独立 decision/rollback/evidence/gates 与 source SHA-256。 |
| release-evidence专属 unit | `10/10 PASS` | 唯一release-check失败/未运行integration不可篡改；native误启、inherited误关、E04-C授权、E05-C small代偿、人工gate误升级、跨action evidence/rollback借用与source hash drift均拒绝。 |
| canonical policy registry unit | `20/20 PASS` | canonical schema/enum、production/effective mode、static reference与freeze authority。 |
| E05-P0 receipt + mixed lifecycle unit | `11/11 PASS` | per-file mixed结果继续、strict/repair shape、receipt三outcome/唯一键与含receipt删除语义。 |
| E05-C专属 unit | `15/15 PASS` | requested 4/native actual 1、repair 1、permit、disk/symlink、cancel/spawn/invalid topology、Pool/Writer/cleanup。 |
| affected static checks | PASS | validator及3个改动test ESLint；3个 `node --check`；JSON parse；`git diff --check`。 |
| 既有重量级组合环境 probe | `57/64 PASS`；7 fail 均为当前 host resource gate | 当时 `os.freemem()` 约 0.8–1.0 GiB，低于 E00 2 GiB system reserve：mature topology保守降1；E04 real Worker固定5秒 admission timeout。串行复跑仍同因失败；未改相关 `src/`，不把环境拒绝重标为产品 PASS。更广 E05-A/B probe 出现同类 admission timeout 后停止，不作通过声明。 |
| Lead唯一完整 `npm run release-check`（reviewed HEAD `c9e89db7`） | `EXIT 1`：lint PASS；smoke PASS；unit `6166/6171 PASS`、2 fail、3 skip；integration因`&&`未执行 | 失败事实、phase边界和禁止重跑均进入machine snapshot；绝不宣称release-check PASS。 |
| renderer PreFund失败root cause与修复 | 过时静态regex；生产顺序正确。更新测试锁定handler内operation lock → `assertDeleteDateRange(service,payload)` → `deleteTempByDateRange(normalizedRange)`；定向 `8/8 PASS` | 不改`src/main.js`、Hold gate、资金删除口径或normalized range。 |
| Windows contract失败root cause与修复 | 首次run的worktree依赖解析到`electron-builder/app-builder-lib 26.8.1`；按lock重建后installed/locked `electron-builder=26.15.7`、`app-builder-lib=26.15.7`，并用`npm rebuild electron`补全Electron postinstall，未改package/lock；Windows contract `EXIT 0`、5 pass/0 fail/2 skip | 环境漂移已解决，中间失败属于隔离依赖安装状态而非产品缺陷；这是post-failure定向验证，不改变唯一release-check `FAIL`。 |
| post-failure独立unit component（reviewed HEAD `634671b`） | `npm run test:unit` `EXIT 0`：6172 tests、6169 pass、0 fail、3 skip、377 unit files、25275ms；log `logs/unit-tests/unit-20260826-122322.log` | correct-lock依赖与Electron postinstall完成后的全unit组件验证；不是release-check重跑，也不把唯一release-check改写为PASS。 |
| post-failure独立integration component | `npm run test:integration` `EXIT 0`：51/51 scripts、2455/2455 assertions、278953ms | 唯一release-check因unit失败未进入integration；本次独立component PASS不构成release-check重跑或PASS。runner合法同步`rules/integration-test-policy.md`时间与耗时清单，随最终commit保留。 |

## Blindspot Pass

### [Important] policy authority 分层可能误关 inherited action

- 事实：native runtime只聚合5个v3.2.1 action；canonical full-policy fixture另含 inherited `toolbox:split-large` / `toolbox:publish` 的 `true/thread-single/1`。
- 影响：若把 runtime 缺席解释成 disabled，会静默改写 inherited production state。
- 处置：已覆盖。snapshot显式记录 `policyAuthority`，validator按两种authority分别反查并有误关tamper test。

### [Important] benchmark局部收益与schema枚举可能造成证据抬高

- 事实：E04-C对one Writer改善21.096%但对live legacy仅8.581%，资源/Windows combined gate失败；E05-C representative仅0.57%，small为33.04%；policy schema无`benchmark-fail`。
- 影响：跨基线或跨fixture代偿会误启production，伪造pass enum会污染后续release判断。
- 处置：已覆盖。decision/reasons与policy字段分离；validator锁定原始指标、结论、source hash及small不可代偿。

### [Important] 未执行平台/人工门禁必须保持可见

- 事实：Windows packaged、Excel/WPS、真实进程终止与真实业务/恢复人工复核没有当前证据。
- 影响：自动测试若把任一项升级为PASS，会越过durability、格式或恢复边界。
- 处置：BLOCK production enable。每action gate独立记录，tamper test禁止升级。

未发现会改变实现方案的其他存活盲区。已被证据反证的候选问题：snapshot不会被runtime读取；没有第二Writer源码/入口；没有版本bump规范要求；本diff没有Publisher、receipt或Recovery Hold旁路。

## Reconciliation Blindspot Pass

### [Critical] PreFund amount/currency/sequence/receipt与恢复边界

- 场景：release rollback若删除receipt、绕过Hold或自动重跑unknown，可能重复/漏记或覆盖错误batch/dataset。
- 事实与证据：本diff不改任何业务`src/`、migration或Side DB；snapshot rollback固定保留committed receipt与Recovery Hold、禁止down migration和unknown auto-rerun；E05-P0 `11/11` 与E05-C `15/15`通过。
- 推断/未知：自动fixture不能替代真实脱敏insert/noop/replacement/mixed-result与历史v0 receipt人工核对。
- 资损或审计影响：错误恢复可能重复mutation或破坏batch/dataset lineage。
- 处置：⚠️ 资金红线，请人工复核；`funds/recovery=PENDING_HUMAN_REVIEW`，阻断native production enable。

### [Important] Toolbox row-set/格式与all-or-none publication

- 场景：generation evidence不能替代真实Excel/WPS业务文件与journal recovery人工检查。
- 事实与证据：本diff不改generation/validation/Publisher；E04-C仍拒绝第二Writer，rollback固定沿用既有FIFO Publisher/durable journal。
- 推断/未知：当前host低内存使real Worker定向probe被admission拒绝；Windows packaged和人工workbook证据仍未执行。
- 资损或审计影响：若误判通过，可能发布格式错误、缺输出或不完整正式目标。
- 处置：BLOCK production enable；`windows/Excel-WPS/realProcessTermination/businessFile/recovery`保持open。

必须使用真实数据或人工确认的口径：Toolbox代表性业务workbook行集/格式/warning/all-or-none；PreFund真实脱敏source identity、sequence replacement、batch.id、dataset version、金额币种、repair token、candidate order及crash recovery。自动测试没有宣称这些门禁通过。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Packaged Windows、Excel/WPS、真实进程终止证据 | BLOCK production enable / `NOT_RUN` | Release owner 在真实 packaged Windows 与 Office 环境执行 | 不阻断 evidence artifact；阻断相关 native production enable。 |
| 真实业务文件与资金/恢复人工复核 | BLOCK production enable / `PENDING_HUMAN_REVIEW` | Toolbox/PreFund 业务与恢复 owner | ⚠️ 资金与恢复红线，请人工复核。 |
| 当前host低于E00 system reserve，重量级real Worker定向测试被admission拒绝 | PROBE / 环境限制 | 项目负责人在满足E00内存预算的review环境复跑定向Toolbox/E05-B或最终唯一release-check | release专属validator及纯合同测试已通过；不把未跑完的real Worker矩阵声明PASS。 |
| 唯一完整 `release-check` 已失败 | CLOSED AS EVIDENCE / `EXIT 1` | 禁止任何agent再次运行；修复后renderer/Windows定向与独立unit/integration components已通过 | release-check自身的integration phase保持`NOT_RUN`；standalone unit/integration另记PASS，最终状态不得写为release-check PASS。 |
