---
name: check-vars
description: 扫描当前改动是否触及 rules/important-variables.md 中的重要变量；命中则输出关联功能 review 清单与 PR body 追加段。触发场景：提 PR 前 / 版本号 bump 前 / 合并到 main 或 v1.5.x 前 / 用户显式调用 /check-vars。
---

# check-vars — 重要变量变动检查

## 用途

每次会影响 `src/` 的代码变动，进入**合并阶段**前跑一次这个 skill，确认是否触及 `rules/important-variables.md` 里的关键变量。命中则：
- 在对话里列出受影响变量 + 层级 + 关联功能 review 清单
- 输出一段可粘贴到 PR body 的"⚠️ 关联功能 review"段落

**不做的事**：不跑业务测试、不改代码、不 commit。仅"扫描 + 提醒"。

## 何时主动调用

按 CLAUDE.md § 重要变量变动 check 的触发点：

1. **team-lead 提 PR 前**（memory `workflow_no_tester_no_auto_pr` 定义的节点）
2. **版本号 bump**（`package.json.version` 改动）时
3. **合并到 `main` / `v1.5.x`** 前
4. 用户显式输入 `/check-vars`

除此之外，agent 在做 `Edit` / `Write` 修改 `src/` 时应当**主动在结尾对照本表自查**（不强制调用本 skill，但要参考清单）。

## 执行流程

### Step 1 — 确定改动范围

优先级（由高到低）：

1. 用户显式指定基准：`/check-vars --since <ref>`（例如 `--since main`）
2. 当前分支有与目标分支 diff：`git diff <target>...HEAD -- 'src/**/*.js'`
   - v1.5.x fix → 对 `main`
   - v2.0.0 开发 → 对 `v2.0.0` 上游
3. 无 target：`git status --short` + `git diff HEAD -- 'src/**/*.js'`（未提交 + 已提交的本地改动）

用这一步拿到**改动的 .js 文件列表**和**改动的 diff 文本**。

### Step 2 — 读清单

读 `rules/important-variables.md`，按层级（二级标题 `## 1. Critical` / `## 2. Important-skeleton` / `## 3. Runtime-state` / `## 4. Risk-sensitive` / `## 5. Minor`）分别提取所有反引号包起来的变量名（`inline code`）。

注意：Minor 层不强制 review，但要在最终报告里以"知会"形式列出命中。

### Step 3 — 扫命中

对 Step 1 拿到的每个改动文件，用 Grep（或 `git grep` / ripgrep）搜每个变量名，判定"命中" = 该文件 diff 行里出现了该变量名。

**仅比对 diff 行**（`git diff --unified=0` 或解析 `+`/`-` 行前缀），不扫未变更的上下文——否则噪音太大。

若改动文件本身就在 `rules/important-variables.md` 的"定义位置"字段里，也算命中（说明动了定义本身）。

### Step 4 — 输出报告

按"命中层级由高到低"排序。格式：

```
## check-vars 报告

### Critical 命中 N 处
- `变量名1` @ `src/xxx.js:line_hint` — [关联功能] — review 建议：...
- ...

### Important-skeleton 命中 N 处
- ...

### Runtime-state 命中 N 处
- ...

### Risk-sensitive 命中 N 处
- ...

### Minor 知会 N 处
- ...

### 建议补跑
- npm run smoke
- （按命中层级列出必须手工验证的场景）
```

每条命中**必须引用** `rules/important-variables.md` 里该条目的"变更 review 要点"——不要自己造 review 清单，直接复用表里的即可。

### Step 5 — PR body 片段

在报告末尾输出一段可直接粘贴到 PR body 的 Markdown：

```markdown
## ⚠️ 关联功能 review（check-vars 自动生成）

本次改动触及以下重要变量，请针对性验证：

- **Critical**: `var1`, `var2`
  - review: （引用 rules/important-variables.md 对应条目）
- **Risk-sensitive**: `var3`
  - review: （引用 rules/important-variables.md 对应条目）

**必跑**：
- [ ] `npm run smoke`
- [ ] （按命中层级补其他验证项）
```

若无任何命中，输出：`check-vars 未命中任何 Critical / Important / Runtime-state / Risk-sensitive 变量，无需关联功能 review。` 然后结束。

## 参数

- `--since <ref>` — 指定 diff 基准（默认按分支推断）
- `--include-minor` — 输出时把 Minor 层也纳入（默认仅知会）
- `--no-pr` — 不输出 PR body 片段

## 产物去向

- 对话里打印完整报告（供用户阅读）
- PR body 片段由用户手动粘贴（skill 不 commit 不 push）
- 如发现**新的**跨 ≥ 3 文件变量（参考 `docs/analysis/var-reference-stats.md` 的 A-share 段），在报告末尾追加"升格候选"段，提醒人工评估是否加入本表

## 依赖

- `rules/important-variables.md` — 主清单
- `docs/analysis/var-reference-stats.md` — 自动统计（升格候选数据源）
- `scripts/scan-vars.js` — 若自动报告缺失，建议先跑 `npm run scan:vars` 再执行本 skill

## 失败处理

- 若 `rules/important-variables.md` 不存在：中止，提示"请先落表再调用 check-vars"
- 若 git 不可用 / 非 git 仓库：中止，提示用 `--since` 手动指定范围
- 若 diff 为空（没改动）：直接输出"无改动，跳过 check"并结束
