# Log — v2.0.0-beta.3 阶段 2+3：模块入口 + 场景管理弹窗

## 2026-04-28 初始

- 动作：落 spec/tasks/log，状态=apply
- 证据：PRD §十二 方案 B 切分确认 PR #30 = 阶段 2+3 = 模块入口 + 场景管理（不含 3 类配置弹窗）
- 风险：
  - 改 `CURRENT_MODULE_VALID` 触及 PR #27 的合法值校验链路（main + renderer 两端必须对齐）
  - fork pendingModulePanel 容易遗漏：DOM id / class / event binding / CSS 一致性
  - "查看 / 修改场景"占位 alert 可能让用户产生"功能未做完"的误解 → 文案要明确提示"将在阶段 4-6 启用"
- 决策：
  - fork pendingModulePanel 而非从 0 写（复用 CSS）
  - 占位 alert 比 disabled 更友好（按钮在但禁用感弱）
  - toggle-enabled 即时写库（D13），与 PR #27 currentModule 模式一致
  - 删除内置场景与用户场景同等普通 confirm（D14）

## 可沉淀知识
- [ ] 多模块面板 fork 模式：复用 .control-board + .module-panel CSS + 4 按钮 + statusBox 布局；新模块只需改 id / 按钮文案 / statusBox 初始文案
