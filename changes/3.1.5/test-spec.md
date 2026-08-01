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
