# macOS 内存预算排查与真实启动重试

日期：2026-09-12，Asia/Shanghai。范围：排查并重试真实启动；沿用用户已确认的“仅修正验证脚本，不调整业务启动保护、深色模式实现或已交付 HTML”的边界。

## Task Brief

- Goal：解释启动报告的 0 MiB，再用既有准入条件重试浅色、深色真实启动。
- Context：48 GiB macOS；Electron 36.9.5 / Node 22.19.0 / libuv 1.51.0；隔离临时数据库、userData 和 Documents。
- Constraints：不改预算公式、reserve、cap、固定 phase lease 或业务迁移状态，不释放用户应用/系统缓存；两个场景均完成才记 PASS。
- Done when：区分预算与实耗，记录固定版本实现、实时样本、真实重试结果及剩余限制。

## 已确认事实

| 事实 | 证据 | 含义 |
| --- | --- | --- |
| 预算为 `min(cap, max(0, os.freemem() - 2 GiB))`，本机 cap 为 12 GiB | `src/main-process/background-execution/resource-budget.js:34–75` | free 低于 2 GiB 时结果必为 0；首次激活需采样时 free 至少约 3 GiB |
| v3.2.8、HEAD 和工作树预算文件完全一致 | 三者 Git blob 均为 `ac026553569b77ed9282ba68c148bcaac4bbb664` | 不是本轮深色模式引入的公式 |
| 1024 MiB 是 `EXPORT_IO_RESOURCES` 的固定资源声明，预检结束释放 lease | `biz-op-v327/export-publication.js:11`；`upgrade-main.js:197–247` | 不是本次测得的进程 RSS，也不表示预检立即分配了 1 GiB |
| Runtime 创建时采样一次，governor 冻结预算 | `background-execution/runtime.js:341`；`resource-governor.js:91` | 之后 free 恢复不会刷新同一 Runtime，需重启重新采样 |
| 14:05 的重试在创建业务窗口前报告可用和预算上限均为 314 MiB | `live-runtime-investigation-2026-09-12T06-05-09-351Z.log` | 不是 0 MiB，也仍不足 1024 MiB；结果 BLOCKED，尚未进入主题检查 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| “0 MiB”是否代表整机实际没有可用内存 | 已知未知 | 高 | 容易 | 当前公式只取 free；vm_stat 同时存在大量 inactive | PROBE | 对照公式、日志、带时间的内核采样 | 已确认只是后台预算；实际安全可分配字节数仍未测定 |
| 当前 Electron 原生内存 API 能否直接提供包含 inactive 的 available | 已知未知 | 高 | 一般 | 固定版本 Electron、Chromium、libuv 源码 | PROBE | 读所用版本而非最新文档 | 现有接口不能直接解决；本轮不替换来源 |
| 环境自然恢复后能否通过真实 Main 冷启动 | 已知未知 | 高 | 容易 | 本轮真实启动 314 MiB 被拒 | PROBE | 有界观察现有 free 指标，满足预检再重启 | 见下方重试记录和 memory-watch JSON |
| 调整 macOS 平台采样是否在本轮范围 | 已知未知 | 高 | 一般 | 用户已确认的脚本限定；本次要求排查并重试 | ASSUME | 遵循已确认边界，不改平台契约 | 平台采样修正作为后续明确范围，不借 GUI 重试提高预算 |

## 固定版本采样核查

- [Electron v36.9.5 DEPS](https://github.com/electron/electron/blob/v36.9.5/DEPS#L4) 固定 Chromium 136.0.7103.177 和 Node 22.19.0。
- [libuv v1.51.0 darwin.c](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/darwin.c) 的 `uv_get_free_memory()` 为 free_count × pageSize，`uv_get_available_memory()` 直接返回同一值。当前版本换成 `process.availableMemory()` 不能解决 inactive 未计入的问题。
- [ElectronBindings::GetSystemMemoryInfo](https://github.com/electron/electron/blob/v36.9.5/shell/common/api/electron_bindings.cc#L166) 在 macOS 暴露 total/free，单位 KB；没有 available/fileBacked/purgeable 字段。
- [Chromium 136 GetSystemMemoryInfo](https://github.com/chromium/chromium/blob/136.0.7103.177/base/process/process_metrics_apple.mm#L298) 的 free 使用 `(free_count - speculative_count) × pageSize / 1024`，也没有加入 inactive。

因此，当前采样可能明显低于系统实际可利用的内存，但现有证据不足以给出安全可分配字节数，不能把这次拦截直接定性为已量化验证的误拒。inactive、file-backed 和 purgeable 也不能未经验证相加；`memory_pressure -Q` 输出的 89% 不能直接换算为可分配 RAM。

## 实时采样与重试

`memory-probe-2026-09-12T06-05-09-351Z.json` 记录：14:05:09.353 的 Node free 为 1533.953125 MiB，公式预算 0 MiB；随后 vm_stat 的 free 页面和 Node 数值已有明显差异，说明这些顺序采样不是同一瞬间。vm_stat page size 为 16384 bytes，inactive 为 1300465 页；memory_pressure 输出为 89%。这些统计仅帮助识别采样口径，未注入应用预算。

紧接着验证父进程采得 free 2476.40625 MiB；真正 Main 的报错则为预算上限/可用均 314 MiB。父进程样本不能冒充 Main 实际采样，314 是向下取整后的 MiB。完整记录见 `live-runtime.json` 和上述 investigation 日志。测试进程已退出，没有创建业务窗口。

随后执行 120 秒的只读观察：每 5 秒记录一次 free；预定连续两次达到 4096 MiB 时再运行原验证脚本。4096 MiB 只是本轮启动预检的余量，不修改应用内实际的 2 GiB reserve、12 GiB cap 或 1 GiB phase 申请。14:06:41–14:08:41 共 25 个样本，范围为 126.671875–629.0625 MiB，全部低于 2 GiB reserve；结果 NOT_READY，没有触发第二次启动。证据：`memory-watch-2026-09-12T06-06-41-689Z.json`。

本轮测试 PID 70059/70063 及其已识别子进程 70064/70065 已退出，临时目录 night-mode-live-dTXL02 已删除。另有用户主工作区的 `electron .` 进程不属于本轮测试，未操作。浅色首个场景受资源准入阻塞，深色场景未运行，不能记录 2/2 PASS。

## 变更与验证边界

本次排查未修改业务源文件、验证脚本或 HTML，仅新增/更新诊断证据。原脚本 appPath/name/version 修正、Renderer 完成标记等待和父进程 90 秒总超时继续使用。加载完成后的主题快照不代表从原生窗口创建到完成加载全程无闪白。

排查时 tracked diff SHA-256 仍为 `cedf2146b1947cf937c9ebdd546048e236f17c81a08f2478fcc69fb431c859e7`。Downloads 交付 HTML 与分支产物 SHA-256 均为 `41182f26c88a53020cf2c7b9dcad2d3a2b016c3cc12a6afd5a14cbc7a37373ac`。不因诊断追加重复全量门禁。
