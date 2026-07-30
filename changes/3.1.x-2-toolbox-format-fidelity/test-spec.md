# v3.1.2 Test Spec

## 不变量

- 表头、文件、Sheet 和行顺序不变。
- `split:read` 暴露的每个值都能由 `split:export` 重新命中。
- 原始输出值与 `matchValue` 双轨，修复格式不得改变匹配集合。
- 任一 prepare/validate/publish 失败不允许报告整批成功。
- 删除发布 target 前必须确认仍为本任务哈希。
- XLSX 低样式基数内存不随总行数线性积累。

## 自动测试

- 模型：文本/数字/布尔/错误/公式缓存/显式空白。
- 数字：科学词法、15/16 位、前导零、极大/极小、负数、多小数位。
- 日期：1900 的 59/60/61、1904 的 0/1、时间小数、`t=d`、三时区。
- 样式：XF 继承、whole-XF precedence、theme/indexed/tint、跨 registry、组件预算。
- 布局：默认/显式宽高、零宽、BIFF8 默认隐藏零高度到 OOXML `zeroHeight=1` 的转换、隐藏、outline、分页重放。
- Sheet：合并跳过 hidden/veryHidden；拆分继续参与；空/表头-only/重复表头。
- BIFF8：全部必需 record、唯一 `Dimensions` 半开区间与 65536/256 最大边界、LibreOffice `ColInfo.colLast=256` 哨兵、Row reserved 位、XFCRC、Theme/XFExt、palette、Continue、Mul*、损坏/加密/错位。
- 发布：prepare、journal、index、backup、publish、commit、cleanup 各 checkpoint 失败和重启恢复。
- Worker：IPC payload 有界，普通与 Worker 使用同一语义。

## 集成与人工

- XLSX/BIFF8/CSV × merge/单输出/多输出/分页路径矩阵。
- 30 万行低/高样式基数性能。
- Windows Excel 与 WPS 打开真实脱敏 `.xlsx`/`.xls` 产物，无修复提示。
- LibreOffice 生成的标准 BIFF8 `.xls` 合并/拆分后，OOXML `<col max>` 不得超过 256，零宽/默认隐藏布局不得变回可见；writer 产物必须可由同版 strict XLSX reader 再次扫描，且不得出现 `defaultRowHeight=0`。
- Windows/OneDrive 覆盖和恢复演练。
