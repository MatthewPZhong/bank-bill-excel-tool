# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

网银账单生成小助手 — Electron desktop app for Chinese bank statement processing. Imports Excel/CSV bank statements, maps columns via configurable templates, and exports standardized detail & balance Excel files.

Tech stack: Electron 36 + vanilla JS (no frontend framework) + SQLite (`node:sqlite` DatabaseSync) + SheetJS (XLSX).

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

**Key files by size/importance (largest first):**
- `src/main.js` — all IPC handlers, business logic orchestration, global session state
- `src/renderer-dialogs.js` — all modal dialog factories (mapping, import, account selection)
- `src/renderer.js` — renderer state management, DOM event binding, UI updates

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

- `main` 始终可发布；`v1.5.x` 为线上维护分支；`vX.Y.Z` 为对应版本开发分支。
- 当前版本号以 `package.json.version` 为准，分支清单以 `git branch` 为准（不在此处维护快照）。
- PR 方向：v1.5.x fix → `v1.5.x → main`；vX.Y.Z 开发分支 → 对应分支 → `main`。

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

项目维护一张重要变量清单 `rules/important-variables.md`（5 层：Critical / Important-skeleton / Runtime-state / Risk-sensitive / Minor）；完整的软约束、硬节点、数据刷新流程见 `.claude/skills/check-vars/SKILL.md`。要点：

- **软约束**：每次改 `src/**/*.js` 后对照清单，命中 Minor 以上层级要在结尾汇报里列「⚠️ 关联功能 review」段落。
- **硬节点（必须跑 `/check-vars`）**：提 PR 前 / `package.json.version` bump 时 / 合并到 `main` 或 `v1.5.x` 前 / 用户显式调用。
- **命令**：`npm run scan:vars` 刷新统计报告（版本 bump / 合并受保护分支前必跑）；`npm run check:vars` 等同 `/check-vars`。
