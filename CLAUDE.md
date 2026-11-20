@AGENTS.md
@CODEX.md

<!-- 项目事实、边界、命令与发布流程的唯一正文在 AGENTS.md，条件化工作流在 CODEX.md，两者均已导入；本文件只放 Claude Code 专属适配，不复制其正文。 -->

## Claude Code 适配

- **工作流**：上方导入的 `CODEX.md` 同样适用于 Claude Code，只执行任务命中的章节；「按需读取」表中对 `CODEX.md` 的读取已由导入完成。
- **Skill 位置**：在用 Skill 的唯一正文在 `.agents/skills/`，`.claude/skills/` 下同名条目是指向它们的符号链接；修改时编辑原文。正文中的 `$skill-name` 即同名 Skill，`agents/openai.yaml` 是 Codex 元数据。
- **Skill 触发**：以 `CODEX.md`「协作与 Skill」为准，description 中更宽的适用范围不单独构成触发。
- **署名**：规则见 `AGENTS.md`「约定与分支」；Claude Code 的提交与 PR 署名已由 `.claude/settings.json` 关闭。

## Compact Instructions

压缩摘要用简体中文，按以下优先级保留，篇幅不够时从后往前删：
1. 用户原话中的目标、约束和授权边界（是否允许提交/推送/开 PR/升版），以及尚未回答的问题。
2. 当前分支与版本线；本次改动的文件清单（每个一句话说明改了什么），并区分开工前已存在、不属于本次的改动。压缩时若附有仓库状态，以其为准核对。
3. 已做的决策、假设、偏离及依据（spec/techdoc 路径，如 `changes/<版本>/<分支>/`）。
4. 验证证据：执行过的命令与 PASS/FAIL；失败时保留用例名和关键报错原文；集成测试是否回写了 `rules/integration-test-policy.md`。
5. 对账/资金红线发现、待人工复核项、需登记 `knowledge/backlog.md` 的遗留项。
6. 剩余步骤（按顺序）和下一步要做的第一件事。

不要保留：文件正文、完整日志、已解决问题的排查过程；只记路径和行号，压缩后按需重读。
