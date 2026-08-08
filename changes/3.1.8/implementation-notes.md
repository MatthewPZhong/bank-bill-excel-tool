# Implementation Notes

## Baseline

- Goal/spec: `/Users/pzhong/Downloads/v3.1.8-codex-spec-final.md`，SHA-256 `9f3af33df52907499ec673b20f808b7615e7edf10231a33508c8eb5acd2a76de`；Q01～Q12 全部锁定。
- Initial plan: 按 Spec Phase 0～6 建立六个堆叠草稿 PR，分别覆盖输入契约、状态模型、破坏性事务、调整 UI、模板导出与发布收口。
- Done when: `changes/3.1.8/preflight.md` 的 Done when 与 Spec §15 同时满足；人工财务核对门禁保持开启。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 使用堆叠 PR，后续分支以直接前序分支为 base | 数据库和 UI 阶段存在真实依赖，同时需要每个 PR diff 可独立评审 | 一个大 PR；每个 PR 都从 main 重复带依赖 | 合并顺序必须固定，PR body 标明依赖 |
| PR 1 同时包含 Pending 资产、代码契约、历史 hash 迁移与运行门禁 | 单独只改表头会制造历史同键异内容冲突；只改门禁会让合法新模板仍无法导入 | 将资产/迁移/门禁拆散 | 这一 PR 是后续资金计算的输入可信基座 |
| 系统财务OP数据管理导出以 `balances_json` 为九币种财务余额唯一权威源，`raw_json.rows[].displayValues` 仅保留其余 15 列展示血缘 | PR #124 review 用真实精度反例证明显示值 `135886024.6` 会覆盖 canonical `135886024.59`；Spec §4.7.3 要求数据管理全链路保持原精度 | 继续从 `displayValues` 导出全行；在 writer 内重算余额 | 仅“财务余额”按 `normalizedCurrency` 覆盖为 canonical；九币种集合、金额或读取证据损坏时 `invalid-export-lineage` 失败关闭，不回退显示值 |
| 两份已在工作区且哈希匹配的模板视为用户提供的本迭代资产 | 哈希与 Spec §2.3/§2.4 精确一致 | 重新生成或肉眼复制模板 | 保留用户原始工作簿字节，测试不得改写 golden |
| 极老残缺审计表为空时允许补列；若已有 Pending 行却缺少 `raw_json` 等重算证据则失败关闭 | 无原始 46/48 列载荷无法证明新 hash，静默跳过会制造同键异内容 | 猜测列序或沿用旧 hash | 空旧库兼容升级；有事实但无血缘的旧库必须人工处理 |
| 系统财务OP金额以 workbook relationship 指向 worksheet 的原始 `<v>` lexical token 为第一权威源 | SheetJS 在形成 `Number` 前可能已合并大额分币，显示值也可能被单元格格式截断 | 继续信任 SheetJS `raw:true` Number；从显示文本反推 | 公式使用缓存 `<v>`；重复余额 cell、空/损坏 XML 稳定以 `amount-precision-invalid` 失败关闭；只有明确缺少 OOXML relationship/entry 时才进入 Number fallback |
| OOXML 缺失时的 Number fallback 允许安全整数，非整数在 `abs(value) >= 2^46` 时拒绝 | 15 位整数在 `Number.isSafeInteger` 时可精确证明；`2^46` 起浮点相邻间距已不能保证分币唯一 | 所有大于低阈值的 Number 一律拒绝；继续放行至 `MAX_SAFE_INTEGER` | 合法 15 位整数不误伤，大额非整数缺 lexical 证据时 fail closed；最终仍受两位小数与 15 位有效数字门禁约束 |
| 财务OP运行必须同时通过主进程 service 与 worker 内 `expectedInputFingerprint` 校验 | 可选 fingerprint 允许绕过“预检确认 → 事务内二次预检”的状态一致性门禁 | 仅依赖 renderer 总会传参；只在主进程入口校验 | 缺失、格式非法或与最新状态不一致均不写计算结果；伪造 64 位值只能进入 `state-changed`，不能放行 |
| preflight 以稳定顺序返回完整 `issues[]`，renderer 逐条展示；损坏系统快照不再冒充 missing dataset | 单一 top-level code 会遮蔽同账期其它待处理问题，用户需反复运行才能逐个发现 | 保留 first-error-only；把 invalid snapshot 继续塞入 `missing` | 兼容保留 top-level code/missing 等字段，同时一次展示 active、缺失/空表、快照损坏、归档、未处理导入和主体差异 |
| 后置候选表头通过 row-scanner 的按行稀疏全宽模式校验到 XFD | 原扫描器只有物理第 1 行全宽，后置 Pending 表头的 BM/XFD 增列会被 64 列预览截断 | 将所有行稠密扩到 16384 列；只扩大固定预览宽度 | 普通数据行契约不变；候选行只物化实际非空 cell，XFD fixture 仅有 2 个数组键；正式读取再次全宽核验命中表头行 |
| `systemRowError` 同时保留顶层定位字段与 JSON-safe `context` | worker 错误序列化只透传 `context`，原顶层 `sourceRow/fieldName/sheetName` 会在主进程丢失 | 扩展全局 serialize-error 的专用字段列表 | 保持库内旧调用兼容，跨 worker 的 `amount-precision-invalid` 仍可定位 sheet、行和字段 |
| GitHub 认证问题不阻塞本地实现 | `gh` 已安装但 token 失效；代码和测试均可离线推进 | 等待登录后才开始编码 | push/PR 创建仍明确阻塞，不能声称已发布 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 未跟踪的其他 change、预览和输出文件不属于 v3.1.8 | 与 Spec 文件清单和目标模块无关 | 误提交用户资料 | 始终显式暂存；每次 commit 前检查 staged diff |
| 后续 PR 可暂时保持草稿和堆叠 base | 用户要求“按 Spec 里的多 PR 推进”且未要求每个立即合入 main | GitHub 展示/合并顺序需维护 | PR body 标明前序；前序合并后再重设 base |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| Spec 建议六个提交 | 六个堆叠 PR，每个 PR 内可含少量聚焦提交 | 用户明确要求多 PR 推进 | 评审与回滚粒度更细，功能口径不变 | 是（本实施记录） |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `git rev-parse HEAD` | `dff07df11fb94ce84940b474b55ac796f084d241` | 基线无漂移 |
| 两份模板 `shasum -a 256` | 分别匹配 `f7967d...a9fc`、`f920fd...1f4` | 用户资产身份 |
| PR 1 定向单测 | `104/104 PASS` | Pending 46/48 列契约与迁移、五表预检、原始数值精度、审计/导出兼容、renderer 接线 |
| PR #124 review 导出精度定向回归 | `node --test tests/unit/main-process/vcc-financial-op-dataset-writer.test.js` 返回 `6/6 PASS` | 原表/校验表重新打开后 JPY 为 `135886024.59`；其余显示列及 CNY→CNH 展示血缘不变；`balances_json` 缺失/非对象/币种缺失或重复/金额非法/读取证据不一致均结构化失败关闭 |
| 极老审计表回归 | 空残缺表可幂等补审计列；存在 Pending 行但缺 `raw_json` 时事务回滚且历史 hash 不变 | 迁移兼容与失败关闭 |
| 真实样本 `/Users/pzhong/Downloads/财务OP (22).xlsx` | PPHK JPY 读取为 `135886024.59`；检测到显示值 `135886024.6` 与原始值不一致并保留审计证据 | 原始数值优先及大额两位小数不被显示格式截断 |
| PR 1 `npm run release-check` | lint 通过；smoke 通过；unit `4587/4587 PASS`；integration `44/44` 脚本、`2051/2051` 断言通过 | 全仓静态检查、核心业务回归、迁移/大文件/side DB 集成门禁 |
| PR 1 review 定向回归 | 核心 7 文件 `93/93 PASS`；system importer + serialize-error `42/42 PASS` | 正负大额分币、relationship 重定位、公式缓存、安全 15 位整数、重复/损坏 XML、跨 worker 定位上下文、强制 fingerprint、多问题完整展示、后置 XFD 增列与稀疏键数 |
| PR 1 review 全仓门禁 | changed src ESLint 通过；smoke 通过；unit `4600/4600 PASS`；integration `44/44` 脚本、`2051/2051` 断言通过；`git diff --check` 通过 | 共享 row-scanner 四方等价、VCC 资金计算、迁移、全仓模块与大文件集成零回归 |
| `gh auth status` | 默认账号 token invalid | 仅 GitHub 发布被阻塞 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 生产历史 Pending raw_json 是否有未知列数 | PROBE | Codex 在 PR 1 建 dry-run 迁移测试；运行时异常 fail-closed | 阻塞 PR 1 合并 |
| Windows 打包资产与 Excel/WPS 实际显示 | PROBE + 人工门禁 | PR 6 Windows CI 与财务人员 | 阻塞版本发布 |
| GitHub 登录恢复 | BLOCK（发布） | 用户执行 `gh auth login -h github.com`，Codex 复检 | 阻塞 push/PR，不阻塞实现 |
| 真实月份逐主体逐币种复核 | BLOCK（发布） | 财务人员按最终核对清单执行 | 阻塞 3.1.8 发布 |
