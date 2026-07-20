# Tasks — v3.0.20 主页面同类要素垂直对齐

## Task 1：冻结规格与基线

- 建立 spec、test-spec、tasks、implementation notes。
- 锁定 10 个目标模块、5 组控件、排除项和水平几何不变量。
- 状态：done

## Task 2：统一状态内容层

- 为 10 个状态框增加 `.status-box-content`。
- 固定图标盒与 SVG 显示方式，迁移资金对账状态框自动外边距。
- 保持新开账户状态框结构不变。
- 状态：done

## Task 3：统一标签与下拉框轨道

- 给 5 组标签/控件增加公共对齐类。
- 将 BU、前置资金对账绝对标签改为按 48px 控件轨道定位。
- 保留对账单修复右对齐和前置资金对账水平位移。
- 状态：done

## Task 4：测试与视觉验证

- 新增 DOM/样式契约测试并更新旧定位断言。
- 新增可复跑 Electron 几何脚本，执行双尺寸 × 100%/125%/150% 缩放测量，并接入 Windows PR/Release workflow。
- 执行 10 个主模块 preview。
- 回归新开账户状态框和资金对账滚动。
- 状态：done

## Task 5：版本、文档和质量门

- bump `package.json` / lockfile 至 3.0.20。
- 同步 `CHANGELOG.md`、版本历史和用户指南。
- 执行 release-check、scan-vars、check-vars 和最终 diff review。
- 状态：done（Windows workflow 待 PR 执行；安装版人工观感为发布后 canary）
