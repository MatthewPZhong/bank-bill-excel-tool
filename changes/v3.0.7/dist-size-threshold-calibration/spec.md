# Spec — check-dist-size asar 阈值按实测校准（25MB → 70MB）

> 状态：**代码已落（v3.0.7 工作区，未提交 / 未 PR）** ｜ 来源分支：`v3.0.7` ｜ 目标版本：**3.0.7**
> 性质：🔴 **CI / 打包发布红线**（构建体积守卫阈值）——纯配置常量调整，**零运行时行为改动**、零业务代码。
> 缘起：用户 2026-06-16 反馈「GitHub 打包动作 #404 失败」。诊断后确认：`build` 作业 "Check dist size" 步骤因 `app.asar = 57.47MB` 超过守卫脚本 25MB 硬阈值而 `exit 1`，且该失败自 v3.0.5 起在 main 上长期存在（PR 不跑 build job 故未暴露）。

---

## 〇、需求

让 main 分支的 "Build Windows Packages" 工作流不再因体积守卫误杀而构建失败，恢复 installer / portable 产物的正常产出，同时**保留**体积守卫对「开发文档/脚本/开发依赖误入包」的防回归能力。

- 不删除任何运行时在用的依赖（三大 Excel 库均在用）。
- 不降低守卫的实际防护意义（不是无脑放大到无穷）。

---

## 一、现状根因（事实，带出处）

### 1.1 直接死因 — CI 日志

`#404` = run `27587472956`（PR #74 合并到 main 后的 `push` 构建，conclusion=failure），失败步骤 "Check dist size"：

```
==== check-dist-size FAIL ====
  asar 体积：57.47MB（上限 25.00MB）
  包内条目数：2700
  断言①体积超标：app.asar = 57.47MB，上限 25.00MB → exit 1
```

前一版 `#400`（run `27536225183`，PR #73 合并）同样死因：`57.39MB / 2696 条目`。即 **v3.0.5、v3.0.6 两次合并 main 均在此步失败**。

### 1.2 为何 PR 构建「成功」、main 才暴露

`.github/workflows/build-windows.yml` 的 `build` 作业带门控：

```yaml
build:
  if: github.event_name != 'pull_request'   # ← PR 跳过整个 build job
```

| 事件 | smoke-test | build（electron-builder + Check dist size + 产物上传）|
|---|---|---|
| `pull_request` | ✅ | ❌ **整个 job 跳过** |
| `push`（合并 main 后）| ✅ | ✅ |

∴ PR 里**根本不跑实体打包与体积检查**，PR #403「成功」是假绿；守卫只在合并 main 后生效，导致每次合进去才暴雷。

### 1.3 守卫的来历与阈值失真

- v3.0.4 合并(#396)能过 = **当时尚无体积检查**。
- 守卫由 v3.0.5 commit `386492d`「打包瘦身 PR-1 Part A」新增：`build.files` 改白名单 + `@napi-rs/canvas` 移 devDependencies + 新增 `scripts/check-dist-size.js`（`MAX_ASAR_BYTES = 25 * 1024 * 1024`，行 23）。
- 该提交只做了**负向验证**（「负向验证 101MB 旧 asar 正确 FAIL」），**未验证瘦身后的新 asar 能否压进 25MB**。脚本注释「当前理论值 ~13MB」与实测 ~57.5MB 严重不符。
- CHANGELOG v3.0.5 亦写「预期 asar 101MB → ≤ 15MB」——该预期落空，实际只瘦到 ~57.5MB。

### 1.4 体积来源（为何压不到 25MB）

`build.files` 白名单内 `src/**`≈4.1M、`assets/**`≈6.5M 都不大；膨胀来自**三个 Excel 库并存、且均运行时在用**：

| 库 | node_modules 体积 | src 内 require 处数 | 备注 |
|---|---|---|---|
| `exceljs` | **22M** | 7（`*-writer.js`） | dist/ 占 21M，其中 ~17M 是浏览器打包 + `.js.map` sourcemap；运行实际只用 lib/（940K） |
| `xlsx-js-style` | 9.5M | 11 | 带样式输出 |
| `xlsx`(SheetJS) | 7.2M | 12 | 读取 |

三者约 39M + 传递依赖（`codepage` 5.9M、`@fast-csv` 3.8M 等）≈ 57M。**三个都在用，不能简单删 → 25MB 阈值在不做深度瘦身的前提下不可能达成。**

---

## 二、修复方案（最小改，已落）

仅调整 `scripts/check-dist-size.js` 断言①阈值常量，并修正失真注释。**不动 workflow、不动 build.files、不动依赖。**

### 改动：`scripts/check-dist-size.js`（头注释 + 常量块 + 断言① 行内注释，三处 25→70MB；行内注释改引用 `MAX_ASAR_BYTES` 防再陈旧）

```js
// asar 体积上限：70MB（v3.0.7 按实测校准）。
//   原 25MB 阈值（A-D2）为瘦身预期值，但三大 Excel 库 exceljs(22M)/xlsx(7.2M)/xlsx-js-style(9.5M)
//   均运行时在用、无法删除，实测 asar ~57.5MB，导致 v3.0.5 起 main 构建长期 FAIL（PR 不跑 build job 故未暴露）。
//   按实测 ~57.5MB 留约 22% 模板/字体/依赖增长余量定为 70MB；若后续完成 dist/sourcemap 排除瘦身，应再下调。
const MAX_ASAR_BYTES = 70 * 1024 * 1024;
```

- **阈值取 70MB 而非用户初提的 60MB**：实测 57.47MB，60MB 仅余 ~2.5MB，下次加模板/升级依赖即复发；70MB = 实测 +~22% 增长余量，沿用脚本原「留增长余量」设计意图。
- 断言②（禁止路径）、断言③（必需文件反向保护）**零改动**，防回归能力保留。

---

## 三、风险

🔴 **CI / 打包发布红线**（Risk-sensitive）：

1. **本质是「放行」不是「瘦身」**：57.5MB 的安装包体积本身没变小，只是守卫不再误杀。注释已留 TODO：若后续做 `exceljs/dist` + `*.map` 排除瘦身，应把阈值再下调。
2. **阈值放大削弱了守卫灵敏度**：从 25→70MB 后，「未来又有大依赖/文档误入包」需新增 ≥13MB 才会触发告警，灵敏度下降。可接受（断言②禁止路径仍兜底常见误入场景），但属显式取舍。
3. 改动隔离在单文件单常量，无运行时副作用；全仓库扫描确认无单测断言旧阈值，CHANGELOG 内 25MB 为 v3.0.5 历史记录不回改。
4. ⚠️ `MAX_ASAR_BYTES` 可能命中 `rules/important-variables.md`——**提 PR 前须跑 `/check-vars`**。

---

## 四、验证

- ✅ `node --check scripts/check-dist-size.js` → syntax OK。
- ✅ 全仓库扫描（排除 node_modules/.git）：除本脚本外，硬编码 25MB 仅在 `CHANGELOG.md`（历史记录）；`package.json` 的 `dist:win` 等仅调用脚本无硬编码；无单测断言旧阈值。
- ✅ 逻辑判定：57.47MB < 70MB → 断言①通过；断言②/③未触及，行为不变。
- ⏳ **待 CI 实证**：合并/触发 main 的 `Build Windows Packages` 后，"Check dist size" 应打印 PASS 摘要（含实测体积 ~57.5MB / 上限 70MB），产物上传步骤恢复。本机为 macOS，无法本地产出 Windows asar，故 CI 为最终判据。

---

## 五、OPEN

| # | 问题 | 决策 |
|---|------|------|
| OPEN-1 | 阈值定 60MB 还是 70MB？ | ✅ **已定：70MB**（2026-06-16，余量考量；用户如坚持 60MB 可改） |
| OPEN-2 | 是否同时做真正瘦身（方向 1/3：排除 `exceljs/dist`、`*.map`、`*.d.ts`、README）？ | ✅ **已定：暂不做**（2026-06-16 用户拍板——v3.0.7 仅调阈值不扩范围，真瘦身记 backlog 后续版本评估） |
| OPEN-3 | main 上 #404 失败如何尽快止血？v3.0.7 PR 合并前 main 仍会构建失败 | ✅ **已定：先 hotfix main**（2026-06-16 用户拍板——把 check-dist-size 单常量改单独提小 PR 到 main 止血，不等 v3.0.7 整包） |
| OPEN-4 | `build` job 的 `if: github.event_name != 'pull_request'` 是否调整，让 PR 也跑体积检查以提前暴露？ | ✅ **已定：保持现状**（2026-06-16 用户拍板——PR 仍跳过 build 保持快；dist-size 已修、70MB 余量短期不复发） |
| OPEN-5 | 是否记入 CHANGELOG / 版本三件套？ | ✅ **已记入**（2026-06-16 v3.0.7 收尾：CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE 均含 dist-size 阈值段） |

---

## 六、决策记录

- 2026-06-16：用户反馈 #404 失败 → 诊断确认根因（§一）。用户先选「只诊断，先不动」，随后改选**方向 2（仅调阈值到现实值）**。
- 2026-06-16：阈值落 **70MB**（非用户初提 60MB，理由见 §二/OPEN-1），代码已改 `scripts/check-dist-size.js`，**未提交、未 PR**。
- 2026-06-16：用户指示「落 spec，落好了停一下」——本变更**停在 spec + 已落代码**阶段，等后续明确指令再走提交 / `/check-vars` / PR。
- 2026-06-16（v3.0.7 收尾）：文档三件套已记入本变更（OPEN-5 ✅）；`/check-vars` 已跑——`MAX_ASAR_BYTES` 命中 Risk-sensitive（§三 风险4 预判正确），自查＝单文件单常量、零运行时副作用、全仓无单测断言旧阈值，安全。仍**未提交 / 未 PR**，等用户「提 PR」。OPEN-2（瘦身）/ OPEN-3（main 止血）/ OPEN-4（PR 也跑 build 检查）待用户拍板。
- 2026-06-16（OPEN 收口）：用户 askuserquestion 拍板 4 项——**OPEN-3 先 hotfix main**（从 `origin/main` 拉 hotfix 分支，仅 `scripts/check-dist-size.js` 25MB→70MB 单常量改，提小 PR → main 止血，不等 v3.0.7 整包）；**OPEN-2 暂不瘦身**（记 backlog）；**OPEN-4 保持现状**（PR 仍跳过 build）；**守卫脚本不补专项单测**（依赖 CI build job 兜底）。hotfix 的 push/PR 仍等用户明确「提 PR」再执行。
