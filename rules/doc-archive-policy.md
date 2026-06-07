# 文档归档约定（PRD / PR / iterations）

> 2026-06-07 新增。起因：v2.1.12~v2.1.16 出现 PRD 命名/归档漂移（详见文末「已知漂移记录」），统一约定避免再分叉。

## 1. PRD 命名与归档位置

- **标准命名**：`PRD-<版本>.md`（如 `PRD-v2.1.15.md`）；同版本子 PRD 加后缀（如 `PRD-v2.1.13-FONTS.md`）。
- **归档位置**：`docs/iterations/<版本>/`。
- **每个版本目录必须有 `PRD-<版本>.md`**。若版本体量大、改用 Gradual Spec（`backlog.md` + `spec-*.md`）承载需求规格，仍须放一份 `PRD-<版本>.md` **索引/导读**（汇总范围 + 指向各源文档），不重复正文。
- 工作目录 `changes/<change>/PRD.md` 是草稿态；版本收敛后**复制（非移动）**到 `docs/iterations/<版本>/PRD-<版本>.md`，`changes/` 原件保留。

## 2. iterations 目录标准构成

`docs/iterations/<版本>/` 建议包含：

| 文件 | 说明 | 必备 |
|------|------|------|
| `PRD-<版本>.md` | 需求规格 / 索引 | ✅ |
| `spec.md` / `backlog.md` / `tasks.md` | Gradual Spec 流程产物 | 按需 |
| `TECH_DESIGN.md` | PRD+TechDoc 流程产物 | 按需 |
| `manual-test-checklist.md` | 手动测试清单 | 按需 |

## 3. PR 草稿 / 归档

- PR 草稿建于 `docs/prs/待merge-PR #N.md`，提成 PR 后重命名为 `PR<N>-v<版本>.md`（参见 memory `workflow_archive_pr_draft`）。
- **每个已合并 PR 都应在 `docs/prs/` 留归档文件，编号连续**。事后补建的归档须在文件头标注「事后补建 + 来源」。

## 4. 自检命令

```bash
# 核对每个 iterations 版本目录是否都有 PRD-<版本>.md
for d in docs/iterations/*/; do
  ls "$d"PRD*.md >/dev/null 2>&1 || echo "❌ $(basename "$d") 缺 PRD"
done
```

## 5. 已知漂移记录

| 版本 / 对象 | 漂移 | 处理（2026-06-07）|
|------|------|------|
| v2.1.12 / v2.1.15 | 用 `backlog.md` / `spec.md` 承载规格，无 `PRD-<版本>.md` | 补索引 PRD |
| v2.1.13 / v2.1.14 | PRD 停在 `changes/`，未归档到 `docs/iterations/` | 复制归档（含 TASKS/TECH_DESIGN）|
| v2.1.16-beta.1 | 在研，无 iterations 目录 | 补在研索引 PRD（指向 PR #61）|
| PR #58（v2.1.13）| `docs/prs/` 缺草稿文件，编号断层（PR57→PR59）| 事后补建 `PR58-v2.1.13.md` |
