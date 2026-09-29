# 公共反馈弹窗实施记录

## Baseline

- 需求与验收：[spec.md](./spec.md)，r3、AC01–AC16。
- 技术方案：[techdoc.md](./techdoc.md)，公共工厂标记、局部 CSS、挂载后正文 Tab 入口。
- 用户本轮明确要求执行 `save-spec` 并在功能分支 worktree 开发。复用已保存且与 Downloads r3 哈希一致的两份文档；不另建同一任务的有效方案。
- 工作区：`/Users/pzhong/.codex/worktrees/feedback-dialog-scroll/bank-bill-excel-tool`。
- 分支：`codex/v3.2.11-common-feedback-dialog-scroll`；按用户明确要求从当前本地 `main@18b82b4328cf5e00c1b2549d373a5b2f2677215c` 创建。进入实现时没有已有源码修改，只有已保存的本任务方案和两轮审查资料。
- 保留原审查及 `review-2026-09-29-evidence/`。其 15 项结果是方案实验；新实现的测试和截图独立存入 `implementation-evidence/`。

## Decisions

| 决定 | 原因与证据 | 影响 |
| --- | --- | --- |
| 仅公共 alert／confirm 追加 `.feedback-dialog-card` | 两个公共工厂共享结构；调用与包装见 [call-inventory.md](./call-inventory.md) | 自动覆盖公共入口，独立工厂不迁移 |
| 用 `registerModal(...onMount)` 增加正文 tabindex，不主动 focus | host 初始焦点先于 onMount；真实输入／原按钮初始焦点测试通过 | 保持初始动作，正文可用 Tab、PageDown、Space 滚动 |
| 正文可收缩并独立滚动；footer 不收缩且可换行 | 真实 CSS 几何、末项与真实鼠标命中验证 | 不截断消息，不改业务参数和回调 |
| 保留局部 class 和包装 | 只发现两处追加 class、一处追加错误节点，均未覆盖公共标记或移动 footer | 不修改各业务模块源码 |
| 扩展现有生命周期 harness 的可选布局模式 | 默认老 fixture 不加载样式；新模式使用 index.html 实际 CSS 顺序、隔离文件页面和真实输入 | 新 fixture 自动进入现有 integration／release-check；退出恢复默认窗口 |
| 共用已安装依赖 | 两边 package-lock SHA-256 均为 `6360f29a82d5f4c1d1003d9e61e6a4db678f398aab5043c23c46371e2f215e65` | 仅本 worktree 的 node_modules 符号链接，不改依赖清单 |

## Assumptions

| 假设 | 验证与影响 |
| --- | --- |
| 当前宿主注册顺序是本次焦点方案的前提 | 真实生产宿主、bridge、工厂验证首次按钮／正文输入焦点、Tab 环、返回焦点、busy 和日志合并；未来宿主顺序变动由回归保护 |
| macOS 页面 zoom 与 Windows DPI 不等价 | 每份布局 JSON 实测 OS、显示器 scale、窗口／内容区、CSS 视口、DPR、zoom；Windows 另列未执行 |

## Deviations

| 原计划 | 实际 | 原因与影响 |
| --- | --- | --- |
| 文档默认模块分支从上一发布标签开始 | 按用户后续明确指令，以当前本地 main 为基线 | 显式用户要求优先；不改发布流程或合并策略 |
| 首轮夹具运行 | 29/40；修正测试后 40/40 | 测试数据 warningSamples 应为对象、模板内正则转义、未导出的删除表单应由管理入口打开；真实 Enter 需完整 keyDown／char／keyUp 序列。未因这些夹具问题更改业务源码 |

## Evidence

最终命令、输入哈希、环境矩阵和验收边界在 [implementation-evidence/README.md](./implementation-evidence/README.md) 汇总。

- 新增公共／业务真实布局 fixture：40/40 PASS。覆盖 G1–G7 的本机自动化部分。
- 完整 Renderer 生命周期：273/273 PASS（新增 40，原有 233）。
- `npm run release-check`：退出码 0。lint、架构（765/765 文件）、smoke、unit、68 个集成脚本全部通过；unit 为 9,435 通过、0 失败、4 项 Windows 专用跳过。门禁自动更新 `rules/integration-test-policy.md` 的测试清单，未手改规则。
- `git diff --check`：通过；运行后生产与测试输入哈希和验证时一致。
- 界面截图已核对正文滚动区域、footer、长列表与独立结构；截图是辅助证据，滚动与命中结论来自断言。

## Remaining Unknowns

| 未完成项 | 处理与交付影响 |
| --- | --- |
| Windows W1/W2/W3：系统缩放 100%／125%／150%，实际最小窗口 | 当前环境为 macOS，未执行；正式 Windows GUI 验收仍待完成 |
| 实体触控板与系统滚动条拖动 | 已验证 Chromium 真实 wheel／keyboard 输入和滚动条未隐藏；设备手测未执行，不外推为通过 |
| 与其他 v3.2.11 分支的集成 | 尚未合并；共享文件 `renderer-dialogs.js`、`styles-gemini-extra.css` 集成时逐块检查冲突 |
| OOS-01 | 已知独立平盘映射错误框不在范围，本次不计作修复 |

未提交、推送、开 PR、升版或发布。
