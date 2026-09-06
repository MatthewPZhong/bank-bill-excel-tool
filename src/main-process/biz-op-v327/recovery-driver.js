'use strict';

const { setImmediate: yieldMain } = require('node:timers/promises');
const { createRecoveryBudget } = require('./recovery-budget');
const { ACTIONS, sourceKey, sameSource, fail, hash } = require('./contracts');

function createBizOpRecoveryDriver({ catalog, sources, admission, readRepository, budgetOptions }) {
  let platform = null;
  let pending = null;
  let deferredStartupBudget = null;
  let platformScanCompleted = false;
  function openObligations() {
    const db = catalog.db;
    return Boolean(db.prepare(`SELECT 1 FROM biz_op_v327_prepared_ops p
      JOIN biz_op_v327_settlement_progress s USING(task_run_id) JOIN archive_task_runs t USING(task_run_id)
      WHERE p.phase!='CLOSED' OR s.state!='COMPLETE' OR t.status NOT IN ('succeeded','failed','cancelled') LIMIT 1`).get()
      || db.prepare('SELECT 1 FROM biz_op_v327_read_pins LIMIT 1').get()
      || db.prepare("SELECT 1 FROM biz_op_v327_dispatches WHERE state!='CLOSED' AND process_exit_evidence_json IS NULL LIMIT 1").get()
      || db.prepare("SELECT 1 FROM biz_op_v327_reclaim_queue WHERE state!='DONE' LIMIT 1").get()
      || db.prepare("SELECT 1 FROM biz_op_v327_recovery_followups WHERE state!='COMPLETE' LIMIT 1").get()
      || readRepository.listActiveRecoveryHolds().some((hold) => ACTIONS[hold.actionKey]));
  }
  function progress(source) {
    const { db } = catalog;
    return hash({
      task: catalog.task(source.taskRunId).status,
      phase: catalog.operation(source.taskRunId).phase,
      receipt: Boolean(catalog.receipt(source.taskRunId)),
      finalization: Boolean(db.prepare('SELECT 1 FROM biz_op_v327_abort_finalizations WHERE source_kind=? AND source_ref=?')
        .get(source.sourceKind, source.sourceRef)),
      pins: db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(source.taskRunId).n,
      reclaim: source.boundedEvidence.category === 'RECLAIM'
        ? db.prepare('SELECT state FROM biz_op_v327_reclaim_queue WHERE reclaim_id=?').get(source.boundedEvidence.reclaimId).state : null,
      hold: readRepository.getActiveRecoveryHoldByScope(source.conflictScopeKey)?.holdId || null,
      closure: sources.facts(source).evidence.closureDigest
    });
  }
  async function runAttempt({ initialPlatformOnly = false } = {}) {
    if (!platform) fail('BIZOP_RECOVERY_PLATFORM_NOT_BOUND');
    return admission.exclusive(async () => {
      const budget = deferredStartupBudget || createRecoveryBudget(budgetOptions);
      deferredStartupBudget = null;
      sources.installBudget(budget);
      let platformSummary = null;
      let completedSources = 0;
      let reason = null;
      const blockedScopes = new Set();
      async function scan() {
        budget.begin('fullScans');
        // 不使用 Promise.race：调用越过准入期限时继续持有 gate，等待真实返回。
        const summary = await platform.scanAndRecover();
        platformScanCompleted = true;
        const bytes = Buffer.byteLength(JSON.stringify(summary.decisions || []));
        if (bytes > budget.limits.decisionBytes) budget.reject('BIZOP_RECOVERY_DECISIONS_LIMIT');
        platformSummary = { sourceCount: summary.sourceCount, activeHoldCount: summary.activeHoldCount };
      }
      try {
        let snapshot = sources.collect();
        if (initialPlatformOnly && snapshot.length) {
          // Archive 尚未装配，不开始平台调用；owner 阶段接续同一预算和期限。
          deferredStartupBudget = budget;
          return { ready: false, sourceCount: snapshot.length, ...budget.snapshot(), completedSources,
            blockedScopeCount: 0, reason: 'ARCHIVE_OWNER_PHASE_REQUIRED' };
        }
        await scan();
        while (snapshot.length > 0) {
          const groups = new Map();
          const byKey = new Map(snapshot.map((source) => [sourceKey(source), source]));
          for (const source of snapshot) {
            if (!groups.has(source.conflictScopeKey)) groups.set(source.conflictScopeKey, []);
            groups.get(source.conflictScopeKey).push(source);
          }
          let madeProgress = false;
          let steps = 0;
          for (const [scope, queue] of groups) {
            if (blockedScopes.has(scope)) continue;
            const done = new Set();
            let cursor = 0;
            while (cursor < queue.length) {
              budget.admit();
              const hold = readRepository.getActiveRecoveryHoldByScope(scope);
              const owner = hold ? byKey.get(sourceKey(hold)) : null;
              if (hold && (!owner || !sameSource(owner, hold))) { blockedScopes.add(scope); break; }
              const source = owner && !done.has(sourceKey(owner)) ? owner : queue[cursor++];
              if (done.has(sourceKey(source))) continue;
              if (hold && owner && done.has(sourceKey(owner))) { blockedScopes.add(scope); break; }
              const before = progress(source);
              if (sources.prepareSource) await sources.prepareSource(source);
              const current = await platform.recoverSource(source, hold);
              if (current.blocked || current.inspection && ['unknown', 'partially-committed'].includes(current.inspection.outcome)
                  || current.outcome && current.outcome !== 'completed') {
                blockedScopes.add(scope); break;
              }
              if (current.inspection && current.inspection.outcome === 'not-committed') {
                await sources.finalize(source, current.inspection);
                const freshHold = readRepository.getActiveRecoveryHoldByScope(scope);
                if (freshHold && !sameSource(source, freshHold)) { blockedScopes.add(scope); break; }
                const final = await platform.recoverSource(source, freshHold);
                if (final.blocked || final.held || final.inspection && ['unknown', 'partially-committed'].includes(final.inspection.outcome)
                    || final.outcome && final.outcome !== 'completed') { blockedScopes.add(scope); break; }
              }
              if (sources.afterSource) await sources.afterSource(source);
              const aligned = sources.syncCompletion(source);
              if (aligned || progress(source) !== before) { madeProgress = true; completedSources += 1; }
              done.add(sourceKey(source));
              steps += 1;
              if (steps % budget.limits.yieldEvery === 0) await yieldMain();
            }
          }
          if (!madeProgress) { reason = 'NO_DURABLE_PROGRESS'; break; }
          // 新回收/读者来源在轮次边界完整枚举，不增加平台全量扫描。
          snapshot = sources.collect();
          if (snapshot.length && snapshot.every((source) => blockedScopes.has(source.conflictScopeKey))) {
            reason = 'SCOPE_BLOCKED'; break;
          }
        }
        if (!reason && blockedScopes.size === 0) {
          // 上一轮的完整枚举就是本次最终快照；初始空快照仍需重新完整枚举。
          if (budget.snapshot().enumerations === 1) sources.collect();
          await scan();
          if (openObligations()) reason = 'FINAL_OBLIGATIONS_PENDING';
          else admission.markRecovered();
        }
      } catch (error) {
        reason = error.code || 'BIZOP_RECOVERY_FAILED';
      } finally { sources.clear(); }
      return Object.freeze({ ready: admission.snapshot().recoveryReady,
        sourceCount: platformSummary?.sourceCount || 0, activeHoldCount: platformSummary?.activeHoldCount || 0,
        ...budget.snapshot(), completedSources, blockedScopeCount: blockedScopes.size, reason });
    }, { recovery: true });
  }
  return Object.freeze({
    bindPlatform(value) {
      if (platform || !value || typeof value.scanAndRecover !== 'function' || typeof value.recoverSource !== 'function') {
        fail('BIZOP_RECOVERY_PLATFORM_BINDING_INVALID');
      }
      platform = value;
    },
    run(options) {
      if (pending) return pending;
      pending = runAttempt(options).finally(() => { pending = null; });
      return pending;
    }, openObligations, hasCompletedPlatformScan: () => platformScanCompleted
  });
}

module.exports = { createBizOpRecoveryDriver };
