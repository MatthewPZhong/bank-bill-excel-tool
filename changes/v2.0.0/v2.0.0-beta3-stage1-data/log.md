# Log — v2.0.0-beta.3 阶段 1：数据底座

## 2026-04-28 初始

- 动作：落 spec/tasks/log，状态=apply
- 证据：PRD §十二 阶段 1 范围明确（数据底座，不含 UI / 算法）
- 风险：
  - schema 变更（新增 `scenarios` 表），但与现有表无外键，影响隔离
  - 内置场景的 JSON 配置必须严格按 PRD §7.6（后续阶段 4-7 算法引擎将依赖这个 schema）
- 决策：
  - 单表 + JSON blob（PRD D6）
  - listScenarios 不返 config_json（轻量）；getScenario 才返完整 config
  - listScenarios 排序 `(priority desc, id asc)`（与调度顺序一致，便于调试）
  - 内置 3 场景在迁移内 seed-if-empty，不单独写 seed 入口

## 可沉淀知识
- [ ] 单表 + JSON blob 的 schema 模式：适用于"模式差异大但 CRUD 路径相同"的多形态实体（场景 / 规则 / 配置）
