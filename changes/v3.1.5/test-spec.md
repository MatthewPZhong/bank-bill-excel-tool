# v3.1.5 Test Spec

## 定向回归

- `node --test tests/unit/main-process/position-reconciliation-filtered-source-report.test.js`
- 两个真实 `PositionReconciliationStore` 用例结束时必须先 `close()`，再递归删除 temp dir。
- 同一命令必须在 GitHub Actions `windows-latest` 的 PR job 通过。

## 完整门禁

- `npm run lint`
- `npm run release-check`
- `npm run verify:main-panel-alignment`
- `npm run scan:vars`
- `npm run check:vars -- --include-minor`
- 发布/update contract 定向单测。

## Release 验证

- tag 类型为 annotated，且 peeled commit 等于创建时最新 `main`。
- Release workflow 的 release checks、布局、构建、包体、更新资产和发布步骤全部成功。
- GitHub Release 为 stable/latest、non-draft、non-prerelease。
- 资产包含：
  - `bank-bill-excel-tool-setup-3.1.5.exe`
  - `bank-bill-excel-tool-setup-3.1.5.exe.blockmap`
  - `bank-bill-excel-tool-portable-3.1.5.exe`
  - `latest.yml`
- 回读大小与 SHA-256；`latest.yml` 的 version、path、sha512、size 与 Setup 资产一致。

## 非自动化结论

Windows 10/11 启动/SmartScreen、`v3.1.3 → v3.1.5` 离线覆盖、真实用户数据保留和 production/latest 在线升级 canary 均保持未执行，不能由 CI 成功替代。

## Release Evidence

- PR Windows run `30705791034`：smoke、SQLite teardown regression、布局全部通过。
- main 候选 Windows run `30705981990`：上述门禁、Setup/portable 构建、包体、更新资产暂存和上传全部通过。
- 正式 Release run `30706152991`：tag/main/version、完整 release checks、布局、构建、包体、更新资产哈希、不可变发布和公开 Release 复核全部通过。
- GitHub latest 为 `v3.1.5`，`isDraft=false`、`isPrerelease=false`，发布时间为 2026-08-02 00:01:11 +08:00。
- 独立下载资产核对：
  - portable：99,526,150 bytes；SHA-256 `afcc4917cbc3ef8633ae612ab154c7ded52338704f03600e31923d503d9116f2`
  - Setup：100,023,007 bytes；SHA-256 `27a1be3438bdedc1d338dbf85765c6bc258ae88c6c2a4c5a5b907a3d313b40ec`
  - blockmap：105,674 bytes；SHA-256 `753316861e5ea353e08a97bb959e0ce11aea287939f2714a137eea4c898e7682`
  - `latest.yml`：369 bytes；SHA-256 `afad0c3841d8142bf2ac1a84c041faa3eab594e7b9c3675139cd8c983066ee31`
- `latest.yml` 固定 `version/path/size=3.1.5/bank-bill-excel-tool-setup-3.1.5.exe/100023007`，SHA-512 与 Setup 实际字节一致。
