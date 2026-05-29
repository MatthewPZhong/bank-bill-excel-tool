# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

网银账单生成小助手 — Electron desktop app for Chinese bank statement processing. Imports Excel/CSV bank statements, maps columns via configurable templates, and exports standardized detail & balance Excel files.

Tech stack: Electron 36 + vanilla JS (no frontend framework) + SQLite (`node:sqlite` DatabaseSync) + SheetJS (XLSX).

> v2.1.1 起移除 PDF 导入支持（破坏性变更），同时卸下 pdfjs-dist + tesseract.js OCR 依赖与 `src/backend/file-service/pdf-worker.js` 子进程。

## Commands

```bash
npm start                    # Launch Electron app (dev mode)
npm run smoke                # Smoke/integration tests (scripts/smoke-test.js)
npm run dist:win             # Build Windows installer + portable exe
npm run dist:win:portable    # Portable exe only
npm run dist:win:setup       # NSIS installer only
npm run preview              # Render main UI screenshot
npm run preview:account      # Render account mapping UI screenshot
npm run startup:measure      # Startup performance profiling
```

Automated tests are three layers, chained by `npm run release-check` (the PASS/FAIL source of truth): `npm run test:unit` (`node:test` specs under `tests/unit/`, via `scripts/run-unit-tests.js` — prints `N/N PASS` and writes a timestamped log to `logs/unit-tests/`), `npm run test:integration` (`scripts/integration/*.js` end-to-end contract scripts, auto-discovered by `scripts/integration-runner.js`), and `npm run smoke` (`scripts/smoke-test.js`, integration-level — creates temp dirs and test workbooks). Add `--coverage` via `npm run test:unit:coverage`.

## Architecture

```
Renderer (index.html + renderer.js + renderer-dialogs.js)
    │  ipcRenderer.invoke()
    ▼
Preload (src/preload.js) — exposes window.desktopApi
    │
    ▼
Main Process (src/main.js) — ipcMain.handle() handlers + orchestration
    │
    ├── src/backend/database.js        — AppDatabase facade over SQLite
    │   └── database/                  — migrations, repositories, utils
    ├── src/backend/file-service.js    — file I/O facade
    │   └── file-service/              — readers, writers, normalizers, common
    ├── src/main-process/              — statement-session, statement-generation
    └── src/backend/*-store.js         — balance seeds, adjustments, account order/mode
```

**Key files by size/importance:**
- `src/main.js` (~7500 lines) — all IPC handlers, business logic orchestration, global session state
- `src/renderer-dialogs.js` (~5000 lines) — all modal dialog factories (mapping, import, account selection)
- `src/renderer.js` (~3500 lines) — renderer state management, DOM event binding, UI updates

### Data Flow

1. **Import**: User selects files → `readers.js` extracts headers & rows → column mapping via stored template → `normalizers.js` cleans dates/amounts/currency → rows held in-memory session
2. **Big Account Selection**: Distinct MerchantId+Currency combos presented → user picks → stored in `lastFileImportContext`
3. **Export**: Prepared rows → amount splitting/bill merge logic → `writers.js` generates Excel → saved to `Documents/网银账单生成小助手/exports/{date}/`

### State Management

- **Main process**: Global variables (`lastGeneratedExports`, `statementImportSessions`, `lastFileImportContext`) — not persisted across restarts
- **Renderer**: Single global `state` object + `elements` DOM cache
- **SQLite**: Templates, mappings, settings (persistent)
- **File system**: Exports, error reports, balance seeds, logs

## Key Business Rules

- **Amount mapping modes** (mutually exclusive — 4-way): direct Credit/Debit mapping, signed-amount splitting, field-conditional splitting (`按字段区分发生额`), bill split/merge (`账单拆分合并`)
- **Balance calculation**: direct column, calculated from amounts (`通过发生额计算`), or user-prompted seed
- **Currency**: Normalized via built-in `assets/币种映射表.xlsx`; mixed-currency imports produce per-currency balance sheets in one file
- **Row filtering**: Rows with both Credit and Debit = 0/empty are silently skipped; rows with both non-zero abort export with error report
- **Template bundles**: JSON export/import with `bundleVersion` (current: v3); v2 auto-upgraded, v4+ rejected

## File Storage Locations

| Data | Path |
|------|------|
| SQLite DB | `{userData}/tool-data.sqlite` |
| Exports | `Documents/网银账单生成小助手/exports/{date}/` |
| Error reports | `Documents/网银账单生成小助手/error-reports/{date}/` |
| Activity log | `Documents/网银账单生成小助手/app_activity_log.txt` |
| Balance seeds | `Documents/网银账单生成小助手/balance-seeds/` |
| Template library | `Documents/网银账单生成小助手/templates/template-library.json` |

## Branch Structure

| Branch | Purpose | Version |
|--------|---------|---------|
| `main` | 线上正式版，始终可发布 | 2.0.0 |
| `v1.5.x` | 1.5.x 维护分支（线上 bug 修复） | 1.5.x |
| `v2.0.0` | 2.0.0 开发分支（已合并 main） | 2.0.0 |
| `v2.1.0` | 2.1.0 开发分支（单据对账 ReconID 修复模块） | 2.1.0-beta.1 |
| `v3.0.0` | 3.0.0 开发分支 | 3.0.0-beta.1 |

PR 方向：v1.5.x fix → `v1.5.x → main`；v2.0.0/v2.1.0/v3.0.0 发布 → 对应分支 → `main`。

## Docs to Keep Updated on Version Iterations

Per README convention, these three files must be updated together on each release:
- `CHANGELOG.md`
- `docs/VERSION_FEATURE_HISTORY.md`
- `docs/USER_GUIDE.md`

## Conventions

- All UI strings and comments are in Chinese; output to user in Chinese
- Custom error class: `FileValidationError` (code, message, detail lines, context) in `file-service/common.js`
- Prepared field values use `__FIXED__:` prefix (e.g., `__FIXED__:MerchantId=NET001`)
- Database migrations are idempotent and run on every startup (`database/migrations.js`)
- Dialogs are created dynamically in JS — no separate HTML templates
- Commit message 不加 `Co-Authored-By` AI 署名
- PR body 不加 `Generated with Claude Code` 等 AI 标记
- 代码和注释中不出现 AI 相关标识

## 重要变量变动 check

项目有一张**重要变量清单** `rules/important-variables.md`，涵盖 5 层（Critical / Important-skeleton / Runtime-state / Risk-sensitive / Minor），每条附关联功能与变更 review 要点。

### 软约束（每次 agent 改 src/ 时）

每次对 `src/**/*.js` 做 `Edit` / `Write`，agent 完成修改后必须：
1. 回看本次改动涉及的符号名，对照 `rules/important-variables.md`
2. 若命中 Critical / Important-skeleton / Runtime-state / Risk-sensitive 任一层：
   - 在给用户的结尾汇报里专门列一个「**⚠️ 关联功能 review**」段落
   - 列出命中的变量名 + 层级 + 该条目的"变更 review 要点"
3. Minor 层可仅做"知会"提示，不强制列出

### 硬节点（必须调用 `/check-vars` skill）

以下场景**必须**调用 `/check-vars` skill（详见 `.claude/skills/check-vars/SKILL.md`）：

1. **team-lead 提 PR 前**（memory `workflow_no_tester_no_auto_pr` 定义节点）
2. **`package.json.version` bump** 时
3. **合并到 `main` 或 `v1.5.x`** 前
4. 用户显式输入 `/check-vars`

skill 会输出可粘贴到 PR body 的「⚠️ 关联功能 review」段落。

### 数据刷新

- 自动统计报告：`docs/analysis/var-reference-stats.md`（由 `npm run scan:vars` 生成，不要手改）
- 刷新时机：版本号 bump / 合并到受保护分支前，必须重跑 `npm run scan:vars`
- 升格评估：若 scan-vars 新发现的 A-share（跨 ≥ 3 文件）条目不在 `rules/important-variables.md`，人工评估是否升格入表

### 命令速查

```bash
npm run scan:vars     # 重新生成自动统计报告（docs/analysis/var-reference-stats.{md,json}）
npm run check:vars    # 手动触发 check-vars skill（等同 /check-vars）
```
