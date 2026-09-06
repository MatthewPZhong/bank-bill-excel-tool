'use strict';

const { fail, snapshot, hash } = require('./contracts');
const { outputName } = require('./export-cells');

function month(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) fail('BIZOP_OPERATION_MONTH_INVALID', '请选择有效的操作月份');
  return value;
}
function pageSize(value = 200) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) fail('BIZOP_PAGE_SIZE_INVALID');
  return value;
}
function createBizOpMetadata({ catalog, admission }) {
  const { db } = catalog;
  function currentInput({ kind, dataDate } = {}) {
    if (!['OP', 'FLOW'].includes(kind) || typeof dataDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dataDate)
        || !Number.isFinite(Date.parse(`${dataDate}T00:00:00Z`)) || new Date(`${dataDate}T00:00:00Z`).toISOString().slice(0, 10) !== dataDate) fail('BIZOP_INPUT_DATE_INVALID', '请选择有效账期');
    return admission.read(() => {
      const row = db.prepare(`SELECT d.dataset_id AS objectId,d.public_version AS version FROM biz_op_v327_input_heads h
        JOIN biz_op_v327_datasets d USING(dataset_id) WHERE h.kind=? AND h.data_date=? AND d.state='ACTIVE'`).get(kind, dataDate);
      if (!row) fail('BIZOP_INPUT_MISSING', '该账期没有当前可用输入，请先导入文件');
      return { ...row, kind, dataDate };
    });
  }
  function listMonths({ before = null, limit = 200 } = {}) {
    pageSize(limit); if (before !== null) month(before);
    return admission.read(() => {
      const values = db.prepare(`SELECT operation_month FROM (
        SELECT substr(activated_at,1,7) AS operation_month FROM biz_op_v327_datasets WHERE state='ACTIVE'
        UNION SELECT operation_month FROM biz_op_v327_runs WHERE state='PUBLISHED')
        WHERE (? IS NULL OR operation_month<?) ORDER BY operation_month DESC LIMIT ?`).all(before, before, limit + 1)
        .map((row) => row.operation_month);
      return { months: values.slice(0, limit), nextBefore: values.length > limit ? values[limit - 1] : null };
    });
  }
  function list(input) {
    const { view, kind = 'OP', operationMonth, cursor = null, limit = 200, generation } = input || {};
    if (!['RESULT', 'CHECK', 'RAW'].includes(view) || !['OP', 'FLOW'].includes(kind)) fail('BIZOP_LIST_VIEW_INVALID');
    month(operationMonth); pageSize(limit);
    return admission.read(() => {
      const currentGeneration = catalog.control().generation;
      if (generation !== undefined && generation !== currentGeneration) fail('BIZOP_GENERATION_CHANGED', '数据已变化，请刷新列表');
      const scope = hash({ view, kind, operationMonth, generation: currentGeneration });
      let after = { time: '\uffff', id: '', order: -1 };
      if (cursor !== null) {
        try {
          if (typeof cursor !== 'string' || cursor.length > 1024) throw new Error();
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          if (decoded.scope !== scope || typeof decoded.time !== 'string' || typeof decoded.id !== 'string'
              || !Number.isSafeInteger(decoded.order)) throw new Error();
          after = decoded;
        } catch (_error) { fail('BIZOP_LIST_CURSOR_INVALID', '列表已变化，请从第一页重新选取'); }
      }
      let rows;
      if (view === 'RESULT') {
        rows = db.prepare(`SELECT * FROM biz_op_v327_runs WHERE state='PUBLISHED' AND operation_month=?
          AND (published_at<? OR (published_at=? AND run_id>?)) ORDER BY published_at DESC,run_id LIMIT ?`)
          .all(operationMonth, after.time, after.time, after.id, limit + 1).map((row) => ({
            objectId: row.run_id, rowKey: row.run_id, startDate: row.start_date, endDate: row.end_date,
            tableName: outputName('RESULT_DIFF', { startDate: row.start_date, endDate: row.end_date, version: row.result_version }),
            version: row.result_version, updatedAt: row.published_at, operationMonth: row.operation_month,
            fullRowCount: row.full_row_count, diffRowCount: row.diff_row_count,
            _cursor: { time: row.published_at, id: row.run_id, order: 0 } }));
      } else {
        const raw = view === 'RAW';
        const order = raw ? 's.source_file_order' : '0';
        rows = db.prepare(`SELECT d.*${raw ? ',s.source_file_name,s.source_file_order' : ''}
          FROM biz_op_v327_datasets d ${raw ? 'JOIN biz_op_v327_dataset_sources s USING(dataset_id)' : ''}
          WHERE d.state='ACTIVE' AND d.kind=? AND substr(d.activated_at,1,7)=? AND
          (d.activated_at<? OR (d.activated_at=? AND d.dataset_id>?)
          OR (d.activated_at=? AND d.dataset_id=? AND ${order}>?))
          ORDER BY d.activated_at DESC,d.dataset_id${raw ? ',s.source_file_order' : ''} LIMIT ?`)
          .all(kind, operationMonth, after.time, after.time, after.id, after.time, after.id, after.order, limit + 1)
          .map((row) => ({ objectId: row.dataset_id, rowKey: `${row.dataset_id}:${row.source_file_order ?? 0}`,
            kind, dataDate: row.data_date, tableName: outputName(`${kind}_${view}`, { dataDate: row.data_date, version: row.public_version }),
            version: row.public_version, updatedAt: row.activated_at, operationMonth: row.activated_at.slice(0, 7),
            rowCount: row.row_count, ...(raw ? { originalName: row.source_file_name } : {}),
            _cursor: { time: row.activated_at, id: row.dataset_id, order: row.source_file_order ?? 0 } }));
      }
      const hasMore = rows.length > limit; rows = rows.slice(0, limit);
      const nextCursor = hasMore ? Buffer.from(JSON.stringify({ scope, ...rows.at(-1)._cursor })).toString('base64url') : null;
      return snapshot({ generation: currentGeneration, rows: rows.map(({ _cursor, ...row }) => row), nextCursor }, { maxBytes: 245760 });
    });
  }
  return { list, listMonths, currentInput };
}
module.exports = { createBizOpMetadata, month, pageSize };
