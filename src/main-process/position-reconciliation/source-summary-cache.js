'use strict';

const POSITION_SOURCE_SUMMARY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS position_source_summaries (
    source_type TEXT PRIMARY KEY,
    raw_row_count INTEGER NOT NULL DEFAULT 0,
    raw_date_min TEXT,
    raw_date_max TEXT,
    raw_updated_at TEXT,
    source_months_json TEXT NOT NULL DEFAULT '[]',
    linked_row_count INTEGER NOT NULL DEFAULT 0,
    linked_date_min TEXT,
    linked_date_max TEXT,
    linked_updated_at TEXT,
    refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

function ensurePositionSourceSummaryCache(db) {
  db.exec(POSITION_SOURCE_SUMMARY_SCHEMA);
}

function revisionTimestamp(db, kind, sourceType) {
  const row = db.prepare(`
    SELECT updated_at AS updatedAt
    FROM position_revisions
    WHERE kind = ? AND scope_key = ?
  `).get(kind, sourceType);
  return row && row.updatedAt ? String(row.updatedAt) : '';
}

function normalizeMonths(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    if (!Array.isArray(parsed)) return null;
    const months = parsed.map((item) => String(item || '')).filter(Boolean);
    return months.length === parsed.length ? months : null;
  } catch (_error) {
    return null;
  }
}

function normalizeSummaryRow(row) {
  if (!row) return null;
  const sourceMonths = normalizeMonths(row.sourceMonthsJson);
  const rawRowCount = Number(row.rawRowCount);
  const linkedRowCount = Number(row.linkedRowCount);
  if (!sourceMonths
      || !Number.isSafeInteger(rawRowCount)
      || rawRowCount < 0
      || !Number.isSafeInteger(linkedRowCount)
      || linkedRowCount < 0) {
    return null;
  }
  return {
    sourceType: String(row.sourceType || ''),
    rawRowCount,
    rawDateMin: row.rawDateMin || '',
    rawDateMax: row.rawDateMax || '',
    rawUpdatedAt: row.rawUpdatedAt || '',
    sourceMonths,
    linkedRowCount,
    linkedDateMin: row.linkedDateMin || '',
    linkedDateMax: row.linkedDateMax || '',
    linkedUpdatedAt: row.linkedUpdatedAt || ''
  };
}

function readPositionSourceSummary(db, sourceType) {
  ensurePositionSourceSummaryCache(db);
  return normalizeSummaryRow(db.prepare(`
    SELECT source_type AS sourceType,
           raw_row_count AS rawRowCount,
           raw_date_min AS rawDateMin,
           raw_date_max AS rawDateMax,
           raw_updated_at AS rawUpdatedAt,
           source_months_json AS sourceMonthsJson,
           linked_row_count AS linkedRowCount,
           linked_date_min AS linkedDateMin,
           linked_date_max AS linkedDateMax,
           linked_updated_at AS linkedUpdatedAt
    FROM position_source_summaries
    WHERE source_type = ?
  `).get(sourceType));
}

function refreshPositionSourceSummary(db, sourceType, {
  refreshRaw = true,
  refreshLinked = true,
  onPhase = null
} = {}) {
  ensurePositionSourceSummaryCache(db);
  const existing = readPositionSourceSummary(db, sourceType);
  const shouldRefreshRaw = refreshRaw || !existing;
  const shouldRefreshLinked = refreshLinked || !existing;
  const emit = (phase) => {
    if (typeof onPhase === 'function') onPhase(phase);
  };

  let raw = existing ? {
    rowCount: existing.rawRowCount,
    dateMin: existing.rawDateMin,
    dateMax: existing.rawDateMax,
    updatedAt: existing.rawUpdatedAt,
    months: existing.sourceMonths
  } : {
    rowCount: 0,
    dateMin: '',
    dateMax: '',
    updatedAt: '',
    months: []
  };
  if (shouldRefreshRaw) {
    emit('raw');
    const aggregate = db.prepare(`
      SELECT COUNT(*) AS rowCount, MIN(event_date) AS dateMin,
             MAX(event_date) AS dateMax, MAX(updated_at) AS updatedAt
      FROM position_source_rows
      WHERE source_type = ?
    `).get(sourceType);
    emit('months');
    const months = db.prepare(`
      SELECT month_key AS monthKey
      FROM position_source_rows
      WHERE source_type = ?
        AND month_key IS NOT NULL
        AND TRIM(month_key) <> ''
      GROUP BY month_key
      ORDER BY month_key
    `).all(sourceType).map((row) => String(row.monthKey));
    raw = {
      rowCount: Number(aggregate.rowCount),
      dateMin: aggregate.dateMin || '',
      dateMax: aggregate.dateMax || '',
      updatedAt:
        revisionTimestamp(db, 'source', sourceType)
        || aggregate.updatedAt
        || '',
      months
    };
  }

  let linked = existing ? {
    rowCount: existing.linkedRowCount,
    dateMin: existing.linkedDateMin,
    dateMax: existing.linkedDateMax,
    updatedAt: existing.linkedUpdatedAt
  } : {
    rowCount: 0,
    dateMin: '',
    dateMax: '',
    updatedAt: ''
  };
  if (shouldRefreshLinked) {
    emit('linked');
    const aggregate = db.prepare(`
      SELECT COUNT(*) AS rowCount, MIN(event_date) AS dateMin,
             MAX(event_date) AS dateMax, MAX(created_at) AS updatedAt
      FROM position_link_rows
      WHERE source_type = ? AND visible = 1
    `).get(sourceType);
    linked = {
      rowCount: Number(aggregate.rowCount),
      dateMin: aggregate.dateMin || '',
      dateMax: aggregate.dateMax || '',
      updatedAt:
        revisionTimestamp(db, 'linked', sourceType)
        || aggregate.updatedAt
        || raw.updatedAt
        || ''
    };
  }

  db.prepare(`
    INSERT INTO position_source_summaries(
      source_type, raw_row_count, raw_date_min, raw_date_max, raw_updated_at,
      source_months_json, linked_row_count, linked_date_min, linked_date_max,
      linked_updated_at, refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(source_type) DO UPDATE SET
      raw_row_count = excluded.raw_row_count,
      raw_date_min = excluded.raw_date_min,
      raw_date_max = excluded.raw_date_max,
      raw_updated_at = excluded.raw_updated_at,
      source_months_json = excluded.source_months_json,
      linked_row_count = excluded.linked_row_count,
      linked_date_min = excluded.linked_date_min,
      linked_date_max = excluded.linked_date_max,
      linked_updated_at = excluded.linked_updated_at,
      refreshed_at = CURRENT_TIMESTAMP
  `).run(
    sourceType,
    raw.rowCount,
    raw.dateMin || null,
    raw.dateMax || null,
    raw.updatedAt || null,
    JSON.stringify(raw.months),
    linked.rowCount,
    linked.dateMin || null,
    linked.dateMax || null,
    linked.updatedAt || null
  );
  emit('done');
  return readPositionSourceSummary(db, sourceType);
}

module.exports = {
  POSITION_SOURCE_SUMMARY_SCHEMA,
  ensurePositionSourceSummaryCache,
  readPositionSourceSummary,
  refreshPositionSourceSummary
};
