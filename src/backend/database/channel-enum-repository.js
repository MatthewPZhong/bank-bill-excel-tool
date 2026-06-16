// v2.1.16-beta.3 ①：Channel 枚举字典仓储层（纯函数 (db, ...) 风格，仿 linked-table-repository.js）
//
// 🔴 性质说明：纯沉淀（仅 INSERT/UPDATE 枚举字典），不删除、不改写任何对账数据；
//    非资金红线、属审计辅助。供后续 ③ 中台退款回填引擎读库 + 业务审计值字典。
//
// 去重 + 累积语义（UNIQUE(value_type, enum_value)）：
//   - 新值 → INSERT，first_seen_at = last_seen_at = now，seen_count = delta。
//   - 已存在值 → UPDATE，last_seen_at = now，seen_count = seen_count + delta，first_seen_at 不变。
// seen_count 口径（TECH §3.4 默认）：累加「该批去重前出现的行数」（同批 3 行同值 → +3）。
//   边界：地区空只落 channel（不拼 'JPM-' 脏值）；Channel 空跳过整行。

const VALUE_TYPE_CHANNEL = 'channel';
const VALUE_TYPE_CHANNEL_REGION = 'channel-region';

const UPSERT_SQL = `
  INSERT INTO channel_enum_values (value_type, enum_value, first_seen_at, last_seen_at, seen_count)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(value_type, enum_value) DO UPDATE SET
    last_seen_at = excluded.last_seen_at,
    seen_count   = seen_count + excluded.seen_count
`;

/**
 * upsert 单个枚举值。空值（trim 后为空）直接跳过、返回 false。
 * 新值 INSERT(first=last=now, count=delta)；已存在 UPDATE(last=now, count+=delta, first 不变)。
 * @param {*} db
 * @param {'channel'|'channel-region'} valueType
 * @param {string} enumValue
 * @param {string} now ISO 时间戳
 * @param {number} delta seen_count 增量（默认 1）
 * @returns {boolean} 是否实际写入
 */
function recordValue(db, valueType, enumValue, now, delta = 1) {
  const value = enumValue === null || enumValue === undefined ? '' : String(enumValue).trim();
  if (value === '') return false;
  if (valueType !== VALUE_TYPE_CHANNEL && valueType !== VALUE_TYPE_CHANNEL_REGION) {
    // CHECK 约束会拒绝；这里提前守护，避免无意义 SQL 错误（属编程错误，抛出由上层 try-catch 吞）
    throw new Error(`[channel-enum-repository] 非法 value_type：${valueType}`);
  }
  const safeDelta = Number.isFinite(delta) && delta > 0 ? Math.floor(delta) : 1;
  db.prepare(UPSERT_SQL).run(valueType, value, now, now, safeDelta);
  return true;
}

/**
 * 从一批银行对账单行抽取并沉淀 Channel / Channel-地区 枚举值。
 *   - rows：对象数组，每行 row['Channel'] / row['地区'] 可取值（readBankStatement 产物）。
 *   - 进程内先 dedupe（Map）累计出现行数，再单事务批量 upsert（减少 upsert 次数）。
 *   - 🔴 地区空只落 channel：Channel 非空且 地区 非空 → 记 channel + channel-region；
 *     Channel 非空但 地区 空（含纯空格 / null）→ 只记 channel；Channel 空 → 跳过整行。
 *   - seen_count 累加「该批去重前出现的行数」。
 * @returns {{channelCount:number, channelRegionCount:number}} 本批去重后不同值数量（供日志）
 */
function recordFromBankStatementRows(db, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  // key = `${valueType}\u0000${value}`（用 NUL 分隔，避免 value 含 '-' 与 type 边界歧义）
  const counts = new Map();
  const SEP = '\u0000';

  for (const row of safeRows) {
    const obj = row && typeof row === 'object' ? row : {};
    const ch = obj.Channel === null || obj.Channel === undefined ? '' : String(obj.Channel).trim();
    if (ch === '') continue; // Channel 空 → 跳过整行

    const chKey = `${VALUE_TYPE_CHANNEL}${SEP}${ch}`;
    counts.set(chKey, (counts.get(chKey) || 0) + 1);

    const region = obj['地区'] === null || obj['地区'] === undefined ? '' : String(obj['地区']).trim();
    if (region !== '') {
      // 🔴 地区非空才拼接 channel-region；地区空跳过（不生成 'JPM-' 脏值）
      const crKey = `${VALUE_TYPE_CHANNEL_REGION}${SEP}${ch}-${region}`;
      counts.set(crKey, (counts.get(crKey) || 0) + 1);
    }
  }

  let channelCount = 0;
  let channelRegionCount = 0;
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    for (const [key, cnt] of counts) {
      const sepIdx = key.indexOf(SEP);
      const valueType = key.slice(0, sepIdx);
      const value = key.slice(sepIdx + 1);
      const written = recordValue(db, valueType, value, now, cnt);
      if (written) {
        if (valueType === VALUE_TYPE_CHANNEL) channelCount += 1;
        else channelRegionCount += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    // 🔴 上抛给 handler，由 handler try-catch 吞掉（不阻断导入）
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }

  return { channelCount, channelRegionCount };
}

/**
 * v3.0.0 需求1：从一批银行对账单行抽取唯一「渠道-地区」组合（供状态框前缀展示）。
 *   纯函数（不依赖 db），复用 recordFromBankStatementRows 的拼接口径，保证与枚举沉淀同口径：
 *     - Channel（trim 后）为空 → 跳过整行（不产出任何组合）。
 *     - 地区（trim 后）为空 → 只产出 `Channel`（不生成 'JPM-' 这种带短横的脏值）。
 *     - 地区非空 → 产出 `Channel-地区`。
 *   结果去重（Set）+ `sort()` 稳定排序（默认字典序），便于前端拼前缀与单测断言。
 * @param {Array<{Channel?:*, 地区?:*}>} rows readBankStatement 产物（对象数组）
 * @returns {string[]} 去重 + 排序后的「渠道」/「渠道-地区」组合
 */
function extractChannelRegionCombos(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const set = new Set();
  for (const row of safeRows) {
    const obj = row && typeof row === 'object' ? row : {};
    const ch = obj.Channel === null || obj.Channel === undefined ? '' : String(obj.Channel).trim();
    if (ch === '') continue; // Channel 空 → 跳过整行
    const region = obj['地区'] === null || obj['地区'] === undefined ? '' : String(obj['地区']).trim();
    // 🔴 地区非空才拼接 channel-region；地区空只产出 channel（不生成 'JPM-' 脏值）
    set.add(region !== '' ? `${ch}-${region}` : ch);
  }
  return Array.from(set).sort();
}

/**
 * v3.0.7 需求2d（🔴🔴 资金红线·契约 C5）：单行「是否银行对账单入金行」谓词。
 *   逐行取 Channel / 地区（与 extractChannelRegionCombos 同 trim 归一口径），命中以下任一即入金行：
 *     - Channel === 'ADM'（按裸 Channel 列值，🔴 忽略地区——ADM 行地区可空可有值，统一判入金）。
 *     - Channel === 'BOC'（同上，按裸 Channel 列值，🔴 忽略地区——真实 BOC 入金行 地区='CN'，
 *       见 boc-fx-link-fields.js BOC_BANK_FILTER.地区='CN'；绝不能拼成 'BOC-CN' 组合去比白名单）。
 *     - Channel === 'JPM' ∧ 地区 === 'US'（仅 JPM-US；JPM-HK 排除走 R1-R5 预处理，与退款回填 JPM-HK
 *       另有二跳口径一致）。
 *   🔴 大小写敏感、精确等于（与 BOC_CHANNEL_VALUE 等常量一致）。Channel 空（trim 后空）不在此判定，
 *      由上层 isBankDepositChannelFile 跳过。
 * @param {string} ch 已 trim 的 Channel 列值
 * @param {string} region 已 trim 的 地区 列值
 * @returns {boolean}
 */
function isBankDepositRow(ch, region) {
  if (ch === 'ADM' || ch === 'BOC') return true; // ADM/BOC 按裸 Channel，忽略地区
  if (ch === 'JPM' && region === 'US') return true; // 仅 JPM-US（JPM-HK 排除）
  return false;
}

/**
 * v3.0.7 需求2d（🔴🔴 资金红线·契约 C5）：判定一份 44 列银行对账单文件是否为「银行对账单入金表」
 *   （命中 → 落 bank-deposit 链接表；否则 → 走 R1-R5 预处理）。「导入文件」按钮 Channel 二次路由的唯一真相。
 *
 *   口径（逐行 Channel+地区 判定，🔴 绝不用 'Channel-地区' 组合字符串比白名单——
 *     ADM/BOC 真实数据会带地区，组合化会把 'BOC-CN' 判成非白名单致误路由，见本批次修复背景）：
 *     - Channel（trim 后）为空 → 跳过该行（不参与判定，与 extractChannelRegionCombos 一致）。
 *     - 非空 Channel 行经 isBankDepositRow 判定。
 *   文件判为 bank-deposit ⟺ 至少有一行非空 Channel 且**所有**非空 Channel 行都 isBankDepositRow。
 *   🔴 空文件 / 全空 Channel（无任何非空 Channel 行）→ false（保守，绝不吞为链接表；
 *      用 sawChannel 标记守卫，避免 every-on-empty 的 vacuously-true 误判）。
 * @param {Array<{Channel?:*, 地区?:*}>} rows readBankStatement 产物（对象数组）
 * @returns {boolean} true=入金表（路由 bank-deposit）；false=走 R1-R5 预处理
 */
function isBankDepositChannelFile(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  let sawChannel = false; // 是否见过至少一行非空 Channel（守卫空文件 / 全空 Channel → false）
  for (const row of safeRows) {
    const obj = row && typeof row === 'object' ? row : {};
    const ch = obj.Channel === null || obj.Channel === undefined ? '' : String(obj.Channel).trim();
    if (ch === '') continue; // Channel 空 → 跳过该行（不参与判定）
    sawChannel = true;
    const region = obj['地区'] === null || obj['地区'] === undefined ? '' : String(obj['地区']).trim();
    if (!isBankDepositRow(ch, region)) return false; // 有一行非入金行 → 整份走预处理
  }
  return sawChannel; // 全部非空 Channel 行都是入金行（且至少有一行）
}

/**
 * 按 value_type 过滤列出枚举值（供后续引擎读库 + 审计）。
 * @param {*} db
 * @param {'channel'|'channel-region'} valueType
 * @returns {Array<{enumValue, firstSeenAt, lastSeenAt, seenCount}>} ORDER BY enum_value ASC
 */
function listChannelEnumValues(db, valueType) {
  const rows = db
    .prepare(
      `SELECT enum_value, first_seen_at, last_seen_at, seen_count
       FROM channel_enum_values
       WHERE value_type = ?
       ORDER BY enum_value ASC`
    )
    .all(valueType);
  return rows.map((r) => ({
    enumValue: r.enum_value,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    seenCount: Number(r.seen_count) || 0
  }));
}

module.exports = {
  VALUE_TYPE_CHANNEL,
  VALUE_TYPE_CHANNEL_REGION,
  recordValue,
  recordFromBankStatementRows,
  // v3.0.0 需求1：状态框渠道-地区前缀（纯函数，与枚举沉淀同拼接口径）
  extractChannelRegionCombos,
  // v3.0.7 需求2d：「导入文件」Channel 二次路由谓词（纯函数，bank-deposit 文件判定单一真相）
  isBankDepositRow,
  isBankDepositChannelFile,
  listChannelEnumValues
};
