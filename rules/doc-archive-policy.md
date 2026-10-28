# 文档归档约定（spec / TechDoc / 发布记录）

> 2026-06-07 新增（起因：v2.1.12~v2.1.16 出现 PRD 命名/归档漂移）。2026-10-18 按现行做法修订：v3.1.9 起需求、设计与发布记录只放 `changes/<版本>/`，`docs/iterations/`、`docs/prs/` 停止新增，转为只读历史归档；原约定见 §3。

## 1. 现行位置

| 文档 | 位置 | 规则正文 |
|------|------|------|
| spec / TechDoc | 单分支版本 `changes/<版本>/`；多分支版本 `changes/<版本>/<分支名>/` | `save-spec` Skill |
| 实施记录、审查与修复、验证证据 | 随所属版本或分支放在 `changes/<版本>/` 下 | `implementation-notes` Skill（实施记录） |
| 本轮发布与集成记录 | `changes/<版本>/release.md`，或复用已有 PR / Release 记录 | `weekly-release` Skill |
| 遗留项：未做、待核验、已知问题、顺延 | `knowledge/backlog.md`（当轮记录只引用编号） | 该文件「维护约定」 |
| PR 说明 | GitHub PR 正文：范围、顺延项、依赖、验证与人工检查结果 | `weekly-release` 清单 D2 |
| 发布文档 | `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md` | `AGENTS.md`「约定与分支」 |
| 文档范本 | `changes/templates/`、`docs/templates/` | `save-spec` Skill |

- 本文件只做索引；存放、复用与补齐细则以上表的规则正文为准。
- 不再要求每个版本补 `PRD-<版本>.md`，也不再要求在 `docs/prs/` 留编号连续的 PR 归档。

## 2. 历史归档（只读）

| 目录 | 覆盖范围 | 说明 |
|------|------|------|
| `docs/iterations/<版本>/` | v3.1.8 及以前 | PRD、TECH_DESIGN、manual-test-checklist 等；不再新建版本目录 |
| `docs/prs/` | 截至 PR #124（v3.1.8） | PR 草稿与归档；之后以 GitHub PR 为准，不事后补建 |

历史文件中的命名、必备文件和编号要求只约束当时的版本；引用时以现行规则为准，不为补齐历史改写已发布内容。

## 3. 原约定（2026-06-07 版，v3.1.9 起停用）

保留要点供追溯：

- PRD 命名 `PRD-<版本>.md`（同版本子 PRD 加后缀），归档到 `docs/iterations/<版本>/`；每个版本目录须有 PRD，Gradual Spec 版本放索引 PRD；`changes/<change>/PRD.md` 为草稿，收敛后复制归档。
- `docs/iterations/<版本>/` 建议含 `PRD-<版本>.md`（必备）、`spec.md` / `backlog.md` / `tasks.md`、`TECH_DESIGN.md`、`manual-test-checklist.md`。
- PR 草稿建于 `docs/prs/待merge-PR #N.md`，提成 PR 后重命名为 `PR<N>-v<版本>.md`；每个已合并 PR 留编号连续的归档，事后补建须在文件头标注「事后补建 + 来源」。

历史归档自检（仅适用 `docs/iterations/`）：

```bash
for d in docs/iterations/*/; do
  ls "$d"PRD*.md >/dev/null 2>&1 || echo "❌ $(basename "$d") 缺 PRD"
done
```

### 已知漂移记录

| 版本 / 对象 | 漂移 | 处理（2026-06-07）|
|------|------|------|
| v2.1.12 / v2.1.15 | 用 `backlog.md` / `spec.md` 承载规格，无 `PRD-<版本>.md` | 补索引 PRD |
| v2.1.13 / v2.1.14 | PRD 停在 `changes/`，未归档到 `docs/iterations/` | 复制归档（含 TASKS/TECH_DESIGN）|
| v2.1.16-beta.1 | 在研，无 iterations 目录 | 补在研索引 PRD（指向 PR #61）|
| PR #58（v2.1.13）| `docs/prs/` 缺草稿文件，编号断层（PR57→PR59）| 事后补建 `PR58-v2.1.13.md` |
