# 设置 → 账户管理（清结算系统银行账户表）

v3.2.15 起，清结算系统导出的银行账户表统一存放在这里，供以后各模块按需读取。需求与决策见 [spec](../../../changes/v3.2.15/feat/bank-account-management/spec.md)。

## 职责与存放

| 位置 | 职责 |
| --- | --- |
| `service.js` | 概况与分页查询、导入（选择 → 预检 → 确认替换）、另存为原表、对外只读接口 |
| `constants.js` | 识别结构资源 ID 与渠道列名，模板文件的必用列同样引用 |
| `workbook.js` | 解析 `.xlsx` / `.xls`：逐个工作表比较第 1 行表头，与当前识别结构完全一致的必须恰好一个；单元格转显示文本 |
| `src/backend/database/bank-account-repository.js` | 主库 `bank_account_snapshot`（单行元数据）与 `bank_account_rows`（按导入时表头对齐的账户行）；整份替换在一个事务内完成 |
| `{userData}/bank-accounts/<sha256>.<扩展名>` | 最近一次导入的原文件；导出按 SHA-256 核对后原样另存 |

- 表头识别结构取「设置 → 模板文件 → 清结算银行账户表」（`position-bank-accounts`）当前版本，与平盘链接原始表共用；该结构的必用列另含渠道列 `银行/通道简称`。
- 账户表属于轻量、长期的主数据，存主库；导入整份替换，不属于 run 级批量数据。
- 写入顺序：先写原文件，再在事务内替换元数据与账户行（预检时的 `snapshot_no` 不一致则回滚），成功后删除旧原文件。失败时账户表不变，新原文件被清理；首次读取概况时清理未被引用的原文件与写入中断的临时文件。

## IPC

| 通道 | 登记 |
| --- | --- |
| `bank-accounts:get-overview`、`bank-accounts:list` | exclude · read-only-query |
| `bank-accounts:pick-import-file` | exclude · file-picker-only（导入目录 scope `bank-accounts`） |
| `bank-accounts:prepare-import`、`bank-accounts:discard-import` | exclude · staging-preflight-only |
| `bank-accounts:commit-import` | support-action · bank-account-snapshot |
| `bank-accounts:save-as` | support-action · user-document-export |

变更后向各窗口广播 `bank-accounts:changed`。导入不登记存档中心：原文件由本服务保存并可另存，与模板文件导入一致。

## 对外只读接口

- `getSnapshotMeta()`：当前账户表元数据，未导入时为 `null`。
- `listAccounts({ channel })`：`[{ excelRowNumber, channel, record }]`，`record` 以表头为键；`channel` 为空串时返回全部。

接入方自行决定筛选口径（如维护大账号的“正常 + 参与对账”、平盘的“正常”），并在各自 spec 中定义；本期没有调用方。

## Renderer

`src/renderer/dialogs/bank-accounts.js` 导出 `__bankAccountsDialogs.createBankAccountsDialogs({ api, modalBridge, ui })`，由 `renderer.js` 以窄 API 装配，经 `ui.mountBankAccounts` 挂进设置弹窗；视图返回 `{ enter, leave, destroy }`，首次进入才读取。架构登记为 `renderer-dialog-bank-accounts`。

## 验证入口

- 单测：`tests/unit/backend/database/bank-account-repository.test.js`、`tests/unit/main-process/bank-accounts-service.test.js`
- 集成：`scripts/integration/bank-accounts-import-export.js`
- 界面：`node scripts/test-renderer-lifecycle.js bank-accounts`
