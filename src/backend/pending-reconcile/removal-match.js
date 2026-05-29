// v2.1.11 T2 — missing ↔ 移除归档 匹配（🔴 资金/对账红线）
//
// 目标（PRD §2.2 / spec §3.4 / D-T2-2 对账后自动）：
//   对账(上月 vs 本月)产出 diff_rows 后，用对账规则 matchFields 把该 run 的 `missing` 行
//   （upper_row_id → pending_rows 值）与 removed_pending_rows(upperMonth) 配对，
//   结果写 pending_removal_matches；配对后再用 compareFields（共用对账规则）做内容核对，供导出
//   标记三态"核对无误 / 核对有差异：… / missing有_移除无"（compareMatchedContent），及 sheetB"移除有_missing无"。
//
// ⚠️ 配对语义必须与 pending-reconcile/engine.js runReconciliation 完全一致（资金红线，不另造规则）：
//   - 多轮 fallback：外层遍历 matchFields，第 n 轮用第 n 个字段做 key（单字段相等即配对）。
//   - 每轮：未匹配的两侧行，按单字段 key 分组；key 为空（null / ''）的行跳过（engine SQL
//     `field IS NOT NULL AND field <> ''`）。
//   - 同 key 1 对 1 配对，按 id 升序（engine SELECT ... ORDER BY id）；取前 min(左,右) 对。
//   - 配对成功的行移出候选池，进入下一轮用下一个字段。
//   - 配对单位：missing 侧用 pending_rows.id（=diff_row.upperRowId）升序，与 engine upper 行
//     的 id 升序一致；removed 侧用 removed_pending_rows.id 升序（listByMonth 已 ORDER BY id）。
//   - 取值：missing 侧值 = pending_rows[field]；removed 侧值 = removed.raw[field]
//     （移除模板前 28 列与 pending_rows 一致；matchField 若是移除模板没有的列 → raw[field]
//      undefined → 视为空跳过，与该侧无此 key 等价）。
//
// 纯函数式，可独立 unit（不依赖 IPC / session）。

const diffRepo = require('../pending-db/diff-repository');
const removedRepo = require('../pending-db/removed-repository');

// ⚠️ C1 资金红线（v2.1.11 SR-FIX Round 1）：数值类 matchField 的比较 key 归一化
//
// 背景：pending 行入库走 streaming-xlsx-reader.js:88-97 —— 数值 cell → `String(parseFloat(v))`
//   （如 "1234.50" → "1234.5"、"1000.00" → "1000"）；移除行走 removed-reader.js:117
//   `sheet_to_json({raw:false})` 取显示格式串（如 "1,234.50" / "1,000.00"，带千分位/尾零）。
//   两侧裸 String 比较 → 同一笔金额因串不等而配不上，被同时误报在「missing有_移除无」+
//   「移除有_missing无」两张 sheet（对账人据此误判）。
//
// 修复：比较 key 时，对数值类字段两侧统一归一化到与 pending 入库一致的口径
//   —— parseNumber（去千分位）后 `String(number)`（= ExcelJS / streaming-reader 的 `String(parseFloat)` 同款）。
//   非数值字段保持原字符串比较（order_no/recon_id 等不变）。
//   ⚠️ 归一化仅用于「比较 key」分桶 —— 不改 raw_json，导出 sheetB 仍用 removedRow.raw 原样显示值。
//
// 口径来源：与 scenario-engines（c2-offset-bill-mark.js:94 / c3-gateway-recon-join.js:55）的
//   isNumericFieldName + engine-utils.parseNumber 一致；此处内联同款，避免 backend 反向依赖 main-process。

// 数值字段启发式（与 C3 口径一致，取最宽集合）：含 Amount/Fee/金额/数额/发生额 关键词
function isNumericFieldName(fieldName) {
  const name = String(fieldName || '');
  return /Amount|Fee|金额|数额|发生额/.test(name);
}

// 数值规范化（与 engine-utils.parseNumber 同款）：去千分位 + trim → number 或 null
function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const cleaned = String(value).replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 把单侧字段值规范化成「比较 key」：数值字段 → String(parseNumber)（对齐 pending 入库 String(parseFloat)）；
//   非数值字段 → 原串。解析失败（parseNumber 返回 null）的数值字段回退原串（不丢非数值脏数据的可比性）。
function normalizeCompareKey(rawValue, field) {
  if (rawValue === '') return '';
  if (!isNumericFieldName(field)) return rawValue;
  const n = parseNumber(rawValue);
  return n === null ? rawValue : String(n);
}

// 读 pending_rows 单行指定字段值（已归一化为比较 key）；行不存在或字段不存在 → ''
// 与 engine 一致：值统一 String 化、null/undefined → ''；数值字段额外按 C1 口径归一化
function readPendingFieldValue(db, rowId, field) {
  if (rowId == null) return '';
  const row = db.prepare(`SELECT \`${field}\` AS v FROM pending_rows WHERE id = ?`).get(rowId);
  if (!row || row.v == null) return '';
  return normalizeCompareKey(String(row.v), field);
}

// 取 removed 行的字段值（已归一化为比较 key）；优先 raw[field]，否则 ''（与 reader 抽取一致）
function readRemovedFieldValue(removedRow, field) {
  return normalizeCompareKey(readRemovedFieldRaw(removedRow, field), field);
}

// ===== v2.1.11 T2 手测增强：状态列内容核对取「原始值」 =====
// 上面 read*FieldValue 返回归一化后的「比较 key」（数值字段去千分位/尾零）—— 用于配对 + 一致性判定。
// 内容核对的「差异文字」要显示用户能对上的原始值（如 "1,234.50"、"1234.5"），不显示归一化后的值，
// 故另出两个「取原始值」函数（口径与 readPending/RemovedFieldValue 完全一致，仅不做 normalizeCompareKey）。

// 取 pending_rows 单行指定字段「原始值」（仅 String 化 / null→''，不归一化）；行或字段不存在 → ''
function readPendingFieldRaw(db, rowId, field) {
  if (rowId == null) return '';
  const row = db.prepare(`SELECT \`${field}\` AS v FROM pending_rows WHERE id = ?`).get(rowId);
  if (!row || row.v == null) return '';
  return String(row.v);
}

// 取 removed 行指定字段「原始值」（仅 String 化 / null→''，不归一化）；优先顶层索引列，否则 raw，否则 ''
function readRemovedFieldRaw(removedRow, field) {
  if (!removedRow) return '';
  if (removedRow[field] !== undefined && removedRow[field] !== null) {
    return String(removedRow[field]);
  }
  if (removedRow.raw && removedRow.raw[field] !== undefined && removedRow.raw[field] !== null) {
    return String(removedRow.raw[field]);
  }
  return '';
}

// 核心匹配。参数：
//   db        — pending DB
//   runId     — diff_runs.id（取该 run 的 missing diff 行）
//   upperMonth— 对账"上月"（missing 来源月 = 移除文件关联月，D-T2-1）
//   matchFields — 对账规则 matchFields（取自 rule-repository.getRule().matchFields）
// 返回 { matchedCount, missingUnmatched, removedUnmatched }
//   matchedCount     — 配上的对数（= 写入 pending_removal_matches 的行数）
//   missingUnmatched — 剩余未配上的 missing 行数（"missing有_移除无"）
//   removedUnmatched — 剩余未配上的 removed 行数（"移除有_missing无"）
function matchRemoval(db, runId, upperMonth, matchFields) {
  const fields = Array.isArray(matchFields)
    ? matchFields.filter((f) => typeof f === 'string' && f)
    : [];

  // 该 run 全部 missing diff 行（含 upperRowId → pending_rows.id）
  const missingRows = diffRepo.listDiffRows(db, runId, 'missing');
  // 该月移除数据（已按 id 升序）
  const removedRows = removedRepo.listByMonth(db, upperMonth);

  // missing 侧按 pending_rows.id（upperRowId）升序——与 engine upper 行 id 升序一致
  const missingSorted = missingRows
    .slice()
    .sort((a, b) => {
      const ua = a.upperRowId == null ? Infinity : a.upperRowId;
      const ub = b.upperRowId == null ? Infinity : b.upperRowId;
      return ua - ub;
    });

  const matchedMissing = new Set();   // diff_row.id
  const matchedRemoved = new Set();   // removed_pending_rows.id
  const insertStmt = db.prepare(
    `INSERT INTO pending_removal_matches (run_id, diff_row_id, removed_row_id, match_field, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const createdAt = new Date().toISOString();
  let matchedCount = 0;

  // I4（v2.1.11 SR-FIX Round 1）：DELETE 旧匹配 + INSERT 新匹配必须在同一事务原子。
  //   旧实现 DELETE 在 BEGIN 之前先自动提交 → 若后续 INSERT 抛错 ROLLBACK，旧匹配已删未重建（脏状态）。
  //   现把 DELETE 移入事务；空集合早返回路径在 DELETE 后单独 COMMIT（保证幂等清旧匹配在无数据时也生效）。
  db.exec('BEGIN');
  try {
    // 先清掉该 run 的旧匹配（幂等：重复对账/重跑匹配不累积）
    db.prepare('DELETE FROM pending_removal_matches WHERE run_id = ?').run(runId);

    // 空 matchFields 或任一侧为空 → 无配对（与 engine "matchFields 为空无法配 key" 防御一致，
    // 但此处不抛错：移除核对是叠加功能，无规则/无数据时静默返回零匹配）。
    // 仍需提交上面的 DELETE（清旧匹配幂等）。
    if (fields.length === 0 || missingRows.length === 0 || removedRows.length === 0) {
      db.exec('COMMIT');
      return {
        matchedCount: 0,
        missingUnmatched: missingRows.length,
        removedUnmatched: removedRows.length
      };
    }

    // 多轮 fallback：每轮一个字段
    for (const field of fields) {
      // removed 侧未匹配行按 key 分组（key→[removed 行，id 升序]；removedRows 已 ORDER BY id）
      const removedByKey = new Map();
      for (const r of removedRows) {
        if (matchedRemoved.has(r.id)) continue;
        const key = readRemovedFieldValue(r, field);
        if (key === '') continue;                 // 空值跳过（engine: field <> ''）
        let bucket = removedByKey.get(key);
        if (!bucket) { bucket = []; removedByKey.set(key, bucket); }
        bucket.push(r);
      }
      if (removedByKey.size === 0) continue;

      // missing 侧未匹配行，按 id 升序逐个尝试取同 key 的下一个 removed 行
      for (const m of missingSorted) {
        if (matchedMissing.has(m.id)) continue;
        const key = readPendingFieldValue(db, m.upperRowId, field);
        if (key === '') continue;                 // 空值跳过
        const bucket = removedByKey.get(key);
        if (!bucket || bucket.length === 0) continue;
        const r = bucket.shift();                 // 同 key 取前一个（id 升序 1 对 1）
        insertStmt.run(runId, m.id, r.id, field, createdAt);
        matchedMissing.add(m.id);
        matchedRemoved.add(r.id);
        matchedCount += 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
    throw err;
  }

  return {
    matchedCount,
    missingUnmatched: missingRows.length - matchedMissing.size,
    removedUnmatched: removedRows.length - matchedRemoved.size
  };
}

// 查某 run 已匹配的 diff_row_id 集合（导出 sheetA "移除核对状态" 列用）
function listMatchedDiffRowIds(db, runId) {
  const rows = db
    .prepare('SELECT diff_row_id FROM pending_removal_matches WHERE run_id = ?')
    .all(runId);
  return new Set(rows.map((r) => Number(r.diff_row_id)));
}

// 查某 run 已匹配的 removed_row_id 集合（导出 sheetB "移除有_missing无" 用：未在此集合的 removed 行）
function listMatchedRemovedRowIds(db, runId) {
  const rows = db
    .prepare('SELECT removed_row_id FROM pending_removal_matches WHERE run_id = ?')
    .all(runId);
  return new Set(rows.map((r) => Number(r.removed_row_id)));
}

// ===== v2.1.11 T2 手测增强：配对成功后用 compareFields（共用对账规则）做「内容核对」→ 状态列三态 =====
//
// 背景（用户需求 2.3 "共用对账规则" = matchFields 配对 + compareFields 比对）：
//   matchRemoval 只做了 matchFields 配对（配上/配不上），漏了 compareFields 内容核对。
//   本函数补上：对每对已配对的 (missing diff 行 ↔ removed 行)，逐 compareField 比对内容是否一致。
//
// 🔴 比对口径红线（与 C1 / pending 对账 changed 同源）：
//   - 一致性判定：两侧用 normalizeCompareKey 归一化后比较（数值字段去千分位/尾零，空值统一当 ''）
//     → "100" vs "100.00"、"1,234.50" vs "1234.5" 判为一致，不误报"核对有差异"。
//   - 差异文字展示：用「原始值」（read*FieldRaw），不显示归一化后的值（用户要能对上原始账单值）。
//   - 取值口径：missing 侧 = pending_rows[field]（按 diff_row.upperRowId）；
//     removed 侧 = removed.raw[field] 或顶层索引列 —— 与 readPending/RemovedFieldValue 完全一致。
//
// 参数：db / runId / compareFields（取自 rule-repository.getRule().compareFields，与对账 changed 同源）
// 返回 Map<diff_row_id(Number), { status:'无误'|'有差异', diffText:string }>
//   - status='无误'：compareFields 全部归一化一致（或 compareFields 为空 → 无可比 → 视为无误）
//   - status='有差异'：≥1 个 compareField 不一致；diffText = '字段A(missing原值≠移除原值); 字段B(...)'
//   仅含「配对成功」的 diff_row_id（未配对的 missing 行不在此 Map，writer 据此填第三态 missing有_移除无）。
function compareMatchedContent(db, runId, compareFields) {
  const fields = Array.isArray(compareFields)
    ? compareFields.filter((f) => typeof f === 'string' && f)
    : [];

  // 该 run 的配对结果：diff_row_id → removed_row_id
  const matchPairs = db
    .prepare('SELECT diff_row_id, removed_row_id FROM pending_removal_matches WHERE run_id = ?')
    .all(runId);

  const result = new Map();
  if (matchPairs.length === 0) return result;

  // diff_row_id → upper_row_id（missing 侧 pending_rows.id）
  const diffRowToUpper = new Map();
  const diffRows = diffRepo.listDiffRows(db, runId, 'missing');
  for (const d of diffRows) diffRowToUpper.set(Number(d.id), d.upperRowId);

  // removed_row_id → removed 行（含 raw + 顶层索引列）；按需建索引避免 N 次全表扫
  const removedById = new Map();
  {
    const stmt = db.prepare(
      `SELECT id, raw_json, order_no, recon_id, \`金额\`, channel, merchant_id, bank_ref
       FROM removed_pending_rows WHERE id = ?`
    );
    for (const p of matchPairs) {
      const rid = Number(p.removed_row_id);
      if (removedById.has(rid)) continue;
      const r = stmt.get(rid);
      if (!r) { removedById.set(rid, null); continue; }
      let raw = {};
      try { const parsed = JSON.parse(r.raw_json); if (parsed && typeof parsed === 'object') raw = parsed; }
      catch (_e) { raw = {}; }
      removedById.set(rid, {
        id: Number(r.id),
        raw,
        order_no: r.order_no, recon_id: r.recon_id, 金额: r['金额'],
        channel: r.channel, merchant_id: r.merchant_id, bank_ref: r.bank_ref
      });
    }
  }

  for (const p of matchPairs) {
    const diffRowId = Number(p.diff_row_id);
    const upperRowId = diffRowToUpper.has(diffRowId) ? diffRowToUpper.get(diffRowId) : null;
    const removedRow = removedById.get(Number(p.removed_row_id)) || null;

    const diffParts = [];
    for (const field of fields) {
      const missingRaw = readPendingFieldRaw(db, upperRowId, field);
      const removedRaw = readRemovedFieldRaw(removedRow, field);
      // 一致性判定用归一化 key（C1 口径）；展示用原始值
      const missingKey = normalizeCompareKey(missingRaw, field);
      const removedKey = normalizeCompareKey(removedRaw, field);
      if (missingKey !== removedKey) {
        diffParts.push(`${field}(${missingRaw}≠${removedRaw})`);
      }
    }

    result.set(diffRowId, diffParts.length === 0
      ? { status: '无误', diffText: '' }
      : { status: '有差异', diffText: diffParts.join('; ') });
  }

  return result;
}

module.exports = {
  matchRemoval,
  listMatchedDiffRowIds,
  listMatchedRemovedRowIds,
  compareMatchedContent,
  // 暴露给测试
  __internal: { readPendingFieldValue, readRemovedFieldValue, readPendingFieldRaw, readRemovedFieldRaw }
};
