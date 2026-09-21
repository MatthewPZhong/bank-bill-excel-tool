'use strict';

const {
  createBaseTaskPolicy,
  classifyKnownStatus,
  invocationBusinessRunIdentity
} = require('../archive-center/task-policy-common');

function positionResultClassifier(result) {
  return classifyKnownStatus(result, ['needs-confirmation']);
}

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('position-reconciliation:bank:apply-import', 'POSITION', {
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:bank:delete', 'POSITION', {
    workerContext: 'operation',
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:bank:export', 'POSITION', {
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:mappings:save', 'POSITION', {
    workerContext: 'operation',
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:run', 'POSITION', {
    workerContext: 'operation',
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:run:confirm', 'POSITION', {
    workerContext: 'operation',
    startsNewFlow: false,
    flowIdentityResolver: invocationBusinessRunIdentity,
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:run:export', 'POSITION', {
    startsNewFlow: false,
    flowIdentityResolver: invocationBusinessRunIdentity,
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:run:export-filtered', 'POSITION', {
    startsNewFlow: false,
    flowIdentityResolver: invocationBusinessRunIdentity,
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:run:import-result', 'POSITION', {
    startsNewFlow: false,
    flowIdentityResolver: invocationBusinessRunIdentity,
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:linked:export', 'POSITIONLINK', {
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:raw:export', 'POSITIONLINK', {
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:source:apply-import', 'POSITIONLINK', {
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:source:delete', 'POSITIONLINK', {
    workerContext: 'operation',
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:source:export-anomaly', 'POSITIONLINK', {
    resultClassifier: positionResultClassifier
  }),
  createBaseTaskPolicy('position-reconciliation:source:prepare-import', 'POSITIONLINK', {
    resultClassifier: positionResultClassifier
  })
]);

module.exports = {
  archivePolicies,
  positionResultClassifier
};
