# G2-T1 测试准备独立审查

日期：2026-09-20。范围为本 worktree 未提交的四个新增测试/夹具文件，输入摘要见 [preparation-tests.json](evidence/preparation-tests.json)。生产基线 `11086a3c`，G1 未固定集成。审查结论由独立只读审查汇总，本文由主执行者落盘；不代表生产 G2 验收。

**未发现阻塞“基线核对与测试准备”交付的必改项。** 独立执行三文件得到 45 tests、37 pass、8 TODO、0 fail、exit 0。8 个 TODO 中有 7 个目标断言实际执行并失败，1 个 adapter 构建场景尚无执行体；不得汇总为 45 通过。

核对结果：

- `tests/helpers/archive-aware-operation-harness.js:22` 提取并执行 Main 原函数，未复制测试专用入口；真实 IPC prepared contract 与原 helper 被复用，提取边界缺失会失败。
- `tests/unit/main-process/task-adapters.test.js:19` 保留 prepared 显式身份、Position token route、legacy recovery 透传和 Toolbox/VCC 空数组优先级；未擅改历史身份合同。
- `archive-aware-prepared-resource-entry.test.js:97` 与 `prepared-resource-scope.test.js:70` 使用目标 abandon===1，未把当前漏收口写为正确行为；两者均位于 `tests/unit/main-process/`。
- 入口错误测试保留 lifecycle unavailable 和已进入 lifecycle 的 cleanup-error 优先级；接管后通用 abandon 为零，符合 TechDoc §3.4。

覆盖限制及后续要求：

1. lifecycle、Hold、Archive、领域存储是可注入协作者，不能证明真实 BOR/DB/outbox/worker/文件权限/GUI/重启。身份用例锁定传入 lifecycle 的参数，不证明真实 owner admission 已通过。
2. Position deferred/legacy 用例验证兼容能力，没有声称存在对应生产 taskKey。
3. adapter 构建 test.todo 没有执行体，且不被 G2_T1_REQUIRE_TARGET=1 升级。T2 必须替换为真实生产构建入口故障断言，不能仅看强制目标命令。
4. 新 scope 单飞、重复 run、终结后 mark 拒绝、错误诊断留存、前置失败延迟 cleanup 的 tail 屏障仍待 T2 实现与测试。文件名不代表 scope 已存在。
5. 未执行完整 release-check、生产迁移审查或 G1+G2 组合验收。实际进度与剩余事项见 [实施记录](implementation-notes.md)。
