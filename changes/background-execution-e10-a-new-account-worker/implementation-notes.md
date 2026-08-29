# E10-A Implementation Notes

## Baseline

- Goal/spec：frozen v3.2.3 spec/techdoc §9、§10、§11 的 E10-A NewAccount generation core/Worker。
- Initial plan：见同目录 `preflight.md`。
- Done when：唯一 core、bounded contract、allowlisted template、one-shot Worker、业务回读与 Main technical validation完成；production/legacy/workerCount 保持 `false/legacy/0`。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| live legacy handler 与 Worker 共用业务 pure core，E10-A 不切 live | E10-B Publisher 尚未实现且 frozen release strategy 要独立 flag | E10-A 直接替换 live handler | 用户行为零切换，允许完整 golden 后再启用 |
| 模板 identity 使用固定 allowlist path + stat snapshot + SHA-256，Worker 前后双检 | 只校验 caller path 或 metadata 存在 TOCTOU/同 metadata 内容替换盲区 | 信任 Worker input path；只用 `existsSync` | 模板变化一律 fail closed |
| 复用 Statement staging ownership validator | 已覆盖 root/ancestor symlink、realpath、hardlink、alias | 新写一套弱化路径判断 | technical validation 与 cleanup 权限一致 |
| Worker result 不回传 generationPath，Main 以自己冻结的 input 绑定 staging | Worker 自报路径不能授予校验/删除权限，且结果不应泄露本地路径 | manifest 回传 generationPath 并驱动 cleanup | Main 只按已授权 staging path 校验 size/hash；Worker 无 final target |
| Worker contract 上限为 256 KiB、64 账户、每账户 64 币种、250,000 预计记录 | 64×64×近 10 年会放大到千万级行；bounded DTO 不能只限制 JSON 字节 | 沿用 legacy 无界 Worker input | dormant Worker fail closed；live legacy 不新增记录上限 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 日期继续采用 legacy 本地日历语义 | 冻结要求 golden 等价，legacy 使用 local `Date` | 改 UTC 会改变非上海时区/DST 边界 | 昨日/3650/3651 边界 golden；若产品另定时区则先改 spec |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 无 | 无 | 未发生行为偏差；blindspot 发现的 final/staging alias 与 legacy 必填失败状态边界均在结案前按既有合同修正 | 无 | 不适用 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 父链 | `7beb80e8151c77dbd659d4192178b07663674009` | 精确 restack 基线 |
| frozen spec/techdoc/sequence 取证 | E10-A/E10-B/R3.2.3 边界确认 | 防止范围扩张 |
| `node --test tests/unit/main-process/new-account-generation-e10-a.test.js` | 7/7 PASS | 日期/10年边界、必填、币种顺序、文件名、bounded DTO、allowlist/TOCTOU、staging alias/collision/symlink、真实 Worker golden、tamper、cancel/crash/late done、cleanup |
| focused platform/legacy set | 41/41 PASS | E10-A + Statement deferred legacy + shared runtime/toolbox lifecycle |
| `node scripts/integration/new-account-balance-statement.js` | 36/36 PASS | 既有 NewAccount/余额 writer readback golden |
| `npm run test:integration` | 51 scripts、2455/2455 PASS，291844 ms | 全平台 recovery/integration 与 NewAccount 36/36；自动 timing 文档改动已恢复，未引入范围外 churn |
| `npm run smoke` | PASS；含全部列示模块 smoke | 应用级回归 |
| `npm run test:unit` | 6302/6306 PASS；1 个 failure、3 skipped | 唯一失败为未改动 Windows NSIS dependency template `System::Store`；在精确父 worktree 同测试同样失败，确认为 baseline |
| `npm run lint -- --no-cache`、`node --check`、`git diff --check` | PASS | 静态语法/风格/补丁完整性 |
| 10 轮真实 Worker 性能探针 | 10×1815 rows，2481.58 ms；Main event loop 995 ticks；RSS max delta 193,806,336 bytes；transport leak=0、shutdown error=0 | 非阻塞、RSS 与连续 one-shot lifecycle |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged Worker + assets allowlist 真实路径 | PROBE | R3.2.3 在 setup/portable 人工与 canary 验证 | production 必须继续 false |
| NewAccount 日期/账户/币种/输出记录人工复核 | BLOCK（上线） | 财务/业务 owner 按 frozen checklist 复核 | 不阻断 E10-A dormant merge，阻断 production enable |
| app 进程级 crash 后持久 task-staging 扫描与 Publisher journal | PROBE | E10-B 绑定 task staging/Publisher，R3.2.3 做 restart recovery | E10-A 无发布路径且 production=false；阻断 production enable |
