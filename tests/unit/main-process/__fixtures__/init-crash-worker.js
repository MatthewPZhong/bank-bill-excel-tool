// v2.1.10 SR-FIX-1 Round 6 H3 — 测试 fixture worker（仅 unit test 用）
//
// 用途：模拟 worker 在 init 期立刻 exit(1) — 验证 ensureInitialized 的 init promise reject + reset 路径
//
// 行为：worker 启动后立即 process.exit(1)，不等任何 message
//   → ensureInitialized 内 once('exit') listener 触发 → reject + reset
//   → 下次 dispatchRunCheck 触发 cold-start（用回正常 worker script）
//
// 注：不能 require 任何业务模块（避免引发依赖加载副作用 / 真的 init DB）
'use strict';

// 立即退出 — 不发任何 message
process.exit(1);
