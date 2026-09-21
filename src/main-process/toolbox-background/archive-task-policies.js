'use strict';

const {
  createBaseTaskPolicy
} = require('../archive-center/task-policy-common');

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('toolbox:merge', 'TOOLBOX'),
  createBaseTaskPolicy('toolbox:split:export', 'TOOLBOX')
]);

module.exports = {
  archivePolicies
};
