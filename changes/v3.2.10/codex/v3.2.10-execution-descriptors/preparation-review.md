# G7-T1a 准备切片独立复核

日期：2026-09-21。范围：两个 baseline helper、两个固定 JSON fixture、两个测试文件。代码基线为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9` 加本次未提交新增文件；摘要见 [最终快照](evidence/delivery-snapshot.json)。

结论：未发现阻断准备切片的问题。独立复核者运行同一两文件单测，43/43 PASS、0 fail/skip/TODO，与主流程 [联合测试证据](evidence/preparation-tests.json) 一致。这不是正式 descriptor 装配审查，也不标记 G7-T1 全部完成。

- JSON 期望固定读取，测试不重新生成或覆盖期望；Archive 另有独立 authority/manifest/digest 交叉检查与等数量身份篡改负例。
- Archive 的 27 个场景组展开为 6,357 次 channel/sample 行为比较；callable 标记与行为观测分开，相同形状但改变分类/lineage 的负例能被发现。
- 资源验证实际经过原 Supervisor，静态 phase fallback、NewAccount 动态估算、Promise/slots 拒绝均走真实现有路径。探针在创建载体前停止。
- 19 次缺 authority、10 次字段 override 拒绝来自真实 runtime.execute；尚未证明正常注入、beforeDispatch 成功、defaultUnits 和跨 generation 行为。
- 两个 JSON 递归扫描无绝对路径值。worker 路径是仓库相对路径，业务样例为合成数据。测试中的合成绝对路径仅作为准入前参数，没有读写这些文件。
- `src`/`scripts` 没有引用本次 helper，没有新增生产 hook 或文件写入。

证据归属限制：runtime helper 中的 Main binder 分组与 `ESTIMATOR_OWNER` 是人工代码清点元数据，不是从实际 closure 自动反推的事实。冻结快照比较证明注册与策略保持，补充探针证明列明的拒绝与资源行为；不能扩大为全部函数行为或来源自动证明。

剩余义务仍归原 G7-T1–T5：descriptor exact-shape/重复/缺失/副作用前拒绝，生产转换，正常 binder 和跨代，compound planner，真实 carrier 取消/退出，FilePlan IO/DB proof/terminal routes，以及固定 G1/G2 release SHA 下的组合验证。未执行 Windows packaged、GUI 或完整 release-check。
