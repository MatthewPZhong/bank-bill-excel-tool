'use strict';

function createWorkerDurableCoordinatorRouter(routesInput) {
  if (!routesInput || typeof routesInput !== 'object' || Array.isArray(routesInput)) {
    throw new TypeError('WorkerDurableCoordinatorRouter routes必须是对象');
  }
  const routes = new Map(Object.entries(routesInput));

  function route(input, method) {
    const coordinator = input && routes.get(input.actionKey);
    if (!coordinator || typeof coordinator[method] !== 'function') {
      const error = new Error(`Worker-durable action缺少${method} coordinator：${input && input.actionKey}`);
      error.code = 'WORKER_DURABLE_COORDINATOR_ROUTE_MISSING';
      throw error;
    }
    return coordinator[method](input);
  }

  return Object.freeze({
    prepareAndAck(input) { return route(input, 'prepareAndAck'); },
    observeReceipt(input) { return route(input, 'observeReceipt'); },
    settleCommitted(input) { return route(input, 'settleCommitted'); },
    resolveUncertain(input) { return route(input, 'resolveUncertain'); },
    acceptNoop(input) {
      const coordinator = input && routes.get(input.actionKey);
      return coordinator && typeof coordinator.acceptNoop === 'function'
        ? coordinator.acceptNoop(input)
        : false;
    },
    awaitPersistentStateAdoption(input) {
      const coordinator = input && routes.get(input.actionKey);
      return coordinator && typeof coordinator.awaitPersistentStateAdoption === 'function'
        ? coordinator.awaitPersistentStateAdoption(input)
        : true;
    }
  });
}

module.exports = {
  createWorkerDurableCoordinatorRouter
};
