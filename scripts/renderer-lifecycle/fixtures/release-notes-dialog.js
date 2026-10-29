'use strict';

// 真实更新说明工厂/宿主/桥接；确认 API 为替身，不读写真实设置。
module.exports = async ({ js, load, reset, assert, test, layout }) => {
  const tick = () => js('new Promise(resolve=>setTimeout(resolve,10))');
  const PENDING = {
    fromVersion: '3.2.14',
    toVersion: '3.2.16',
    entries: [
      { version: '3.2.16', date: '2026-11-11', highlights: ['新增 <b>不应解析</b> 的要点', '第二条'] },
      { version: '3.2.15', date: '2026-11-04', highlights: ['十五'] }
    ]
  };
  const CURRENT = PENDING.entries[0];

  async function setup({ releaseNotes = { current: CURRENT, pending: PENDING }, owner = 'application', layoutOptions = null } = {}) {
    await reset('<div id="modalRoot"></div>', layoutOptions ? { layout: layoutOptions } : undefined);
    await load('src/renderer/dialogs/release-notes.js');
    await js(`
      window.rn={acks:[],errors:[],
        root:()=>document.getElementById('modalRoot'),
        top:()=>document.getElementById('modalRoot').lastElementChild,
        text:()=>document.getElementById('modalRoot').lastElementChild?.textContent.replace(/\\s+/g,' ').trim()||''};
      rn.host=__rendererModalHost;
      rn.bridge=__modalBridge.createModalBridge({host:rn.host,getOwner:()=>${JSON.stringify(owner)}});
      rn.dialogs=__releaseNotesDialogs.createReleaseNotesDialogs({
        api:{settings:{acknowledgeReleaseNotes:version=>{rn.acks.push(version);return Promise.resolve({status:'ok'});}}},
        modalBridge:rn.bridge,
        ui:{escapeHtml:value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
          getModalRoot:()=>document.getElementById('modalRoot')}
      });
      rn.dialogs.accept(${JSON.stringify(releaseNotes)});
      rn.other=()=>rn.bridge.openModal(()=>{const overlay=document.createElement('div');overlay.className='modal-overlay';
        overlay.innerHTML='<section class="modal-card other-card"><button type="button">其他</button></section>';return overlay;}).handle;
      window.addEventListener('unhandledrejection',event=>rn.errors.push(String(event.reason?.message||event.reason)));
      void 0;
    `);
  }

  await test('升级后弹出：版本从新到旧、文本转义，【知道了】后只确认一次且不再弹', async () => {
    await setup();
    await js('rn.dialogs.showStartupReleaseNotes()');
    assert.equal(await js('rn.root().children.length'), 1);
    assert.equal(await js(`rn.top().querySelector('.release-notes-summary').textContent`), '已从 v3.2.14 更新到 v3.2.16');
    assert.deepEqual(await js(`[...rn.top().querySelectorAll('.release-notes-version-title span:first-child')].map(node=>node.textContent)`), ['v3.2.16', 'v3.2.15']);
    assert.equal(await js(`rn.top().querySelector('.release-notes-list li').textContent`), '新增 <b>不应解析</b> 的要点');
    assert.equal(await js(`rn.top().querySelector('.release-notes-list b')`), null);
    assert.equal(await js(`document.activeElement?.dataset.action`), 'acknowledge');
    await js(`rn.top().querySelector('[data-action="acknowledge"]').click()`); await tick();
    assert.equal(await js('rn.root().children.length'), 0);
    assert.deepEqual(await js('rn.acks'), ['3.2.16']);
    await js('rn.dialogs.showStartupReleaseNotes()'); await tick();
    assert.equal(await js('rn.root().children.length'), 0);
    assert.deepEqual(await js('rn.acks'), ['3.2.16']);
    assert.deepEqual(await js('rn.errors'), []);
  });

  await test('来源版本未知时写“已更新到”；×、Esc 关闭同样确认，点背景不关', async () => {
    await setup({ releaseNotes: { current: CURRENT, pending: { ...PENDING, fromVersion: null } } });
    await js('rn.dialogs.showStartupReleaseNotes()');
    assert.equal(await js(`rn.top().querySelector('.release-notes-summary').textContent`), '已更新到 v3.2.16');
    await js(`rn.top().dispatchEvent(new MouseEvent('click',{bubbles:true}))`); await tick();
    assert.equal(await js('rn.root().children.length'), 1, '点击背景不关闭');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await tick();
    assert.equal(await js('rn.root().children.length'), 0);
    assert.deepEqual(await js('rn.acks'), ['3.2.16']);

    await setup();
    await js('rn.dialogs.showStartupReleaseNotes()');
    await js(`rn.top().querySelector('[data-action="close"]').click()`); await tick();
    assert.deepEqual(await js('rn.acks'), ['3.2.16']);
  });

  await test('启动时已有弹窗：等其关闭后再弹，不替换已有弹窗', async () => {
    await setup();
    await js('rn.otherHandle=rn.other(); rn.dialogs.showStartupReleaseNotes()'); await tick();
    assert.equal(await js('rn.root().children.length'), 1);
    assert.equal(await js('rn.otherHandle.isOpen()'), true);
    assert.equal(await js(`!!rn.top().querySelector('.other-card')`), true);
    await js('rn.otherHandle.close({status:"submitted"})'); await tick();
    assert.equal(await js('rn.root().children.length'), 1);
    assert.equal(await js(`!!rn.top().querySelector('.release-notes-card')`), true);
    assert.deepEqual(await js('rn.acks'), []);
    await js(`rn.top().querySelector('[data-action="acknowledge"]').click()`); await tick();
    assert.deepEqual(await js('rn.acks'), ['3.2.16']);
  });

  await test('应用级弹窗：模块 closeOwner 不关闭；被替换或强制卸载时不确认', async () => {
    await setup({ owner: 'statement-generator' });
    await js('rn.dialogs.showStartupReleaseNotes()');
    await js(`rn.host.closeOwner('statement-generator'); void 0;`); await tick();
    assert.equal(await js(`!!rn.top()?.querySelector('.release-notes-card')`), true);
    await js('rn.other(); void 0;'); await tick();
    assert.equal(await js(`!!rn.top().querySelector('.other-card')`), true);
    assert.deepEqual(await js('rn.acks'), [], '被其他弹窗替换不算用户确认');

    await setup();
    await js('rn.dialogs.showStartupReleaseNotes()');
    await js('rn.host.dispose(); void 0;'); await tick();
    assert.deepEqual(await js('rn.acks'), []);
  });

  await test('设置入口：叠在设置弹窗上只显示本版，关闭后回到设置且不确认', async () => {
    await setup();
    await js('rn.parent=rn.other(); rn.dialogs.openCurrentReleaseNotes(rn.parent); void 0;'); await tick();
    assert.equal(await js('rn.root().children.length'), 2);
    assert.equal(await js(`rn.top().querySelector('.release-notes-summary').textContent`), '当前版本 v3.2.16');
    assert.equal(await js(`rn.top().querySelectorAll('.release-notes-version').length`), 1);
    await js(`rn.top().querySelector('[data-action="acknowledge"]').click()`); await tick();
    assert.equal(await js('rn.root().children.length'), 1);
    assert.equal(await js('rn.parent.isTop()'), true);
    assert.deepEqual(await js('rn.acks'), []);

    await setup({ releaseNotes: { current: null, pending: null } });
    await js('rn.dialogs.showStartupReleaseNotes()'); await tick();
    assert.equal(await js('rn.root().children.length'), 0, '没有待显示内容时不弹');
    await js('rn.parent=rn.other(); rn.dialogs.openCurrentReleaseNotes(rn.parent); void 0;'); await tick();
    assert.equal(await js(`rn.top().querySelector('.release-notes-empty').textContent`), '本版暂无更新说明');
    assert.equal(await js(`rn.top().querySelector('.release-notes-summary')`), null);
  });

  // 跨多个版本、每版写满 5 条的最长内容：正文滚动，标题与【知道了】始终可见。
  const LONG_PENDING = {
    fromVersion: '3.2.13',
    toVersion: '3.2.16',
    entries: ['3.2.16', '3.2.15', '3.2.14'].map((version, index) => ({
      version,
      date: `2026-11-${String(11 - index * 7).padStart(2, '0')}`,
      highlights: Array.from({ length: 5 }, (_, item) => `第 ${item + 1} 条：${'设置与导出相关的面向用户说明，'.repeat(6)}`.slice(0, 120))
    }))
  };
  for (const [name, options] of [
    ['release-notes-light', { width: 1080, height: 760, theme: 'light' }],
    ['release-notes-dark', { width: 1080, height: 760, theme: 'dark' }],
    ['release-notes-zoom-150', { width: 1080, height: 760, theme: 'light', zoom: 1.5 }]
  ]) {
    await test(`生产样式 ${options.width}×${options.height}${options.zoom ? ` @${options.zoom * 100}%` : ''} ${options.theme}：长内容正文滚动，标题与按钮可见`, async () => {
      // 先切回普通模式，使布局用例各自新建并显示窗口；复用被遮挡的窗口时截图可能停在旧帧。
      await reset();
      await setup({ releaseNotes: { current: LONG_PENDING.entries[0], pending: LONG_PENDING }, layoutOptions: options });
      await js('rn.dialogs.showStartupReleaseNotes()');
      await layout.settle();
      const geometry = await js(`(() => {
        const card = rn.top().querySelector('.release-notes-card').getBoundingClientRect();
        const body = rn.top().querySelector('.release-notes-body');
        const visible = (selector) => {
          const element = rn.top().querySelector(selector);
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        };
        return {
          cardFits: card.left >= -1 && card.top >= -1 && card.right <= innerWidth + 1 && card.bottom <= innerHeight + 1,
          bodyScrolls: body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === 'auto',
          noHorizontalOverflow: body.scrollWidth <= body.clientWidth + 1,
          titleVisible: visible('.dialog-title'),
          acknowledgeVisible: visible('[data-action="acknowledge"]')
        };
      })()`);
      assert.deepEqual(geometry, { cardFits: true, bodyScrolls: true, noHorizontalOverflow: true, titleVisible: true, acknowledgeVisible: true });
      await js('new Promise((resolve) => setTimeout(resolve, 250))');
      await layout.evidence(name, { geometry });
      await layout.click('[data-action="acknowledge"]');
      await tick();
      assert.deepEqual(await js('rn.acks'), ['3.2.16']);
    });
  }
};
