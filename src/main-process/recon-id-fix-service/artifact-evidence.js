'use strict';

const path = require('node:path');
const XLSXStyle = require('xlsx-js-style');

const {
  openZipWithEntries,
  readEntryAsString
} = require('../../backend/big-table-import/zip-reader');
const {
  getReconIdFixOutputContract,
  UNMATCHED_REPORT_HEADERS,
  UNMATCHED_REPORT_SHEET_NAME
} = require('../recon-id-fix-io');
const { reconFixEvidenceSha256 } = require('./evidence-projection');

function evidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function workbookContract(artifactKind, subMode) {
  return artifactKind === 'main'
    ? getReconIdFixOutputContract(subMode)
    : Object.freeze({
        sheetName: UNMATCHED_REPORT_SHEET_NAME,
        headers: UNMATCHED_REPORT_HEADERS
      });
}

function xmlAttribute(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

async function readHeaderFontSizes(filePath, headerCount) {
  const { zip, entries } = await openZipWithEntries(path.basename(filePath), filePath, {
    rejectDuplicateEntries: true
  });
  try {
    if (!entries.has('xl/styles.xml') || !entries.has('xl/worksheets/sheet1.xml')) {
      throw evidenceError('RECON_FIX_EXPORT_STYLE_MISMATCH', 'ReconFix workbook 缺少 styles/worksheet part');
    }
    const stylesXml = await readEntryAsString(zip, entries.get('xl/styles.xml'));
    const sheetXml = await readEntryAsString(zip, entries.get('xl/worksheets/sheet1.xml'));
    const fontsSection = stylesXml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/);
    const cellXfsSection = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (!fontsSection || !cellXfsSection) {
      throw evidenceError('RECON_FIX_EXPORT_STYLE_MISMATCH', 'ReconFix workbook style table 不完整');
    }
    const fonts = [...fontsSection[1].matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/g)]
      .map((match) => {
        const sizeTag = match[1].match(/<sz\b[^>]*>/);
        return sizeTag ? Number(xmlAttribute(sizeTag[0], 'val')) : null;
      });
    const xfs = [...cellXfsSection[1].matchAll(/<xf\b[^>]*>/g)]
      .map((match) => Number(xmlAttribute(match[0], 'fontId')));
    const sizes = [];
    for (let column = 0; column < headerCount; column += 1) {
      const address = XLSXStyle.utils.encode_cell({ r: 0, c: column });
      const cellTag = [...sheetXml.matchAll(/<c\b[^>]*>/g)]
        .map((match) => match[0])
        .find((tag) => xmlAttribute(tag, 'r') === address);
      const styleIndex = cellTag ? Number(xmlAttribute(cellTag, 's')) : NaN;
      const fontId = Number.isSafeInteger(styleIndex) ? xfs[styleIndex] : NaN;
      sizes.push(Number.isSafeInteger(fontId) ? fonts[fontId] : null);
    }
    return sizes;
  } finally {
    zip.close();
  }
}

async function readReconFixArtifactEvidence(filePath, artifactKind, subMode) {
  let workbook;
  try {
    workbook = XLSXStyle.readFile(filePath, {
      cellDates: false,
      cellNF: true,
      cellStyles: true,
      raw: true
    });
  } catch (_error) {
    throw evidenceError('RECON_FIX_EXPORT_WORKBOOK_INVALID', 'ReconFix staging workbook 无法业务回读');
  }
  const contract = workbookContract(artifactKind, subMode);
  if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length !== 1 ||
      workbook.SheetNames[0] !== contract.sheetName || !workbook.Sheets[contract.sheetName]) {
    throw evidenceError('RECON_FIX_EXPORT_SHEET_MISMATCH', 'ReconFix staging workbook sheet 集合不一致');
  }
  const worksheet = workbook.Sheets[contract.sheetName];
  const aoa = XLSXStyle.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: true,
    defval: ''
  });
  const headers = (aoa[0] || []).map((value) => (
    value === null || value === undefined ? '' : String(value)
  ));
  if (headers.length !== contract.headers.length ||
      headers.some((header, index) => header !== contract.headers[index])) {
    throw evidenceError('RECON_FIX_EXPORT_HEADERS_MISMATCH', 'ReconFix staging workbook 列名或顺序不一致');
  }
  const rows = aoa.slice(1).map((values) => {
    const row = {};
    for (let index = 0; index < contract.headers.length; index += 1) {
      row[contract.headers[index]] = values[index] === null || values[index] === undefined
        ? ''
        : values[index];
    }
    return row;
  });
  const headerFontSizes = await readHeaderFontSizes(filePath, contract.headers.length);
  if (headerFontSizes.some((size) => size !== 10)) {
    throw evidenceError('RECON_FIX_EXPORT_STYLE_MISMATCH', 'ReconFix staging workbook 表头样式不一致');
  }
  if (!workbook.Props || workbook.Props.LastAuthor !== 'pzhong') {
    throw evidenceError('RECON_FIX_EXPORT_STYLE_MISMATCH', 'ReconFix staging workbook watermark 不一致');
  }
  return Object.freeze({
    sheetName: contract.sheetName,
    headersDigest: reconFixEvidenceSha256(contract.headers),
    recordsDigest: reconFixEvidenceSha256(rows),
    rowCount: rows.length,
    headerFontSize: 10,
    lastAuthor: 'pzhong'
  });
}

module.exports = {
  readReconFixArtifactEvidence
};
