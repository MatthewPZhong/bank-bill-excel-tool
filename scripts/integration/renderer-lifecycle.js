'use strict';

// Renderer 宿主/控制器/经典脚本装配集成：实际 Electron DOM + production factories。
// 覆盖父子返回、busy 原子关闭、晚到响应、作用域释放与全部模块导航；API 为可控 fixture。
// 隔离 userData/Documents，不加载产品 Main、不写真实业务数据，不替代完整 GUI/输出验收。
// 用法：node scripts/integration/renderer-lifecycle.js
// 通过 integration-runner 自动发现；子入口输出 N/N PASS 并负责 setup/cleanup。
require('../test-renderer-lifecycle');
