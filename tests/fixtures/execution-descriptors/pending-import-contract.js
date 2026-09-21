'use strict';

// 隔离治理集成场景的业务合同；只写调用方提供的临时 SQLite。
module.exports = function createContract() {
  return {
    expectedHeaders: ['日期', '主键', '金额'],
    valueColumnWhitelist: null,
    validateHeaders(cells) {
      return cells[0] === '日期' && cells[1] === '主键' && cells[2] === '金额'
        ? { ok: true }
        : { ok: false, error: '表头不匹配', detailLines: [] };
    },
    mapRow({ values }) {
      const key = String(values[1] || '').trim();
      return key
        ? { params: [values[0], key, values[2]] }
        : { error: { reason: '主键为空' } };
    },
    insertSql: 'INSERT INTO imported_rows (d, k, amount) VALUES (?, ?, ?)',
    requiredColumns: [0, 1, 2],
    monthKeyOf({ values }) { return String(values[0]).slice(0, 7); },
    deleteSqlForOverwrite: 'DELETE FROM imported_rows WHERE d LIKE ?',
    deleteParamsFromMonthKey(monthKey) { return [monthKey + '%']; }
  };
};
