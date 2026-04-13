# 测试报告 — v1.5.1

| 项目 | 内容 |
|------|------|
| 版本 | v1.5.1 |
| 日期 | 2026-04-13 |
| 测试方式 | 代码审查 + 数据验证 + Smoke Test |
| Smoke Test | `npm run smoke` ✅ 通过 |
| 关联 PRD | `docs/iterations/v1.5.1/PRD-v1.5.1.md` |
| 关联 TechDoc | `docs/iterations/v1.5.1/TechDoc-v1.5.1.md` |

---

## 一、改动文件清单

| 文件 | 改动量 | 对应需求 |
|------|--------|---------|
| `package.json` | version 1.5.0 → 1.5.1 | 版本号 |
| `src/backend/database/migrations.js` | +71 行 | 需求 1（`ensureParentTemplateSupport`）+ 需求 2（`ensureAccountMappingTemplateSupport`） |
| `src/backend/database/template-repository.js` | +80 行 | 需求 1（`listChildTemplates`、`listTemplates` 增 isParent/parentTemplateId） |
| `src/backend/database/settings-repository.js` | +14 行 | 需求 2（`listAccountMappings`/`saveAccountMappings` 增 templateId 参数） |
| `src/backend/database/utils.js` | +4 行 | 辅助工具 |
| `src/backend/database.js` | +37 行 | 透传新增参数、注册新迁移函数 |
| `src/backend/file-service.js` | +1 行 | 辅助调整 |
| `src/main.js` | +1060 行 | 需求 1/4/5 主逻辑（主/子匹配、Bundle v4、三维度判重） |
| `src/main-process/statement-session.js` | +5 行 | 辅助调整 |
| `src/preload.js` | +10 行 | 需求 2（accountMappings 增 templateId） |
| `src/renderer-dialogs.js` | +507 行 | 需求 1/2/3 前端（主/子勾选框、账户映射改造、标题） |
| `src/renderer.js` | +56 行 | 需求 1（下拉框过滤子模板）+ 迁移检查 |
| `src/styles.css` | +155 行 | UI 样式 |
| `scripts/smoke/scenarios.js` | +2 行 | smoke test 适配 |
| **合计** | **+1738 / -266** | |

---

## 二、P0 必测场景

| 编号 | 场景 | 结果 | 验证方式 | 备注 |
|------|------|------|---------|------|
| P0-1 | 设为主模板 → 模板管理页出现 ▶ 按钮 | ✅ | 手动 | |
| P0-2 | 设为子模板 → 主页面下拉框不显示、模板管理页展开可见 | ✅ | 手动 + 代码（`renderer.js:1621` `.filter(!parentTemplateId)`） | |
| P0-3 | 主模板导入子模板文件 → 自动匹配并导出 | ⚠️ 需重测 | 数据验证 | 12:22 导出文件确认 MerchantId 为空（bug 存在）；15:17/16:20 导出文件 MerchantId 正确（代码已修复）。详见§三-1 |
| P0-4 | 主模板导入主模板自身文件 → 正常导出 | ⚠️ 需重测 | 数据验证 | 同 P0-3，当前代码模拟验证通过。详见§三-1 |
| P0-5 | 主模板导入不匹配文件 → 报错提示 | ✅ | 手动 + 代码（`main.js:5910` `TEMPLATE_HEADER_MISMATCH`） | |
| P0-6 | 账户映射按模板隔离 | ✅ | 手动 + 代码（`UNIQUE(template_id, bank_account_id)`） | |
| P0-7 | 账户映射编辑/完成切换 | ✅ | 手动 | |
| P0-8 | Bundle v4 导出含子模板+账户映射 | ✅ | 手动 + 代码（`main.js:1142-1170`） | |
| P0-9 | Bundle v4 导入还原主/子关系+账户映射 | 待测 | — | 发布后测 |
| P0-10 | 旧 Bundle v3 导入兼容 | ✅ | 手动 + 代码（缺失字段默认空值） | |
| P0-11 | 同路径重复文件 → 覆盖，无"保留两份" | ✅ | 手动 | |
| P0-12 | 同文件名重复 → 提示"同名文件" | ✅ | 手动 | |
| P0-13 | 同内容重复 → 提示"文件内容相同" | ✅ | 手动 + 代码（`main.js:5258` SHA-256） | |

---

## 三、P0 失败场景分析

### 1. P0-3 / P0-4：主模板导入时 MerchantId 为空

**现象**：选择主模板（KORAPAY-NG）导入子模板或主模板自身文件，导出明细账单 MerchantId 列为空值。

**导出文件验证**：

| 导出文件 | 时间 | MerchantId | 说明 |
|----------|------|------------|------|
| `KORAPAY-NG-IN-NRA123-COMMON-2026-03-16~2026-03-23.xlsx` | 12:22 | **(empty)** | 子模板单独导入 — **确认 bug** |
| `KORAPAY-NG-NRA123-COMMON-2026-03-16~2026-03-20.xlsx` | 15:17 | NRA123 ✅ | 主模板单独导入 — 已修复 |
| `KORAPAY-NG-NRA123-COMMON-2026-03-16~2026-03-23.xlsx` | 16:20 | NRA123 ✅ | 多文件同时导入（48 主 + 377 子 = 426 行）— 已修复 |

**根因**：早期代码在主模板匹配子模板后，直接使用 provisional rows（未传 `selectedBigAccount`），导致 MerchantId 为 `__MULTI_BIG_ACCOUNT__` 标记值而非实际账号。

**修复**：`rebuildMatchedTemplateFileEntries`（`main.js:613-653`）在大账号选定后**重建 detailRows**，正确传入 `selectedBigAccount: { merchantId, currency }`。

**代码模拟验证**：使用当前代码 + 实际 DB 配置 + 实际测试文件，`buildMappedRows` 输出 MerchantId = "NRA123" ✅。

**结论**：当前代码已修复，需重测确认。

---

## 四、P1 应测场景

| 编号 | 场景 | 结果 | 验证方式 |
|------|------|------|---------|
| P1-1 | 互斥勾选 — 勾主模板后勾子模板，前者自动取消 | ✅ | 手动 + 代码（`renderer-dialogs.js:1940-1965` 互斥逻辑） |
| P1-2 | 取消子模板身份 → 恢复普通，主页面可见 | ✅ | 手动 |
| P1-3 | 取消主模板（有子模板）→ 弹确认提示 | ✅ | 手动 + 代码（`renderer-dialogs.js:1932` 确认对话框） |
| P1-4 | 子模板选择主模板下拉框只显示已设为主模板的 | ✅ | 手动 + 代码（`renderer-dialogs.js:1914-1925` `.filter(t.isParent)`） |
| P1-5 | 模板管理页展开/折叠 ▶/▼ | ✅ | 手动 |
| P1-6 | 模板管理页面标题"模板管理" | ✅ | 手动 + 代码（`renderer-dialogs.js:1770-1771`） |
| P1-7 | 账户映射新增行 → 默认编辑状态 | ✅ | 手动 |
| P1-8 | 账户映射删除行 | ✅ | 手动 |
| P1-9 | 账户映射表头"网银账单账户号"/"清结算系统银行账号" | ✅ | 手动 + 代码（`renderer-dialogs.js:4144-4145`） |
| P1-10 | 多文件导入自动匹配账户映射 | 待测 | P1-16 验收后再测 |
| P1-11 | 多文件导入账户映射缺失 → 不阻断 | — | 已移除检查 |
| P1-12 | Bundle 导出普通模板 → 含账户映射，不含子模板 | ✅ | 手动 |
| P1-13 | Bundle v5 拒绝导入 | ✅ | 手动 + 代码（`main.js:1198` 版本检查） |
| P1-14 | 同一批次内文件名重复 | ✅ | 手动 |
| P1-15 | 重复检测优先级 路径 > 文件名 > 内容 | ✅ | 手动 + 代码（`main.js:5290-5318` 依次检查） |
| P1-16 | 主模板同时导入主模板+子模板文件 → 均正确解析 | ❌ | 手动 | 详见§五 |

---

## 五、P1-16 失败场景分析

**现象**：模板选 BOC-CN（主模板），导入多个文件（桌面/小助手-Debug/1.5.1/BOC），可进入大账号确认页面，但点击"提取大账号顺序"后报错"所有行均提取不到大账号信息"。

**代码路径**：`main.js:6717` `file:extract-big-account-order` → `allMerchantIds`（line 6726）→ 逐文件 `identifyAccountsFromFile` → 搜索 raw file 中 header 上方的 merchantId。

**模拟验证**：

| 文件 | 匹配模板 | 大账号提取 |
|------|---------|-----------|
| `PPchaxun1.csv` | BOC-CN ✅ | 50 个 block 全部 exact match ✅ |
| `PPCHAXUN-YJF 1.csv` | BOC-CN ✅ | 待确认 |
| `PPchaxun2.csv` | BOC-CN ✅ | 待确认 |
| `文静1.csv` | BOC-CN ✅ | 待确认 |
| `账户明细查询列表 (24).xls` | ABC-CN（子模板）✅ | 需账户映射桥接 |
| `TQP_*.csv` | 待确认 | 待确认 |

**可能原因**：
1. ABC-CN 子模板文件需通过账户映射桥接提取大账号，但 `allMerchantIds` 可能仅包含 BOC-CN 的 bigAccounts 而缺少子模板的
2. 部分文件（如 TQP、已导出文件）可能无法匹配任何模板 header，导致匹配阶段异常
3. `aggregatedBigAccounts`（`main.js:5977-5987`）仅聚合已匹配到的子模板 bigAccounts，未匹配的子模板被跳过

**待确认**：需要用户提供实际选择的文件列表以精确复现。

---

## 六、新增功能验证

| 功能 | 结果 | 代码依据 |
|------|------|---------|
| 迁移分配对话框 | ✅ | `main.js:2935` 检查 `account_mapping_migration_pending` → `renderer.js:2614` 弹分配对话框 → `renderer-dialogs.js:4409` 渲染界面 → `main.js:2998` 分配后清 flag |
| 账户映射下拉框含子模板 | ✅ | `renderer.js:2649` 传 `state.templates`（全量，含子模板）→ `renderer-dialogs.js:4162` 遍历不过滤 |
| 币种 tooltip ⓘ | ✅ | `renderer-dialogs.js:4146` 图标 + tooltip 文本 → `styles.css:2221-2260` `z-index: 9999` 防遮挡 |
| "有账户号无币种" checkbox 已去掉 | ✅ | `renderer-dialogs.js:4250` `getNoCurrency: () => currencyInput.value.trim() !== ''` 自动检测 |
| 编辑/完成按钮左对齐 | ✅ | `styles.css:2301-2310` `.account-mapping-action-cell { text-align: left }` |
| 多币种桥接提醒 | ✅ | `main.js:6924-6930` 检测多币种 → `renderer-dialogs.js:1091-1098` 弹提醒框 |
| 主/子模板 checkbox 状态回显 | ✅ | `renderer-dialogs.js:1878-1886` `${templateIsParent ? 'checked' : ''}` + `${templateParentId ? 'checked' : ''}` 初始化 |

---

## 七、风险评估

| 级别 | 项目 | 说明 |
|------|------|------|
| Minor | 账户映射数据迁移 | 多模板场景下旧记录复制到所有模板，用 `account_mapping_migration_pending` flag 提示用户手动分配。事务保护（`migrations.js:224` BEGIN/ROLLBACK），风险低 |
| Minor | 子模板 headers 冲突 | 两个子模板 headers 完全相同时匹配报错（`main.js:5919-5925`），属正确行为 |
| Minor | 大文件哈希性能 | `fs.readFileSync` 同步 SHA-256，大文件短暂卡顿，与现有同步读取一致 |

---

## 八、总结

| 类别 | 通过 | 失败 | 待测/重测 |
|------|------|------|----------|
| P0 必测 | 10 | 0 | 3（P0-3、P0-4 需重测；P0-9 发布后测） |
| P1 应测 | 13 | 1 | 2（P1-10 待 P1-16 后测；P1-16 待确认文件列表） |
| 新增功能 | 7 | 0 | 0 |
| **合计** | **30** | **1** | **5** |

Smoke test 通过。P0-3/P0-4 的 MerchantId 为空 bug 在当前代码中已修复，建议重测确认。P1-16 需要补充实际导入文件列表以精确定位根因。
