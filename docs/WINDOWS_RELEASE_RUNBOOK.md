# Windows 在线升级发布 Runbook

适用于 v3.0.18 及后续 Windows stable Release。发布流程定义在
`.github/workflows/release-windows.yml`，客户端只消费公开 GitHub Releases 的 `latest` 通道。

## 一次性仓库配置

由仓库管理员在 GitHub 完成，仓库文件不能替代这些服务端保护：

1. 创建名为 `production-release` 的 GitHub Environment，只允许受保护 tag 部署，并限制可审批人员。
2. 保护 `main`：禁止 force push 和删除，要求 PR 与必需检查通过后才能合并。
3. 建立 `v*` tag protection / repository ruleset：禁止非发布负责人创建、更新或删除发布 tag。
4. 确认 Actions 的 `GITHUB_TOKEN` 对 Release 具有 `contents: write`，除此之外不配置 PAT 或客户端凭据。
5. 保持仓库公开；若改为 private，立即停止 stable 在线升级并重新评审分发方案。

## 发布前

1. 确认 `main` 可发布、tracked worktree 干净，`package.json.version` 为目标版本。
2. 执行 `npm ci`、`npm run release-check`、`npm run scan:vars` 和
   `npm run check:vars -- --include-minor`。
3. 在 Windows 10/11 验证候选 setup 与 portable；无签名版本需记录 SmartScreen 实际提示。
4. 使用候选 Setup 执行离线 `N -> N+1` 覆盖安装，至少核对应用版本、SQLite、平盘 side DB、用户设置、存档和导出文件。公开 `production/latest` 的检查、下载、稍后、业务忙阻断和重启安装只能在目标 Release 存在后验证，仍按“发布后”第 2 项执行。
5. v3.0.18 是引导版本：从 v3.0.17 手动覆盖安装验证，不能宣称 v3.0.17 可在线升级。

若发布负责人决定豁免第 3 或第 4 项，必须在打 tag 前留下稳定的 GitHub PR/Issue 评论：
写明批准人、具体豁免范围、理由和发布后补做项。豁免只允许继续生成技术资产，不得把
对应项目标记为已验证或用于“人工验收通过”的公告。

## 创建发布

仅在上述门禁通过后创建一次 tag：

```bash
git switch main
git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

workflow 会拒绝以下情况：tag 不等于 `v${package.json.version}`、tag 不指向当前
`main`、tag 不是 annotated tag、同名 Release 已存在、测试/构建失败、`latest.yml` 与 Setup SHA-512 不匹配，
或缺少 Setup、portable、blockmap、metadata 任一资产。

发布前会保留本地中文品牌构建产物，并额外 staging ASCII 文件名：Setup 使用
`latest.yml.path`，portable 使用 `bank-bill-excel-tool-portable-<version>.exe`。Release
只能上传 staging 产物；GitHub 会自动改写含特殊或非字母数字字符的资产名，不能直接
用中文构建文件名作为发布后精确校验契约。

workflow 直接创建 published、non-draft、non-prerelease Release。不要手动替换或覆盖
已发布资产；故障必须发布更高补丁版本。

## 发布后

1. 核对 Release 为公开 stable latest，四类资产齐全且可匿名下载。
2. 用上一 stable NSIS 从生产 `latest` 做一次 canary，确认版本升级和用户数据保留。
3. canary 通过后再公告；失败时停止公告，不删除或替换同版本资产，修复后发布更高版本。
4. 保存 workflow URL、资产名和哈希、升级前后版本截图、数据保留证据和复核人。

## v3.0.18 发布记录

- Release：`https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.0.18`，tag 指向 `854460d1fc7da96c512ec13c9b9088971562f739`。
- Windows workflow `29622809519` 已通过 release-check、构建、应用检查、staging、哈希校验和 Release 创建；最后复核因 GitHub 将中文 portable 名规范化为 `-3.0.18-portable.exe` 而误报缺失。
- 线上 `latest.yml` 与 Setup SHA-512 已回读确认一致；portable 的大小、PE 头和 SHA-256 与 GitHub asset digest 一致。按不可变发布规则不修改 v3.0.18 已发布资产。
- 后续版本必须使用 ASCII portable staging 名，避免重复出现发布后名称漂移。
- 真实 Windows `3.0.18 -> 后继 stable` 必须等后继版本资产存在后执行。
