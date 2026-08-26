'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const { createToolboxOutputWriter } = require('../toolbox-output-writer');
const { abortWriters } = require('../toolbox-format-operations');
const {
  TOOLBOX_GENERATION_ACTIONS,
  TOOLBOX_GENERATION_SCHEMA_VERSION,
  generationEvidencePath,
  normalizeMultiSplitInput
} = require('./generation-contract');
const { artifactFrom } = require('./generation-core');
const {
  decodeHeaderPayload,
  decodeRowPayload,
  decodeStylePayload,
  inspectSealedRouteDb,
  outputPlanHash,
  routeMaskIncludes
} = require('./route-db-contract');

function createStyleResolver(rows) {
  const registries = new Map();
  for (const item of rows) {
    if (!registries.has(item.source_registry_id)) registries.set(item.source_registry_id, []);
    const styles = registries.get(item.source_registry_id);
    if (item.style_ref !== styles.length) {
      const error = new Error('Route DB style_ref必须连续且从0开始');
      error.code = 'TOOLBOX_ROUTE_STYLE_ORDER_INVALID';
      throw error;
    }
    styles.push(decodeStylePayload(item.style_payload));
  }
  const resolver = new Map();
  for (const [sourceRegistryId, styles] of registries) {
    resolver.set(sourceRegistryId, Object.freeze({
      get(styleRef) {
        const style = styles[styleRef];
        if (!style) throw new RangeError(`未知Route DB样式引用：${styleRef}`);
        return style;
      }
    }));
  }
  return resolver;
}

async function writeOutputsFromSealedRouteDb(rawInput, signal) {
  const input = normalizeMultiSplitInput(rawInput);
  const planHash = outputPlanHash(input.operation.groups, input.generations);
  const route = inspectSealedRouteDb({
    dbPath: input.route.dbPath,
    manifestPath: input.route.manifestPath,
    expectedOutputPlanHash: planHash
  });
  if (signal && signal.aborted) {
    const error = new Error('工具箱 Route DB Writer 已取消');
    error.code = 'TOOLBOX_GENERATION_CANCELLED';
    throw error;
  }

  const db = new DatabaseSync(input.route.dbPath, { readOnly: true });
  const writers = [];
  try {
    db.exec('PRAGMA query_only=ON');
    const meta = db.prepare('SELECT header_payload FROM route_meta').get();
    const header = decodeHeaderPayload(meta && meta.header_payload);
    const styleRows = db.prepare(`
      SELECT source_registry_id, style_ref, style_payload
      FROM route_styles
      ORDER BY source_registry_id, style_ref
    `).all();
    const sourceRegistryResolver = createStyleResolver(styleRows);
    for (const generation of input.generations) {
      writers.push(createToolboxOutputWriter({
        savePath: generation.generationPath,
        outputId: generation.outputId,
        normalizedHeaders: header.normalizedHeaders,
        rawHeaderCells: header.rawHeaderCells,
        headerRow: header.headerRow,
        layoutBaseline: header.sheetMeta,
        sourceRegistryResolver,
        sheetBaseName: 'COMMON'
      }));
    }
    const statement = db.prepare(
      'SELECT source_row_index, row_payload, route_mask FROM route_rows ORDER BY source_row_index'
    );
    for (const item of statement.iterate()) {
      if (signal && signal.aborted) {
        const error = new Error('工具箱 Route DB Writer 已取消');
        error.code = 'TOOLBOX_GENERATION_CANCELLED';
        throw error;
      }
      const row = decodeRowPayload(item.row_payload);
      for (let outputIndex = 0; outputIndex < writers.length; outputIndex += 1) {
        if (routeMaskIncludes(item.route_mask, outputIndex)) writers[outputIndex].emitRow(row);
      }
    }
    const artifacts = [];
    for (let outputIndex = 0; outputIndex < writers.length; outputIndex += 1) {
      // A single Writer owns every generation path in this E04-B slice and commits in output order.
      // eslint-disable-next-line no-await-in-loop
      const result = await writers[outputIndex].commitAndValidate();
      const generation = input.generations[outputIndex];
      artifacts.push(Object.freeze({
        outputIndex,
        ...artifactFrom(
          result,
          generation,
          result.dataRowCount,
          header.normalizedHeaders
        )
      }));
    }
    return Object.freeze({
      schemaVersion: TOOLBOX_GENERATION_SCHEMA_VERSION,
      actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT,
      artifacts: Object.freeze(artifacts),
      summary: Object.freeze({
        sourceFileCount: 1,
        inputSheetCount: route.inputSheetCount,
        inputDataRowCount: route.inputDataRowCount,
        outputDataRowCount: artifacts.reduce((total, artifact) => total + artifact.dataRowCount, 0),
        skippedHiddenSheetCount: route.skippedHiddenSheetCount,
        skippedEmptySheetCount: route.skippedEmptySheetCount
      }),
      routeDb: Object.freeze({
        byteSize: route.byteSize,
        sha256: route.sha256,
        manifestArtifact: route.manifestArtifact,
        rowCount: route.rowCount,
        styleCount: route.styleCount,
        outputPlanHash: route.outputPlanHash
      })
    });
  } catch (error) {
    for (const generation of input.generations) {
      try { fs.rmSync(generationEvidencePath(generation.generationPath), { force: true }); } catch (_error) { /* best effort */ }
    }
    if (writers.length > 0) await abortWriters(writers, error);
    throw error;
  } finally {
    db.close();
  }
}

module.exports = { writeOutputsFromSealedRouteDb };
