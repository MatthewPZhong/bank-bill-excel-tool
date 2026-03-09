# Changelog

## 1.0.1 - 2026-03-09

- 新增 Windows `portable` 免安装打包目标，可生成直接运行的单文件 `exe`。
- 新增 `npm run dist:win:portable` 和 `npm run dist:win:setup` 脚本。
- 调整 `npm run dist:win`，默认同时生成安装版和免安装版。
- GitHub Actions 现在同时上传 `windows-installer` 和 `windows-portable-exe` 产物。
- 为 Windows 主进程补充 `AppUserModelId` 设置，提升便携版系统集成兼容性。

## 1.0.0 - 2026-03-09

- 初始化 Electron 桌面端应用骨架，支持 Windows 10 / 11。
- 实现自定义窗口栏、拖拽窗口、最小化 / 最大化 / 关闭。
- 实现模版导入、模版列表管理、映射关系设置与删除确认。
- 实现基于 SQLite 的模版和映射关系持久化。
- 实现 Excel / CSV 导入校验、COMMON 枚举加载、账单转换和 Excel 导出。
- 实现按日期生成输出目录与日志文件。
- 在页面右下角显示应用版本号。
- 补充版本迭代说明和版本回溯文档。
