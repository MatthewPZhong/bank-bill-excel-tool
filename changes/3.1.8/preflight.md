# v3.1.8 实施前核验

## Task Brief

- Goal: 按已锁定的 v3.1.8 Spec 完成 VCC 财务OP校验迭代，并拆成可独立评审、按顺序合并的堆叠 PR。
- Context: 基线为 `main@dff07df11fb94ce84940b474b55ac796f084d241`；版本起点为 3.1.7；Q01～Q12 已全部锁定。
- Constraints: 不改变既有充值清退、费用换汇、通道和 Pending 金额方向/分组口径；金额链路只使用十进制定点字符串；破坏性状态变更必须事务化、二次门禁、审计并提交后断言；人工财务复核是发布门禁。
- Done when: Spec 的 AC-1.1～AC-1.10、自动化回归、模板契约、版本文档和重要变量检查均有证据；Windows 产物与真实财务数据完成人工复核后才可发布。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 当前代码与 Spec baseline 完全一致 | `git rev-parse HEAD` 返回 `dff07df11fb94ce84940b474b55ac796f084d241` | 无需在漂移代码上重放补丁 |
| Pending 金标准资产已位于目标路径且内容正确 | `shasum -a 256 assets/VCC财务OP校验/VCC_移除归档Pending账单.xlsx` 返回 `f7967d...a9fc` | PR 1 可直接锁定 46 列契约 |
| 结果模板资产已位于目标路径且内容正确 | `shasum -a 256 assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx` 返回 `f920fd...1f4` | PR 5 必须使用该模板且禁止回退 |
| 精度回归真实样例可用 | `/Users/pzhong/Downloads/财务OP (22).xlsx` 存在 | PR 1 用真实 JPY 单元格验证 raw-first |
| 当前系统财务OP错误地优先显示值 | `system-op-importer.js::systemAmountToken` 先返回 display；现有测试明确断言 `123.45` 按 `0.0` 变成 `123.5` | PR 1 必须反转优先级并更新审计证据 |
| 当前 Pending 是 48 列且计算阶段不要求 Pending | `definitions.js::PENDING_HEADERS`、`calculator.js::REQUIRED_DETAIL_TYPES` | PR 1 同时升级导入契约、历史哈希与运行门禁 |
| 当前有效行唯一键为 `source_type × idempotency_key` | `vcc_fin_op_effective_rows` 的 UNIQUE 约束 | 迁移必须保持同一业务键唯一，不得重插历史事实 |
| 当前工作区含与本迭代无关的用户文件 | `git status -sb` | 所有提交只显式暂存本迭代文件，禁止 `git add -A` |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 历史 Pending `raw_json` 是否可能既非 48 项也非已知 46 项 | 旧库数据形态 | 高 | 困难 | 生产库不可直接假设干净 | PROBE | 用内存库构造 48/46/异常长度迁移 fixture | 异常长度必须整次阻断，零部分迁移 |
| 46 列重放能否与迁移后的 48 列历史事实幂等相等 | 数据契约 | 高 | 一般 | 当前 hash 基于原始全列 JSON | PROBE | 迁移测试后走一次真实分类逻辑 | v2 hash 仅删除两个旧字段，其余原值原序保留 |
| raw number 转稳定十进制 token 是否覆盖科学计数法且不掩盖超精度 | 金额精度 | 高 | 容易 | `canonicalizeVccAmount` 已限制两位小数和 15 位有效数字 | PROBE | 真实样例 + 科学计数法/公式缓存/超精度测试 | 有限安全数值 raw-first；规范化失败即拒绝 |
| 首月旧库存在多个初始化月份 | 历史状态 | 高 | 困难 | 当前 schema 允许多个月份 | PROBE | PR 2 迁移 fixture | 按 Spec fail-closed，绝不自动删改资金值 |
| 新结果模板动态行/合并区能否由现有 SheetJS writer 无损复制 | Excel 样式能力 | 中 | 一般 | 当前 writer 依赖固定行号 | PROBE | PR 5 先做真实模板 contract/round-trip 测试 | 锚点缺失即失败，不做旧模板 fallback |
| GitHub 草稿 PR 能否发布 | 外部认证 | 中 | 容易 | `gh auth status` 显示 token invalid | BLOCK（仅发布） | 用户执行 `gh auth login -h github.com` 后复检 | 不阻塞本地实现与提交；阻塞 push/PR 创建 |
| Windows installer/portable 中模板可读性 | 平台产物 | 高 | 一般 | 当前环境不是 Windows | PROBE/人工门禁 | Windows CI 构建并检查打包资产 | 阻塞最终发布，不阻塞代码 PR 草稿 |

## 保守假设

- 多 PR 使用堆叠分支：每个后续 PR 以直接前序分支为 base，只展示本阶段增量；合并顺序固定，最终再逐个改回 `main` 或顺序合并。
- 用户已放入仓库且哈希匹配的两份 Excel 属于本迭代范围；其他未跟踪文件不纳入任何 PR。
- 自动化通过不能替代 Spec 要求的真实月份财务人工复核。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | PR 1：锁定 raw 金额、Pending v2 契约/迁移和五表预检 | 金额不丢精度；旧事实唯一；输入齐全 | 真实 JPY、模板 SHA/表头、迁移及 preflight 测试 | 推翻后续所有计算可信度 | 不进入状态/UI PR |
| 2 | PR 2：首月状态、调整账本和统一生效结果 | 首月不漂移；基础结果不可变；调整一次性 | DB 迁移、金额公式、revision 测试 | 归档/删除/UI 无可靠状态模型 | 保留 PR 1，撤回新状态层 |
| 3 | PR 3：解归档与两类删除事务 | 跨月血缘、行数守恒、失败零部分成功 | 三月集成场景、token 变化、故障回滚 | 禁止开放破坏性入口 | 移除 IPC/UI，保留底层只读能力 |
| 4 | PR 4：完整结果确认与调整交互 | rowKey 防伪、核对 revision、UI 与后端一致 | renderer contract + service/DB 测试 | 不影响基础导入，可关闭修改入口 | feature UI 回滚 |
| 5 | PR 5：语义模板、着色和月份导出 | 输出可审计；样式来自模板；月份不串 | 真实模板 round-trip、fill、调整行、月份测试 | 阻塞结果导出 | 导出 fail-closed，不回退旧模板 |
| 6 | PR 6：预览、文档、版本与全量发布门禁 | 用户可见契约、重要变量、回归完整 | release-check、check-vars、Windows CI、人工清单 | 不得发布 3.1.8 | 保持全部 PR 草稿 |
