'use strict';

const {
  createBaseTaskPolicy
} = require('../archive-center/task-policy-common');

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('pre-fund-reconciliation:export', 'PREFUND'),
  createBaseTaskPolicy('pre-fund-reconciliation:import-bank', 'PREFUND'),
  createBaseTaskPolicy('pre-fund-reconciliation:run', 'PREFUND'),
  createBaseTaskPolicy('pre-fund-reconciliation:temp:clear', 'PREFUND'),
  createBaseTaskPolicy('pre-fund-reconciliation:temp:delete', 'PREFUND'),
  createBaseTaskPolicy('pre-fund-reconciliation:temp:delete-by-date-range', 'PREFUND'),
  createBaseTaskPolicy('pre-fund-reconciliation:import-mpt', 'PREFUNDTEMP'),
  createBaseTaskPolicy('pre-fund-reconciliation:mpt-errors:export', 'PREFUNDTEMP'),
  createBaseTaskPolicy('pre-fund-reconciliation:mpt-errors:repair', 'PREFUNDTEMP')
]);

module.exports = {
  archivePolicies
};
