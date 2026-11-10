'use strict';

// 工作表 XML 热路径专用的严格词法扫描器。
//
// 背景：xlsx-sheet-scanner 原先用 sax@1.6（strict + xmlns）逐字符推进状态机，10 万行级工作表
// 的读取、拆分扫描和写后复核大部分时间都花在这里。本模块按标记块扫描（indexOf + charCode
// 循环），对外事件与 sax strict + xmlns 模式保持一致：
// - opentag 节点形状 {name, attributes, ns, prefix, local, uri, isSelfClosing}，属性为
//   {name, value, prefix, local, uri}；命名空间沿用 sax 的原型链作用域与绑定校验；
// - 实体解析沿用 sax.ENTITIES（scanner 未开启 strictEntities，sax 接受完整 HTML 实体表）；
// - 严格错误的判定点、错误前先吐出已累积文本、错误文案（含 Line/Column/Char）与 sax 对齐；
// - Buffer 输入的编码探测、BOM 处理与 XML 声明编码校验沿用 SAXStream 的规则；
// - position / startTagPosition 与 sax 的 UTF-16 计数一致，供 onCellLexical 审计切片。
// 已知差异：sax 的 64K 缓冲上限只在每次 write 结束时抽查，本模块在未完成的单个标记、注释、
// 处理指令、DOCTYPE 或实体名超过同一上限时确定性报错；文本与 CDATA 同样按 64K 分段吐出。
//
// 可选快路径（handlers.fastPath = { leadCodes, match, apply }）：根元素内遇到 `<` 且下一字符属于
// leadCodes（ASCII）时先调用 match(buf, lt, len, nsScope)。nsScope 是新元素继承的命名空间作用域对象
// （无前缀元素的 URI 为 nsScope[''] || ''，前缀 p 的 URI 为 nsScope[p]；同一作用域对象在多次调用间
// 不变，可按对象身份缓存判定结果）。match 只读，只认当前缓冲区内完整、调用方能证明与逐事件处理
// 等价的标记，返回其结束下标并写入 fastPath.lastTagStart（最后一个标签的 `<` 下标）与
// fastPath.openTagName（null 表示整个元素已闭合；否则为仍处于打开状态的元素名，例如只匹配开标签
// 时）；不认的返回 -1 走通用路径。命中后与通用路径一样先吐出已累积文本，若元素仍打开则按通用
// 路径压入标签栈（不声明命名空间，作用域沿用 nsScope），再调用 apply() 完成语义处理。

const sax = require('sax');

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const MAX_BUFFER_LENGTH = sax.MAX_BUFFER_LENGTH;
const ROOT_NS = { xml: XML_NAMESPACE, xmlns: XMLNS_NAMESPACE };
// 与 sax 相同：实体表通过 Object.create 沿原型链查找。
const ENTITIES = Object.create(sax.ENTITIES);

const NAME_START = /[:_A-Za-zÀ-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�]/;
const NAME_BODY = /[:_A-Za-zÀ-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�·̀-ͯ‿-⁀.\d-]/;

const LT = 60;
const GT = 62;
const AMP = 38;
const SLASH = 47;
const QMARK = 63;
const BANG = 33;
const EQ = 61;
const DQUOTE = 34;
const SQUOTE = 39;
const SEMI = 59;
const HASH = 35;
const NEWLINE = 10;

const S_BEGIN = 0;
const S_BEGIN_WHITESPACE = 1;
const S_TEXT = 2;
const S_CDATA = 3;
const S_DOCTYPE = 4;
const S_DOCTYPE_QUOTED = 5;
const S_DOCTYPE_DTD = 6;
const S_DOCTYPE_DTD_QUOTED = 7;
const S_SWALLOW = 8;

const END_OF_INPUT = -1;

class StrictXmlSyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StrictXmlSyntaxError';
    this.code = 'STRICT_XML_SYNTAX';
  }
}

function isWhitespaceCode(code) {
  return code === 32 || code === 10 || code === 13 || code === 9;
}

function isQuoteCode(code) {
  return code === DQUOTE || code === SQUOTE;
}

function isAsciiNameStart(code) {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 58 || code === 95;
}

function isNameStartCode(code) {
  if (code < 128) return isAsciiNameStart(code);
  return NAME_START.test(String.fromCharCode(code));
}

function isNameBodyCode(code) {
  if (code < 128) {
    return isAsciiNameStart(code) || (code >= 48 && code <= 57) || code === 45 || code === 46;
  }
  return NAME_BODY.test(String.fromCharCode(code));
}

function isEntityStartCode(code) {
  return code === HASH || isNameStartCode(code);
}

function isEntityBodyCode(code) {
  return code === HASH || isNameBodyCode(code);
}

function qname(name, attribute) {
  const index = name.indexOf(':');
  const qualName = index < 0 ? ['', name] : name.split(':');
  let prefix = qualName[0];
  let local = qualName[1];
  if (attribute && name === 'xmlns') {
    prefix = 'xmlns';
    local = '';
  }
  return { prefix, local };
}

// 与 sax parseEntity 一致；无效时返回 null，由调用方按 sax 的位置报错。
function resolveEntity(entity) {
  if (ENTITIES[entity]) return ENTITIES[entity];
  const entityLC = entity.toLowerCase();
  if (ENTITIES[entityLC]) return ENTITIES[entityLC];
  let rest = entityLC;
  let num;
  let numStr = '';
  if (rest.charAt(0) === '#') {
    if (rest.charAt(1) === 'x') {
      rest = rest.slice(2);
      num = parseInt(rest, 16);
      numStr = num.toString(16);
    } else {
      rest = rest.slice(1);
      num = parseInt(rest, 10);
      numStr = num.toString(10);
    }
  }
  rest = rest.replace(/^0+/, '');
  if (Number.isNaN(num) || num === undefined || numStr.toLowerCase() !== rest || num < 0 || num > 0x10ffff) {
    return null;
  }
  return String.fromCodePoint(num);
}

function determineBufferEncoding(data, isEnd) {
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) return 'utf-16le';
    if (data[0] === 0xfe && data[1] === 0xff) return 'utf-16be';
  }
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return 'utf8';
  if (data.length >= 4) {
    if (data[0] === 0x3c && data[1] === 0x00 && data[2] === 0x3f && data[3] === 0x00) return 'utf-16le';
    if (data[0] === 0x00 && data[1] === 0x3c && data[2] === 0x00 && data[3] === 0x3f) return 'utf-16be';
    return 'utf8';
  }
  return isEnd ? 'utf8' : null;
}

function getDeclaredEncoding(body) {
  const match = body && body.match(/(?:^|\s)encoding\s*=\s*(['"])([^'"]+)\1/i);
  return match ? match[2] : null;
}

function normalizeEncodingName(encoding) {
  if (!encoding) return null;
  return encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function encodingsMatch(detectedEncoding, declaredEncoding) {
  const detected = normalizeEncodingName(detectedEncoding);
  const declared = normalizeEncodingName(declaredEncoding);
  if (!detected || !declared) return true;
  if (declared === 'utf16') return detected === 'utf16le' || detected === 'utf16be';
  return detected === declared;
}

function noop() {}

class StrictXmlTokenizer {
  constructor(handlers = {}) {
    this.onOpenTag = handlers.onOpenTag || noop;
    this.onCloseTag = handlers.onCloseTag || noop;
    this.onText = handlers.onText || noop;
    this.onCdata = handlers.onCdata || noop;
    const fastPath = handlers.fastPath || null;
    if (fastPath && (!Array.isArray(fastPath.leadCodes) ||
        !fastPath.leadCodes.every((code) => Number.isInteger(code) && code > 0 && code < 128) ||
        typeof fastPath.match !== 'function' || typeof fastPath.apply !== 'function')) {
      throw new TypeError('StrictXmlTokenizer fastPath 需要 ASCII leadCodes、match 与 apply');
    }
    this.fastPath = fastPath;
    this.fastLeads = new Uint8Array(128);
    if (fastPath) for (const code of fastPath.leadCodes) this.fastLeads[code] = 1;

    this.buf = '';
    this.pos = 0;
    this.base = 0;
    this.newlinesBeforeBase = 0;
    this.lastNewlineBeforeBase = -1;
    this.textScanFrom = 0;
    this.state = S_BEGIN;
    this.textNode = '';
    this.tags = [];
    this.ns = Object.create(ROOT_NS);
    this.sawRoot = false;
    this.closedRoot = false;
    this.doctype = '';
    this.quote = 0;
    this.swallowLength = 0;
    this.encoding = null;
    this.decoder = null;
    this.decoderBuffer = null;
    this.closed = false;
    this.error = null;
    this.position = 0;
    this.startTagPosition = 0;
  }

  write(chunk) {
    if (this.error) throw this.error;
    if (this.closed) throw new Error('StrictXmlTokenizer 已结束，不能继续写入');
    let text;
    if (Buffer.isBuffer(chunk)) {
      text = this._decodeBuffer(chunk, false);
    } else {
      if (this.decoderBuffer) {
        const remaining = this._decodeBuffer(Buffer.alloc(0), true);
        if (remaining) this._feed(remaining);
      }
      text = String(chunk);
    }
    if (text) this._feed(text);
    this.position = this.base + this.pos;
  }

  end() {
    if (this.error) throw this.error;
    if (this.decoderBuffer) {
      const finalChunk = this._decodeBuffer(Buffer.alloc(0), true);
      if (finalChunk) this._feed(finalChunk);
    } else if (this.decoder) {
      const remaining = this.decoder.decode();
      if (remaining) this._feed(remaining);
    }
    this._finish();
  }

  _decodeBuffer(data, isEnd) {
    let input = data;
    if (this.decoderBuffer) {
      input = Buffer.concat([this.decoderBuffer, input]);
      this.decoderBuffer = null;
    }
    if (!this.decoder) {
      const encoding = determineBufferEncoding(input, isEnd);
      if (!encoding) {
        this.decoderBuffer = input;
        return '';
      }
      this.encoding = encoding;
      this.decoder = new TextDecoder(encoding);
    }
    return this.decoder.decode(input, { stream: !isEnd });
  }

  _feed(text) {
    if (this.pos > 0) this._discardConsumed();
    this.buf = this.buf.length === 0 ? text : this.buf + text;
    this._run();
    if (this.textNode.length > MAX_BUFFER_LENGTH) this._flushText();
  }

  _discardConsumed() {
    const { buf, pos } = this;
    let index = buf.indexOf('\n');
    while (index >= 0 && index < pos) {
      this.newlinesBeforeBase += 1;
      this.lastNewlineBeforeBase = this.base + index;
      index = buf.indexOf('\n', index + 1);
    }
    this.buf = buf.slice(pos);
    this.base += pos;
    this.pos = 0;
  }

  _flushText() {
    if (!this.textNode) return;
    const text = this.textNode;
    this.textNode = '';
    this.onText(text);
  }

  // index 为当前缓冲区下标；END_OF_INPUT 表示 sax end() 阶段（Char 为空）。
  _fail(message, index) {
    this._flushText();
    const { buf } = this;
    let line = this.newlinesBeforeBase;
    let lastNewline = this.lastNewlineBeforeBase;
    let charIndex;
    let char = '';
    if (index === END_OF_INPUT) {
      charIndex = buf.length - 1;
    } else {
      charIndex = index;
      char = buf.charAt(index);
    }
    let newline = buf.indexOf('\n');
    while (newline >= 0 && newline <= charIndex) {
      line += 1;
      lastNewline = this.base + newline;
      newline = buf.indexOf('\n', newline + 1);
    }
    // sax 处理到第 k 个字符时：line 为 [0, k] 中换行数，column 为距最近换行（含 k 自身）的字符数。
    const column = this.base + charIndex - lastNewline;
    const error = new StrictXmlSyntaxError(`${message}\nLine: ${line}\nColumn: ${column}\nChar: ${char}`);
    this.error = error;
    throw error;
  }

  _failBufferLength(bufferName) {
    this._fail(`Max buffer length exceeded: ${bufferName}`, END_OF_INPUT);
  }

  _insideRoot() {
    return this.sawRoot && !this.closedRoot;
  }

  // 新开元素继承的命名空间作用域（与 _openTag 的 parentNs 取法一致）。
  _namespaceScope() {
    return this.tags.length > 0 ? this.tags[this.tags.length - 1].ns : this.ns;
  }

  _run() {
    const { buf } = this;
    const len = buf.length;
    let pos = this.pos;
    while (pos < len) {
      const state = this.state;
      if (state === S_TEXT) {
        if (!this._insideRoot()) {
          // 根元素之外只允许空白；sax 会逐字符累积这些空白为文本。
          let index = pos;
          while (index < len) {
            const code = buf.charCodeAt(index);
            if (code === LT) break;
            if (!isWhitespaceCode(code)) {
              this.textNode += buf.slice(pos, index);
              this.pos = index;
              this._fail('Text data outside of root node.', index);
            }
            index += 1;
          }
          this.textNode += buf.slice(pos, index);
          if (index >= len) {
            pos = index;
            break;
          }
          pos = index;
        } else {
          const from = Math.max(pos, this.textScanFrom - this.base);
          const lt = buf.indexOf('<', from);
          if (lt < 0) {
            this.textScanFrom = this.base + len;
            if (len - pos > MAX_BUFFER_LENGTH) {
              pos = this._decodeText(pos, len, true);
              this._flushText();
            }
            break;
          }
          pos = this._decodeText(pos, lt, false);
          const fastPath = this.fastPath;
          const lead = buf.charCodeAt(pos + 1);
          if (fastPath !== null && lead < 128 && this.fastLeads[lead] === 1) {
            const scope = this._namespaceScope();
            const end = fastPath.match(buf, pos, len, scope);
            if (end > pos) {
              this._flushText();
              this.startTagPosition = this.base + fastPath.lastTagStart + 1;
              this.position = this.base + end;
              const openTagName = fastPath.openTagName;
              if (openTagName !== null) this.tags.push({ name: openTagName, ns: scope });
              fastPath.apply();
              pos = end;
              continue;
            }
          }
        }
        this.startTagPosition = this.base + pos + 1;
        const next = this._markup(pos);
        if (next < 0) break;
        pos = next;
        continue;
      }
      if (state === S_BEGIN) {
        this.state = S_BEGIN_WHITESPACE;
        if (buf.charCodeAt(pos) === 0xfeff) pos += 1;
        continue;
      }
      if (state === S_BEGIN_WHITESPACE) {
        const code = buf.charCodeAt(pos);
        if (code === LT) {
          this.startTagPosition = this.base + pos + 1;
          const next = this._markup(pos);
          if (next < 0) break;
          pos = next;
          continue;
        }
        if (isWhitespaceCode(code)) {
          pos += 1;
          continue;
        }
        this.pos = pos;
        this._fail('Non-whitespace before first tag.', pos);
      }
      if (state === S_CDATA) {
        const end = buf.indexOf(']]>', pos);
        if (end < 0) {
          if (len - pos > MAX_BUFFER_LENGTH) {
            const cut = len - 2;
            this._emitCdata(buf.slice(pos, cut));
            pos = cut;
          }
          break;
        }
        this._emitCdata(buf.slice(pos, end));
        this.state = S_TEXT;
        pos = end + 3;
        continue;
      }
      if (state === S_SWALLOW) {
        // sax 在 `<!` 后遇到引号时进入无法退出的 SGML_DECL_QUOTED，后续内容全部吞入。
        this.swallowLength += len - pos;
        pos = len;
        if (this.swallowLength > MAX_BUFFER_LENGTH) {
          this.pos = pos;
          this._failBufferLength('sgmlDecl');
        }
        break;
      }
      pos = this._runDoctype(pos);
      if (pos < 0) {
        pos = -pos - 1;
        break;
      }
    }
    this.pos = pos;
  }

  _emitCdata(content) {
    if (!content) return;
    this._flushText();
    this.onCdata(content);
  }

  // DOCTYPE 极少出现，逐字符复刻 sax 的 DOCTYPE/DTD 状态。返回负数表示等待更多输入。
  _runDoctype(start) {
    const { buf } = this;
    const len = buf.length;
    let pos = start;
    while (pos < len) {
      const code = buf.charCodeAt(pos);
      const char = buf[pos];
      const state = this.state;
      if (state === S_DOCTYPE) {
        if (code === GT) {
          this._flushText();
          this.doctype = true;
          this.state = S_TEXT;
          return pos + 1;
        }
        this.doctype += char;
        if (code === 91) this.state = S_DOCTYPE_DTD;
        else if (isQuoteCode(code)) {
          this.state = S_DOCTYPE_QUOTED;
          this.quote = code;
        }
      } else if (state === S_DOCTYPE_QUOTED) {
        this.doctype += char;
        if (code === this.quote) {
          this.quote = 0;
          this.state = S_DOCTYPE;
        }
      } else if (state === S_DOCTYPE_DTD) {
        if (code === 93) {
          this.doctype += char;
          this.state = S_DOCTYPE;
        } else if (code === LT) {
          this.startTagPosition = this.base + pos + 1;
          const next = this._markup(pos);
          if (next < 0) return -pos - 1;
          return next;
        } else if (isQuoteCode(code)) {
          this.doctype += char;
          this.state = S_DOCTYPE_DTD_QUOTED;
          this.quote = code;
        } else {
          this.doctype += char;
        }
      } else if (state === S_DOCTYPE_DTD_QUOTED) {
        this.doctype += char;
        if (code === this.quote) {
          this.state = S_DOCTYPE_DTD;
          this.quote = 0;
        }
      } else {
        return pos;
      }
      if (typeof this.doctype === 'string' && this.doctype.length > MAX_BUFFER_LENGTH) {
        this.pos = pos + 1;
        this._failBufferLength('doctype');
      }
      pos += 1;
    }
    return -pos - 1;
  }

  // 解码根元素内的文本区间 [start, end)；tail=true 表示区间后尚无终止符，未完成实体留待后续输入。
  _decodeText(start, end, tail) {
    const { buf } = this;
    // indexOf 没有终点参数；先在区间副本上判断，避免每段文本都扫到缓冲区末尾。
    if (start === end) return end;
    const segment = buf.slice(start, end);
    if (segment.indexOf('&') < 0) {
      this.textNode += segment;
      return end;
    }
    let index = start;
    let out = '';
    for (;;) {
      const amp = buf.indexOf('&', index);
      if (amp < 0 || amp >= end) {
        out += buf.slice(index, end);
        this.textNode += out;
        return end;
      }
      out += buf.slice(index, amp);
      const parsed = this._scanEntity(amp, end, tail);
      if (parsed.incomplete) {
        this.textNode += out;
        return amp;
      }
      if (parsed.errorIndex !== undefined) {
        this.textNode += out;
        this._fail(parsed.message, parsed.errorIndex);
      }
      out += parsed.value;
      index = parsed.next;
    }
  }

  // 解析 buf[amp] 处的实体；end 为当前区间终点（其位置字符即 sax 遇到的终止字符）。
  _scanEntity(amp, end, tail) {
    const { buf } = this;
    let index = amp + 1;
    if (index >= end) {
      if (tail) return { incomplete: true };
      return { errorIndex: end, message: 'Invalid character in entity name' };
    }
    let code = buf.charCodeAt(index);
    if (code !== SEMI) {
      if (!isEntityStartCode(code)) {
        return { errorIndex: index, message: 'Invalid character in entity name' };
      }
      index += 1;
      while (index < end && isEntityBodyCode(buf.charCodeAt(index))) index += 1;
      if (index >= end) {
        if (tail) {
          if (end - amp - 1 > MAX_BUFFER_LENGTH) this._failBufferLength('entity');
          return { incomplete: true };
        }
        return { errorIndex: end, message: 'Invalid character in entity name' };
      }
      code = buf.charCodeAt(index);
      if (code !== SEMI) {
        return { errorIndex: index, message: 'Invalid character in entity name' };
      }
    }
    const value = resolveEntity(buf.slice(amp + 1, index));
    if (value === null) return { errorIndex: index, message: 'Invalid character entity' };
    return { value, next: index + 1 };
  }

  // 属性值解码；tail=true 时只检查已到达部分的确定性错误。
  _decodeAttributeValue(start, end, tail) {
    const { buf } = this;
    const segment = buf.slice(start, end);
    if (segment.indexOf('&') < 0) return tail ? null : segment;
    let index = start;
    let out = '';
    for (;;) {
      const amp = buf.indexOf('&', index);
      if (amp < 0 || amp >= end) {
        if (tail) return null;
        return out + buf.slice(index, end);
      }
      out += buf.slice(index, amp);
      const parsed = this._scanEntity(amp, end, tail);
      if (parsed.incomplete) return null;
      if (parsed.errorIndex !== undefined) this._fail(parsed.message, parsed.errorIndex);
      out += parsed.value;
      index = parsed.next;
    }
  }

  // buf[lt] === '<'。返回下一个未处理下标；-1 表示需要更多输入（无副作用或副作用可重入）。
  _markup(lt) {
    const { buf } = this;
    const len = buf.length;
    let index = lt + 1;
    while (index < len && isWhitespaceCode(buf.charCodeAt(index))) index += 1;
    if (index >= len) return -1;
    const code = buf.charCodeAt(index);
    if (code === BANG) return this._sgmlDeclaration(index + 1);
    if (isNameStartCode(code)) return this._openTag(index);
    if (code === SLASH) return this._closeTag(index + 1);
    if (code === QMARK) return this._processingInstruction(index + 1);
    this._fail('Unencoded <', index);
    return -1;
  }

  _sgmlDeclaration(start) {
    const { buf } = this;
    const len = buf.length;
    let declaration = '';
    for (let index = start; index < len; index += 1) {
      const char = buf[index];
      if (declaration + char === '--') return this._comment(index + 1);
      if (this.doctype && this.doctype !== true && declaration) {
        this.doctype += `<!${declaration}${char}`;
        this.state = S_DOCTYPE_DTD;
        return index + 1;
      }
      const upper = (declaration + char).toUpperCase();
      if (upper === '[CDATA[') {
        this._flushText();
        this.state = S_CDATA;
        return index + 1;
      }
      if (upper === 'DOCTYPE') {
        this.state = S_DOCTYPE;
        if (this.doctype || this.sawRoot) {
          this._fail('Inappropriately located doctype declaration', index);
        }
        this.doctype = '';
        return index + 1;
      }
      if (char === '>') {
        this._flushText();
        this.state = S_TEXT;
        return index + 1;
      }
      if (char === '"' || char === "'") {
        this.state = S_SWALLOW;
        this.swallowLength = declaration.length + 1;
        return index + 1;
      }
      declaration += char;
    }
    if (declaration.length > MAX_BUFFER_LENGTH) this._failBufferLength('sgmlDecl');
    return -1;
  }

  _comment(start) {
    const { buf } = this;
    const len = buf.length;
    const end = buf.indexOf('--', start);
    if (end < 0) {
      if (len - start > MAX_BUFFER_LENGTH) this._failBufferLength('comment');
      return -1;
    }
    if (end > start) this._flushText();
    if (end + 2 >= len) return -1;
    if (buf.charCodeAt(end + 2) !== GT) this._fail('Malformed comment', end + 2);
    this.state = this.doctype && this.doctype !== true ? S_DOCTYPE_DTD : S_TEXT;
    return end + 3;
  }

  _processingInstruction(start) {
    const { buf } = this;
    const len = buf.length;
    let name = '';
    let body = '';
    let mode = 0; // 0 name, 1 body, 2 ending
    for (let index = start; index < len; index += 1) {
      const char = buf[index];
      const code = buf.charCodeAt(index);
      if (mode === 0) {
        if (code === QMARK) mode = 2;
        else if (isWhitespaceCode(code)) mode = 1;
        else name += char;
      } else if (mode === 1) {
        if (!body && isWhitespaceCode(code)) continue;
        if (code === QMARK) mode = 2;
        else body += char;
      } else if (code === GT) {
        if (this.encoding && name === 'xml') {
          const declaredEncoding = getDeclaredEncoding(body);
          if (declaredEncoding && !encodingsMatch(this.encoding, declaredEncoding)) {
            this._fail(
              `XML declaration encoding ${declaredEncoding} does not match detected stream encoding ${this.encoding.toUpperCase()}`,
              index
            );
          }
        }
        this._flushText();
        this.state = S_TEXT;
        return index + 1;
      } else {
        body += `?${char}`;
        mode = 1;
      }
    }
    if (name.length > MAX_BUFFER_LENGTH) this._failBufferLength('procInstName');
    if (body.length > MAX_BUFFER_LENGTH) this._failBufferLength('procInstBody');
    return -1;
  }

  _openTag(nameStart) {
    const { buf } = this;
    const len = buf.length;
    let index = nameStart + 1;
    while (index < len && isNameBodyCode(buf.charCodeAt(index))) index += 1;
    if (index >= len) {
      if (index - nameStart > MAX_BUFFER_LENGTH) this._failBufferLength('tagName');
      return -1;
    }
    const name = buf.slice(nameStart, index);
    // sax newTag：标签名结束即吐出此前文本。
    this._flushText();
    const parentNs = this.tags.length > 0 ? this.tags[this.tags.length - 1].ns : this.ns;
    const tag = { name, attributes: {}, ns: parentNs };
    const attributeList = [];
    let code = buf.charCodeAt(index);

    if (code === GT) return this._emitOpenTag(tag, attributeList, false, index);
    if (code !== SLASH) {
      if (!isWhitespaceCode(code)) this._fail('Invalid character in tag name', index);
      index += 1;
    }
    for (;;) {
      // ATTRIB
      while (index < len && isWhitespaceCode(buf.charCodeAt(index))) index += 1;
      if (index >= len) return -1;
      code = buf.charCodeAt(index);
      if (code === GT) return this._emitOpenTag(tag, attributeList, false, index);
      if (code === SLASH) {
        if (index + 1 >= len) return -1;
        if (buf.charCodeAt(index + 1) !== GT) {
          this._fail('Forward-slash in opening tag not followed by >', index + 1);
        }
        return this._emitOpenTag(tag, attributeList, true, index + 1);
      }
      if (!isNameStartCode(code)) this._fail('Invalid attribute name', index);

      // ATTRIB_NAME
      const attributeStart = index;
      index += 1;
      while (index < len && isNameBodyCode(buf.charCodeAt(index))) index += 1;
      if (index >= len) {
        if (index - attributeStart > MAX_BUFFER_LENGTH) this._failBufferLength('attribName');
        return -1;
      }
      const attributeName = buf.slice(attributeStart, index);
      code = buf.charCodeAt(index);
      if (code === EQ) {
        index += 1;
      } else if (code === GT) {
        this._fail('Attribute without value', index);
      } else if (isWhitespaceCode(code)) {
        index += 1;
        while (index < len && isWhitespaceCode(buf.charCodeAt(index))) index += 1;
        if (index >= len) return -1;
        if (buf.charCodeAt(index) !== EQ) this._fail('Attribute without value', index);
        index += 1;
      } else {
        this._fail('Invalid attribute name', index);
      }

      // ATTRIB_VALUE
      while (index < len && isWhitespaceCode(buf.charCodeAt(index))) index += 1;
      if (index >= len) return -1;
      const quote = buf.charCodeAt(index);
      if (!isQuoteCode(quote)) this._fail('Unquoted attribute value', index);
      const valueStart = index + 1;
      const valueEnd = buf.indexOf(quote === DQUOTE ? '"' : "'", valueStart);
      if (valueEnd < 0) {
        this._decodeAttributeValue(valueStart, len, true);
        if (len - valueStart > MAX_BUFFER_LENGTH) this._failBufferLength('attribValue');
        return -1;
      }
      const value = this._decodeAttributeValue(valueStart, valueEnd, false);
      this._attribute(tag, parentNs, attributeList, attributeName, value, valueEnd);
      index = valueEnd + 1;

      // ATTRIB_VALUE_CLOSED
      if (index >= len) return -1;
      code = buf.charCodeAt(index);
      if (isWhitespaceCode(code)) {
        index += 1;
        continue;
      }
      if (code === GT) return this._emitOpenTag(tag, attributeList, false, index);
      if (code === SLASH) {
        if (index + 1 >= len) return -1;
        if (buf.charCodeAt(index + 1) !== GT) {
          this._fail('Forward-slash in opening tag not followed by >', index + 1);
        }
        return this._emitOpenTag(tag, attributeList, true, index + 1);
      }
      if (isNameStartCode(code)) this._fail('No whitespace between attributes', index);
      this._fail('Invalid attribute name', index);
    }
  }

  // sax attrib()：xmlns 模式下其去重检查拿属性名去查 [name, value] 对数组，实际从不命中，
  // 因此重复属性全部保留、后者覆盖前者（含命名空间绑定）。xmlns 绑定在属性出现时生效并校验前缀。
  _attribute(tag, parentNs, attributeList, name, value, index) {
    const { prefix, local } = qname(name, true);
    if (prefix === 'xmlns') {
      if (local === 'xml' && value !== XML_NAMESPACE) {
        this._fail(`xml: prefix must be bound to ${XML_NAMESPACE}\nActual: ${value}`, index);
      } else if (local === 'xmlns' && value !== XMLNS_NAMESPACE) {
        this._fail(`xmlns: prefix must be bound to ${XMLNS_NAMESPACE}\nActual: ${value}`, index);
      } else {
        if (tag.ns === parentNs) tag.ns = Object.create(parentNs);
        tag.ns[local] = value;
      }
    }
    attributeList.push([name, value]);
  }

  _emitOpenTag(tag, attributeList, selfClosing, gtIndex) {
    const qualified = qname(tag.name, false);
    tag.prefix = qualified.prefix;
    tag.local = qualified.local;
    tag.uri = tag.ns[qualified.prefix] || '';
    if (tag.prefix && !tag.uri) {
      this._fail(`Unbound namespace prefix: ${JSON.stringify(tag.name)}`, gtIndex);
    }
    for (let i = 0; i < attributeList.length; i += 1) {
      const name = attributeList[i][0];
      const value = attributeList[i][1];
      const attributeName = qname(name, true);
      const prefix = attributeName.prefix;
      const uri = prefix === '' ? '' : tag.ns[prefix] || '';
      const attribute = { name, value, prefix, local: attributeName.local, uri };
      if (prefix && prefix !== 'xmlns' && !uri) {
        this._fail(`Unbound namespace prefix: ${JSON.stringify(prefix)}`, gtIndex);
      }
      tag.attributes[name] = attribute;
    }
    tag.isSelfClosing = !!selfClosing;
    this.sawRoot = true;
    this.tags.push(tag);
    this.state = S_TEXT;
    this.position = this.base + gtIndex + 1;
    this.onOpenTag(tag);
    if (selfClosing) this._closeMatched(tag.name, gtIndex);
    return gtIndex + 1;
  }

  _closeTag(start) {
    const { buf } = this;
    const len = buf.length;
    let index = start;
    while (index < len && isWhitespaceCode(buf.charCodeAt(index))) index += 1;
    if (index >= len) return -1;
    if (!isNameStartCode(buf.charCodeAt(index))) {
      this._fail('Invalid tagname in closing tag.', index);
    }
    const nameStart = index;
    index += 1;
    while (index < len && isNameBodyCode(buf.charCodeAt(index))) index += 1;
    if (index >= len) {
      if (index - nameStart > MAX_BUFFER_LENGTH) this._failBufferLength('tagName');
      return -1;
    }
    const name = buf.slice(nameStart, index);
    let code = buf.charCodeAt(index);
    if (code !== GT) {
      if (!isWhitespaceCode(code)) this._fail('Invalid tagname in closing tag', index);
      index += 1;
      while (index < len && isWhitespaceCode(buf.charCodeAt(index))) index += 1;
      if (index >= len) return -1;
      code = buf.charCodeAt(index);
      if (code !== GT) this._fail('Invalid characters in closing tag', index);
    }
    this.position = this.base + index + 1;
    this._closeMatched(name, index);
    return index + 1;
  }

  _closeMatched(name, gtIndex) {
    const top = this.tags.length - 1;
    if (top < 0) this._fail(`Unmatched closing tag: ${name}`, gtIndex);
    if (this.tags[top].name !== name) this._fail('Unexpected close tag', gtIndex);
    const tag = this.tags.pop();
    this.state = S_TEXT;
    this._flushText();
    this.onCloseTag(tag.name);
    if (top === 0) this.closedRoot = true;
  }

  _finish() {
    const { buf } = this;
    const len = buf.length;
    let pos = this.pos;
    // TEXT 状态下挂起区要么是不含 `<` 的尾部文本，要么以 `<` 开头的未完成标记。
    if (this.state === S_TEXT && pos < len && this._insideRoot() && buf.charCodeAt(pos) !== LT) {
      // sax 逐字符处理尾部文本：确定性的实体错误先于 end() 报出，未完成实体留给 end() 判定。
      pos = this._decodeText(pos, len, true);
      this.pos = pos;
    }
    if (this.sawRoot && !this.closedRoot) this._fail('Unclosed root tag', END_OF_INPUT);
    const pendingMarkup = pos < len;
    if (pendingMarkup || (this.state !== S_BEGIN && this.state !== S_BEGIN_WHITESPACE && this.state !== S_TEXT)) {
      this._fail('Unexpected end', END_OF_INPUT);
    }
    this._flushText();
    this.closed = true;
    this.position = this.base + len;
  }
}

function createStrictXmlTokenizer(handlers) {
  return new StrictXmlTokenizer(handlers);
}

module.exports = {
  MAX_BUFFER_LENGTH,
  StrictXmlSyntaxError,
  StrictXmlTokenizer,
  createStrictXmlTokenizer
};
