// v2.1.9 N7 Phase 7 T30：场景模板 bundle 应用导入（事务包裹 + 缺失渠道创建 + 同名场景跳过）
//
// 提取自 src/main.js（v2.1.9 SR-FIX-1 round 3 / spec §16.3.5）：
//   原本是 main.js 局部函数 applyScenarioBundleImport(bundle, options)，
//   round 3 抽到独立 module 以便 integration test 直接走真实代码路径
//   （round 2 Case F 因函数未 exports 只能手写 sham 模拟 → 漏掉「createScenario 不传 channelId
//   + 后置 UPDATE」与「F1 createScenario 默认 channel_id=1」协同 bug — 同名场景在
//   通用渠道已存在时 INSERT 撞 UNIQUE 抛 friendly error → UPDATE 永远到不了）。
//
// 入参：
//   bundle:                                  parseScenarioBundle 输出
//   options.confirmCreateMissingChannels:    用户已点确认创建缺失渠道（true 才允许 INSERT 渠道）
//   deps:                                    依赖注入（让 main.js 薄壳 wrapper 提供 database facade，
//                                            集成测试自行注入 SQLite + repo helpers）
//     {
//       db,                              // SQLite DatabaseSync 实例（事务控制）
//       listChannels,                    // () => Channel[]，等价 database.listChannels()
//       getBuiltinGeneralChannel,        // () => Channel，等价 database.getBuiltinGeneralChannel()
//       createChannel,                   // (payload) => Channel，等价 database.createChannel(payload)
//       findScenarioByChannelAndName,    // (channelId, name) => ScenarioDetail|null
//       createScenario                   // (payload) => { id }，必须支持 payload.channelId 入参
//     }
//
// 行为：
//   1. 事务包裹（BEGIN ... COMMIT / ROLLBACK）
//   2. 对每个 bundle.channels 元素：
//      - 查 channel by (name, ownerLocation)
//      - 不存在且非 builtin：
//          confirmCreateMissingChannels=true → createChannel
//          confirmCreateMissingChannels=false → 跳过该渠道下所有 scenarios（收集到 conflicts）
//      - 不存在且 builtin：理论不可能（builtin 仅「通用」且 ensureChannelsTable 启动期建出）
//        → fallback 到通用 id=1
//   3. 对每个 channel 下的 scenarios：
//      - 按 (channel_id, name) 查 channel 内是否已存在
//      - 已存在 → 跳过 + 收集到 conflicts: [{channel, scenario, reason: 'name-duplicate'}]
//      - 不存在 → createScenario({ ..., channelId: targetChannel.id }) 一步落库
//        （v2.1.9 SR-FIX-1 round 3 F2-cont / spec §16.3.5：F1 已让 createScenario 支持 channelId 入参，
//         直接传入；原 round 2 「createScenario + UPDATE channel_id」两步走方案 round 3 删除，
//         否则通用渠道有同名场景时会撞 UNIQUE 抛 friendly error → UPDATE 永远到不了）
//   4. 出错 → ROLLBACK 整批
//
// 返回：{ importedCount, conflicts: [{channel, scenario, reason}], createdChannels: [{name, ownerLocation, id}] }
//
// 资金红线（spec §10.2）：
//   - 事务包裹保证导入失败不留半状态
//   - 同名场景跳过 + 报告（不静默覆盖）
//   - confirmCreateMissingChannels=false 时跳过缺失渠道的所有 scenarios（不创建渠道）
function applyScenarioBundleImport(bundle, options, deps) {
  const opts = options || {};
  const confirmCreateMissingChannels = opts.confirmCreateMissingChannels === true;
  if (!deps || !deps.db) {
    throw new Error('applyScenarioBundleImport: deps.db 未提供');
  }
  const {
    db,
    listChannels,
    getBuiltinGeneralChannel,
    createChannel,
    findScenarioByChannelAndName,
    createScenario
  } = deps;
  if (typeof listChannels !== 'function'
    || typeof getBuiltinGeneralChannel !== 'function'
    || typeof createChannel !== 'function'
    || typeof findScenarioByChannelAndName !== 'function'
    || typeof createScenario !== 'function') {
    throw new Error('applyScenarioBundleImport: deps 必须含 listChannels / getBuiltinGeneralChannel / createChannel / findScenarioByChannelAndName / createScenario 函数');
  }

  const conflicts = [];
  const createdChannels = [];
  let importedCount = 0;

  db.exec('BEGIN');
  try {
    // 缓存 channel 名→记录映射，避免每个 scenario 都查 DB
    const allChannels = listChannels();
    const channelKeyToRecord = new Map(allChannels.map((c) => [`${c.name} ${c.ownerLocation}`, c]));

    for (const bundleChannel of bundle.channels) {
      const channelKey = `${bundleChannel.name} ${bundleChannel.ownerLocation}`;
      const channelLabel = `${bundleChannel.name}-${bundleChannel.ownerLocation}`;
      let targetChannel = channelKeyToRecord.get(channelKey);

      if (!targetChannel) {
        if (bundleChannel.isBuiltin) {
          // builtin 渠道理论应当已存在（「通用」固定 id=1）；fallback 到通用
          targetChannel = getBuiltinGeneralChannel();
          channelKeyToRecord.set(channelKey, targetChannel);
        } else if (confirmCreateMissingChannels) {
          const newChannel = createChannel({
            name: bundleChannel.name,
            ownerLocation: bundleChannel.ownerLocation
          });
          channelKeyToRecord.set(channelKey, newChannel);
          targetChannel = newChannel;
          createdChannels.push({
            id: newChannel.id,
            name: newChannel.name,
            ownerLocation: newChannel.ownerLocation
          });
        } else {
          // 未确认创建 → 跳过该渠道所有 scenarios
          for (const s of bundleChannel.scenarios) {
            conflicts.push({ channel: channelLabel, scenario: s.name, reason: 'channel-missing' });
          }
          continue;
        }
      }

      // v2.1.9 SR-FIX-1 round 2 F2（spec §16.3.3）：channel 内查重（findByChannelAndName）
      //   → 跨渠道同名场景可正常导入（原全表查重会让跨 channel 同名也匹配 → 错误跳过）
      for (const bundleScenario of bundleChannel.scenarios) {
        const existingInChannel = findScenarioByChannelAndName(
          targetChannel.id,
          bundleScenario.name
        );
        if (existingInChannel) {
          conflicts.push({
            channel: channelLabel,
            scenario: bundleScenario.name,
            reason: 'name-duplicate'
          });
          continue;
        }
        // 解析 configJson（已在 parseScenarioBundle 透传；apply 时再 serialize 到 DB）
        let configValue = bundleScenario.configJson;
        if (typeof configValue === 'string') {
          try { configValue = JSON.parse(configValue); } catch (_e) { /* 透传原值 */ }
        }
        // v2.1.9 SR-FIX-1 round 3 F2-cont（spec §16.3.5）：
        //   createScenario 直接传 channelId（F1 已支持），不再 INSERT 后 UPDATE channel_id
        //   原 round 2 方案 「INSERT 不传 channelId（默认落通用 id=1） + UPDATE channel_id」
        //   会让通用渠道已有同名场景时 INSERT 撞 UNIQUE → 抛 friendly error → UPDATE 不到
        createScenario({
          category: bundleScenario.category,
          name: bundleScenario.name,
          priority: Number.isInteger(bundleScenario.sortOrder) ? bundleScenario.sortOrder : 0,
          enabled: bundleScenario.enabled === 1,
          config: configValue,
          channelId: targetChannel.id
        });
        importedCount += 1;
      }
    }

    db.exec('COMMIT');
    return { importedCount, conflicts, createdChannels };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { applyScenarioBundleImport };
