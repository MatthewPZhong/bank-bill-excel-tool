# v3.1.12 Windows 启动验收运行手册

本手册只描述 PR5 的本地受控运行。正式 STP-08 必须在同一台受控 Windows 主机上，用本地挂载、已脱敏且经数据负责人确认的约 2.9GB golden，依次运行三份独立报告。不得把数据库、WAL/SHM、`userData`、Documents、raw runner report 或 raw log 上传到 GitHub。

小型 synthetic fixture 只能做 harness rehearsal；其结果无条件为 `rehearsal/not-evaluated`，不能作为 70% 或发布证据。

## 运行前人工准备

1. 在受控 Windows 本地准备四个来源文件：v3.1.11 setup、v3.1.11 portable、v3.1.12 setup、v3.1.12 portable。setup 不是被测 exe；orchestrator 会将两代 setup 实际静默安装到 owner-marked 根，再解析 installed exe。
2. 准备三个互相隔离的 golden bundle：current normal、3.1.11 migration/VACUUM、current crash WAL。不得直接使用源 golden 运行或清理。
3. 数据负责人为每个 bundle 建立结构化 receipt。formal 在创建 `workRoot`、安装或调用 runner 前就要求三份 receipt 全部存在、为普通非链接文件，并逐项校验 exact schema/scenario/signer/确认项、canonical `signedAt` 以及 source main/WAL/SHM 的 SHA-256 与 size；三份 source bundle 完成绑定后，每个 main 还必须至少为 `2_700_000_000` bytes。缺失、不匹配或小于该正式下限时安装数与 runner 数必须均为 0，且不创建 `workRoot`。config、receipt 和最终公开报告必须在 `workRoot` 外；`workRoot` 必须是空目录或不存在。output 的父目录须已存在且不是 symlink/reparse；output 自身必须不存在。
4. 确认 workRoot 所在卷为 local fixed disk，空间满足工具计算的预算。normal 同时占五份 golden；non-normal 只保留当前样本，成功固化 evidence 后立即精确清理。
5. 记录并人工复核 Windows/CPU/RAM/本地磁盘/path class/power plan/Defender realtime、版本与 exclusion 命中、cache policy。power plan GUID 输入允许大小写，但公开前必须规范为 lowercase 且严格匹配 `8-4-4-4-12` hexadecimal UUID shape；36 位纯数字、缺 hyphen 或含非 hex 字符均拒绝并保持 `not-evaluated`，privacy allowlist 也只对已通过该 shape 的 GUID 豁免长数字检查。公开报告只保留 Windows/arch、CPU model SHA-256、文件系统/介质/bus 安全枚举与必要数值，不发布 WMI/PE 自由原文；Defender realtime/workRoot exclusion/golden exclusion 三项缺任一布尔时为 unavailable / `not-evaluated`，绝不把缺失伪造成 `false`。

## 配置合同

正式 config 示例（示例路径必须替换为受控主机本地路径，配置本身不得提交）：

```json
{
  "schemaVersion": 1,
  "mode": "formal",
  "runs": 8,
  "timeoutMs": 300000,
  "workRoot": "D:\\startup-acceptance-owned",
  "output": "D:\\startup-evidence\\formal-draft.json",
  "inputs": {
    "3.1.11-setup": "D:\\mounted-inputs\\v3.1.11-setup.exe",
    "3.1.11-portable": "D:\\mounted-inputs\\v3.1.11-portable.exe",
    "3.1.12-setup": "D:\\mounted-inputs\\v3.1.12-setup.exe",
    "3.1.12-portable": "D:\\mounted-inputs\\v3.1.12-portable.exe"
  },
  "scenarios": {
    "normal-clean-shutdown": {
      "goldenDb": "D:\\mounted-golden\\normal\\tool-data.sqlite",
      "manualReceipt": "D:\\startup-receipts\\normal.json"
    },
    "migration-vacuum": {
      "goldenDb": "D:\\mounted-golden\\migration\\tool-data.sqlite",
      "manualReceipt": "D:\\startup-receipts\\migration.json"
    },
    "crash-recovery": {
      "goldenDb": "D:\\mounted-golden\\crash\\tool-data.sqlite",
      "goldenWal": "D:\\mounted-golden\\crash\\tool-data.sqlite-wal",
      "walSentinel": "startup_wal_probe=OWNER_PROVIDED_EXPECTED_VALUE",
      "manualReceipt": "D:\\startup-receipts\\crash.json"
    }
  }
}
```

四个 `inputs` key 与三个 `scenarios` key 都必须精确齐全。formal 固定为 8 轮；只有 rehearsal 可选择其它不小于 5 的轮数。initial formal config 只接受三个 golden receipt，禁止预放 process/final receipt；后二者只能在 machine draft 生成后分阶段绑定。所有 source/receipt/output 都必须在可清理 workRoot 外。orchestrator 在任何安装或 runner mutation 前固定 config、四制品、三个 main/WAL/SHM bundle、WAL/recovery sentinel、所有 MANUAL receipt，以及 output parent 的 lexical path、realpath 和稳定 volume/file identity，并拒绝已存在的 output、symlink/reparse/hardlink alias。写入紧前再次核对全部保护身份和 output parent；只向复验过的 canonical parent 下目标执行 create-new `wx`，parent 被 rename 或重定向时立即失败，不向攻击目录写文件。Windows 无法取得可靠稳定身份时 fail-closed。四制品 exact `fileVersion` 只接受纯数字 dotted form，拒绝 PE 自由文本后缀。

运行开始后冻结四制品身份，同一进程、同一 host 串行三场景。non-normal 若未提供 cleanup handler，会在创建 workRoot、冻结/copy golden 或 launch 前直接失败。底层 runner 在每次 launch 紧前重新核对 frozen artifact 与 golden identity；working main/WAL/SHM 及 recovery sentinel 会清除 readonly、恢复 owner writable，并用 `r+` 验证，source 与 runner-owned frozen bundle 保持只读。non-normal 的 `afterSampleCleanup` 必须返回 exact target 的结构化 receipt，只有 `verifiedAbsent=true` 才可继续；public target token 固定为 `H(schemaVersion, kind, comparisonId, scenario, label, round)`，不含 owner/path，raw projection 与 finalize 都逐样本重算且全 comparison 唯一。false/missing/throw 都会立即 abort、保留证据并保持 `not-evaluated`。删除存在性使用 `lstat`；即使 dangling symlink 的目标不存在，也拒绝删除或签 absent receipt，最终删除 workRoot 后也用 `lstat` 拒绝被替换的 lexical entry。normal 首轮 before 绑定 approved golden，之后每个 variant 分别强制 `previous.after === next.before`，不把后续轮次错误地重置为 golden。

运行：

```powershell
npm run startup:acceptance:windows -- --config D:\startup-local-config.json
```

## 人工 receipt

每个 golden receipt 必须由数据负责人填写和签署，不能由 CLI 自由字符串代替机器或人工证据：

```json
{
  "schemaVersion": 1,
  "kind": "windows-startup-golden-manual-receipt",
  "evidenceSource": "manual",
  "scenario": "normal-clean-shutdown",
  "goldenSha256": "64位小写十六进制 SHA-256",
  "goldenWalSha256": null,
  "goldenShmSha256": null,
  "goldenSizeBytes": 2900000000,
  "goldenWalSizeBytes": 0,
  "goldenShmSizeBytes": 0,
  "sourceClass": "controlled-windows-local-mounted-anonymized-copy",
  "anonymizationConfirmed": true,
  "representativenessConfirmed": true,
  "dataOwnerConfirmed": true,
  "signer": { "id": "组织内可追溯标识", "role": "data-owner" },
  "signedAt": "2026-08-20T00:00:00.000Z"
}
```

main/WAL/SHM 的 non-null SHA 必须都是 64 位小写十六进制；null sidecar 的 size 必须为 0，存在的 sidecar 则同时绑定其 SHA 与 size。

机器证据完整、normal installer 与 portable 两组 raw `externalFullReadyMs` median 均至少缩短 70% 时，首次输出仍是 `not-evaluated` machine draft。其 `candidateEvidenceSha256` 是 machine candidate `M`：绑定 draft canonical `generatedAt`、完整 canonical/sanitized machine environment、固定 privacy 语义、制品与三场景结构化 projection digest、三个 golden receipt digest，以及重新计算的 comparison。三份 golden receipt 的 canonical `signedAt` 不得晚于 `M.generatedAt`。Windows evidence reviewer 只能在 `M.generatedAt` 至实际 bind 调用 `now` 之间，用当前 `M` 签 process/window/failure seam receipt：

```json
{
  "schemaVersion": 1,
  "kind": "windows-startup-process-seams-manual-receipt",
  "evidenceSource": "manual",
  "candidateEvidenceSha256": "draft 中的 64 位 SHA-256",
  "installerAndPortableTreesObserved": true,
  "ownedMainWindowObserved": true,
  "closeMainWindowReceiptReviewed": true,
  "failureCleanupObserved": true,
  "noUnownedProcessTouchedConfirmed": true,
  "signer": { "id": "组织内可追溯标识", "role": "windows-evidence-reviewer" },
  "signedAt": "2026-08-20T00:00:00.000Z"
}
```

先把 process receipt 绑定到 machine draft。工具以实际 bind 调用的 canonical `boundAt` 生成 release candidate `R = H(kind, M, processReceiptDigest, boundAt)`，并把 `releaseBoundAt` 写入公开 candidate：

```json
{
  "schemaVersion": 1,
  "action": "bind-process",
  "draftReport": "D:\\startup-evidence\\formal-draft.json",
  "processSeamsReceipt": "D:\\startup-receipts\\process-seams.json",
  "output": "D:\\startup-evidence\\formal-release-candidate.json"
}
```

```powershell
npm run startup:acceptance:windows -- --config D:\startup-bind-process-config.json
```

绑定是单向的：输入 draft 的 `releaseCandidateSha256` 与 `releaseBoundAt` 必须为 null，已绑定文件不能再次绑定。发布负责人复核完整 release candidate 后，只能在 `R.releaseBoundAt` 至实际 finalize 调用 `now` 之间为 `R` 建立终签 receipt；不能预先签未来 candidate，也不能使用非 canonical ISO、倒序或重复绑定：

```json
{
  "schemaVersion": 1,
  "kind": "windows-startup-final-signoff-manual-receipt",
  "evidenceSource": "manual",
  "releaseCandidateSha256": "formal-release-candidate.json 中的 64 位 SHA-256",
  "reductionsReviewed": true,
  "formalReleaseApproved": true,
  "signer": { "id": "组织内可追溯标识", "role": "release-owner" },
  "signedAt": "2026-08-20T00:00:00.000Z"
}
```

终签 config：

```json
{
  "schemaVersion": 1,
  "action": "finalize",
  "draftReport": "D:\\startup-evidence\\formal-release-candidate.json",
  "processSeamsReceipt": "D:\\startup-receipts\\process-seams.json",
  "finalSignoffReceipt": "D:\\startup-receipts\\final.json",
  "output": "D:\\startup-evidence\\formal-final.json"
}
```

finalize 仍使用同一命令，并从当前 release candidate 的 canonical artifact/scenario/sample/environment evidence 重跑 schema、identity、privacy、sample、process、scenario 与未取整 median 门禁，重算 `M` 和含 `boundAt` 的 `R`；不会信任 draft 缓存的 environment digest、comparison、candidate SHA 或 release candidate SHA。全 comparison 的 96 个 process nonce SHA 必须唯一；64 个 non-normal cleanup token 必须唯一且与精确坐标相等。raw 与 projected 两层都要求 legacy `externalFullReadyMs >= rendererInitMs`，3.1.12 还要求 external 不小于 renderer/window/startup-total 且 startup-total 不小于 window-ready，只允许 `0.000001ms` 浮点容差。任一 failed/missing sample、非 8 轮、rotation/首样本异常、cleanup 未证实、3.1.12 phase 缺失/重复/未闭合/非有限值、receipt hash/时序不匹配，均不能 formal pass；完整数据但任一配对低于 70% 为 formal fail。阈值用未 round 的完整 Number median 裁决，只对展示值 round。禁止过滤失败样本、合池、平均 installer 与 portable 或删除首样本。

## Rehearsal 与人工 Windows seams

`npm run startup:rehearsal:golden -- --output-dir <空目录>` 只生成小型 deterministic current-schema fixture 和隐私安全 manifest。它不是 2.9GB golden，也不生成正式 migration/crash 数据，且 `formalUseAllowed=false`。三场景 harness 可用经审查的小型专用 fixture 在 `mode=rehearsal` 下运行，输出始终 `not-evaluated`。

正式发布前还须在任务管理器/Process Explorer 与可见窗口上人工确认：两代 installer/portable 的 wrapper→browser lineage；至少一个 owned 主窗口接受 `CloseMainWindow`；无 nonce renderer/utility 未清理；late-child quiescence；失败/timeout 后 runner receipt 与 DB 锁状态一致。该人工观察不能由自动报告冒充，发现残留时保留 owner-marked workRoot 供人工处理，不得扩大删除范围。

可发布报告由逐层 recursive allowlist 从 canonical known fields 重构，不 spread raw draft。每个成功样本保留 phase/duration/outcome/counts、ready、process/window/exit/三轮 quiescence、before+after main/WAL/SHM hash/size、完整 recovery counts、normal 启动前 steady flag/WAL/schema fingerprint 与启动后 fingerprint、migration 的 VACUUM 前置 flag 及精确 column/index/fingerprint、crash 的 WAL checkpoint 与 recovery sentinel 前后状态、per-sample cleanup receipt，以及 raw runner report digest；3.1.11 phase 明确为 unavailable。失败样本仍至少保留 round/status/evidenceCode，并保留已安全取得的 phase/ready/before-after/recovery/cleanup，缺项写 explicit `unavailable`；缺轮补 `MISSING_SAMPLE`，缺单 variant、其 `samples` 或整个 `variants` 时，为对应 label 生成 exact `status=unavailable`、`evidenceCode`、`sampleCount=0` 和空 samples 投影；缺整场景也保留 `run.status=unavailable` 占位，绝不因一个 blocker 清空其它安全场景。任何未知嵌套 key、敏感词、连续长账号型数字和任何含路径分隔符的 path value 都拒绝，绝不包含账号、金额、SQL/参数、WMI/PE 自由原文、相对或绝对路径、数据库/sidecar、raw report 或 raw log。
