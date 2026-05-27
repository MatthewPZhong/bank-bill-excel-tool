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
//
// 出参：JSON 字符串（含尾换行符，便于 cat / git diff 友好）
//
// 不变量：
// - channels 顺序保持入参顺序（caller 决定排序：通用一般在首位，但本函数不强加约束）
// - scenarios 内部按入参顺序 — caller 应在调用前按 (priority desc, id asc) 排好
// - 若 channelId 不在 scenariosByChannel 中 → scenarios 数组为空（合法导出空渠道）
function serializeScenarioBundle(channels, scenariosByChannel, appVersion) {
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

  const payload = {
    scenarioBundleVersion: SUPPORTED_SCENARIO_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: String(appVersion || ''),
    channels: channels.map((ch) => {
      const scenarios = (lookup(ch.id) || []).map((s) => normalizeScenarioForExport(s));
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

function normalizeScenarioForExport(scenario) {
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
  return {
    category: String(scenario.category || ''),
    name: String(scenario.name || ''),
    sortOrder,
    enabled: scenario.enabled === true || scenario.enabled === 1 ? 1 : 0,
    configJson
  };
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
    configJson: rawScenario.configJson
  };
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
