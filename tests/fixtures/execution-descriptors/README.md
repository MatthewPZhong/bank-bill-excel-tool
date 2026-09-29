# Execution Descriptor 迁移基线

本目录的两份 JSON 保存 G7-T1a 冻结的测试期望，不提供生产装配或授权；`pending-import-contract.js` 是后续真实集成的隔离输入合同。固定来源为 `main/v3.2.9@11086a3cbf632a30adbcfa796e4cd81810c5aef9`；当前依赖与实施状态见 [实施记录](../../../changes/v3.2.10/codex/v3.2.10-execution-descriptors/implementation-notes.md)。

| 文件 | 保存内容 | 行为验证入口 |
| --- | --- | --- |
| [runtime-baseline.json](runtime-baseline.json) | 49 runtime policies 的完整策略、载体与取消码、14 个 bucket 引用、Main binder 清点、资源 phase 和 estimator 有无 | [资源与 runtime 测试](../../unit/main-process/execution-descriptor-resource-profiles.test.js) |
| [archive-baseline.json](archive-baseline.json) | 268 个 channel（71 file / 63 no-file / 134 exclude）、独立 action/task authority、领域 hook 的固定输入和预期 | [Archive 基线测试](../../unit/main-process/execution-descriptor-archive-baseline.test.js) |

在当前 worktree 根目录运行：

```sh
node --test tests/unit/main-process/execution-descriptor-resource-profiles.test.js tests/unit/main-process/execution-descriptor-archive-baseline.test.js
```

测试读取固定 JSON 后调用真实现有 registry/runtime；不会在测试时重建预期或自动更新 fixture。正式迁移测试已将新冻结 policy registry 交给 [runtime helper](../../helpers/execution-descriptor-runtime-baseline.js)，将聚合后的 Archive policies 交给 [Archive helper](../../helpers/execution-descriptor-archive-baseline.js) 做同一基线对照。固定依赖获批改变行为时，先记录 release SHA 和逐项差量，再有依据地更新期望；不能仅因测试失败重采样。

Runtime 的五 registry 重建是测试准备，并非 production descriptor 转换器：它从已冻结 binding 反查已有值，不验证 descriptor exact shape、重复定义或 G1/G2 registrations。Main binding 清单由代码清点得到；[等价测试](../../unit/main-process/execution-descriptor-equivalence.test.js) 补充了正常注入、BizOP dispatch、跨 generation 隔离与 passthrough，不能单靠本 fixture 的 callable 标记推断这些行为。

函数的 callable/API 标记只证明注册形状。Archive 已执行固定领域行为样例，仍不等于真实文件/DB proof 或全部业务输入等价。资源测试走真实 Supervisor 但在载体创建前停止，不能作为实际 worker exit、取消、恢复、service/adapter 或 Windows 打包验收证据。
