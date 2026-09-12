# v3.2.9 业务 OP 自动错误报告实施记录

## Baseline

- 分支：`codex/v3.2.9-biz-op-error-report-auto-save`。
- 基线：`v3.2.8^{commit}` = `2ba9ef14fe972363b604955636cff0c9ac53700f`。
- 工作区：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool-v329-biz-op-auto-report`；主工作区未切换、未暂存或清理用户已有改动。
- 需求：[Spec](Spec-v3.2.9-biz-op-error-report-auto-save.md)；技术方案：[TechDoc](TechDoc-v3.2.9-biz-op-error-report-auto-save.md)。
- 输入：Downloads/v3.2.9-biz-op-spec-techdoc 的 1.1 文档。Spec SHA-256 `ec2b2bfa707493456873e3af78d79f8a349b462ca6e6540d7f8b17039d83a6dc`；TechDoc SHA-256 `f39b5edcc72cad6db8faee2ebfea05b373eb9f784dfa2bdf42190e3c51d7e9b8`。

## Decisions

- 按 save-spec 将文档与记录放在 `changes/v3.2.9/codex/v3.2.9-biz-op-error-report-auto-save/`，保留输入文件名。Downloads 作为原始交付材料，迭代维护以本目录为准。
- 独立 worktree 最初在临时目录创建；交付前迁移至项目旁固定目录，避免未提交实现仅存放于系统临时目录。在该 worktree 实现与验证，使用已有 node_modules；不混入主工作区的历史文档整理和其他模块变更。
- 请求缓存命中前保留可信 sender/frame/输入和摘要校验；仅新请求执行业务就绪门禁。自动报告属于原 import promise，不重放业务写入。
- 导入 IPC 整段编排持有业务操作登记，覆盖导入与报告两个 Task 之间的恢复阶段。退出 transition 仍可阻止尚未开始的新导出；已有工作完成后释放登记，再允许关闭 runtime。
- 验收使用 tmp 输入与 tmp DB；不访问真实业务数据，不改变金额/币种/匹配/导入规则、schema、mode 路由、版本号。

## Evidence

- 已验证本地标签与 HEAD 均为基线提交；已创建指定分支，原工作区仍位于 main。
- 文档已复制并校验输入摘要；实现已落地。当前真实集成 12/12、服务单测 46/46、真实 IPC 13/13、页面 VM 与 Electron DOM 各 8/8 通过；最终全仓门禁 exit 0，单测 7,349 通过 / 0 失败 / 3 个既有 Windows 专用跳过，54 个集成脚本通过，汇总 2,500/2,500。
- 独立 review 发现并修复两个 P2：Main 后处理异常不应导出内部空诊断；保存失败须提供固定、有界且可行动的原因。已补真实空诊断回归和零样本截断对照。
- IPC/主装配独立审查未发现新增缺陷；两个共享 registry 的真实退出时点已纳入集成。
- 验证详情及平台边界见 [verification.md](verification.md)。

## Remaining unknowns

- 已消解：真实 IPC 自动保存、异常后封存诊断、发布后恢复与报告目标校验。
- 已消解：隔离页面的按钮、普通取消、busy、焦点与报告反馈。
- 已完成：最终源码的 release-check、迁移后/门禁后 14 文件内容摘要复核；见 verification.md。
- 尚未执行：Windows Excel/WPS 人工验收；本机验证不能代替该项。
