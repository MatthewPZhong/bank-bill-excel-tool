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
写明实际批准人、完整豁免范围、理由和发布后逐项补做计划。真实链接只在 PR/评论实际创建后记录，
不得预写占位链接；缺少这份稳定记录不得创建或推送 tag。豁免只允许继续生成技术资产，不得把
对应项目标记为已验证或用于“人工验收通过”的公告。

## 创建发布

仅在上述门禁通过后创建一次 tag：

从 tag 前最终同步/复验并准备推送 tag 起，到 Release workflow 的 `Verify tag and main` 成功为止，
冻结对 `main` 的 merge/push；不要求在此窗口之外全程冻结。tag 前若发现 `main` 漂移，必须重新同步并
复验门禁、文档和 Review。tag 推送后、校验成功前若 `main` 漂移，停止当前版本，保留且不改 tag，
并发布更高补丁版本。

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

workflow 直接创建 published、non-draft、non-prerelease Release。仅当 Release 与资产均尚未创建，
且可证明失败属于基础设施瞬时故障时，才可在代码、tag、commit 和打包输入完全不变的前提下，
受控重跑同一 tag/commit。产品、元数据或打包输入问题，或 Release 已创建后的失败，都必须停止
公告/推广并发布更高补丁版本。不得删除、替换、重传 tag 或资产。

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

## v3.1.11 发布记录

- Release：[v3.1.11](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.11)，annotated tag object `e17f29d262c48c59d162b7a61e18bce2b802c308` peeled 后精确指向发布时 `main@782415ae1f606da2adebe881ba7ab56b1b045137`。
- Windows workflow [32219459465](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/32219459465) 全绿，已完成 tag/main、release-check、布局、构建、应用检查、staging、更新元数据、Release 发布与回读。
- Setup `100359253` bytes / SHA-256 `c68ab388561c18fe3a77c074cba4709c6c61e40a57c88328a260033820880206`；portable `99862407` bytes / SHA-256 `68e61d634ea81ff4d56abc7fabb8aac71f758b731d29745f405f6c044bd52e5f`；blockmap `105645` bytes / SHA-256 `0e73c8d2077c278a0067fd0aa27ee67d83fdb36e5559c946b0aa4b08b2f935e6`；`latest.yml` `372` bytes / SHA-256 `728f5ba06a594e7b408d0e7a162241d35f68ad9762037e994f1ee0125abe998d`。
- `latest.yml` 的 version/path/size 与 Setup 一致，SHA-512 为 `d1MSPttwUnICShPzJnBJDhOfSlgAHRnsaFdpbnNVwFUzudQzgNkJ4mq1HetVHvPzSN1SPpmCNV3KLSaaXzE9KQ==`；Release 为公开、非 draft、非 prerelease 且是 latest stable。
- 四项资产的公开 URL 均以无凭据 HEAD 请求跟随重定向得到 HTTP 200；独立下载的 `latest.yml` 与 blockmap SHA-256 和 GitHub asset digest 一致。
- 发布负责人已确认 Windows 10/11 Setup、portable、SmartScreen 和 `3.1.10 -> 3.1.11` 离线覆盖安装全部 PASS，未使用发布前豁免。`production/latest` 在线 canary 必须在公开 Release 存在后另行执行；实际通过前不公告“在线升级已验证”。
- 已知随包文档问题：tag commit 中的 `docs/USER_GUIDE.md` 仍把 v3.1.11 写成“未发布候选”；发布后证据 PR 无法进入既有安装包。按本 Runbook 的不可变发布规则，不替换 v3.1.11 资产，改由 v3.1.12 更高补丁版本交付修正。

## v3.1.12 发布记录

- Release：[v3.1.12](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.12)。PR #157 以 merge commit `a8c632bad119eab6bca27b949dfb5956805cf3ae` 合入 `main`；annotated tag object `97462b6062dda9a31d409691b0d2c2dec94f0650` peeled 后精确指向该 merge commit。
- Windows workflow [32393079026](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/32393079026) 全绿，已完成 tag/main 校验、release-check、真实 Windows startup adapter、面板布局、构建、应用检查、staging、更新元数据、Release 发布与回读。
- Setup `bank-bill-excel-tool-setup-3.1.12.exe`：`100369733` bytes / SHA-256 `336d309751e918efa1e4a7eed366fd4a68facbe74724176b0f9b60bdf76b23eb`。
- portable `bank-bill-excel-tool-portable-3.1.12.exe`：`99872969` bytes / SHA-256 `dc753d024c9d4734a117871cc248b6a7a40ac4d5e558c78ca962b70599ada4fa`。
- blockmap `bank-bill-excel-tool-setup-3.1.12.exe.blockmap`：`105698` bytes / SHA-256 `60ad36761bd064b68fe4fa48d5935a21afae51e4e991101665fdac041f2e13f4`；`latest.yml`：`372` bytes / SHA-256 `feb714764acd0a1a236aa3f4f6fa10e902b61a27761263075d7b77d80093fb76`。
- `latest.yml` 的 version/path/size 与 Setup 一致，Setup SHA-512 为 `ZQ38NNiTax5KuwmrveUcjNCVBXQ2L4IDcYKrXaduPTpMMNPrp5uQE/4+K9/VHI7+mT0ki0N77riMPK2sIjAwmA==`；Release 为公开、非 draft、非 prerelease 且是 latest stable Release。
- 四项资产的公开 URL 均以无凭据 HEAD 请求跟随重定向得到 HTTP 200；独立下载的 `latest.yml` 与 blockmap SHA-256 和 GitHub asset digest 一致。发布负责人在 tag 前已确认 3.1.12 人工验收完成并授权发布，未使用发布前豁免。
- 当前收尾环境为 macOS，不能执行 Windows `3.1.11 -> 3.1.12` 的 `production/latest` 在线 canary。该项保持 `MANUAL / NOT RUN`；实际通过前不得公告“在线升级已验证”，且不得删除、替换或重传 v3.1.12 资产。若发现问题，按不可变发布规则发布更高补丁版本。

## v3.1.13 发布记录

- Release：[v3.1.13](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.13)。功能 PR #159 以 merge commit `9e68c0339427a91c1948f73bfae66f0a76d17b5c` 合入产品代码；发布准备 PR #160 以 merge commit `099f2c9c8078c83785d71c499a68f2a818ab8c7c` 合入 `main`。
- annotated tag object `5d5c9c828869bc82931cd1861f4cff3a099b5f32` peeled 后精确指向发布时 `main@099f2c9c8078c83785d71c499a68f2a818ab8c7c`。
- Windows workflow [32455995895](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/32455995895) 首次尝试在完整 `release-check` 通过后，真实 PowerShell process snapshot 因 15 秒硬超时以 `PROCESS_SNAPSHOT_TIMEOUT` fail closed；构建、资产 staging 和 Release 全部跳过，因此没有半成品 Release。PR #160 上同一探针已通过；同一 tag、同一 commit 的受控重跑随后通过全部 15 个步骤并创建 Release，未修改代码、tag 或资产。
- Setup `bank-bill-excel-tool-setup-3.1.13.exe`：`100371076` bytes / SHA-256 `0316f86d0300f33a034596863c295aec7cd31111de916892389c16117b63b06a`。
- portable `bank-bill-excel-tool-portable-3.1.13.exe`：`99874308` bytes / SHA-256 `918f858bffa1611ecce5fb8400c1da33fa62867bafd721b692a997b302be07ef`。
- blockmap `bank-bill-excel-tool-setup-3.1.13.exe.blockmap`：`105417` bytes / SHA-256 `7bb644b372282f8ecff8cea569f1adcedee01783dba7dd85725495e145d9129c`；`latest.yml`：`372` bytes / SHA-256 `12f3cb340aa8bd3b642a505010673bebbe3784d5368a558c8c42fc39d2550ff0`。
- `latest.yml` 的 version/path/size 与 Setup 一致，releaseDate 为 `2026-08-21T08:07:03.561Z`，Setup SHA-512 为 `4m7H4Xxq72n2u7Js89A0j/z2yORmKgaFA4P5l9EYWYBe5r8acJgRKb68/9slLPFhN2bBiMS5a7OFlplmDmwpJg==`。
- Release 为公开、非 draft、非 prerelease 且是 latest stable；四项资产均以无凭据公开 GET 完整下载，实际大小和 SHA-256 与 GitHub asset digest 一致，独立计算的 Setup SHA-512 与 `latest.yml` 一致。两个 EXE 均识别为 Windows PE/NSIS 自解压文件。
- GitHub API 当前报告 `isImmutable=false`，即平台级 immutable release 标记未启用；仓库发布流程和负责人仍必须把 tag/资产视为不可变，不得删除、替换或重传。若需要平台强制锁定，应另行启用 GitHub immutable releases，不在本次已发布资产上做变更。
- Windows 原生【返回 / 覆盖全部】按钮顺序/焦点、packaged 长任务关闭保护与系统字体、Windows 10/11 Setup/portable、SmartScreen、`v3.1.12 -> v3.1.13` 离线覆盖安装和 `production/latest` canary 仍为 `MANUAL / NOT RUN`；技术 Release 完成不是这些人工项 PASS。任一补测失败都停止推广并发布更高补丁版本。
- 仓库维护者已明确要求以后不再运行 `check-vars`，本次发布未执行 `scan:vars` 或 `check:vars`，不将其表述为通过。

## v3.1.14 发布记录

- Release：[v3.1.14](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.14)。功能 PR #162 以 merge commit `1cc5999c62e4666d56b542e37e54529f6177e6bc` 合入产品代码；发布准备 PR #163 以 merge commit `225d07d17a7c211348ba549734aaf84f602253cb` 合入 `main`。
- annotated tag object `fee1498311854a69fea666fe275511da89d99836` peeled 后精确指向 `225d07d17a7c211348ba549734aaf84f602253cb`，远端回读一致。
- Windows workflow [32508170702](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/32508170702) 全部 15 步 success；`Verify tag and main` 确认 tag/main 后继续完成 release-check、构建、应用检查、staging、更新元数据、Release 发布与回读。
- portable `bank-bill-excel-tool-portable-3.1.14.exe`：`99,874,669` bytes / SHA-256 `964944f588bfe4ca38b73bc9e45af3d795a5d05fec48ab1b52d942c541e02781`。
- Setup `bank-bill-excel-tool-setup-3.1.14.exe`：`100,371,449` bytes / SHA-256 `e71e17aa0525b92ca9d15c508ef48cd783ed24ebdd63ace82cb693a1920503df`。
- blockmap `bank-bill-excel-tool-setup-3.1.14.exe.blockmap`：`105,515` bytes / SHA-256 `831edeaa11a2e4015f812b81d794c38c9c7fed98fb179f05607bcf635c87ef10`。
- `latest.yml`：`372` bytes / SHA-256 `9dea317367aa36cde238c672b870151613686538da035a3f4472984a3a491a2c`；version 为 `3.1.14`，path/size 对应 Setup，releaseDate 为 `2026-08-21T17:58:41.566Z`，Setup SHA-512 为 `QmsR5uVGyBSwB1A8w7J70WyiIgqEE7HOLfZVXhxWPh91G3uREMH21u3tWcj+wYnB6T3fBvMydQevH6+fwUll4g==`，独立计算一致。
- Release publishedAt 为 `2026-08-21T17:58:54Z`，公开、非 draft、非 prerelease；GitHub 默认 latest 回读 `tagName=v3.1.14`。四项资产均以无凭据公开 HTTPS GET 完整下载，实际大小和 SHA-256 与 GitHub asset digest 一致；两个 EXE 均识别为 Windows PE32 GUI / Nullsoft Installer self-extracting archive，认证下载与匿名下载逐字节一致。
- PR #163 body 已稳定记录实际批准人、完整豁免范围、理由和发布后逐项补做计划；从最终同步/tag 推送到 `Verify tag and main` 成功的最小 `main` 冻结窗口已执行并闭合。workflow 首轮成功，没有触发受控重跑。只有 Release/资产均未创建且可证明为基础设施瞬时故障时，才可在代码、tag、commit、打包输入不变的前提下重跑同一 tag/commit；产品、元数据、打包输入问题或 Release 已创建后的失败仍必须改发更高补丁。
- GitHub API 当前报告 `isImmutable=false`；仓库流程仍把 tag/资产视为不可变，不得删除、替换或重传。
- Windows packaged VCC 阶段切换与取消体验、Windows 10/11 Setup/portable、SmartScreen、`v3.1.13 -> v3.1.14` 离线覆盖安装和 `production/latest` canary 仍为 `MANUAL / NOT RUN`；技术 Release 完成不是这些人工项 PASS。任一补测失败都停止推广并发布更高补丁版本。
