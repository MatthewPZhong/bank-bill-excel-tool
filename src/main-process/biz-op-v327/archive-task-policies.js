'use strict';

const {
  createBaseTaskPolicy
} = require('../archive-center/task-policy-common');

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('bizOpReconV327:import', 'BIZOP'),
  createBaseTaskPolicy('bizOpReconV327:run', 'BIZOP', {
    workerContext: 'operation'
  }),
  createBaseTaskPolicy('bizOpReconV327:delete', 'BIZOP', {
    workerContext: 'operation'
  }),
  createBaseTaskPolicy('bizOpReconV327:maintenance:upgrade', 'BIZOP', {
    workerContext: 'operation'
  }),
  createBaseTaskPolicy('bizOpReconV327:maintenance:reclaim', 'BIZOP', {
    workerContext: 'operation'
  }),
  createBaseTaskPolicy('bizOpReconV327:export:op-raw', 'BIZOP'),
  createBaseTaskPolicy('bizOpReconV327:export:flow-raw', 'BIZOP'),
  createBaseTaskPolicy('bizOpReconV327:export:op-check', 'BIZOP'),
  createBaseTaskPolicy('bizOpReconV327:export:flow-check', 'BIZOP'),
  createBaseTaskPolicy('bizOpReconV327:export:result-full', 'BIZOP'),
  createBaseTaskPolicy('bizOpReconV327:export:result-diff', 'BIZOP'),
  createBaseTaskPolicy('bizOpReconV327:export:errors', 'BIZOP')
]);

module.exports = {
  archivePolicies
};
