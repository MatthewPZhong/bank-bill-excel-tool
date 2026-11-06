'use strict';

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { SOURCE_DEFINITIONS, SOURCE_TYPES } = require('../../../src/main-process/position-reconciliation/constants');

// 真实设置弹窗、账户管理工厂与宿主；账户管理 API 为受控替身（数据在内存中），不读写用户文件。
module.exports = async ({ js, load, reset, assert, test, layout }) => {
  const root = path.resolve(__dirname, '../../..');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  const program = acorn.parse(renderer, { ecmaVersion: 'latest' }).body;
  const escapeHtmlNode = program.find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'escapeHtml');
  const modulesNode = program.find((node) => node.type === 'VariableDeclaration' && node.declarations[0].id.name === 'MODULES');
  assert.ok(escapeHtmlNode && modulesNode, '生产 escapeHtml 与 MODULES 应存在');
  const escapeHtmlSource = renderer.slice(escapeHtmlNode.start, escapeHtmlNode.end);
  const modulesSource = renderer.slice(modulesNode.declarations[0].init.start, modulesNode.declarations[0].init.end);
  const headers = [...SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].headers];

  async function setup({ snapshot = true, rows = 250, hold = [], layoutOptions = null, open = true } = {}) {
    await reset('<div id="modalRoot"></div>', layoutOptions ? { layout: layoutOptions } : undefined);
    await js(escapeHtmlSource + '\n;void 0;');
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await load('src/renderer/dialogs/bank-accounts.js');
    await load('src/renderer/dialogs/app-settings.js');
    await js(`
      window.FIXTURE_MODULES = ${modulesSource};
      window.ba = { calls: [], hold: {}, listeners: new Set(), headers: ${JSON.stringify(headers)},
        defer() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; },
        clone: (value) => JSON.parse(JSON.stringify(value)) };
      for (const name of ${JSON.stringify(hold)}) ba.hold[name] = ba.defer();
      ba.makeRows = (count, prefix = '') => Array.from({ length: count }, (_value, index) => {
        const values = ba.headers.map(() => '');
        values[ba.headers.indexOf('银行/通道简称')] = index % 5 === 0 ? '花旗' : (index % 7 === 0 ? '' : '招商银行');
        values[ba.headers.indexOf('银行账号')] = prefix + '6222' + String(index).padStart(6, '0');
        values[ba.headers.indexOf('账户状态')] = '正常';
        return { ordinal: index + 1, excelRowNumber: index + 2, channel: values[ba.headers.indexOf('银行/通道简称')], values };
      });
      ba.setData = (count, { fileName = '银行账户信息.xlsx', snapshotNo = 1, prefix = '' } = {}) => {
        ba.rows = ba.makeRows(count, prefix);
        ba.snapshot = count ? { snapshotNo, fileName, fileExtension: 'xlsx', rowCount: count, headers: ba.headers,
          channelHeader: '银行/通道简称', structureLabel: 'V1', importedAtText: '2026-11-05 21:30' } : null;
      };
      ba.setData(${snapshot ? rows : 0});
      ba.prepareResult = { status: 'success', importToken: 'token-1', fileName: '新账户表.xlsx', sheetName: '账户',
        structureLabel: 'V1', rowCount: 12, channelCount: 2, previousRowCount: ${snapshot ? rows : 0}, previousFileName: '银行账户信息.xlsx' };
      ba.commitResults = [];
      ba.saveAsResult = { status: 'success', fileName: '银行账户信息.xlsx', filePath: '/fixture/银行账户信息.xlsx' };
      ba.api = {
        async getOverview() { ba.calls.push(['overview']); if (ba.hold.overview) await ba.hold.overview.promise;
          const channels = {}; for (const row of ba.rows) if (row.channel) channels[row.channel] = (channels[row.channel] || 0) + 1;
          return ba.clone({ status: 'success', channelHeader: '银行/通道简称', snapshot: ba.snapshot,
            channels: Object.entries(channels).sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN')).map(([channel, rowCount]) => ({ channel, rowCount })) }); },
        async list(payload) { ba.calls.push(['list', payload]); if (ba.hold.list) await ba.hold.list.promise;
          const filtered = ba.rows.filter((row) => !payload.channel || row.channel === payload.channel);
          return ba.clone({ status: 'success', snapshotNo: ba.snapshot ? ba.snapshot.snapshotNo : 0, headers: ba.snapshot ? ba.headers : [],
            channel: payload.channel, total: filtered.length, offset: payload.offset, limit: payload.limit,
            rows: filtered.slice(payload.offset, payload.offset + payload.limit) }); },
        async pickImportFile() { ba.calls.push(['pick']); return { status: 'success', filePath: '/fixture/新账户表.xlsx', fileName: '新账户表.xlsx' }; },
        async prepareImport(payload) { ba.calls.push(['prepare', payload]); if (ba.hold.prepare) await ba.hold.prepare.promise; return ba.clone(ba.prepareResult); },
        async discardImport(token) { ba.calls.push(['discard', token]); return { status: 'success' }; },
        async commitImport(payload) { ba.calls.push(['commit', payload]); if (ba.hold.commit) await ba.hold.commit.promise;
          const result = ba.commitResults.shift() || { status: 'success', snapshotNo: 2, fileName: '新账户表.xlsx', rowCount: 12, channelCount: 2 };
          if (result.status === 'success') ba.setData(12, { fileName: '新账户表.xlsx', snapshotNo: 2, prefix: 'N' });
          return result; },
        async saveAs() { ba.calls.push(['saveAs']); return ba.clone(ba.saveAsResult); },
        onChanged(listener) { ba.calls.push(['subscribe']); ba.listeners.add(listener);
          return () => { ba.calls.push(['unsubscribe']); ba.listeners.delete(listener); }; }
      };
      ba.count = (name) => ba.calls.filter((call) => call[0] === name).length;
      ba.last = (name) => ba.calls.filter((call) => call[0] === name).at(-1)?.[1];
      ba.bridge = window.__rendererModalBridge;
      ba.dialogs = window.__createTestRendererDialogs({ modalBridge: ba.bridge, state: {}, elements: {}, desktopApi: {}, appConstants: {} });
      ba.bankAccounts = window.__bankAccountsDialogs.createBankAccountsDialogs({
        api: { bankAccounts: ba.api }, modalBridge: ba.bridge,
        ui: { escapeHtml, createConfirmDialog: ba.dialogs.createConfirmDialog } });
      ba.settings = window.__appSettingsDialogs.createAppSettingsDialogs({
        api: {}, modalBridge: ba.bridge, modules: FIXTURE_MODULES,
        ui: { escapeHtml, createConfirmDialog: ba.dialogs.createConfirmDialog,
          getDarkModeController: () => null, mountAppearanceSettings: () => null,
          mountBankAccounts: (pane, options) => ba.bankAccounts.mountBankAccounts(pane, options),
          applyAppUpdateActionResult() {}, applyAppUpdateStatus() {}, getAppUpdateStatus: () => ({}),
          refreshOpenAppUpdateDialog() {}, restartAndInstallAppUpdate() {} } });
      ba.open = () => { ba.handle = ba.bridge.openModal(() => (ba.overlay = ba.settings.createAppUpdateSettingsDialog())).handle; };
      ba.q = (selector) => ba.overlay.querySelector('[data-pane="accounts"] ' + selector);
      ba.top = () => document.getElementById('modalRoot').lastElementChild;
      ba.text = (selector) => (ba.q(selector)?.textContent || '').replace(/\\s+/g, ' ').trim();
      ba.bodyRows = () => ba.overlay.querySelectorAll('[data-pane="accounts"] .bank-accounts-table tbody tr').length;
      ba.select = (value) => { const element = ba.q('[data-role="bank-accounts-channel"]'); element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); };
      void 0;`);
    if (open) {
      await js('ba.open(); ba.overlay.querySelector(\'[data-tab="accounts"]\').click(); void 0;');
      if (!hold.includes('overview') && !hold.includes('list')) {
        await waitFor(snapshot ? 'ba.bodyRows() > 0' : '!!ba.q(".bank-accounts-empty")', '账户表加载');
      }
    }
  }

  async function waitFor(expression, description = expression) {
    return js(`new Promise((resolve, reject) => {
      const until = Date.now() + 3000;
      const check = () => {
        try { if (${expression}) return resolve(true); } catch (error) { return reject(error); }
        if (Date.now() > until) return reject(new Error('等待条件超时：' + ${JSON.stringify(description)}));
        setTimeout(check, 20);
      };
      check();
    })`);
  }
  const settle = () => js('new Promise((resolve) => setTimeout(resolve, 30))');

  await test('账户管理位于外观设置之前（与模板文件的先后由界面合同测试核对）；首次进入才读取，切换标签不重复读取', async () => {
    await setup({ open: false });
    await js('ba.open(); void 0;');
    assert.deepEqual(await js(`[...ba.overlay.querySelectorAll('.app-settings-nav-item')].map((item) => item.dataset.tab)`),
      ['update', 'archive', 'accounts', 'appearance']);
    assert.equal(await js(`ba.overlay.querySelector('[data-tab="accounts"] span:not(.app-settings-nav-icon)').textContent`), '账户管理');
    assert.equal(await js('ba.count("overview")'), 0);
    await js(`ba.overlay.querySelector('[data-tab="accounts"]').click(); void 0;`);
    await waitFor('ba.bodyRows() > 0');
    assert.equal(await js(`ba.overlay.querySelector('[data-pane="accounts"]').hidden`), false);
    assert.equal(await js(`ba.overlay.querySelector('[data-footer="update"]').hidden`), true);
    await js(`ba.overlay.querySelector('[data-tab="appearance"]').click(); ba.overlay.querySelector('[data-tab="accounts"]').click(); void 0;`);
    await settle();
    assert.equal(await js('ba.count("overview")'), 1);
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('标题、空白默认渠道与左下按钮；空白显示全部并分页，选中渠道只显示该渠道', async () => {
    await setup();
    assert.equal(await js(`ba.text('#bankAccountsHeading')`), '清结算系统账户管理');
    assert.deepEqual(await js(`[...ba.q('[data-role="bank-accounts-channel"]').options].map((option) => [option.value, option.textContent])`),
      [['', ''], ['花旗', '花旗'], ['招商银行', '招商银行']]);
    assert.equal(await js(`ba.q('[data-role="bank-accounts-channel"]').value`), '');
    assert.deepEqual(await js(`[...ba.overlay.querySelectorAll('[data-pane="accounts"] .bank-accounts-actions-main button')].map((button) => [button.textContent, button.disabled])`),
      [['导入银行账户信息', false], ['导出', false]]);
    assert.equal(await js('ba.bodyRows()'), 200);
    assert.equal(await js(`ba.overlay.querySelectorAll('[data-pane="accounts"] .bank-accounts-table thead th').length`), headers.length + 1);
    assert.equal(await js(`ba.text('[data-role="bank-accounts-page"]')`), '第 1 / 2 页（共 250 行）');
    assert.equal(await js(`ba.text('[data-role="bank-accounts-summary"]')`), '当前账户表：银行账户信息.xlsx · 250 行 · 2 个渠道 · 导入于 2026-11-05 21:30 · 识别结构 V1');
    await js(`ba.q('[data-action="next-page"]').click(); void 0;`);
    await waitFor('ba.bodyRows() === 50');
    assert.deepEqual(await js('ba.last("list")'), { channel: '', offset: 200, limit: 200 });
    await js(`ba.select('花旗'); void 0;`);
    await waitFor('ba.bodyRows() === 50 && ba.last("list").channel === "花旗"');
    assert.deepEqual(await js('ba.last("list")'), { channel: '花旗', offset: 0, limit: 200 });
    assert.equal(await js(`[...ba.overlay.querySelectorAll('[data-pane="accounts"] .bank-accounts-table tbody tr')].every((row) => row.cells[1 + ba.headers.indexOf('银行/通道简称')].textContent === '花旗')`), true);
    assert.equal(await js(`ba.q('[data-role="bank-accounts-pager"]').hidden`), true);
    await js(`ba.select(''); void 0;`);
    await waitFor('ba.bodyRows() === 200');
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('未导入时显示空状态，导出不可用、渠道下拉禁用', async () => {
    await setup({ snapshot: false });
    assert.equal(await js(`ba.text('.bank-accounts-empty')`), '尚未导入银行账户信息，请点击左下角【导入银行账户信息】');
    assert.equal(await js(`ba.text('[data-role="bank-accounts-summary"]')`), '尚未导入银行账户信息');
    assert.deepEqual(await js(`({ exportDisabled: ba.q('[data-action="export-bank-accounts"]').disabled,
      channelDisabled: ba.q('[data-role="bank-accounts-channel"]').disabled, listCalls: ba.count('list') })`),
    { exportDisabled: true, channelDisabled: true, listCalls: 0 });
  });

  await test('导入：预检后确认整份替换，写入中确认框与设置弹窗都不能关闭，完成后刷新为新账户表', async () => {
    await setup({ hold: ['commit'] });
    await js(`ba.q('[data-action="import-bank-accounts"]').click(); void 0;`);
    await waitFor(`ba.top()?.querySelector('.alert-message')?.textContent.includes('整份替换')`, '替换确认框');
    assert.equal(await js(`ba.top().querySelector('.alert-message').textContent.replace(/\\s+/g, ' ').trim()`),
      '清结算银行账户表将整份替换：250 行 → 12 行（2 个渠道）文件：新账户表.xlsx；工作表：账户；识别结构：V1');
    assert.deepEqual(await js('ba.last("prepare")'), { filePath: '/fixture/新账户表.xlsx' });
    await js(`ba.top().querySelector('[data-action="confirm"]').click(); void 0;`);
    await waitFor('ba.count("commit") === 1');
    assert.equal(await js(`ba.top().querySelector('[data-action="confirm"]').textContent`), '处理中…');
    assert.equal(await js(`ba.bridge.closeModal(ba.top()).status !== 'closed'`), true, '写入中确认框不能关闭');
    assert.equal(await js(`ba.bridge.closeModal(ba.overlay).status !== 'closed'`), true, '写入中设置弹窗不能关闭');
    await js('ba.hold.commit.resolve(); void 0;');
    await waitFor(`ba.bodyRows() === 12 && ba.text('[data-role="bank-accounts-summary"]').startsWith('当前账户表：新账户表.xlsx · 12 行')`);
    assert.equal(await js(`ba.text('[data-role="bank-accounts-feedback"]')`), '已导入 12 行账户（2 个渠道）：新账户表.xlsx');
    assert.deepEqual(await js('ba.last("commit")'), { importToken: 'token-1' });
    assert.equal(await js('ba.count("discard")'), 0);
    assert.equal(await js(`ba.top() === ba.overlay`), true);
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('导入：取消确认时丢弃预检；预检未通过时逐行提示原因，不弹确认', async () => {
    await setup();
    await js(`ba.q('[data-action="import-bank-accounts"]').click(); void 0;`);
    await waitFor(`ba.top()?.querySelector('[data-action="cancel"]') && ba.top() !== ba.overlay`);
    await js(`ba.top().querySelector('[data-action="cancel"]').click(); void 0;`);
    await waitFor('ba.count("discard") === 1');
    assert.equal(await js('ba.last("discard")'), 'token-1');
    assert.equal(await js('ba.count("commit")'), 0);

    await js(`ba.prepareResult = { status: 'failed', message: '无法识别为清结算银行账户表：新账户表.xlsx',
      detailLines: ['最接近：清结算银行账户表（当前版本 V1，40 列；文件 39 列）', '缺少列：最近更新时间', '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本'] };
      ba.q('[data-action="import-bank-accounts"]').click(); void 0;`);
    await waitFor(`ba.q('[data-role="bank-accounts-feedback"]').dataset.tone === 'error'`);
    assert.deepEqual(await js(`[...ba.q('[data-role="bank-accounts-feedback"]').querySelectorAll('li')].map((item) => item.textContent)`),
      ['最接近：清结算银行账户表（当前版本 V1，40 列；文件 39 列）', '缺少列：最近更新时间', '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本']);
    assert.equal(await js('ba.top() === ba.overlay'), true);
    assert.equal(await js(`ba.q('[data-action="import-bank-accounts"]').disabled`), false);
  });

  await test('导入：写入失败时关闭确认框并提示，账户表保持原样；关闭设置弹窗时退订且丢弃迟到的预检', async () => {
    await setup();
    await js(`ba.commitResults.push({ status: 'failed', message: '账户表在预检之后已被替换，请重新导入银行账户信息' });
      ba.q('[data-action="import-bank-accounts"]').click(); void 0;`);
    await waitFor('ba.top() !== ba.overlay');
    await js(`ba.top().querySelector('[data-action="confirm"]').click(); void 0;`);
    await waitFor(`ba.text('[data-role="bank-accounts-feedback"]') === '账户表在预检之后已被替换，请重新导入银行账户信息'`);
    assert.equal(await js('ba.top() === ba.overlay'), true);
    assert.equal(await js('ba.bodyRows()'), 200);

    await setup({ hold: ['prepare'] });
    await js(`ba.q('[data-action="import-bank-accounts"]').click(); void 0;`);
    await waitFor('ba.count("prepare") === 1');
    assert.equal(await js(`ba.q('[data-action="import-bank-accounts"]').disabled`), true);
    await js('ba.bridge.closeModal(ba.overlay); void 0;');
    await settle();
    assert.equal(await js('ba.count("unsubscribe")'), 1);
    await js('ba.hold.prepare.resolve(); void 0;');
    await waitFor('ba.count("discard") === 1', '关闭后到达的预检被丢弃');
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 0);
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('导出：调用另存为并提示结果；变更通知触发重新读取', async () => {
    await setup();
    await js(`ba.q('[data-action="export-bank-accounts"]').click(); void 0;`);
    await waitFor(`ba.text('[data-role="bank-accounts-feedback"]') === '已导出：银行账户信息.xlsx'`);
    assert.equal(await js('ba.count("saveAs")'), 1);
    await js(`ba.saveAsResult = { status: 'failed', message: '原表文件已被修改，请重新导入银行账户信息' };
      ba.q('[data-action="export-bank-accounts"]').click(); void 0;`);
    await waitFor(`ba.text('[data-role="bank-accounts-feedback"]') === '原表文件已被修改，请重新导入银行账户信息'`);
    await js(`ba.setData(3, { fileName: '其他窗口导入.xlsx', snapshotNo: 5 }); for (const listener of ba.listeners) listener({ snapshotNo: 5 }); void 0;`);
    await waitFor('ba.bodyRows() === 3');
    assert.equal(await js('ba.count("overview")'), 2);
    assert.deepEqual(await js('__testErrors'), []);
  });

  for (const [name, options] of [
    ['bank-accounts-light', { width: 1080, height: 760, theme: 'light' }],
    ['bank-accounts-dark', { width: 1080, height: 760, theme: 'dark' }],
    ['bank-accounts-zoom-150', { width: 1080, height: 760, theme: 'light', zoom: 1.5 }]
  ]) {
    await test(`生产样式 ${options.width}×${options.height}${options.zoom ? ` @${options.zoom * 100}%` : ''} ${options.theme}：表格内部横向滚动，标题、渠道与按钮可见`, async () => {
      await reset();
      await setup({ layoutOptions: options });
      const geometry = await js(`(() => {
        const card = ba.overlay.querySelector('.app-update-settings-card').getBoundingClientRect();
        const visible = (element) => { const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.left >= card.left - 1 && rect.right <= card.right + 1 && rect.top >= card.top - 1 && rect.bottom <= card.bottom + 1; };
        const pane = ba.overlay.querySelector('[data-pane="accounts"]');
        const wrap = ba.q('.bank-accounts-table-wrap');
        return {
          paneOverflow: pane.scrollWidth > pane.clientWidth + 1,
          tableScrolls: wrap.scrollWidth > wrap.clientWidth && getComputedStyle(wrap).overflowX === 'auto',
          visible: ['#bankAccountsHeading', '[data-role="bank-accounts-channel"]', '[data-action="import-bank-accounts"]', '[data-action="export-bank-accounts"]']
            .map((selector) => visible(ba.q(selector))),
          exportRightOfImport: ba.q('[data-action="export-bank-accounts"]').getBoundingClientRect().left > ba.q('[data-action="import-bank-accounts"]').getBoundingClientRect().right,
          cardFits: card.right <= innerWidth + 1 && card.bottom <= innerHeight + 1
        };
      })()`);
      assert.deepEqual(geometry, { paneOverflow: false, tableScrolls: true, visible: [true, true, true, true], exportRightOfImport: true, cardFits: true });
      await layout.settle();
      await js('new Promise((resolve) => setTimeout(resolve, 250))');
      await layout.evidence(name, { geometry });
    });
  }
};
