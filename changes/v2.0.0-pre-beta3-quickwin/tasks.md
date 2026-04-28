# Tasks — v2.0.0-pre-beta3-quickwin

## Task 1 — T1 主页面标题改黑
- 目标：Clear 风格下 `.gemini-gradient` 显示纯黑色
- 涉及文件：`src/styles-gemini.css`
- 操作：
  1. grep 全仓 `gemini-gradient` 使用点，确认仅 index.html:29 主标题
  2. `styles-gemini.css:122-132` 把 `.gemini-gradient` 内容替换为 `color: #000;`，删掉 `background` / `webkit-background-clip` / `webkit-text-fill-color` / `color: transparent`
- 验证：跑 `npm run preview`，肉眼确认 `docs/previews/main-page.png` 标题黑色
- 状态：todo

## Task 2 — T3 月度余额 billDate 改月末日
- 目标：`assembleMonthlyBalance` 输出的 records.billDate = `targetLastDay`
- 涉及文件：`src/main-process/monthly-balance.js`
- 操作：
  1. 行 197 `billDate: chosen.billDate` → `billDate: targetLastDay`
  2. 行 8-10 头注释更新 Q2 描述：从"用 seed 实际日期"改为"统一用月末日（v2.0.0 反转 v1.5.3 决策）"
  3. 行 191 单行注释更新：从"Q2 资金红线：billDate 用 seed 实际记录的那一天"改为"v2.0.0：billDate 统一用月末日（targetLastDay）；endBalance 仍是 chosen.endBalance"
- 验证：
  - 写一个临时 node 脚本：模拟 seeds（2026-02-15、2026-02-25 各一条），调 `assembleMonthlyBalance({ year:2026, month:2 })`，断言 `records[0].billDate === '2026-02-28'` 且 `records[0].endBalance === <2026-02-25 那条 seed 的余额>`
- 状态：todo

## Task 3 — smoke + preview 回归
- 目标：自动化不退化
- 涉及文件：无
- 操作：
  1. `npm run smoke`
  2. `npm run preview`（Clear）
  3. `npm run preview:account`
  4. 如有 General preview 命令也跑一遍
- 验证：smoke pass + preview 截图含黑色标题
- 状态：todo

## Task 4 — important-variables 入表评估
- 目标：T1+T3 的改动是否触发新增 / 升格条目
- 操作：grep 改动 diff 里的符号 vs `rules/important-variables.md`
  - T1 改 CSS，无 JS 符号 → 无影响
  - T3 改 `monthly-balance.js`，命中既有 Risk-sensitive `lastDayOfMonth` / Important-skeleton `templateRepository`（间接调用）
- 评估结论：填入 log.md
- 状态：todo

## Task 5 — 提 PR
- 目标：PR #28 提交 + Codex review 处理
- 操作：
  1. commit 一个（小改动一 PR）
  2. push origin v2.0.0
  3. `gh pr create` 含资金红线反转高亮
  4. 等 Codex 评论，按 P0/P1 处理
- 状态：todo
