'use strict';

const {
  createBaseTaskPolicy
} = require('../archive-center/task-policy-common');

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('duplicate-inbound-match:export', 'DUPINBOUND'),
  createBaseTaskPolicy('duplicate-inbound-match:import-files', 'DUPINBOUND'),
  createBaseTaskPolicy('duplicate-inbound-match:run', 'DUPINBOUND')
]);

module.exports = {
  archivePolicies
};
