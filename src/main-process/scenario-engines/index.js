// v2.0.0-beta.3：场景算法引擎统一入口
// 按 category 分发到 c1/c2/c3 对应的 runner

const { runC1Scenario } = require('./c1-extract-recon-id');
const { runC2Scenario } = require('./c2-offset-bill-mark');
const { runC3Scenario } = require('./c3-gateway-recon-join');
const { normalizeCellValue, valuesEqual } = require('./engine-utils');
const { CANONICAL_FUND_TRANSFER_DIRECTIONS } = require('./fund-transfer-engine-policy');

// v3.2.17：自带写死场景「从银行对账单的信息里提取调拨订单对账ID」只处理调拨行：
//   FundType 去空格后恰好等于 FundTransfer-in / FundTransfer-out（区分大小写，与 R5 引擎同口径；
//   InternelFundTransfer-*、FundTransfer-in&FX 等不算）。
//   Channel=DBS 的行不受此限：R3.5 DBS-Charge 资金校验靠本场景给同一调拨的 Charge/outbound 行写上相同对账ID来归组，
//   这些行在 R2 时 FundType 仍是导入值（与 R3.5 渠道门控同口径：trim 后精确等于 'DBS'）。
const BUILTIN_EXTRACT_FUND_TYPES = Object.freeze(new Set(
  CANONICAL_FUND_TRANSFER_DIRECTIONS.map((direction) => direction.bankFundType)
));
const BUILTIN_EXTRACT_EXEMPT_CHANNEL = 'DBS';

function builtinExtractRowGate(row) {
  if (!row) return false;
  if (valuesEqual(row.Channel, BUILTIN_EXTRACT_EXEMPT_CHANNEL)) return true;
  return BUILTIN_EXTRACT_FUND_TYPES.has(normalizeCellValue(row.FundType));
}

// 统一入口：runScenario(scenario, bankRows, gwRows?)
// 返回 { lockedRowIds: Set, modifications: Array, warnings: Array }
function runScenario(scenario, bankRows, gwRows = null) {
  if (!scenario || !scenario.category) {
    throw new Error('runScenario: scenario 无效，缺少 category');
  }
  switch (scenario.category) {
    case 'extract-recon-id':
      return runC1Scenario(scenario, bankRows);
    // v2.1.13 D-5：自带写死场景（builtin-fixed）— 由原 extract-recon-id 提取场景归类而来，
    //   config 形态保持不变（extractByFeature）→ 复用 C1 提取引擎。
    //   v3.2.17：另加 FundType 前置门控（见 builtinExtractRowGate）；用户自建的提取场景不受影响。
    //   未来若 builtin-fixed 容纳其他形态，按 config 字段再分流。
    case 'builtin-fixed':
      if (scenario.config && scenario.config.extractByFeature) {
        return runC1Scenario(scenario, bankRows, { rowGate: builtinExtractRowGate });
      }
      throw new Error(`runScenario: builtin-fixed 场景 "${scenario.name}" 无法识别的 config 形态（缺 extractByFeature）`);
    case 'offset-bill-mark':
      return runC2Scenario(scenario, bankRows);
    case 'gateway-recon-join':
      return runC3Scenario(scenario, bankRows, gwRows);
    default:
      throw new Error(`runScenario: 未知 category "${scenario.category}"`);
  }
}

module.exports = {
  BUILTIN_EXTRACT_FUND_TYPES,
  builtinExtractRowGate,
  runScenario,
  runC1Scenario,
  runC2Scenario,
  runC3Scenario
};
