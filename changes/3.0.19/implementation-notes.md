# Implementation Notes — v3.0.19 工具箱多 Sheet 合并

> status: released / Windows installed-app canary pending
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
- 发布快照：annotated tag `v3.0.19` 指向 `7e69698`，与 tag 推送时的 `origin/main` 一致。
- Release workflow run `29684771136` 用时 12m40s；tag/main/version、完整 `release-check`、Windows 构建、应用检查、ASCII staging、metadata/SHA-512、发布及发布后资产复核全部通过。
- Release `https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.0.19` 为 published、non-draft、non-prerelease，并成为 GitHub Latest。
- 线上资产：Setup 99,721,805 bytes，SHA-256 `1393b5cc9e41e10efe496b7858fc68f682098ee87baf40dc79a4ac2583362793`；portable 99,225,035 bytes，SHA-256 `a92f744a5729e1dc66c5205fc4ac61d108c9347819c5a6b8dfda595d2ead9947`；另含 Setup blockmap 与 `latest.yml`。
- 匿名 `releases/latest/download/latest.yml` 回读为 `version=3.0.19`、`path=bank-bill-excel-tool-setup-3.0.19.exe`；实际下载 Setup 的 `MZ` 头、大小和 SHA-512 `YoeYyh4Nt57m9iwMKLWhYXNHnR3+dkwhNzOuSRmRU/0y1froi2C54meJrSJsQX6djCmI0jakZIKiKYfkRvtySw==` 与 metadata 一致，blockmap/portable HTTP 200。

## Remaining Unknowns

- 无产品或自动化阻塞项；仍需业务方用真实 Excel/WPS 文件人工确认隐藏状态、表头、行序、总行数和分页结果。
- 仍需在真实 Windows 已安装的 v3.0.18 NSIS 上执行“立即检查 → 下载 → 重启安装 → 数据保留”canary；生产 feed 与更新资产已验证，但 macOS 环境不能替代该实机链路。
