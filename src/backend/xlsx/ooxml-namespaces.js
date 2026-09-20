'use strict';

const SPREADSHEETML_NAMESPACES = Object.freeze(new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main'
]));

const DRAWINGML_NAMESPACES = Object.freeze(new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main'
]));

const PACKAGE_RELATIONSHIP_NAMESPACES = Object.freeze(new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships'
]));

const OFFICE_RELATIONSHIP_NAMESPACES = Object.freeze(new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships'
]));

function saxAttributeValue(attribute) {
  if (attribute && typeof attribute === 'object' &&
      Object.prototype.hasOwnProperty.call(attribute, 'value')) {
    return attribute.value;
  }
  return attribute;
}

function exactSaxLocalName(nodeOrName) {
  if (nodeOrName && typeof nodeOrName === 'object' &&
      typeof nodeOrName.local === 'string') {
    return nodeOrName.local;
  }
  const qualifiedName = String(
    nodeOrName && typeof nodeOrName === 'object'
      ? nodeOrName.name || ''
      : nodeOrName || ''
  );
  const colon = qualifiedName.indexOf(':');
  return colon >= 0 ? qualifiedName.slice(colon + 1) : qualifiedName;
}

function saxAttributeIdentity(rawName, rawAttribute) {
  const qualifiedName = String(
    rawAttribute && typeof rawAttribute === 'object' && rawAttribute.name
      ? rawAttribute.name
      : rawName
  );
  const colon = qualifiedName.indexOf(':');
  const prefix = rawAttribute && typeof rawAttribute === 'object' &&
    typeof rawAttribute.prefix === 'string'
    ? rawAttribute.prefix
    : (colon >= 0 ? qualifiedName.slice(0, colon) : '');
  const localName = rawAttribute && typeof rawAttribute === 'object' &&
    typeof rawAttribute.local === 'string'
    ? rawAttribute.local
    : (colon >= 0 ? qualifiedName.slice(colon + 1) : qualifiedName);
  return {
    qualifiedName,
    prefix,
    localName,
    uri: rawAttribute && typeof rawAttribute === 'object'
      ? String(rawAttribute.uri || '')
      : '',
    value: saxAttributeValue(rawAttribute),
    namespaceDeclaration: qualifiedName === 'xmlns' || prefix === 'xmlns'
  };
}

function normalizedSaxAttributes(attributes = {}) {
  const output = {};
  for (const [rawName, rawAttribute] of Object.entries(attributes || {})) {
    const name = rawAttribute && typeof rawAttribute === 'object' && rawAttribute.name
      ? rawAttribute.name
      : rawName;
    output[String(name).toLowerCase()] = saxAttributeValue(rawAttribute);
  }
  return output;
}

function saxAttributeRecord(attributes = {}, qualifiedName) {
  const expected = String(qualifiedName || '').toLowerCase();
  for (const [rawName, rawAttribute] of Object.entries(attributes || {})) {
    const name = rawAttribute && typeof rawAttribute === 'object' && rawAttribute.name
      ? rawAttribute.name
      : rawName;
    if (String(name).toLowerCase() === expected) return rawAttribute;
  }
  return null;
}

function namespaceAllowed(uri, allowedNamespaces) {
  return !!allowedNamespaces && allowedNamespaces.has(String(uri || ''));
}

module.exports = {
  DRAWINGML_NAMESPACES,
  OFFICE_RELATIONSHIP_NAMESPACES,
  PACKAGE_RELATIONSHIP_NAMESPACES,
  SPREADSHEETML_NAMESPACES,
  exactSaxLocalName,
  namespaceAllowed,
  normalizedSaxAttributes,
  saxAttributeIdentity,
  saxAttributeRecord,
  saxAttributeValue
};
