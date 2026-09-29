'use strict';

const {
  createBaseTaskPolicy
} = require('../archive-center/task-policy-common');

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('new-account:export', 'NEWACCOUNT'),
  createBaseTaskPolicy('new-account:generate', 'NEWACCOUNT')
]);

module.exports = {
  archivePolicies
};
