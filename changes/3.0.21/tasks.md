# Tasks — v3.0.21 Ach Return 与 DBS-Charge 校验修复

> 每个 task 均以 spec 验收标准为完成依据。

## Task 1 — 规格与证据基线
- 目标：固定已确认规则、非目标、真实问题样本和 Unknowns Register。
- 涉及文件：`changes/3.0.21/*`。
- 验证：spec、test-spec、tasks、implementation notes 四份文档齐全且互相一致。
- 状态：done

## Task 2 — Ach Return 退款过滤
- 目标：编排器透传 R1 pairs，R5 只过滤具体 AchReturn pair.bankRow。
- 涉及文件：`reconciliation-orchestrator.js`、`r5-refund-order-backfill.js`、对应单测。
- 验证：AC-01～AC-05、P0-01～P0-04。
- 状态：done

## Task 3 — DBS 白名单与方向守卫
- 目标：固定 12 类白名单，方向守卫先于金额币种，异常可见。
- 涉及文件：`dbs-charge-fund-check.js`、`error-causes.js`、对应单测/集成 fixture。
- 验证：AC-06～AC-13、P0-05～P0-11。
- 状态：done

## Task 4 — 版本与重要变量文档
- 目标：版本更新为 3.0.21，同步三份版本文档和资金红线变量清单。
- 涉及文件：`package.json`、`package-lock.json`、`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`、`rules/important-variables.md`。
- 验证：版本搜索无陈旧 3.0.20 当前版本引用；check-vars 能命中新规则。
- 状态：done

## Task 5 — 自动验证与真实样本回放
- 目标：完成定向测试、全量 release gate、变量扫描及目标样本只读回放。
- 涉及文件：测试、`docs/analysis/var-reference-stats.md`、implementation notes。
- 验证：test-spec §6 的自动命令全部通过，受控本地问题样本输出对应退款单与精准命中，业务标识不入库。
- 状态：done

## Task 6 — 人工资金复核
- 目标：人工逐笔确认真实退款、DBS 白名单、金额币种、方向 warning 和标黄。
- 涉及文件：真实脱敏输入和导出结果。
- 验证：资金负责人留下明确验收结论。
- 状态：follow-up（用户于 2026-07-20 在知悉未完成人工逐笔复核后明确授权执行发布；不得宣称人工验收已通过）

## Task 7 — 合并归档与在线发布
- 目标：归档 PR #96 与 v3.0.21 PRD，创建受控 tag，并验证 Windows Release 与在线升级资产。
- 涉及文件：`docs/prs/PR96-v3.0.21.md`、`docs/iterations/v3.0.21/PRD-v3.0.21.md` 及本迭代四份文档。
- 验证：PR 为 MERGED、开发分支删除、tag 指向发布准备 commit、Release workflow 成功、公开资产与 `latest.yml` 一致。
- 状态：done（tag、Windows Release、四个资产和公开下载证据均已完成）
