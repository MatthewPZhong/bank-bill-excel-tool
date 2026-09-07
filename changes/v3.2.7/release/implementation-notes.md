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

- package/lock 均为 3.2.7，三份文档已同步；9 个既有版本元数据、VCC 历史文档、打包输入和 updater 资产测试文件共 27 PASS / 0 FAIL / 0 SKIP。首次文档版本行附带日期被固定格式检查拒绝，已保留原独立版本行并复验通过，未放宽断言。git diff --check 通过。
- 开发目录的打包输入检查明确拒绝当前未提交元数据和本地未跟踪 `assets/清结算自有账户表.xlsx`；该文件未改动或纳入本次提交。实际包使用 CI 干净检出，不能把本地检查标为 PASS。
- 最终 CI、main 合并/开发构建、发布前人工条件、tag/正式构建及公开资产回读仍待完成。自动技术发布不等于 Windows 人工或真实资金验收通过。
