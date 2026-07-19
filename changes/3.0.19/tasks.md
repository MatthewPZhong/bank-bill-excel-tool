# Tasks — v3.0.19 工具箱多 Sheet 合并

## Task 1：冻结契约与基线

- 建立 spec、test-spec、tasks、implementation notes。
- 锁定可见 sheet、严格表头、顺序、混合格式和超限分页规则。
- 状态：done

## Task 2：实现严格多 Sheet 读取

- 扩展 XLSX sheet 元数据为 `name/entryPath/state`，按 workbook 显示序读取。
- 在既有多 sheet reader 旁新增严格逐 sheet 表头模式，不改变拆分续页模式。
- 为 XLS/CSV 提供相同回调契约和可见性判定。
- 状态：done

## Task 3：实现合并编排与资源清理

- 首个有效表头出现后懒创建流式 writer，逐文件逐 sheet 校验并写入。
- 接回 `toolbox:merge`，保持 IPC、UI和默认文件名。
- 所有路径清理临时目录和打开的输出/输入资源。
- 状态：done

## Task 4：测试与回归

- 补严格 reader、混合格式、可见性、表头错误、顺序、分页和清理单测。
- 补多 sheet merge 集成与大文件有界内存回放。
- 回归既有单 sheet merge、multi-sheet split和 worker 通道。
- 状态：done

## Task 5：版本、文档和质量门

- bump `package.json` / lockfile 至 3.0.19。
- 同步三份版本文档、重要变量清单与统计报告。
- 执行 release-check、check-vars、startup measure及最终 diff review。
- 状态：done（自动化门禁全部通过；Excel/WPS 人工打开检查待业务验收）
