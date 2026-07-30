# v3.1.2 Unknowns Preflight

## Task Brief

- Goal: 工具箱“合并表格 / 按字段拆分”在 Spec B 枚举范围内保持来源值类型、数字格式、静态基础样式和行列布局，且长编号安全、最终可见纯数字不使用科学计数法。
- Context: v3.1.1 已完成发布开发收尾；当前分支为 `codex/v3.1.2-toolbox-format-fidelity`；现有工具箱读取载荷主要为 `string[]`，普通、Worker、多输出和分页路径存在分叉。
- Constraints: 不修改资金匹配、场景配置或数据库；XLSX 30 万行仍须流式；所有输出整批 prepare/validate 后再发布；BIFF8 `.xls` 与 `.xlsx` 同版交付格式保真，不允许运行时依赖 LibreOffice 或静默降级。
- Done when: Spec B 路径矩阵、格式/日期/长编号、样式预算、整批回滚、自动测试与 Windows Excel/WPS 人工验收均有可审计证据；版本文档及发布门禁通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| XLSX 流式 reader 当前只向上游传递值数组 | `toolbox-stream-io.js`、`toolbox-xlsx-stream/multi-sheet-reader.js` | 必须新增工具箱专用 style-aware 契约，不能只改 writer |
| 当前 writer 按列名应用固定格式并硬编码表头样式 | `toolbox-stream-io.js` | 必须让来源样式和布局贯穿读取、路由、Worker 与写入 |
| `.xls` 当前由 SheetJS 整表读取 | `toolbox-merge-io.js` 等入口 | `.xls` 需要独立 BIFF8 样式元数据 overlay |
| 两套现有 `.xls` 解析入口均能读取值、长编号、numFmt、填充、行列尺寸/隐藏/outline 和公式缓存值 | `probes/xls-capability-probe.js`，2026-07-29 实测 | 这些属性具备实现基础 |
| 两套现有 `.xls` 解析入口均读不到字体、边框和对齐 | 同一 probe：`xlsx` 与 `xlsx-js-style` 均缺 `font/border/alignment` | SheetJS 保留值层；项目自有 BIFF8 record scanner 补齐样式层 |
| BIFF8 会把日期格式规范化为转义形式，但显示语义不变 | probe 中 `yyyy-mm-dd hh:mm:ss` 回读为 `yyyy\\-mm\\-dd\\ hh:mm:ss` | 格式比较必须做语义规范化，不能把合法转义误报为丢失 |
| BIFF8 可以携带 `Theme` record，且现有真实资产包含 theme + XFExt theme 色 | `assets/外汇交割表.xls` 的 record-level 只读核查 | `.xls` 颜色解析不能只依赖 palette；必须把嵌入 theme 解析为最终 ARGB |
| 既有 `.xls` 拆分只读首个 Sheet，Spec 的 BIFF8 路径矩阵要求多 Sheet | `readRows` fallback 与 Spec 9.10 对照 | 本版明确扩展 `.xls` 为与 XLSX 相同的续页语义，并写入版本说明 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `.xls` 字体、边框、对齐如何满足 Spec B | 已知未知 | 高，新增二进制解析与错位风险 | 一般 | 两套现有解析器不暴露必要属性；用户明确要求 `.xls` 同版纳入 | RESOLVED / PROBE | BIFF8 record scanner + SheetJS overlay fixture | 项目自有只读 BIFF8 样式层，不依赖外部程序 |
| BIFF8 overlay 与 SheetJS 值层能否逐 Sheet/坐标稳定对齐 | 已知未知 | 高，错位会造成值/样式串行 | 一般 | BoundSheet offset 与 cell XF record 可提供稳定键 | PROBE | 覆盖 Blank/MulBlank/RK/MulRK/Formula 的双层一致性 fixture | 任一不一致整文件 fail-closed |
| BIFF8 Theme/XFExt 色能否完整解析为 ARGB | 已知未知 | 高，真实 `.xls` 可能串色 | 一般 | 真实资产包含 Theme 与大量 theme 色 XFExt | PROBE | Theme record + XFExt fixture 与 Excel 可见颜色对拍 | 未知必需颜色类型整文件 fail-closed |
| XLSX 普通与 Worker 的匹配值是否完全一致 | 已知未知 | 高，可能改变拆分结果 | 容易 | 当前路径实现不同 | PROBE | 先建立 `toMatchValue` golden 再重构 | 生产实现前锁定 golden |
| 多输出发布中途失败能否完整恢复 | 盲区 | 高，可能产生部分结果 | 一般 | 当前入口各自管理临时文件/覆盖 | PROBE | 注入 prepare/publish/rollback 各阶段失败 | 固定外部 journal + userData index |
| 跨主题颜色及 1900/1904 日期能否无时区漂移 | 已知未知 | 高，可见结果错误 | 容易 | 当前载荷不保留主题/日期系统 | PROBE | XML fixture + 三时区回读 | 纯算法转换，不使用本地 `Date` |
| 样式预算能否在写正式目标前被准确阻断 | 已知未知 | 高，Excel 可能修复文件 | 容易 | 当前无组件预算 | PROBE | 接近/超过五项预算 fixture | prepare 阶段失败且正式目标零变化 |

## 保守假设

- `.xls` 值和既有 `matchValue` 继续以 SheetJS 为权威；BIFF8 层只补样式、显式空白及布局，任何对齐异常整文件失败。
- 本版 `.xls` 指 BIFF8（Excel 97–2003）；其它旧 BIFF、加密或伪装格式明确拒绝并提示转换，不静默输出。
- CSV 沿用全量读取，只保证词法值、前导零、长数字和不显示科学计数法；不宣称来源样式。
- 公式表达式继续排除，只输出缓存值及有效样式。
- 合并跳过 hidden/veryHidden；拆分保留既有隐藏 Sheet 行为，二者不得互相套用。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | `.xls` fixture 与 BIFF8 scanner/overlay | 不过度承诺旧格式保真，防止值/样式错位 | 双解析器 capability map + record/overlay fail-closed 测试 | 推翻 `.xls` 实现结构 | 不回落 fill-only；保持正式目标零变化 |
| 2 | 契约/匹配 golden/纯函数 | 拆分结果、值类型和格式语义不漂移 | 单元与 golden 测试 | 阻塞后续接线 | 仅保留 probe/解析层，不接生产入口 |
| 3 | XLSX 与 BIFF8 最小拆分闭环 | 验证两类载荷汇入同一 writer | XML/回读、Excel 可见结果与内存证据 | 推翻实现结构 | 回滚到契约层 |
| 4 | 合并/Worker/多输出/分页 | 全入口行为一致 | 路径矩阵全过 | 发现入口旁路 | 逐入口停止发布 |
| 5 | journal/预算/告警 | 防止部分发布和不可打开文件 | 故障注入、预算边界、恢复测试 | 阻塞发布 | 保留旧目标与 backup |
| 6 | 文档、人工验收与发布检查 | 最终可见结果可信 | Excel/WPS 签字、release-check、check-vars | 不允许合并 | 保留分支继续修复 |
