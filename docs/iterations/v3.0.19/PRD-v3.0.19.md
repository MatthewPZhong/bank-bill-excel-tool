# bank-bill-excel-tool 3.0.19 PRD

> 目标版本：`3.0.19`
> 状态：released（PR #94 已合入 `main`；v3.0.19 已发布为 GitHub Latest）
> 归档：PR #94 merge commit `0822ad4`；源规格 `changes/3.0.19/spec.md`
> 更新时间：2026-07-19
> 适用仓库：`bank-bill-excel-tool`

## 0. 迭代目标

工具箱「合并表格」同时支持单个文件的多个 Sheet 和多个文件的多个 Sheet。输入可混选 `.xlsx`、`.xls`、`.csv`，输出保持为一份 Excel 工作簿；正常数据写入 `COMMON`，超过 Excel 单页上限后自动续写。

本迭代只调整工具箱合并链路，不改变拆分表格、业务对账、数据库或在线升级功能。

## 1. 输入与顺序

- 一次可选择一个或多个 `.xlsx`、`.xls`、`.csv` 文件。
- `.xlsx`、`.xls` 读取全部可见工作表；CSV 作为一个逻辑工作表。
- 扩展名为 CSV、实际内容为 ZIP XLSX 或 OLE2 XLS 时，按文件 magic bytes 识别并读取 Excel 工作簿。
- 合并顺序固定为：文件选择顺序 → 工作簿标签显示顺序 → Sheet 内原始行顺序。
- `hidden`、`veryHidden` 和完全空白 Sheet 跳过。
- 只有表头的 Sheet 参与表头校验，但贡献 0 条数据。
- 每个选中文件必须至少有一张可见非空 Sheet，否则整次失败并指出文件。

## 2. 表头与数据规则

- 每张可见非空 Sheet 的首个有意义行作为该 Sheet 表头，忽略表头前空行。
- 表头单元格转为字符串并去首尾空格，再移除末尾空列。
- 全部参与 Sheet 的列名、列数、列序和大小写必须与首个有效 Sheet 完全一致。
- 表头不一致时，错误明细同时给出基准文件/Sheet 和异常文件/Sheet。
- 每张 Sheet 只移除自己的首个表头；数据区再次出现相同内容时仍作为普通数据保留。
- 数据不去重、不排序、不增加来源列，也不做字段映射。

## 3. 输出契约

- 输出仍为一份 `.xlsx`，默认文件名为 `合并-YYYYMMDDHHmm.xlsx`。
- 数据不超过 1,048,575 行时只输出 `COMMON`。
- 超过单页上限后自动生成 `COMMON(2)`、`COMMON(3)`，每页重复同一表头。
- 保持既有按字段名应用日期、金额和文本格式的规则。
- 不复制源 Sheet 样式、公式、合并单元格或计算状态。
- `window.desktopApi.toolbox.merge()` 及其 `success/cancelled/failed` 返回结构保持不变。

## 4. 流式处理与失败安全

- XLSX 按 Sheet 流式读取，避免把全部数据行一次性放入内存。
- XLS 使用 SheetJS 遍历可见 Sheet，CSV 沿用既有读取语义。
- 首个有效表头出现后创建流式 writer，后续 Sheet 边校验边写入。
- 临时结果先在目标目录生成，发布前备份同名旧文件，再通过原子替换完成保存。
- 读取、表头校验、写出或发布任一步失败时，中止 writer、删除本批临时产物并恢复旧文件。
- 成功、取消另存为和失败路径均清理工具箱临时目录与输入句柄。
- 活动日志记录输入文件数、参与 Sheet 数、数据行数、输出 Sheet 数和保存路径。

## 5. 兼容与非目标

- 单文件单 Sheet 和既有多文件单 Sheet 合并保持兼容。
- 工具箱拆分表格“后续 Sheet 可省略重复表头”的语义保持独立，不受严格合并模式影响。
- 不支持相似表头对齐、字段重排、来源列、去重、筛选、公式重算或源样式复制。
- 不修改任何对账、金额、币种、数据库或在线升级业务。

## 6. 验证与归档

- `npm run release-check`：PASS；unit 3694/3694，integration 42 个脚本 / 1955/1955，smoke 与 ESLint 通过。
- 新增多 Sheet 合并集成 16/16 PASS，覆盖 3 × 10 万行流式回放和 RSS 阈值。
- 既有工具箱合并、30 万行大文件合并、多 Sheet 拆分与 worker 路径回归通过。
- `npm run scan:vars`、`npm run check:vars -- --include-minor`、`npm run startup:measure` 与 `git diff --check` 完成。
- PR #94 第一轮 self-review 修复 2 个 P4，第二轮确认 P0-P4 Finding 为 0。
- GitHub Actions `smoke-test` 通过；PR #94 以 merge commit `0822ad4` 合入 `main`，远程开发分支删除。
- 自动化 Excel 回读已通过；Excel/WPS 真实客户端人工打开检查仍为业务验收项。
- 原实施范围不包含 tag 或 GitHub Release；用户于 2026-07-19 追加授权发布收尾，采用指向当前 `main` 的 `v3.0.19` tag 触发受控稳定版 workflow。
- annotated tag `v3.0.19` 指向 `7e69698`；Release workflow run `29684771136` 的完整测试、Windows 构建、应用检查、资产 staging、hash 校验、发布与发布后复核全部通过。
- [v3.0.19 Release](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.0.19) 为 published、non-draft、non-prerelease，并成为 GitHub Latest。
- 线上 `latest.yml` 匿名回读为 3.0.19，指向 ASCII Setup；实际下载 Setup 为 99,721,805 bytes、`MZ` PE 头且 SHA-512 与 metadata 一致，blockmap 和 portable 均可匿名访问。
- 生产 feed 已具备 3.0.18 NSIS 发现 3.0.19 的条件；真实 Windows 安装、重启和用户数据保留仍需人工 canary。
