# 网银账单生成小助手

基于 Electron + SQLite + XLSX 的桌面端工具，支持在 Windows 10 和 Windows 11 上运行。

完整用户使用说明见 [docs/USER_GUIDE.md](./docs/USER_GUIDE.md)。

版本功能变更清单见 [docs/VERSION_FEATURE_HISTORY.md](./docs/VERSION_FEATURE_HISTORY.md)。

## 功能

- 导入 Excel / CSV 作为模板文件。
- 网银账单生成模块支持直接导入原始账单文件：系统会自动在第一个 sheet 中定位真实表头，清理前置说明行、左侧脏列和右侧空尾列后再继续转换。
- 应用内置 `COMMON枚举.xlsx`，启动后自动加载网银账单枚举表。
- 导入 Excel / CSV 账单文件并按映射替换表头。
- `导入文件` 支持一次选择多个原始账单文件，并将同一批次文件合并处理。
- 支持账户映射模块，将模板中映射为 `MerchantId` 的字段值按大账户映射表转换为清结算系统大账户ID。
- 导出文件中 `Credit Amount` / `Debit Amount` 强制输出为数字格式，`BillDate` / `ValueDate` 强制输出为日期格式，`MerchantId` / `Channel` 强制输出为文本格式。
- 明细账单导出时不再保留 `Balance` 列；若需要余额值，请使用“导出余额”。
- 导入文件中映射为 `Credit Amount` / `Debit Amount` 的原始值会先清洗为仅保留数字和 `.`，再按数值写入导出文件。
- 导入文件中映射为 `Balance` 的原始值也会先清洗为仅保留数字和 `.`，再按数值参与余额账单生成。
- 若某条记录的 `Credit Amount` 与 `Debit Amount` 同时为 0 或空值，该记录不会参与导出的明细账单和余额账单生成，并会在状态框提示。
- 若某条记录的 `Credit Amount` 与 `Debit Amount` 同时有值，系统会中止导出并生成详细报错文件。
- 应用内置 `assets/币种映射表.xlsx`；`Currency` 若不是纯英文，会优先按映射表模糊替换为英文简称，匹配失败时保留原值并生成可导出的报错文件。
- 当 `MerchantId` 选择 `自己输入` 时，会直接进入“维护大账号”模式，由维护的大账号配置统一接管 `MerchantId + Currency`。
- 当维护大账号只展开出 1 条 `大账号 + 币种` 组合时，导入时会自动直通，不再弹出选择框。
- 同一模板在当前软件打开期间已导入过 2 次及以上时，点击 `导出明细` / `导出余额` 会先提示用户选择“导出当前文件”还是“导出所有”结果；该统计范围只按模板，不再按大账号 / 币种拆分。
- `导出所有明细` / `导出所有余额` 会把同一模板的多个大账号、多个币种结果整合到同一个文件里；这类文件命名不再带大账号。
- 映射关系弹窗已升级为“映射关系管理”，并支持“根据发生额做映射的户名 / 账户号”规则，可按收支方向分别映射 `Payee Name`、`Payee Cardno`、`Drawee Name`、`Drawee CardNo`。
- 明细账单按 `模板名-COMMON-最早账单日期~最晚账单日期.xlsx` 命名，余额账单按 `模板名-BALANCE-最早账单日期~最晚账单日期.xlsx` 命名；单日账单不带 `~`。
- 当模板启用了 `Balance` 且遇到“同一账单日存在多个余额、但当前无法取得上一账单日余额”的场景时，系统会先尝试读取本地余额种子；若仍取不到，会提示用户补录上一账单日日期和余额，并在保存后立即重试余额校验。
- 混合币种账单会按币种分别计算余额，再把所有币种结果整合到同一个余额文件、同一个 sheet 中导出。
- 本地余额种子保存在 `文档/网银账单生成小助手/balance-seeds/`；文件按银行拆分，记录键为 `MerchantId + Currency + BillDate`，并带有 `生成方式` 字段。
- 当模板启用了 `Balance` 时，`MerchantId` 必须映射且导入值不能为空，否则余额账单不会生成。
- `Balance` 映射新增固定选项 `通过发生额计算`；启用后会按 `上一账单日余额 + Credit Amount 汇总 - Debit Amount 汇总` 生成余额账单。
- 映射关系管理新增 `按正负号拆分的发生额`；对于单列带正负号的原始发生额，可自动拆分为 `Credit Amount` / `Debit Amount`。
- `BillDate` / `ValueDate` 会自动清理时分秒、补齐年月日位数，并在导出时按 `YYYY-MM-DD`、`YYYY/MM/DD`、`YYYYMMDD` 之一写出显示格式。
- 模板管理页新增 `大账号` 列和 `重命名`；`MerchantId` 选择 `自己输入` 后，可直接通过“维护大账号”维护多个“大账号 + 币种”配置，并在导入时自动使用唯一组合或选择本次使用的组合。
- 映射关系管理保存失败时，会先弹出错误提示；确认后回到原编辑内容继续修改，不会丢失当前草稿。
- 模板会自动同步到 `文档/网银账单生成小助手/templates/template-library.json`，并支持 JSON 模板包导入与导出。
- “新开账户生成网银账单”模块导出文件命名规则为 `银行名称-所在地-银行账号-币种-NEW_BALANCE.xlsx`；多币种账户时，其中“币种”固定输出为 `多币种`。
- “新开账户生成网银账单”模块支持多币种账户模式；勾选后可从 `币种映射表.xlsx` 的 C 列多选币种并批量生成多行余额账单。
- 所有用户侧报错都会生成详细报错文件，状态框可点击导出；报错文件名规则为 `YYYYMMDD-HHMMSS-模板名-错误步骤.txt`。
- 支持“新开账户生成网银账单”模块，可按开户日期和月末日期批量生成零余额账单。
- 支持另存为导出生成文件。
- 将模板和映射关系持久化到 SQLite。
- 异常按日期写入日志文件，并会在文档目录生成 `app_activity_log.txt` 记录关键操作与报错。

## 运行

```bash
npm install
npm start
```

生成界面预览图：

```bash
npm run preview
```

生成账户映射页预览图：

```bash
npm run preview:account
```

同步应用图标资源：

```bash
npm run icon:sync -- /path/to/source.png
```

## 打包 Windows 可执行文件

```bash
npm run dist:win
```

默认会同时生成安装包和免安装可执行文件：

```bash
dist/网银账单小助手-1.4.1-setup.exe
dist/网银账单小助手-1.4.1-portable.exe
```

如果只想生成免安装的单文件 exe：

```bash
npm run dist:win:portable
```

如果只想生成安装包：

```bash
npm run dist:win:setup
```

## GitHub 下载说明

- GitHub 网页上的 `Download ZIP` 下载的是源码，不包含已构建的 `exe`。
- 如果需要现成安装程序，请到仓库的 `Actions` 页面下载 `windows-installer` 构建产物。
- 如果需要直接运行的单文件 exe，请下载 `windows-portable-exe` 构建产物。
- 如果是在本地 Windows 机器上自行生成，执行 `npm install` 后运行 `npm run dist:win`。

## 产物说明

- `setup.exe`：安装版，适合正式分发给终端用户。
- `portable.exe`：免安装版，下载后可直接运行。
- 根据 electron-builder 官方文档，Windows `portable` 目标是“portable app without installation”，而自动更新能力对应的是 NSIS 目标，因此如果后续要做自动更新，仍建议优先保留安装版。

## 数据和日志目录

- 生成文件目录：`文档/网银账单生成小助手/exports/执行日期`
- 日志目录：`文档/网银账单生成小助手/logs`
- 报错文件目录：`文档/网银账单生成小助手/error-reports/执行日期`
- 本地余额种子目录：`文档/网银账单生成小助手/balance-seeds`
- 模板库文件：`文档/网银账单生成小助手/templates/template-library.json`
- 应用运行日志：`文档/网银账单生成小助手/app_activity_log.txt`
- SQLite 数据库：Electron `userData` 目录下的 `tool-data.sqlite`

## 注意

- `COMMON枚举.xlsx` 已随应用打包，启动后自动加载，不再需要首次导入枚举表。
- 如果重复导入同名模板，系统会保留模板名称并重置旧映射关系，需重新维护映射。
- 每次版本迭代时，请同时更新 `CHANGELOG.md` 和 `docs/VERSION_FEATURE_HISTORY.md`。

## 已知风险

- 当前依赖 `xlsx@0.18.5` 存在 `npm audit` 报告的 1 个高危漏洞。
- 该问题来自 `sheetjs` 的已知安全公告，当前 `npm audit fix` 无法自动修复。
- 后续每次版本迭代前，建议继续复核该漏洞状态，并评估是否迁移到其他 Excel 读写库。
