'use strict';

// 只读取 UA shadow DOM 和布局；不聚焦、不改值、不改样式。
async function inspectNativeTimeLayout(webContents) {
  const report = {
    status: 'NOT_RUN',
    capturedAt: new Date().toISOString(),
    scope: '原生时间字段几何裁切取证；不替代截图、字形或遮挡验收',
    toleranceCssPx: 0.5,
    inputs: [],
    errors: [],
  };
  let attachedHere = false;
  const debug = webContents && webContents.debugger;
  const objectGroup = `native-time-layout-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const send = (method, params = {}) => debug.sendCommand(method, params);
  const attrs = (node) => Object.fromEntries(
    Array.from({ length: (node.attributes || []).length / 2 }, (_, i) =>
      [node.attributes[i * 2], node.attributes[i * 2 + 1]]),
  );
  const validRect = (r) => r && ['left', 'top', 'right', 'bottom', 'width', 'height']
    .every((key) => Number.isFinite(r[key]));
  const inside = (r, boundary, x = true, y = true) =>
    (!x || (r.left >= boundary.left - 0.5 && r.right <= boundary.right + 0.5)) &&
    (!y || (r.top >= boundary.top - 0.5 && r.bottom <= boundary.bottom + 0.5));
  const measureFunction = function (cdpAttributes) {
    const rect = (r) => ({ left: r.left, top: r.top, right: r.right,
      bottom: r.bottom, width: r.width, height: r.height });
    const box = this.getBoundingClientRect();
    const win = this.ownerDocument.defaultView;
    const css = win.getComputedStyle(this);
    const sx = this.offsetWidth ? box.width / this.offsetWidth : 1;
    const sy = this.offsetHeight ? box.height / this.offsetHeight : 1;
    // client 区域排除边框和滚动条；缩放统一到 viewport CSS 坐标。
    const left = box.left + this.clientLeft * sx;
    const top = box.top + this.clientTop * sy;
    const clipRect = { left, top, right: left + this.clientWidth * sx,
      bottom: top + this.clientHeight * sy,
      width: this.clientWidth * sx, height: this.clientHeight * sy };
    const pseudo = this.getAttribute('pseudo') || cdpAttributes.pseudo || '';
    const isField = /^-webkit-datetime-edit-(?:.+-field|text)$/.test(pseudo);
    const textRects = [];
    if (isField) {
      const walker = this.ownerDocument.createTreeWalker(this, 4);
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (!textNode.nodeValue) continue;
        const range = this.ownerDocument.createRange();
        range.selectNodeContents(textNode);
        for (const item of range.getClientRects()) textRects.push(rect(item));
      }
    }
    let axisAlignedTransform = css.transform === 'none';
    if (!axisAlignedTransform) {
      try {
        const matrix = new win.DOMMatrixReadOnly(css.transform);
        axisAlignedTransform = matrix.is2D && matrix.a > 0 && matrix.d > 0 &&
          matrix.b === 0 && matrix.c === 0;
      } catch { /* 未解析的变换不能证明完整。 */ }
    }
    return {
      connected: this.isConnected,
      tag: this.tagName,
      pseudo,
      value: typeof this.value === 'string' ? this.value : null,
      text: isField ? this.textContent : null,
      datetimeformat: this.getAttribute('datetimeformat') || cdpAttributes.datetimeformat || null,
      rect: rect(box), clipRect, textRects,
      clientWidth: this.clientWidth, scrollWidth: this.scrollWidth,
      clientHeight: this.clientHeight, scrollHeight: this.scrollHeight,
      style: { display: css.display, visibility: css.visibility, opacity: css.opacity,
        contentVisibility: css.contentVisibility,
        overflowX: css.overflowX, overflowY: css.overflowY, direction: css.direction,
        transform: css.transform, axisAlignedTransform, clipPath: css.clipPath, clip: css.clip,
        maskImage: css.maskImage, contain: css.contain,
        overflowClipMargin: css.overflowClipMargin },
      viewport: { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight,
        width: win.innerWidth, height: win.innerHeight },
      devicePixelRatio: win.devicePixelRatio,
    };
  };
  try {
    if (!debug || webContents.isDestroyed()) throw new Error('webContents/debugger 不可用');
    if (!debug.isAttached()) {
      debug.attach('1.3');
      attachedHere = true;
    }
    report.attachedHere = attachedHere;
    const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
    const parents = new Map();
    const nodes = [];
    function walk(node, parent) {
      nodes.push(node);
      if (parent) parents.set(node.nodeId, parent);
      for (const child of [...(node.children || []), ...(node.shadowRoots || []),
        ...(node.pseudoElements || [])]) walk(child, node);
    }
    walk(root, null);
    const cache = new Map();
    async function measure(node, fresh = false) {
      if (!fresh && cache.has(node.nodeId)) return cache.get(node.nodeId);
      const resolved = await send('DOM.resolveNode', { nodeId: node.nodeId, objectGroup });
      const objectId = resolved.object && resolved.object.objectId;
      if (!objectId) throw new Error(`节点 ${node.nodeId} 没有 Runtime objectId`);
      const result = await send('Runtime.callFunctionOn', {
        objectId, functionDeclaration: measureFunction.toString(), returnByValue: true,
        silent: true, arguments: [{ value: attrs(node) }],
      });
      if (result.exceptionDetails || !result.result || !result.result.value) {
        throw new Error(`节点 ${node.nodeId} 布局读取失败: ${JSON.stringify(result.exceptionDetails || result.result)}`);
      }
      const value = { nodeId: node.nodeId, backendNodeId: node.backendNodeId,
        attributes: attrs(node), ...result.result.value };
      if (!validRect(value.rect) || !validRect(value.clipRect)) {
        throw new Error(`节点 ${node.nodeId} 返回无效尺寸`);
      }
      cache.set(node.nodeId, value);
      return value;
    }
    for (const role of ['dark-mode-start', 'dark-mode-end']) {
      const input = { role, status: 'NOT_RUN', missing: [], violations: [], fields: [] };
      report.inputs.push(input);
      try {
        const matches = nodes.filter((node) => attrs(node)['data-role'] === role);
        if (matches.length !== 1) {
          input.missing.push(`期望唯一输入，实际 ${matches.length} 个`);
          continue;
        }
        const host = matches[0];
        input.host = await measure(host);
        input.value = input.host.value;
        if (attrs(host).type !== 'time') input.missing.push('输入不是 type=time');
        const roots = (host.shadowRoots || []).filter((n) => n.shadowRootType === 'user-agent');
        if (roots.length !== 1) {
          input.missing.push(`期望一个 UA shadow root，实际 ${roots.length} 个`);
          continue;
        }
        const internal = [];
        function collect(node) {
          internal.push(node);
          for (const child of node.children || []) collect(child);
        }
        collect(roots[0]);
        async function one(pseudo) {
          const found = internal.filter((n) => attrs(n).pseudo === pseudo);
          if (found.length !== 1) {
            input.missing.push(`${pseudo}：期望唯一，实际 ${found.length}`);
            return null;
          }
          return measure(found[0]);
        }
        input.edit = await one('-webkit-datetime-edit');
        input.wrapper = await one('-webkit-datetime-edit-fields-wrapper');
        input.clock = await one('-webkit-calendar-picker-indicator');
        input.format = input.edit && input.edit.datetimeformat;
        if (!input.format) input.missing.push('缺少 datetimeformat');
        const fieldNodes = internal.filter((n) =>
          /^-webkit-datetime-edit-(?:.+-field|text)$/.test(attrs(n).pseudo || ''));
        const expected = ['hour', 'minute'];
        if (/[abB]/.test((input.format || '').replace(/'[^']*'/g, ''))) expected.push('ampm');
        for (const field of expected) {
          if (fieldNodes.filter((n) => attrs(n).pseudo === `-webkit-datetime-edit-${field}-field`).length !== 1) {
            input.missing.push(`缺少唯一 ${field} 字段`);
          }
        }
        const paintEnabled = (item) => item && item.connected &&
          item.style.display !== 'none' && item.style.visibility === 'visible' &&
          item.style.contentVisibility !== 'hidden' && Number(item.style.opacity) > 0;
        const visible = (item) => paintEnabled(item) &&
          item.rect.width > 0 && item.rect.height > 0;
        if (!visible(input.host)) input.missing.push('输入不可见或已脱离文档');
        if (!visible(input.clock)) input.missing.push('时钟按钮不可见/尺寸不可用');
        else if (!inside(input.clock.rect, input.host.clipRect)) {
          input.violations.push('时钟按钮超出输入 client 区域');
        }
        const clipValues = new Set(['hidden', 'clip', 'scroll', 'auto', 'overlay']);
        for (const fieldNode of fieldNodes) {
          const field = await measure(fieldNode);
          field.visible = visible(field);
          field.ancestors = [];
          field.violations = [];
          input.fields.push(field);
          let parent = parents.get(fieldNode.nodeId);
          while (parent) {
            if (parent.nodeType === 1) field.ancestors.push(await measure(parent));
            parent = parents.get(parent.nodeId);
          }
          // fixed 后代可见时，普通 overflow:visible 祖先仍可为零高。
          // 祖先只查绘制状态；所有 overflow 裁切仍在下方逐项检查。
          if (!field.visible || field.ancestors.some((n) => !paintEnabled(n))) {
            input.missing.push(`${field.pseudo} 不可见或祖先不可见`);
            continue;
          }
          if (/-field$/.test(field.pseudo) && (!field.text || field.textRects.length === 0)) {
            input.missing.push(`${field.pseudo} 缺少实际文本或文字尺寸`);
            continue;
          }
          const boundaries = [
            { name: 'input-client', rect: input.host.clipRect, x: true, y: true },
            { name: 'viewport', rect: input.host.viewport, x: true, y: true },
          ];
          for (const ancestor of [field, ...field.ancestors]) {
            const style = ancestor.style;
            const x = clipValues.has(style.overflowX);
            const y = clipValues.has(style.overflowY);
            if (x || y) boundaries.push({ name: ancestor.pseudo || `node:${ancestor.nodeId}`,
              rect: ancestor.clipRect, x, y });
            if ((style.clipPath && style.clipPath !== 'none') ||
                (style.maskImage && style.maskImage !== 'none') ||
                (style.clip && style.clip !== 'auto') || /paint|strict|content/.test(style.contain)) {
              input.missing.push(`node:${ancestor.nodeId} 存在未解析的非 overflow 裁切`);
            }
            if (!style.axisAlignedTransform) {
              input.missing.push(`node:${ancestor.nodeId} 存在 transform，轴对齐边界不足以证明完整`);
            }
          }
          field.clipBoundaries = boundaries;
          const boxes = [field.rect, ...field.textRects];
          for (const boundary of boundaries) {
            if (!validRect(boundary.rect)) {
              input.missing.push(`${field.pseudo} 的 ${boundary.name} 裁切尺寸缺失`);
            } else if (boxes.some((r) => !inside(r, boundary.rect, boundary.x, boundary.y))) {
              field.violations.push(`字段/文字超出 ${boundary.name}`);
            }
          }
          if (visible(input.clock)) {
            const rtl = input.host.style.direction === 'rtl';
            field.beforeClock = boxes.every((r) => rtl
              ? r.left >= input.clock.rect.right - 0.5
              : r.right <= input.clock.rect.left + 0.5);
            if (!field.beforeClock) field.violations.push('字段/文字侵入时钟区域');
          } else field.beforeClock = null;
          field.fullyContained = field.violations.length === 0;
          input.violations.push(...field.violations.map((reason) => `${field.pseudo}: ${reason}`));
        }
        if (!input.fields.length) input.missing.push('未发现任何原生时间字段');
        const after = await measure(host, true);
        input.after = after;
        if (after.value !== input.value || !after.connected ||
            ['left', 'top', 'width', 'height'].some((k) => Math.abs(after.rect[k] - input.host.rect[k]) > 0.5)) {
          input.missing.push('采样期间输入值或布局变化，需稳定后重采');
        }
        input.missing = [...new Set(input.missing)];
        input.allVisibleFieldsComplete = input.missing.length ? null : input.violations.length === 0;
        input.status = input.violations.length ? 'FAIL' : input.missing.length ? 'NOT_RUN' : 'PASS';
      } catch (error) {
        input.status = 'ERROR';
        input.error = String(error && error.stack || error);
      }
    }
    report.status = ['ERROR', 'FAIL', 'NOT_RUN'].find((status) =>
      report.inputs.some((input) => input.status === status)) || 'PASS';
  } catch (error) {
    report.status = 'ERROR';
    report.errors.push(String(error && error.stack || error));
  } finally {
    if (debug && debug.isAttached()) {
      try { await send('Runtime.releaseObjectGroup', { objectGroup }); }
      catch (error) { report.errors.push(`releaseObjectGroup: ${error.message}`); }
      if (attachedHere) {
        try { debug.detach(); }
        catch (error) { report.errors.push(`detach: ${error.message}`); }
      }
    }
    if (report.errors.length) report.status = 'ERROR';
  }
  return report;
}

module.exports = { inspectNativeTimeLayout };
