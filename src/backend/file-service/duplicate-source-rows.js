'use strict';

// v3.2.19：原始账单预处理「重复账单过滤」（spec §8.3）。纯函数，不读写文件与数据库。
// - buildMappedRows 在开启时为每个进入映射的源行（已经过「过滤账单」）按整行（含模板表头范围以外的列）算内容指纹，
//   写在 rowMetas[i].sourceRowKey。
// - scanDuplicateSourceRows 在一次导入的全部文件（大账号分配之后的映射结果）中找重复：
//   内容指纹相同 且 账户（该源行全部输出行的 MerchantId + 币种）相同 且 账期（BillDate）相同；
//   只比较会导出为明细行的源行（与 buildDetailExportRows 共用 isDetailExportAmountRow），合计行等不产出明细的行不参与；
//   任一输出行没有账户号（MerchantId 为空）的源行无法证明账户相同，也不参与（保留，不删）。
//   每组按（文件顺序, 源行号）保留第一行，其余进入删除计划。
// - dropDuplicateSourceRows 按删除计划去掉这些源行的全部输出行（拆分出的多行一起去掉）及其提示。
const crypto = require('node:crypto');
const path = require('node:path');
const { normalizeCell } = require('./common');
const { isDetailExportAmountRow, isZeroOrBlankAmount } = require('./normalizers');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// 文本单元格序列化为去首尾空白后的字符串；Excel 错误值（读取时标为 { excelError }）序列化为对象，
//   与任何文本（含同文字的文本、空白）都不同。文本型工作簿中被推断为数值等的单元格（读取时标为 { sourceText }）按原文比较。
function normalizeFingerprintCell(cell) {
  if (cell && typeof cell === 'object' && typeof cell.excelError === 'string') return { excelError: cell.excelError };
  if (cell && typeof cell === 'object' && typeof cell.sourceText === 'string') return normalizeCell(cell.sourceText);
  return normalizeCell(cell);
}

// 读取时标为值未知的单元格：公式（{ unknownFormula }）、整行或编码无法证明的值（{ unknownValue }）
function hasUnknownCell(cells) {
  return (Array.isArray(cells) ? cells : []).some((cell) => cell && typeof cell === 'object'
    && (typeof cell.unknownFormula === 'string' || typeof cell.unknownValue === 'string'));
}

// 按 Excel 物理列对齐：去掉首尾空白单元格，记录首个非空单元格的绝对列号（columnOffset 为第 0 个单元格的物理列），
//   不同文件有效范围的起始列不同也按同一列比较，且不为前导空列分配空间。
function normalizeAlignedCells(cells, columnOffset) {
  const normalized = (Array.isArray(cells) ? cells : []).map((cell) => normalizeFingerprintCell(cell));
  while (normalized.length && normalized[normalized.length - 1] === '') normalized.pop();
  let start = 0;
  while (start < normalized.length && normalized[start] === '') start += 1;
  return [start < normalized.length ? columnOffset + start : 0, normalized.slice(start)];
}

// 整行的表头与单元格（含模板表头范围以外的列，按 Excel 物理列对齐）去首尾空白后整体比较；表头不同的文件之间不会相同。
// 首尾空白单元格不影响结果。不做数值换算。含没有缓存结果的公式（值未知）时返回 ''：无法证明整行相同，该行不参与查重。
function buildSourceRowKey(headers, row, { columnOffset = 0 } = {}) {
  if (hasUnknownCell(headers) || hasUnknownCell(row)) return '';
  const offset = Number.isInteger(columnOffset) && columnOffset > 0 ? columnOffset : 0;
  return sha256(JSON.stringify([normalizeAlignedCells(headers, offset), normalizeAlignedCells(row, offset)]));
}

function fieldIndex(headerRow, field) {
  const index = (Array.isArray(headerRow) ? headerRow : []).findIndex((cell) => normalizeCell(cell) === field);
  return index >= 0 ? index : null;
}

function cellAt(row, index) {
  return index === null ? '' : normalizeCell(row && row[index]);
}

// 与明细导出同一口径：会导出为明细行的输出行才参与查重（不能解析的金额照常导出，也照常参与）
function isDetailOutputRow(row, creditIndex, debitIndex) {
  return isDetailExportAmountRow(
    creditIndex === null ? '' : row && row[creditIndex],
    debitIndex === null ? '' : row && row[debitIndex],
    { hasCredit: creditIndex !== null, hasDebit: debitIndex !== null }
  );
}

// 收、支两列都在且都不为空或 0：明细导出时按收支同时有值报错（同 buildDetailExportRows）
function isAmountConflictRow(row, creditIndex, debitIndex) {
  if (creditIndex === null || debitIndex === null) return false;
  return !isZeroOrBlankAmount(row && row[creditIndex]) && !isZeroOrBlankAmount(row && row[debitIndex]);
}

function entryFileName(entry) {
  const filePath = String(entry && entry.filePath || '');
  return filePath && filePath !== '__cached__' ? path.basename(filePath) : filePath;
}

// 一个文件中带指纹、产出明细行且有账户号的源行：[{ sourceRowNumber, key, accountKey, accounts, billDate }]（按源行号升序）。
function collectCandidateSourceRows(detailRows) {
  const rows = Array.isArray(detailRows) ? detailRows : [];
  const metas = Array.isArray(rows.rowMetas) ? rows.rowMetas : [];
  const header = rows[0] || [];
  const creditIndex = fieldIndex(header, 'Credit Amount');
  const debitIndex = fieldIndex(header, 'Debit Amount');
  const merchantIndex = fieldIndex(header, 'MerchantId');
  const currencyIndex = fieldIndex(header, 'Currency');
  const billDateIndex = fieldIndex(header, 'BillDate');
  const bySourceRow = new Map();
  for (let index = 1; index < rows.length; index += 1) {
    const meta = metas[index - 1];
    const key = meta && typeof meta.sourceRowKey === 'string' ? meta.sourceRowKey : '';
    const sourceRowNumber = Number(meta && meta.sourceRowNumber);
    if (!key || !Number.isInteger(sourceRowNumber)) continue;
    let item = bySourceRow.get(sourceRowNumber);
    if (!item) {
      item = { sourceRowNumber, key, accounts: new Map(), billDate: '', hasDetailOutput: false, missingAccount: false, hasAmountConflict: false };
      bySourceRow.set(sourceRowNumber, item);
    }
    const row = rows[index];
    const merchantId = cellAt(row, merchantIndex);
    const currency = cellAt(row, currencyIndex);
    if (!merchantId) item.missingAccount = true;
    // 账户按（账户号, 币种）二元组比较，序列化成无歧义的键（账户号里可能有任意字符）
    item.accounts.set(JSON.stringify([merchantId, currency]), { merchantId, currency });
    if (!item.billDate) item.billDate = cellAt(row, billDateIndex);
    if (isDetailOutputRow(row, creditIndex, debitIndex)) item.hasDetailOutput = true;
    if (isAmountConflictRow(row, creditIndex, debitIndex)) item.hasAmountConflict = true;
  }
  // 任一输出行收、支同时有值（拆分出的某一笔也算）：该源行生成时须报错，不参与查重（删除它会掩盖报错）
  return Array.from(bySourceRow.values())
    // 账期为空的源行无法证明与另一行同一账期（两个未知账期不能算相同），不参与查重
    .filter((item) => item.hasDetailOutput && !item.missingAccount && !item.hasAmountConflict && item.billDate !== '')
    .sort((left, right) => left.sourceRowNumber - right.sourceRowNumber)
    .map((item) => {
      const accountKeys = Array.from(item.accounts.keys()).sort();
      return {
        sourceRowNumber: item.sourceRowNumber,
        key: item.key,
        accountKey: JSON.stringify(accountKeys),
        accounts: accountKeys.map((accountKey) => ({ ...item.accounts.get(accountKey) })),
        billDate: item.billDate
      };
    });
}

// entries：[{ filePath, detailRows }]，顺序即导入文件顺序。
// 返回 { groups, dropPlan, droppedRowCount, digest }：
//   groups[{ accounts, billDate, rows: [{ fileIndex, fileName, sourceRowNumber, kept }] }]（按首行出现顺序）；
//   dropPlan[fileIndex] 为该文件要删除的源行号（升序）；
//   digest 含文件序号、行号、指纹、账户与账期（弹窗展示的内容都在内），不含路径（确认续跑会把路径换成冻结副本）。
function scanDuplicateSourceRows(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const groupsByKey = new Map();
  const orderedGroups = [];
  list.forEach((entry, fileIndex) => {
    // 查重范围（duplicateScope，调用方按生成组标注）：不同范围的相同行不互判重复
    const scope = entry && entry.duplicateScope !== undefined ? String(entry.duplicateScope) : '';
    collectCandidateSourceRows(entry && entry.detailRows).forEach((candidate) => {
      const groupKey = JSON.stringify([scope, candidate.key, candidate.accountKey, candidate.billDate]);
      let group = groupsByKey.get(groupKey);
      if (!group) {
        group = { key: candidate.key, accountKey: candidate.accountKey, accounts: candidate.accounts, billDate: candidate.billDate, rows: [] };
        groupsByKey.set(groupKey, group);
        orderedGroups.push(group);
      }
      group.rows.push({ fileIndex, fileName: entryFileName(entry), sourceRowNumber: candidate.sourceRowNumber });
    });
  });
  const dropPlan = list.map(() => []);
  const groups = orderedGroups
    .filter((group) => group.rows.length > 1)
    .map((group) => {
      const rows = group.rows.map((row, index) => ({ ...row, kept: index === 0 }));
      rows.slice(1).forEach((row) => dropPlan[row.fileIndex].push(row.sourceRowNumber));
      return { key: group.key, accountKey: group.accountKey, accounts: group.accounts, billDate: group.billDate, rows };
    });
  dropPlan.forEach((rowNumbers) => rowNumbers.sort((left, right) => left - right));
  const droppedRowCount = dropPlan.reduce((sum, rowNumbers) => sum + rowNumbers.length, 0);
  const digest = groups.length
    ? sha256(JSON.stringify(groups.map((group) => [
        group.key,
        group.accountKey,
        group.billDate,
        group.rows.map((row) => [row.fileIndex, row.sourceRowNumber, row.kept])
      ])))
    : '';
  return { groups, dropPlan, droppedRowCount, digest };
}

// 复制明细行数组上的附加属性（含不可枚举的 bigAccountRecognitionBasis），只换数据行。
function cloneDetailRowsWith(detailRows, keptRows) {
  const next = keptRows;
  Object.getOwnPropertyNames(detailRows).forEach((name) => {
    if (name === 'length' || /^\d+$/.test(name)) return;
    Object.defineProperty(next, name, Object.getOwnPropertyDescriptor(detailRows, name));
  });
  return next;
}

// 按删除计划去掉源行的全部输出行（rowMetas 同步）及这些行的提示；不改原数组，没有要删的文件原样返回。
function dropDuplicateSourceRows(entries, scan) {
  const list = Array.isArray(entries) ? entries : [];
  const dropPlan = scan && Array.isArray(scan.dropPlan) ? scan.dropPlan : [];
  // 每个有删除行的文件：保留行所在的其他文件（之后单独覆盖这些文件会让被删的交易无处保留，导入时据此拦下）
  const keeperFileIndexes = list.map(() => new Set());
  (scan && Array.isArray(scan.groups) ? scan.groups : []).forEach((group) => {
    const kept = group.rows.find((row) => row.kept);
    if (!kept) return;
    group.rows.forEach((row) => {
      if (!row.kept && row.fileIndex !== kept.fileIndex && keeperFileIndexes[row.fileIndex]) {
        keeperFileIndexes[row.fileIndex].add(kept.fileIndex);
      }
    });
  });
  return list.map((entry, fileIndex) => {
    const rowNumbers = Array.isArray(dropPlan[fileIndex]) ? dropPlan[fileIndex] : [];
    const detailRows = entry && entry.detailRows;
    if (!rowNumbers.length || !Array.isArray(detailRows)) return entry;
    const dropSet = new Set(rowNumbers);
    const metas = Array.isArray(detailRows.rowMetas) ? detailRows.rowMetas : [];
    const keptRows = [detailRows[0]];
    const keptMetas = [];
    for (let index = 1; index < detailRows.length; index += 1) {
      const meta = metas[index - 1];
      if (meta && dropSet.has(Number(meta.sourceRowNumber))) continue;
      keptRows.push(detailRows[index]);
      keptMetas.push(meta);
    }
    const nextRows = cloneDetailRowsWith(detailRows, keptRows);
    nextRows.rowMetas = keptMetas;
    if (Array.isArray(detailRows.issues)) {
      nextRows.issues = detailRows.issues.filter((issue) => !(issue && dropSet.has(Number(issue.rowNumber))));
    }
    nextRows.duplicateRowFilterStats = {
      droppedRowNumbers: rowNumbers.slice(),
      droppedRowCount: rowNumbers.length,
      keptInFilePaths: Array.from(keeperFileIndexes[fileIndex] || [])
        .sort((left, right) => left - right)
        .map((keeperIndex) => String(list[keeperIndex] && list[keeperIndex].filePath || ''))
        .filter(Boolean)
    };
    return { ...entry, detailRows: nextRows };
  });
}

// 导入会话中，覆盖 replacePaths 会破坏哪些已确认的跨文件去重关系（双向检查，关系两端须一起覆盖，一起导入时重新查重）：
//   - 未被覆盖的文件，其去除行只保留在将被覆盖的文件里 → 覆盖后这些交易无处保留（少记）；
//   - 将被覆盖的文件，其去除行保留在未被覆盖的文件里 → 单独重新导入会把去除行带回来（与保留行重复记）。
//   去重关系可以连成链（A 保留了 B 的行、B 又保留了 C 的行），按连通的整组判断：
//   返回 [{ filePaths }]，每项为一组通过去重关系（含间接）相连、只有一部分被覆盖的文件（按会话顺序），
//   提示列出整组，用户按提示一起重新导入即可，不会沿关系链来回提示。
function findDuplicateKeeperReplacementConflicts(sessionEntries, replacePaths) {
  const replaced = new Set((Array.isArray(replacePaths) ? replacePaths : []).map((filePath) => path.resolve(String(filePath))));
  if (!replaced.size) return [];
  const order = [];
  const displayPath = new Map();
  const adjacency = new Map();
  const addNode = (filePath) => {
    const key = path.resolve(String(filePath));
    if (!adjacency.has(key)) {
      adjacency.set(key, new Set());
      displayPath.set(key, String(filePath));
      order.push(key);
    }
    return key;
  };
  (Array.isArray(sessionEntries) ? sessionEntries : []).forEach((entry) => {
    if (!entry || !entry.filePath) return;
    const node = addNode(entry.filePath);
    const stats = entry.detailRows && entry.detailRows.duplicateRowFilterStats;
    const keepers = stats && Array.isArray(stats.keptInFilePaths) ? stats.keptInFilePaths : [];
    keepers.forEach((keeper) => {
      const keeperNode = addNode(keeper);
      adjacency.get(node).add(keeperNode);
      adjacency.get(keeperNode).add(node);
    });
  });
  const position = new Map(order.map((key, index) => [key, index]));
  const visited = new Set();
  const conflicts = [];
  order.forEach((start) => {
    if (visited.has(start)) return;
    const component = [];
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const key = queue.shift();
      component.push(key);
      adjacency.get(key).forEach((next) => {
        if (visited.has(next)) return;
        visited.add(next);
        queue.push(next);
      });
    }
    const replacedCount = component.filter((key) => replaced.has(key)).length;
    if (replacedCount === 0 || replacedCount === component.length) return;
    conflicts.push({
      filePaths: component.sort((left, right) => position.get(left) - position.get(right)).map((key) => displayPath.get(key))
    });
  });
  return conflicts;
}

// 覆盖提示：列出须一起重新导入的整组文件（文件名只在弹窗中显示，不写日志）。返回 { message, detailLines }。
function describeDuplicateKeeperReplacementConflicts(conflicts) {
  const list = Array.isArray(conflicts) ? conflicts : [];
  const quote = (filePath) => `「${path.basename(String(filePath))}」`;
  const relatedNames = Array.from(new Set(list.flatMap((conflict) => (
    Array.isArray(conflict && conflict.filePaths) ? conflict.filePaths : []
  )))).map(quote).join('、');
  return {
    message: `上次导入时${relatedNames}之间去除过重复账单，只覆盖其中一部分会让交易丢失或重复入账，请把${relatedNames}一起重新导入`,
    detailLines: list.map((conflict) => `须一起重新导入：${(Array.isArray(conflict && conflict.filePaths) ? conflict.filePaths : []).map(quote).join('、')}`)
  };
}

module.exports = {
  buildSourceRowKey,
  describeDuplicateKeeperReplacementConflicts,
  findDuplicateKeeperReplacementConflicts,
  dropDuplicateSourceRows,
  scanDuplicateSourceRows
};
