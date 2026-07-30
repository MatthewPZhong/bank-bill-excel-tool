'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const sax = require('sax');
const {
  openZipWithEntries,
  WORKBOOK_ENTRY_NAME,
  WORKBOOK_RELS_ENTRY_NAME
} = require('../big-table-import/zip-reader');
const {
  createSourceStyleRegistryFromOoxml
} = require('./style-registry');
const {
  assertExcelCellTextLength,
  assertExcelStXstringRawLength,
  decodeExcelStXstring
} = require('./excel-text');
const {
  OFFICE_RELATIONSHIP_NAMESPACES,
  PACKAGE_RELATIONSHIP_NAMESPACES,
  SPREADSHEETML_NAMESPACES,
  exactSaxLocalName,
  namespaceAllowed,
  normalizedSaxAttributes,
  saxAttributeIdentity
} = require('./ooxml-namespaces');
const {
  ToolboxXlsxCancelledError,
  ToolboxXlsxFormatError,
  scanXlsxSheet
} = require('./xlsx-sheet-scanner');

const TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES = 1_200_000_000;
const TOOLBOX_XLSX_METADATA_LIMITS = Object.freeze({
  workbook: 16 * 1024 * 1024,
  relationships: 16 * 1024 * 1024,
  styles: 32 * 1024 * 1024,
  theme: 8 * 1024 * 1024
});
const WORKBOOK_CANONICAL_ELEMENT_NAMES = Object.freeze([
  'workbook',
  'workbookPr',
  'sheets',
  'sheet'
]);
const RELATIONSHIP_CANONICAL_ELEMENT_NAMES = Object.freeze([
  'Relationships',
  'Relationship'
]);
const SHARED_STRING_CANONICAL_ELEMENT_NAMES = Object.freeze([
  'sst',
  'si',
  'r',
  'rPr',
  'rPh',
  'phoneticPr',
  't'
]);
const WORKBOOK_ELEMENTS_BY_CASEFOLD = new Map(
  WORKBOOK_CANONICAL_ELEMENT_NAMES.map((name) => [name.toLowerCase(), name])
);
const RELATIONSHIP_ELEMENTS_BY_CASEFOLD = new Map(
  RELATIONSHIP_CANONICAL_ELEMENT_NAMES.map((name) => [name.toLowerCase(), name])
);
const SHARED_STRING_ELEMENTS_BY_CASEFOLD = new Map(
  SHARED_STRING_CANONICAL_ELEMENT_NAMES.map((name) => [name.toLowerCase(), name])
);
const WORKBOOK_ELEMENT_NAMES = new Set(WORKBOOK_ELEMENTS_BY_CASEFOLD.keys());
const RELATIONSHIP_ELEMENT_NAMES = new Set(RELATIONSHIP_ELEMENTS_BY_CASEFOLD.keys());
const SHARED_STRING_ELEMENT_NAMES = new Set(SHARED_STRING_ELEMENTS_BY_CASEFOLD.keys());
const WORKBOOK_CONSUMED_ATTRIBUTES = Object.freeze({
  workbookPr: new Map([
    ['date1904', 'date1904']
  ]),
  sheet: new Map([
    ['name', 'name'],
    ['state', 'state']
  ])
});
const RELATIONSHIP_CONSUMED_ATTRIBUTES = new Map([
  ['id', 'Id'],
  ['type', 'Type'],
  ['target', 'Target'],
  ['targetmode', 'TargetMode']
]);
const OFFICE_RELATIONSHIP_TYPE_ALLOWLIST = Object.freeze({
  worksheet: Object.freeze([...OFFICE_RELATIONSHIP_NAMESPACES]
    .map((namespace) => `${namespace}/worksheet`)),
  styles: Object.freeze([...OFFICE_RELATIONSHIP_NAMESPACES]
    .map((namespace) => `${namespace}/styles`)),
  theme: Object.freeze([...OFFICE_RELATIONSHIP_NAMESPACES]
    .map((namespace) => `${namespace}/theme`)),
  sharedStrings: Object.freeze([...OFFICE_RELATIONSHIP_NAMESPACES]
    .map((namespace) => `${namespace}/sharedStrings`))
});
const WORKSHEET_STATES = Object.freeze([
  'visible',
  'hidden',
  'veryHidden'
]);

function localName(name) {
  return exactSaxLocalName(name).toLowerCase();
}

function validateElementCase(nodeOrName, canonicalNames, xmlPart) {
  const exactName = exactSaxLocalName(nodeOrName);
  const canonicalName = canonicalNames.get(exactName.toLowerCase()) || null;
  if (canonicalName && exactName !== canonicalName) {
    throw new ToolboxXlsxFormatError(
      `${xmlPart} 的元素 ${exactName} 大小写无效；规范名称必须为 ${canonicalName}`,
      {
        xmlPart,
        elementName: exactName,
        canonicalElementName: canonicalName
      }
    );
  }
  return {
    canonicalName,
    normalizedName: exactName.toLowerCase()
  };
}

function validateConsumedAttributeCase(attributes, canonicalNames, context = {}) {
  if (!canonicalNames) return;
  for (const [rawName, rawAttribute] of Object.entries(attributes || {})) {
    const identity = saxAttributeIdentity(rawName, rawAttribute);
    if (identity.namespaceDeclaration || identity.prefix) continue;
    const canonicalName = canonicalNames.get(identity.localName.toLowerCase());
    if (canonicalName && identity.localName !== canonicalName) {
      throw new ToolboxXlsxFormatError(
        `${context.xmlPart || 'OOXML'} 的元素 ${context.elementName || ''} ` +
          `属性 ${identity.localName} 大小写无效；规范名称必须为 ${canonicalName}`,
        {
          ...context,
          attributeName: identity.localName,
          canonicalAttributeName: canonicalName
        }
      );
    }
  }
}

function relationshipTypeAllowed(type, relationshipKind) {
  const allowedTypes = OFFICE_RELATIONSHIP_TYPE_ALLOWLIST[relationshipKind];
  return !!allowedTypes && allowedTypes.includes(String(type || ''));
}

function parseWorksheetState(value, sheetName) {
  if (value === undefined) return 'visible';
  const state = String(value);
  if (!WORKSHEET_STATES.includes(state)) {
    throw new ToolboxXlsxFormatError(
      `工作表“${sheetName}”的 state 仅允许 visible/hidden/veryHidden`,
      {
        sheetName,
        state,
        allowedStates: WORKSHEET_STATES
      }
    );
  }
  return state;
}

function parseSheetRelationshipId(node, sheetName) {
  const relationshipIdAttributes = [];
  for (const [rawName, rawAttribute] of Object.entries(node.attributes || {})) {
    const identity = saxAttributeIdentity(rawName, rawAttribute);
    if (identity.namespaceDeclaration ||
        !namespaceAllowed(identity.uri, OFFICE_RELATIONSHIP_NAMESPACES) ||
        identity.localName.toLowerCase() !== 'id') {
      continue;
    }
    if (identity.localName !== 'id') {
      throw new ToolboxXlsxFormatError(
        `工作表“${sheetName}”的关系属性 ${identity.localName} 大小写无效；规范名称必须为 id`,
        {
          sheetName,
          attributeName: identity.localName,
          canonicalAttributeName: 'id'
        }
      );
    }
    relationshipIdAttributes.push(identity);
  }
  if (relationshipIdAttributes.length !== 1 ||
      !namespaceAllowed(
        relationshipIdAttributes[0] && relationshipIdAttributes[0].uri,
        OFFICE_RELATIONSHIP_NAMESPACES
      )) {
    throw new ToolboxXlsxFormatError(
      `工作表“${sheetName}”的 r:id namespace 无效或缺失`,
      {
        sheetName,
        relationshipAttributeCount: relationshipIdAttributes.length,
        relationshipNamespaces: relationshipIdAttributes
          .map((attribute) => String(attribute.uri || ''))
      }
    );
  }
  const relationshipId = relationshipIdAttributes[0] &&
    relationshipIdAttributes[0].value;
  if (!relationshipId) {
    throw new ToolboxXlsxFormatError(`工作表“${sheetName}”缺少 r:id 关系标识`, {
      sheetName
    });
  }
  return String(relationshipId);
}

function parseStrictOoxmlBoolean(value, fallback = false, context = {}) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const lexical = String(value).trim();
  if (lexical === 'true' || lexical === '1') return true;
  if (lexical === 'false' || lexical === '0') return false;
  throw new ToolboxXlsxFormatError(
    'workbookPr.date1904 仅允许 0/1/true/false',
    { ...context, date1904: value }
  );
}

function parseWorkbookXml(workbookXml) {
  const xml = String(workbookXml || '');
  if (!xml.trim()) {
    throw new ToolboxXlsxFormatError('xlsx 的 workbook.xml 为空或已损坏');
  }
  let date1904 = false;
  const sheets = [];
  const relationshipIds = new Set();
  const sheetNames = new Map();
  let workbookSeen = false;
  let workbookClosed = false;
  let workbookPrSeen = false;
  let sheetsSeen = false;
  let sheetsClosed = false;
  let depth = 0;
  let workbookDepth = -1;
  let sheetsDepth = -1;
  let extensionListDepth = -1;
  let extensionDepth = -1;
  const elementStack = [];
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  parser.onopentag = (node) => {
    const exactName = exactSaxLocalName(node);
    const parent = elementStack[elementStack.length - 1] || null;
    const insideExtension = extensionDepth >= 0;
    const foreignExtensionElement = insideExtension &&
      !namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES);
    const elementName = foreignExtensionElement
      ? { canonicalName: null, normalizedName: null }
      : validateElementCase(
        node,
        WORKBOOK_ELEMENTS_BY_CASEFOLD,
        'workbook.xml'
      );
    const name = elementName.normalizedName;
    validateConsumedAttributeCase(
      node.attributes,
      WORKBOOK_CONSUMED_ATTRIBUTES[elementName.canonicalName],
      {
        xmlPart: 'workbook.xml',
        elementName: elementName.canonicalName
      }
    );
    const attrs = normalizedSaxAttributes(node.attributes);
    depth += 1;
    elementStack.push({
      exactName,
      uri: String(node.uri || '')
    });
    if (extensionListDepth < 0 &&
        exactName === 'extLst' &&
        namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES) &&
        parent &&
        parent.exactName === 'workbook' &&
        namespaceAllowed(parent.uri, SPREADSHEETML_NAMESPACES) &&
        depth === workbookDepth + 1) {
      extensionListDepth = depth;
    } else if (extensionDepth < 0 &&
        extensionListDepth >= 0 &&
        exactName === 'ext' &&
        namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES) &&
        parent &&
        parent.exactName === 'extLst' &&
        namespaceAllowed(parent.uri, SPREADSHEETML_NAMESPACES) &&
        depth === extensionListDepth + 1) {
      extensionDepth = depth;
    }
    if (WORKBOOK_ELEMENT_NAMES.has(name) &&
        !namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES)) {
      throw new ToolboxXlsxFormatError(
        `workbook.xml 的 ${node.name} 元素 namespace 无效或缺失`,
        {
          elementName: node.name,
          namespaceUri: String(node.uri || '')
        }
      );
    }
    if (name === 'workbook') {
      if (workbookSeen || depth !== 1) {
        throw new ToolboxXlsxFormatError('workbook.xml 包含重复或嵌套的 workbook 根节点');
      }
      workbookSeen = true;
      workbookDepth = depth;
      return;
    }
    if (!workbookSeen || workbookClosed) return;
    if (name === 'sheets') {
      if (sheetsSeen || depth !== workbookDepth + 1) {
        throw new ToolboxXlsxFormatError('workbook.xml 的 sheets 节点重复或层级无效');
      }
      sheetsSeen = true;
      sheetsDepth = depth;
    } else if (name === 'workbookpr') {
      if (depth !== workbookDepth + 1) {
        throw new ToolboxXlsxFormatError('workbookPr 必须是 workbook 的直接子元素');
      }
      if (workbookPrSeen) {
        throw new ToolboxXlsxFormatError('workbook.xml 重复声明 workbookPr 节点');
      }
      workbookPrSeen = true;
      date1904 = parseStrictOoxmlBoolean(attrs.date1904, false, {
        xmlPart: 'workbook.xml'
      });
    } else if (name === 'sheet') {
      if (!sheetsSeen || sheetsClosed || depth !== sheetsDepth + 1) {
        throw new ToolboxXlsxFormatError('sheet 必须是 sheets 的直接子元素');
      }
      const sheetName = String(attrs.name || '');
      if (!sheetName) {
        throw new ToolboxXlsxFormatError('workbook.xml 中存在缺少 name 的工作表声明');
      }
      const sheetState = parseWorksheetState(attrs.state, sheetName);
      const relationshipId = parseSheetRelationshipId(node, sheetName);
      if (relationshipIds.has(relationshipId)) {
        throw new ToolboxXlsxFormatError(`workbook.xml 包含重复的工作表 r:id：${relationshipId}`, {
          relationshipId
        });
      }
      const comparableSheetName = sheetName.toUpperCase();
      if (sheetNames.has(comparableSheetName)) {
        throw new ToolboxXlsxFormatError(`workbook.xml 包含大小写不敏感的重复工作表名：${sheetName}`, {
          sheetName,
          conflictingSheetName: sheetNames.get(comparableSheetName)
        });
      }
      relationshipIds.add(relationshipId);
      sheetNames.set(comparableSheetName, sheetName);
      sheets.push({
        name: sheetName,
        relationshipId,
        state: sheetState
      });
    }
  };
  parser.onclosetag = (rawName) => {
    const name = localName(rawName);
    if (name === 'sheets' && depth === sheetsDepth) sheetsClosed = true;
    if (name === 'workbook' && depth === workbookDepth) workbookClosed = true;
    if (depth === extensionDepth) extensionDepth = -1;
    if (depth === extensionListDepth) extensionListDepth = -1;
    elementStack.pop();
    depth -= 1;
  };
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof ToolboxXlsxFormatError) throw error;
    throw new ToolboxXlsxFormatError(`workbook.xml 不是完整有效的 XML：${error.message}`, {
      cause: error.message
    });
  }
  if (!workbookSeen || !workbookClosed || !sheetsSeen || !sheetsClosed || depth !== 0) {
    throw new ToolboxXlsxFormatError('workbook.xml 根节点或 sheets 节点未完整闭合');
  }
  return { date1904, sheets };
}

function normalizeRelationshipTarget(target) {
  const value = String(target || '').trim();
  if (!value) return null;
  if (value.startsWith('/')) return path.posix.normalize(value.slice(1));
  const workbookRelative = value.startsWith('xl/') ? value : path.posix.join('xl', value);
  const normalized = path.posix.normalize(workbookRelative);
  return normalized.startsWith('../') ? null : normalized;
}

function parseWorkbookRelationships(relsXml) {
  const xml = String(relsXml || '');
  if (!xml.trim()) {
    throw new ToolboxXlsxFormatError('workbook.xml.rels 为空或已损坏');
  }
  const relationships = new Map();
  let rootSeen = false;
  let rootClosed = false;
  let depth = 0;
  let rootDepth = -1;
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  parser.onopentag = (node) => {
    const elementName = validateElementCase(
      node,
      RELATIONSHIP_ELEMENTS_BY_CASEFOLD,
      'workbook.xml.rels'
    );
    const name = elementName.normalizedName;
    if (elementName.canonicalName === 'Relationship') {
      validateConsumedAttributeCase(
        node.attributes,
        RELATIONSHIP_CONSUMED_ATTRIBUTES,
        {
          xmlPart: 'workbook.xml.rels',
          elementName: 'Relationship'
        }
      );
    }
    const attrs = normalizedSaxAttributes(node.attributes);
    depth += 1;
    if (RELATIONSHIP_ELEMENT_NAMES.has(name) &&
        !namespaceAllowed(node.uri, PACKAGE_RELATIONSHIP_NAMESPACES)) {
      throw new ToolboxXlsxFormatError(
        `workbook.xml.rels 的 ${node.name} 元素 namespace 无效或缺失`,
        {
          elementName: node.name,
          namespaceUri: String(node.uri || '')
        }
      );
    }
    if (name === 'relationships') {
      if (rootSeen || depth !== 1) {
        throw new ToolboxXlsxFormatError('workbook.xml.rels 包含重复或嵌套的 Relationships 根节点');
      }
      rootSeen = true;
      rootDepth = depth;
      return;
    }
    if (name === 'relationship' &&
        (!rootSeen || rootClosed || depth !== rootDepth + 1)) {
      throw new ToolboxXlsxFormatError(
        'Relationship 必须是 Relationships 的直接子元素'
      );
    }
    if (name !== 'relationship') return;
    const id = attrs.id;
    if (!id) {
      throw new ToolboxXlsxFormatError('workbook.xml.rels 中存在缺少 Id 的 Relationship');
    }
    if (relationships.has(String(id))) {
      throw new ToolboxXlsxFormatError(`workbook.xml.rels 包含重复的关系 Id：${id}`, {
        relationshipId: String(id)
      });
    }
    const type = String(attrs.type || '').trim();
    const target = normalizeRelationshipTarget(attrs.target);
    const hasTargetMode = attrs.targetmode !== undefined && attrs.targetmode !== null;
    const targetMode = !hasTargetMode
      ? ''
      : String(attrs.targetmode).trim();
    if (hasTargetMode && targetMode !== 'Internal' && targetMode !== 'External') {
      throw new ToolboxXlsxFormatError(
        `workbook.xml.rels 的关系 ${id} 包含无效 TargetMode：${targetMode}`,
        {
          relationshipId: String(id),
          targetMode
        }
      );
    }
    if (!type || !target) {
      throw new ToolboxXlsxFormatError(`workbook.xml.rels 的关系 ${id} 缺少有效 Type 或 Target`, {
        relationshipId: String(id),
        type,
        target: attrs.target
      });
    }
    relationships.set(String(id), {
      id: String(id),
      type,
      target,
      targetMode
    });
  };
  parser.onclosetag = (rawName) => {
    const name = localName(rawName);
    if (name === 'relationships' && depth === rootDepth) rootClosed = true;
    depth -= 1;
  };
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof ToolboxXlsxFormatError) throw error;
    throw new ToolboxXlsxFormatError(`workbook.xml.rels 不是完整有效的 XML：${error.message}`, {
      cause: error.message
    });
  }
  if (!rootSeen || !rootClosed || depth !== 0) {
    throw new ToolboxXlsxFormatError('workbook.xml.rels 根节点未完整闭合');
  }
  return relationships;
}

function findRelationshipEntry(
  entries,
  relationships,
  relationshipKind,
  fallbackPath,
  options = {}
) {
  const allowedRelationshipTypes = OFFICE_RELATIONSHIP_TYPE_ALLOWLIST[relationshipKind];
  if (!allowedRelationshipTypes) {
    throw new Error(`未知 workbook relationship kind：${relationshipKind}`);
  }
  const matchingRelationships = [...relationships.values()]
    .filter((relationship) => relationshipTypeAllowed(
      relationship.type,
      relationshipKind
    ));
  if (matchingRelationships.length === 0) {
    const conflictingRelationships = [...relationships.values()]
      .filter((relationship) => relationship.target === fallbackPath);
    if (conflictingRelationships.length > 0) {
      const relationshipLabel = options.relationshipLabel || relationshipKind;
      throw new ToolboxXlsxFormatError(
        `workbook.xml.rels 存在错误 Type 的关系占用 ${relationshipLabel} 标准路径`,
        {
          sourceFile: options.sourceFile || '',
          relationshipKind,
          allowedRelationshipTypes,
          fallbackPath,
          conflictingRelationships: conflictingRelationships.map((relationship) => ({
            relationshipId: relationship.id,
            relationshipType: relationship.type,
            targetMode: relationship.targetMode
          }))
        }
      );
    }
    return entries.get(fallbackPath) || null;
  }

  const relationshipLabel = options.relationshipLabel || relationshipKind;
  if (matchingRelationships.length > 1) {
    throw new ToolboxXlsxFormatError(
      `workbook.xml.rels 重复声明 ${relationshipLabel} 关系`,
      {
        sourceFile: options.sourceFile || '',
        relationshipKind,
        allowedRelationshipTypes,
        relationshipIds: matchingRelationships.map((relationship) => relationship.id),
        targets: matchingRelationships.map((relationship) => relationship.target)
      }
    );
  }

  const relationship = matchingRelationships[0];
  if (relationship.targetMode.toLowerCase() === 'external') {
    throw new ToolboxXlsxFormatError(
      `workbook.xml.rels 的 ${relationshipLabel} 关系不得指向外部目标`,
      {
        sourceFile: options.sourceFile || '',
        relationshipId: relationship.id,
        relationshipType: relationship.type,
        target: relationship.target,
        targetMode: relationship.targetMode
      }
    );
  }
  if (!relationship.target || !entries.has(relationship.target)) {
    throw new ToolboxXlsxFormatError(
      `workbook.xml.rels 的 ${relationshipLabel} 关系目标 entry 不存在`,
      {
        sourceFile: options.sourceFile || '',
        relationshipId: relationship.id,
        relationshipType: relationship.type,
        target: relationship.target
      }
    );
  }
  return entries.get(relationship.target);
}

function assertToolboxSharedStringsSize(entry, sourceFile = '') {
  if (!entry) return;
  const uncompressedSize = Number(entry.uncompressedSize);
  if (Number.isFinite(uncompressedSize) &&
      uncompressedSize >= TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES) {
    const error = new ToolboxXlsxFormatError(
      `${sourceFile || '该文件'}：共享字符串表过大（${uncompressedSize} bytes），工具箱为避免内存耗尽已停止读取`,
      {
        sourceFile,
        uncompressedSize,
        limitBytes: TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES
      }
    );
    error.code = 'TOOLBOX_XLSX_SHARED_STRINGS_TOO_LARGE';
    throw error;
  }
}

function readToolboxMetadataEntryAsString(
  zip,
  entry,
  {
    sourceFile = '',
    partName = 'metadata',
    limitBytes
  } = {}
) {
  const limit = Number(limitBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return Promise.reject(new TypeError('工具箱 metadata part 上限必须是正安全整数'));
  }
  const declaredSize = Number(entry && entry.uncompressedSize);
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    return Promise.reject(new ToolboxXlsxFormatError(
      `${sourceFile || '该文件'}：${partName} 的 ZIP 解压尺寸无效`,
      { sourceFile, partName, declaredSize }
    ));
  }
  if (declaredSize > limit) {
    const error = new ToolboxXlsxFormatError(
      `${sourceFile || '该文件'}：${partName} 超过工具箱安全读取上限`,
      { sourceFile, partName, uncompressedSize: declaredSize, limitBytes: limit }
    );
    error.code = 'TOOLBOX_XLSX_METADATA_TOO_LARGE';
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (openError, stream) => {
      if (openError) {
        reject(openError);
        return;
      }
      const chunks = [];
      let totalBytes = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { stream.destroy(); } catch (_error) {}
        reject(error);
      };
      stream.on('data', (chunk) => {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > limit) {
          const error = new ToolboxXlsxFormatError(
            `${sourceFile || '该文件'}：${partName} 解压后超过工具箱安全读取上限`,
            { sourceFile, partName, actualBytes: totalBytes, limitBytes: limit }
          );
          error.code = 'TOOLBOX_XLSX_METADATA_TOO_LARGE';
          fail(error);
          return;
        }
        chunks.push(chunk);
      });
      stream.once('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, totalBytes).toString('utf8'));
      });
      stream.once('error', fail);
    });
  });
}

function loadToolboxSharedStrings(zip, entry, sourceFile = '') {
  if (!entry) return Promise.resolve([]);
  assertToolboxSharedStringsSize(entry, sourceFile);
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (openError, stream) => {
      if (openError) {
        reject(openError);
        return;
      }
      const parser = sax.createStream(true, {
        trim: false,
        normalize: false,
        xmlns: true
      });
      const values = [];
      const elementStack = [];
      let rootSeen = false;
      let rootClosed = false;
      let depth = 0;
      let rootDepth = -1;
      let insideSi = false;
      let siDepth = -1;
      let textDepth = -1;
      let richRunDepth = -1;
      let phoneticRunDepth = -1;
      let stringMode = null;
      let plainTextSeen = false;
      let richRunTextSeen = false;
      let currentValue = '';
      let currentTextValue = '';
      let settled = false;

      const invalidSharedStrings = (message, context = {}) => new ToolboxXlsxFormatError(
        `${sourceFile || '该文件'}：sharedStrings.xml ${message}`,
        { sourceFile, ...context }
      );
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (error) {
          try { stream.destroy(); } catch (_destroyError) {}
          reject(error instanceof ToolboxXlsxFormatError
            ? error
            : invalidSharedStrings(`不是完整有效的 XML：${error.message}`, {
              cause: error.message
            }));
        }
        else resolve(values);
      };
      parser.on('opentag', (node) => {
        if (settled) return;
        let elementName;
        try {
          elementName = validateElementCase(
            node,
            SHARED_STRING_ELEMENTS_BY_CASEFOLD,
            'sharedStrings.xml'
          );
        } catch (error) {
          finish(error);
          return;
        }
        const name = elementName.normalizedName;
        const parentName = elementStack.length > 0
          ? elementStack[elementStack.length - 1]
          : null;
        depth += 1;
        if (SHARED_STRING_ELEMENT_NAMES.has(name) &&
            !namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES)) {
          finish(invalidSharedStrings(
            `的 ${node.name} 元素 namespace 无效或缺失`,
            {
              elementName: node.name,
              namespaceUri: String(node.uri || '')
            }
          ));
          return;
        }
        if (textDepth >= 0) {
          finish(invalidSharedStrings('的 t 必须只包含文本，不得嵌套子元素'));
          return;
        }
        if (name === 'sst') {
          if (rootSeen || depth !== 1) {
            finish(invalidSharedStrings('包含重复或嵌套的 sst 根节点'));
            return;
          }
          rootSeen = true;
          rootDepth = depth;
        } else if (name === 'si') {
          if (!rootSeen || rootClosed || insideSi ||
              parentName !== 'sst' || depth !== rootDepth + 1) {
            finish(invalidSharedStrings('的 si 必须是 sst 的直接子元素且不可嵌套'));
            return;
          }
          insideSi = true;
          siDepth = depth;
          textDepth = -1;
          richRunDepth = -1;
          phoneticRunDepth = -1;
          stringMode = null;
          plainTextSeen = false;
          richRunTextSeen = false;
          currentValue = '';
        } else if (insideSi && name === 'r') {
          if (parentName !== 'si' || depth !== siDepth + 1 ||
              richRunDepth >= 0 || stringMode === 'plain') {
            finish(invalidSharedStrings('的 r 必须是 si 的直接子元素，且不得与 plain t 混用'));
            return;
          }
          stringMode = 'rich';
          richRunDepth = depth;
          richRunTextSeen = false;
        } else if (insideSi && name === 'rpr') {
          if (richRunDepth < 0 || parentName !== 'r' || depth !== richRunDepth + 1) {
            finish(invalidSharedStrings('的 rPr 必须是 r 的直接子元素'));
            return;
          }
        } else if (insideSi && name === 'rph') {
          if (parentName !== 'si' || depth !== siDepth + 1 || phoneticRunDepth >= 0) {
            finish(invalidSharedStrings('的 rPh 必须是 si 的直接子元素'));
            return;
          }
          phoneticRunDepth = depth;
        } else if (insideSi && name === 'phoneticpr') {
          if (parentName !== 'si' || depth !== siDepth + 1) {
            finish(invalidSharedStrings('的 phoneticPr 必须是 si 的直接子元素'));
            return;
          }
        } else if (insideSi && name === 't') {
          if (phoneticRunDepth >= 0) {
            if (parentName !== 'rph' || depth !== phoneticRunDepth + 1) {
              finish(invalidSharedStrings('的 phonetic t 必须是 rPh 的直接子元素'));
              return;
            }
          } else {
            const isPlainText = parentName === 'si' && depth === siDepth + 1;
            const isRichText = richRunDepth >= 0 &&
              parentName === 'r' && depth === richRunDepth + 1;
            if (!isPlainText && !isRichText) {
              finish(invalidSharedStrings('的 t 仅允许出现在 si/t 或 si/r/t 路径'));
              return;
            }
            if ((isPlainText && stringMode === 'rich') ||
                (isRichText && stringMode === 'plain')) {
              finish(invalidSharedStrings('的 plain t 与 rich r 不得混用'));
              return;
            }
            if (isPlainText && plainTextSeen) {
              finish(invalidSharedStrings('的 plain si 最多只能有一个直属 t'));
              return;
            }
            if (isRichText && richRunTextSeen) {
              finish(invalidSharedStrings('的每个 rich r 最多只能有一个直属 t'));
              return;
            }
            stringMode = isPlainText ? 'plain' : 'rich';
            if (isPlainText) plainTextSeen = true;
            if (isRichText) richRunTextSeen = true;
            textDepth = depth;
            currentTextValue = '';
          }
        } else if (!insideSi &&
                   ['r', 'rpr', 't', 'rph', 'phoneticpr'].includes(name)) {
          finish(invalidSharedStrings(`的 ${name} 必须位于 si 内`));
          return;
        }
        elementStack.push(name);
      });
      const collect = (text) => {
        if (settled) return;
        if (insideSi && textDepth >= 0) {
          currentTextValue += text;
          try {
            assertExcelStXstringRawLength(currentTextValue);
          } catch (error) {
            finish(invalidSharedStrings('单个 t 文本超过 Excel 单元格读取上限', {
              cause: error.message
            }));
          }
          return;
        }
        if (insideSi && phoneticRunDepth < 0 && String(text).trim() !== '') {
          finish(invalidSharedStrings('包含合法 t 节点之外的非空文本'));
        }
      };
      parser.on('text', collect);
      parser.on('cdata', collect);
      parser.on('closetag', (rawName) => {
        if (settled) return;
        const name = localName(rawName);
        const openName = elementStack.pop();
        if (openName !== name) {
          finish(invalidSharedStrings('元素闭合顺序无效', {
            openElement: openName || null,
            closeElement: name
          }));
          return;
        }
        if (name === 't' && depth === textDepth) {
          try {
            currentValue += decodeExcelStXstring(currentTextValue);
            assertExcelCellTextLength(currentValue);
          } catch (error) {
            finish(invalidSharedStrings('包含无效或超长的 ST_Xstring/UTF-16 文本', {
              cause: error.message
            }));
            return;
          }
          currentTextValue = '';
          textDepth = -1;
        } else if (name === 'rph' && depth === phoneticRunDepth) {
          phoneticRunDepth = -1;
        } else if (name === 'r' && depth === richRunDepth) {
          richRunDepth = -1;
          richRunTextSeen = false;
          currentTextValue = '';
        } else if (name === 'si' && depth === siDepth) {
          values.push(currentValue);
          currentValue = '';
          insideSi = false;
          siDepth = -1;
          textDepth = -1;
          richRunDepth = -1;
          phoneticRunDepth = -1;
          stringMode = null;
          plainTextSeen = false;
          richRunTextSeen = false;
        } else if (name === 'sst' && depth === rootDepth) {
          rootClosed = true;
        }
        depth -= 1;
      });
      parser.on('error', finish);
      parser.on('end', () => {
        if (!rootSeen || !rootClosed || insideSi || textDepth >= 0 ||
            richRunDepth >= 0 || phoneticRunDepth >= 0 ||
            elementStack.length !== 0 || depth !== 0) {
          finish(invalidSharedStrings('根节点或字符串节点未完整闭合'));
          return;
        }
        finish();
      });
      stream.on('error', finish);
      stream.pipe(parser);
    });
  });
}

class ToolboxXlsxPass {
  constructor({
    filePath,
    sourceFile,
    zip,
    entries,
    sheets,
    date1904,
    sharedStrings,
    sourceRegistry,
    themeColors
  }) {
    this.filePath = filePath;
    this.sourceFile = sourceFile;
    this.format = 'xlsx';
    this.zip = zip;
    this.entries = entries;
    this.sheets = Object.freeze(sheets.map((sheet) => Object.freeze({ ...sheet })));
    this.date1904 = !!date1904;
    this.sharedStrings = sharedStrings;
    this.sourceRegistry = sourceRegistry;
    this.sourceRegistryId = sourceRegistry.sourceRegistryId;
    this.themeColors = themeColors;
    this.closed = false;
    this.scanActive = false;
  }

  getSourceRegistry(sourceRegistryId = this.sourceRegistryId) {
    return sourceRegistryId === this.sourceRegistryId ? this.sourceRegistry : null;
  }

  _resolveSheet(sheetOrIndex) {
    if (Number.isInteger(sheetOrIndex)) return this.sheets[sheetOrIndex] || null;
    if (sheetOrIndex && this.sheets.includes(sheetOrIndex)) return sheetOrIndex;
    if (sheetOrIndex && Number.isInteger(sheetOrIndex.sheetIndex)) {
      return this.sheets[sheetOrIndex.sheetIndex] || null;
    }
    return null;
  }

  async scanSheet(sheetOrIndex, options = {}) {
    if (this.closed) throw new Error('ToolboxXlsxPass 已关闭');
    if (this.scanActive) throw new Error('同一 ToolboxXlsxPass 不允许并发扫描多个工作表');
    const sheet = this._resolveSheet(sheetOrIndex);
    if (!sheet) throw new RangeError('未找到指定 XLSX 工作表');
    if (!sheet.entryPath || !this.entries.has(sheet.entryPath)) {
      throw new ToolboxXlsxFormatError('工作簿中的工作表关系缺失或已损坏', {
        sourceFile: this.sourceFile,
        sheetName: sheet.name,
        sheetIndex: sheet.sheetIndex
      });
    }

    this.scanActive = true;
    try {
      return await scanXlsxSheet({
        ...options,
        zip: this.zip,
        sheetEntry: this.entries.get(sheet.entryPath),
        sheet,
        sourceFile: this.filePath,
        sourceRegistry: this.sourceRegistry,
        date1904: this.date1904,
        sharedStrings: this.sharedStrings,
        themeColors: this.themeColors
      });
    } finally {
      this.scanActive = false;
    }
  }

  async scanSheets(options = {}) {
    const includeSheet = typeof options.includeSheet === 'function'
      ? options.includeSheet
      : () => true;
    const summaries = [];
    for (const sheet of this.sheets) {
      if (options.cancelToken && options.cancelToken.cancelled) {
        throw new ToolboxXlsxCancelledError();
      }
      if (!includeSheet(sheet)) continue;
      const summary = await this.scanSheet(sheet, {
        cancelToken: options.cancelToken,
        onSheetMeta: options.onSheetMeta
          ? (meta) => options.onSheetMeta(meta, sheet)
          : null,
        onRow: options.onRow
          ? (row, meta) => options.onRow(row, meta, sheet)
          : null
      });
      if (options.cancelToken && options.cancelToken.cancelled) {
        throw new ToolboxXlsxCancelledError();
      }
      summaries.push(summary);
    }
    return summaries;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.zip.close(); } catch (_error) {}
  }
}

async function openToolboxXlsxPass(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const sourceFile = path.basename(absolutePath);
  const { zip, entries } = await openZipWithEntries(sourceFile, absolutePath, {
    rejectDuplicateEntries: true
  });
  try {
    const workbookEntry = entries.get(WORKBOOK_ENTRY_NAME);
    if (!workbookEntry) {
      throw new ToolboxXlsxFormatError('xlsx 缺少 xl/workbook.xml', { sourceFile });
    }
    const relsEntry = entries.get(WORKBOOK_RELS_ENTRY_NAME);
    const workbookXml = await readToolboxMetadataEntryAsString(zip, workbookEntry, {
      sourceFile,
      partName: 'workbook.xml',
      limitBytes: TOOLBOX_XLSX_METADATA_LIMITS.workbook
    });
    const relsXml = relsEntry
      ? await readToolboxMetadataEntryAsString(zip, relsEntry, {
        sourceFile,
        partName: 'workbook.xml.rels',
        limitBytes: TOOLBOX_XLSX_METADATA_LIMITS.relationships
      })
      : '';
    const workbook = parseWorkbookXml(workbookXml);
    const relationships = relsEntry ? parseWorkbookRelationships(relsXml) : new Map();

    const sheetEntryPaths = new Set();
    const sheets = workbook.sheets.map((sheet, sheetIndex) => {
      const relationship = sheet.relationshipId
        ? relationships.get(String(sheet.relationshipId))
        : null;
      if (!relationship) {
        throw new ToolboxXlsxFormatError(`工作表“${sheet.name}”缺少对应的 workbook relationship`, {
          sourceFile,
          sheetName: sheet.name,
          sheetIndex,
          relationshipId: sheet.relationshipId
        });
      }
      if (relationship.targetMode === 'External' ||
          !relationshipTypeAllowed(relationship.type, 'worksheet')) {
        throw new ToolboxXlsxFormatError(`工作表“${sheet.name}”的关系类型不是有效 worksheet`, {
          sourceFile,
          sheetName: sheet.name,
          sheetIndex,
          relationshipId: sheet.relationshipId,
          relationshipType: relationship.type,
          targetMode: relationship.targetMode
        });
      }
      if (!relationship.target || !entries.has(relationship.target)) {
        throw new ToolboxXlsxFormatError(`工作表“${sheet.name}”指向的 worksheet entry 不存在`, {
          sourceFile,
          sheetName: sheet.name,
          sheetIndex,
          relationshipId: sheet.relationshipId,
          entryPath: relationship.target
        });
      }
      if (sheetEntryPaths.has(relationship.target)) {
        throw new ToolboxXlsxFormatError(`多个工作表声明指向同一 worksheet entry：${relationship.target}`, {
          sourceFile,
          sheetName: sheet.name,
          sheetIndex,
          relationshipId: sheet.relationshipId,
          entryPath: relationship.target
        });
      }
      sheetEntryPaths.add(relationship.target);
      return {
        name: sheet.name,
        state: sheet.state,
        sheetIndex,
        relationshipId: sheet.relationshipId,
        entryPath: relationship && relationship.target ? relationship.target : null
      };
    });
    if (sheets.length === 0) {
      throw new ToolboxXlsxFormatError('xlsx 未声明任何工作表', { sourceFile });
    }

    const stylesEntry = findRelationshipEntry(
      entries,
      relationships,
      'styles',
      'xl/styles.xml',
      { sourceFile, relationshipLabel: 'styles' }
    );
    const themeEntry = findRelationshipEntry(
      entries,
      relationships,
      'theme',
      'xl/theme/theme1.xml',
      { sourceFile, relationshipLabel: 'theme' }
    );
    const sharedStringsEntry = findRelationshipEntry(
      entries,
      relationships,
      'sharedStrings',
      'xl/sharedStrings.xml',
      { sourceFile, relationshipLabel: 'sharedStrings' }
    );

    const stylesXml = stylesEntry
      ? await readToolboxMetadataEntryAsString(zip, stylesEntry, {
        sourceFile,
        partName: 'styles.xml',
        limitBytes: TOOLBOX_XLSX_METADATA_LIMITS.styles
      })
      : '';
    const themeXml = themeEntry
      ? await readToolboxMetadataEntryAsString(zip, themeEntry, {
        sourceFile,
        partName: 'theme',
        limitBytes: TOOLBOX_XLSX_METADATA_LIMITS.theme
      })
      : '';
    const sharedStrings = await loadToolboxSharedStrings(zip, sharedStringsEntry, sourceFile);
    const sourceRegistryId = options.sourceRegistryId ||
      `xlsx-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`;
    const styleResult = createSourceStyleRegistryFromOoxml({
      sourceRegistryId,
      stylesXml,
      themeXml,
      requireStylesXml: !!stylesEntry,
      requireThemeXml: !!themeEntry
    });

    return new ToolboxXlsxPass({
      filePath: absolutePath,
      sourceFile,
      zip,
      entries,
      sheets,
      date1904: workbook.date1904,
      sharedStrings,
      sourceRegistry: styleResult.registry,
      themeColors: styleResult.themeColors
    });
  } catch (error) {
    try { zip.close(); } catch (_closeError) {}
    throw error;
  }
}

module.exports = {
  TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES,
  TOOLBOX_XLSX_METADATA_LIMITS,
  ToolboxXlsxPass,
  assertToolboxSharedStringsSize,
  findRelationshipEntry,
  loadToolboxSharedStrings,
  normalizeRelationshipTarget,
  openToolboxXlsxPass,
  parseWorkbookRelationships,
  parseWorkbookXml,
  readToolboxMetadataEntryAsString
};
