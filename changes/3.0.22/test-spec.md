# Test Spec - v3.0.22 设置页内存档中心

> source: `changes/3.0.22/spec.md`
> updated: 2026-07-21

## 1. 测试不变量

| ID | 不变量 |
|---|---|
| INV-01 | 只导入未运行时不创建运行批次或 Blob。 |
| INV-02 | 成功运行/成功生成只建一个批次，绑定本次启动周期可证明的输入。 |
| INV-03 | 只登记第一次成功结果；后续另存、重复、聚合和区间导出不追加。 |
| INV-04 | 相同字节只保存一个 Blob，不同逻辑引用仍全部存在。 |
| INV-05 | 删除/清理只删除目标引用，最后引用才删除 Blob。 |
| INV-06 | 锁定批次不自动清理且不能直接手动删除。 |
| INV-07 | 归档失败不改变业务返回、业务 DB 或正常结果文件。 |
| INV-08 | 错误报告、配置、工具箱、数据库和历史文件不进入存档。 |
| INV-09 | 资金对账、对账单修复、链接表和临时 MPT 的活动批次互不串用。 |
| INV-10 | Renderer 只能按批次/文件 ID 操作，不能取得 Blob 或源文件绝对路径。 |
| INV-11 | 显式 run key 未命中时不得回退到最新批次；同名文件不得按文件名串绑。 |
| INV-12 | 业务成功后的文件发生变化时不得存入变化后字节；整批文件须在复制前全部登记。 |

## 2. 单元与集成测试

### 2.1 Repository

- 幂等建表。
- 本地日期流水生成、跨模块代码隔离、删除最高批次后游标仍不回退。
- 批次列表按本地日期和创建顺序稳定排序，不比较不同模块各自的日流水号。
- artifact 成功/失败/重试状态和批次汇总。
- 相同 SHA-256 多引用、最后引用释放。
- 到期日、永久、锁定和过期筛选。
- pending 中断、断裂引用和 Blob 失效修复。

### 2.2 Archive service

- 流式复制、SHA-256/大小校验、同文件系统原子发布。
- 相同内容去重；同大小不同内容不合并。
- 源丢失、权限、rename 和元数据提交失败返回失败对象，不向业务抛出。
- 业务成功时的文件身份快照与复制前 stat 不一致时返回 `ARCHIVE_SOURCE_CHANGED`，公开对象不泄露内部快照。
- 批量文件在首个 read stream 打开前已全部登记，正常退出等待后台队列排空。
- 失败后按原源路径重试。
- 启动清理 `.staging`、`.readonly` 和孤儿 Blob。
- 打开只读副本、另存取消/成功、Blob 不被修改。
- 共享 Blob 删除与到期清理。
- 另存为覆盖失败时恢复原目标；若恢复也失败，返回仍可人工找回的备份路径。
- 另存目标通过 symlink/junction 指向存档根目录时仍拒绝写入。

### 2.3 Controller / IPC

- 保留期只接受 30/90/180/365/永久，缺失或非法值回退 90。
- 模板排除按稳定 ID 持久化；损坏设置隐私优先排除全部现有网银模板。
- 列表按日期/模块/批次号筛选，详情不返回源路径。
- 锁定、删除、重试、打开和另存结果统一映射为 renderer 契约。
- preload 暴露 12 个 `archiveCenter` API；main 注册同名 IPC。
- 删除元数据成功但物理 Blob 清理失败时，返回 `metadataDeleted=true`，UI 不误报整批仍存在。

### 2.4 十一模块策略

| 模块 | 正向用例 | 反向/旁路用例 |
|---|---|---|
| 网银账单 | 直接成功、大账号续接、余额补录、月度余额 | 模板排除、失败导入、重复导出 |
| 新开账户 | 生成成功归档结果 | 生成失败、后续另存 |
| Pending | 上下月+移除输入、单 run 输出 | 只导入、聚合输出、历史持久数据空批 |
| 资金对账 | 银行/退款输入、首次结果、网关修复来源 | 错误报告、链接表批次抢占、重复导出 |
| 对账单修复 | 专用页面运行、双结果 | 资金对账来源误归、第二次导出 |
| 银行 BU | 双输入、单 run 输出 | 聚合输出、跨月输入串用 |
| 业务 OP | 日期双源输入、单日期输出 | 日期区间输出、跨日期串用 |
| 收单币种 | 流水/单据输入、运行内结果 | 覆盖确认二次调用丢路径、重复结果 |
| VCC OP | scan 后 save 归档输入 | compute 不建批、无伪造输出 |
| 前置资金 | 银行输入、渠道结果集合 | 临时 MPT/修复批次抢占、错误数据输出 |
| 重复入金 | 银行+单据输入、邮件结果 | 只导入、第二次导出 |

- 仅归档白名单内的业务 IPC 创建 AsyncLocalStorage 上下文；无关 IPC 不保留参数、不排入空任务。
- 重启后历史单次导出没有当前周期活动批次时，不创建 output-only 批次。
- 当前仍有最新批次时，显式历史 run key 未命中也不得回退追加；月度余额不得抢占普通账单余额补录批次。
- 临时 MPT 修复存在不同目录同名文件时按结果下标筛选，仅存真正成功项。

### 2.5 UI

- 每次打开设置默认“自动更新”；自动更新现有选择器和事件仍存在。
- 左侧只有“自动更新 / 存档中心”；主模块仍是 11 个。
- 存档筛选只有日期、模块、批次号。
- 空态、加载态、失败提示、批次选择和详情切换可见。
- 文件操作、重试、锁定和删除均有可访问名称与二次确认。
- 保留期、模板不存档和唯一/逻辑大小可设置、可显示。
- 锁定批次仍显示真实到期日，并追加“已锁定”，不误显示为永久保留。
- `1240x860` 与 `1080x760` 无横向溢出、重叠或按钮截断。

## 3. 必跑命令

```bash
node --test tests/unit/backend/database/archive-repository.test.js \
  tests/unit/main-process/archive-service.test.js \
  tests/unit/main-process/archive-center-controller.test.js \
  tests/unit/main-process/archive-operation-tracker.test.js \
  tests/unit/main-process/archive-source-snapshot.test.js \
  tests/unit/archive-center-ui-contract.test.js
npm run preview:archive-center
npm run lint
npm run release-check
npm run scan:vars
npm run check:vars -- --include-minor
npm run startup:measure
```

## 4. 手工验收

1. 在 11 个模块各选择一份脱敏文件，完成一次成功运行/生成和首次输出。
2. 对源文件、正常结果和对应存档 Blob 分别计算 SHA-256，确认字节完全一致。
3. 同一文件重复用于两个批次，确认逻辑文件为两条、唯一物理文件为一份。
4. 锁定一个到期批次后重启，确认未清理；解锁并到下次启动确认被清理。
5. 制造一个源文件丢失或存档目录不可写场景，确认业务仍成功、存档失败可见且可重试。
6. Windows 100%/125%/150% 显示缩放下检查设置页最小窗口。
7. 在业务完成后、后台存档开始前替换同路径文件，确认原业务成功但存档拒绝错存，并提示重新执行业务。

⚠️ 资金红线：本迭代不改业务计算，但存档宣称提供输入/结果血缘。真实文件摘要、模块归属和首次结果必须人工抽查，不能仅凭模拟策略测试验收。

## 5. 合并与发布证据

- 存档专项测试 `64/64 PASS`；最终 `npm run release-check` 为 unit `3780/3780`、integration `1955/1955`、Smoke 全通过。
- GitHub PR #97 Windows workflow 通过；最终 self-review 为 P0-P4 Finding 0。
- PR #97 已由 merge commit `116eee1` 合入 `main`。
- 合并归档后的最终 `main` 已在干净 `npm ci` 依赖上重新通过 release-check、主页面几何门禁 `6/6`、变量扫描和重要变量复核。
- 首次发布 workflow run `29814335578` 在打包前失败，未创建 Release 或资产；根因为测试写死 POSIX 路径和 LF 换行。修复后定向测试 `34/34`、完整 release-check（unit `3780/3780`、integration `1955/1955`、Smoke）再次通过。
- annotated tag `v3.0.22` 指向 `9e40a298f2f85fa82ce10b5eed941a0b4716a48a`；Windows Release workflow run `29816044492` 全部通过。
- GitHub Release `v3.0.22` 已发布为 latest、非 draft、非 prerelease；Setup、portable、blockmap 和 `latest.yml` 四个资产齐全。匿名 Range 回读的两个 EXE 文件头均为 `MZ`，`latest.yml` 为版本 `3.0.22` 且 Setup 大小匹配资产元数据。
- 真实文件 SHA-256、11 模块归属和 Windows Excel/WPS 只读表现继续保留为人工 follow-up。
