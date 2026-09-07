# v3.2.7 发布记录

## Goal / Context / Constraints / Done when

- 用户于 2026-09-07 要求远端合并 PR237，随后执行正式发布和开发发布。
- 基线：PR237 净额修改提交 `9691b888939e21c31fa4caeaf3692e9e933b220d`；远端 main 为 `5850fef15c6241da957a7af0848a1411eee9bde7`，最新正式版为 v3.2.6。本次版本 v3.2.7；预检时 tag 和 Release 均不存在。
- main 要求严格 smoke-test / build 通过，管理员也受约束；tag/资产不可覆盖。真实业务数据保持原样，验收结果按实际来源记录。
- 完成标准：版本与三份文档一致、最终 PR 检查通过并合并、main 开发构建成功及产物回读、tag 前验收条件满足、唯一 annotated tag 指向 main、正式 workflow 成功及四项公开资产校验。发布后 production/latest 人工 canary 单独记录。

## Decisions

- 先在现有 PR237 收口 package/lock 与三份发布文档，使合并前完整检查和候选包使用 3.2.7；不另建仅版本号 PR 或覆盖 v3.2.6。
- 开发构建由合并后的 main push 自动触发；不重复 dispatch。正式 Release 由唯一 annotated v3.2.7 tag push 触发。
- 沿用 docs/WINDOWS_RELEASE_RUNBOOK.md。tag 前最终 main 校验至正式 workflow 的 Verify tag and main 成功期间不执行其他 main merge/push。
- 现有 USER_AUTHORIZED 仅是业务 OP 模块启用授权。Windows Setup/portable、SmartScreen 与覆盖升级的本次人工验收或豁免不得从历史版本、模块启用或自动测试推定。

## Unknowns Register / Evidence

| 项目 | 状态 | 证据和下一步 |
| --- | --- | --- |
| 目标版本与可用 tag | PROBE 已确认 | 最新 stable v3.2.6；v3.2.7 tag 无结果、Release API 404 |
| 最终提交完整机器检查 | PROBE 待执行 | PR237 / smoke-test 含 release-check，随后 build；版本收口后按新 head 回读 |
| 开发与正式产物一致性 | PROBE 待执行 | 分别下载，各自校验四项资产、PE、版本、哈希及 latest.yml，不要求两次打包字节相同 |
| Windows 候选包及离线升级人工验收 | BLOCK 在候选可用后确认 | 若未执行，需发布负责人明确决定豁免；tag 前在稳定 PR/Issue 评论记录批准人、完整范围、理由及逐项补做计划 |
| production-release 环境批准 | PROBE | 使用现有受保护环境；按正常发布授权提交审批，不更改保护规则 |
| 在线升级与新增业务验收 | MANUAL / NOT_RUN | Windows production/latest、目标规模、实际资金及 Excel/WPS，保持未执行直到有实际证据 |

## Remaining

- 版本收口提交 `f75e76d1` 的 CI 34072318083 已成功（7059 单元 PASS / 155 SKIP / 0 FAIL，53/53 集成脚本 PASS，启动/关闭/SQLite/layout 专项通过，Windows 构建成功）。这只是修复审查意见前的基线，不能作为后续新提交的 PASS。候选附件下载遇到网络 EOF，未通过本地完整资产校验，不用于发布验收。
- 合并前发现三个未解决审查问题：首次升级低内存无限排队、非法日历授权日期被 Date.parse 进位、证据更新使 ACTIVE/未完成升级拒绝启动。均用代码和失败测试证实；最小修复与兼容合同已同步 enablement/spec.md。
- 冻结凭据测试覆盖同一数据库真实关闭重开、引用更新、授权转 PASS、撤销、摘要篡改、收据丢失以及原 Task 中断恢复；资源测试使用真实 governor 并检查无新 Task/intent、队列/租约无泄漏和旧数据保留。没有改变资金公式或历史计算结果。
- 原 Linux 目录耐久 job 的分支前缀未覆盖当前 PR237 分支；新增该分支精确匹配，使本轮 CI 在 Linux 实际执行所有业务 OP 合同，Windows 原平台 skip 判断保持不变。
- 最终审查修复在独立 f75 检出中验证全部业务 OP 测试 272 PASS / 0 FAIL / 0 SKIP（187574 ms），含授权日期 53 项、资源 11 项、冻结凭据 9 项和七处真实进程退出恢复。原全量首次暴露运行日历 IPC 数量旧断言 20，与实际 21 不符；已同步数量并显式检查日历入口存在，全部业务 handler 的禁用拒绝保持。ESLint、diff whitespace 检查通过；此轮两项生产文件 check-vars 未命中重要变量。
- 共享目录另一个用户授权任务同时修复业务 OP 发布/删除等 Main 阶段资源死等、启动错误明细丢失与退出 Promise；专属范围见 `changes/biz-op-startup-resource-wait`。它与本任务文件边界已协调，单独验收后统一最终提交；上述独立 272 项结果不包含该任务改动。
- 上述任务已冻结交付 12 个文件并核对 SHA256。其最终受影响组 27 PASS、Electron 36.9.5 / 内置 Node 22.19.0 新增组 14 PASS；此前扩展回归 156 PASS、Controller 专项 62 PASS，均 0 FAIL / 0 SKIP，集合重叠不累加。独立复核发现的 Publisher/RAW 排队取消错误已补齐实际调用测试并复核通过；详细命令见该任务实施记录。没有操作真实用户数据库或运行 Windows GUI。
- 两组合并的 8 个生产文件 check-vars 未命中重要变量；发布文档再次 27 PASS / 0 FAIL / 0 SKIP。完整最终 CI、远端 main 合并和开发/正式发布仍待执行，f75 基线成绩不可替代新提交。

- package/lock 均为 3.2.7，三份文档已同步；9 个既有版本元数据、VCC 历史文档、打包输入和 updater 资产测试文件共 27 PASS / 0 FAIL / 0 SKIP。首次文档版本行附带日期被固定格式检查拒绝，已保留原独立版本行并复验通过，未放宽断言。git diff --check 通过。
- 开发目录的打包输入检查明确拒绝当前未提交元数据和本地未跟踪 `assets/清结算自有账户表.xlsx`；该文件未改动或纳入本次提交。实际包使用 CI 干净检出，不能把本地检查标为 PASS。
- 最终 CI、main 合并/开发构建、发布前人工条件、tag/正式构建及公开资产回读仍待完成。自动技术发布不等于 Windows 人工或真实资金验收通过。
