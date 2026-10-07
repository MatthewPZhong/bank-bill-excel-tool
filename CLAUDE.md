@AGENTS.md
@CODEX.md

<!-- 项目事实、边界、命令与发布流程的唯一正文在 AGENTS.md，条件化工作流在 CODEX.md，两者均已导入；本文件只放 Claude Code 专属适配，不复制其正文。 -->

## Claude Code 适配

- **工作流**：上方导入的 `CODEX.md` 同样适用于 Claude Code，只执行任务命中的章节；「按需读取」表中对 `CODEX.md` 的读取已由导入完成。
- **Skill 位置**：在用 Skill 的唯一正文在 `.agents/skills/`，`.claude/skills/` 下同名条目是指向它们的符号链接；修改时编辑原文。正文中的 `$skill-name` 即同名 Skill，`agents/openai.yaml` 是 Codex 元数据。
- **Skill 触发**：以 `CODEX.md`「协作与 Skill」为准，description 中更宽的适用范围不单独构成触发。
- **已移除**：check-vars Skill（旧固定扫描/分级汇报流程）与 PM/Dev 角色；用户明确要求时仍可运行 `npm run check:vars` / `npm run scan:vars`。历史文档里“CLAUDE.md 规则 N / 硬节点 / Key Business Rules / Branch Structure”等引用指迁移前旧版，以现行 AGENTS/CODEX 与当前代码为准。
- **署名**：规则见 `AGENTS.md`「约定与分支」；Claude Code 的提交与 PR 署名已由 `.claude/settings.json` 关闭。
