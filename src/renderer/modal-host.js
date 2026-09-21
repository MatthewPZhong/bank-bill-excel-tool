(function exposeModalHost(global) {
  'use strict';

  const FOCUSABLE = 'button, input, select, textarea, a[href], area[href], summary, iframe, object, embed, [tabindex], [contenteditable="true"]';

  function createModalHost({ root, document, reportError = () => {}, resolveFallbackFocus = () => null }) {
    if (!root || !document || typeof root.appendChild !== 'function') {
      throw new TypeError('弹窗宿主需要根节点和 document');
    }
    const view = document.defaultView || global;
    const AbortControllerClass = view.AbortController || global.AbortController;
    const stack = [];
    const records = new Map();
    const usedOverlays = new WeakSet();
    let nextId = 0;
    let changing = false;
    let disposed = false;

    function report(error, phase, record) {
      try { reportError(error, { phase, id: record?.id, owner: record?.owner }); } catch (_) { /* 日志失败不能阻止收尾。 */ }
    }

    function fail(code, message) {
      const error = Object.assign(new Error(message), { code });
      report(error, 'contract');
      throw error;
    }

    function transaction(fn) {
      if (changing) fail('MODAL_REENTRANT', '弹窗检查或切换期间不允许重入宿主');
      if (disposed) fail('MODAL_HOST_DISPOSED', '弹窗宿主已经销毁');
      changing = true;
      try { return fn(); } finally { changing = false; }
    }

    function top() { return stack[stack.length - 1]; }
    function getRecord(handle) {
      const record = records.get(handle?.id);
      return record?.handle === handle ? record : null;
    }
    function getHandle(element) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (element && stack[i].overlay.contains(element)) return stack[i].handle;
      }
      return null;
    }

    function createScope() {
      const controller = new AbortControllerClass();
      const cleanups = [];
      let ended = false;
      const run = (cleanup) => {
        try { cleanup(); } catch (error) { report(error, 'cleanup'); }
      };
      return {
        public: Object.freeze({
          signal: controller.signal,
          onDispose(cleanup) {
            if (typeof cleanup !== 'function') throw new TypeError('弹窗清理必须是函数');
            if (ended) run(cleanup);
            else cleanups.push(cleanup);
          }
        }),
        dispose() {
          if (ended) return;
          ended = true;
          try { controller.abort(); } catch (error) { report(error, 'abort'); }
          while (cleanups.length) run(cleanups.pop());
        }
      };
    }

    function setAttributeBack(element, name, value) {
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }

    function restoreLayer(record) {
      if (!record.suspended) return;
      record.overlay.inert = record.suspended.inert;
      setAttributeBack(record.overlay, 'inert', record.suspended.inertAttribute);
      setAttributeBack(record.overlay, 'aria-hidden', record.suspended.ariaHidden);
      record.suspended = null;
    }

    function updateLayers() {
      for (const record of stack) {
        if (record === top()) restoreLayer(record);
        else if (!record.suspended) {
          record.suspended = {
            inert: record.overlay.inert,
            inertAttribute: record.overlay.getAttribute('inert'),
            ariaHidden: record.overlay.getAttribute('aria-hidden')
          };
          record.overlay.inert = true;
          record.overlay.setAttribute('inert', '');
          record.overlay.setAttribute('aria-hidden', 'true');
        }
      }
    }

    function interactive(element) {
      if (!element?.isConnected || typeof element.focus !== 'function' || element.disabled) return false;
      if (element.matches?.(':disabled')) return false;
      for (let node = element; node && node !== document; node = node.parentElement) {
        if (node.hidden || node.inert || node.getAttribute?.('aria-hidden') === 'true') return false;
        const style = view.getComputedStyle?.(node);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
      }
      return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
    }

    function focusables(record) {
      return Array.from(record.overlay.querySelectorAll(FOCUSABLE))
        .filter((element) => interactive(element) && element.tabIndex >= 0)
        .sort((left, right) => {
          const a = left.tabIndex > 0 ? left.tabIndex : Infinity;
          const b = right.tabIndex > 0 ? right.tabIndex : Infinity;
          return a === b ? 0 : a - b;
        });
    }

    function tryFocus(element) {
      if (!interactive(element)) return false;
      try { element.focus({ preventScroll: true }); } catch (error) { report(error, 'focus'); return false; }
      return document.activeElement === element;
    }

    function focusDefault(record) {
      if (record?.state !== 'mounted' || record !== top()) return;
      let preferred;
      try {
        preferred = typeof record.descriptor.initialFocus === 'function'
          ? record.descriptor.initialFocus() : record.descriptor.initialFocus;
      } catch (error) { report(error, 'initial-focus', record); }
      if (preferred && record.overlay.contains(preferred) && tryFocus(preferred)) return;
      for (const element of focusables(record)) if (tryFocus(element)) return;
      if (!record.dialog.hasAttribute('tabindex')) {
        record.temporaryTabIndex = true;
        record.dialog.setAttribute('tabindex', '-1');
      }
      tryFocus(record.dialog);
    }

    function cancelFocus(record) {
      if (record.focusFrame === null) return;
      if (typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(record.focusFrame);
      record.focusFrame = null;
    }

    function scheduleFocus(record) {
      // 同步切换先收回旧层焦点；帧回调只处理仍存活的栈顶。
      focusDefault(record);
      if (typeof view.requestAnimationFrame !== 'function') return;
      record.focusFrame = view.requestAnimationFrame(() => {
        record.focusFrame = null;
        if (record.state === 'mounted' && record === top() && !record.overlay.contains(document.activeElement)) focusDefault(record);
      });
    }

    function restoreFocus(element) {
      const current = top();
      if (current) {
        if (current.overlay.contains(element) && tryFocus(element)) return;
        focusDefault(current);
        return;
      }
      if (tryFocus(element)) return;
      try { tryFocus(resolveFallbackFocus()); } catch (error) { report(error, 'fallback-focus'); }
    }

    function outcome(value, defaultReason = 'cancel') {
      if (!value) return { status: 'cancelled', reason: defaultReason };
      if (value.status === 'submitted') return { status: 'submitted', value: value.value };
      const reasons = ['cancel', 'escape', 'backdrop', 'replaced', 'parent-closed', 'navigation', 'disposed'];
      if (value.status !== 'cancelled' || !reasons.includes(value.reason)) {
        fail('MODAL_OUTCOME_INVALID', '弹窗结果需要明确的提交或取消原因');
      }
      return { status: 'cancelled', reason: value.reason };
    }

    function preflight(targets, reason) {
      for (const record of [...targets].reverse()) {
        try {
          const result = record.descriptor.canClose ? record.descriptor.canClose(reason) : true;
          if (result && typeof result.then === 'function') {
            // 捕获错误的 async canClose，既不 await 也不遗留未处理 rejection。
            Promise.resolve(result).catch((error) => report(error, 'can-close', record));
            throw Object.assign(new TypeError('canClose 必须同步返回 boolean'), { code: 'MODAL_CLOSE_INVALID' });
          }
          if (typeof result !== 'boolean') throw Object.assign(new TypeError('canClose 必须返回 boolean'), { code: 'MODAL_CLOSE_INVALID' });
          if (!result) return { status: 'blocked', by: record.id };
        } catch (error) {
          report(error, 'can-close', record);
          return { status: 'blocked', by: record.id };
        }
      }
      return null;
    }

    function construct(factory, owner, returnFocus) {
      const scope = createScope();
      try {
        if (typeof factory !== 'function') throw new TypeError('弹窗工厂必须是函数');
        const descriptor = factory(scope.public);
        const overlay = descriptor?.overlay;
        const dialog = descriptor?.dialog;
        if (!overlay || !dialog || typeof overlay.contains !== 'function' || !overlay.contains(dialog)) {
          throw Object.assign(new TypeError('弹窗工厂必须返回包含 dialog 的 overlay'), { code: 'MODAL_FACTORY_INVALID' });
        }
        if (overlay.isConnected || usedOverlays.has(overlay)) {
          throw Object.assign(new Error('弹窗工厂必须创建未挂载且未使用的新节点'), { code: 'MODAL_NODE_REUSED' });
        }
        if (descriptor.canClose !== undefined && typeof descriptor.canClose !== 'function') throw new TypeError('canClose 必须是函数');
        let resolveClosed;
        const closed = new Promise((resolve) => { resolveClosed = resolve; });
        const record = {
          id: `modal-${++nextId}`, owner, descriptor, overlay, dialog, scope, resolveClosed,
          state: 'constructed', returnFocus, focusFrame: null, suspended: null, temporaryTabIndex: false
        };
        record.handle = Object.freeze({
          id: record.id, owner, signal: scope.public.signal, closed,
          close: (result) => closeRecord(record, result, false),
          dispose: () => closeRecord(record, { status: 'cancelled', reason: 'disposed' }, true),
          isOpen: () => record.state === 'mounted',
          isTop: () => record.state === 'mounted' && record === top()
        });
        return record;
      } catch (error) {
        scope.dispose();
        report(error, 'factory');
        throw error;
      }
    }

    function finishRecords(targets, getOutcome) {
      // 先同时标记，清理触发的同步事件不能再次进入任何待销毁层。
      for (const record of targets) record.state = 'closing';
      for (const record of [...targets].reverse()) {
        try {
          cancelFocus(record);
          record.scope.dispose();
          restoreLayer(record);
          if (record.temporaryTabIndex) record.dialog.removeAttribute('tabindex');
        } catch (error) { report(error, 'cleanup', record); }
        finally {
          try { record.overlay.remove(); } catch (error) { report(error, 'remove', record); }
          const index = stack.indexOf(record);
          if (index !== -1) stack.splice(index, 1);
          records.delete(record.id);
          record.state = 'closed';
          record.resolveClosed(getOutcome(record));
        }
      }
    }

    function mount(record) {
      const onBackdrop = (event) => {
        if (record === top() && event.target === record.overlay && record.descriptor.dismiss?.backdrop === true) {
          record.handle.close({ status: 'cancelled', reason: 'backdrop' });
        }
      };
      record.overlay.addEventListener('click', onBackdrop);
      record.scope.public.onDispose(() => record.overlay.removeEventListener('click', onBackdrop));
      try {
        root.appendChild(record.overlay);
        usedOverlays.add(record.overlay);
        record.state = 'mounted';
        records.set(record.id, record);
        stack.push(record);
        updateLayers();
        scheduleFocus(record);
      } catch (error) {
        finishRecords([record], () => ({ status: 'cancelled', reason: 'disposed' }));
        updateLayers();
        report(error, 'mount', record);
        throw error;
      }
      return { status: 'opened', handle: record.handle };
    }

    function onMounted(result) {
      if (result.status !== 'opened') return result;
      const record = getRecord(result.handle);
      if (!record || typeof record.descriptor.onMount !== 'function') return result;
      try {
        const pending = record.descriptor.onMount(record.handle);
        if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch((error) => report(error, 'on-mount', record));
      } catch (error) { report(error, 'on-mount', record); }
      return result;
    }

    function replaceRange(index, factory, owner) {
      const targets = stack.slice(index);
      const blocked = preflight(targets, 'replaced');
      if (blocked) return blocked;
      const returnFocus = targets.length ? targets[0].returnFocus : document.activeElement;
      const record = construct(factory, owner, returnFocus);
      finishRecords(targets, () => ({ status: 'cancelled', reason: 'replaced' }));
      return mount(record);
    }

    function closeRecord(record, value, force) {
      if (record.state === 'closed' && !changing) return { status: 'already-closed' };
      return transaction(() => {
        if (record.state !== 'mounted') return { status: 'already-closed' };
        const result = outcome(value);
        const targets = stack.slice(stack.indexOf(record));
        const blocked = force ? null : preflight(targets, result.reason || 'submitted');
        if (blocked) return blocked;
        finishRecords(targets, (target) => target === record ? result : {
          status: 'cancelled', reason: force ? 'disposed' : 'parent-closed'
        });
        updateLayers();
        restoreFocus(record.returnFocus);
        return { status: 'closed' };
      });
    }

    function keydown(event) {
      const record = top();
      if (!record || record.state !== 'mounted') return;
      if (event.key === 'Escape' && record.descriptor.dismiss?.escape === true) {
        event.preventDefault();
        event.stopPropagation();
        record.handle.close({ status: 'cancelled', reason: 'escape' });
      } else if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const items = focusables(record);
        if (!items.length) { focusDefault(record); return; }
        const current = items.indexOf(document.activeElement);
        const index = current < 0 ? (event.shiftKey ? items.length - 1 : 0)
          : (current + (event.shiftKey ? -1 : 1) + items.length) % items.length;
        tryFocus(items[index]);
      }
    }

    document.addEventListener('keydown', keydown, true);
    return Object.freeze({
      openRoot: (factory, { owner = 'application' } = {}) => onMounted(transaction(() => replaceRange(0, factory, owner))),
      push(parent, factory, options = {}) {
        return onMounted(transaction(() => {
          const record = getRecord(parent);
          if (!record || record !== top()) fail('MODAL_PARENT_INVALID', '子弹窗只能从当前打开的栈顶创建');
          if (options.owner !== undefined && options.owner !== record.owner) fail('MODAL_OWNER_INVALID', '子弹窗必须继承父层 owner');
          return mount(construct(factory, record.owner, document.activeElement));
        }));
      },
      replace(handle, factory) {
        return onMounted(transaction(() => {
          const record = getRecord(handle);
          if (!record) fail('MODAL_PARENT_INVALID', '不能替换已经关闭或不属于宿主的弹窗');
          return replaceRange(stack.indexOf(record), factory, record.owner);
        }));
      },
      closeTop(value) {
        if (changing) fail('MODAL_REENTRANT', '弹窗检查或切换期间不允许重入宿主');
        return top() ? top().handle.close(value) : { status: 'already-closed' };
      },
      closeOwner(owner, reason = 'navigation') {
        return transaction(() => {
          const index = stack.findIndex((record) => record.owner === owner);
          if (index < 0) return { status: 'closed' };
          const result = outcome({ status: 'cancelled', reason });
          const targets = stack.slice(index);
          const blocked = preflight(targets, result.reason);
          if (blocked) return blocked;
          const returnFocus = targets[0].returnFocus;
          finishRecords(targets, () => result);
          updateLayers();
          restoreFocus(returnFocus);
          return { status: 'closed' };
        });
      },
      dispose() {
        if (changing) fail('MODAL_REENTRANT', '弹窗检查或切换期间不允许重入宿主');
        if (disposed) return;
        transaction(() => {
          disposed = true;
          try { finishRecords([...stack], () => ({ status: 'cancelled', reason: 'disposed' })); }
          finally { document.removeEventListener('keydown', keydown, true); }
        });
      },
      getHandle,
      getTop: () => top()?.handle || null
    });
  }

  const exported = Object.freeze({ createModalHost });
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (global) global.__modalHost = exported;
})(typeof window !== 'undefined' ? window : globalThis);
