# Spec — v3.0.19 工具箱多 Sheet 合并

> status: release-pending（PR #94 已合入 `main`；用户已追加授权 v3.0.19 发布收尾）
> owner: PM / Dev
> created: 2026-07-19
> updated: 2026-07-19
> implementation branch: `codex/v3.0.19-toolbox-multi-sheet-merge`

## 0. 任务摘要

- Goal：让工具箱「合并表格」同时支持单文件多 sheet 与多文件多 sheet，并保持现有单 sheet、CSV/XLS、流式大文件和输出格式契约。
- Context：当前 `toolbox:merge` 每个文件只读取第一个 sheet；拆分链路已有独立的多 sheet 续页读取能力，但允许后续 sheet 不带表头，不能直接作为本需求的严格合并规则。
- Constraints：每个参与 sheet 必须有完全一致的表头；只合并可见非空 sheet；不增加来源列、不去重、不排序；拆分链路行为不变；正常范围输出一个 sheet，超 Excel 行上限沿用自动分页。
- Done when：AC-01～AC-14 全部通过，版本与文档更新为 3.0.19，完整质量门通过。

## 1. 代码事实

| 事实 | 出处 | 约束 |
|---|---|---|
| 合并入口与 IPC 已是一气呵成流程 | `src/renderer-dialogs.js`、`src/preload.js`、`src/main.js` 的 `toolbox:merge` | UI、preload 和返回结构保持不变 |
| 当前 `.xlsx` 多 sheet 会回退 `readRows`，只读 `SheetNames[0]` | `src/main-process/toolbox-stream-io.js` | 需新增逐可见 sheet 的严格流式读取，不可继续静默漏 sheet |
| 拆分大文件已有按显示序读取多 sheet 的底层能力 | `src/backend/toolbox-xlsx-stream/multi-sheet-reader.js` | 复用 zip/row scanner 原语，但不得改变“续页可无表头”的拆分语义 |
| 写侧会在 1,048,575 条数据行后创建 `COMMON(2)` | `createRowsStreamWriter` | 保留自动分页，不引入新的输出规则 |
| 合并临时目录当前成功、取消保存后不清理 | `src/main.js` 的 `toolbox:merge` | 本迭代一并收敛所有退出路径的临时资源 |

## 2. 功能契约

### 2.1 输入范围与顺序

- 支持一次选择一个或多个 `.xlsx`、`.xls`、`.csv` 文件；不同格式可混选。
- `.xlsx`、`.xls` 读取全部可见工作表；CSV 作为一个逻辑工作表。扩展名为 CSV 但实际是 Excel 的文件继续按 magic bytes 识别为 Excel。
- 合并顺序固定为：文件选择顺序 → 工作簿标签显示顺序 → sheet 内原始行顺序。
- `hidden`、`veryHidden` 与完全空白 sheet 跳过。只有表头的 sheet 参与表头校验但贡献 0 条数据。
- 每个选中文件必须至少有一个可见非空 sheet；否则整次失败并指出文件。

### 2.2 表头与数据行

- 每个可见非空 sheet 的首个有意义行是该 sheet 表头；表头前的空行忽略。
- 表头按现有口径归一化：单元格转字符串并 trim，移除末尾空列；大小写敏感。
- 所有 sheet 的表头必须与首个有效 sheet 在列名、列数和列序上完全一致。
- 表头不一致时整次失败，错误明细同时列出基准文件/sheet、异常文件/sheet及双方表头。
- 每张 sheet 只移除自己的首个表头；表头后的行不去重、不排序、不做字段映射。数据区再次出现与表头相同的行仍作为普通数据保留。

### 2.3 输出与生命周期

- 输出仍为一份 `.xlsx`，默认名 `合并-YYYYMMDDHHmm.xlsx`，首 sheet 名为 `COMMON`。
- 数据行不超过 1,048,575 时只有一个输出 sheet；超过后沿用 `COMMON(2)`、`COMMON(3)` 自动分页，每页重写同一表头。
- 保持现有 by-name 日期、金额、文本格式和 Courier New 表头；不复制源 sheet 样式、公式或合并单元格。
- `window.desktopApi.toolbox.merge()` 返回契约保持不变：`success/filePath`、`cancelled`、`failed/message/detailLines`。
- 读取、表头校验、写入或发布失败均不得留下半成品；成功、取消保存、失败后都清理临时目录和句柄。
- 活动日志记录输入文件数、参与合并 sheet 数、数据行数、输出 sheet 数和保存路径。

## 3. 非目标

- 不改变工具箱拆分表格及其“后续 sheet 可省略重复表头”的续页规则。
- 不支持按相似列名对齐、重排列、来源列、去重、筛选、公式重算或源样式复制。
- 不修改任何对账、金额、币种、数据库或在线升级业务。
- 原实施范围不包含 tag 或 GitHub Release；2026-07-19 用户追加授权发布收尾，采用受控 `v3.0.19` tag workflow 发布稳定版。

## 4. 验收标准

- AC-01：单个 XLSX 的多个可见同表头 sheet 合并为一份结果，行序为标签顺序。
- AC-02：多个文件的多个 sheet 按文件选择顺序和标签顺序合并。
- AC-03：XLSX、XLS、CSV 可混选，CSV 作为一个 sheet。
- AC-04：隐藏、深度隐藏和完全空白 sheet 不进入结果。
- AC-05：任一选中文件没有可见非空 sheet 时失败且不产文件。
- AC-06：每个 sheet 首个有效行作为表头，前导空行不影响识别。
- AC-07：任一表头不完全一致时失败，明细可定位文件和 sheet。
- AC-08：每张 sheet 表头只输出一次；数据区同内容行不被误删。
- AC-09：数据内容不去重、不排序，文件/sheet/行顺序守恒。
- AC-10：普通结果只有 `COMMON`；超限后自动生成连续分页并保持总行数。
- AC-11：单文件单 sheet、既有多文件单 sheet及大文件合并行为不回归。
- AC-12：现有多 sheet 拆分续页语义和大文件 worker 路径不回归。
- AC-13：成功、取消与失败路径均无工具箱临时目录残留。
- AC-14：IPC、默认文件名、输出格式、状态反馈和启动性能不回归。

## 5. 实施与归档

- 2026-07-19：本地 `release-check` 全绿，unit 3694/3694、integration 1955/1955，GitHub Actions `smoke-test` 通过。
- 2026-07-19：PR #94 在第二轮 self-review 确认 P0-P4 Finding 为 0 后，以 merge commit `0822ad4` 合入 `main`，远程开发分支删除。
- 归档见 `docs/prs/PR94-v3.0.19.md` 与 `docs/iterations/v3.0.19/PRD-v3.0.19.md`。
- 自动化 Excel 回读已通过；Excel/WPS 真实客户端人工打开仍为业务验收项，不阻塞代码归档。
- 2026-07-19：用户在合并归档后追加发布收尾；发布必须由指向当前 `main` 的 annotated tag `v3.0.19` 触发，完整通过 Windows release workflow 后才算完成。
