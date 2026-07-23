# Tasks — v3.0.25

## 1. 文档与基线

- [x] 建立 spec、test-spec、tasks、implementation notes
- [x] 更新版本号与三份版本文档
- [x] 更新重要变量清单

## 2. 设置弹窗

- [x] 全局按钮改为【确认】
- [x] 存档设置接入全局确认保存
- [x] 删除独立保存/取消
- [x] 保留 X/返回放弃语义
- [x] 保持下载完成时更新页【稍后】、存档页【确认】

## 3. 模板排除退役

- [x] 删除控制器模板排除状态与方法
- [x] 删除 Main/Preload IPC
- [x] 旧配置启动归一化为 `[]`
- [x] 网银/月度余额移除模板级 `skipArchive`
- [x] 保留 operation tracker 通用 `skipArchive`
- [x] 删除 Renderer 模板区域、状态和调用

## 4. 文案与视觉

- [x] 删除三段指定说明
- [x] 删除存档保留期说明和“默认保留”标签
- [x] 增加 60 天枚举并统一前后端默认值
- [x] 保留 portable 下载提示并收起 NSIS 空说明
- [x] 开关状态文字固定 14px
- [x] 用共享变量对齐更新内容右边界和确认按钮
- [x] 更新平盘第二项显示名称

## 5. 验证

- [x] 定向单测
- [x] 自动更新与存档设置 preview
- [x] 六组合设置几何验证
- [x] release-check
- [x] scan:vars / check:vars
- [x] startup:measure
- [x] team-lead 三层质量门禁

## 6. 合并归档与在线发布

- [x] PR #100 self-review 清零并以 merge commit 合入 `main`
- [x] 建立 PR 归档与版本 PRD
- [x] 在合并后的 `main` 上重跑干净依赖发布门禁
- [x] 创建并推送 annotated tag `v3.0.25`
- [x] 验证 Windows Release workflow 与 GitHub Release
- [x] 回读 `latest.yml`、Setup、blockmap 和 portable 公开资产
- [x] 回写最终发布证据并确认 tracked worktree 干净

## 7. 公告前人工门禁

- [ ] Windows 10/11 setup 与 portable 实机打开验证，并记录 SmartScreen 表现
- [ ] 使用上一 stable 完成 `v3.0.24 → v3.0.25` 生产在线升级 canary
- [ ] 核对升级后的 SQLite、用户设置与导出文件保留
