# v3.1.7 Unknowns Preflight 与发布结论

## Task Brief

- Goal：完成 Payment 与 R5s2-recon 调拨回填调整的正式收尾，并通过受控 tag workflow 生成、核对 v3.1.7 Windows 技术 Release。
- Context：功能 PR #121 已合入 `main`；版本号和三份用户文档已更新到 3.1.7；固定样本生产链路基线已建立。
- Constraints：不得修改已合并的资金口径，不得把自动化当成人工资金验收；tag 必须 annotated 且指向创建时最新 `main`；公开资产不可覆盖。
- Done when：release-closeout PR 合并；Windows Release workflow 全绿；四项公开资产与 updater 元数据独立核对；发布证据回写并合入 `main`；无未解决 P3 及以上 Finding。

## 已确认事实

| 事实 | 证据 | 对发布的约束 |
|---|---|---|
| 当前候选版本为 3.1.7，lockfile 同步 | `package.json`、`package-lock.json` | tag 必须为 `v3.1.7`。 |
| 功能已合入最新 main | PR #121；merge `6fe118b8c4d665e1ce877fb792e6a4bbcda64cdf` | release-closeout 不再修改 `src`。 |
| main Windows 候选构建成功 | run `30794912210` | 已有 Windows 构建与 updater 暂存证据。 |
| 干净依赖完整门禁成功 | release-check：unit 4,575/4,575，integration 2,051/2,051 | 本地候选满足自动发布前置条件。 |
| 固定样本生产回放稳定 | Payment 220、R5 2、命中 192、未命中 1,639 | tag 前不得出现业务基线漂移。 |
| 人工资金复核尚未完成 | `implementation-notes.md` Remaining Unknowns | 技术 Release 不得被表述为业务验收或上线批准。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 当前结论 |
|---|---|---:|---|---|
| v3.1.7 Release/tag 是否已存在 | PROBE | 高 | 通过 GitHub API 在 tag 前再次确认 | 必须不存在；存在则停止，禁止覆盖。 |
| release-closeout 合并后 main 是否仍是 tag 目标 | PROBE | 高 | 合并后 fetch 并比较 `HEAD`、`origin/main` | 只给完全相等的最新 main 打 tag。 |
| Windows Release 资产是否与 updater 元数据一致 | PROBE | 高 | 独立下载四项资产并重算 SHA-256/SHA-512 | 任一不一致停止回写成功状态。 |
| 220+2 人工资金复核何时完成 | BLOCK（业务） | 高 | 由业务负责人逐笔复核 | 阻断正式业务启用和公告，不阻止本次明确授权的技术资产生成。 |
| Windows 实机 Setup/portable 与在线升级 canary | PROBE（发布后） | 中 | 从上一 stable 执行实机验证 | 未完成前不得宣称生产 canary 已通过。 |

## 风险优先计划

1. 先冻结并复验候选：干净依赖、完整门禁、布局、变量、固定样本和生产依赖审计。
2. 仅提交 release-prepared 文档与自动生成统计，review 后合入 `main`。
3. 再次确认同名 tag/Release 不存在，并给最新 `main` 创建 annotated tag。
4. 等待 Windows workflow 完成测试、构建、发布和公开回读；失败时保留失败 tag 供审计，不覆盖同版本资产。
5. 独立下载公开资产重算摘要和 updater 契约，最后通过单独证据 PR 回写正式发布日期与发布身份。

## 资金盲区结论

- 主键血缘、付款账户、时间边界、同值消费、跨引擎银行互斥、运行态重置和行数守恒已有代码、测试和固定样本证据。
- 本次 release-closeout 不改业务实现，不新增匹配旁路、fallback、金额/币种转换或持久化状态。
- 仍命中资金红线：自动化只能证明实现符合规则，不能证明 220+2 业务配对本身正确。必须保留人工复核阻断，不得静默降级。
