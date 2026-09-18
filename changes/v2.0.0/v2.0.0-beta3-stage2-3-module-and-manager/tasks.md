# Tasks — v2.0.0-beta.3 阶段 2+3：模块入口 + 场景管理弹窗

## Task 1 — 持久化合法值追加
- 涉及文件：`src/backend/database/settings-repository.js`
- 操作：`CURRENT_MODULE_VALID` 追加 `'bank-statement-process'`
- 验证：单元测试空库 → setCurrentModule('bank-statement-process') 不抛错
- 状态：done

## Task 2 — index.html 模块入口
- 涉及文件：`index.html`
- 操作：
  1. module-switcher-menu 加第 4 个 button：`<button class="module-option" data-module="bank-statement-process">银行对账单处理</button>`
  2. 复制 pendingModulePanel 结构生成 bankStatementModulePanel，文案改造（场景管理 / 导入文件 / 开始运行 / 导出文件 / statusBox 初始文案）
  3. id 命名：bankStatementScenarioBtn / bankStatementImportBtn / bankStatementRunBtn / bankStatementExportBtn / bankStatementStatusBox
- 状态：done

## Task 3 — renderer.js 模块切换
- 涉及文件：`src/renderer.js`
- 操作：
  1. MODULES 加 `bankStatementProcess: { id: 'bank-statement-process', name: '银行对账单处理' }`
  2. elements 注册 `bankStatementModulePanel`、4 个按钮、statusBox
  3. setCurrentModule 加 panel hidden 切换
  4. initialize() 内 binding 4 个按钮事件（暂时占位 alert）
- 状态：done

## Task 4 — renderer-dialogs.js 场景管理弹窗
- 涉及文件：`src/renderer-dialogs.js`
- 操作：
  1. 新增 `createScenariosManagerDialog({ onClose })`：
     - 加载场景列表（调 `desktopApi.scenarios.list()`）
     - 表格 6 列渲染
     - 编辑模式两段式锁切换
     - 是否启动 checkbox（即时调 toggleEnabled）
     - 删除按钮（confirm + deleteOne + 重渲）
     - 新增场景按钮（打开类别选择弹窗）
     - "查看 / 修改场景" 按钮占位 alert
  2. 新增 `createScenarioCategorySelectDialog({ onContinue, onCancel })`：
     - 单选下拉 + 继续/取消
     - "继续"占位 alert（PR #31 才接入 3 类配置弹窗）
- 状态：done

## Task 5 — CSS 场景管理表格样式
- 涉及文件：`src/styles-gemini.css` + `src/styles.css`
- 操作：
  1. `.scenarios-manager-dialog` 容器（max-width / overflow）
  2. `.scenarios-table` 6 列布局（fixed / 行 hover / 边框）
  3. 操作列按钮组样式
  4. 编辑模式 `.is-editing` 状态高亮
  5. 双风格（Clear/General）适配
- 状态：done

## Task 6 — 单元 + 集成测试
- 操作：
  1. preload IPC wrapper 单测（mock ipcRenderer）—— 暂可跳过，已在 PR #29 验证
  2. 集成验证：启动 app → 切到新模块 → 点场景管理 → 应见 3 内置场景 → 切换 enabled 写库 → 关闭重启应保持 → 删除 1 条 → 重启应仍只有 2 条（D14）
- 状态：done

## Task 7 — smoke + preview + check-vars
- 操作：`npm run smoke` + `npm run preview` + `npm run preview:account` + `npm run check:vars`
- 状态：done

## Task 8 — 提 PR #30
- 操作：commit + push + gh pr create + Codex review 处理
- 状态：done
