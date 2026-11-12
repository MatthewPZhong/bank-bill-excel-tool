# TechDoc — 「核对上一账单日余额」弹窗截断、金额浮点尾差与首日断档说明

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.17（暂定） |
| 分支 | `fix/balance-seed-mismatch-dialog`，基于正式标签 `v3.2.16`（`8e027cb8`） |
| 日期 | 2026-11-10 |
| 状态 | 已实现，待 PR 审查与 GUI 人工检查 |
| 依据 | [spec.md](spec.md) D1–D3 |
| 格式来源 | `changes/v3.2.16/feat/statement-balance-verification/techdoc.md`（按本任务规模精简） |

## 一、技术决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| T1 | `normalizers.js` 新增 `sumAmounts(values)`：浮点求和后按各值最短十进制表示的最大小数位（`countAmountDecimals`，含科学计数法，上限 12）`toFixed` 取整；经 `file-service.js` 门面导出 | D2。加减法精确结果的小数位不超过输入的最大小数位，按它取整即还原精确值；输入带 12 位小数时与 `roundAmountHighPrecision` 等价，不触碰 PRD v1.5.0 的 12 位保留与 15 位有效数字转文本规则。不改 `roundAmountHighPrecision`：统一截到 15 位有效数字会丢掉直接映射余额（如 4 位整数 + 12 位小数）的位数 |
| T2 | 换用 `sumAmounts`：`verifyStatementEndingBalance` 的收入 / 支出合计、预期、差额；`calculateEndingBalanceFromAmounts`；`deriveBalanceRecords` 的附加值叠加 / 扣回与人工补录替换差额；`statementSeedOriginalBalance`；`resolveBalanceAdjustment` 的累计 | 覆盖余额链路上全部加减点。候选去重与比较仍用 `roundAmount`（两位小数），判定不变 |
| T3 | `buildBalanceSeedMismatch` 增加 `missingFrom` / `missingTo`（不缺日期为空串，与 `mismatch` 同形）与 `suggestedSeedDate`（缺日期为首日前一天，否则为种子日期）；判定沿用 `isBalanceDateGap` / `shiftDateLabel` | D3。经 `error.context.seedMismatch` 展开原样进入生产路径与 worker 路径的 prompt，不新增错误码、IPC 字段或路由 |
| T4 | 主进程 `formatBalanceSeedMismatchLine` 缺日期时追加「；中间缺 …」，仍列全部余额 | 活动日志用于审计，不做摘要 |
| T5 | Renderer `formatSeedMismatchStatementBalances`：> 6 个余额时为「（共 N 个）前 3 … 后 3」；`formatBalanceSeedMismatchDetail` 缺日期时改写结尾；预填日期取 `suggestedSeedDate || seedDate`，缺日期时金额留空 | D1、D3。旧 prompt（无新字段）回退到 v3.2.16 行为 |
| T6 | `styles-gemini-extra.css`：`.manual-balance-card > .manual-balance-context` 设 `flex: 0 1 auto; min-height: 0; overflow-y: auto`，其子项与 `.manual-balance-form`、`.dialog-actions` 不收缩；说明 `overflow-wrap: anywhere` | D1。卡片已是 `max-height` + `overflow: hidden` 的纵向 flex，正文区收缩滚动即可让输入区与按钮留在可见区域；与断档 / 不一致确认框「正文滚动、按钮可见」同一模式。只影响作为卡片直接子项的上下文区，其他复用 `manual-balance-card` 的弹窗无此结构或不溢出 |

## 二、改动文件

| 文件 | 改动 |
| --- | --- |
| `src/backend/file-service/normalizers.js` | `countAmountDecimals`、`sumAmounts`；校验与发生额计算改用 |
| `src/backend/file-service.js` | 导出 `sumAmounts` |
| `src/backend/balance-adjustment-store.js` | 附加值累计改用 `sumAmounts` |
| `src/main-process/statement-generation-business.js` | 加减点改用 `sumAmounts`；`seedMismatch` 增加缺日期字段 |
| `src/main.js` | 活动日志补缺的日期 |
| `src/renderer/dialogs/configuration.js` | 余额摘要、断档说明、预填 |
| `src/styles-gemini-extra.css` | 核对弹窗正文滚动 |

## 三、测试

| 层级 | 位置 | 覆盖 |
| --- | --- | --- |
| 单测 | `tests/unit/backend/file-service/normalizers.test.js` | 合成数据在旧口径下确有尾差；`sumAmounts` 还原精确值、保留 12 位小数、科学计数法、空数组与 NaN；校验三种结果与发生额计算无尾差 |
| 单测 | `tests/unit/backend/balance-adjustment-store.test.js` | 多条附加值累计无尾差 |
| 单测 | `tests/unit/main-process/statement-balance-verify.test.js` | D7 对象含新字段；首日缺多天 / 一天的 `seedMismatch`；补录首日前一天后相符且旧种子不动；活动日志补缺的日期 |
| 集成 | `scripts/integration/statement-balance-verify.js` Step8、Step10 | 真实 xlsx：补录提示金额无尾差并写明缺的日期 → 按建议补录 → 生成并回读余额与种子；发生额计算余额表为数字单元格 |
| Renderer | `scripts/renderer-lifecycle/fixtures/configuration-dialogs.js` | 缺日期的说明全文、余额摘要、预填与提交；只缺一天与 ≤ 6 个余额；1080×760、150% 下说明区滚动、输入与「完成」可见并可点（旧 CSS 下该用例失败） |

## 四、兼容与回滚

- 余额数值：原本带尾差的值现在输出精确值（如 2,008,582.8800000001 → 2,008,582.88）；原本已是精确值的不变。已落盘的带尾差种子不迁移：以它为起点时按其小数位参与计算，结果可能仍带尾差（合成数据约一半），按分比较不受影响；登记 [B80](../../../../knowledge/backlog.md)。
- 回滚：还原本分支提交即可，无数据迁移。
