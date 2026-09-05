'use strict';

// 隔离 Electron 窗口运行真实弹窗与事件；账号、接口结果均为合成数据。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function exerciseDialogs() {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const modalRoot = document.getElementById('modalRoot');
  let cancelCount = 0;
  const state = {
    currencyOptions: ['USD'],
    scenarioDraft: {
      mode: 'create', category: 'offset-bill-mark', name: '子串匹配验收', priority: 1,
      config: {
        billTypes: [
          { seq: 1, conditions: [{ field: 'CustomerRef', op: '非空值', value: '' }] },
          { seq: 2, conditions: [{ field: 'Credit Amount', op: '非空值', value: '' }] }
        ],
        reconFields: [{ seq: 1, leftType: 1, leftField: 'CustomerRef', rightType: 2, rightField: 'CustomerRef' }],
        markValue: { type: 2, field: 'CustomerRef', value: '已匹配' }
      }
    }
  };
  const desktopApi = {
    scenarios: { getFundTypeEnum: async () => ({ values: [] }) },
    bigAccount: { loadMode: async () => ({ mode: 'unfixed' }), loadOrder: async () => ({ order: [] }) },
    files: {
      extractBigAccountOrder: async () => ({
        status: 'error', errorCode: 'BIG_ACCOUNT_NOT_MAINTAINED',
        unmaintainedAccounts: Array.from({ length: 18 }, (_, i) => ({
          merchantId: `M${String(i + 2).padStart(3, '0')}`, fileName: `合成账单-${i + 1}.xlsx`,
          fileOrdinal: i, blockOrdinal: 1, sourceRowNumber: 8
        }))
      }),
      cancelBigAccountSelection: async (contextId) => {
        check(contextId === 'synthetic-context', '取消上下文错误');
        cancelCount += 1;
        return { status: 'success' };
      }
    }
  };
  const dialogs = window.__rendererDialogs.createRendererDialogs({
    state, elements: { modalRoot }, desktopApi,
    appConstants: { bankStatementFields: ['CustomerRef', 'Credit Amount', 'Debit Amount'] },
    setStatus: () => {}, applyStatementResult: () => { throw new Error('阻断后不应应用账单结果'); }
  });
  dialogs.openModal(dialogs.createScenarioConfigDialogC2());
  await settle();
  const operator = modalRoot.querySelector('[data-multi="reconFields"] [data-multi-field="op"]');
  check(operator.value === '等于' && operator.options.length === 2 && !operator.multiple, '缺省或枚举错误');
  operator.value = '包含';
  operator.dispatchEvent(new Event('change', { bubbles: true }));
  check(state.scenarioDraft.config.reconFields[0].op === '包含', '选择未写回配置');
  const body = modalRoot.querySelector('.scenario-config-body');
  check(body.scrollWidth <= body.clientWidth + 1, 'C2 对账字段横向溢出');
  const remove = modalRoot.querySelector('[data-multi="reconFields"] [data-multi-action="remove"]');
  check(remove.getBoundingClientRect().right <= body.getBoundingClientRect().right, '删除按钮被挤出视口');
  window.__v326Dialogs = { dialogs, settle, modalRoot, getCancelCount: () => cancelCount };
  return { operator: operator.value, noHorizontalOverflow: true };
}

async function showMissingAccounts() {
  const { dialogs, settle, modalRoot } = window.__v326Dialogs;
  const rows = [{ index: 0, fileName: '合成账单.xlsx', sourceRowNumber: 8 }];
  dialogs.openModal(dialogs.createBigAccountSelectionDialog({
    contextId: 'synthetic-context', templateId: 1, rows, rowsWithEmptyBlocks: rows,
    expandedBigAccountOptions: [{ merchantId: 'M001', currency: 'USD' }]
  }));
  await settle();
  modalRoot.querySelector('[data-action="extract-order"]').click();
  await settle();
  const alert = modalRoot.querySelector('.big-account-unmaintained-alert');
  if (!alert || !alert.textContent.includes('M019')) throw new Error('未展示全部未维护账号');
  const button = alert.querySelector('button');
  const rect = button.getBoundingClientRect();
  if (rect.bottom > innerHeight || rect.top < 0) throw new Error('长列表确认按钮不可见');
  const body = alert.querySelector('.alert-body');
  if (body.scrollHeight <= body.clientHeight || getComputedStyle(body).overflowY !== 'auto') {
    throw new Error('长列表无法滚动');
  }
  return { allAccountsPresent: true, scrollable: true, confirmationVisible: true };
}

async function runChild() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.V326_DIALOG_USER_DATA);
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({
    width: 1080, height: 760, frame: false, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  const outputDir = path.resolve(__dirname, '../docs/previews/v3.2.6');
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    await win.loadFile(path.resolve(__dirname, '../index.html'));
    const c2 = await win.webContents.executeJavaScript(`(${exerciseDialogs.toString()})()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(outputDir, 'c2-contains-min-window.png'), (await win.webContents.capturePage()).toPNG());
    const missing = await win.webContents.executeJavaScript(`(${showMissingAccounts.toString()})()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(outputDir, 'unmaintained-accounts-min-window.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`(async () => {
      const { modalRoot, settle, getCancelCount } = window.__v326Dialogs;
      modalRoot.querySelector('.big-account-unmaintained-alert button').click();
      await settle();
      if (modalRoot.childElementCount !== 0 || getCancelCount() !== 1) throw new Error('确认未结束当前导入');
    })()`);
    console.log(JSON.stringify({ status: 'PASS', viewport: '1080x760', c2, missing, cancellation: 'PASS' }));
  } finally {
    win.destroy();
    app.quit();
  }
}

if (process.versions.electron) {
  runChild().catch((error) => { console.error(error); require('electron').app.exit(1); });
} else {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bill-v326-dialogs-'));
  try {
    const child = spawnSync(require('electron'), [__filename], {
      timeout: 30000, stdio: 'inherit',
      env: { ...process.env, V326_DIALOG_USER_DATA: tempDir, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    });
    if (child.error) throw child.error;
    process.exitCode = child.status === 0 ? 0 : 1;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
