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

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 现有 journal publisher 可在不接 live IPC 的情况下复用 | 其核心 API 已模块化并有 fault tests | 已通过双 artifact 第二项失败回滚、成功发布及 generation cleanup 验证 | production 保持 false，可独立回滚新增 dormant seam |

## Deviations

当前无偏差。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `git rev-parse HEAD` | `654393e9a24c772f51db9114888a2114382ce39d` | 精确 parent/base |
| E09-C 专项 `node --test ...statement-generation-e09-c.test.js ...error-codec.test.js` | 15/15 PASS | 真实 Supervisor/ServiceHost/Worker、临时 XLSX/SQLite、current/all、跨 action scope、stale/replay/evidence、tamper、all-or-none、四金额、混币余额、partial writer、manual prompt、路径/cleanup、bounded manifest |
| E09-P0/A/B + Supervisor/ServiceHost/Governor 回归 | 205/205 PASS | 既有 token/session/取消/crash/资源生命周期及 platform 基线 |
| `node scripts/integration/statement-generation-pipeline.js` | 45/45 PASS | legacy generation pipeline 业务等价 |
| 全量 `npm run test:unit` | 6242/6246 PASS，1 FAIL，3 SKIP | 唯一失败为共享依赖 `app-builder-lib` 的 `multiUser.nsh` 仍含 `System::Store`，与本 change 无关；隔离 worktree 无本地依赖时另有两个 ENOENT，临时依赖 symlink 后已归因 |
| changed JS ESLint + `node --check` + parent/overall `git diff --check` | PASS | 静态质量与 diff 完整性 |
| `statement-legacy-golden-e09-p0.test.js` 与 fixture | current/all、四金额、混合币种/余额、manual prompt 已冻结且回归通过 | 业务等价基线 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged durable publication | BLOCK release gate | R3.2.3 人工/packaged 门禁 | 不阻塞 dormant E09-C 合并，production 必须保持 false |
| balance seed durable settlement（含自动派生 seed 的最终 owner） | BLOCK production gate | E09-D/后续合同按 Main-owned settlement 闭环 | E09-C 不允许 Worker 修改共享 seed；不阻塞 dormant 合并，阻止 production 启用 |
