# 网银账单生成小助手

基于 Electron + SQLite + XLSX 的桌面端工具，支持在 Windows 10 和 Windows 11 上运行。

## 功能

- 导入 Excel / CSV 作为模版文件。
- 首次运行通过状态框导入网银账单枚举表，后续支持点击状态框覆盖导入。
- 导入 Excel / CSV 账单文件并按映射替换表头。
- 生成 `模版名-COMMON-执行日期.xlsx` 文件到按日期创建的目录中。
- 支持另存为导出生成文件。
- 将模版和映射关系持久化到 SQLite。
- 异常按日期写入日志文件。

## 运行

```bash
npm install
npm run init:enum
npm start
```

生成界面预览图：

```bash
npm run preview
```

## 打包 Windows 可执行文件

```bash
npm run dist:win
```

默认会同时生成安装包和免安装可执行文件：

```bash
dist/网银账单生成小助手-1.0.2-setup.exe
dist/网银账单生成小助手-1.0.2-portable.exe
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
- SQLite 数据库：Electron `userData` 目录下的 `tool-data.sqlite`

## 注意

- 枚举表不再从应用根目录自动读取，需在首次打开后点击状态框导入文件名带有“枚举”的 `.xlsx` 文件。
- 如果重复导入同名模版，系统会保留模版名称并重置旧映射关系，需重新维护映射。
