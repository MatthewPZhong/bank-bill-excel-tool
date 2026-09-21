'use strict';

const {
  createBaseTaskPolicy
} = require('../archive-center/task-policy-common');

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('recon-id-fix:clear-session', 'RECONFIX'),
  createBaseTaskPolicy('recon-id-fix:export', 'RECONFIX'),
  createBaseTaskPolicy('recon-id-fix:import', 'RECONFIX'),
  createBaseTaskPolicy('recon-id-fix:run', 'RECONFIX')
]);

module.exports = {
  archivePolicies
};
