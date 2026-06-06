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
//       createScenario,                  // (payload) => { id }，必须支持 payload.channelId 入参
//       // v2.1.13 PR#58 P2-1（可选）— builtin-fixed 适用渠道还原：
//       findChannelByNameAndLocation,    // (name, ownerLocation) => Channel|null，等价 database.findChannelByNameAndLocation
//       setScenarioApplicableChannels,   // (scenarioId, channelIds) => ...，等价 database.setScenarioApplicableChannels
//       // v2.1.13 PR#58 P3-2（可选）— 限定渠道全 resolve 失败时禁用场景：
//       setScenarioEnabled               // (scenarioId, enabled) => ...，等价 database.toggleScenarioEnabled
//     }
//     说明：findChannelByNameAndLocation / setScenarioApplicableChannels / setScenarioEnabled 仅在 bundle 的某
//     scenario 携带 applicableChannelNames 时才被调用；缺省时该场景仅记 warning 不阻断（向后兼容旧 caller / 旧 bundle）。
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
// 返回：{ importedCount, conflicts: [{channel, scenario, reason}], createdChannels: [{name, ownerLocation, id}], warnings: string[] }
//
// 资金红线（spec §10.2 + v2.1.13 PR#58 P2-1 适用渠道语义）：
//   - 事务包裹保证导入失败不留半状态
//   - 同名场景跳过 + 报告（不静默覆盖）
//   - confirmCreateMissingChannels=false 时跳过缺失渠道的所有 scenarios（不创建渠道）
//   - 🔴 适用渠道还原（builtin-fixed）：bundle 携带 applicableChannelNames 时，按 (name, ownerLocation)
//     resolve 成当前库 channel_id 后调 setScenarioApplicableChannels。逐名 resolve，匹配不到记 warning。
//     · applicableChannelNames 缺省（旧 bundle 无字段）→ 不调 set（保留新建场景默认「无关联=适用全部」，向后兼容）。
//     · applicableChannelNames 非空但**一个都 resolve 不到** → 不调 set([])（[] 会变成「适用全部」=反向 bug）；
//       P3-2 起进一步**禁用该场景**（setScenarioEnabled false）+ 强 warning，避免限定场景误对所有渠道生效；
//       caller 未提供 setScenarioEnabled 时退回「仅 warning」（向后兼容）。
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
    createScenario,
    // v2.1.13 PR#58 P2-1（可选）
    findChannelByNameAndLocation,
    setScenarioApplicableChannels,
    // v2.1.13 PR#58 P3-2（可选）：限定渠道全 resolve 失败时禁用场景（避免退化为「适用全部」）
    setScenarioEnabled
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
  const warnings = [];
  // v2.1.13 PR#58 P2-1：适用渠道还原延后到「所有渠道创建完成」后做（否则写死场景的适用渠道
  //   若是后续 bundle.channels 才创建的渠道，循环内 resolve 会查不到 → 误判不存在）。
  const pendingApplicable = []; // { scenarioId, scenarioName, refs: [{name, ownerLocation}] }
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
        const created = createScenario({
          category: bundleScenario.category,
          name: bundleScenario.name,
          priority: Number.isInteger(bundleScenario.sortOrder) ? bundleScenario.sortOrder : 0,
          enabled: bundleScenario.enabled === 1,
          config: configValue,
          channelId: targetChannel.id
        });
        importedCount += 1;

        // v2.1.13 PR#58 P2-1：收集适用渠道还原任务（延后到循环外、所有渠道建好后统一 resolve）。
        //   applicableChannelNames 为 undefined（旧 bundle 无字段）→ 不收集（保持「无关联=适用全部」向后兼容）。
        if (Array.isArray(bundleScenario.applicableChannelNames)
          && bundleScenario.applicableChannelNames.length > 0
          && created && created.id != null) {
          pendingApplicable.push({
            scenarioId: created.id,
            scenarioName: bundleScenario.name,
            refs: bundleScenario.applicableChannelNames
          });
        }
      }
    }

    // v2.1.13 PR#58 P2-1（🔴 资金/业务红线）：第二趟还原 builtin-fixed 适用渠道（此时所有渠道已建好）。
    //   按 (name, ownerLocation) resolve 成当前库 channel_id；逐名匹配不到记 warning。
    //   仅当 resolve 到 ≥1 个渠道才写；全不命中时不写 [](避免空=适用全部的反向 bug)，仅 warning。
    if (pendingApplicable.length > 0) {
      if (typeof findChannelByNameAndLocation !== 'function' || typeof setScenarioApplicableChannels !== 'function') {
        for (const job of pendingApplicable) {
          warnings.push(`场景「${job.scenarioName}」携带适用银行渠道但当前导入未提供渠道解析能力，已跳过适用渠道还原`);
        }
      } else {
        for (const job of pendingApplicable) {
          const resolvedIds = [];
          for (const ref of job.refs) {
            const ch = findChannelByNameAndLocation(ref.name, ref.ownerLocation || '');
            if (ch && ch.id != null) {
              resolvedIds.push(Number(ch.id));
            } else {
              const label = ref.ownerLocation ? `${ref.name}-${ref.ownerLocation}` : ref.name;
              warnings.push(`场景「${job.scenarioName}」适用银行渠道「${label}」在当前库不存在，已跳过该渠道`);
            }
          }
          if (resolvedIds.length > 0) {
            setScenarioApplicableChannels(job.scenarioId, resolvedIds);
          } else if (typeof setScenarioEnabled === 'function') {
            // v2.1.13 PR#58 P3-2（🔴 资金/业务红线）：限定渠道一个都 resolve 不到时，不写 [](空=适用全部反向 bug)，
            //   且**禁用该场景** — builtin-fixed 限定场景在目标库无任何可绑定渠道时若保持 enabled，会对所有渠道生效，
            //   等于把「限定」误放大成「全适用」。禁用 + warning 是安全降级：用户手动绑定渠道后再启用。
            setScenarioEnabled(job.scenarioId, false);
            warnings.push(`场景「${job.scenarioName}」所有适用银行渠道均无法匹配，已禁用该场景（避免误对所有渠道生效）；请手动绑定渠道后重新启用`);
          } else {
            // 兜底：caller 未提供禁用能力时退回 warning（保持向后兼容）
            warnings.push(`场景「${job.scenarioName}」所有适用银行渠道均无法匹配，未设置适用渠道（该场景将对所有渠道生效，请手动核对）`);
          }
        }
      }
    }

    db.exec('COMMIT');
    return { importedCount, conflicts, createdChannels, warnings };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { applyScenarioBundleImport };
