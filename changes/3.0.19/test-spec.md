# Test Spec — v3.0.19 工具箱多 Sheet 合并

> status: implementation merged via PR #94; Excel/WPS manual verification pending
> created: 2026-07-19
> updated: 2026-07-19
> source: `changes/3.0.19/spec.md` AC-01～AC-14

## 1. 测试目标

- 证明 XLSX 多 sheet 读取按显示顺序、可见性和严格表头契约运行，且流式处理不全量物化数据区。
- 证明 XLS、CSV 与 XLSX 混合输入、行顺序、输出分页和 by-name 格式保持现有行为。
- 证明新增严格读取不会改变工具箱拆分表格的既有续页语义。
- 证明任何失败或取消路径都关闭 writer/zip 并清理临时目录。

## 2. P0 必测

| ID | 场景 | 预期 |
|---|---|---|
| P0-01 | 单 XLSX，3 个可见同表头 sheet | 一份结果；只含一份表头；数据按 tab 顺序 |
| P0-02 | 两个 XLSX，各含多个 sheet，物理 sheetN 与显示序错位 | 文件顺序优先，文件内按显示序，不按 entry 名排序 |
| P0-03 | XLSX + XLS + CSV 混选 | 三种输入全部进入结果，表头只保留一次 |
| P0-04 | hidden、veryHidden、空白和仅表头 sheet | 前三类跳过；仅表头参与校验且数据行增量为 0 |
| P0-05 | 某选中文件没有可见非空 sheet | failed，detailLines 含文件名，无输出 |
| P0-06 | 各 sheet 有前导空行 | 首个有意义行识别为表头，前导空行不输出 |
| P0-07 | 列名/列序/大小写/列数任一不一致 | 整次失败，明细含基准与异常文件/sheet及表头 |
| P0-08 | 数据区出现与表头完全相同的一行 | 该行作为数据保留，仅移除每张 sheet 的首个表头 |
| P0-09 | 重复数据、空值、日期/金额/文本列 | 不去重、不排序，现有输出格式与内容口径不变 |
| P0-10 | 小阈值模拟超过单 sheet 行上限 | `COMMON`、`COMMON(2)` 连续分页，总行数与顺序守恒 |
| P0-11 | 单文件单 sheet、多文件单 sheet | 与 v3.0.18 结果契约一致 |
| P0-12 | 读取/表头/写入失败及取消保存 | 无最终文件；writer、zip、临时目录全部清理 |
| P0-13 | 既有多 sheet 拆分夹具 | 后续 sheet 可无重复表头的旧规则保持不变 |
| P0-14 | 30 万行单 sheet与多 sheet 大 XLSX | 内存有界、结果行数正确、主进程不 OOM |

## 3. P1 边界

- 文件名或 sheet 名包含中文、XML 实体和特殊字符时，诊断信息可读。
- XLS 隐藏元数据按 SheetJS `Hidden=1/2` 跳过；XLSX `state=hidden/veryHidden` 跳过。
- CSV 扩展名实际为 OLE2/ZIP 时按 Excel 工作簿读取全部可见 sheet。
- 工作簿关系损坏、可见 sheet entry 缺失、sharedStrings 损坏时 fail closed，不跳过选中数据。
- 表头尾部空列按现有规则忽略，表头内部空列仍参与全等比较。
- 表头后的显式空数据行按现有格式读取语义处理，不引入跨格式行为漂移。

## 4. 质量门

- 定向 unit：toolbox strict reader、merge orchestrator、stream writer、既有 multi-sheet reader。
- 定向 integration：toolbox roundtrip、large-file stream、large split multi-sheet、新增 multi-sheet merge roundtrip。
- 全量：`npm run release-check`。
- 变量：`npm run scan:vars`、`npm run check:vars -- --include-minor`。
- 性能：`npm run startup:measure`。
- 人工：用 Excel/WPS 打开单文件多 sheet、多文件多 sheet和分页结果，核对 sheet 名、表头、行序和总行数。
