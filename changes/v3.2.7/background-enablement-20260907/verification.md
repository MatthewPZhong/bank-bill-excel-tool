# 验证记录

> **当前状态：已撤回代码改动。** 用户随后明确要求“不要动代码”；本轮源代码、测试及三份产品文档已恢复到修改前状态，VCC 开关已恢复关闭。本目录保留此前检查与短暂试验的历史证据，不能解读为当前配置已开启。完整 release-check 发现两项失败后按用户要求停止（退出码 130），没有完整 PASS，也没有完成修复或重新验收。

## 环境与范围

- 基线：`f75e76d140c4019980c5387e715ab9a99f9e8ffe`，工作区 3.2.7。
- 本机 Node 24.13.0 / macOS；另使用已安装 Electron 36.9.5 / Node 22.19.0 的 Node 模式运行生产请求专项。
- 数据均为测试自己创建的临时 SQLite/工作簿/发布目录。没有读取或改写用户真实业务库，没有启动真实应用 Main。
- 所有新增生产成功验证均传 `production:true`，未注入启用 policy 或发布 PASS。资源预算值为隔离测试参数，不能作为用户机器当前内存充足的证据。

## 已执行

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 开启前新增三项生产请求 | 0 PASS / 3 FAIL，均为 POLICY_PRODUCTION_DISABLED | `production-before.log` |
| 开启后相同三项生产请求 | 3 PASS / 0 FAIL / 0 SKIP | `production-after.log` |
| Electron Node 模式同组三项生产请求 | 3 PASS / 0 FAIL / 0 SKIP，退出码 0 | `electron-production.log` |
| 三模块平台专项，8 个测试文件 | 147 PASS / 0 FAIL / 0 SKIP，退出码 0 | `focused-tests.log` |
| 当前 Manifest coverage / strategy | 396/396，66 个动作、48 个注册策略、13 个开启、53 个 effective legacy | `strategy-snapshot.json` |
| `git diff --check` | PASS | 本轮工作区检查 |
| 完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` | 执行中 | `release-check.log` |

专项包含 VCC 三种导出与原 Workbook 对比、全部业务表前后快照、实际 native Worker 和默认 durable Publisher、零泄漏关闭；同时覆盖 VCC 来源/产物拒绝、模块互斥、真实 Publisher 硬退出后的二次启动恢复、资金对账 artifact/runtime、Statement service/token 以及平台 action coverage。

新增生产回放观察 Archive handoff 回调，未在这三项中创建完整存档控制器；实际存档二启恢复由同次运行的既有 `vcc-financial-op-output-recovery.test.js` 覆盖。没有将两个层次合并描述为一次真实 UI 全链路验收。

## 未执行

- 用户实际运行的 Electron 页面点击与真实样本导出。
- Windows Setup/portable、本期 Windows 目录耐久和目标规模压力测试。
- Excel/WPS 人工打开与资金样例人工复核。
- 当前真实 userData 的备份、关停和切换；本轮只准备源码配置，不触发这些操作。
- 安装包构建、提交、PR、合并或发布。

历史 release evidence 保持原文件；本次只生成独立当前策略快照，不把旧证据改写为已启用。
