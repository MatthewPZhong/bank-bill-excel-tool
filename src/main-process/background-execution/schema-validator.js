'use strict';

const SUPPORTED_SCHEMA_KEYWORDS = Object.freeze([
  '$defs',
  '$id',
  '$ref',
  '$schema',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'default',
  'description',
  'else',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'if',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'not',
  'oneOf',
  'pattern',
  'properties',
  'propertyNames',
  'required',
  'then',
  'title',
  'type',
  'uniqueItems'
]);

const SUPPORTED_KEYWORD_SET = new Set(SUPPORTED_SCHEMA_KEYWORDS);
const ANNOTATION_KEYWORDS = new Set(['$id', '$schema', 'default', 'description', 'title']);
const SCHEMA_MAP_KEYWORDS = new Set(['$defs', 'properties']);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf']);
const SCHEMA_VALUE_KEYWORDS = new Set([
  'additionalProperties',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then'
]);

class SchemaCompileError extends Error {
  constructor(code, message, schemaPath) {
    super(message);
    this.name = 'SchemaCompileError';
    this.code = code;
    this.schemaPath = schemaPath;
  }
}

class SchemaValidationError extends Error {
  constructor(code, message, path, errors) {
    super(message);
    this.name = 'SchemaValidationError';
    this.code = code;
    this.path = path;
    this.errors = errors;
  }
}

function escapePointerToken(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function appendPointer(path, value) {
  return `${path}/${escapePointerToken(value)}`;
}

function isSchema(value) {
  return typeof value === 'boolean' || (value !== null && typeof value === 'object' && !Array.isArray(value));
}

function resolveLocalRef(rootSchema, ref, schemaPath) {
  if (ref === '#') {
    return rootSchema;
  }
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new SchemaCompileError(
      'UNSUPPORTED_SCHEMA_REF',
      `Only local JSON Pointer references are supported: ${String(ref)}`,
      schemaPath
    );
  }

  let current = rootSchema;
  for (const rawToken of ref.slice(2).split('/')) {
    const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, token)) {
      throw new SchemaCompileError('UNRESOLVED_SCHEMA_REF', `Unresolved schema reference: ${ref}`, schemaPath);
    }
    current = current[token];
  }
  if (!isSchema(current)) {
    throw new SchemaCompileError('INVALID_SCHEMA_REF', `Reference does not target a schema: ${ref}`, schemaPath);
  }
  return current;
}

function auditSchema(rootSchema) {
  if (!isSchema(rootSchema)) {
    throw new SchemaCompileError('INVALID_SCHEMA', 'Schema must be an object or boolean', '#');
  }

  const visited = new Set();

  function visit(schema, schemaPath) {
    if (typeof schema === 'boolean') {
      return;
    }
    if (!isSchema(schema)) {
      throw new SchemaCompileError('INVALID_SCHEMA', 'Nested schema must be an object or boolean', schemaPath);
    }
    if (visited.has(schema)) {
      return;
    }
    visited.add(schema);

    for (const keyword of Object.keys(schema)) {
      const keywordPath = `${schemaPath}/${escapePointerToken(keyword)}`;
      if (!SUPPORTED_KEYWORD_SET.has(keyword)) {
        throw new SchemaCompileError(
          'UNSUPPORTED_SCHEMA_KEYWORD',
          `Unsupported JSON Schema keyword: ${keyword}`,
          keywordPath
        );
      }

      const value = schema[keyword];
      if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new SchemaCompileError('INVALID_SCHEMA_KEYWORD', `${keyword} must be an object`, keywordPath);
        }
        for (const [name, nestedSchema] of Object.entries(value)) {
          visit(nestedSchema, `${keywordPath}/${escapePointerToken(name)}`);
        }
      } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) {
        if (!Array.isArray(value) || value.length === 0) {
          throw new SchemaCompileError('INVALID_SCHEMA_KEYWORD', `${keyword} must be a non-empty array`, keywordPath);
        }
        value.forEach((nestedSchema, index) => visit(nestedSchema, `${keywordPath}/${index}`));
      } else if (SCHEMA_VALUE_KEYWORDS.has(keyword) && !(keyword === 'additionalProperties' && typeof value === 'boolean')) {
        visit(value, keywordPath);
      } else if (keyword === '$ref') {
        resolveLocalRef(rootSchema, value, keywordPath);
      } else if (keyword === 'pattern') {
        try {
          new RegExp(value, 'u');
        } catch (error) {
          throw new SchemaCompileError('INVALID_SCHEMA_PATTERN', error.message, keywordPath);
        }
      } else if (keyword === 'format' && value !== 'date-time') {
        throw new SchemaCompileError('UNSUPPORTED_SCHEMA_FORMAT', `Unsupported JSON Schema format: ${value}`, keywordPath);
      }
    }
  }

  visit(rootSchema, '#');
  return Object.freeze({
    keywords: Object.freeze(collectSchemaKeywords(rootSchema)),
    supportedKeywords: SUPPORTED_SCHEMA_KEYWORDS
  });
}

function collectSchemaKeywords(rootSchema) {
  const found = new Set();
  const visited = new Set();

  function visit(schema) {
    if (typeof schema === 'boolean' || visited.has(schema)) {
      return;
    }
    visited.add(schema);
    for (const [keyword, value] of Object.entries(schema)) {
      found.add(keyword);
      if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
        Object.values(value).forEach(visit);
      } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) {
        value.forEach(visit);
      } else if (SCHEMA_VALUE_KEYWORDS.has(keyword) && isSchema(value)) {
        visit(value);
      }
    }
  }

  visit(rootSchema);
  return [...found].sort();
}

function valueMatchesType(value, expectedType) {
  switch (expectedType) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}

function jsonValueEqual(left, right) {
  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonValueEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) && jsonValueEqual(left[key], right[key]));
}

function isDateTime(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/
  );
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const calendarValid = month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 60 && offsetHour <= 23 && offsetMinute <= 59;
  if (!calendarValid) return false;
  if (second < 60) return true;

  // RFC 3339 permits :60 only for a leap second. A numeric offset may express the
  // same instant in local time, so normalize the preceding :59 to UTC first.
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, 59, 0);
  const offsetSign = match[7] === '-' ? -1 : 1;
  const offsetMinutes = offsetSign * (offsetHour * 60 + offsetMinute);
  utc.setTime(utc.getTime() - offsetMinutes * 60000);
  return utc.getUTCHours() === 23 && utc.getUTCMinutes() === 59 &&
    ((utc.getUTCMonth() === 5 && utc.getUTCDate() === 30) ||
      (utc.getUTCMonth() === 11 && utc.getUTCDate() === 31));
}

function createSchemaValidator(rootSchema, options = {}) {
  const audit = auditSchema(rootSchema);
  const maxErrors = Number.isInteger(options.maxErrors) && options.maxErrors > 0 ? options.maxErrors : 32;
  const schemaName = options.schemaName || 'schema';

  function validate(value) {
    const errors = [];
    evaluate(rootSchema, value, '', '#', errors);
    return Object.freeze({
      valid: errors.length === 0,
      errors: Object.freeze(errors.map((error) => Object.freeze(error)))
    });
  }

  function addError(errors, keyword, path, schemaPath, message) {
    if (errors.length >= maxErrors) {
      return;
    }
    errors.push({
      code: `SCHEMA_${keyword.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()}`,
      path: path || '/',
      schemaPath,
      keyword,
      message
    });
  }

  function branchValid(schema, value, path, schemaPath) {
    const branchErrors = [];
    evaluate(schema, value, path, schemaPath, branchErrors);
    return branchErrors.length === 0;
  }

  function evaluate(schema, value, path, schemaPath, errors) {
    if (errors.length >= maxErrors) {
      return;
    }
    if (schema === true) {
      return;
    }
    if (schema === false) {
      addError(errors, 'falseSchema', path, schemaPath, 'Value is rejected by the schema');
      return;
    }

    if (schema.$ref !== undefined) {
      evaluate(resolveLocalRef(rootSchema, schema.$ref, `${schemaPath}/$ref`), value, path, schema.$ref, errors);
    }

    if (schema.type !== undefined) {
      const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!allowedTypes.some((type) => valueMatchesType(value, type))) {
        addError(errors, 'type', path, `${schemaPath}/type`, `Expected type ${allowedTypes.join(' or ')}`);
        return;
      }
    }

    if (schema.const !== undefined && !jsonValueEqual(value, schema.const)) {
      addError(errors, 'const', path, `${schemaPath}/const`, 'Value must equal the schema constant');
    }
    if (schema.enum !== undefined && !schema.enum.some((candidate) => jsonValueEqual(value, candidate))) {
      addError(errors, 'enum', path, `${schemaPath}/enum`, 'Value is not in the allowed enumeration');
    }

    if (schema.allOf !== undefined) {
      schema.allOf.forEach((nestedSchema, index) => {
        evaluate(nestedSchema, value, path, `${schemaPath}/allOf/${index}`, errors);
      });
    }
    if (schema.anyOf !== undefined) {
      const matches = schema.anyOf.some((nestedSchema, index) =>
        branchValid(nestedSchema, value, path, `${schemaPath}/anyOf/${index}`)
      );
      if (!matches) {
        addError(errors, 'anyOf', path, `${schemaPath}/anyOf`, 'Value must match at least one schema branch');
      }
    }
    if (schema.oneOf !== undefined) {
      const matches = schema.oneOf.reduce(
        (count, nestedSchema, index) => count + Number(branchValid(nestedSchema, value, path, `${schemaPath}/oneOf/${index}`)),
        0
      );
      if (matches !== 1) {
        addError(errors, 'oneOf', path, `${schemaPath}/oneOf`, 'Value must match exactly one schema branch');
      }
    }
    if (schema.not !== undefined && branchValid(schema.not, value, path, `${schemaPath}/not`)) {
      addError(errors, 'not', path, `${schemaPath}/not`, 'Value must not match the forbidden schema');
    }
    if (schema.if !== undefined) {
      const conditionalMatches = branchValid(schema.if, value, path, `${schemaPath}/if`);
      if (conditionalMatches && schema.then !== undefined) {
        evaluate(schema.then, value, path, `${schemaPath}/then`, errors);
      } else if (!conditionalMatches && schema.else !== undefined) {
        evaluate(schema.else, value, path, `${schemaPath}/else`, errors);
      }
    }

    if (typeof value === 'string') {
      const length = Array.from(value).length;
      if (schema.minLength !== undefined && length < schema.minLength) {
        addError(errors, 'minLength', path, `${schemaPath}/minLength`, `String must contain at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        addError(errors, 'maxLength', path, `${schemaPath}/maxLength`, `String must contain at most ${schema.maxLength} characters`);
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
        addError(errors, 'pattern', path, `${schemaPath}/pattern`, 'String does not match the required pattern');
      }
      if (schema.format === 'date-time' && !isDateTime(value)) {
        addError(errors, 'format', path, `${schemaPath}/format`, 'String must be an RFC 3339 date-time');
      }
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      if (schema.minimum !== undefined && value < schema.minimum) {
        addError(errors, 'minimum', path, `${schemaPath}/minimum`, `Number must be at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        addError(errors, 'maximum', path, `${schemaPath}/maximum`, `Number must be at most ${schema.maximum}`);
      }
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
        addError(errors, 'exclusiveMinimum', path, `${schemaPath}/exclusiveMinimum`, `Number must be greater than ${schema.exclusiveMinimum}`);
      }
      if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
        addError(errors, 'exclusiveMaximum', path, `${schemaPath}/exclusiveMaximum`, `Number must be less than ${schema.exclusiveMaximum}`);
      }
    }

    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        addError(errors, 'minItems', path, `${schemaPath}/minItems`, `Array must contain at least ${schema.minItems} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        addError(errors, 'maxItems', path, `${schemaPath}/maxItems`, `Array must contain at most ${schema.maxItems} items`);
      }
      if (schema.uniqueItems === true) {
        for (let index = 0; index < value.length; index += 1) {
          if (value.slice(0, index).some((candidate) => jsonValueEqual(candidate, value[index]))) {
            addError(errors, 'uniqueItems', appendPointer(path, index), `${schemaPath}/uniqueItems`, 'Array items must be unique');
            break;
          }
        }
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => {
          evaluate(schema.items, item, appendPointer(path, index), `${schemaPath}/items`, errors);
        });
      }
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
        addError(errors, 'minProperties', path, `${schemaPath}/minProperties`, `Object must contain at least ${schema.minProperties} properties`);
      }
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
        addError(errors, 'maxProperties', path, `${schemaPath}/maxProperties`, `Object must contain at most ${schema.maxProperties} properties`);
      }
      if (schema.required !== undefined) {
        schema.required.forEach((propertyName) => {
          if (!Object.prototype.hasOwnProperty.call(value, propertyName)) {
            addError(errors, 'required', appendPointer(path, propertyName), `${schemaPath}/required`, `Missing required property: ${propertyName}`);
          }
        });
      }
      if (schema.propertyNames !== undefined) {
        keys.forEach((propertyName) => {
          evaluate(schema.propertyNames, propertyName, appendPointer(path, propertyName), `${schemaPath}/propertyNames`, errors);
        });
      }

      const declaredProperties = schema.properties || {};
      for (const [propertyName, nestedSchema] of Object.entries(declaredProperties)) {
        if (Object.prototype.hasOwnProperty.call(value, propertyName)) {
          evaluate(
            nestedSchema,
            value[propertyName],
            appendPointer(path, propertyName),
            `${schemaPath}/properties/${escapePointerToken(propertyName)}`,
            errors
          );
        }
      }

      if (schema.additionalProperties !== undefined) {
        keys.filter((propertyName) => !Object.prototype.hasOwnProperty.call(declaredProperties, propertyName)).forEach((propertyName) => {
          const propertyPath = appendPointer(path, propertyName);
          if (schema.additionalProperties === false) {
            addError(errors, 'additionalProperties', propertyPath, `${schemaPath}/additionalProperties`, `Unexpected property: ${propertyName}`);
          } else if (isSchema(schema.additionalProperties)) {
            evaluate(schema.additionalProperties, value[propertyName], propertyPath, `${schemaPath}/additionalProperties`, errors);
          }
        });
      }
    }

    for (const keyword of ANNOTATION_KEYWORDS) {
      void schema[keyword];
    }
  }

  function assertValid(value, errorCode = 'SCHEMA_VALIDATION_FAILED') {
    const result = validate(value);
    if (!result.valid) {
      const firstError = result.errors[0];
      throw new SchemaValidationError(
        errorCode,
        `${schemaName} validation failed at ${firstError.path}: ${firstError.message}`,
        firstError.path,
        result.errors
      );
    }
    return value;
  }

  return Object.freeze({
    audit,
    assertValid,
    schema: rootSchema,
    validate
  });
}

module.exports = {
  SUPPORTED_SCHEMA_KEYWORDS,
  SchemaCompileError,
  SchemaValidationError,
  auditSchema,
  collectSchemaKeywords,
  createSchemaValidator,
  jsonValueEqual
};
