# 公共反馈弹窗滚动方案复审（文档 r3）

日期：2026-09-29。本轮是对修订后 Spec / TechDoc 的第二次审查，不是实现审查或功能验收。

## 1. 结论

**文档复审通过。上一轮 OBS-01、OBS-02 两项定稿建议均已落实，可以关闭；本轮未发现新的阻塞性设计问题或需修改的明确缺陷。r3 可以作为该功能的实施依据。**

修复边界仍是 `createAlertDialog()` / `createConfirmDialog()` 两个公共工厂。原始前置资金问题仍是首要业务验收场景，公共正文滚动、操作区保护、首次焦点和日志兼容方案没有改变。

文档通过只表示方案及验收定义达到本轮审查要求。OOS-01 的平盘自建报错框仍是明确排除的已知问题；生产实现、全量调用清单、真实输入、Windows 与正式交付门禁仍待完成。

## 2. 本轮输入与工作区

| 项目 | 核对结果 |
| --- | --- |
| Spec | [r3 Spec](/Users/pzhong/Downloads/v3.2.11-common-feedback-dialog-scroll-spec.md)，191 行 |
| TechDoc | [r3 TechDoc](/Users/pzhong/Downloads/v3.2.11-common-feedback-dialog-scroll-techdoc.md)，417 行 |
| 上轮审查 | [review-2026-09-29.md](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.11/codex/v3.2.11-common-feedback-dialog-scroll/review-2026-09-29.md) |
| 工作目录 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool` |
| 当前分支 / HEAD | `main@18b82b4328cf5e00c1b2549d373a5b2f2677215c`，与上一轮及文档分析基线一致 |
| 工作区状态 | 已跟踪文件无改动；既存未跟踪审查、架构、归档和输出资料保留，不纳入本次范围 |
| 对照方式 | 完整阅读 r3，对照本对话保留的 r2 内容、上轮审查和原始实验记录；不将其描述为两份冻结附件的字节级 diff |
| 本轮执行边界 | 仅文档审查和只读取证；附件中的实施、迁移、提交、分支操作仍是被评审内容 |

本轮附件 SHA-256：

```text
Spec    02b03ef644201931c8199e8f0c694669e8add7504ed245d551ae2dffb4e7a6e5
TechDoc e477ba018e358157be45766aabdc623b107ca609a7a1287dcc4cd3f0b44e6373
```

## 3. 上轮意见关闭核对

| 审查项 | r3 的处理 | 结论 |
| --- | --- | --- |
| OBS-01：平盘账户映射保存失败未通过公共工厂，需明确剩余风险 | Spec §2.2 定义 OOS-01；AC10 / AC16 和 TechDoc §3.2 / G5 / §7.4 同步记录，不计为已修复，不自动扩大公共修复范围 | 已关闭 |
| OBS-02：测试矩阵应列出真实最小窗口配置 | Spec AC05 与 TechDoc G7 / §4.3 / §4.5 / T5 写明 `minWidth: 1080`、`minHeight: 760`、`frame: false`，要求按实际内容区验收 | 已关闭 |

OBS-01 的位置见 [Spec:51](/Users/pzhong/Downloads/v3.2.11-common-feedback-dialog-scroll-spec.md:51)、[Spec AC10:139](/Users/pzhong/Downloads/v3.2.11-common-feedback-dialog-scroll-spec.md:139)、[TechDoc:107](/Users/pzhong/Downloads/v3.2.11-common-feedback-dialog-scroll-techdoc.md:107)。当前源码仍在 [showNestedAlert()](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-position-reconciliation.js:1275) 独立构造 DOM，保存抛错及非 `ok` 结果仍调用它，范围说明与事实一致。

OBS-02 的位置见 [Spec AC05:134](/Users/pzhong/Downloads/v3.2.11-common-feedback-dialog-scroll-spec.md:134)、[TechDoc §4.5:278](/Users/pzhong/Downloads/v3.2.11-common-feedback-dialog-scroll-techdoc.md:278)。[生产窗口配置](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:4335) 与所列数值一致；[截图参数处理](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:4349) 确实将输入尺寸钳到 1080 / 760，新增压力视口说明也有源码依据。

这里的“关闭”指文档建议已完成，不表示 OOS-01 的产品缺陷已修复或 Windows 验收已通过。

## 4. 新增说明的一致性

1. **负向回归定义正确。** Spec §2.2、AC10 和 TechDoc §3.2 明确要求独立结构不被误命中、不产生新增退化；没有把“旧缺陷必须继续存在”写成通过条件。范围外已知问题与回归要求没有冲突。
2. **正式窗口与压力用例已经分开。** W1–W3 分别覆盖 Windows 100% / 125% / 150% 系统缩放下的生产最小窗口，Z1 是页面 zoom 压力，P1 是独立 CSS 视口压力；不把配置值、CSS 视口和截图像素当成同一尺寸。
3. **测试接入约束与源码一致。** TechDoc §4.3 指出现有 harness 的 `1080×800` 默认窗口不带生产 `frame: false` / 最小尺寸配置，这与 [electron-main.cjs:21](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/scripts/renderer-lifecycle/electron-main.cjs:21) 一致。不能直接把旧 fixture 运行称为生产最小窗口验收。
4. **实验与正式验收的界限保留完整。** RV1 与 TechDoc §4.6 / §7.4 将 15 个受控案例归于此前的方案实验，没有当成本轮新执行，也没有扩大成完整业务链、真实鼠标或 Windows 的 PASS。
5. **核心技术与业务范围保持一致。** 公共 helper、CSS、焦点接入、业务回调、旧局部 class 兼容和回滚边界与上一轮所审方案一致；没有新生产依赖、IPC、数据迁移或删除语义变化。AC01–AC16 完整且无重复，T1–T6 仍为待实施。
6. **保留已有审查材料的要求正确。** Spec §8 和 TechDoc §7.3 明确只合并本任务 Spec / TechDoc，保留既有审查文档与证据，避免整目录替换清掉原件。

## 5. 本轮证据核对与复用

本轮已实际读取此前的 [probe-result.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.11/codex/v3.2.11-common-feedback-dialog-scroll/review-2026-09-29-evidence/probe-result.json)：基线为相同 SHA，平台 `darwin`，Electron `36.9.5`，包含 15 个受控案例；平盘独立入口的按钮可见性结果为 `false`，与 r3 引用的审查结论相符。

r3 中“文档修订者当时未取得审查原件”的表述属于其取证范围说明。本轮原件在当前工作区可访问，现已完成关联核对，不把该历史说明当作文档缺陷，也不需要重造实验数据或补传原件。

另外，重新计算并对照上一轮保存于本对话的 SHA-256，以下 5 个关键源码文件全部一致：

```text
src/renderer-dialogs.js
src/styles-gemini-extra.css
src/renderer/modal-host.js
src/renderer/modal-bridge.js
src/renderer-position-reconciliation.js
```

本轮执行了工作区 / HEAD / 附件哈希检查、上述源码哈希对照、原始 JSON 核对、AC 编号检查，以及最小窗口、截图尺寸钳制、隔离 harness 与平盘失败调用链的定点阅读。

**没有重跑 Electron 实验。** 本次修订集中于已知范围外风险、验收矩阵和证据说明，核心方案与关键源码未改变，没有新增需要复现的矛盾。15 例属于上一轮结果的核对复用，不是本轮新测试。

未执行生产实现、完整调用清单、真实鼠标 / 滚轮 / 键盘原生滚动、全部返回链、Windows W1–W3、lint / 单测 / 集成 / release-check。它们属于实施和正式交付阶段，不因本轮文档复审而被标记完成。

## 6. 交付状态

本轮只新增本复审文档。用户提供的 r3 附件、上一轮审查及 JSON、生产源码和既有测试均未修改。没有创建或切换功能分支，没有移动 Spec / TechDoc，没有提交、推送、开 PR、升版或发布。

本次没有提出新的必改项，保留 r3 作为当前方案；实施时按既定 T1–T6 与 AC01–AC16 执行即可。
