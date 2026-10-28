'use strict';

// 设置 → 模板文件测试用存储：真实迁移 + 真实仓储，方法名与 AppDatabase 门面一致。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const { ensureTemplateResourceVersionSupport } = require('../../src/backend/database/migrations');
const repository = require('../../src/backend/database/template-resource-repository');

function createTemplateResourceStore({ filePath = ':memory:', scenarios = [] } = {}) {
  const db = new DatabaseSync(filePath);
  ensureTemplateResourceVersionSupport(db);
  return {
    db,
    scenarios,
    listTemplateResourceVersions: () => repository.listVersions(db),
    listTemplateResourceStates: () => repository.listStates(db),
    commitTemplateResourceVersion: (payload) => repository.commitVersion(db, payload),
    setTemplateResourceCurrentVersion: (payload) => repository.setCurrentVersion(db, payload),
    deleteTemplateResourceVersion: (payload) => repository.deleteVersion(db, payload),
    appendTemplateResourceChange: (change) => repository.appendChange(db, change),
    listTemplateResourceChanges: (limit) => repository.listChanges(db, limit),
    listScenarioConfigs() {
      return this.scenarios;
    },
    close: () => db.close()
  };
}

const ROOT = path.join(__dirname, '..', '..');

// 读取随包模板并按 mutate 修改后写成新的 .xlsx（用于导入新版本的测试文件）。
async function restyledTemplate(relativePath, targetPath, mutate) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(ROOT, ...relativePath.split('/')));
  if (mutate) await mutate(workbook);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  await workbook.xlsx.writeFile(targetPath);
  return targetPath;
}

module.exports = { createTemplateResourceStore, restyledTemplate };
