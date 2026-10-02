'use strict';

// 整表 CSV 的低档容量边界；配合实际读取上限，不能作为所有 CSV 的格式上限。
// 256 KiB 将行/单元格对象数量限制在有界范围；密集短行等边界由真实 153 MiB Worker 回归覆盖。
const LOW_MEMORY_CSV_MAX_BYTES = 256 * 1024;

module.exports = { LOW_MEMORY_CSV_MAX_BYTES };
