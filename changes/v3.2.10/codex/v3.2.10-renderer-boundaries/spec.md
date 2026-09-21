# Spec｜v3.2.10 Renderer 状态边界与弹窗生命周期治理（G3）

| 项目 | 内容 |
|---|---|
| 目标版本 | 3.2.10 |
| 治理项 / 优先级 | G3 / P1；优先交付弹窗生命周期切片 |
| 适用模块 | 公共弹窗、模块导航、旧 Renderer 领域控制器 |
| 计划功能分支 | `codex/v3.2.10-renderer-boundaries`；本文未创建分支 |
| 代码基线 | `main@11086a3cbf632a30adbcfa796e4cd81810c5aef9`；正式附注标签 `v3.2.9` 对应提交 |
| 集成目标 | `release/v3.2.10`；交付前已与 v3.2.9 同步，本次未操作 Git；实施时按[总索引](../../README.md)再次核对 |
| 文档日期 / 状态 | 2026-09-20 / 设计稿，未实施，本文验收尚未执行 |
| 配套文档 | [techdoc.md](techdoc.md)、[治理总索引](../../README.md) |
| 格式参考 | [v3.2.9 工具箱 Spec](../../../v3.2.9/codex/v3.2.9-toolbox-split-by-rows/spec.md) |
| 依据 | [耦合审查 G3](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/review.md)及其局部探针 |

## 1. 目标与事实边界

用户要求将耦合治理具体写成按功能分支组织的 Spec / TechDoc。本分支把“责任入口”落实为进程内 JavaScript 模块：公共弹窗宿主唯一管理挂载和销毁，导航只管理模块选择，各业务控制器管理自己的缓存、订阅和面板。不增加独立进程、服务、开发框架或 ESM 迁移。

已核对的事实：

- [renderer.js:217](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:217)集中保存多个领域的状态；[renderer.js:599](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:599)向 Dialogs 注入全量 `state/elements/desktopApi` 及业务刷新回调。
- [renderer-dialogs.js:279](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-dialogs.js:279)和 [renderer.js:4028](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:4028)各有直接清空 `modalRoot` 的实现；不能只迁移其中一份。
- [renderer-vcc-financial-op.js:193](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-vcc-financial-op.js:193)的 `mountDialog` 独立绑定 `keydown`，仅它自己的 `close` 执行解绑和 `onClose`。月份选择等 Promise 依赖此回调完成。
- [renderer-dialogs.js:5610](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-dialogs.js:5610)的账户映射弹窗叠加在链接表管理上；加载失败禁止保存，保存成功会关闭映射层并保留结果告警。Position 也存在自行挂载/移除弹窗的路径。
- [renderer.js:1598](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:1598)的导航掌握领域刷新；场景弹窗直接刷新 BankStatement/ReconID 面板。
- [renderer.js:7133](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:7133)明确保留资金对账网关流程与 ReconID 修复共享 main session、引擎和导出的业务决策；本次不拆成两份数据事实。

已有模拟 DOM 探针证明“VCC 挂载 → 公共关闭”会删除节点但不调用关闭回调、遗留键盘监听；这不是已完成的真实 GUI 触发复现。本文提出的模块、接口与行为测试均是新设计，不把参考的 Position scoped API 当作全仓已经隔离。

## 2. 范围与交付阶段

以下阶段属于同一个功能分支，按顺序提交可审查的切片；文档不授权本次直接实施。

| 阶段 | 本阶段必须完成 | 完成边界 |
|---|---|---|
| R1 公共弹窗 | 统一 modalHost；迁移两份公共 open/close、全部 VCC mountDialog、链接表 → 账户映射 → 告警、Position 的直接挂载/关闭，以及存档设置 → 删除确认、工具箱 → 拆分选择/结果告警 | 所有生产代码对 `modalRoot` 的挂载、清空、移除经宿主；清理和 Promise 收尾可组合验证 |
| R2 导航生命周期 | 建立控制器注册表；给所有现有面板统一 `enter/leave/dispose`；先用旧入口适配器保留行为 | `setCurrentModule` 不含领域恢复/刷新分支，重复进入不重复绑定 |
| R3 场景与共享会话 | 提取 BankStatement、ReconID 控制器及场景管理；明确 mutation 结果和失效路由，保留共享 session | 删除 Dialogs 中对这两域的反向刷新回调；两个面板状态私有，场景关闭不抹导出结果 |
| R4 旧域迁移 | Pending、PreFund、BankBU、Duplicate、Acquiring、VCC OP Calc、旧 BizOP 回退控制器依次迁出；现有 Position、VCC Financial OP、BizOP v327 实现接入同一生命周期 | 导航和公共弹窗不持有这些域的状态；旧域每个切片均先保留后移除转发 |
| R5 账单与配置收口 | 账单生成、新建账户控制器；模板/大账号/账户映射通过窄配置服务；应用外观/窗口/更新留在应用壳私有服务 | `renderer.js` 只装配壳、公共服务和控制器；旧全量 state/elements 注入不再用于生产 |

R1 可先交付并单独验收，但不能据此宣布整项 G3 完成。R2 的适配器是迁移步骤，R5 验收时不得继续把全量 `state` 藏在适配器内传给新模块。

范围不包括修改业务计算、导入导出格式、数据库 schema、IPC 名称、存档/清理资格、账号映射统一管理的待实施需求，也不借重构改变现有页面布局或文案。相邻账号映射需求另有材料，本分支只治理 v3.2.9 已有交互的生命周期。

## 3. 弹窗用户行为

### 3.1 普通打开、替换与嵌套

- 普通根弹窗的打开是“替换根会话”：先检查现有栈全部层是否允许关闭，全部允许后，从顶到底收尾，再挂载新根。任一层忙碌拒绝时不删除旧 DOM、不创建新活动层；新工厂延后到检查通过后执行。
- 嵌套打开必须指定父句柄，保留父层表格、滚动、筛选和未提交草稿。父层仍挂载但不可交互，只有栈顶接收 Escape、遮罩和键盘焦点。
- 点击关闭、取消、遮罩、Escape 都是“请求关闭当前层”。保留各弹窗原先是否允许 Escape/遮罩关闭的策略，不把本来必须点确认的告警改成可随意取消。
- 替换顶层仅用于当前视图确实结束的转换，以及账户映射保存成功后的结果告警；只清理被替换层及其后代，保留祖先。需要返回原窗口的临时确认、字段选择、告警必须 `push` 子层，父句柄保持 mounted，关闭子层直接显露父层，不能销毁后重挂同一个旧 DOM。多步向导确需替换时，草稿由仍存活的会话 owner 持有，新视图从草稿重建。
- 业务完成后关闭中间层时，其后代不得成为失去父级的孤儿。默认连同后代从顶到底清理。账户映射成功告警以“替换映射层”完成，不依靠先 append 告警再偷偷移除映射层。

### 3.2 忙碌与关闭控制

`canClose(reason)` 是同步、只读的关闭资格判断。正在不可中断保存/提交的窗口继续保留关闭禁用策略，遮罩/Escape/替换同样遵守；不能只禁用右上角按钮。关闭拒绝后维持当前焦点和输入。

普通导航不是业务取消。离开页面时关闭本域允许关闭的窗口；存在拒绝关闭的窗口则保留当前模块，不能先隐藏面板再报告阻塞。已有后台任务继续按其原取消入口处理，modalHost 无权凭“关窗口”取消或删除任务。

`dispose` 是控制器/宿主销毁时的最终资源释放，不用于绕过忙碌锁。应用文档卸载或初始化失败可强制销毁；它只清理前端监听、节点和待决交互，不声称回滚已经发出的 IPC 或停止后台任务。

### 3.3 清理和 Promise

每层只执行一次清理：事件解绑、定时器/动画取消、DOM 移除、业务 `onClose` 和 Promise 完成各恰好一次。重复关闭、事件冒泡、Escape 与按钮同一轮触发不得二次回调。

新内部弹窗 Promise 统一区分 `{ status: 'submitted', value }` 和 `{ status: 'cancelled', reason }`。取消、替换、父层关闭、控制器销毁都必须结束等待。原调用方需要 `null/false` 等值时只在过渡包装层转换，不能把取消当成功提交。

清理回调抛错时继续完成其余清理和 Promise，交给现有日志通道记录；不因一个回调异常遗留遮罩或永远等待。弹窗异步加载在关闭后返回时，不写 DOM、不复活告警、不启用保存按钮。

### 3.4 焦点

新顶层先聚焦显式指定控件，次选第一个可交互控件，再退回可聚焦的 dialog 本身。Tab/Shift+Tab 留在顶层；底层标记 `inert` 和辅助技术不可交互状态，恢复时还原原属性。

嵌套层关闭后优先恢复到仍连接且可交互的打开按钮；按钮已移除则聚焦父层默认控件。根关闭后回到调用入口，入口已不存在则回当前面板默认控件。延迟聚焦回调必须检查句柄仍然打开且位于栈顶。

### 3.5 必须保留的真实流程

| 场景 | 期望 |
|---|---|
| VCC 月份选择打开后被公共替换 | 月份等待以取消完成，旧 keydown 解绑；新弹窗 Escape 只影响新层 |
| VCC 保存中公共关闭/替换 | 由原 busy/`canClose` 拒绝；任务不重复提交 |
| 链接表 → 账户映射 → 加载失败告警 | 告警关闭回到映射层；完成保持禁用，绝不能 `save([])` |
| 映射成功返回合法空数组 | 正常允许有意保存空映射；“加载失败”和“加载到空表”保持区别 |
| 映射保存成功 | 映射层被结果告警替换；确认后回链接表原位置；不保留已提交映射编辑层 |
| Position 数据管理/配置的嵌套告警 | 告警关闭只关闭本层，管理层保留；取消确认 Promise 正常收尾 |
| 存档设置 → 删除预检 → 确认 | 设置父层、请求代次和保留期保存队列保持；取消只关确认，成功刷新父层，失败留在确认；父层最终关闭才清理 |
| 工具箱 → 拆分字段/行数/多文件选择 → 保存/结果告警 | 父层和本次 splitReadToken 始终存活；返回不重挂旧节点；完成只发一次 splitExport，取消不导出；告警关闭回父层 |
| 打开新窗口的工厂抛错 | 已校验仍未替换的旧栈保留；记录错误，不留半挂载窗口 |

## 4. 控制器状态与导航

每个控制器只接收本域 API、面板根节点和列明的公共 UI/配置服务，不接收完整 `desktopApi`、总 `state`、总 `elements`。控制器内部状态只由自身修改；应用壳只持有当前模块、启用顺序、窗口/外观/更新等应用信息。

所有控制器提供 `enter(context)`、`leave(context)`、`dispose()`。重复进入是幂等的：已绑定的静态事件不再绑定；订阅按控制器生命周期安装一次，最终销毁取消一次。离开只停止本域可见刷新、使旧响应失效并关闭允许关闭的本域弹窗，不自行重置 Main session、已完成任务或导出缓存。

进入时的自动刷新沿用“同步按钮和状态，但不覆盖已有成功/欢迎反馈”的既有约定；失败在本域提示。调用失败不能使导航壳读取其他域内部状态来修复。

每域维护自己的请求 generation 和活动状态。快速 A → B → A、连续刷新、换月份/切场景/重新导入时，旧结果不能覆盖新请求。后台写操作结果即使页面已离开也不能被伪造为取消：记录本域需刷新，重新进入读取 Main 事实，错误按已有业务反馈规则处理。

## 5. 场景变更与共享 session

场景编辑器负责草稿和调用窄命令服务，不直接调用 `refreshBankStatementStatus` 或 `reloadReconIdFixScenarios`。**数据变更类别 `categories` 与 Main 结果失效域 `invalidationScope` 分开**：前者用于刷新列表/选项，后者来自确定的 IPC 命令副作用映射，应用层只按后者通知结果控制器。不能把类别集合当作所有命令的缓存权限。

| 成功命令 | 既有 Main 行为 / 本次保持的结果失效范围 |
|---|---|
| create（包括复制草稿最终保存）、update、toggle-enabled | 普通四类 `extract-recon-id / offset-bill-mark / gateway-recon-join / builtin-fixed` 只清 BankStatement；`recon-id-fix / gateway-recon-id-fix` 只清 ReconID；未知类别双清。update 不允许改 category，不设计跨类别 update |
| delete | 确实删除既有记录才按该记录类别处理；`deleted:false` 不新增结果失效 |
| transfer、batch-delete、import-bundle-apply | **成功一律双清**，即使只涉及一种类别，或返回成功但变更计数为 0；沿用 Main 现有合同 |
| set-applicable-channels | 只清 BankStatement；适用渠道与优先级连续保存是两次命令，已成功的前一步不能被后一步失败抹掉 |
| channels create/update/delete；场景模板导出、导入选择/预检、普通读取；管理窗无变更关闭 | 不发结果失效成功事件；渠道变更刷新配置列表，读取/预检/关闭保持已有结果和导出反馈 |

矩阵源码依据为 [Main 单项 category 分流](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5275)、[transfer/batch-delete](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5366)、[适用渠道](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5404)、[导入 apply](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5703)。TechDoc 明确 Renderer 生成摘要的方法及完整调用方；不改变现有 IPC 名称、参数或返回结果，不收窄 Main 双清行为。

场景数字 ID **不是不可复用的实体身份**：[scenarios-repository.js:407](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/database/scenarios-repository.js:407)会在删除后复用最小空闲 ID，因此同一 ID 可以从 ReconID 类别变为普通类别。类别元数据只由命令服务维护，所有场景/渠道写入开始和结算均推进服务自己的 `metadataEpoch` 并使旧缓存失效；该 epoch 与事件去重 revision、页面渲染 generation 是三种不同事实。

成功 delete/batch-delete 清掉原实体映射；create 只在没有并发交错且结算明确时，按成功返回的 ID 和实际提交类别建立新映射；applyImport 等无法列出完整变化集合时整份元数据失效。跨过写入、在写入期间发起或来自已销毁服务的旧 list/get，即使返回成功，也不能回填命令服务。update/delete/toggle 只有在可证明读取证据对应当前实体、从取证到写结算没有另一写入交错时，才允许按类别发布确定 scope。补读失败、ID 身份不明、并发交错或传输结算不明均沿既有 resync 协议处理，不用旧类别猜 scope，不改变 §5 命令矩阵，不自动重试或额外串行化业务写入。

- `invalidationScope` 命中的控制器立即使旧结果/导出动作不可用、清除该结果对应的过期导出反馈，并读取 Main 状态；未命中的独立结果继续保留。后台或不可见控制器同样先标记失效，重新进入时再读事实。失败不广播成功变更，传输结果不确定时单独请求事实重同步。
- `recon-id-fix` 和 `gateway-recon-id-fix` 仍是 ReconID 的两种子模式。BankStatement 网关入口与 ReconID 共享 session/引擎：ReconID 结果失效也使 BankStatement **网关结果视图**同步失效，但不清其普通 bank 结果。`bank-statement` 失效域本身不表示清空独立的共享网关结果。
- “非 C4 不清 ReconID”“C4 不清普通 BankStatement”仅用于矩阵中单项 category 分流的命令，不能覆盖 transfer/batch-delete/import apply 的双清。部分成功的连续命令逐项通知；数据库已定义整批原子的 transfer/batch-delete 不虚构部分成功。
- 仅关闭管理窗时只通知列表轻量刷新，等价于 `scenariosChanged:false`，不重复广播之前已发布的成功 mutation，也不清导出反馈。

共享会话服务是对既有 Main session 的窄访问和变更通知入口，只保存轻量 revision，不复制明细和业务结果，也不替代 Main 的 subMode/category 检查。

## 6. 兼容、依赖与回退

经典 `<script>` 加载保留；新公共模块先加载，控制器工厂随后，`renderer.js` 最后装配。Preload sandbox、公开 IPC 和现有命名方法保持不变。

过渡期 `openModal/closeModal`、旧控制器函数名保留转发；禁止再直接操作 `modalRoot`。每个切片在所有生产调用者迁移且行为测试通过后移除它自己的转发，预览入口同步接入同一宿主，不另做一套生产生命周期。

G3 无需等待 G1/G2/G4/G5/G7。G8 与本分支协调激活 modalHost/控制器依赖规则；即使 G8 尚未合入，本分支也完成自身行为测试。与其他分支冲突集中在 `renderer.js`、`renderer-dialogs.js`、`index.html`，采用逐段合并，不整文件覆盖。

本分支无数据迁移。回退按完整切片回退控制器、装配、测试与转发，不在已经迁出的入口上重新恢复 `innerHTML = ''`。应用运行中不热切换宿主实现；回退版本重启后生效。

## 7. 验收清单

以下都是拟实施验收，当前没有执行记录。

| 编号 | 场景 | 必须满足 |
|---|---|---|
| G3-AC-01 | VCC + 公共关闭组合 | 节点、监听、onClose、Promise 四者一致结束，各清理一次 |
| G3-AC-02 | 重复 close/dispose、关闭回调抛错 | 无重复业务回调；全部剩余清理执行，等待正常完成，错误有记录 |
| G3-AC-03 | 忙碌关闭与 root replace | canClose 拒绝时整栈、焦点、草稿保持，后继工厂未调用 |
| G3-AC-04 | 链接表/映射/告警三层 | 关闭顶层保留底层；成功替换后的告警回到链接表，无孤儿层 |
| G3-AC-05 | 映射加载失败与合法空表 | 失败不 save；合法空表可保存；关闭后晚到加载不写 DOM |
| G3-AC-06 | Focus/Tab/Escape/遮罩 | 只有顶层交互；关闭恢复有效焦点；原禁止关闭策略保留 |
| G3-AC-07 | 全部挂载入口与经典脚本 | 生产 `modalRoot` 写入只在宿主；两份旧公共入口、VCC、Position 均接入，无加载顺序错误 |
| G3-AC-08 | 所有面板重复 enter/leave/dispose | 导航无领域分支；事件/订阅不叠加，dispose 后不渲染 |
| G3-AC-09 | 快速切换/月份/场景/重导入 | 旧响应不覆盖新状态，未完成后台操作不被误认取消 |
| G3-AC-10 | 全部场景命令与仅关闭 | 按 §5 的命令副作用矩阵失效，category 与 scope 分开；关闭不清输出；失败不广播成功 |
| G3-AC-11 | BankStatement 网关与 ReconID | 共享 Main session/引擎/导出及 subMode 校验保持；不复制会话 |
| G3-AC-12 | R3–R5 所有已迁移域 | 私有状态及 scoped API；没有全量 state/elements/API 注入与跨域面板刷新 |
| G3-AC-13 | 旧业务与预览 | 导入/运行/导出/取消/错误报告及现有预览保持；不改变输出内容和公开 IPC |
| G3-AC-14 | 工厂失败/替换失败/销毁晚到 IPC | 没有半挂载、幽灵告警、重复提交；失败与取消可区分 |
| G3-AC-15 | 两域已就绪后转移/批删/导入 apply | 普通类别和 C4 单类操作都使两侧结果、导出按钮与反馈和 Main 一致；单项 toggle/仅关闭反例保持未命中域 |
| G3-AC-16 | 适用渠道、复制、连续保存及调用方闭合 | set-applicable-channels 只失效 BankStatement，复制最终走 create，前一步成功后下一步失败仍发布前一步影响；全部写入口经同一命令服务 |
| G3-AC-17 | 存档设置/删除完整会话 | 预检及确认前均检查期限保存锁；父 handle 不销毁；token 不改写；取消/完整成功/待清理/失败正确返回或停留；迟到响应无效；最终资源释放一次 |
| G3-AC-18 | 工具箱/拆分完整会话 | splitRead→单项/行数/多文件选择→返回/保存→结果告警保持本次 token 与草稿；IPC 至多一次；Main stale 拒绝保留；父子最终清理一次 |
| G3-AC-19 | 跨类别 ID 复用与晚到 list/get | 真实仓储按最小空闲 ID 复用；C4→删除→普通类别复用同 ID 后的 update/toggle/delete 与 Main 失效域一致；早期查询晚到不能覆盖新类别；反向复用同样成立 |
| G3-AC-20 | 服务元数据 epoch、交错写与未知结算 | 写前/写后失效覆盖全部命令；补读跨写、并发写、applyImport、未知结算不产生错误确定 scope，不重试业务写；未命中域结果/导出反馈保持，现有 resync 与订阅生命周期成立 |

## 8. 完成与证据

按 R1–R5 分别记录变更、已迁移调用者、自动化结果和 GUI 结果；整体完成要求全部阶段及 G3-AC-01 至 G3-AC-20 有证据。不能只以文件数减少或截图中遮罩消失验收。

文档交付仅核对源码、文档及链接。后续正式实现完成时执行适用单测、行为集成、完整 `npm run release-check`，在隔离用户目录的 Electron 上验证键盘/焦点/嵌套层和真实导航；涉及输出的业务回归沿用已有 Windows/Excel/WPS 验收，未做项明确记录。

本次文档补充统一交付要求：每个切片均按[切片完成标准](../../README.md#slice-completion)验收，并按[实施记录与状态要求](../../README.md#slice-record)区分本稿设计 AC、实际实施进度与已取得的验证证据；本补充沿用上述业务验收条件；独立审查 R2/R3/R9 后新增的 AC-15 至 AC-20 属于设计修订要求，尚未执行。
