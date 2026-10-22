'use strict';

// 设置 → 模板文件：在受限 Worker 中读取用户导入的模板（任务本体见 inspection-task.js）。
//   ExcelJS / SheetJS 读入时会按文件声明的范围逐格展开（数据验证、合并单元格、定义名称、列定义、超链接等），
//   几 KB 的文件就能让读入耗尽内存，无法在读入前逐项预判。放在有内存上限的 Worker 里，超限只终止该 Worker，
//   由 inspection-runner 判为预检不通过；主进程只读取已通过该检查的文件。

const { parentPort, workerData } = require('node:worker_threads');
const { errorPayload, runInspectionTask } = require('./inspection-task');

runInspectionTask(workerData).then(
  (result) => parentPort.postMessage({ ok: true, result }),
  (error) => parentPort.postMessage({ ok: false, error: errorPayload(error) })
);
