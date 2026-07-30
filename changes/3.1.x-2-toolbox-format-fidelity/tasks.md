# v3.1.2 Implementation Tasks

## T1 — 统一载荷与纯函数

- [x] `ToolboxCell / ToolboxRow / ToolboxSheetMeta`
- [x] `matchValue` 与输出值双轨
- [x] 十进制、日期格式分类、1900/1904 和 `t=d` 无时区算法
- [x] source/output style registry 与组件预算

完成证据：纯函数、golden、预算边界单测。

## T2 — XLSX style-aware pass

- [x] ZIP/workbook/rels/styles/theme/SST 每 pass 一次解析
- [x] 稀疏逐行 scanner，保留原始词法、类型、样式、行列布局
- [x] 合并和拆分两套 Sheet 参与策略
- [x] workbook/rels/worksheet/SST/styles/theme 严格闭合、直属层级、Transitional/Strict namespace、关系完整 URI、ZIP entry 唯一性、cell type/payload 一致性和非法颜色 fail-closed
- [x] 低编号物理 numFmt 分区、x15 扩展边界、ST_Xstring 单次解码与单 cell/metadata 资源上限

完成证据：XML fixture、跨主题、显式空白、宽表、50 个真实 XLSX、压缩膨胀与资源释放测试。

## T3 — BIFF8 overlay

- [x] 标准 OLE/CFB BIFF8 验证
- [x] globals/sheet record scanner、XF/XFCRC/XFExt/Theme/palette
- [x] SheetJS 值层与 overlay 的 Sheet/坐标/XF 严格对齐
- [x] MsoCrc32Compute、CellXF/StyleXF 扩展标志及真实资产 CRC 校验
- [x] 低编号 FORMAT 分区、Date1904/id60、压缩 Font、非有限 numeric/formula/RK 与 BoolErr/special cache 值域
- [x] 唯一 Dimensions 半开区间、Row reserved 位、LibreOffice ColInfo 256 哨兵与 BIFF8 最大行列边界

完成证据：真实资产、record fixture、损坏/加密/错位 fail-closed 测试。

## T4 — 唯一 writer

- [x] 单/多输出与自动分页共用
- [x] 来源值类型、样式、行列布局
- [x] 样式缓存/预算、写后直属结构及 projected/actual count 复核、warning summary
- [x] ST_Xstring 安全编码、32,767 UTF-16 文本上限、非字符/代理项拒绝与非有限输出兜底
- [x] BIFF8 零宽列、零默认高度和默认隐藏行的等价 OOXML 投影

完成证据：XLSX 回读与 XML 计数、分页、abort、超预算测试。

## T5 — 全入口接线

- [x] merge、split:read、普通/Worker split:export
- [x] XLSX/BIFF8/CSV magic 路由
- [x] Worker 控制型 IPC，不传逐行数据
- [x] 移除 by-name/Courier 与旧 `.xls`/CSV 单输出 writer 旁路

完成证据：路径矩阵和既有行为回归。

## T6 — 可恢复发布

- [x] 全产物 prepare/validate
- [x] 同目录 staging、外部 journal、固定 userData index
- [x] batch publish、rollback、restart recovery、并发互斥

完成证据：每个 checkpoint 故障注入及子进程强杀恢复测试。

## T7 — UI、日志与发布

- [x] success `warningSummary`
- [x] renderer 有界一次提示，保持中性且不进入错误报告
- [x] 活动日志含行数、样式、验证和恢复信息
- [x] General 数字词法尾零按有效小数位生成 `numFmt`，整数不再显示末尾小数点
- [x] 版本号、CHANGELOG、功能历史、用户手册
- [x] `release-check`
- [x] 最终 `scan:vars` / `check:vars`
- [x] 自审无 P3 Finding
- [x] PR #104、PR #105 合入 `main`
- [x] 用户确认 Windows Excel/WPS 人工验收通过
- [x] 合并后干净依赖环境发布门禁
- [ ] 创建并推送 `v3.1.2` tag
- [ ] Windows Release workflow 与四项公开资产回读
- [ ] 回写正式发布证据并确认 tracked worktree 干净
