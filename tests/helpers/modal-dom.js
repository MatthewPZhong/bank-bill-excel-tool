'use strict';

// 确定性 DOM 替身：测宿主生命周期和焦点路由；不声称覆盖浏览器布局或辅助技术。
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, properties = {}) {
    const event = {
      type, target: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...properties
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
  listenerCount(type) { return this.listeners.get(type)?.size || 0; }
}

class Element extends Events {
  constructor(document, tagName) {
    super();
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.disabled = false;
    this.hidden = false;
    this._inert = false;
  }
  get parentNode() { return this.parentElement; }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentElement?.isConnected; }
  get inert() { return this._inert; }
  set inert(value) {
    this._inert = !!value;
    if (value) this.attributes.set('inert', '');
    else this.attributes.delete('inert');
  }
  get tabIndex() {
    if (this.hasAttribute('tabindex')) return Number(this.getAttribute('tabindex'));
    return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'IFRAME', 'OBJECT', 'EMBED'].includes(this.tagName)
      || this.hasAttribute('href') || this.getAttribute('contenteditable') === 'true' ? 0 : -1;
  }
  set tabIndex(value) { this.setAttribute('tabindex', value); }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children.at(-1) || null; }
  get childElementCount() { return this.children.length; }
  appendChild(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('找不到子节点');
    this.children.splice(index, 1);
    child.parentElement = null;
    if (child.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    return child;
  }
  remove() { this.parentElement?.removeChild(this); }
  contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'inert') this._inert = true;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'inert') this._inert = false;
  }
  matches(selector) {
    if (selector === ':disabled') return this.disabled;
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
    const parts = selector.match(/^([a-z]+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/i);
    if (!parts) return false;
    return (!parts[1] || this.tagName === parts[1].toUpperCase())
      && (!parts[2] || (this.hasAttribute(parts[2]) && (parts[3] === undefined || this.getAttribute(parts[2]) === parts[3])));
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { return this.isConnected && !this.hidden && this.style.display !== 'none' ? [{}] : []; }
  focus() {
    if (!this.isConnected || this.disabled || this.hidden) return;
    for (let parent = this; parent; parent = parent.parentElement) if (parent.inert) return;
    this.ownerDocument.activeElement = this;
  }
}

function createModalDom() {
  const document = new Events();
  document.createElement = (tagName) => new Element(document, tagName);
  document.body = document.createElement('body');
  document.activeElement = document.body;
  let nextFrame = 0;
  const frames = new Map();
  document.defaultView = {
    AbortController,
    requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle(element) { return element.style; }
  };
  const root = document.createElement('div');
  document.body.appendChild(root);
  return {
    document, root, frames,
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      for (const fn of pending) fn();
    },
    createDialog(properties = {}) {
      const overlay = document.createElement('div');
      const dialog = document.createElement('section');
      const first = document.createElement('button');
      const last = document.createElement('button');
      overlay.appendChild(dialog);
      dialog.append(first, last);
      return { overlay, dialog, first, last, ...properties };
    }
  };
}

module.exports = { createModalDom };
