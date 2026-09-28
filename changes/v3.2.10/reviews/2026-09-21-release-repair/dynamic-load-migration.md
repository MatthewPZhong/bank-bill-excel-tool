# G1／G6 既有 worker 加载登记迁移

原登记固定在 `9a38b96b1b8006c5851535d0c1e586bbaeb63f10:architecture/boundaries.json`，blob 为 `bf3b2eba5acc15cd1d55f69d2d712ac96a718776`。这份登记沿用 v3.2.9 的启动点，release 已集成的 G1／G6 改变了两处实际启动结构。本次精确迁移位置与指纹，数量及每一项允许目标集保持一致。

| 登记 | 旧位置／指纹 | 现有实现与迁移 | 保持的目标 |
| --- | --- | --- | --- |
| `src/main-process/run-check-multiworker.js` | `startWorker.<anonymous:1>`；`ff92d9b23731f8dd4f8ff730bd0ffd2290b9c0a2e75c588734fbe7d2ab54e565` | G6 的 worker 启动移至 `startWorker`；worker 构造 AST 指纹不变，退出屏障及 worker 资源生命周期按 G6 测试验证 | `src/main-process/run-check-multiworker-worker.js` |
| `src/main-process/toolbox-output-publication-dispatch.js` | `runWorkerJob.<anonymous:1>`；`b0a2253ddf72c309706e091e302cb27ce15eb58c4aeaa26c2c26a7dcd191f5fb` | G1 使用 `new Worker(workerScriptPath, { workerData })` 传递授权上下文；位置相同，完整 AST 指纹更新为 `24e6df1332be8ec12f46b93b64da06ce65f3fa9f3edf9c7514254f3bdfec8bc1` | `src/main-process/toolbox-output-publication-worker.js` |

完整精确的 from／to 值保存在 `boundaries.json` 的 `$policy.dynamicLoads` 迁移记录中。其余动态加载登记不变。没有增加可执行目标，没有允许目录或任意路径，没有修改历史防倒退规则。

G1 worker 的加载路径登记只解释“加载哪个脚本”；`execute-recovery` 的授权位置另由恢复边界的精确 allowedSites 保护。真实 discovery／授权／复验／执行、随机 worker key、FIFO 和 lease 仍须通过 G1 行为测试，不能由加载路径静态许可替代。
