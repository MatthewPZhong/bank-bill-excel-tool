// v3.0.9 子任务 T3：split:read 第一步 —— scanFields（全表流式扫描 → 有界去重值）。
//
// 职责：把一个 .xlsx 多 sheet 逻辑表全表流式扫一遍，按列收集去重值（有界封顶），
//   产出 { headers, valuesByField }，供 main.js toolbox:split:read 大通道回传前端字段下拉。
//
// 数据流（TechDoc v3.0.9 §4.1）：
//   acc = createBoundedValuesAccumulator()   // 表头未知前先建累加器
//   headers = null
//   await streamLogicalTableRows(filePath, {
//     onHeaderRow: (h) => { headers = h; acc.setHeaders(h) },   // 逻辑表头确定时回调一次
//     onDataRow:   (values) => acc.addRow(values),              // 每数据行喂累加器（values 按列索引数组）
//     cancelToken
//   })
//   return { headers, valuesByField: acc.result() }   // {field:string[]} 逐字节同现状契约
//
// 🚩 前端零改动契约（AC1-4）：valuesByField = { [field]: string[] }（封顶后 ≤N、首现序），
//   与现状 createValuesByFieldAccumulator.result() 逐字节同构——不暴露 truncated / distinctSeen 元数据。
//
// 🔴 红线（纯 Node、worker 安全）：
//   - 只 require 同 package 的 T1 multi-sheet-reader + T2 bounded-values-accumulator（均纯 Node、worker 安全）。
//   - 绝不 require electron / main.js / 隔离铁律禁区的流式读取器（pending-import 银行专表流式 reader）。
//   - 读路径全走 T1（yauzl 流式多 sheet），不碰任何 SheetJS 全量读路径。

const { streamLogicalTableRows } = require('./multi-sheet-reader');
const { createBoundedValuesAccumulator } = require('./bounded-values-accumulator');

// 全表流式扫描，收集每列去重值（有界）。
//   入参：
//     filePath     string                     源 .xlsx 路径
//     cancelToken  { cancelled?: boolean }     可选；中途取消（透传给 T1 reader，每行检查）
//   返回：{ headers, valuesByField }
//     headers       string[]                   逻辑表头（normalize 后；空文件 / 无有意义行为 null）
//     valuesByField { [field]: string[] }      每列去重值（封顶 N、首现序，逐字节同现状契约）
//
//   注：空文件（无任何有意义行 → onHeaderRow 从未触发）时 headers=null、valuesByField={}（累加器未 setHeaders）。
//     与现状一致地交由上层 handler 归一（现状空文件由 readHeaderRowStreamed 抛 ToolboxStreamEmptyError）。
async function scanFields(filePath, cancelToken) {
  const acc = createBoundedValuesAccumulator();
  let headers = null;

  await streamLogicalTableRows(filePath, {
    onHeaderRow: (h) => {
      headers = h;
      acc.setHeaders(h);
    },
    onDataRow: (values) => {
      acc.addRow(values);
    },
    cancelToken: cancelToken || null
  });

  return { headers, valuesByField: acc.result() };
}

module.exports = {
  scanFields
};
