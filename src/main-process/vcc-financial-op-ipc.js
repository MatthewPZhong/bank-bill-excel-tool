'use strict';

function vccFinancialOpErrorResult(error) {
  const sourceContext = error && error.context && typeof error.context === 'object'
    ? error.context
    : null;
  const auditFailure = error && error.auditFailure && typeof error.auditFailure === 'object'
    ? {
        name: typeof error.auditFailure.name === 'string' ? error.auditFailure.name : 'Error',
        code: error.auditFailure.code === undefined || error.auditFailure.code === null
          ? null
          : String(error.auditFailure.code),
        message: typeof error.auditFailure.message === 'string'
          ? error.auditFailure.message
          : String(error.auditFailure.message)
      }
    : null;
  const context = sourceContext || auditFailure
    ? { ...(sourceContext || {}), ...(auditFailure ? { auditFailure } : {}) }
    : null;
  const dependentMonths = error && Array.isArray(error.dependentMonths)
    ? error.dependentMonths
    : (context && context.preview && Array.isArray(context.preview.dependentMonths)
      ? context.preview.dependentMonths
      : []);
  return {
    status: 'error',
    code: error && error.code ? error.code : null,
    message: error && error.message ? error.message : String(error),
    detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : [],
    dependentMonths,
    context
  };
}

module.exports = {
  vccFinancialOpErrorResult
};
