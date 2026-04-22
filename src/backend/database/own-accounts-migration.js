// v1.5.3 R2：一次性迁移 Documents/网银账单生成小助手/own-accounts/*.json → template_big_accounts
// - 幂等：完成后写 app_settings.own_accounts_migration_v1_5_3_done = '1'，下次启动 short-circuit
// - 冲突：同 (template_id, merchant_id, currency) 已存在 → 保留已有，写 [CONFLICT] 日志
// - orphan bankName（D16）：json 对应 bankName 在数据库找不到模板 → 跳过整份 + 写 [WARN] 日志，不算迁移失败
// - 失败（D15）：外层 try/catch，异常不抛出，返回 status='failed'；调用方根据返回值决定是否显示状态栏告警

const fs = require('node:fs');
const path = require('node:path');
const settingsRepository = require('./settings-repository');
const templateRepository = require('./template-repository');

const MIGRATION_FLAG_KEY = 'own_accounts_migration_v1_5_3_done';
const MIGRATION_LOG_FILENAME = 'own-accounts-migration-v1.5.3.log';

function getMigrationLogPath(storageRoot) {
  return path.join(storageRoot, MIGRATION_LOG_FILENAME);
}

function appendMigrationLog(storageRoot, line) {
  try {
    const logPath = getMigrationLogPath(storageRoot);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const iso = new Date().toISOString();
    fs.appendFileSync(logPath, `[${iso}] ${line}\n`, 'utf8');
  } catch (_error) {
    // 日志写入失败不影响迁移流程
  }
}

function getOwnAccountsDir(storageRoot) {
  return path.join(storageRoot, 'own-accounts');
}

// 主入口：runOwnAccountsMigration(storageRoot, db, { appendActivityLogEntry })
// 返回 { status: 'done' | 'already-done' | 'failed', stats }
function runOwnAccountsMigration(storageRoot, db, { appendActivityLogEntry } = {}) {
  const stats = {
    scannedJsonFiles: 0,
    totalAccountsInJson: 0,
    insertedRows: 0,
    conflicts: 0,
    orphans: 0,
    orphanAccounts: 0
  };

  try {
    // 幂等检查
    const existingFlag = settingsRepository.getSetting(db, MIGRATION_FLAG_KEY);
    if (existingFlag === '1' || existingFlag === 'true') {
      return { status: 'already-done', stats };
    }

    const ownAccountsDir = getOwnAccountsDir(storageRoot);
    if (!fs.existsSync(ownAccountsDir)) {
      // 没目录也标记完成，避免每次启动都重跑空流程
      settingsRepository.setSetting(db, MIGRATION_FLAG_KEY, '1');
      appendMigrationLog(storageRoot, `[INFO] no own-accounts directory at ${ownAccountsDir}, nothing to migrate`);
      return { status: 'done', stats };
    }

    const jsonFiles = fs.readdirSync(ownAccountsDir).filter((f) => f.endsWith('.json'));
    appendMigrationLog(storageRoot, `[INFO] migration started, ${jsonFiles.length} json file(s) found`);

    const now = new Date().toISOString();
    const insertStmt = db.prepare(`
      INSERT INTO template_big_accounts
        (template_id, merchant_id, currency, row_index, account_nature, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'own', ?, ?)
    `);
    const countStmt = db.prepare(
      'SELECT COUNT(1) AS cnt FROM template_big_accounts WHERE template_id = ?'
    );
    const existingStmt = db.prepare(`
      SELECT account_nature AS accountNature
      FROM template_big_accounts
      WHERE template_id = ? AND merchant_id = ? AND currency = ?
    `);

    for (const jsonFile of jsonFiles) {
      stats.scannedJsonFiles += 1;
      const bankName = path.basename(jsonFile, '.json');
      const filePath = path.join(ownAccountsDir, jsonFile);
      // 主动读+解析：损坏 json / 非 array 视为迁移整体失败（抛异常由外层 catch 接）
      // 与 own-account-store.readOwnAccounts 吞异常行为不同 —— 迁移需要可见的失败信号
      const rawContent = fs.readFileSync(filePath, 'utf8');
      let accounts;
      try {
        accounts = JSON.parse(rawContent);
      } catch (parseErr) {
        throw new Error(`invalid json in ${jsonFile}: ${parseErr.message}`);
      }
      if (!Array.isArray(accounts)) {
        throw new Error(`${jsonFile} content is not an array`);
      }

      const matchingTemplates = templateRepository.getTemplatesByBankName(db, bankName);

      if (matchingTemplates.length === 0) {
        // D16：orphan bankName → 跳过 + 日志，不中断整体流程，不算失败
        stats.orphans += 1;
        stats.orphanAccounts += accounts.length;
        appendMigrationLog(
          storageRoot,
          `[WARN] orphan bankName: ${bankName} skipped (${accounts.length} accounts)`
        );
        continue;
      }

      for (const account of accounts) {
        const merchantId = typeof account?.merchantId === 'string' ? account.merchantId.trim() : '';
        if (!merchantId) continue;
        const currencies = Array.isArray(account?.currencies)
          ? account.currencies.map((v) => String(v || '').trim()).filter((v) => v !== '')
          : [];
        if (currencies.length === 0) continue;

        stats.totalAccountsInJson += 1;

        for (const template of matchingTemplates) {
          for (const currency of currencies) {
            const existing = existingStmt.get(template.id, merchantId, currency);
            if (existing) {
              stats.conflicts += 1;
              appendMigrationLog(
                storageRoot,
                `[CONFLICT] template="${template.name}" merchantId=${merchantId} currency=${currency} already exists as nature='${existing.accountNature || 'client'}', keeping existing`
              );
              continue;
            }

            // 计算 row_index：拼到该模板现有记录之后
            const countRow = countStmt.get(template.id);
            const nextRowIndex = Number(countRow?.cnt || 0);
            insertStmt.run(template.id, merchantId, currency, nextRowIndex, now, now);
            stats.insertedRows += 1;
            appendMigrationLog(
              storageRoot,
              `[OK] template="${template.name}" merchantId=${merchantId} currency=${currency} nature=own row_index=${nextRowIndex}`
            );
          }
        }
      }
    }

    settingsRepository.setSetting(db, MIGRATION_FLAG_KEY, '1');
    appendMigrationLog(
      storageRoot,
      `[INFO] migration done: scannedJsonFiles=${stats.scannedJsonFiles} totalAccountsInJson=${stats.totalAccountsInJson} insertedRows=${stats.insertedRows} conflicts=${stats.conflicts} orphans=${stats.orphans}`
    );

    if (typeof appendActivityLogEntry === 'function') {
      try {
        appendActivityLogEntry({
          level: stats.orphans > 0 ? 'warn' : 'info',
          message: '自有账号迁移（v1.5.3）完成',
          details: [
            `扫描 json 文件：${stats.scannedJsonFiles}`,
            `写入 template_big_accounts 记录：${stats.insertedRows}`,
            `冲突保留已有：${stats.conflicts}`,
            `orphan bankName（跳过）：${stats.orphans}，共 ${stats.orphanAccounts} 条`
          ]
        });
      } catch (_logErr) {
        // 日志写入失败不影响迁移
      }
    }

    return { status: 'done', stats };
  } catch (err) {
    // D15：迁移整体失败不抛异常、不阻塞启动
    const stack = err && err.stack ? err.stack : String(err);
    appendMigrationLog(storageRoot, `[ERROR] migration failed: ${stack}`);
    if (typeof appendActivityLogEntry === 'function') {
      try {
        appendActivityLogEntry({
          level: 'error',
          message: '自有账号迁移（v1.5.3）失败',
          details: [`错误：${err && err.message ? err.message : String(err)}`]
        });
      } catch (_logErr) {
        // swallow
      }
    }
    return { status: 'failed', stats, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  MIGRATION_FLAG_KEY,
  MIGRATION_LOG_FILENAME,
  getMigrationLogPath,
  runOwnAccountsMigration
};
