# PR5 实施记录

2026-09-07 VCC 紧凑样式追加（起点 623c4cdc）：用户认为整体结构仍臃肿，要求参照 VCC 导出数据、删除、导出月份与选择导入账期弹窗。Goal/Done when：业务 OP 对应小弹窗在字体、控件、标题和留白上缩小，之前按钮定位/成功提示均保留，更新 PR237。

- PROBE 已确认：VCC 表单标签和正文 13px、输入 38px、small 按钮 36px；VCC 导入账期标题 18px/600。业务 OP 字段继承 16px，操作按钮默认 48px，标题叠加了通用顶部 padding；仅缩窄外框未消除这些差异。
- Decisions：使用既有 VCC 字段类和公共 small 按钮，局部统一 18px 标题及紧凑 header/footer，按内容收紧六类小弹窗；保留数据管理大表结构。删除预览和运行输入清单长名称换行、长列表滚动，完整保留影响范围和原业务合同。
- Deviation：最新明确要求缩小整体字体/结构，取代上一轮固定保留 233/152/180px 字段的约束；已先同步 spec。业务 OP 仍按日选择，不套用 VCC 月份业务语义。
- Evidence：最终 UI 43 PASS、真实 Electron 鼠标/键盘取消 11 PASS，lint/diff 检查通过；当前 VCC 四个预览入口实测与 BizOP 表单均为 13px、小按钮均为 36px，BizOP 标题与 VCC 导入账期均为 18px/600。开始运行与输入/结果导出初始高度约 247.5px；删除确认在完整明细仍可滚动的前提下最高约 510px。1080 窗口 100%/125% 下表单边缘、运行明细日期不重叠及底部可达验证通过。
- 视觉复核补充：缩窄后的日期最初侵入版本列，增加完整日期最小宽度，并以文字 Range 检查内容不跨列；删除/运行清单增加内容高度上限。截图等待已有有限动画结束，避免把正在恢复的按钮颜色记成最终外观。原始记录为 /tmp/bizop-ui-compact-20260907 与 /tmp/bizop-ui-compact-cancel-20260907，汇总在 button-layout-validation.json；截图已刷新。
- check-vars：本次仅命中 renderer 局部 dialog，按 rules/important-variables.md 的明确排除复核为非 Main 全局变量；原保存位置取消和真实输入取消已通过。业务 OP 原生模态焦点、busy、请求绑定、删除 mode 和资金数据语义保持。
- Remaining：更新 PR237 并读取远端 head/CI 状态；本轮不重跑整套 release-check 或 Windows 人工验收。

2026-09-07 按钮定位补充（起点 e682bec0）：落实用户四项对齐、取消尺寸和原表导出成功提醒要求；验收为隔离 Electron 中导出前/中/后按钮坐标稳定、三个弹窗边缘对齐、成功与取消/失败正确分支，随后更新 PR237。只改前端及说明，不修改输入、输出、金额或 IPC 合同。

- PROBE 已确认：setBusy 把取消按钮追加到数据管理 footer 第三个 flex 子项，破坏原有左右分组；改用左侧独立取消槽，右侧按钮组继续靠右。
- PROBE 已确认：通用 dialog-actions 的左右 28px padding 与表单缩窄列不一致；按钮栏与表单共用列宽，取消按钮另有槽位。
- ASSUME：用户在第 1 项同时提到结果原表与校验原表，成功提醒覆盖 RESULT_FULL、OP_RAW、FLOW_RAW 三种原表；不扩大到其它导出类型。弹窗取消显示短文案【取消】，使宽高可与【删除】一致，保留完整 aria-label 和原 requestId 取消协议。
- Decisions：成功提醒在原操作实际结束并恢复控件后创建；只有 status=ok 才显示，pendingArchiveHandoff/cleanupPending 继续明确提示，失败/取消不报成功。需求已同步 spec.md。
- 历史中间方案（已由上面的 VCC 紧凑样式取代）：两个弹窗由 760/620px 收紧为约 527/392px，保留运行日期约 233px、导出日期 152px、目标 180px；预检输入清单使用内容区滚动，取消槽与底部对齐继续保持。增加 1080 窗口 100%/125% 缩放的等边距检查。
- 历史提交 623c4cdc Evidence：UI 41 PASS、真实鼠标/键盘取消 11 PASS，lint 与 diff 检查通过；导出前/中/成功后管理按钮坐标完全一致，取消与删除宽高一致，三个表单边缘误差小于 1 CSS px，原表成功/失败/取消/归档收尾未决分支通过。原始记录分别位于 `/tmp/bizop-ui-buttons-20260907` 与 `/tmp/bizop-ui-buttons-cancel-20260907`；本轮截图同步到 screenshots/。
- check-vars：仅词法命中 renderer 局部 `dialog`。按 rules/important-variables.md §3 的明确排除，它不是 Main 的 Electron dialog；仍按“改 dialog 调用必须考虑用户取消分支”复核，保存位置取消及十一项真实输入取消检查通过。
- Probe 修正：新增成功预检检查已建立可运行状态，后续失败探针直接点击确认运行，避免重复发起预检并误用前一轮按钮就绪状态。未放宽产品预检或失败条件。
- 验证边界：上述 UI/取消检查使用真实组件与合成 API，不对用户真实数据执行导出或删除；本次前端调整未重跑完整 release-check 或 Windows 人工验收。

2026-09-07 页面布局纠偏：此前单排主工具栏及主页面“导出数据”不符合 E5 §6 的 VCC 财务 OP 布局要求，数据管理分类下拉也偏离参考结构。修正范围、依据与验证见 [layout-correction.md](layout-correction.md)，保留原功能和恢复合同。

## Unknowns Register

| 项目 | 分类 | 证据与处置 |
| --- | --- | --- |
| 真实 IPC 当前都拒绝新业务 | PROBE 已确认 | ipc.js 只有禁用占位；本 PR 装配 Main 服务依赖与 preload，生产断言仍由 PR6 控制 |
| 操作月份与当前对象 | PROBE 已确认 | runs 有 operation_month；datasets 从 activated_at 取成功月份。只列 ACTIVE/PUBLISHED，原表来源另以有界元数据页展示 |
| 预览/确认间变化 | PROBE | 持久 token + generation + 完整闭包摘要，confirm 时复核；失败不自动扩大选择 |
| 删除计划工作量 | PROBE 已确认 | 只涉及目录关系，不扫描明细；预览严格受既有 64 KiB 控制文档预算，确认的规范化/核对走已注册 delete-plan 原生 job |
| 历史结果、原件和用户锁 | PROBE | 复用 commitDelete 精确 owner holds 和 reclaim；真实文件测试两种模式与重启，不直接删除 Archive blob/外部文件 |
| UI 偏好 | 已确定 | E5 §6 的布局、列序、按钮、操作月份和导出入口，直接实现并截图验证，不重开业务选择 |
| 上线门禁 | OPEN | Windows、目标规模、人工资金/Excel 和 PR6 激活均未通过，本 PR 继续默认关闭 |

## Decisions / Evidence / Deviations

- PR235 修复：同一个取消按钮随操作移入当前模态弹窗，保留 busy、Escape 阻断和关闭保护；同步禁用防重复取消，响应按原 requestId 核对后才更新提示。10 项真实 Electron 鼠标/键盘输入场景通过，包含两层删除弹窗、保留结果删除、原表/结果导出、发布保护及取消响应晚到。另跑原 UI 11 PASS 和真实 IPC/删除 18 PASS；查看了运行、删除、发布保护三张实际截图。
- 新 UI 探针初次只发 keyDown/keyUp，没有完整 Enter 字符事件；随后补上真实 char 事件。另修探针把函数返回给 Electron 导致的不可克隆返回值。以上为验证脚本问题，未通过更改产品键盘行为绕过。最终测试无 `element.click()` 激活取消控件。
- check-vars 仅命中 renderer 局部 `dialog`，按 important-variables.md 判定不属于 Main 的 Electron 全局 dialog；原生文件选择与用户取消分支沿用，真实 IPC 取消回归通过。导入/计算最后取消屏障现分别由 PR2 / PR3 自身提供，不依赖 PR5。

实施中持续更新；最终 review 和 validation 随本 PR 提交。

- 月份沿用现有 run 目录的 UTC 成功时间口径；输入由固定 activated_at 派生，增加表达式索引，不新增可与时间戳漂移的冗余字段。页面显示相同存储口径，不因本机显示时区变化改操作月份。

- 真实 IPC 主窗口及主 frame 校验；选择引用 10 分钟、最多 64 个待处理引用，绑定窗口/action。requestId 以请求摘要去重，同窗口业务串行；近期完成请求有界保留，选择已消费时不能通过新 requestId 重放。
- 20 个 Main/preload 入口一致；7 个导出 action 逐项 literal invoke，保持仓库的接口清单检查能力。新增 8 个排除频道不改变 71 file / 63 no-file 分类。
- preflight 固定当前 generation；提交在原 EXCLUSIVE 区间核验。页面处理异步预检/列表的晚到响应，错误保留日期且阻止重复任务。
- 完整预览可用既有控制文档上限：64 KiB、最多 4096 元数据评估，不改成截断清单；选择文件上限沿用 4096 来源预算，完整响应仍守 256 KiB，超限提示缩小选择。
- KEEP_RESULTS 缺结果说明是实现复核中补上的故障链。预览增加 manifestDigest，删除前及已提交恢复/回收前核验保留结果、说明、RESULT holds 和实际原件；读取原件的额外阶段以既有 Governor 1 GiB 准入，真实返回后释放。更晚合法独立删除的结果不由旧 KEEP_RESULTS 复活。
- 取消现在覆盖 worker 之后的导入/计算封存核验；Main 在最后事务前重新检查 signal。共享平台核心不改，Provider/回收挂钩仅在 BizOP 模块内部。
- 第一次完整检查 3 个旧接口清单断言失败；修订后专项 35 PASS。最终全量仍待重跑结果，不能用专项替代全量。

最终完整回归：release-check 退出码 0，7079 PASS / 3 既有 SKIP / 0 FAIL，53 个集成脚本 2488/2488。第一次清单失败及修订保留在验证记录，不覆盖历史失败。
