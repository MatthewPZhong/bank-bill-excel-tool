// v1.5.3 R1 (T1.2)：月度余额账单导出装配模块（资金红线集中点）
//
// 职责：
//   - assembleMonthlyBalance：按 templateScope × {year, month} 从 balance-seeds 装配 records
//   - toBalanceRows：把装配出的 records 对齐到 balanceTemplateFields 的列顺序（供 writeBalanceWorkbook 消费）
//
// 资金字段（endBalance / merchantId）的读取规则（PRD §5.1.3 + 决策 Q2 / Q6）：
//   - Q2：每个 (merchantId, currency) 的"最新余额"取 billDate ≤ 月末最后一日里 billDate 最大的一条；
//          - 若存在 billDate === 月末最后一日 → 优先用该日
//          - 若全部 seeds 的 billDate > 月末 → 跳过该大账号（"未来余额排除"）
//          - 无任何 seeds → 跳过该大账号
//   - Q6：R1 是全流程里唯一放行 account_nature='own' 的场景，所以必须显式传 { includeOwn: true }
//   - Q4：所有模板 / 大账号 / 币种的余额条目合并到单个 sheet
//
// 数据流：
//   Main → assembleMonthlyBalance({ templateScope, year, month, db, storageRoot })
//     → { records, stats } → 调用方 (main.js) → toBalanceRows(records, balanceTemplateFields)
//     → writeBalanceWorkbook(records, balanceTemplateFields, outputFilePath)

const { readBalanceSeedRecords, splitTemplateName } = require('../backend/balance-seed-store');

const ALL_BANKS_TEMPLATE_SCOPE = '__ALL_BANKS__';

function pad2(value) {
  const n = Number(value);
  return n < 10 ? `0${n}` : String(n);
}

// 计算目标年月的月末最后一日（自然日），自动处理闰年（2 月可能是 28 或 29）
function lastDayOfMonth(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    return null;
  }
  // Date(y, m, 0) 返回 y 年 m 月的最后一天（月份本身是 1-based，第 0 天回退到上月末）
  return new Date(y, m, 0).getDate();
}

function buildTargetLastDay(year, month) {
  const day = lastDayOfMonth(year, month);
  if (day === null) return '';
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// PRD §四 术语 / §5.1.3：普通模板 = 不是主模板 && 不是子模板 && 不是虚拟 ID（__FILENAME_MAPPING__ 不会进 listTemplates，无需额外过滤）
function isRegularTemplate(template) {
  if (!template) return false;
  if (template.isParent) return false;
  if (template.parentTemplateId) return false;
  return true;
}

// 从 balance-seeds/{bankName}.json 里挑选目标月末最后一日或更早的最新一条
// 返回 { chosen, reason }：
//   chosen 为 null 时 reason 是 'no-candidates'（全部 billDate > 月末 或 完全无记录）
//   chosen 非 null 时 reason 为 'exact'（精确匹配月末当日）或 'fallback'（兜底最新）
function pickLatestSeedForAccount(seeds, merchantId, currency, targetLastDay) {
  const mid = String(merchantId || '').trim();
  const cur = String(currency || '').trim();
  if (!mid) {
    return { chosen: null, reason: 'invalid-merchant-id' };
  }

  const candidates = seeds.filter((record) => {
    return (
      String(record.merchantId || '').trim() === mid &&
      String(record.currency || '').trim() === cur &&
      String(record.billDate || '') !== '' &&
      String(record.billDate) <= String(targetLastDay)
    );
  });

  if (!candidates.length) {
    return { chosen: null, reason: 'no-candidates' };
  }

  // 先找精确月末匹配
  const exact = candidates.find((record) => String(record.billDate) === String(targetLastDay));
  if (exact) {
    return { chosen: exact, reason: 'exact' };
  }

  // 兜底：billDate ≤ 月末最后一日 里 billDate 最大的一条
  const sorted = candidates.slice().sort((a, b) => String(b.billDate).localeCompare(String(a.billDate)));
  return { chosen: sorted[0], reason: 'fallback' };
}

// 核心装配函数
// 入参：
//   - db：AppDatabase 实例（需含 listTemplates / getTemplateBigAccounts）
//   - storageRoot：balance-seeds 所在根目录
//   - templateScope：'__ALL_BANKS__' | 模板名字符串
//   - year / month：目标年月（例：2026 / 3）
//
// 返回：
//   {
//     targetLastDay: 'YYYY-MM-DD',
//     templates: 被扫描的模板数组,
//     records: [{ bankName, location, merchantId, currency, billDate, endBalance, templateName }],
//     stats: {
//       templateCount, accountsScanned, accountsIncluded,
//       missingAccounts: [{ templateName, merchantId, currency, reason }],
//       skippedTemplates: [{ templateName, reason }]
//     }
//   }
function assembleMonthlyBalance({ templateScope, year, month, db, storageRoot }) {
  const targetLastDay = buildTargetLastDay(year, month);
  if (!targetLastDay) {
    throw new Error('月度余额装配失败：year / month 不合法');
  }
  if (!db || typeof db.listTemplates !== 'function' || typeof db.getTemplateBigAccounts !== 'function') {
    throw new Error('月度余额装配失败：db 缺失 listTemplates / getTemplateBigAccounts');
  }
  if (!storageRoot) {
    throw new Error('月度余额装配失败：storageRoot 不能为空');
  }

  // 1. 确定要处理的模板范围
  const allTemplates = db.listTemplates().filter(isRegularTemplate);
  const targetTemplates = templateScope === ALL_BANKS_TEMPLATE_SCOPE
    ? allTemplates
    : allTemplates.filter((template) => String(template.name) === String(templateScope));

  const stats = {
    templateCount: targetTemplates.length,
    accountsScanned: 0,
    accountsIncluded: 0,
    missingAccounts: [],
    skippedTemplates: []
  };

  const records = [];

  for (const template of targetTemplates) {
    const templateName = String(template.name || '');
    const { bankName, location } = splitTemplateName(templateName);

    if (!bankName) {
      stats.skippedTemplates.push({ templateName, reason: 'bankName-missing' });
      continue;
    }

    // 2. 该模板的全部大账号（Q6：R1 唯一放行 includeOwn=true）
    const bigAccounts = db.getTemplateBigAccounts(template.id, { includeOwn: true }) || [];
    if (!bigAccounts.length) {
      stats.skippedTemplates.push({ templateName, reason: 'no-big-accounts' });
      continue;
    }

    // 3. 该 bankName 下的全部 seeds
    let seeds = [];
    try {
      seeds = readBalanceSeedRecords(storageRoot, bankName) || [];
    } catch (error) {
      // 损坏 json 跳过该模板，记入 skippedTemplates，不中断整体装配
      stats.skippedTemplates.push({
        templateName,
        reason: `read-seeds-failed: ${error.message || error.code || String(error)}`
      });
      continue;
    }

    // 4. 逐大账号按规则挑选
    for (const bigAccount of bigAccounts) {
      stats.accountsScanned += 1;
      const merchantId = String(bigAccount.merchantId || '').trim();
      const currency = String(bigAccount.currency || '').trim();

      if (!merchantId) {
        stats.missingAccounts.push({
          templateName,
          merchantId,
          currency,
          reason: 'invalid-merchant-id'
        });
        continue;
      }

      const { chosen, reason } = pickLatestSeedForAccount(seeds, merchantId, currency, targetLastDay);
      if (!chosen) {
        stats.missingAccounts.push({
          templateName,
          merchantId,
          currency,
          reason // 'no-candidates' → 全部 > 月末 或 完全无记录（PRD Q2 规则）
        });
        continue;
      }

      // Q2 资金红线：billDate 用 seed 实际记录的那一天（可能是 2026-02-28），不是月末
      records.push({
        bankName,
        location,
        merchantId,
        currency,
        billDate: chosen.billDate,
        endBalance: chosen.endBalance,
        templateName,
        pickReason: reason
      });
      stats.accountsIncluded += 1;
    }
  }

  return {
    targetLastDay,
    templateScope,
    templates: targetTemplates.map((t) => ({ id: t.id, name: t.name })),
    records,
    stats
  };
}

// 把 records 按 balanceTemplateFields 的列顺序打平为二维数组（供 writeBalanceWorkbook 消费）
// PRD §3.4 / §5.1.3：字段名以 assets/余额账单模版.xlsx 的 extractHeaders 为准
//   - 识别到的字段：银行名称 / 所在地 / 银行账号 / 币种 / 账单日期 / 期末余额
//   - 其它字段（期初余额 / 期初可用余额 / 期末可用余额 / 扩展字段 等）缺省为空字符串
function toBalanceRows(records, balanceTemplateFields) {
  const fields = Array.isArray(balanceTemplateFields) ? balanceTemplateFields : [];

  return records.map((record) => {
    const fieldToValue = new Map();
    fieldToValue.set('银行名称', record.bankName || '');
    fieldToValue.set('所在地', record.location || '');
    fieldToValue.set('银行账号', record.merchantId || '');
    fieldToValue.set('币种', record.currency || '');
    fieldToValue.set('账单日期', record.billDate || '');
    fieldToValue.set('期末余额', record.endBalance !== null && record.endBalance !== undefined ? record.endBalance : '');

    return fields.map((fieldName) => {
      const key = String(fieldName || '').trim();
      if (!key) return '';
      return fieldToValue.has(key) ? fieldToValue.get(key) : '';
    });
  });
}

module.exports = {
  ALL_BANKS_TEMPLATE_SCOPE,
  assembleMonthlyBalance,
  buildTargetLastDay,
  isRegularTemplate,
  lastDayOfMonth,
  pad2,
  pickLatestSeedForAccount,
  toBalanceRows
};
