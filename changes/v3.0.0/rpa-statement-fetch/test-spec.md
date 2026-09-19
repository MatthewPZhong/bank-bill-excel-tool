# Test Spec — rpa-statement-fetch

> 关联 spec：`./spec.md`
> 关联 tasks：`./tasks.md`

## 测试分层

| 层 | 工具 | 覆盖范围 |
|----|------|---------|
| 单元/模块 | 手写 mock + node:test 风格断言 | step runner、download interceptor 逻辑 |
| 集成 smoke | `scripts/smoke-rpa.js`（新增） | fake-icbc 本地页面端到端 |
| 手测 | 手工 + 工行测试账号 | 真实工行企业网银 |

项目已有 `npm run smoke` 框架（`scripts/smoke-test.js`），RPA 走相同模式但独立脚本。

---

## 覆盖范围

### 必覆盖

- [x] BrowserView 创建/挂载/卸载/销毁
- [x] step runner 9 个 op 各自的成功与失败路径
- [x] step 超时机制
- [x] 下载拦截：白名单后缀通过/拒绝、大小限制、路径正确
- [x] 状态机：所有合法 phase 转换
- [x] 状态机：异常路径（cancel / error）
- [x] partition 强制 `in-memory:` 校验
- [x] DevTools 默认关闭
- [x] 同时 1 个会话的互斥（开第二个时应拒绝或排队）
- [x] 与现有 import 管线对接的桥（喂入下载路径走 readers.js）
- [x] preload `rpa.*` API 在 renderer 可调用

### 选覆盖

- [ ] selector 失败时的截图生成（仅调试模式）
- [ ] 日志脱敏（grep 不到 cookie/token）
- [ ] 多次启动后 `rpa-downloads/` 不无限增长

### 不覆盖（明确说明原因）

- ❌ 真实工行企业网银的端到端登录：**无测试账号**，且银行 UI 改版频繁，单测维护成本极高 → 走「每月手测一次」流程
- ❌ 风控触发：无法在不冒真实账户风险的前提下测试
- ❌ 短信/Ukey 验证：用户手动操作，不属于自动化测试范围
- ❌ Windows/macOS 跨平台差异：MVP 仅在 Windows 用户场景下使用（用户主用 Windows），macOS 暂列 known-issue 而非阻塞

---

## 关键测试场景

### S1：fake-icbc 端到端 smoke

**目的**：在不依赖真实工行环境下验证整条链路

**步骤**：
1. 启动 Electron app
2. `scripts/smoke-rpa.js` 注入一个本地 HTML（模拟工行登录页 + 明细页）
3. 用 IPC 触发 `rpa:start-session`
4. 自动模拟 `rpa:user-confirm`
5. 验证 BrowserView 走完 9 个 step
6. 验证下载文件落在 `{userData}/rpa-downloads/<sessionId>/test.xlsx`
7. 验证 `rpa:result` 事件 success=true

**预期通过**：所有断言 ok；退出码 0

### S2：取消路径

**步骤**：
1. 启动会话
2. 在 `phase=awaiting-user` 点取消
3. 在 `phase=running` 任意 step 触发取消
4. 在 `phase=downloading` 触发取消

**预期**：
- BrowserView 立即卸载
- `rpa:result` 事件 success=false, error.code='CANCELLED'
- 后续 `rpaSessions.get(sessionId)` 应为 null

### S3：超时路径

**步骤**：
1. fake page 故意不渲染目标 selector
2. 触发 `wait-for-selector`，超时设为 2 秒

**预期**：
- 2 秒后 step 抛错
- 整体 phase=error
- error.code='TIMEOUT'
- error.context 包含 selector、stepIdx、page url

### S4：下载白名单

**步骤**：
1. fake page 触发下载 `.exe` 文件
2. fake page 触发下载 `.xlsx` 文件
3. fake page 触发下载 100 MB `.xlsx` 文件

**预期**：
- 场景 1：被拒，error.code='DOWNLOAD_TYPE_REJECTED'
- 场景 2：成功，路径正确
- 场景 3：被拒，error.code='DOWNLOAD_SIZE_LIMIT'

### S5：并发会话互斥

**步骤**：
1. 启动会话 A，phase=running
2. 同时调用 `rpa:start-session` 启动会话 B

**预期**：
- B 立即返回 error.code='SESSION_BUSY'
- A 不受影响继续执行

### S6：与现有 import 管线对接

**步骤**：
1. fake-icbc smoke 成功
2. 自动调用 bridge → 进入现有大账号选择
3. 完成大账号选择 → 走到导出 Excel

**预期**：
- 整条流程与"从本地选文件 + 完成"路径产物一致
- 不绕过任何现有校验

### S7：preload 隔离不破坏

**步骤**：
1. renderer 端 `window.desktopApi` 检查现有 API 全部存在
2. `window.desktopApi.rpa` 不为 undefined
3. 尝试 `window.require` 或 `window.electron` → 应仍然 undefined（contextBridge 未被打破）

**预期**：所有现有 API 完整；新 API 可用；隔离不破

---

## 手测 checklist（真实工行环境）

**前置**：用户/团队提供工行企业网银**测试账号**或在生产账号上有意识地小规模测试

**checklist**（每月跑一次 + 每次发版前跑一次）：

- [ ] 主界面"从网银抓取"按钮显示
- [ ] 点击后渠道选择对话框正常弹出
- [ ] 选择"工行企业网银"后 BrowserView 加载登录页
- [ ] 用户能正常登录（账号 + 密码 + 短信/Ukey）
- [ ] 控制栏状态文案随登录进度更新
- [ ] 用户点"开始抓取"后程序自动跳转到明细页
- [ ] 日期范围自动选择"昨日"
- [ ] 自动点击导出
- [ ] 下载的 Excel 文件落在 `{userData}/rpa-downloads/<sid>/`
- [ ] 自动进入现有大账号选择 → 导出流程
- [ ] 任意时刻点"取消"能正确返回主界面
- [ ] 故意输错密码 → 不会触发 selector 失败（因为还在 awaiting-user）
- [ ] 工行页面卡死/超时 → 程序给出可读错误
- [ ] 关闭软件后 `{userData}/rpa-downloads/` 中残留文件能定期清理（>7 天）

---

## 验收门

**MVP 通过门**（必须全部满足）：

1. S1（fake smoke）通过
2. S2、S3、S4 全部通过
3. S6 端到端通过
4. 手测 checklist 在工行测试账号下 100% 通过
5. spec §7 安全清单逐项绿
6. `npm run smoke` 全绿（不引入对现有 smoke 的回归）

**未通过门则不进入**：合并 → main / 发版 / 提 PR
