// v3.0.9 子任务 T2：有界去重累加器（工具箱「按字段值拆分」大文件隔离 worker 通道用）
//
// 背景：现状 src/main-process/toolbox.js:186 createValuesByFieldAccumulator 是「无界」去重累加器——
//   每列 Set 随基数无限增长，对 700 万行高基数列（如订单号、时间戳）会吃掉 GB 级内存，是大文件 OOM 根因之一。
//   本模块在「逐字节同契约」前提下给每列 Set 封顶，使内存恒定 O(N)，供 worker 内 scanFields 安全收集去重值。
//
// 核心语义（与 TechDoc v3.0.9 §三① 一致，权威）：
//   - 每列 Set 封顶 N=1000：某列去重值达 N 后【丢弃该列 Set】（释放内存，该列内存恒 O(N) 不再随基数增长），
//     后续该列新值不再收集。封顶后 result() 仍稳定回该列前 N 个（首现序）。
//   - 全局 maxTotalDistinct=200000 兜底：跨所有列已收集去重值总数达上限 → 停止所有列新增（病态宽表防护）。
//   - 归一化口径与 toolbox.js 现状逐字节一致：normalizeCell（null/undefined→''，否则 String(value).trim()）；
//     空串 / 纯空白值跳过；去重 + 保留首现序；同名表头重复时后者覆盖前者的列索引。
//
// 🚩 前端零改动契约（最关键，契约锁 AC1-4）：
//   result() 只回 { [field]: string[] }，与现状 createValuesByFieldAccumulator.result() 逐字节同构。
//   绝不暴露 truncated / distinctSeen 等截断元数据——它们只能留在累加器内部（getInternalStats）供 log / 护栏用，
//   绝不进 result() 返回值（IPC 返回链任一处加字段都破前端零改动契约）。
//
// 🔴 红线：纯 Node、worker 安全——只 require file-service/common（normalizeCell，纯 Node）；
//   不 require electron / main-process 重模块（本模块将在 worker_threads 内被 require）。

const { normalizeCell } = require('../file-service/common');

// 默认阈值（TechDoc §三① / OPEN-T4 取 plan 建议值，实施期可按真实数据微调）。
const DEFAULT_MAX_DISTINCT_PER_FIELD = 1000; // 每列 Set 封顶 N
const DEFAULT_MAX_TOTAL_DISTINCT = 200000; // 全局去重值总数兜底

// 有界去重累加器工厂。
//   接口形态参考现状 src/main-process/toolbox.js:186 createValuesByFieldAccumulator，差异：
//     - 表头通过 setHeaders(headers) 设定（scanFields 先建累加器、拿到表头再喂；非构造时传）。
//     - 新增 merge(other) 供分片 / 测试合并快照。
//   options（均可选，便于测试用小阈值断言截断行为）：
//     - maxDistinctPerField  每列 Set 封顶 N（默认 1000）
//     - maxTotalDistinct     全局去重值总数兜底（默认 200000）
function createBoundedValuesAccumulator(options = {}) {
  const maxDistinctPerField = normalizePositiveInt(
    options.maxDistinctPerField,
    DEFAULT_MAX_DISTINCT_PER_FIELD
  );
  const maxTotalDistinct = normalizePositiveInt(
    options.maxTotalDistinct,
    DEFAULT_MAX_TOTAL_DISTINCT
  );

  // header（normalize 后） -> 列索引（同名后者覆盖前者，对齐全量 computeValuesByField 的对象键覆盖语义）。
  let colIdxByField = new Map();
  // header -> string[]（首现序去重值，封顶后稳定为前 N 个）。这是 result() 唯一回传的结构。
  let valuesByField = {};
  // header -> Set<string>（去重判定用；该列达 N 后【丢弃 Set】释放内存，置 null）。
  let seenByField = Object.create(null);
  // header -> boolean（该列是否已封顶 / 丢弃 Set；用于内部 log / 护栏，不进 result()）。
  let truncatedByField = Object.create(null);
  // 已收集的去重值总数（仅统计实际放进 valuesByField 的，跨所有列）。
  let totalDistinct = 0;
  // 全局兜底是否已触发（达 maxTotalDistinct 后停止所有列新增）。
  let totalCapReached = false;

  function ensureHeaders(headers) {
    const safeHeaders = Array.isArray(headers) ? headers : [];
    colIdxByField = new Map();
    valuesByField = {};
    seenByField = Object.create(null);
    truncatedByField = Object.create(null);
    totalDistinct = 0;
    totalCapReached = false;
    safeHeaders.forEach((rawHeader, colIdx) => {
      // 表头比对 / 列名键沿用 toolbox.js 现状：extractHeaders 已 normalizeCell，这里仍按列名建键（保持同名后者覆盖）。
      const header = rawHeader;
      Object.defineProperty(valuesByField, header, {
        value: [],
        writable: true,
        enumerable: true,
        configurable: true
      });
      seenByField[header] = new Set();
      truncatedByField[header] = false;
      colIdxByField.set(header, colIdx);
    });
  }

  // 收集单个（已 normalize 且非空）值到指定列，遵守每列 N 上限 + 全局兜底 + 首现序。
  //   返回是否实际放入（用于内部统计；不影响外部语义）。
  function collectValue(header, value) {
    if (totalCapReached) return false;
    if (truncatedByField[header]) return false; // 该列已封顶 / Set 已丢弃，后续不再收集

    const seen = seenByField[header];
    if (!seen) return false; // 防御：理论上 truncated 与 seen===null 同步
    if (seen.has(value)) return false; // 已去重

    seen.add(value);
    valuesByField[header].push(value);
    totalDistinct += 1;

    // 该列达 N → 丢弃 Set 释放内存，标记封顶（后续该列新值不再收集，但 result() 仍稳定回前 N 个）。
    if (valuesByField[header].length >= maxDistinctPerField) {
      seenByField[header] = null;
      truncatedByField[header] = true;
    }
    // 全局去重值总数达上限 → 停止所有列新增（病态宽表防护）。
    if (totalDistinct >= maxTotalDistinct) {
      totalCapReached = true;
    }
    return true;
  }

  return {
    // 设定列名数组（headers 为 normalize 后的表头）。重复调用以最后一次为准（会重置已收集状态）。
    setHeaders(headers) {
      ensureHeaders(headers);
    },

    // 逐行喂（values 按列索引的数组）。每列用 Set 收集去重值（封顶 N + 全局兜底 + 首现序）。
    //   口径与 toolbox.js createValuesByFieldAccumulator.addRow 一致：normalizeCell 归一、空串跳过。
    addRow(values) {
      if (!Array.isArray(values)) return;
      if (totalCapReached) return; // 全局兜底已触发，整体停止
      for (const [header, colIdx] of colIdxByField.entries()) {
        const value = normalizeCell(values[colIdx]);
        if (value === '') continue; // 空串 / 纯空白跳过（trim 后为空）
        collectValue(header, value);
        if (totalCapReached) break; // 本行收集中触顶，提前结束本行
      }
    },

    // 🚩 契约锁：只回 { [field]: string[] }（≤N、首现序），与现状逐字节同构，绝不含 truncated / distinctSeen。
    result() {
      return valuesByField;
    },

    // 合并另一累加器快照（供分片 / 测试用，遵守 N 上限 + 首现序）。
    //   接受：另一个本工厂实例（有 result() / getInternalStats()），或裸 { [field]: string[] } 快照。
    //   语义：以本累加器现状为基，按 other 的列、值首现序追加未见过的值，仍受每列 N + 全局兜底约束。
    //   未在本累加器 headers 中出现的列：动态新增该列（合并场景下两分片列集一致，新增是防御性兜底）。
    merge(other) {
      if (!other) return;
      const otherValues =
        typeof other.result === 'function'
          ? other.result()
          : other && typeof other === 'object'
            ? other
            : null;
      if (!otherValues || typeof otherValues !== 'object') return;

      for (const header of Object.keys(otherValues)) {
        const incoming = otherValues[header];
        if (!Array.isArray(incoming)) continue;
        // 本累加器未知的列 → 动态登记（列索引追加在末尾，仅用于 addRow 时的列定位；merge 直接按值追加不依赖它）。
        if (!Object.prototype.hasOwnProperty.call(valuesByField, header)) {
          Object.defineProperty(valuesByField, header, {
            value: [],
            writable: true,
            enumerable: true,
            configurable: true
          });
          seenByField[header] = new Set();
          truncatedByField[header] = false;
          colIdxByField.set(header, colIdxByField.size);
        }
        for (const rawValue of incoming) {
          if (totalCapReached) return;
          const value = normalizeCell(rawValue);
          if (value === '') continue;
          collectValue(header, value);
        }
      }
    },

    // 仅供 worker 内部 log / 护栏使用——绝不进 result() / IPC 返回（契约锁）。
    //   truncatedFields  达 N 被封顶（丢弃 Set）的列名数组
    //   distinctSeen     已收集去重值总数（跨所有列，实际放入 valuesByField 的）
    //   totalCapReached  全局 maxTotalDistinct 兜底是否触发
    getInternalStats() {
      const truncatedFields = Object.keys(truncatedByField).filter(
        (header) => truncatedByField[header]
      );
      return {
        truncatedFields,
        distinctSeen: totalDistinct,
        totalCapReached,
        maxDistinctPerField,
        maxTotalDistinct
      };
    }
  };
}

// 把 options 数值归一为正整数；非正 / 非数 → 回退默认值。
function normalizePositiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const intValue = Math.floor(value);
  return intValue > 0 ? intValue : fallback;
}

module.exports = {
  createBoundedValuesAccumulator,
  DEFAULT_MAX_DISTINCT_PER_FIELD,
  DEFAULT_MAX_TOTAL_DISTINCT
};
