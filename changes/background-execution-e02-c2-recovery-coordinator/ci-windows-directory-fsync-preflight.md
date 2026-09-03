# PR #170 Windows Directory Fsync CI Preflight

## Task Brief

- Goal: 修复 PR #170 在 GitHub-hosted Windows 上的 3 个 recovery-contract 单测失败，同时保持 directory-fsync fail-closed 合同。
- Context: run `32710239931` 的 unit 为 `5914/5919 PASS`、3 fail；失败均来自 `durable-file.js` 的真实 Windows 目录句柄 barrier。
- Constraints: 不把 unsupported 宣称为 committed；不扩大 production enablement；不改 RecoverySource、资金 identity、Hold/重试或公共 IPC；不运行 `check-vars`/`scan:vars`。
- Done when: Windows 明确的目录句柄不支持错误返回 `durability-unavailable`；supported/fatal 分支均有确定性测试；macOS 定向/全量验证通过；推送后 Windows CI 通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| CI 的 3 个失败都在 `recovery-contract-c2.test.js` | run `32710239931`：#1175/#1184/#1190 | 先修同一 durability 根因，不碰无关 build |
| 两项直接抛 `DURABILITY_DIRECTORY_FSYNC_FAILED`，一项因 Provider 未完成而保持 `committed` | CI stack 指向 `durable-file.js:28`，另有 expected `closed` / actual `committed` | 必须同时覆盖 primitive、Provider prepare/recover 与 target post-image |
| macOS 同文件 `35/35 PASS` | 本地 `node --test .../recovery-contract-c2.test.js` | 属于平台能力分支，不是通用状态机回归 |
| 冻结合同要求 unsupported 保持 source open/Hold，禁止宣称 durable success | `platform-contract-v1.md` 与 E00 TechDoc | 不能用吞错或强制 `committed` 让 CI 变绿 |
| 仓库既有目录 fsync 适配把 Windows `EACCES/EISDIR/EPERM` 视为不支持，普通文件 fsync 仍 fatal | `toolbox-output-publication.js`、`vcc-financial-op-storage-rebuild.js` | 复用目录专用边界，不把普通文件错误纳入容错 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Windows runner 返回 `EACCES/EISDIR/EPERM` 中哪一个 | 平台能力 | 中 | 容易 | CI 没展开 `details.errorCode`；仓库已有三者 allowlist | PROBE | 对三者做 win32 注入合同测试，CI 真实路径再验证 | 三者仅在 win32 归为 unsupported，并保留原始 errorCode |
| 成功路径测试是否应依赖宿主真实目录 fsync | 测试边界 | 高 | 容易 | 当前 macOS success、Windows fail | PROBE | 注入 supported directory barrier 后执行相同真实 file fsync/rename | success 状态机使用显式 test seam；另测真实 capability 分支 |
| integration canary 遇到 unsupported 应 PASS 还是 FAIL | 发布合同 | 高 | 容易 | production=false，合同要求记录 capability 并 fail closed | PROBE | 对照冻结 TechDoc 与现有 `durability-unavailable` DTO | canary 接受 supported/unsupported，但仅 supported 可宣称 committed |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 平台感知地分类 Windows 目录句柄 errno | unsupported 不冒充 committed；POSIX 权限错误仍 fatal | win32 三码 unsupported，非 win32 EPERM/EACCES fatal，EIO 始终 fatal | 推翻 primitive 方案 | 只保留实际 CI errno |
| 2 | 给 durable writer/canary Provider 增加内部 barrier 注入 seam | supported 状态机测试不依赖宿主能力 | 原 file fsync/rename 仍真实执行，只有 directory barrier 受控 | 测试仍平台不稳定 | 收缩为 canary 私有 writer 注入 |
| 3 | 调整 unit/integration canary 验收 | supported 与 unsupported 两条语义都可解释 | 定向 unit/integration PASS 且 production=false | Windows 仍失败 | CI 输出 capability 后继续收窄 |
| 4 | 全量回归与盲区扫描 | Recovery/Hold/资金边界不漂移 | `release-check`、diff review、Windows CI | 阻止推送/合并 | 回滚本次最小 commit |
