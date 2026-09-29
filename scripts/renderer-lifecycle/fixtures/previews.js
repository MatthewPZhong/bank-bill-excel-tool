'use strict';

// 生产预览入口 + 真实映射工厂；异步映射 API 受控，禁止读写真实配置。
module.exports = async ({ js, load, reset, assert, test }) => {
  async function setup() {
    await reset();
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await load('src/renderer-previews.js');
    await js(`
      window.fixture = { reads: 0, saves: [], state: {}, root: document.getElementById('modalRoot') };
      fixture.api = { fundTransferAccountMappings: {
        list() { fixture.reads++; return new Promise(resolve => fixture.resolveLoad = resolve); },
        async save(rows) { fixture.saves.push(rows); return { status: 'success', message: '已保存' }; }
      } };
      fixture.dialogs = __createTestRendererDialogs({ modalBridge: __rendererModalBridge,
        state: fixture.state, elements: { modalRoot: fixture.root }, desktopApi: fixture.api });
      fixture.previews = __rendererPreviews.createRendererPreviews({ ...fixture.dialogs, modalHost: __rendererModalHost,
        state: fixture.state, elements: { modalRoot: fixture.root },
        MODULES: { bankStatementProcess: { id: 'bank' }, statementGenerator: { id: 'statement' } },
        setCurrentModule(id) { fixture.state.currentModule = id; }
      }); void 0;
    `);
  }

  await test('映射预览先挂载再读取，合法空表允许保存，成功结果替换编辑层', async () => {
    await setup();
    assert.equal(await js(`fixture.unmounted = fixture.dialogs.createFundTransferAccountMappingDialog(); fixture.reads`), 0);
    assert.deepEqual(await js(`fixture.opened = fixture.previews.applyFundTransferAccountMappingPreviewState();
      fixture.overlay = fixture.root.firstElementChild;
      ({ reads: fixture.reads, open: fixture.opened.handle.isOpen(), disabled: fixture.overlay.querySelector('[data-action="done"]').disabled })`),
    { reads: 1, open: true, disabled: true });
    await js(`fixture.resolveLoad({status:'success', mappings:[]}); new Promise(resolve => setTimeout(resolve, 0))`);
    assert.equal(await js(`fixture.overlay.querySelector('[data-action="done"]').disabled`), false);
    await js(`fixture.overlay.querySelector('[data-action="done"]').click(); new Promise(resolve => setTimeout(resolve, 0))`);
    assert.deepEqual(await js(`({ saves: fixture.saves, oldOpen: fixture.opened.handle.isOpen(), count: fixture.root.children.length, alert: !!fixture.root.querySelector('.alert-card') })`),
      { saves: [[]], oldOpen: false, count: 1, alert: true });
    assert.deepEqual(await js(`__testErrors`), []);
  });

  await test('映射预览加载失败禁用保存，告警只关闭子层，保留映射父层', async () => {
    await setup();
    await js(`fixture.opened = fixture.previews.applyFundTransferAccountMappingPreviewState(); fixture.overlay = fixture.root.firstElementChild;
      fixture.resolveLoad({status:'failed'}); new Promise(resolve => setTimeout(resolve, 0))`);
    assert.deepEqual(await js(`({ count: fixture.root.children.length, disabled: fixture.overlay.querySelector('[data-action="done"]').disabled, open: fixture.opened.handle.isOpen() })`),
      { count: 2, disabled: true, open: true });
    await js(`fixture.root.lastElementChild.querySelector('button').click();
      fixture.overlay.querySelector('[data-action="done"]').dispatchEvent(new MouseEvent('click', {bubbles:true}));`);
    assert.deepEqual(await js(`({ count: fixture.root.children.length, saves: fixture.saves, top: fixture.opened.handle.isTop() })`),
      { count: 1, saves: [], top: true });
  });

  await test('映射预览销毁后晚到读取不改旧控件或新生产窗口', async () => {
    await setup();
    await js(`fixture.opened = fixture.previews.applyFundTransferAccountMappingPreviewState(); fixture.overlay = fixture.root.firstElementChild;
      fixture.before = fixture.overlay.innerHTML;
      fixture.replacement = __rendererModalBridge.openModal(() => fixture.dialogs.createAlertDialog('新生产窗口', {skipLogReport:true}));
      fixture.resolveLoad({status:'success', mappings:[{midAccountId:'A',clearingAccountId:'B'}]}); new Promise(resolve => setTimeout(resolve, 0))`);
    assert.deepEqual(await js(`({ oldUnchanged: fixture.before===fixture.overlay.innerHTML,
      oldOpen: fixture.opened.handle.isOpen(), current: fixture.replacement.handle.isTop(), count:fixture.root.children.length })`),
      { oldUnchanged: true, oldOpen: false, current: true, count: 1 });
  });

  await test('多文件工具箱预览沿生产工厂延迟打开和增组，返回句柄限定所有延迟操作', async () => {
    await setup();
    await js(`fixture.previews.applyToolboxSplitFieldPickerMultiplePreviewState(); new Promise(resolve => setTimeout(resolve, 260))`);
    assert.deepEqual(await js(`({ groups: fixture.root.querySelectorAll('.toolbox-split-group').length,
      panelOpen: !fixture.root.querySelector('.toolbox-split-values-floating-panel').hidden, count: fixture.root.children.length })`),
      { groups: 8, panelOpen: true, count: 1 });
    assert.deepEqual(await js(`__testErrors`), []);
  });
};
