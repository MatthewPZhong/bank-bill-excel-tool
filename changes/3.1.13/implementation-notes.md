# v3.1.13 Implementation Notes

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| 当前阶段 | 实现与自动门禁完成；待 Windows 人工验收 |
| 基线 | `7221274f01b769c2786b63300f554fec65bf8641` |

## Baseline

- Goal/spec：`changes/3.1.13/spec.md`
- Technical design：`changes/3.1.13/techdoc.md`
- Initial plan：覆盖确认文案 → 状态结构/生命周期 → 运行保护 → 存档中心默认筛选/布局增补 → 两个对账模块初始化状态修复 → 全局状态框星星移除 → 测试/预览 → 版本资料。
- Done when：Spec §6 的十四项验收闭合，未验证的 Windows 边界明确保留。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 状态框使用工具箱工厂内局部状态 | 工具箱弹框每次创建即独立会话，无需持久化到 renderer 全局 state | 新增全局状态和 IPC | 关闭并重开工具箱后回到“等待操作” |
| 三条 Promise 共用一个 busy 派生状态 | 任一条运行时都不应关闭或再启动另一条 | 只隐藏 close、不禁另一入口 | 防止并发工具箱任务与遮罩旁路 |
| 状态框短状态、详细结果保留原提示框 | 144px 状态框不适合路径和多行错误；已有提示框完整展示 | 把路径/错误全文塞进状态框 | 数据可见性不回退，布局稳定 |
| 【返回】沿用 response 0 | 现有判断发生在 FilePlan 和临时目录之前 | 新增返回码并重建分类编辑器 | 仅文案变化，零写入合同不变 |
| 用单一 CSS label-width 变量表达 2× | 标签和状态框共享同一几何来源 | 两处独立写死 72/144 | 后续标签宽调整时比例不漂移 |
| Spec 与 TechDoc 分离 | Spec 冻结用户可见行为，TechDoc 记录 DOM/CSS、状态机和验证落点 | 把实现细节塞进用户行为条目 | 后续实现偏差可按层反向同步 |
| 空日期直接复用现有查询语义 | controller/repository 已把空字符串解释为不按日期筛选 | 新增“全部日期”枚举或后端接口 | 仅改初始 UI 值，筛选/维护数据流不变 |
| 设置齿轮移动到标题 copy 内 | `data-action` 是行为绑定依据，移动 DOM 不改变事件合同 | 复制第二个入口或改成文字按钮 | 只有一个设置入口，aria/title 保留 |
| 只移除两项统计投影 | 路径、文件大小、迁移仍依赖 `getStats()` | 停止请求 stats 或缩减 API payload | 后端兼容与迁移观测不变 |
| 设置页不再重复投影文件总大小 | 用户明确把移除范围限定在存档设置；浏览页顶部仍承担容量概览 | 同时移除浏览页容量或停止请求 stats | `getStats()` 合同不变，设置页结构更精简 |
| 维护提示按入口静默而非隐藏共用提示栏 | 同一提示栏还承载列表、迁移、删除、保留期限等有效错误 | 全局过滤字符串或隐藏 `archive-feedback` | 仅 maintenance 文案消失，非维护反馈保持可见 |
| 维护完成继续刷新，失败仅写开发日志 | UI 静默不应改变维护状态机、数据刷新与重试 | 删除全部维护事件处理 | 用户界面不被维护进度打扰，后台失败仍可诊断 |
| 自动模块同步成功不写状态框 | v3.1.9 已冻结“同步真实数据和按钮但保持欢迎”；当前 `enteringModule=true` 恰好反向覆盖 | 每次进入强制重写欢迎文案 | 首次静态欢迎保留，当前进程内用户动作反馈跨模块切回也不被擦除 |
| `updateStatus:false` 只静默成功，不静默失败 | 历史契约明确读取错误仍可见；静默所有写入会制造假正常 | 失败只写 console 或沿用旧摘要 | 失败结果和 reject 均清无效 session、同步安全按钮态并显示 error |
| 平盘 `initialize()` 仅在 refresh 成功后写欢迎 | 无条件 finally/后置写欢迎会覆盖真实读取失败 | 依赖 HTML 初值且不显式收口 | 初始化成功语义明确；异常不会阻断整个 renderer 初始化 |
| 对账单修复场景列表失败独立显示 | 模块自动进入同时读取场景与 session，任一失败都属于真实初始化读取失败 | 只显示 session-status 失败 | 场景 IPC 非 ok/reject 不再只留 console，成功 session 同步也不会吞掉该错误 |
| 删除星星包装而非仅隐藏 SVG | 14 个入口均为纯装饰，General 虽已隐藏但 Clear 仍显示；只隐藏会留下死 DOM、渐变 ID 和图文 gap | 仅加 `display:none` 或保留空 `.status-spark` | 两套主题 DOM 一致，状态更新仍只依赖 `.status-box-text`，不触碰其它 SVG |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 【返回】不要求恢复刚才的多文件分类编辑状态 | 用户只要求按钮文案“取消”改“返回”；现有取消回工具箱 | 用户可能希望回到原分类编辑器 | 可后续增加明确返回码和 `initialGroups`，不影响本版发布合同 |
| 状态框初始文案可采用“等待操作” | 项目状态框普遍使用“等待…”短文案 | 仅文案偏好 | 单行替换即可回滚 |
| “全量批次”沿用现有单次最多 1000 条查询合同 | 用户把行为归因于日期默认值且明确称为前端改动；现有 UI 无分页 | 超过 1000 条时不会展示更老批次 | 若后续要求真正无限滚动，单独设计分页与游标，不在本次静默扩展 |
| 模块切回时保留当前状态文案优于强制重置欢迎 | v3.1.9 说明“用户动作后的状态反馈仍按原路径显示”；状态文案不驱动业务按钮 | 若产品期望每次切回都只看欢迎，会与当前解释不同 | 该行为可通过把自动入口改成成功后显式欢迎回滚，不影响 session 或业务结果 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| v3.1.13 只包含工具箱三项调整 | 同版追加存档中心三项前端调整 | 用户在首轮交付后明确新增需求 | 扩大 renderer/CSS/预览/文档测试范围，不改变后端与数据合同 | 是 |
| 存档中心首轮增补保留设置页文件总大小和维护提示 | 同版继续移除设置页重复容量投影并静默维护类顶部文案 | 用户追加明确需求 | 只改变 renderer 展示，维护执行与非维护反馈不变 | 是 |
| v3.1.13 原计划不再改其它主模块 | 同版修复平盘对账数据处理与对账单修复初始化状态 | 用户发现 v3.1.9 已声明行为在真实入口未实现并要求修复 | 新增两个 renderer 状态投影改动、行为测试、主面板预览与文档；不改对账业务 | 是 |
| 星星移除初始盘点只覆盖 Electron 生产入口 | 盲区复核追加清理 `Clear/` 六个当前 UI 样板及样板 CSS | 全仓非历史检索发现该目录仍复制同款星星，且被版本资料用作当前结构基线 | 不改变运行包；消除样板漂移并把静态回归扩大到镜像路径 | 是 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 基线与工作树检查 | HEAD `7221274f`；追踪文件无改动 | 避免覆盖用户已有追踪改动 |
| 工具箱调用链审计 | 定位 renderer 三条 Promise、main 唯一多文件冲突框 | 实施范围与旁路 |
| 布局样式审计 | header/body 左 padding 28px、标签 72px、按钮 36px | 精确几何方案 |
| 既有测试/preview 审计 | 有 renderer 静态测试、multi-split IPC 测试、toolbox preview | 可复现验证入口 |
| 工具箱定向单测 | `renderer-dialogs-toolbox` 与 `toolbox-multi-split-ipc` 合计 48/48 PASS | 状态 DOM、生命周期、busy 门禁、几何、【返回】零写入顺序 |
| 工具箱 preview | `npm run preview:toolbox` 成功；`docs/previews/toolbox.png` 为 2480×1720，并完成视觉检查 | 状态框左沿、跨行上下沿、按钮与标签布局 |
| lint 与工具箱 roundtrip | `npm run lint` PASS；`toolbox-roundtrip` 30/30 PASS | 语法/风格与常规合并拆分合同 |
| 版本资料定向单测 | 12/12 PASS；与存档中心静态合同合跑 38/38 PASS | v3.1.13 版本号、三份版本资料、Spec/TechDoc 与存档 UI 口径一致 |
| 存档空日期 probe | controller/repository 已有空日期不筛选合同；运行布局捕获首次 `{localDate:'',moduleId:'',batchNumber:''}` | 不改 IPC/后端即可展示全部日期范围 |
| 存档中心运行布局 | `npm run verify:app-settings-layout` 6/6 PASS（1240×860、1080×760；100%/125%/150%） | 日期空值、跨日期 4 批次、标题齿轮相邻、位置按钮相邻、精简统计与横向溢出 |
| 存档中心双页 preview | browser/settings 均为 2480×1720，browser 150% 为 2160×1520；三张均完成视觉检查 | 空日期 placeholder、标题栏、设置页路径/按钮及移除统计 |
| 完整 release-check（存档首轮增补后、二次 UI 精简前） | lint PASS；smoke PASS；unit 5591/5592 PASS（1 skip、0 fail）；48 个 integration 脚本、2410/2410 断言 PASS | 前序全项目回归；unit 日志 `logs/unit-tests/unit-20260820-193446.log` |
| 存档二次精简静态合同 | 存档中心 + 版本资料合跑 38/38 PASS | 设置页移除标题/容量、五类维护提示静默、完成刷新与非维护错误入口保留 |
| 存档二次精简运行布局 | `npm run verify:app-settings-layout` 6/6 PASS（1240×860、1080×760；100%/125%/150%） | 设置页移除项不可见、浏览页容量保留、非维护保留期限失败仍显示顶部错误 |
| 存档设置二次 preview | `archive-center-settings.png` 重建为 2480×1720，并完成视觉检查 | 页面直接从存档位置开始，保留期限布局正常，无统计标题、容量或异常空白 |
| 二次精简 lint 与全量 unit | `npm run lint` PASS；unit 5591/5592 PASS（1 skip、0 fail） | 最终 renderer/CSS/文档测试回归；日志 `logs/unit-tests/unit-20260820-195717.log` |
| 工具箱重型集成 | large-file 50/50、large-split 31/31、multi-sheet-merge 16/16、multi-split 17/17、roundtrip 30/30 PASS | 大文件、多 Sheet、多文件发布与普通流程均未回退 |
| 最终盲区扫描 | 未发现需追加代码的高/中风险缺口；已移除节点无残留消费，维护五类展示入口均静默，完成刷新/选中清理与非维护反馈仍在 | 入口旁路、空值、状态生命周期、失败可观测性、兼容、可访问性与测试缺口 |
| v3.1.9 历史契约与回归引入点审计 | VUI-02 明确三个模块成功初始化保持欢迎；commit `acb7d2ea` 引入 `enteringModule` 接线并被静态测试锁错 | 证明不是用户记错，也不是 v3.1.13 新回归；修复应落在自动模块入口 |
| 初始化状态定向回归 | 平盘与状态框测试合计 51/51 PASS；版本资料 12/12 PASS | 平盘成功欢迎、按钮同步、默认动作摘要、自动重进保留、失败结果/reject；修复 session 成功静默与失败强制可见 |
| 主面板布局验证 | 沙箱内 Electron 6 组均 `exit null` 且无断言输出；按环境失败分类后在沙箱外 6/6 PASS | 两 viewport × 100/125/150%，四个指定状态框初值精确为欢迎且既有对齐无回退 |
| 两个主面板 preview | `recon-id-fix-panel.png`、`position-reconciliation-panel.png` 均重建为 2480×1720并人工查看 | 两个真实应用主面板均显示“欢迎使用小助手”，布局和按钮态正常 |
| 初始化状态增补 lint/diff | `npm run lint` PASS；`git diff --check` PASS | 生产 renderer 语法/风格与补丁空白检查 |
| 初始化状态增补全量 unit | 5596/5597 PASS（1 skip、0 fail） | 350 个 unit 文件全量回归；日志 `logs/unit-tests/unit-20260820-202422.log` |
| 初始化状态增补 smoke | `npm run smoke` PASS；ReconID scenario/engine/IO/IPC/end-to-end 与其它模块 smoke 全绿 | 对账单修复业务链、场景、迁移、Excel IO 与共享网关路径未因状态投影改动回退 |
| 最终定向复跑 | 状态生命周期与版本资料 63/63 PASS；`git diff --check` PASS | 新增 null 失败返回守卫后，成功/失败/reject/空响应和文档合同全部闭合 |
| 状态框入口与镜像审计 | 生产共 14 个入口（`index.html` 13 + 工具箱动态 1），`Clear/` 当前样板另有 6 个镜像；全仓非历史检索后 `index.html`、`src/`、`Clear/` 的 `status-spark`/状态渐变 ID 均为 0 | 入口旁路、动态工厂、主题差异与当前 UI 样板漂移 |
| 状态框无图标定向回归 | 主面板、平盘、工具箱与版本资料合计 87/87 PASS；逐状态框断言无 `.status-spark`/`svg`，两套生产主题和样板 CSS 无残余图标盒/gap | DOM、CSS、特殊新开账户结构、动态工具箱与文档合同 |
| 状态框真实几何验证 | `npm run verify:main-panel-alignment` 6/6 PASS；双 viewport × 三档缩放下单/多行文字中线偏差均 0px | 纯文字居中、不溢出、资金长状态滚动、控件对齐、无状态框 SVG |
| 状态框视觉基线 | 重建 13 个主页面模块代表预览及 `toolbox.png`，共 14 张；人工查看 main/new-account/bank-statement/position/toolbox | 普通、特殊直系文字、跨行、长框与工具箱状态框均无星星且无异常留白；模块切换器等非状态 SVG 保留 |
| 星星移除最终门禁 | `npm run lint` PASS；unit 5597/5598 PASS（1 skip、0 fail）；`npm run smoke` PASS；`git diff --check` PASS | 350 个 unit 文件、状态更新、对账 smoke、主题与补丁空白；unit 日志 `logs/unit-tests/unit-20260820-205126.log` |
| 合并前完整 release-check | lint PASS；smoke PASS；unit 5597/5598 PASS（1 skip、0 fail）；48 个 integration 脚本、2410/2410 断言 PASS | 最终工作树完整门禁；unit 日志 `logs/unit-tests/unit-20260820-205852.log`，集成清单由 runner 自动同步 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows 原生 message box 是否按预期显示【返回】/【覆盖全部】 | PROBE | 发布前 Windows 人工查看 | 不得把 macOS 自动测试表述为 Windows 人工验收 |
| packaged Windows 长任务期间关闭按钮消失、双入口禁用与遮罩门禁的真实手感 | PROBE | 发布前使用足够大的合并/拆分文件人工查看 | 静态合同与 macOS 自动化不能替代该平台验收 |
| 最终工具箱布局是否满足四边对齐 | CLOSED | 已生成并检查 `docs/previews/toolbox.png` | preview 与 CSS 几何合同一致 |
| 存档中心在 packaged Windows 系统字体下的最终相邻间距 | PROBE | 发布前打开 browser/settings 两页人工查看 | 6 组 Electron 布局验证与 150% preview 已过，但不冒充真实 Windows 字体验收 |
| 超过 1000 个可见批次时的分页/无限滚动 | ASSUME | 若真实数据量需要展示更老批次，另立后端游标需求 | 本版沿用既有查询上限，不阻塞当前前端验收 |

## Blindspot Pass

### [已覆盖] 空日期仍可能被其它初始化逻辑改回当天

- 事实：日期模板唯一；`currentArchiveFilters()` 直接读取 input value；运行布局捕获首次请求为空。
- 影响：若存在旁路会继续只显示当天批次。
- 处置：已覆盖；删除默认当天 helper，并由静态合同与真实 DOM 验证双重锁定。

### [已覆盖] 移除统计节点造成 `renderArchiveStats()` 空引用

- 事实：旧实现无条件写入设置页文件大小、运行次数和最新批次 role；DOM 删除后会在设置加载时抛错。
- 影响：存档路径、浏览页文件大小和迁移状态均无法渲染。
- 处置：已同步删除三个设置页 `.textContent` 写入，保留浏览页容量和其余 stats 投影；设置页 preview 和 6/6 布局验证均成功加载。

### [已覆盖] 移动按钮产生第二入口或丢失可访问名称

- 事实：renderer 模板中只剩一个 `open-archive-settings` 按钮，`title`/`aria-label` 保留，事件按 `data-action` 委托。
- 影响：重复加载设置或键盘/读屏入口退化。
- 处置：已覆盖；静态合同、DOM 父子/相邻断言和 preview 均通过。

### [已覆盖] 静默维护提示误伤共用提示栏

- 事实：`archive-feedback` 同时承载维护状态与列表、详情、迁移、保留期限、文件操作、锁定、删除、重试等结果和错误。
- 影响：若整体隐藏提示栏或按关键词全局过滤，真实用户操作失败会变成无反馈。
- 处置：只在 maintenance 专属入口停止调用 `showArchiveFeedback()`；静态审计确认非维护调用仍在，运行测试确认保留期限最终失败仍显示。

### [已覆盖] 静默完成提示同时丢失维护收口行为

- 事实：完成事件不仅显示文案，还携带 deleted IDs 并触发列表、详情和容量刷新。
- 影响：若删除整个 completed listener，已到期批次会继续显示，容量与选中态不同步。
- 处置：保留 completed 订阅、deleted IDs、`loadArchiveBatches()` 和 `loadArchiveStats()`；仅删除提示写入。失败事件保留开发日志，后台失败状态与再次进入重试合同不变。

### [已覆盖] 自动模块进入旁路再次覆盖欢迎文案

- 场景：HTML 与模块自身 `initialize()` 都是欢迎文案，但 `setCurrentModule()` 另发一次自动刷新并把 `enteringModule=true` 当成摘要投影开关。
- 事实与证据：历史 commit `acb7d2ea` 同时引入两条旁路；全仓搜索确认平盘和对账单修复只有 `setCurrentModule()` 这一条自动进入入口。
- 影响：有历史 session/pending run 时，用户真正看见面板的一刻仍是历史摘要，形成“代码看似修改、界面没改”的假完成。
- 处置：已覆盖；两个入口固定 `updateStatus:false`，测试明确拒绝 `enteringModule` 与旧 `showSummary` 接线。

### [已覆盖] 静默成功模式吞掉真实读取失败

- 场景：若把 `updateStatus:false` 简单理解为“不写任何文案”，初始化 API 的 failed/null/reject 会留下欢迎或旧成功摘要。
- 事实与证据：平盘旧代码没有捕获 `api.status()` reject；对账单修复旧代码的非 ok/reject 只清 state 或写 console，场景列表失败也只写 console。
- 影响：按钮与后端状态不一致时用户看不到原因，可能把读取失败误认为模块可正常使用。
- 处置：已覆盖；静默开关只约束成功摘要。failed/null/reject 均进入 error，清无效 session/result 并更新安全按钮态；场景列表失败独立投影。行为测试覆盖四类返回。

### [已覆盖] 自动重进擦除用户动作反馈

- 场景：若每次模块进入都强制写“欢迎使用小助手”，导入、运行、导出、回导、确认或场景选择结果会在切出再切回后丢失。
- 事实与证据：v3.1.9 明确要求用户动作反馈沿原路径显示；平盘默认 `refresh()`、修复模块各 action handler 仍使用 `updateStatus=true`。
- 影响：成功/失败反馈生命周期缩短，用户难以判断刚才动作结果。
- 处置：已覆盖；自动成功同步不写 DOM，从而保留当前文案；用户动作默认刷新不变。平盘行为测试先写摘要再静默刷新并断言摘要保留。

### [已覆盖] 初始化并发顺序造成错误被欢迎覆盖

- 场景：恢复平盘为上次模块时，`setCurrentModule()` 的自动 refresh 与后续 awaited `initialize()` 可能并行。
- 事实与证据：两条自动成功刷新均不写摘要；`initialize()` 只有自己取得 ok 才写欢迎，失败直接保留 error。
- 影响：无条件后置欢迎会制造假正常；无内部 catch 会让整个 renderer 初始化失败。
- 处置：已覆盖；reject 在控制器内收口，成功/失败写入条件互斥。6 组布局、真实 preview 与全量 unit/smoke 均通过。

### [已覆盖] 只清生产 DOM 会遗留当前 UI 样板旁路

- 场景：最初按 Electron 入口盘点出 14 个 SVG，但根目录 `Clear/` 的 6 个当前样板仍复制同款状态框星星。
- 事实与证据：`Clear/` 是已追踪的当前界面参考，并被版本历史用作 HTML 结构基线；它不属于冻结旧版本文档。
- 影响：运行界面虽已修复，但样板、后续人工参考或复制实现仍会把星星带回。
- 处置：已反向同步 Spec/TechDoc，并同步移除 6 个镜像和样板 CSS 规则；静态测试遍历 `Clear/*.html`，全仓非历史检索为零。

### [已覆盖] 仅隐藏 SVG 会留下空容器与主题差异

- 场景：General 主题原本已用 `display:none` 隐藏星星，若只追加隐藏规则，Clear DOM、渐变 ID、空 `.status-spark` 和 8px gap 仍存活。
- 事实与证据：状态更新只查询 `.status-box-text`，图标不承担交互或状态语义。
- 影响：两主题结构漂移、文字可能保留幽灵间距，后续样式变动还可能重新露出图标。
- 处置：删除包装、SVG、专属选择器以及外框/内容层无效 gap；两套主题和样板都由静态合同锁定无残留。

### [已覆盖] 装饰清理误伤功能性 SVG 或状态生命周期

- 场景：“所有状态框”若被扩大为全局删除 SVG，可能误伤模块切换器、按钮图标；若整体改写 `textContent`，可能破坏状态框结构、色调或点击行为。
- 事实与证据：改动只落在 `.status-box` 的星星包装；模块切换器星形图标在更新预览中仍保留。renderer、各模块与工具箱继续写 `.status-box-text`，`data-tone`、`aria-live`、点击和错误态路径未改。
- 影响：误删功能入口会造成可用性回退，状态写入退化会让运行/失败反馈失效。
- 处置：逐状态框无 SVG 断言与全量 unit/smoke 已通过；工具箱 `role="status"`/`aria-live="polite"` 和 busy 生命周期测试继续有效。

### [已覆盖] 无图标后特殊结构、多行与滚动布局偏移

- 场景：新开账户状态框没有 `.status-box-content`；资金状态框允许长文本滚动；工具箱状态框跨两行。统一重构或只测单行可能遗漏偏移。
- 事实与证据：新开账户保持直接文字子节点；真实几何验证覆盖 12 个内容层状态框的单/三行文字、资金框 24 行滚动和新开账户无图标；工具箱以专用预览和几何 CSS 合同覆盖。
- 影响：文字可能不居中、滚动底部不可达或工具箱四边对齐回退。
- 处置：6/6 Electron 几何验收全部 PASS，单/多行中线偏差均 0px；14 张代表预览重建并抽查无异常留白。

## Reconciliation Blindspot Pass — 初始化状态增补

### [已覆盖] 状态投影不得改变对账数据或按钮判定

- 场景：平盘与对账单修复属于资金/对账模块，UI 修复若误改 session、场景选择或按钮条件，可能改变用户可执行的业务动作。
- 事实与证据：生产 diff 只改变自动入口的 `updateStatus` 参数、状态读取异常收口和状态框写入；成功 response 到 `state` 的字段映射、`canRun/canExport`、selected scenario、run/export IPC payload 与全部业务 handler 均保持原实现。ReconID smoke 的 scenario/engine/IO/IPC/end-to-end 全绿。
- 推断/未知：状态框文本不参与任何匹配、回填、金额或导出判断；全仓引用只用于 DOM 展示。
- 资损或审计影响：无数据写入、主键、金额、币种、方向、匹配、幂等、行数守恒、标黄或 Excel 输出变化。
- 最便宜验证：生产 diff 审计 + 全量 unit + `npm run smoke`；无需为纯 renderer 投影重复跑真实资金样本。
- 处置：已覆盖。

### [已覆盖] 共享网关运行入口仍按用户动作更新

- 场景：资金对账模块可复用 `runGatewayReconScenario()`，成功后默认调用 `refreshReconIdFixStatus()`，会更新隐藏的对账单修复状态框。
- 事实与证据：该调用未传 `updateStatus:false`，仍属于用户主动运行后的默认更新；之后切入对账单修复时自动同步不会擦除它。
- 推断/未知：这与 v3.1.9“用户动作后的状态反馈仍按原路径显示”一致，不应为了“首次看见模块”强制重置欢迎。
- 资损或审计影响：只影响跨模块可见反馈，不改变共享 session、场景类别校验或 run/export 结果。
- 最便宜验证：全仓调用点审计和 smoke 中共享网关 ReconID 路径。
- 处置：已覆盖且为有意设计。

### 资金红线结论

- 未命中账号/主体/币种识别、金额/方向/手续费/汇率、主键/唯一键/幂等、回填、重复记账、零输出或审计解释红线。
- 本增补无需新增真实资金数据人工复核；v3.1.13 既有 Windows 工具箱人工门禁仍按原计划保留，不能与本结论混为一项。
- 建议保留的自动化即本次新增：成功同步、失败结果、null、reject、用户动作反馈保留、自动入口常量接线和两主面板初始文案。

### 存活边界

- 没有会改变当前实现方案的高/中风险问题。
- “全量”仍受既有单次 1000 条上限约束；真实 Windows 系统字体与打包环境保留发布前人工检查。
- 两个对账模块的初始化状态修复为平台无关 renderer 逻辑，自动行为测试和真实 macOS preview 已闭合；不把 preview 冒充 Windows 打包环境验收。
