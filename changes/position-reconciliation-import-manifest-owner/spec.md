# v3.1.6 Spec - 平盘链接原始表 manifest owner 修复

> status: `implemented`（代码、自动化和整合 self-review 已完成；Electron 真实文件重试待完成）
> baseline: `main@603807895a39408a7c4e4246e3b2657d1ee9cc66`
> target-version: `3.1.6`
> updated: `2026-08-02`
> nature: 平盘导入 apply、即时存档与侧库 checkpoint 握手，属于资金数据 Risk-sensitive 改动。

## 1. 目标

修复普通链接原始表由 utility process 完成预检后，主进程因消息回调未保留 `AsyncLocalStorage` 上下文而无法登记 pending 输入清单，最终以“manifest 1 条、pending 0 条”拒绝 apply 的问题。

完成后，同一 operation 的预检文件必须在 apply grant 签发前形成可持久化、可核验的存档意图；任何 owner 或文件证据不一致仍须失败关闭。

## 2. 非目标

- 不改变来源类型识别、表头、行过滤、重复折叠、业务主键、链接派生或写入事务。
- 不改变金额、币种、方向、FundType、候选优先级、匹配或消费规则。
- 不删除 manifest 数量、文件路径、快照、SHA-256、大小、异常报告依赖、schema 或 checkpoint 校验。
- 不把失败批次伪装成成功，也不提供跳过存档门禁的人工继续入口。

## 3. 行为契约

1. apply 授权器从当前 pending 读取非空 `operationToken`，并确认 `archiveRequired=true`。
2. 授权器将该 token 显式传给输入及异常报告输出的存档意图登记函数。
3. 登记函数优先使用显式 token，并在写入前再次确认当前 pending owner 与 token 一致；不一致时不得修改其它操作的 pending。
4. 登记完成后，授权器重新读取 pending，逐项核对输入和输出文件证据，再持久化 manifest hash。
5. worker 仅接受 jobId、manifest、schema fingerprint 和 base checkpoint 全部一致的 grant；任一条件变化均拒绝 apply。
6. 平盘操作保持全局互斥；worker 消息按 jobId 过滤，已结束或进入恢复的作业不得再次授权。
7. 现场旧失败发生在 apply 前，升级后允许重新导入原文件；不得据此删除或修补既有侧库业务数据。

## 4. 用户界面

- 平盘“对账数据管理”的状态列仅显示状态名称，不拼接行数。
- “链接原始表导入提醒”使用稳定留白和长内容换行，操作按钮统一右对齐。
- UI 调整不得改变导入、过滤、异常报告、存档或资金校验结果。

## 5. 验收

- 普通来源输入与含异常报告输出均收到同一 pending owner token，并在 manifest 持久化后签发 grant。
- owner 变化、文件证据不一致、manifest 未持久化、schema 或 checkpoint 变化时仍拒绝 apply。
- 全量发布门禁通过，整合 self-review 无未解决 P0-P3 finding。
- 发布前在 Electron 开发环境重试原单文件，确认导入成功、存档批次可见、对账数据管理状态正确，且无重复或部分业务数据。

## 6. 人工资金门禁

⚠️ 资金红线，请人工复核：真实文件重试必须核对来源行数、重复折叠数、过滤数、链接生成数、存档输入文件和侧库 checkpoint。自动测试不能替代该验收。
