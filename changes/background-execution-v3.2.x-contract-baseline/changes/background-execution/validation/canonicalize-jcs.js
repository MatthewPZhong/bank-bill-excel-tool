'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { types: utilTypes } = require('node:util');

class JcsDomainError extends TypeError {
  constructor(code, path, message) {
    super(message);
    this.name = 'JcsDomainError';
    this.code = code;
    this.path = path;
  }
}

function pointer(path, key) {
  return `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function parseJsonLossless(text) {
  let index = 0;

  function fail(code, path, message) {
    throw new JcsDomainError(code, path || '/', `${message} at byte offset ${index}`);
  }

  function skipWhitespace() {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  }

  function parseString(path) {
    if (text[index] !== '"') fail('JCS_JSON_SYNTAX', path, 'Expected string');
    index += 1;
    let value = '';
    while (index < text.length) {
      const char = text[index];
      index += 1;
      if (char === '"') return value;
      if (char === '\\') {
        if (index >= text.length) fail('JCS_JSON_SYNTAX', path, 'Truncated escape');
        const escape = text[index];
        index += 1;
        const simple = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t'
        };
        if (Object.prototype.hasOwnProperty.call(simple, escape)) {
          value += simple[escape];
          continue;
        }
        if (escape !== 'u') fail('JCS_JSON_SYNTAX', path, 'Invalid escape');
        const digits = text.slice(index, index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
          fail('JCS_JSON_SYNTAX', path, 'Invalid Unicode escape');
        }
        value += String.fromCharCode(Number.parseInt(digits, 16));
        index += 4;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) {
        fail('JCS_JSON_SYNTAX', path, 'Unescaped control character');
      }
      value += char;
    }
    fail('JCS_JSON_SYNTAX', path, 'Unterminated string');
  }

  function parseNumber(path) {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(index)
    );
    if (!match) fail('JCS_JSON_SYNTAX', path, 'Invalid number');
    const token = match[0];
    index += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) {
      fail('JCS_NON_FINITE_NUMBER', path, 'JSON number is outside finite IEEE-754');
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail('JCS_UNSAFE_INTEGER', path, 'Integer is outside the safe IEEE-754 range');
    }
    return value;
  }

  function parseArray(path) {
    index += 1;
    const value = [];
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return value;
    }
    let itemIndex = 0;
    while (index < text.length) {
      value.push(parseValue(pointer(path, itemIndex)));
      itemIndex += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return value;
      }
      if (text[index] !== ',') fail('JCS_JSON_SYNTAX', path, 'Expected comma');
      index += 1;
      skipWhitespace();
    }
    fail('JCS_JSON_SYNTAX', path, 'Unterminated array');
  }

  function parseObject(path) {
    index += 1;
    const value = Object.create(null);
    const keys = new Set();
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return value;
    }
    while (index < text.length) {
      const key = parseString(path);
      if (keys.has(key)) {
        fail('JCS_DUPLICATE_KEY', pointer(path, key), 'Duplicate object key');
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') fail('JCS_JSON_SYNTAX', path, 'Expected colon');
      index += 1;
      skipWhitespace();
      value[key] = parseValue(pointer(path, key));
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return value;
      }
      if (text[index] !== ',') fail('JCS_JSON_SYNTAX', path, 'Expected comma');
      index += 1;
      skipWhitespace();
    }
    fail('JCS_JSON_SYNTAX', path, 'Unterminated object');
  }

  function parseValue(path) {
    skipWhitespace();
    const char = text[index];
    if (char === '{') return parseObject(path);
    if (char === '[') return parseArray(path);
    if (char === '"') return parseString(path);
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber(path);
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    fail('JCS_JSON_SYNTAX', path, 'Unexpected token');
  }

  if (typeof text !== 'string') {
    throw new JcsDomainError('JCS_JSON_SYNTAX', '/', 'Raw JSON input must be a string');
  }
  const value = parseValue('');
  skipWhitespace();
  if (index !== text.length) fail('JCS_JSON_SYNTAX', '/', 'Trailing data');
  return value;
}

function assertUnicodeScalarString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new JcsDomainError('JCS_INVALID_SURROGATE', path, 'Unpaired high surrogate');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new JcsDomainError('JCS_INVALID_SURROGATE', path, 'Unpaired low surrogate');
    }
  }
}

function descriptorInChain(value, key) {
  let current = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function assertNoToJson(value, path) {
  if (descriptorInChain(value, 'toJSON')) {
    throw new JcsDomainError('JCS_TO_JSON_FORBIDDEN', path, 'toJSON is outside the JCS input domain');
  }
}

function assertDataDescriptor(descriptor, path) {
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new JcsDomainError('JCS_ACCESSOR_FORBIDDEN', path, 'Accessors are outside the JCS input domain');
  }
  if (descriptor.enumerable !== true) {
    throw new JcsDomainError('JCS_NON_ENUMERABLE_FORBIDDEN', path, 'Non-enumerable data properties are outside the JCS input domain');
  }
  return descriptor.value;
}

function assertJcsDomain(value, path = '', active = new Set()) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, path || '/');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JcsDomainError('JCS_NON_FINITE_NUMBER', path || '/', 'JCS numbers must be finite IEEE-754 doubles');
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new JcsDomainError('JCS_UNSAFE_INTEGER', path || '/', 'JCS integers must be IEEE-754 safe integers');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new JcsDomainError('JCS_UNSUPPORTED_TYPE', path || '/', `Unsupported JCS type: ${typeof value}`);
  }
  if (utilTypes.isProxy(value)) {
    throw new JcsDomainError('JCS_PROXY_FORBIDDEN', path || '/', 'Proxy values are outside the JCS input domain');
  }
  if (active.has(value)) {
    throw new JcsDomainError('JCS_CYCLE_FORBIDDEN', path || '/', 'Cyclic values are outside the JCS input domain');
  }
  active.add(value);
  try {
    assertNoToJson(value, path || '/');
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new JcsDomainError('JCS_ARRAY_PROTOTYPE_INVALID', path || '/', 'Array prototype must be Array.prototype');
      }
      const ownKeys = Reflect.ownKeys(value);
      const expectedKeys = Array.from({ length: value.length }, (_unused, index) => String(index));
      expectedKeys.push('length');
      if (ownKeys.length !== expectedKeys.length ||
          ownKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new JcsDomainError('JCS_ARRAY_SHAPE_INVALID', path || '/', 'Arrays must be dense and have no extra or symbol keys');
      }
      for (let index = 0; index < value.length; index += 1) {
        const itemPath = pointer(path, index);
        const item = assertDataDescriptor(
          Object.getOwnPropertyDescriptor(value, String(index)),
          itemPath
        );
        assertJcsDomain(item, itemPath, active);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JcsDomainError('JCS_PLAIN_OBJECT_REQUIRED', path || '/', 'Objects must have Object.prototype or null prototype');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new JcsDomainError('JCS_SYMBOL_KEY_FORBIDDEN', path || '/', 'Symbol keys are outside the JCS input domain');
      }
      assertUnicodeScalarString(key, pointer(path, key));
      const childPath = pointer(path, key);
      const child = assertDataDescriptor(Object.getOwnPropertyDescriptor(value, key), childPath);
      assertJcsDomain(child, childPath, active);
    }
  } finally {
    active.delete(value);
  }
}

function canonicalizeJcs(value) {
  assertJcsDomain(value);
  function serialize(current) {
    if (current === null || typeof current === 'boolean' ||
        typeof current === 'number' || typeof current === 'string') {
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      return `[${current.map((item) => serialize(item)).join(',')}]`;
    }
    const keys = Object.keys(current).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(current[key])}`).join(',')}}`;
  }
  return serialize(value);
}

function canonicalSha256(value) {
  const canonical = canonicalizeJcs(value);
  return {
    canonical,
    sha256: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
  };
}

function constructRejectionCase(item) {
  switch (item.kind) {
    case 'invalid-surrogate':
      return JSON.parse(item.inputJson);
    case 'sparse-array': {
      const value = [];
      value[1] = 'present';
      return value;
    }
    case 'array-extra-property': {
      const value = ['item'];
      value.extra = true;
      return value;
    }
    case 'accessor-object': {
      const value = {};
      Object.defineProperty(value, 'secret', { enumerable: true, get() {
        throw new Error('getter must not execute');
      } });
      return value;
    }
    case 'to-json':
      return { value: 1, toJSON() { return { value: 2 }; } };
    case 'non-plain-object':
      return new Date('2026-08-23T00:00:00.000Z');
    case 'cycle': {
      const value = {};
      value.self = value;
      return value;
    }
    case 'undefined':
      return { value: undefined };
    case 'non-finite':
      return { value: Number.NaN };
    case 'bigint':
      return { value: 1n };
    case 'symbol-key': {
      const value = {};
      value[Symbol('secret')] = true;
      return value;
    }
    case 'non-enumerable': {
      const value = {};
      Object.defineProperty(value, 'hidden', { value: true, enumerable: false });
      return value;
    }
    case 'function':
      return { value() {} };
    case 'proxy':
      return new Proxy({ value: 1 }, {});
    default:
      throw new Error(`Unknown rejection case kind: ${item.kind}`);
  }
}

function runVectors(path) {
  const fixture = parseJsonLossless(fs.readFileSync(path, 'utf8'));
  const canonicalCases = fixture.canonicalCases.map((item) => {
    const actual = canonicalSha256(parseJsonLossless(item.inputJson));
    return {
      name: item.name,
      canonicalMatched: actual.canonical === item.expectedCanonical,
      sha256Matched: actual.sha256 === item.expectedSha256,
      actualCanonical: actual.canonical,
      actualSha256: actual.sha256
    };
  });
  const rejectionCases = fixture.rejectionCases.map((item) => {
    try {
      canonicalizeJcs(constructRejectionCase(item));
      return { name: item.name, rejected: false, actualCode: null };
    } catch (error) {
      return {
        name: item.name,
        rejected: error instanceof JcsDomainError && error.code === item.expectedCode,
        actualCode: error && error.code || null
      };
    }
  });
  const nullPrototype = Object.create(null);
  nullPrototype.z = 1;
  nullPrototype.a = 2;
  const nullPrototypeResult = canonicalSha256(nullPrototype);
  const rawInputCases = fixture.rawInputCases.map((item) => {
    try {
      const actual = canonicalSha256(parseJsonLossless(item.inputJson));
      const passed = item.expectedCode === null
        && actual.canonical === item.expectedCanonical
        && actual.sha256 === item.expectedSha256;
      return {
        name: item.name,
        accepted: true,
        actualCode: null,
        actualCanonical: actual.canonical,
        actualSha256: actual.sha256,
        passed
      };
    } catch (error) {
      return {
        name: item.name,
        accepted: false,
        actualCode: error && error.code || null,
        passed: error instanceof JcsDomainError && error.code === item.expectedCode
      };
    }
  });
  return {
    algorithm: fixture.algorithm,
    canonicalCases,
    rejectionCases,
    rawInputCases,
    nullPrototypePlainObject: {
      passed: nullPrototypeResult.canonical === '{"a":2,"z":1}',
      canonical: nullPrototypeResult.canonical
    }
  };
}

function main(argv) {
  if (argv[0] === '--vectors' && argv[1]) {
    process.stdout.write(`${JSON.stringify(runVectors(argv[1]))}\n`);
    return;
  }
  if (argv[0] === '--stdin') {
    const input = parseJsonLossless(fs.readFileSync(0, 'utf8'));
    const values = Array.isArray(input) ? input : [input];
    process.stdout.write(`${JSON.stringify(values.map(canonicalSha256))}\n`);
    return;
  }
  throw new Error('Usage: canonicalize-jcs.js --vectors <fixture> | --stdin');
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  JcsDomainError,
  parseJsonLossless,
  assertJcsDomain,
  canonicalizeJcs,
  canonicalSha256
};
