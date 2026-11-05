'use strict';

// 设置 → 模板文件：VCC 原表的导入时结构（导入计划与交接成员 Sheet 的 sourceHeaders，仅用户结构时存在）。
//   读取与日后重读原件都按 sourceHeaders 定位表头、按位置读出，再对应回内置列序（canonicalHeaderMapping）：
//   映射、幂等键、content_hash、raw_json 与导出都按内置列，不随结构变化。没有 sourceHeaders 时为内置结构，原样读取。

const { canonicalHeaderMapping } = require('../file-service/header-structure-diff');

function hasSourceHeaders(sourceHeaders) {
  return Array.isArray(sourceHeaders) && sourceHeaders.length > 0;
}

// canonicalHeaders：内置原始结构（明细为 raw contract 表头，系统财务OP 为 16 列）。
//   返回 { headers, indexOf(header), project(values, { keepTail, fill }) }；内置结构时 project 原样返回。
//   keepTail：保留导入时结构宽度之外的单元格（接在内置列之后），供“模板外列”检查使用；fill：置空列的取值（默认空串）。
function createSourceProjection(canonicalHeaders, sourceHeaders) {
  const canonical = [...canonicalHeaders];
  if (!hasSourceHeaders(sourceHeaders)) {
    return Object.freeze({
      custom: false,
      headers: Object.freeze(canonical),
      indexOf: (header) => canonical.indexOf(header),
      project: (values) => values
    });
  }
  const headers = Object.freeze([...sourceHeaders]);
  const { sourceIndex } = canonicalHeaderMapping(canonical, headers);
  return Object.freeze({
    custom: true,
    headers,
    indexOf: (header) => headers.indexOf(header),
    project(values, { keepTail = false, fill = '' } = {}) {
      const row = Array.isArray(values) ? values : [];
      const projected = sourceIndex.map((index) => (index >= 0 && row[index] !== undefined ? row[index] : fill));
      return keepTail ? [...projected, ...row.slice(headers.length)] : projected;
    }
  });
}

module.exports = { createSourceProjection, hasSourceHeaders };
