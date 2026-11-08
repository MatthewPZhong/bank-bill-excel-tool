(function initReleaseNotesDialogs(global) {
  'use strict';

  // v3.2.14 升级后首次启动的「更新说明」：启动弹窗由用户关闭后确认当前版本；
  //   设置「版本管理」入口查看上一个版本到当前版本的说明（v3.2.15），不改变确认记录。
  //   两处共用同一弹窗，每页 1 个版本，翻页不算确认。
  //   数据来自 app:get-info 的 releaseNotes（Main 启动时判定一次）。
  const ACKNOWLEDGE_REASONS = Object.freeze(['cancel', 'escape']);

  function createReleaseNotesDialogs({ api, modalBridge, ui }) {
    const { escapeHtml, getModalRoot } = ui;
    let releaseNotes = { current: null, pending: null, history: null };
    let startupShown = false;
    let observer = null;
    let dialogSequence = 0;

    function accept(value) {
      const pending = value?.pending;
      const history = value?.history;
      releaseNotes = {
        current: value?.current || null,
        pending: pending && Array.isArray(pending.entries) && pending.entries.length ? pending : null,
        history: history && Array.isArray(history.entries) ? history : null
      };
    }

    function renderEntries(entries) {
      return entries.map((entry) => `
        <section class="release-notes-version">
          <h4 class="release-notes-version-title">
            <span>v${escapeHtml(entry.version)}</span>
            <span class="release-notes-version-date">${escapeHtml(entry.date)}</span>
          </h4>
          <ul class="release-notes-list">
            ${entry.highlights.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}
          </ul>
        </section>`).join('');
    }

    function createReleaseNotesDialog({ summary, entries }) {
      dialogSequence += 1;
      const titleId = `releaseNotesTitle${dialogSequence}`;
      const pageCount = entries.length;
      const paged = pageCount > 1;
      let pageIndex = 0;
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const card = document.createElement('section');
      card.className = 'modal-card release-notes-card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', titleId);
      card.innerHTML = `
        <div class="dialog-header">
          <div id="${titleId}" class="dialog-title">更新说明</div>
          <button class="icon-close" type="button" data-action="close" title="关闭" aria-label="关闭">×</button>
        </div>
        <div class="release-notes-body">
          ${summary ? `<p class="release-notes-summary">${escapeHtml(summary)}</p>` : ''}
          <div data-role="release-notes-page">${pageCount ? '' : '<p class="release-notes-empty">本版暂无更新说明</p>'}</div>
        </div>
        <footer class="dialog-actions ${paged ? 'split' : 'right'}">
          ${paged ? `<div class="release-notes-pager">
            <button class="secondary-btn small" type="button" data-action="previous-page">上一页</button>
            <span class="release-notes-page-indicator" data-role="page-indicator" aria-live="polite"></span>
            <button class="secondary-btn small" type="button" data-action="next-page">下一页</button>
          </div>` : ''}
          <button class="primary-btn small" type="button" data-action="acknowledge">知道了</button>
        </footer>`;
      overlay.appendChild(card);
      const body = card.querySelector('.release-notes-body');
      const page = card.querySelector('[data-role="release-notes-page"]');
      const previousButton = card.querySelector('[data-action="previous-page"]');
      const nextButton = card.querySelector('[data-action="next-page"]');

      // 第 1 页是最新版本；翻页后正文回到顶部。焦点所在按钮被置灰时移到另一个翻页按钮，避免焦点落空。
      function showPage(index) {
        if (!pageCount) return;
        pageIndex = Math.min(Math.max(index, 0), pageCount - 1);
        page.innerHTML = renderEntries([entries[pageIndex]]);
        body.scrollTop = 0;
        if (!paged) return;
        card.querySelector('[data-role="page-indicator"]').textContent = `第 ${pageIndex + 1}/${pageCount} 页`;
        // 置灰会让浏览器立即移走焦点，须先记下焦点所在按钮。
        const focused = card.ownerDocument.activeElement;
        previousButton.disabled = pageIndex === 0;
        nextButton.disabled = pageIndex === pageCount - 1;
        if (focused === previousButton && previousButton.disabled) nextButton.focus();
        else if (focused === nextButton && nextButton.disabled) previousButton.focus();
      }
      showPage(0);

      card.addEventListener('click', (event) => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'acknowledge') modalBridge.closeModal(overlay, { status: 'submitted', value: true });
        else if (action === 'close') modalBridge.closeModal(overlay, { status: 'cancelled', reason: 'cancel' });
        else if (action === 'previous-page') showPage(pageIndex - 1);
        else if (action === 'next-page') showPage(pageIndex + 1);
      });
      modalBridge.registerModal(overlay, {
        dialog: card,
        dismiss: { escape: true, backdrop: false },
        initialFocus: () => card.querySelector('[data-action="acknowledge"]')
      });
      return overlay;
    }

    function stopWaiting() {
      observer?.disconnect();
      observer = null;
    }

    async function acknowledge(version) {
      releaseNotes = { ...releaseNotes, pending: null };
      try {
        const result = await api.settings.acknowledgeReleaseNotes(version);
        if (result?.status === 'failed') console.warn('确认更新说明失败：', result.message);
      } catch (error) {
        console.warn('确认更新说明失败：', error);
      }
    }

    // 已有弹窗时等 modalRoot 清空再弹（与在线升级「已下载」提示一致），不替换别人的弹窗。
    function waitForEmptyModalRoot(root) {
      if (observer || typeof MutationObserver !== 'function') return;
      observer = new MutationObserver(() => {
        if (root.childElementCount === 0) queueMicrotask(showStartupReleaseNotes);
      });
      observer.observe(root, { childList: true });
    }

    function showStartupReleaseNotes() {
      const pending = releaseNotes.pending;
      if (!pending || startupShown) return;
      const root = getModalRoot();
      if (root && root.childElementCount > 0) {
        waitForEmptyModalRoot(root);
        return;
      }
      stopWaiting();
      startupShown = true;
      const summary = pending.fromVersion
        ? `已从 v${pending.fromVersion} 更新到 v${pending.toVersion}`
        : `已更新到 v${pending.toVersion}`;
      // 应用级弹窗：切换模块时控制器 closeOwner 不会关掉它。
      const result = modalBridge.openModal(
        () => createReleaseNotesDialog({ summary, entries: pending.entries }),
        { owner: 'application' }
      );
      if (result?.status !== 'opened') return;
      result.handle.closed.then((outcome) => {
        // 只有用户主动关闭才确认；被替换或页面卸载时下次启动再弹。
        if (outcome?.status === 'submitted' || ACKNOWLEDGE_REASONS.includes(outcome?.reason)) {
          return acknowledge(pending.toVersion);
        }
        return undefined;
      }).catch((error) => console.warn('更新说明弹窗关闭处理失败：', error));
    }

    // 设置入口：Main 给出的 history（待显示的升级 → 最近一次升级 → 只有本版）；旧数据缺 history 时退回本版。
    function historyOf() {
      if (releaseNotes.history) return releaseNotes.history;
      const current = releaseNotes.current;
      return { kind: 'current', fromVersion: null, toVersion: current ? current.version : null, entries: current ? [current] : [] };
    }

    function historySummary(history) {
      if (!history.entries.length) return '';
      if (history.kind !== 'upgrade') return `当前版本 v${history.toVersion}`;
      return history.fromVersion
        ? `已从 v${history.fromVersion} 更新到 v${history.toVersion}`
        : `已更新到 v${history.toVersion}`;
    }

    function openReleaseNotesHistory(parentHandle) {
      const history = historyOf();
      return modalBridge.pushModal(parentHandle, createReleaseNotesDialog({
        summary: historySummary(history),
        entries: history.entries
      }));
    }

    function dispose() {
      stopWaiting();
    }

    return Object.freeze({ accept, showStartupReleaseNotes, openReleaseNotesHistory, dispose });
  }

  global.__releaseNotesDialogs = Object.freeze({ createReleaseNotesDialogs });
  if (typeof module !== 'undefined' && module.exports) module.exports = global.__releaseNotesDialogs;
})(typeof window !== 'undefined' ? window : globalThis);
