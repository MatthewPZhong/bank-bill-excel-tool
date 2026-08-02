# bank-bill-excel-tool 3.1.6 PRD

> 目标版本：`3.1.6`
> 状态：released（v3.1.6 已于 2026-08-03 发布为 stable/latest）
> 源规格：`changes/3.1.6/spec.md`
> 交付归档：`docs/prs/PR118-v3.1.6.md`
> 更新时间：2026-08-03

## 1. 版本目标

新增「VCC财务OP校验」，把五类财务原表的流式导入、业务键幂等、主体九币种发生额、系统余额比较、首月人工期初、跨月归档和数据管理放进一条可追溯流程；同版修复平盘普通链接原始表在预检后被 pending 存档清单门禁误阻断的问题。

## 2. 用户能力

1. 按账期导入 VCC充值清退明细、VCC费用及换汇明细、VCC通道明细、移除归档Pending账单和系统财务OP。
2. 充值/费用使用订单号、通道使用渠道订单号、Pending 使用 PendingBizId 防止重复导入；同内容跳过，异内容阻断并保留双方血缘。
3. 按主体和 AUD、CAD、CNH、EUR、GBP、HKD、JPY、SGD、USD 计算发生额；系统 CNY 映射为 CNH。
4. 缺少上月归档时一次性人工初始化九币种期初；确认归档后余额成为下月期初，已归档月份禁止补数、撤销和原地重算。
5. 每个主体导出一个只含“财务OP校验结果表”和“移除归档Pending发生额计算表”的工作簿。
6. 数据管理支持查看导入记录、幂等/冲突/回滚审计，按账期删除未归档有效原表，以及按账期和目标表导出当前有效原表或校验表。

## 3. 关键业务契约

- 系统财务OP只接受正式资产的 16 列完整表头和原顺序，主体、账期、业务部门、币种和财务余额均取原表正式字段。
- 金额不使用浮点累计，最多 2 位小数和 15 位有效数字，超界不自动舍入。
- Pending 按流水币种和 Pending 币种分别带符号汇总，Sheet2 J:K 差额直接作为 4.2 发生额。
- 归档绑定当时的输入 revision；活动导入、失败记录、缺期初、缺系统快照或九币种不完整均阻断。
- 删除和导出均只读取当前有效事实，完整保留历史导入结果及审计，不把失败、回滚或已删除数据重新计入。

## 4. 平盘修复

独立导入进程 apply 时显式传递已经从 pending 读取并验证的 operation token，主进程登记前再次核对 owner。路径、快照、SHA-256、大小、异常报告依赖、manifest、schema 和 checkpoint 门禁均保持失败关闭；管理页状态列和异常提醒只做显示收敛。

## 5. 自动化与合并

- PR #118 于 2026-08-02 以 merge commit `54acd9ea0dc5a8b9bfa9528a9d0d264018c7c3f1` 合入 `main`。
- self-review 修复 1 个 Pending 校验表名称 P3，复查后无未解决 P0-P3 Finding。
- 合并后干净依赖门禁：unit 4,592/4,592、integration 2,051/2,051，lint 与 smoke 全绿；主页面几何 6/6 PASS。
- Windows Build run `30755450625` 完成 smoke、SQLite teardown、主页面对齐、Setup/portable 构建、包体和更新资产暂存。
- 真实生产路径已回放 5,018,417 行三类明细、28,812 行 Pending 和正式 PPHK 九币种系统OP。

## 6. 发布与人工门禁

用户已授权并完成稳定版技术发布。annotated tag `v3.1.6` 指向创建时最新 `main@97324e56`；Windows Release [run 30756698074](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/30756698074) 全部成功，[v3.1.6](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.6) 已成为 latest、non-draft、non-prerelease。Setup、blockmap、portable 和 `latest.yml` 四项资产的大小与摘要已独立复核，updater 元数据与 Setup 实际字节一致。

以下项目仍未执行，不得因技术发布完成而记为通过：完整历史业务键扫描、真实资金逐项复核、真实 400 万行导出、Windows Excel/WPS、平盘现场单文件重试，以及从上一 stable v3.1.5 的离线/在线升级 canary。
