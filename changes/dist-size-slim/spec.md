# Spec — dist-size-slim 打包体积瘦身（change A / backlog B6）

> status: propose
> owner: pzhong
> created: 2026-06-10
> updated: 2026-06-10
> 目标版本：**待拍板**（建议 v3.0.3 独立小 PR；不混入 v3.0.2 收尾）
> 性质：纯打包配置 + 守卫脚本，**零业务代码改动、零运行时行为变化**。来源：2026-06-10 性能/体积调研（`knowledge/backlog.md` B6）。

---

## 1. 背景

- 用户报告：打包产物越来越大。实测 v3.0.0 安装包 **135MB**（`dist/清结算小助手-3.0.0-setup.exe`，2026-06-09 构建）。
- 其中 Electron 运行时固定成本约 70MB（压缩后），剩余膨胀全部来自 **app.asar = 101MB**（`dist/win-unpacked/resources/app.asar`；同类应用正常 ~15MB）。
- 根因：`build.files` 宽 glob 把开发文档/测试脚本打进包 + 开发工具依赖误入 `dependencies`。

## 2. 代码现状（出处）

### 2.1 打包清单（`package.json:118-128`）

```json
"files": ["assets/**/*", "COMMON枚举.xlsx", "index.html", "src/**/*",
          "scripts/**/*", "CHANGELOG.md", "README.md", "docs/**/*", "package.json"]
```

### 2.2 asar 101MB 实测构成（du，2026-06-10）

| 内容 | 大小 | 运行时是否需要 | 依据 |
|---|---|---|---|
| `docs/**/*` | **42MB** | ❌ 仅 `USER_GUIDE.md`（172KB）需要 | `docs/previews/` 36MB 截图 + `iterations/` 4.7MB + `analysis/` 1.0MB + `prs/` 480K；运行时读取仅 `src/main.js:4212`（帮助页 `userGuidePath`）+ `marked` 渲染（`main.js:4220-4222`） |
| node_modules 生产依赖 | ~47MB | ⚠️ 部分 | electron-builder 自动打包全部 `dependencies`（devDependencies 不打包） |
| ├ `@napi-rs/canvas` | 25MB | ❌ **src/ 零引用** | 全 repo grep：仅 `scripts/render-*.js` 预览工具链使用 |
| ├ `exceljs` | 22MB | ✅ 7 个 writer 必需 | `src/main-process/*-writer.js` 等 |
| ├ `xlsx-js-style` + `xlsx` | 9.5MB + 7.2MB | ⚠️ 双份共存（各带 codepage ~5.9MB） | 均被 src 引用（xlsx 8 文件 / xlsx-js-style 5 文件）；合并属后续独立 PR（见 §3 可不做） |
| `scripts/**/*` | 2MB | ❌ 测试/预览/poc 脚本 | 运行时 worker 均在 `src/main-process/`（`run-check-worker.js` 等）；`gen-build-info.js` 是构建期工具，产物写入 `src/build-info.js`（`main.js:53` require） |
| `assets/**/*` | 6.5MB | ✅ 绝大部分 | 模板 xlsx（FundType枚举值/Pending/中台加款单剔除模板/中台调拨订单/余额账单模版/外汇交割表/外汇期权订单/收单币种校验导出差异表模版/币种映射表）、`cat-meme.gif`（index.html:26）、`fonts/` 3.4MB（fonts.css E2 方案）均运行时引用 |
| ├ `assets/app-icon-source.png` | 1.3MB | ❌ 无运行时引用 | 窗口图标引用为 `APP_ICON_FILE_NAMES = ['app-icon.ico', 'app-icon.png']`（`main.js:388`），source 仅 `scripts/sync-app-icon.js` 的输入源 |
| `CHANGELOG.md` / `README.md` | 小 | ❌ 无运行时读取 | grep src/ 仅 `scenario-hit-rows-writer.js:6` 注释提及 |
| `COMMON枚举.xlsx` | 小 | ✅ | `main.js:342` `BUNDLED_ENUM_FILE_NAME` |
| `src/**/*` + index.html | 3.4MB | ✅ | — |

### 2.3 已知约束

- electron-builder：`files` 只控制 app 文件；`dependencies` 的 node_modules 自动全量打包，唯一出包方式是移到 `devDependencies`。
- CI（`.github/workflows/build-windows.yml`）：PR 跑 smoke，main push 跑 build——守卫脚本挂进 dist 命令即可被 CI build job 覆盖。

## 3. 目标

- **必做**：
  1. `build.files` 改**白名单**（防复发核心：新增文件默认不进包）
  2. `@napi-rs/canvas` → `devDependencies`
  3. 新增打包体积/内容断言守卫脚本，挂进 `dist:win*` 链尾
  4. 排除 `assets/app-icon-source.png`
- **可不做（后续独立 PR）**：`xlsx` 与 `xlsx-js-style` 合一（再 −13MB 原始；涉及 8 个 src 文件 + 全模块读写回归，风险与本 change 不同量级，不混做）
- **明确不做**：不动 `exceljs`；不动 `fonts/`（v2.1.13 E2 功能性方案）；不删仓库里任何文件（`app-icon-source.png` 仅出包不删源）；不改任何 src 代码。

## 4. 功能点

### F1 build.files 白名单

- 新清单（替换 `package.json` build.files）：

```json
"files": [
  "index.html",
  "package.json",
  "COMMON枚举.xlsx",
  "src/**/*",
  "assets/**/*",
  "!assets/app-icon-source.png",
  "docs/USER_GUIDE.md"
]
```

- 边界：`docs/USER_GUIDE.md` 单文件白名单后，asar 内路径不变（`app.getAppPath() + 'docs/USER_GUIDE.md'`），帮助页代码零改动。
- 验收：`asar list` 中不存在 `docs/previews|iterations|analysis|prs`、`scripts/`、`CHANGELOG.md`；存在 `docs/USER_GUIDE.md`。

### F2 @napi-rs/canvas 移 devDependencies

- `package.json` dependencies → devDependencies，`package-lock.json` 同步（`npm install` 重算）。
- 边界：preview 脚本（`scripts/render-*.js`）在开发机不受影响（devDeps 本地照常安装）；CI build job 用 `npm ci` 装全量依赖，`prebuild:meta` 不依赖 canvas。
- 验收：打包产物（asar + asar.unpacked）中无 `@napi-rs`；开发机 `npm run preview` 正常出图。

### F3 守卫脚本 `scripts/check-dist-size.js`（防复发）

- 输入：`dist/win-unpacked/resources/app.asar`（路径可参数化）。
- 实现：`require('@electron/asar').listPackage()`（本地已验证可用，来自 electron-builder 传递依赖；为稳妥在 devDependencies 显式声明 `@electron/asar`）。
- 断言（任一失败 exit 1 并打印明细）：
  1. asar 体积 ≤ **25MB**（阈值常量，拍板可调）
  2. 禁止路径出现：`docs/previews` / `docs/iterations` / `docs/analysis` / `docs/prs` / `scripts/` / `node_modules/@napi-rs`
  3. 必须存在：`docs/USER_GUIDE.md`、`assets/币种映射表.xlsx`、`COMMON枚举.xlsx`、`src/main.js`（防白名单漏列的反向保护）
- 挂载：三条 dist 命令（`dist:win` / `dist:win:setup` / `dist:win:portable`）追加 `&& node scripts/check-dist-size.js`；CI main-push build 自动生效。
- 验收：故意把一个 PNG 放进白名单路径测试 FAIL 路径；正常构建 PASS。

### F4 npm script 补充

- 新增 `"check:dist": "node scripts/check-dist-size.js"` 便于单独运行。

## 5. 影响范围

- 配置：`package.json`（files / dependencies / scripts）+ 新增 `scripts/check-dist-size.js`。
- 前端 / 后端 src：**零改动**。对外接口、数据、模板 bundle：零影响。
- 兼容性：NSIS `artifactName` 不变，安装升级路径不变。
- 重要变量：不触及 src → check-vars 软约束不命中；版本 bump 硬节点照常跑 `/check-vars` + `npm run scan:vars`。

## 6. 技术决策

- **白名单 vs 黑名单**：白名单。黑名单（`!docs/previews`）只能挡住已知项，下次新增 `docs/xxx/` 大文件仍静默进包——本次问题正是宽 glob 造成的，复发通道必须封死。
- **守卫挂 dist 链尾 vs 独立 CI job**：挂链尾。本地构建与 CI 双覆盖，不新增 workflow 维护面。
- **风险**：白名单漏列运行时文件 → 打包版功能缺文件（开发态 `npm start` 不受影响，难在开发期发现）。缓解 = F3 反向"必须存在"断言 + §8 打包版手测清单。

## 7. 数据 / 状态 / 安全影响

- 无数据/状态/权限变更。
- 回滚策略：单 commit revert `package.json` + 删守卫脚本即可，无残留。

## 8. 验收与测试

1. `npm run release-check` 全绿（与本改动正交，防偶发回归）。
2. 本地 `npm run dist:win`：构建成功 + `check-dist-size` PASS + 记录前后体积对比（预期安装包 135MB → **≤ 90MB**，asar 101MB → **≤ 15MB**）。
3. **打包版手测**（win-unpacked 直接运行）：
   - [ ] 帮助页打开、USER_GUIDE 正常渲染（marked 链路）
   - [ ] 窗口/任务栏图标正常
   - [ ] 网银账单导入 → 导出（币种映射表加载）
   - [ ] 新账户币种下拉（FundType枚举值.xlsx IPC 链路）
   - [ ] 收单单据币种校验 / 业务OP / 中台调拨 各打开一次（模板 xlsx 加载）
4. 开发机 `npm run preview` 仍可用（canvas devDeps 验证）。
5. CI：PR smoke 绿；合并后 main build job 绿（守卫在 CI 生效的首次验证）。

## 9. 待拍板

- [ ] 目标版本：建议 **v3.0.3** 独立小 PR（A）；或并入 v3.0.2（B，不推荐——版本已收尾）
- [ ] asar 体积阈值：建议 **25MB**（当前理论值 ~13MB，留模板/字体增长余量）
- [ ] `CHANGELOG.md` / `README.md` 是否随包分发：建议**出包**（无运行时读取）
