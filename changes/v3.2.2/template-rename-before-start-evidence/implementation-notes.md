# Implementation Notes

## Baseline

- Goal/spec: [preflight.md](./preflight.md)
- Initial plan: 先用入口级测试复现共享 `no-file` 包装契约缺口，再做单行 fallback 修复，最后跑生命周期相关回归。
- Done when: `template:rename` 等普通 `no-file` handler 不再因空 evidence 被拒绝，同时最终 Hold gate 和非法 evidence fail-closed 行为保持不变。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 修共享 `no-file` 包装层的缺省返回值 | `template:rename` 没有自定义 hook；生命周期明确接受对象；相同 fallback 为共享入口 | 仅给 `template:rename` 增加伪造的 `prepare/beforeStart` | 同类普通配置操作一并恢复，名称校验和写入逻辑不变 |
| 返回冻结前可合并的空对象 `{}`，不放宽生命周期验证 | lifecycle 初始 evidence 已是冻结空对象，合并 `{}` 不改变内容 | 允许 `null`；删除最终 gate；吞掉所有非法返回值 | 自定义 hook 返回 `null`、布尔值或数组时仍会明确失败 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `node --test tests/unit/main-process/archive-task-policy-registry.test.js`（改动前） | 23/23 PASS | 证明原测试缺少无 evidence fallback 契约覆盖 |
| 同命令（只加入回归测试、生产修复前） | 23/24 PASS；新增用例捕获实际返回 `null` | 证明测试能复现现场 lifecycle 契约错误，不是假阳性 |
| `node --test`：flow resolver、IPC contract、TaskLifecycle、policy registry、worker context 共 5 个文件 | 98/98 PASS | 覆盖 no-file exact-five owner、最终 gate、policy/IPC inventory、flow 绑定和 worker DTO |
| `npm run smoke` | PASS | 覆盖账单、ReconFix、收单币种、使用统计等项目 smoke 组 |
| `git diff --unified=0 -- src/main.js` + `rules/important-variables.md` 自查 | 本次语义命中 Important-skeleton `TaskLifecycle`；自动脚本的其他 Critical/Runtime 命中来自工作区既有未合并改动 | 已按清单补跑 lifecycle/policy/IPC/flow/worker 聚焦测试和 smoke，不把他人改动归因于本补丁 |
| reconciliation blindspot pass | 无主键、金额、币种、方向、行数、输出或迁移 diff；无资金红线 | 证明本修复只改变任务准入空 evidence，不改变账单数据语义 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 当前用户现场是否还存在第二个独立重命名错误 | PROBE | 用户安装修复版本后用同一模板重试；若仍失败再读取错误报告 | 不阻断本次已证实的准入缺陷修复 |
| SQLite 更新成功但模板库文件同步失败的既有双写窗口 | ASSUME | 本补丁不改变原有写入顺序；如后续遇到该独立错误，另立事务/补偿任务 | 不扩大本次生命周期契约修复范围 |
