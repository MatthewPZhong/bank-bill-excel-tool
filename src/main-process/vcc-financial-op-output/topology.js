'use strict';

const {
  VCC_EXPORT_SUBJECTS_ACTION,
  VCC_EXPORT_SUBJECTS_MAX_WRITERS
} = require('./policies');

function topologyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createVccExportTopologyPlanner() {
  return function planVccExportTopology(request) {
    const generations = request && request.input && request.input.generations;
    const subjects = request && request.input && request.input.authority &&
      request.input.authority.subjects;
    if (!request || request.actionKey !== VCC_EXPORT_SUBJECTS_ACTION ||
        !Array.isArray(generations) || !Array.isArray(subjects) ||
        generations.length < 1 || generations.length !== subjects.length) {
      throw topologyError(
        'VCC_EXPORT_TOPOLOGY_INPUT_INVALID',
        'VCC export topology 必须绑定 exact subject/generation set'
      );
    }
    const minUnitsPerWriter = 2;
    return Object.freeze({
      effectiveChildCount: generations.length >= minUnitsPerWriter * VCC_EXPORT_SUBJECTS_MAX_WRITERS
        ? VCC_EXPORT_SUBJECTS_MAX_WRITERS
        : 1
    });
  };
}

module.exports = {
  createVccExportTopologyPlanner
};
