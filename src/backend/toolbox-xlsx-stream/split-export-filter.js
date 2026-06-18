// v3.0.9 子任务 T3：split:export 第二步 —— exportFilter（按字段值过滤 → 流式写命中行）。
//
// 职责：把一个 .xlsx 多 sheet 逻辑表流式过滤（按 field ∈ values），命中行喂 writeRowsStreamed 写出
//   临时 .xlsx（超 104 万行自动分 sheet），返回 { matchedCount }。供 main.js toolbox:split:export 大通道。
//
// 数据流（TechDoc v3.0.9 §4.2 + OPEN-T2 推荐方案 a「先 peek 表头」）：
//   ① peek 表头：用 streamLogicalTableRows 跑一次「只取表头」——onHeaderRow 拿到表头后抛 { __stopParsing:true }
//      早退（O(1)，只读到首个有意义行，scanSheetRows 捕获 __stopParsing 即停 stream + resolve，不 reject）。
//      writeRowsStreamed 需要 normalizedHeaders 先于 writeDataRows 确定，故必须先拿表头。
//   ② createRowFilter(normalizedHeaders, field, values)：定位字段列 + 预编译选中值集合。
//      若 !filter.fieldFound → 抛可解释错误（字段不存在），由上层 handler 归一 failed（不产文件）。
//   ③ writeRowsStreamed({ savePath, normalizedHeaders, sheetBaseName:'COMMON', writeDataRows })：
//      writeDataRows 内再 streamLogicalTableRows 一遍，onDataRow 命中（filter.matches）即 emit。
//   ④ 返回 { matchedCount }（= writeRowsStreamed 返回的 dataRowCount，即 emit 计数）。
//
// 🔴 隔离铁律 / worker 安全（team-lead 已核 require 链）：
//   - 读路径全走 T1 multi-sheet-reader（yauzl 流式多 sheet），本模块绝不直接 require 隔离铁律禁区的
//     pending-import 银行专表流式读取器（AC1-5 红线）。
//   - 写路径复用 main-process/toolbox-stream-io.js 的 writeRowsStreamed（团队已核：其整条 require 链
//     —— readers.js / 该禁区读取器 / toolbox / normalizers / common / workbook-watermark / exceljs ——
//     全部 electron-free、worker 安全）。toolbox-stream-io 传递性加载的那个禁区读取器 + SheetJS
//     【从不被本通道调用】（本通道只走 T1 yauzl 流式读 + writeRowsStreamed 的 ExcelJS 流式写），纯加载无害。
//   - createRowFilter 复用 main-process/toolbox.js（只 require file-service/common，纯 Node）。
//   - 纯 Node：不 require electron / main.js。

const { streamLogicalTableRows } = require('./multi-sheet-reader');
const { createRowFilter } = require('../../main-process/toolbox');
const { writeRowsStreamed } = require('../../main-process/toolbox-stream-io');

// 字段不存在错误——上层 handler 据 name 归一为 { status:'failed' }（不产文件）。
//   与现状全量路径 filterRowsByFieldValues 的 fieldFound=false 分支同语义。
class ToolboxSplitFieldNotFoundError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'ToolboxSplitFieldNotFoundError';
    this.detailLines = Array.isArray(detailLines) ? detailLines.slice() : [];
  }
}

// peek 表头：只读到逻辑表头即早退（O(1)）。返回 normalizedHeaders（string[]）；空文件返回 null。
//   实现：streamLogicalTableRows 的 onHeaderRow 拿到表头后抛 __stopParsing 信号——scanSheetRows 捕获后
//   stop(stream) + resolve（不 reject），streamLogicalTableRows 正常返回；外层主循环检测 stream 已停后不再
//   读后续 sheet。整个过程只解析到首个有意义行（首个非空 sheet 的表头行），不扫数据行。
async function peekNormalizedHeaders(filePath, cancelToken) {
  let headers = null;
  // codex P2：仅靠 __stopParsing 只停「当前 sheet」的 stream——多 sheet 下 streamLogicalTableRows 主循环会
  //   继续读后续 sheet（peek 退化为近全量扫，对 700 万行多 sheet 文件几乎翻倍 I/O）。故拿到表头时同时置一个
  //   内部停扫令牌，使主循环在当前 sheet 结束后 break、不再读后续 sheet（真正 O(1)：只扫第一个非空 sheet 到首个有意义行）。
  const peekStopToken = { cancelled: false };
  // 与调用方 cancelToken 兼容：peek 阶段调用方若已取消也应停（O(1) 内一般无关，纯防御）。
  const effectiveToken = {
    get cancelled() {
      return peekStopToken.cancelled || !!(cancelToken && cancelToken.cancelled);
    }
  };
  await streamLogicalTableRows(filePath, {
    onHeaderRow: (h) => {
      headers = h;
      peekStopToken.cancelled = true; // 停后续 sheet（主循环 sheet 边界检查 effectiveToken.cancelled → break）
      // 抛 __stopParsing 停「当前 sheet」的 stream（O(1) 早退）：scanSheetRows 捕获 → stop + resolve（不 reject）。
      const stop = new Error('__toolbox_split_peek_header_done__');
      stop.__stopParsing = true;
      throw stop;
    },
    onDataRow: () => { /* peek 阶段不消费数据行（早退后不会到达） */ },
    cancelToken: effectiveToken
  });
  return headers;
}

// 按字段值过滤 → 流式写命中行到 savePath。
//   入参（对象）：
//     filePath        string                     源 .xlsx 路径
//     field           string                     单选字段（= 某个表头列名）
//     values          string[]                   该字段被选中的若干值
//     savePath        string                     输出临时 .xlsx 路径
//     cancelToken     { cancelled?: boolean }     可选；中途取消（透传给 T1 reader）
//     maxRowsPerSheet number                      可选；分 sheet 阈值——仅单测传小值确定性验证分 sheet，
//                                                 生产不传（writeRowsStreamed 用其默认 MAX_DATA_ROWS_PER_SHEET）。
//   返回：{ matchedCount }（命中数据行数 = emit 计数 = writeRowsStreamed.dataRowCount）
//   抛错：
//     - 空文件（无逻辑表头）→ Error（headers 为 null）
//     - 字段不存在 → ToolboxSplitFieldNotFoundError（上层归一 failed）
async function exportFilter({ filePath, field, values, savePath, cancelToken, maxRowsPerSheet }) {
  // ① peek 表头（O(1) 早退）。
  const normalizedHeaders = await peekNormalizedHeaders(filePath, cancelToken);
  if (normalizedHeaders === null) {
    // 空文件 / 无有意义行——与现状 readHeaderRowStreamed 空文件口径一致（上层归一 failed）。
    const err = new Error('文件为空或不可读，请重新导入');
    err.name = 'ToolboxStreamEmptyError';
    throw err;
  }

  // ② 预编译字段过滤器。
  const filter = createRowFilter(normalizedHeaders, field, values);
  if (!filter.fieldFound) {
    throw new ToolboxSplitFieldNotFoundError(
      `字段「${field}」不在表头中，无法按该字段拆分`,
      [
        `表头（${normalizedHeaders.length} 列）：${normalizedHeaders.join(' | ') || '（空）'}`,
        `请求拆分字段：${field}`,
        '请确认字段名后重试。'
      ]
    );
  }

  // ③ 流式过滤写：writeRowsStreamed 内 emit 命中行；超 104 万行自动分 sheet（复用其阈值/格式逻辑）。
  //   maxRowsPerSheet 不传 → 用 writeRowsStreamed 默认 = MAX_DATA_ROWS_PER_SHEET（生产恒用默认；
  //   单测可通过本函数的 __maxRowsPerSheet 入口注入小值确定性验证分 sheet，见下）。
  const writeResult = await writeRowsStreamed({
    savePath,
    normalizedHeaders,
    sheetBaseName: 'COMMON',
    writeDataRows: async (emit) => {
      await streamLogicalTableRows(filePath, {
        // 注：writeDataRows 阶段不需要 onHeaderRow（normalizedHeaders 已 peek 拿到）；表头行在 T1 内部
        //   被识别后不进 onDataRow（不会被 emit），故此处无需再判表头。
        onDataRow: (vals) => {
          if (filter.matches(vals)) {
            emit(vals);
          }
        },
        cancelToken: cancelToken || null
      });
    },
    // 仅当显式传入小阈值（单测）时覆盖，否则交由 writeRowsStreamed 用其默认值（生产恒用默认）。
    ...(typeof maxRowsPerSheet === 'number' ? { maxRowsPerSheet } : {})
  });

  // ④ matchedCount = emit 计数（writeRowsStreamed.dataRowCount）。
  return { matchedCount: writeResult.dataRowCount };
}

module.exports = {
  exportFilter,
  ToolboxSplitFieldNotFoundError,
  // 导出供单测
  peekNormalizedHeaders
};
