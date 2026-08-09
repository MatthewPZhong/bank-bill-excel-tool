# bank-bill-excel-tool 3.1.8 PRD 索引

> 目标版本：`3.1.8`
> 状态：已正式发布（2026-08-09）
> 锁定规格：[`changes/3.1.8/spec.md`](../../../changes/3.1.8/spec.md)
> 实施记录：[`changes/3.1.8/implementation-notes.md`](../../../changes/3.1.8/implementation-notes.md)
> 发布预检：[`changes/3.1.8/preflight.md`](../../../changes/3.1.8/preflight.md)
> 归档日期：2026-08-09

## 1. 版本目标

v3.1.8 在不改写 VCC 原始导入事实和基础计算血缘的前提下，补齐跨月解归档、首月期初管理、可审计人工调整、运行前完整性检查、正式结果模板与按月导出，并修正系统财务 OP 精度及 Pending 46 列契约。完整业务、数据库、IPC、Renderer、Excel 和错误码设计以锁定规格为唯一正文。

## 2. 范围

- 数据管理增加受保护的解归档，只允许从最新月份向前处理依赖。
- 固定首月期初的隐藏、删除与重建规则，不允许用新期初绕过上月归档。
- 结果页支持不可变增量调整账本，并以基础值加调整值得到生效结果。
- 运行前双层检查五类数据集、上月归档或首月期初，缺失时失败关闭。
- 按正式结果模板的语义锚点、样式和颜色生成 Excel，并支持历史已归档月份导出。
- 固定系统财务 OP 显示值精度及 Pending 46 列正式模板，保留历史 48 列数据的可解释迁移路径。

## 3. 非目标

- 不改变 VCC 充值清退、费用换汇、通道和 Pending 的方向、分组或业务键。
- 不把人工调整回写为原始导入数据，不通过自动修复改写资金事实。
- 不修改 VCC 财务 OP 以外的资金匹配、回填、幂等键或对账方向。
- 不用 CI、合成预览或固定样本代替 Windows 实机及财务人工签字。

## 4. 验收索引

- 单元、数据库、Excel、Renderer 与发布门禁：锁定规格 [第 11 章「测试计划」](../../../changes/3.1.8/spec.md#11-测试计划)。
- 需求到自动化及人工验收的映射：锁定规格 [第 12 章「验收矩阵」](../../../changes/3.1.8/spec.md#12-验收矩阵)。
- 完成定义：锁定规格 [第 15 章「Definition of Done」](../../../changes/3.1.8/spec.md#15-definition-of-done)。

## 5. 人工发布门禁（6/6 已通过）

v3.1.8 已合入 `main`，主干 fresh Windows release-check、x64 构建和包内分发守卫均已通过。用户于 2026-08-09 明确确认以下六项均已实际完成，授权记录为通过并继续正式发布；详细授权记录见 [preflight「人工发布门禁确认」](../../../changes/3.1.8/preflight.md#人工发布门禁确认2026-08-09)：

1. 在目标 Windows 机器实际安装/运行 x64 installer 和 portable，并从两种安装形态读取两份 VCC 模板。
2. Windows Excel/WPS 下的字体、颜色、动态行、长文本换行、M/N 列和打印区。
3. 受保护解归档/删除任务写入期间的关窗安全收口。
4. 生产数据库副本的只读扫描，异常只阻断并由人工处理。
5. 财务人员按真实月份、主体和九币种逐项核对并记录签字结论。
6. 真实约 700 万行、多 sheet 工具箱极限文件的压力验证。

上述人工门禁现为 6/6 PASS，且通过结论来自用户明确签字，不由自动化 PASS 或 Windows CI 构建代替。永久授权记录见 [PR #130 评论](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/130#issuecomment-5231526107)。

## 6. 正式发布结果

- 发布准备 PR #130 以普通 merge commit `688ae2cb4a85d2fe8d74bdbefb06c6e3056ddcfa` 合入 `main`，发布分支未删除。
- annotated tag `v3.1.8` 的 tag object 为 `eabe485a0393abac09a202420d7a92b4d2d28726`，peeled commit 与发布时 `main` 均为 `688ae2cb4a85d2fe8d74bdbefb06c6e3056ddcfa`。
- [Release workflow run 31314412353](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/31314412353) / job `93247225343` 从首个 job step `2026-08-09T12:53:34Z` 至 complete-job step `2026-08-09T13:24:20Z` 成功完成。release-check 为 unit `4801/4802`（1 个 expected skip）、integration `48/48` 脚本且 `2459/2459` 可计数断言、smoke PASS、main panel `6/6`；大文件链 `50/50`（475269ms），拆分链 `31/31`（401655ms）。
- [GitHub Release v3.1.8](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.8)（Release ID `367485098`）于 `2026-08-09T13:24:16Z` 发布为 latest、non-draft、non-prerelease。

| 公开资产 | Asset ID | 大小（bytes） | SHA-256 |
| --- | ---: | ---: | --- |
| `bank-bill-excel-tool-portable-3.1.8.exe` | `507535165` | 99,686,916 | `3fe4572b519428a7b749a860130287ada6450fd631f039f258240671ab4c79ab` |
| `bank-bill-excel-tool-setup-3.1.8.exe` | `507535166` | 100,183,781 | `f2348f6f14d039113568e25b7770eff049ce6fc2af2e246d7261a6c6969351a9` |
| `bank-bill-excel-tool-setup-3.1.8.exe.blockmap` | `507535163` | 105,382 | `c57e6723010de00c5af235c8f5a6ff1646be7d6729d0590f15a8c4458e4b5c91` |
| `latest.yml` | `507535164` | 369 | `9ffb50d6cdca2bb49ad06ecfce9c160fafe80ca4cea009e1e0e20e62ac92c1ba` |

四项资产从公开下载地址独立回读后，实际大小和 SHA-256 与 GitHub 元数据一致，且 Release 的自定义资产集合恰好为以上四项。`latest.yml` 的 version/path/size 为 `3.1.8` / `bank-bill-excel-tool-setup-3.1.8.exe` / `100183781`，顶层与 `files[0]` 的 SHA-512 均为 `8x/2kU12ea1qpsTlOve2TH9kbL9ObSR6i5jkhv/viYWaQcOPVucD8di4uoEeTKtA/apHeMuBrbLLtfkFzKUGRw==`，与 Setup 实际字节一致。

Setup 和 portable 外层均为 `MZ`；NSIS/self-extractor 外层 PE Machine 为 `0x14c`，这是启动包装器事实，不代表包内应用为 32 位。两种资产提取出的 `清结算小助手.exe` 均为 202,799,104 bytes、SHA-256 `7c01f36352e98815fe902add3a17608278c316f2fc6b8cc460f3645db5d73e0d`、PE Machine `0x8664`（x86-64）。冻结 `changes/3.1.8/spec.md` 继续作为业务合同；正式发布状态以本 PRD 和发布证据文档为准。
