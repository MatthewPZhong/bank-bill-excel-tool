# v2.1.10 β SR-FIX-1 Round 1 Findings

> dev self-review 2026-05-28（37 commits / Phase 0-6 全部完成后）
>
> 输入：spec v0.3 / PRD v0.3 / tasks v0.2 / manual-test-checklist v0.2 / check-vars-report v1.0
> 自查对象：4 主线（A3 worker / A4 chunked / N4-cont-1 raw_json / N4-cont-2 FK CASCADE）+ 10 类自查重点
> 决策范围：不直接修；输出 finding + 推荐修复策略 + 工作量估算

---

## 总览

| 分级 | 数量 | 说明 |
|---|---:|---|
| 🔴 P0 Critical（合并前必修 — 资金 / 数据迁移 / FK 违反 / worker crash 死锁 / resume 不可用） | 4 | 资金红线 0；功能性死锁 / cleanup 冲突 / resume 路径破坏 4 项 |
| 🟡 P1 Important（合并前修 — UI 文案 / 日志 / spec/code 一致性 / 文档与代码不符） | 9 | 文档遗漏 sentinel 修订 / 文档与 code 顺序 / state machine 缺 status / Cancel UX / 单测覆盖缺漏 |
| 🟢 P2 Minor（合并后可补 patch — 注释 / typo / 单测 case 补全 / 边界 / 防御性） | 8 | 文档过时注释 / fixture 不严 / cleanup 冗余 / pre-warm 与 spec 差异等 |
| **合计** | **21** | |

**核心结论**：
1. **资金红线零命中** — `clearStaleSuccessfulRawJson` NOT IN 排除差异行 / `runCheckCore` byte-for-byte / `ensureDiffRowsCascadeMigration_v2_1_10` 8-status state machine 三道资金红线护栏均通过自查
2. **功能性 P0 集中在"重启场景 + worker crash"**：cleanupOrphanData 与 A4 resume 冲突 / worker init-error 永久 brick / before-quit 缺 shutdown
3. **文档与代码一致性 P1 7 项**：N4-cont-1 sentinel `''` 修订有 5 处遗漏（manual-test-checklist 3 + tasks 2）+ spec/code migration 顺序倒置 + IPC handler CancelError 处理不符 spec

---

## P0 Critical findings（4 项）

### P0-1: cleanupOrphanData 启动期清掉 chunked partial run，A4 resume 功能在重启场景下不可用

- **触发场景**：用户跑 runCheck 到 chunk 5/10 → cancel（或 worker crash） → chunk_progress.status='partial' / 'in-progress'，runs.status='success'（line 291 写时），runs.diff_file_path=null（writer 阶段还没到）→ 用户**关掉 app** → 重启 → `cleanupOrphanData` 启动期跑 → 检查 `!run.diff_file_path || !report_file_path → fileBroken=true` → orphanRuns.push → `cleanupAfterRunBackground(includeDiff: true)` 整月清掉 flow/bill/diff + DELETE FROM acquiring_bill_currency_runs WHERE id=? → **partial run 完全消失** → resume IPC 调用 `getLatestRun` 返回新的 latest（或 null）→ 拒绝 resume
- **代码位置**：`src/main-process/acquiring-bill-currency-session.js:593-599`（cleanupOrphanData fileBroken 判定）+ `src/main.js:10866`（resume handler 取 latestRun）
- **影响**：A4 resume 设计意图（spec §3.3 / §5.4 "重跑 idempotent" + tasks T19 "resumeFromRun"）在**用户重启 app 后无法生效**；实际只对"不重启 + cancel 后立即 resume"场景有效；spec PRD §1.3 用户故事覆盖的"500w 行数据 chunked resume"场景在跨 session 下失效
- **推荐修复**：
  - **方案 A（保守，工期 1h）**：cleanupOrphanData line 596 加 chunk_progress 检查 — `if (run.status !== 'success' || (fileBroken && progress?.status !== 'partial'))`。partial 状态的 run 不当孤儿处理（保留供 resume）。需补集成测试 case：模拟 cancel 后重启 + resume 路径
  - **方案 B（激进，工期 2-3h）**：spec §3.3 显式锁定"partial run 必须保留至下次 runCheck 显式触发 clearRunsByMonth"；UI 层（v2.1.11+）暴露 resume 按钮时禁止 partial run 被启动期 cleanup 自动清
  - **方案 C（妥协，工期 30m）**：先在 USER_GUIDE 1.8.10 加显式警告"resume 必须在 app 不重启前提下 + chunked cancel 后立即 resume；重启后需重跑整月"
- **测试 case**：
  - 单元：fixture chunked partial run + 跑 cleanupOrphanData → 断言 run 仍存活 + chunk_progress 仍是 partial
  - 集成：integration test 模拟 dispatch → cancel chunk 5 → reset workerPool（模拟重启）→ ensureInit → 调 resume IPC → 断言成功

### P0-2: worker init-error 后 workerInstance / workerInitPromise 不重置，永久 brick 主进程对账能力

- **触发场景**：worker 入口脚本 `initWorkerDb` 失败（如 PRAGMA verify 失败 / `new DatabaseSync` throw / DB 文件锁等）→ worker 内 catch 块发送 `{ type: 'init-error', error: serialized }` → 主进程 `ensureInitialized` line 200-203 仅 reject promise，**不重置 workerInstance / workerInitPromise**；下次 dispatchRunCheck 调用 → line 185-187 `workerInstance && workerInitPromise` 为 true → 直接 return 已 rejected 的 workerInitPromise → **永远失败，必须重启 app**
- **代码位置**：`src/main-process/run-check-worker-pool.js:200-208`（ensureInitialized init-error 分支无 reset）
- **影响**：worker 启动期失败一次 → 整个 app 生命周期 runCheck 都不能用 → 用户必须重启 app；spec §2.1.3 "异常恢复"明确要求 init-error 后下次冷启动
- **推荐修复**（工期 30m）：在 ensureInitialized init-error 分支加 reset + worker terminate：
  ```js
  } else if (msg.type === 'init-error') {
    w.off('message', onInitMsg);
    workerInitPromise = null;
    workerInstance = null;
    try { w.terminate(); } catch (_e) { /* swallow */ }
    reject(deserializeFromMessage(msg.error));
  }
  ```
  + 同步在 unit test `run-check-worker-pool.test.js` 加 case 17：模拟 init-error → 验证下次 dispatch 触发 cold-start 而非直接 reject
- **测试 case**：
  - unit：`run-check-worker-pool.test.js` 第 17 个 case — `__test_only_post__({ type:'init-error', ... })` 模拟 init-error → 等 reject → 第二次 dispatchRunCheck 必须能成功 cold-start

### P0-3: app.before-quit 缺少 runCheckWorkerPool.shutdown() 调用，worker DB 连接退出时不 graceful close

- **触发场景**：app 退出（用户关闭主窗口 / OS 关机 / kill 信号）→ before-quit 钩子触发 → main.js 11434 行只处理 usage-stats flush + cleanup quit；**完全没有调用 `runCheckWorkerPool.shutdown()`**；worker thread 跟随主进程 kill 时 worker 内 `new DatabaseSync(dbPath)` 连接**不 graceful close** → 可能引入 `.sqlite-wal` / `.sqlite-shm` 文件残留
- **代码位置**：`src/main.js:11434-...`（app.on('before-quit') 钩子无 workerPool.shutdown 调用）
- **影响**：
  - spec §2.1.3 明确要求 "主进程退出（app.before-quit）— workerInstance.terminate() + 等待 worker 内 DB 连接关闭（带 timeout 防卡死）"
  - 实际影响：SQLite 通常自动 WAL recovery，**不会数据损失**，但下次启动 SQLite 会做 WAL replay → 增加启动延迟 + 可能引入 PRAGMA inconsistency 风险
  - 测试集成场景下 `.wal` / `.shm` 残留可能影响后续测试 fixture 隔离
- **推荐修复**（工期 30m）：在 before-quit 钩子加 workerPool shutdown，需在现有 usage-stats flush 之后、cleanup quit 之前调用：
  ```js
  // v2.1.10 SR-FIX-1: 关闭 worker pool（spec §2.1.3）
  try {
    await runCheckWorkerPool.shutdown(5000);
  } catch (shutdownErr) {
    appendActivityLogEntry({
      level: 'warning', source: 'main', domain: 'acquiring-bill-currency',
      message: '[SR-FIX-1 P0-3] before-quit worker shutdown 失败（worker thread 将被强 kill）',
      details: [shutdownErr && shutdownErr.message]
    });
  }
  ```
  注意：before-quit 是同步 event；shutdown 是 async（返回 Promise）；需要 event.preventDefault() + 异步完成后 app.quit() 或接受"不等"语义（worker thread 自动 kill + DB 自动 recovery）
- **测试 case**：
  - 集成：在 phase2 integration 加 case 7：dispatchRunCheck 完成 → 调 shutdown → 断言 worker exit + DB file 无 wal/shm 残留

### P0-4: setupIdleCleanupTimer 中 N4-cont-1 raw_json 清理与 v2.1.8 主 cleanup 并发执行（spec §4.3.2 顺序契约不符）

- **触发场景**：idle 30min 达标 + worker 不 busy + grace 已过 → 进入 cleanup tick → line 11373 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded()`（**setImmediate 异步**，立即返回） → line 11380-11406 **同步**调 `clearStaleSuccessfulRawJson` → **两个 cleanup 并发执行**
- **代码位置**：`src/main.js:11373-11406`（setupIdleCleanupTimer 内 idle tick）
- **影响**：
  - **不算真实 race**（main 进程同一 DatabaseSync 连接顺序执行）— 不同表（DELETE flow_imports vs UPDATE bill_imports）+ event loop 排队保证最终安全
  - **但 spec §4.3.2 + PRD §五.2 明确说"顺序契约：① 先 v2.1.8 cleanupAfterRunBackground → ② 后 raw_json 清理；失败不阻塞主 cleanup"** — 实际代码是"主 cleanup setImmediate 启动 + raw_json 同步立即跑"
  - 日志顺序混乱（raw_json 日志可能先于主 cleanup 日志出现 — 影响排错 + activity log 可读性）
  - 若未来 chunked / cleanup 内部加锁或长 batch 数 → 与 raw_json 触发同 connection 死锁概率上升
- **推荐修复**（工期 1h，需写 unit 验证）：
  - **方案 A（保守，推荐）**：把 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded` 改为返回 Promise（主 cleanup 完成 resolve）→ idle tick 内 `await` 后再调 raw_json。需改 triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded 签名 + 兼容现有 caller（启动期 + 进入模块兜底）
  - **方案 B（最小改动）**：把 raw_json 清理也放进 setImmediate 队列尾（保证至少不抢先于主 cleanup tick）：
    ```js
    triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded();
    setImmediate(() => {
      try { /* clearStaleSuccessfulRawJson */ } catch { /* ... */ }
    });
    ```
  - **方案 C（更新 spec）**：spec §4.3.2 改写为"两个 cleanup 都是 fire-and-forget；同 connection 顺序自然保证"
- **测试 case**：
  - 集成：phase4 加 case 4：fixture 模拟主 cleanup 进行中 → idle tick → 断言 activity log 顺序为先 cleanup 后 raw_json
  - unit：mock idle tick 触发函数 → 验证 await/setImmediate 顺序

---

## P1 Important findings（9 项）

### P1-1: manual-test-checklist 3 处 + tasks 2 处仍用 v0.2 `raw_json IS NULL` / `IS NOT NULL` 语义（未同步到 v0.3 `''` sentinel）

- **触发场景**：tester 按 manual-test-checklist §5.1（line 562-564）跑验收 SQL → 实际 schema 是 NOT NULL → SQL `WHERE raw_json IS NULL` 永远返回 0 行 → tester 误判"对账成功老行未被清"
- **代码位置**：
  - `docs/iterations/v2.1.10/manual-test-checklist.md:562-564` — 3 处 `raw_json IS NOT NULL` / `IS NULL` 验收 SQL
  - `docs/iterations/v2.1.10/tasks.md:244` — T23 描述 `UPDATE ... SET raw_json = NULL` + `raw_json IS NOT NULL` 守卫
  - `docs/iterations/v2.1.10/tasks.md:264` — T28 描述 case 1 验证 SQL 用 `IS NOT NULL`
  - `docs/iterations/v2.1.10/manual-test-checklist.md:1163` — `用户拍板 D26：UPDATE raw_json = NULL（保留行骨架）` 历史标记
- **grep 实证**（per-file line numbers）：
  ```
  manual-test-checklist.md:562 raw_json IS NOT NULL
  manual-test-checklist.md:563 raw_json IS NULL
  manual-test-checklist.md:564 raw_json IS NOT NULL
  tasks.md:244 SET raw_json = NULL ... raw_json IS NOT NULL
  tasks.md:264 b.raw_json IS NOT NULL ... raw_json IS NULL
  ```
- **影响**：tester 实际跑验收会全部误判失败；spec/PRD/USER_GUIDE/CHANGELOG/VFH/check-vars-report 都已经修订到 `''` — 只 tasks + manual-test-checklist 漏改
- **推荐修复**（工期 15m）：批量 replace：
  - `raw_json IS NOT NULL` → `raw_json != ''`
  - `raw_json IS NULL` → `raw_json = ''`
  - `SET raw_json = NULL` → `SET raw_json = ''`
  - 同步加 v0.3 修订标记（与 spec 一致）
- **测试 case**：不需要单测（仅文档 typo）；commit 后由人工 review 确认 sed/replace 全捕获

### P1-2: database.js 启动期 migration 顺序与 spec §八.3 描述相反（实际 N4-cont-1 settings 在前 / N4-cont-2 schema 在后）

- **触发场景**：spec §八.3 + PRD §五.3 写"migration 顺序固定：① 先 N4-cont-2 schema rebuild ② 后 N4-cont-1 settings INSERT OR IGNORE"；**实际代码**：line 300 N4-cont-1 settings (`ensureAcquiringBillCurrencyRawJsonRetentionSettings`) → line 310 N4 raw_json slim (v2.1.8) → line 363 N4-cont-2 schema rebuild
- **代码位置**：`src/backend/database.js:280-420`（init 序列）
- **影响**：
  - **功能 OK** — spec 本身就说"任意顺序都可（settings 与 schema 互不影响），固定为此顺序便于排查"；实际任意顺序都不会 break
  - **文档 vs 代码不一致** — 未来 reviewer 翻文档 vs 翻代码会困惑
- **推荐修复**：二选一（工期 30m）
  - **方案 A**：改 spec §八.3 + PRD §五.3 描述为"先 N4-cont-1 settings → N4 raw_json slim → N4-cont-2 schema rebuild"（贴近代码现状）
  - **方案 B**：改代码顺序，N4-cont-2 schema 移到 N4-cont-1 settings 之前
- **推荐**：方案 A（文档跟代码走 — 代码顺序的设计理由：settings 先 seed → 启动后即可读 / schema 后改 → 避免 N4 重写期间 schema 改动）
- **测试 case**：不需要新增

### P1-3: ensureDiffRowsCascadeMigration_v2_1_10 缺 `checked` status 显式更新（spec §5.3.2 要求 pre-migration FK check）

- **触发场景**：spec §5.3.2 表格定义 8 status：pending → backup-done → **checked**（先验：PRAGMA foreign_key_check 当前 schema 0 violation） → rebuilt → indexed → fk-verified → flag-set → committed；**实际代码**没有显式跑 pre-migration FK check（只在 5g 即 rebuild 后跑 `PRAGMA foreign_key_check`）
- **代码位置**：`src/backend/database/migrations.js:1347-1500`（ensureDiffRowsCascadeMigration_v2_1_10 statusReached 推进只有 'pending' → 'backup-done' → 'rebuilt' → 'indexed' → 'fk-verified' → 'flag-set' → 'committed'，缺 'checked'）
- **影响**：
  - 若 v2.1.7/v2.1.8/v2.1.9 老库就已经有 FK violation（极少；理论 0 violation 但 SQLite WAL replay 边界、用户 sqlite3 直改 等极端场景可能引入） → migration 会无视并 rebuild → 老违反保留到新 schema
  - **风险低**（实际 fresh schema 0 violation 概率高），但**与 spec 8 status 范式不一致**
- **推荐修复**（工期 1.5h）：在 Step 4 backup-done 后加 Step 4.5 checked：
  ```js
  // ---------------- Step 4.5: pre-migration FK check（spec §5.3.2）-----
  const preViolations = db.prepare(`PRAGMA foreign_key_check('${N4_CONT_2_DIFF_ROWS_TABLE}')`).all();
  if (preViolations && preViolations.length > 0) {
    return {
      status: 'pre-fk-violation',
      statusReached,
      backupPath,
      error: `pre-migration FK check 发现 ${preViolations.length} 条 violation — 拒绝迁移以防破坏`,
    };
  }
  statusReached = 'checked';
  ```
  + 同步在 migrations-n4-cont-2.test.js 加 case 13：人为插 FK violation → 验证 status='pre-fk-violation' + 不动 schema
- **测试 case**：
  - unit：fixture 含 FK violation 的 diff_rows → 跑 migration → 断言 status='pre-fk-violation' + backup 保留 + schema 未动

### P1-4: IPC handler `acquiringBillCurrency:run` 对 CancelError 仍走 error 路径（弹错误 Notification，违反 spec §2.4 设计意图）

- **触发场景**：用户在 runCheck 期间点 cancel → worker 内 runCheckCore 5 阶段 cancelToken.throwIfCancelled → throw CancelError → worker 序列化 → 主进程 dispatchRunCheck reject(CancelError) → IPC handler catch → **不区分 CancelError vs 真实 error** → `notifyAcquiringBillCurrencyResult(monthKey, 'error', { message: err.message })` → 用户看到"对账失败：runCheck cancelled at stage=..."的红色 Notification
- **代码位置**：`src/main.js:10813-10818`（run handler catch）+ `src/main-process/acquiring-bill-currency-session.js:158-160`（CancelError 类定义注释明确说"业务语义：用户主动取消（cancel button），不是真正的失败. main.js IPC handler 应识别此 error 不弹错误 Notification，仅 toast「已取消」"）
- **影响**：
  - **UX 严重**：用户主动 cancel → 弹"error Notification" → 用户以为系统出错
  - spec §2.4 设计契约 + CancelError class 注释**显式定义**这个区分；code 漏实现
- **推荐修复**（工期 30m）：catch 块加 CancelError 识别 + 静默 toast 而非 error Notification：
  ```js
  } catch (err) {
    releaseOpLock();
    if (err && err.name === 'CancelError') {
      // v2.1.10 SR-FIX-1 P1-4：用户主动取消，不弹 error
      try {
        notifyAcquiringBillCurrencyResult(monthKey, 'cancelled', { stage: err.stage });
      } catch (_e) { /* swallow */ }
      return { status: 'cancelled', message: err.message, stage: err.stage };
    }
    notifyAcquiringBillCurrencyResult(monthKey, 'error', { message: err && err.message });
    return { status: 'error', message: err && err.message ? err.message : String(err) };
  }
  ```
  + notifyAcquiringBillCurrencyResult 加 'cancelled' branch（短 body toast / 蓝色样式）
  + resume handler 同样改造
- **测试 case**：
  - 集成：phase2 case 3 (cancel stage 1) 加断言：handler return.status === 'cancelled' + 不弹 error Notification
  - 手动：UI 路径 — cancel 按钮触发后查看 Notification 实际样式

### P1-5: resume handler 实施与注释不符 — 只看最近 1 个 run.chunk_progress 不扫描历史 partial run

- **触发场景**：resume handler line 10864-10872 注释说"自动找该月最近一个 chunk_progress.status='partial' 的 run"，但**实际只取 `getLatestRun(monthKey)` 最近一个 run** → 然后 check `progress.status !== 'partial'` → 不 partial 则拒绝 resume；如果月内最近 run 是 complete / in-progress（如刚跑完一次新的），但**前一个 run 是 partial** → 用户无法 resume 前一个 partial
- **代码位置**：`src/main.js:10864-10881`（resume handler 逻辑）
- **影响**：
  - 注释与实际行为不符 — 集成测试 / 高级用户调用会困惑
  - 实际业务场景：v2.1.10 暂未暴露 UI（v2.1.11+），影响范围有限
  - 设计契约：每月一般只 1-2 个 run；最近 1 个 partial 通常就是用户想 resume 的
- **推荐修复**（工期 30m）：
  - **方案 A（匹配注释）**：runRepoLocal 加 `listPartialRuns(db, monthKey)` 返回所有 chunk_progress.status='partial' 的 runs（按 ran_at DESC）→ handler 取第一个 + 校验 month_key 一致
  - **方案 B（匹配实施）**：改注释为"取最近 1 个 run，检查 chunk_progress.status；非 partial 拒绝"
- **推荐**：方案 A（贴近用户预期 + spec PRD 设计意图）
- **测试 case**：
  - 集成：phase3 加 case：fixture 含 latest=complete + 前一个=partial → resume handler 无 runId 参数 → 断言找到 partial 的 run + 成功 resume

### P1-6: worker init-error 路径无 unit / integration 覆盖（tasks T06 12 case 描述与实际不符）

- **触发场景**：tasks.md T06 描述"unit test `tests/unit/main-process/run-check-worker.test.js` 12 case 全绿"；**实际仅 `run-check-worker-pool.test.js`（16 case）存在**；worker 入口 `run-check-worker.js` 没有独立 unit test 文件；init-error 路径无任何自动化覆盖（既 P0-2 永久 brick 也漏 unit 测试）
- **代码位置**：tasks.md:104-106（T06）vs 实际文件 `find tests/unit -name "*worker*"` → 仅 `run-check-worker-pool.test.js`
- **影响**：
  - 单测覆盖度比预期低
  - init-error 路径完全无自动化覆盖（与 P0-2 配对）
- **推荐修复**（工期 2h）：新建 `tests/unit/main-process/run-check-worker.test.js` 12 case：
  1. initWorkerDb 6 PRAGMA 全设
  2. initWorkerDb PRAGMA verify 失败 throw
  3. initWorkerDb dbPath 缺失 throw
  4. initWorkerDb DB 文件不存在自动建
  5. PRAGMA verify int 比较（synchronous=1）
  6. PRAGMA verify string 比较（journal_mode='wal' 小写）
  7. parentPort.on('message') init message 处理
  8. parentPort.on('message') run message 处理
  9. parentPort.on('message') cancel message 处理
  10. parentPort.on('message') close message 处理
  11. PRAGMA_EXPECTED + PRAGMA_STATEMENTS 常量导出
  12. ExperimentalWarning 过滤（POC surprise #1）
  + 同步更新 tasks.md T06 实际 case 数
- **测试 case**：见推荐修复

### P1-7: chunked partial run 在 worker crash 场景下 chunk_progress 不会被设为 'partial'

- **触发场景**：worker 跑到 chunk 5/10 → 突然 process.exit(1) / OOM / SIGKILL → catch 块（runCheckCore line 367-394）**不执行** → chunk_progress 停留在 'in-progress'（onChunkDone 写的最后一次）→ resume handler 检查 `progress.status !== 'partial'` → 拒绝 resume
- **代码位置**：`src/main-process/acquiring-bill-currency-session.js:341-394`（onChunkDone 写 in-progress / catch 写 partial）+ `src/main.js:10878-10881`（resume 检查 status）
- **影响**：
  - worker crash 场景 chunk_progress 状态错位 → resume 不可用
  - 实际场景：worker_threads crash 极少（5 case workers 都通过测试），但 OOM 仍可能
- **推荐修复**（工期 1h）：worker pool failureListener 触发时由主进程兜底改 chunk_progress status='partial'：
  - 在 main.js failureListener 内查 active jobId 对应 runId（需 dispatchRunCheck 把 monthKey + runId 也透传给 failureListener，或 listener 内单独查 latestRun）
  - 调 `runRepo.setRunChunkProgress(database.db, { runId, ..., status: 'partial' })`
  - 失败容忍：try/catch + activity log
- **测试 case**：
  - 集成：phase2 case 6 (worker crash) 加断言：crash 后查 chunk_progress.status='partial'（前提：chunk 1+ 已 COMMIT）

### P1-8: USER_GUIDE 缺少 "chunked partial run 与 cleanupOrphanData 冲突" 警告

- **触发场景**：用户读 USER_GUIDE §1.8.10 / 1.8.11 / 1.8.12 → 期望 resume 功能可用；实际重启后 partial run 被 cleanupOrphanData 清掉（P0-1）→ resume 失败 → 用户困惑
- **代码位置**：`docs/USER_GUIDE.md:1325+`（§1.8.11 跨进程对账 + §1.8.12 chunked）— 仅说 chunked + cancel + resume IPC，**未提重启场景**
- **影响**：
  - 用户预期与实际行为不符
  - 与 P0-1 配对：如果 P0-1 选方案 C（妥协），必须在 USER_GUIDE 同步加警告
- **推荐修复**（工期 30m）：在 §1.8.12（或新建 §1.8.13）加显式段落：
  ```markdown
  **⚠️ Resume 边界条件**：
  - **必须在 app 不重启前提下**触发 resume — 重启会触发启动期 cleanup，清掉 partial run 数据
  - chunked cancel 后立即点 resume 按钮（v2.1.11+ UI）/ 或调 IPC（高级用户）
  - 如果已经重启过 → 必须重跑整月 runCheck（partial run 已不可恢复）
  ```
- **测试 case**：不需要

### P1-9: createRunProgressForwarder 文档过时（"每 run 仅 6 个事件" — chunked 后 50+ 事件不节流）

- **触发场景**：main.js line 10599 注释"createRunProgressForwarder：无节流（每 run 仅 6 个事件）"；**A4 chunked 改造后每 chunk 触发 progress 事件** — 500w 行 = 50 chunks → 50 个 events；5000w 行 → 500 events；renderer.js 端 IPC listener 每 event 都触发渲染 → 大数据量下可能渲染抖动
- **代码位置**：`src/main.js:10597-10620`（createRunProgressForwarder 无节流）
- **影响**：
  - 文档过时但**功能 OK**（renderer 端没有特定要求）
  - 长期：大数据量下 IPC 噪声 + renderer 渲染开销
- **推荐修复**（工期 30m）：
  - **方案 A（仅改注释）**：更新注释为"每 run 6+N chunks 个事件（chunk 数 = totalBillRows / chunkSize）；当前不节流，N > 100 时考虑节流"
  - **方案 B（加节流）**：sql-joining 阶段（chunk 事件）单独 200ms 节流；其他 5 阶段事件必发
- **推荐**：方案 A（v2.1.10 数据量预期 < 50 chunks 不影响）；方案 B 留 v2.1.11+
- **测试 case**：不需要

---

## P2 Minor findings（8 项）

### P2-1: cleanupAfterRunBackground 在 N4-cont-2 改造后注释/代码部分 redundant（先删 diff 已被 CASCADE 覆盖）

- 位置：`src/main-process/acquiring-bill-currency-session.js:520-530` + `src/backend/acquiring-bill-currency-db/run-repository.js:73-76`（clearRunsByMonth 显式两步删）
- 描述：v2.1.10 N4-cont-2 后 DELETE FROM acquiring_bill_currency_runs 会 CASCADE 清 diff_rows；v2.1.8 cleanupAfterRunBackground includeDiff=true 分支先删 diff 再删 bill 现已 redundant（CASCADE 自动）；clearRunsByMonth 同样
- 推荐修复（工期 30m）：
  - 保留显式删（兜底 — 防 N4-cont-2 migration 未跑成功的老库）+ 加注释说明"N4-cont-2 后 CASCADE 已覆盖；保留以应对 migration 未跑场景"
  - 或加 if guard 检查 marker 表 — 复杂度提升不值

### P2-2: chunk size getter MIN=10000 与 manual-test §4.2.4 "chunk size = 1 边界小值" 描述不一致

- 位置：`src/backend/database/settings-repository.js:281-282`（MIN=10000）+ `docs/iterations/v2.1.10/manual-test-checklist.md` §4.2 case 边界 1 行 chunk
- 描述：getter 范围外都回退 100000；caller 直传 chunkSize=1 仍可工作（run-repository.js:156-159 验证 ≥ 1）；但 settings 层路径下 chunk=1 不可达
- 推荐修复（工期 15m）：要么改 MIN=1（允许极端激进），要么改 manual-test case 描述为"caller 绕过 settings 直传 chunk=1（仅集成测试场景）"

### P2-3: test fixture raw_json TEXT NOT NULL DEFAULT '' 与生产 schema 不严格 byte-for-byte（生产无 DEFAULT '')

- 位置：`tests/unit/backend/acquiring-bill-currency-db/raw-json-retention.test.js:47` + `src/backend/database/migrations.js:1739`
- 描述：test fixture 有 DEFAULT ''；生产无（migrations.js:1739 仅 `raw_json TEXT NOT NULL`）；意味着生产 INSERT 必须显式给 raw_json 值（reader.js 总提供），test fixture 是简化
- 推荐修复（工期 15m）：fixture 改 `raw_json TEXT NOT NULL`（移除 DEFAULT '')；insertBill 显式提供 raw_json 值 — 已经在做（line 96）— 实际可直接改

### P2-4: dispatchRunCheck "worker 正忙（业务侧已有 op lock 防御 — 此处理应不可达）" throw 是防御性兜底

- 位置：`src/main-process/run-check-worker-pool.js:229-231`
- 描述：当前 IPC handler run + resume 都有 tryAcquireOpLock 防御；理论不会同时到达 pool dispatchRunCheck；防御性 throw OK 但 error message 可改为更友好
- 推荐修复（工期 10m）：throw 信息改为更明确的 `worker 正忙 jobId=${activeJob.jobId} — 业务侧 op lock 应防御，此处兜底防御性 throw`

### P2-5: run-check-worker-pool cancel 在 worker init 期间无效（activeJob 未 set 前返回 false）

- 位置：`src/main-process/run-check-worker-pool.js:268-291`
- 描述：worker init 期间用户/测试触发 cancel → activeJob === null → return false → cancel 无效；当前 init 仅 ~11ms（POC 实测），实际边界很窄
- 推荐修复（工期 1h）：加 cancelPending flag — init 期间 cancel 设 flag，init-done 后立即对 worker 发 cancel；或仅在文档说明此边界

### P2-6: main.js 未调 preWarm（spec §2.1.1 "pre-warm 策略推荐"）

- 位置：`src/main.js`（无 preWarm 调用）vs spec §2.1.1
- 描述：spec 推荐 pre-warm；POC surprise #3 说 "cold-start 仅 11ms 时可放宽 — pre-warm 策略可放宽为'有条件'"；实际 lazy init 是合理选择，但 spec 仍说 recommended
- 推荐修复（工期 15m）：
  - 方案 A：spec §2.1.1 加注释"实施落地为 lazy init（POC #3 表明 cold-start ~11ms 可接受 / 避免启动期额外耗时）"
  - 方案 B：加 preWarm 调用（启动期 5s 后异步 preWarm，trade-off 增加少量启动期 OS 资源）
- 推荐：方案 A

### P2-7: insertDiffRowsByJoinChunked 在 resumeFromChunkIndex >= totalChunks 路径不显式 SET status='complete'

- 位置：`src/backend/acquiring-bill-currency-db/run-repository.js:183-190`（return without onChunkDone trigger）+ `src/main-process/acquiring-bill-currency-session.js:417-426`（仅处理 totalChunks=0 边界）
- 描述：resumeFromChunkIndex 已 >= totalChunks 时 chunked 返回但 chunk_progress 仍是 partial → 下次 resume 又走"nothing-to-do" → idempotent 但 confusing
- 推荐修复（工期 30m）：session.runCheckCore line 417 if 块扩展条件：`if (chunkedResult.totalChunks === 0 || chunkedResult.lastCompletedChunkIndex >= chunkedResult.totalChunks - 1) { ... status='complete' }`

### P2-8: 集成测试 v2.1.10-n4-cont-1-phase4.js line 255 注释残留 "IS NOT NULL"

- 位置：`scripts/integration/v2.1.10-n4-cont-1-phase4.js:255`
- 描述：注释 `// 验证 baseline：raw_json 全部 IS NOT NULL`，实际 SQL `WHERE raw_json != ''`（一致）；仅注释不一致
- 推荐修复（工期 5m）：改注释 `// 验证 baseline：raw_json 全部 != ''`

---

## 不修但建议留意（不进 SR-FIX）

1. **cancel handler 的 jobId 未透传到 renderer** — 当前单 worker 单 activeJob，pool.cancel(null) 兜底取 activeJob.jobId 是 OK 的；多 worker 时才需要 (v2.1.11+ 评估)
2. **`acquiringBillCurrency:run:resume` UI 暂未暴露** — spec/PRD 明确 v2.1.11+ 评估；高级用户 / 集成测试可用 IPC 调用；不阻塞 v2.1.10 release
3. **bill_imports / flow_imports 未加 ON DELETE CASCADE 到 runs** — D28 = (a) 拍板"仅 diff_rows 2 FK"；bill/flow 是数据真理源，业务语义保留独立
4. **N4 v2.1.8 migration vs N4-cont-2 顺序** — N4 在 N4-cont-2 之前（line 310 vs line 363），spec §八.3 也说"任意顺序都可"；N4 是重写 raw_json 字段值，N4-cont-2 是 schema rebuild — **不影响**
5. **chunked 边界 0 行 bill** — 已处理（totalChunks=0 直接 return + chunk_progress='complete' 显式写）
6. **serialize-error cause 链 10 层截断** — 已有 unit test 覆盖（case 5）+ `__truncated__` 标志 + round-trip 保留

---

## Round 1 总结

### finding 数量分布

| 分级 | 数量 | 占比 |
|---|---:|---:|
| 🔴 P0 Critical | 4 | 19% |
| 🟡 P1 Important | 9 | 43% |
| 🟢 P2 Minor | 8 | 38% |
| **合计** | **21** | 100% |

### 修复总工期估算

| 分级 | 总工期 |
|---|---|
| 🔴 P0 修复（4 项） | ~6h（P0-1 1h + P0-2 30m + P0-3 30m + P0-4 1h + 测试 case 2-3h）|
| 🟡 P1 修复（9 项） | ~9h（文档 15m + P1-2 30m + P1-3 1.5h + P1-4 30m + P1-5 30m + P1-6 2h + P1-7 1h + P1-8 30m + P1-9 30m + 测试 2h） |
| 🟢 P2 修复（8 项） | ~3-4h（每项 15m-1h）|
| **合计** | **~ 1.5-2 工作日**（含集成测试更新 + 集成 case 补全）|

### grep 全 src/ + tests/ + scripts/ raw_json IS NULL / = NULL / IS NOT NULL 残留实测

| 文件 | 命中数 | 性质 |
|---|---:|---|
| `src/backend/acquiring-bill-currency-db/raw-json-retention.js` | 1 | ⚠️ 注释中保留（v0.2 → v0.3 修订历史；非 active 代码）|
| **`src/**` 其他文件** | **0** | ✅ |
| **`tests/**`** | **0**（active 代码） | ✅（test fixture 注释 1 处 — P2-8）|
| **`scripts/integration/**`** | **0**（active 代码） | ✅ |
| `docs/iterations/v2.1.10/manual-test-checklist.md` | **3** | 🟡 P1-1（active 验收 SQL 用 IS NULL/IS NOT NULL）|
| `docs/iterations/v2.1.10/tasks.md` | **2** | 🟡 P1-1（T23/T28 描述用旧 sentinel）|
| `docs/USER_GUIDE.md` | 0 | ✅（已全部 `!= ''` / `= ''`）|
| `docs/VERSION_FEATURE_HISTORY.md` | 0 | ✅ |
| `CHANGELOG.md` | 0 | ✅ |
| `docs/iterations/v2.1.10/spec.md` | 0 | ✅（已 v0.3 reverse sync）|
| `docs/iterations/v2.1.10/PRD-v2.1.10.md` | 0 | ✅（已 v0.3 reverse sync）|
| `docs/iterations/v2.1.10/check-vars-report.md` | 0 | ✅ |
| `rules/important-variables.md` | 0 | ✅ |

**关键事实**：active code 0 残留；只剩 docs/iterations/v2.1.10/{manual-test-checklist,tasks}.md 5 处遗漏 — P1-1 修复。

### byte-for-byte contract test 覆盖度评估

| 测试场景 | 覆盖文件 | 数据量 | 评价 |
|---|---|---|---|
| worker vs main runCheckCore 输出 byte-for-byte | `scripts/integration/v2.1.10-a3-phase1.js` 40 case | fixture 10 行 | ⚠️ 偏少 |
| chunked vs non-chunked diff_rows byte-for-byte | `scripts/integration/v2.1.10-a4-phase3.js` 25 case + perf | 500/5000/50000 行 | ✅ 覆盖 |
| chunked vs non-chunked chunkSize 边界 | `scripts/perf/v2.1.10-a4-chunked-report.md` | 1k/1w/10w/100w | ✅ 覆盖 |
| 500w 行真实数据 byte-for-byte | — | — | ❌ 未覆盖（仅外推） |

**建议**：不阻塞 v2.1.10 release，**用户真实环境验收**（manual-test §9.2）需用户填入 500w+ 行实测数据后才算性能与正确性完全闭环。

### 跨 Phase 协同 bug 检测

| 跨 Phase 协同 | 检测结果 |
|---|---|
| Phase 2 cancelToken 5 阶段 + Phase 3 chunked 每 chunk 边界 | ✅ runCheckCore + insertDiffRowsByJoinChunked 都有 cancelToken 透传 + check |
| Phase 1 worker pool 单 worker + Phase 3 resume 同 runId | ✅ alias runCheck=runCheckCore + payload.resumeFromRun 透传 |
| Phase 4 N4-cont-1 raw_json='' + Phase 5 N4-cont-2 FK CASCADE | ✅ CASCADE 删 bill_imports 时不触发 raw_json constraint（schema NOT NULL 仍满足） |
| Phase 4 N4-cont-1 idle cleanup + Phase 5 N4-cont-2 migration 时机 | ✅ N4-cont-2 在启动期 init() 同步完成；idle cleanup 在 app.whenReady 之后才启动 timer |
| **Phase 3 chunked partial + Phase 5 N4-cont-2 CASCADE + v2.1.8 cleanupOrphanData** | **🔴 P0-1 协同冲突**（cleanupOrphanData 清掉 partial run → A4 resume 失效） |
| **runCheck IPC handler + CancelError + spec §2.4 注释** | **🟡 P1-4 协同 bug**（handler 不区分 CancelError） |

### 文档一致性（v0.3 sentinel）

| 文档 | v0.3 一致性 |
|---|---|
| `docs/iterations/v2.1.10/spec.md` | ✅ |
| `docs/iterations/v2.1.10/PRD-v2.1.10.md` | ✅ |
| `docs/iterations/v2.1.10/tasks.md` | ❌ P1-1（2 处） |
| `docs/iterations/v2.1.10/manual-test-checklist.md` | ❌ P1-1（3 处） |
| `docs/iterations/v2.1.10/check-vars-report.md` | ✅ |
| `docs/USER_GUIDE.md` | ✅ |
| `docs/VERSION_FEATURE_HISTORY.md` | ✅ |
| `CHANGELOG.md` | ✅ |
| `rules/important-variables.md` | ✅ |

### 建议下一步节奏

1. **Round 1 → Round 2 修复（≥ 6h，1 天）**：先修 4 项 P0（功能性死锁 / 重启场景 resume 失效 / before-quit shutdown / cleanup 顺序）+ 5 项 P1（文档遗漏 sentinel / state machine checked / CancelError UX / resume scan / init-error unit test）
2. **Round 2 验证**：跑 release-check + 重写 manual-test-checklist 5.x 一遍 + 集成 case 补全（P0-1 P0-2 P0-4 P1-3 P1-6 P1-7）
3. **可选 Codex review**：4 项 P0 修复完成后请 Codex 二次复审（参考 v2.1.9 SR-FIX-1 Round 3 范式）
4. **用户测试 + 提 PR**：用户跑 manual-test-checklist（重点 §5 N4-cont-1 / §6 N4-cont-2 / §三 A3 worker / §四 A4 chunked）+ 性能基线 §9.2 真实数据填入 → 提 PR
5. **Round 3-4**（按 v2.1.9 PR #53 SR-FIX-1 4 轮范式，视新发现 finding 决定）

### Round 1 工期实际

- **预计**：1-2 h
- **实际**：约 1.5h（grep + 代码审查 + finding 报告）
- **覆盖度**：10 大类 100% + grep 实证 5 个 docs/iterations 文件 + grep 验证 src/tests/scripts active code 0 sentinel 残留

---

**报告状态**：v1.0（2026-05-28 dev self-review Round 1 完成）
**下一步**：等主线程审 finding → 决策 Round 2 修复策略
