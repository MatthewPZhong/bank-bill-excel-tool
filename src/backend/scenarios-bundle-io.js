// v2.1.9 N7 (Phase 7 T27)：场景模板按渠道导入/导出 — bundle 序列化 / 解析 / 类型识别
//
// 设计要点（PRD §五 / spec §6）：
// - bundle 文件结构（spec §6.1）：
//     {
//       "scenarioBundleVersion": 1,           // 与网银账单模板 bundle (bundleVersion=4) 互认隔离
//       "exportedAt": "ISO 8601",
//       "appVersion": "2.1.9",
//       "channels": [
//         {
//           "name": "工商",
//           "ownerLocation": "上海",
//           "isBuiltin": 0,                   // 0/1；导入时不直接 trust，由 builtin 渠道名硬匹配
//           "scenarios": [
//             { "category", "name", "sortOrder", "enabled", "configJson" }
//           ]
//         }
//       ]
//     }
// - reader 类型识别（spec §6.2）：
//     含 scenarioBundleVersion → 'scenarios'
//     含 bundleVersion         → 'template'  (现存网银账单模板 bundle)
//     都没 / 都有 / 类型不匹配 → throw（场景管理入口误用网银模板文件必须报错）
// - 版本号校验：
//     scenarioBundleVersion > SUPPORTED → throw（升级应用提示）
//     scenarioBundleVersion < 1         → throw（不合法版本）
//
// 资金红线（spec §10.2）：
// - bundle 类型互认严格 — reader 必须按顶层 key 区分；不依赖文件名或扩展名
// - 误用 bundleVersion=4 文件给场景管理入口必须报错（避免把网银模板配置误当作场景导入）
// - parse 全失败时 throw（不返 partial bundle 让上层误以为 ok）
//
// 不变量：
// - serialize 输出严格 UTF-8 JSON 字符串（caller 决定是否 write 到磁盘）
// - parse 输出 channels 数组保证存在（即使源 channels 缺失也兜底空数组）
// - scenarios.configJson 透传原值（不做 schema 校验；scenario 内部 schema 由各 engine 自校）
//
// v2.1.13 PR#58 review P2-1（🔴 资金/业务红线 — 适用渠道语义）：
//   scenario 新增**可选**字段 `applicableChannelNames`，承载「自带写死场景」(builtin-fixed) 的
//   「适用银行渠道」列表（DB 表 scenario_applicable_channels 的内容）。
//   - 为什么用「名字」而不是 channel_id：channel_id 跨库不稳定（不同机器/库 id 不同），导出端的
//     id 在导入端无意义；渠道在库内由 (name, ownerLocation) **联合唯一**（channels-repository
//     UNIQUE (name, owner_location)），故每个元素是 `{name, ownerLocation}` 对（仅用 name 会在
//     同名不同地区时歧义）。导入端按该对 resolve 成当前库 channel_id。
//   - 仅 builtin-fixed 有关联行 → 才输出该字段；其它场景（无关联行）= 空 → 不输出该字段
//     （保持 bundle 体积 + 向后兼容：旧库/旧 bundle 无此字段时不调 setApplicable，维持「空=适用全部」）。
//   - 仍是 scenarioBundleVersion=1 的**可选向后兼容字段**（旧 bundle 无此字段照常解析；新 bundle
//     被旧应用读到时该字段被忽略），故不 bump SUPPORTED_SCENARIO_BUNDLE_VERSION。

const SUPPORTED_SCENARIO_BUNDLE_VERSION = 1;
const MIN_SCENARIO_BUNDLE_VERSION = 1;

// ----------------------------------------------------------------------------
// serializeScenarioBundle — 写出场景 bundle 字符串
//
// 入参：
//   channels:           Array<{ id, name, ownerLocation, isBuiltin, ... }>  — 来自 channels-repository.listChannels
//   scenariosByChannel: Map<channelId, Array<scenario>> 或 Record<channelId, Array<scenario>>
//                       scenario shape：{ category, name, priority?, sortOrder?, enabled, config / configJson }
//                       本函数对 config / configJson 字段二选一兼容：优先 configJson（数据库原始 JSON 字符串），否则 JSON.stringify(config)
//   appVersion:         string — 当前 app 版本号（写入 bundle.appVersion 做审计标记）
//   channelIdToName:    Map<channelId, {name, ownerLocation}> 或 Record（可选）
//                       v2.1.13 PR#58 P2-1：把场景的 _applicableChannelIds（channel_id 列表）解析成
//                       {name, ownerLocation} 列表写进 bundle。缺省/缺映射 → 不输出 applicableChannelNames。
//
// 出参：JSON 字符串（含尾换行符，便于 cat / git diff 友好）
//
// 不变量：
// - channels 顺序保持入参顺序（caller 决定排序：通用一般在首位，但本函数不强加约束）
// - scenarios 内部按入参顺序 — caller 应在调用前按 (priority desc, id asc) 排好
// - 若 channelId 不在 scenariosByChannel 中 → scenarios 数组为空（合法导出空渠道）
function serializeScenarioBundle(channels, scenariosByChannel, appVersion, channelIdToName) {
  if (!Array.isArray(channels)) {
    throw new Error('serializeScenarioBundle: channels 必须是数组');
  }
  if (!scenariosByChannel || typeof scenariosByChannel !== 'object') {
    throw new Error('serializeScenarioBundle: scenariosByChannel 必须是 Map 或 Object');
  }
  // 兼容 Map 与 Object 两种入参形态
  const lookup = scenariosByChannel instanceof Map
    ? (id) => scenariosByChannel.get(id) || scenariosByChannel.get(String(id)) || []
    : (id) => scenariosByChannel[id] || scenariosByChannel[String(id)] || [];

  // v2.1.13 PR#58 P2-1：channelId → {name, ownerLocation} 解析器（缺省返 null = 不输出适用渠道名）
  const nameLookup = channelIdToName instanceof Map
    ? (id) => channelIdToName.get(id) || channelIdToName.get(Number(id)) || channelIdToName.get(String(id)) || null
    : (channelIdToName && typeof channelIdToName === 'object')
      ? (id) => channelIdToName[id] || channelIdToName[String(id)] || null
      : () => null;

  const payload = {
    scenarioBundleVersion: SUPPORTED_SCENARIO_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: String(appVersion || ''),
    channels: channels.map((ch) => {
      const scenarios = (lookup(ch.id) || []).map((s) => normalizeScenarioForExport(s, nameLookup));
      return {
        name: String(ch.name || ''),
        ownerLocation: String(ch.ownerLocation || ''),
        isBuiltin: ch.isBuiltin ? 1 : 0,
        scenarios
      };
    })
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function normalizeScenarioForExport(scenario, nameLookup) {
  if (!scenario || typeof scenario !== 'object') {
    throw new Error('serializeScenarioBundle: scenario 必须是对象');
  }
  // sortOrder 兼容字段：优先 sortOrder，其次 priority（v2.0 数据库现状字段名为 priority）
  // 不变量：调度顺序由 (priority desc, id asc) 决定 — sortOrder 在 bundle 中仅作展示
  const sortOrder = Number.isInteger(scenario.sortOrder)
    ? scenario.sortOrder
    : Number.isInteger(scenario.priority)
      ? scenario.priority
      : 0;
  // configJson 二选一：configJson 字符串优先（DB 原始）；否则 JSON.stringify(config)
  let configJson;
  if (typeof scenario.configJson === 'string') {
    // 已是 JSON 字符串 → parse 再放，保证 bundle 是结构化 JSON（不嵌入 escaped 字符串）
    try {
      configJson = JSON.parse(scenario.configJson);
    } catch (_e) {
      // 解析失败 → 透传原字符串（兜底但不应发生：DB 写入前都过了 serializeConfig）
      configJson = scenario.configJson;
    }
  } else if (scenario.config !== undefined && scenario.config !== null) {
    configJson = scenario.config;
  } else {
    throw new Error(`serializeScenarioBundle: scenario "${scenario.name || '(unnamed)'}" 缺少 config / configJson`);
  }
  const out = {
    category: String(scenario.category || ''),
    name: String(scenario.name || ''),
    sortOrder,
    enabled: scenario.enabled === true || scenario.enabled === 1 ? 1 : 0,
    configJson
  };
  // v2.1.13 PR#58 P2-1（🔴 资金/业务红线）：把适用渠道 channel_id 列表解析成 {name, ownerLocation} 列表。
  //   - scenario._applicableChannelIds 由 caller（main.js export handler）对 builtin-fixed 附上（其它 null）。
  //   - 仅当解析到 ≥1 个渠道名时才输出 applicableChannelNames（空/缺映射 → 不输出，保持「空=适用全部」+ 向后兼容）。
  if (Array.isArray(scenario._applicableChannelIds) && scenario._applicableChannelIds.length > 0 && typeof nameLookup === 'function') {
    const names = [];
    for (const cid of scenario._applicableChannelIds) {
      const ch = nameLookup(cid);
      if (ch && ch.name) {
        names.push({ name: String(ch.name), ownerLocation: String(ch.ownerLocation || '') });
      }
    }
    if (names.length > 0) out.applicableChannelNames = names;
  }
  return out;
}

// ----------------------------------------------------------------------------
// parseScenarioBundle — 解析 JSON 文本为结构化 bundle
//
// 入参：jsonText (string)
// 出参：{ scenarioBundleVersion, exportedAt, appVersion, channels }
//   channels 必为数组（即使源缺失也返 []）
//
// 抛错场景：
// - JSON 解析失败 → '场景模板文件格式错误...'
// - 顶层不是 object → throw
// - 顶层缺少 scenarioBundleVersion → throw（detectBundleType 上游已分流，但本函数仍兜底）
// - 版本号 > SUPPORTED 或 < 1 → throw
function parseScenarioBundle(jsonText) {
  if (typeof jsonText !== 'string' || !jsonText.trim()) {
    throw new Error('parseScenarioBundle: jsonText 必须是非空字符串');
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`场景模板文件格式错误：${e && e.message ? e.message : '不是合法 JSON'}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('场景模板文件格式错误：根节点必须是对象');
  }
  if (!('scenarioBundleVersion' in parsed)) {
    throw new Error('场景模板文件缺少 scenarioBundleVersion 字段（可能不是场景模板 bundle）');
  }
  const version = Number(parsed.scenarioBundleVersion);
  if (!Number.isFinite(version) || version < MIN_SCENARIO_BUNDLE_VERSION) {
    throw new Error(`场景模板文件版本号非法（scenarioBundleVersion=${parsed.scenarioBundleVersion}），必须是 >= ${MIN_SCENARIO_BUNDLE_VERSION} 的整数`);
  }
  if (version > SUPPORTED_SCENARIO_BUNDLE_VERSION) {
    throw new Error(`场景模板文件版本（${version}）高于当前应用支持的版本（${SUPPORTED_SCENARIO_BUNDLE_VERSION}），请升级应用后再导入`);
  }

  return {
    scenarioBundleVersion: version,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
    channels: Array.isArray(parsed.channels) ? parsed.channels.map(normalizeChannelForImport) : []
  };
}

function normalizeChannelForImport(rawChannel) {
  if (!rawChannel || typeof rawChannel !== 'object') {
    throw new Error('场景模板文件格式错误：channels 元素必须是对象');
  }
  const name = String(rawChannel.name || '').trim();
  const ownerLocation = String(rawChannel.ownerLocation || '').trim();
  if (!name || !ownerLocation) {
    throw new Error(`场景模板文件格式错误：渠道 name / ownerLocation 不能为空（当前 name="${rawChannel.name}", ownerLocation="${rawChannel.ownerLocation}"）`);
  }
  return {
    name,
    ownerLocation,
    isBuiltin: rawChannel.isBuiltin === 1 || rawChannel.isBuiltin === true ? 1 : 0,
    scenarios: Array.isArray(rawChannel.scenarios) ? rawChannel.scenarios.map(normalizeScenarioForImport) : []
  };
}

function normalizeScenarioForImport(rawScenario) {
  if (!rawScenario || typeof rawScenario !== 'object') {
    throw new Error('场景模板文件格式错误：scenarios 元素必须是对象');
  }
  const category = String(rawScenario.category || '').trim();
  const name = String(rawScenario.name || '').trim();
  if (!category || !name) {
    throw new Error(`场景模板文件格式错误：scenario category / name 不能为空（当前 category="${rawScenario.category}", name="${rawScenario.name}"）`);
  }
  return {
    category,
    name,
    sortOrder: Number.isInteger(rawScenario.sortOrder) ? rawScenario.sortOrder : 0,
    enabled: rawScenario.enabled === 1 || rawScenario.enabled === true ? 1 : 0,
    // configJson 透传原值（可能是 object，也可能是 string）— 上层 apply 时再 serialize
    configJson: rawScenario.configJson,
    // v2.1.13 PR#58 P2-1：透传适用渠道名列表（仅 builtin-fixed 有；旧 bundle 无此字段 → undefined）。
    //   归一化成 [{name, ownerLocation}]；上层 apply 按 (name, ownerLocation) resolve 成当前库 channel_id。
    applicableChannelNames: normalizeApplicableChannelNames(rawScenario.applicableChannelNames)
  };
}

// v2.1.13 PR#58 P2-1：归一化 applicableChannelNames（容忍旧/坏数据）
//   - 非数组（含 undefined）→ undefined（bundle 未携带该字段）
//   - 数组 → 过滤出 name 非空的 {name, ownerLocation}；全部元素无效 → 返回 []
//   注意（PR#58 P3-3 修正）：applyScenarioBundleImport 对 undefined 与 [] **一视同仁**
//     （均走 `.length > 0` 判定 → 都不还原适用渠道，保持新建场景默认「无关联=适用全部」）。
//     这是有意为之，非遗漏：① 导出端从不写 [](仅解析到 ≥1 渠道时才输出 applicableChannelNames)；
//     ② DB 模型「空关联=适用全部」无法表达「适用于零渠道」，故 [] 只能按「无限定」处理。
function normalizeApplicableChannelNames(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    out.push({ name, ownerLocation: String(item.ownerLocation || '').trim() });
  }
  return out;
}

// ----------------------------------------------------------------------------
// detectBundleType — 顶层 key 判型
//
// 入参：parsedJson (已经 JSON.parse 后的对象)
// 出参：'scenarios' | 'template'
// 抛错：
// - 入参非 object → throw
// - 两者都没 → throw（未知 bundle 类型）
// - 两者都有 → throw（歧义 — 拒绝处理）
//
// 关键：本函数严格按顶层 key 区分；不依赖文件名/扩展名/MIME
function detectBundleType(parsedJson) {
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    throw new Error('detectBundleType: 入参必须是对象');
  }
  const hasScenarios = 'scenarioBundleVersion' in parsedJson;
  const hasTemplate = 'bundleVersion' in parsedJson;
  if (hasScenarios && hasTemplate) {
    throw new Error('文件类型不匹配：同时含 scenarioBundleVersion 和 bundleVersion 两个字段，无法识别 bundle 类型');
  }
  if (hasScenarios) return 'scenarios';
  if (hasTemplate) return 'template';
  throw new Error('文件类型不匹配：既无 scenarioBundleVersion 也无 bundleVersion 字段，无法识别 bundle 类型');
}

module.exports = {
  SUPPORTED_SCENARIO_BUNDLE_VERSION,
  MIN_SCENARIO_BUNDLE_VERSION,
  serializeScenarioBundle,
  parseScenarioBundle,
  detectBundleType
};
