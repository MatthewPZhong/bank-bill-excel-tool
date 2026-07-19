# Implementation Notes — v3.0.19 工具箱多 Sheet 合并

> status: release-pending
> owner: Dev
> updated: 2026-07-19

## Task Brief

- Goal：工具箱合并支持单/多文件中的全部可见 sheet，输出一份合并工作簿。
- Constraints：严格表头；顺序守恒；隐藏/空 sheet跳过；拆分语义不变；大 XLSX 内存有界；临时资源可靠清理。
- Done when：spec AC-01～AC-14 和 test-spec P0 全部通过。

## Confirmed Facts

- `toolbox:merge` 当前只消费每个文件的第一张 sheet。
- XLSX 多 sheet 拆分已有显示序定位与 yauzl/row-scanner 流式原语。
- `createRowsStreamWriter` 已支持 by-name 格式和 Excel 行上限自动分页。
- `toolbox:merge` 当前的 OS 临时目录没有 `finally` 清理。

## Decisions

| ID | 决定 | 原因 |
|---|---|---|
| D01 | 每张可见非空 sheet 都必须带完全一致的表头 | 用户确认；避免把未知首行误当数据 |
| D02 | XLSX 与 XLS 读取全部可见 sheet，CSV 为单表且允许混选 | 用户确认；保持现有输入格式能力 |
| D03 | 超单页上限继续自动创建后续 sheet | 用户确认；避免因物理上限拒绝大合并 |
| D04 | 隐藏、深度隐藏和空 sheet 跳过 | 用户确认；避免辅助表误入结果 |
| D05 | 新增严格读取入口，既有拆分续页入口保持独立 | 防止 v3.0.9 行为回归 |
| D06 | 第一个表头出现时懒创建 writer，后续边读边校验写入 | 只遍历数据区一次并保持内存有界 |
| D07 | 用户目标目录内先复制暂存，再备份旧文件并原子替换 | 跨磁盘保存仍可用，发布中断不留下半成品或破坏同名旧文件 |

## Assumptions

- 单文件单 sheet 继续允许，等价于按现有格式复制。
- 每个选中文件至少需要一个可见非空 sheet；完全无有效 sheet 时失败而非静默跳过。
- 不复制源样式、公式和合并单元格，沿用工具箱现有值级搬运与 by-name 格式。

## Deviations

- 无产品契约偏差。最终审查发现直接复制到用户目标可能在失败时留下半成品，因此按既有原子发布原则补充 D07；该调整落实了 spec 的失败清理要求。
- 原计划明确不创建 tag 或 GitHub Release；PR #94 合并归档后，用户于 2026-07-19 追加授权发布收尾。发布沿用 v3.0.18 建立的受控稳定通道，不改变应用代码或更新契约。

## Evidence

- strict reader、merge orchestrator、原子发布和 renderer/handler 定向 unit：62/62 PASS。
- 新增 `toolbox-multi-sheet-merge.js`：16/16 PASS；多 Sheet 流式段为 3 × 10 万行，RSS 增量低于 384MB 门槛。
- 既有 `toolbox-roundtrip.js`：30/30 PASS；既有大文件合并 15/15、multi-sheet split 31/31 PASS。
- `npm run release-check`：PASS；unit 3694/3694，integration 42 个脚本 / 1955/1955，smoke 与 ESLint 均通过。
- `npm run scan:vars`：196 个 JS 文件 / 2200 个顶层声明；`check:vars -- --include-minor` 命中项已逐项复核，Critical/Risk-sensitive 要求的 smoke 已通过。
- `npm run startup:measure`：进程总耗时中位数 767.835ms，ready-to-show 中位数 174.316ms。
- PR #94 self-review 第一轮修复陈旧路径注释，并补 OLE2 XLS 伪装 CSV 的显式路由用例；复核后 P0-P4 Finding 为 0。
- GitHub Actions `smoke-test` 通过；PR #94 head `a850e40` 以 merge commit `0822ad4` 合入 `main`，远程开发分支删除。
- 归档：`docs/prs/PR94-v3.0.19.md`、`docs/iterations/v3.0.19/PRD-v3.0.19.md`。

## Remaining Unknowns

- 无产品或自动化阻塞项；仍需业务方用真实 Excel/WPS 文件人工确认隐藏状态、表头、行序、总行数和分页结果。
