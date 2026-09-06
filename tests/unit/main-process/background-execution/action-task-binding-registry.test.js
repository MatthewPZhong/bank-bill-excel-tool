'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const espree = require('espree');

const {
  ACTION_TASK_BINDING_CONTRACT,
  ActionTaskBindingRegistryError,
  bindingDigest,
  bindingSnapshot,
  createActionTaskBindingRegistry,
  initializeActionTaskBindingRegistry,
  initializeActionTaskBindingStartup,
  validateBindingAuthority
} = require('../../../../src/main-process/background-execution/action-task-binding-registry');
const backgroundExecution = require('../../../../src/main-process/background-execution');
const {
  createTaskPolicyRegistry
} = require('../../../../src/main-process/archive-center/task-policy-registry');

function mutableTaskPolicies() {
  return createTaskPolicyRegistry().list().map((policy) => ({ ...policy }));
}

function fakeTaskPolicyRegistry(policies, onList = () => {}) {
  return Object.freeze({
    list() {
      onList();
      return policies;
    }
  });
}

function realTaskPolicyHost() {
  const registry = createTaskPolicyRegistry();
  return Object.freeze({ list: registry.list.bind(registry) });
}

function expectCode(code) {
  return (error) => error instanceof ActionTaskBindingRegistryError && error.code === code;
}

function replacePolicyIdentity(policies, from, to) {
  const policy = policies.find((item) => item.channel === from);
  assert.ok(policy, `missing test policy ${from}`);
  policy.channel = to;
  policy.taskKey = to;
}

test('生产 authority 一次读取真实 TaskPolicy list 并冻结 66-action inventory digest', () => {
  let listCalls = 0;
  const policies = mutableTaskPolicies();
  const registry = createActionTaskBindingRegistry({
    taskPolicyRegistry: fakeTaskPolicyRegistry(policies, () => { listCalls += 1; })
  });

  assert.equal(listCalls, 1);
  assert.equal(registry.summary.actionKeys.length, 66);
  assert.equal(registry.summary.taskPolicyInventory.length, 134);
  assert.equal(registry.summary.pairCount, 73);
  assert.equal(registry.summary.boundTaskKeyCount, 66);
  assert.equal(registry.summary.unboundTaskPolicyCount, 68);
  assert.equal(
    registry.summary.taskPolicyInventory.filter(
      (taskKey) => !bindingSnapshotValues().has(taskKey)
    ).length,
    registry.summary.unboundTaskPolicyCount
  );
  assert.equal(
    registry.summary.taskPolicyInventorySha256,
    '6912c045c82d260fbe554732e886f4da9fafe01e4f3e64f8dc3b0c870055a773'
  );
  assert.equal(registry.summary.sha256, ACTION_TASK_BINDING_CONTRACT.sha256);
  assert.equal(Object.isFrozen(registry.summary), true);
  assert.equal(Object.isFrozen(registry.summary.taskPolicyInventory), true);
  assert.equal(bindingDigest(), ACTION_TASK_BINDING_CONTRACT.sha256);
});

function bindingSnapshotValues() {
  return new Set(Object.values(bindingSnapshot()).flat());
}

test('factory 不接受 caller binding authority，包括 enumerable 与 hidden 注入', () => {
  const taskPolicyRegistry = createTaskPolicyRegistry();
  assert.throws(
    () => createActionTaskBindingRegistry({ taskPolicyRegistry, bindings: {} }),
    expectCode('ACTION_TASK_BINDING_OPTIONS_INVALID')
  );

  const hidden = { taskPolicyRegistry };
  Object.defineProperty(hidden, 'bindings', {
    value: { 'hidden:action': ['hidden:task'] },
    enumerable: false
  });
  assert.throws(
    () => createActionTaskBindingRegistry(hidden),
    expectCode('ACTION_TASK_BINDING_OPTIONS_INVALID')
  );
  assert.throws(
    () => bindingDigest(bindingSnapshot()),
    expectCode('ACTION_TASK_BINDING_AUTHORITY_REPLACEMENT_FORBIDDEN')
  );
});

test('factory/TaskPolicy hostile Proxy 与 accessor 在真实 Node API 路径稳定拒绝', () => {
  const taskPolicyRegistry = fakeTaskPolicyRegistry(mutableTaskPolicies());
  assert.throws(
    () => createActionTaskBindingRegistry(new Proxy({ taskPolicyRegistry }, {})),
    expectCode('ACTION_TASK_BINDING_OPTIONS_INVALID')
  );
  assert.throws(
    () => createActionTaskBindingRegistry({
      taskPolicyRegistry: new Proxy(taskPolicyRegistry, {})
    }),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_REGISTRY_HOST_INVALID')
  );

  const proxiedPolicies = mutableTaskPolicies();
  proxiedPolicies[0] = new Proxy(proxiedPolicies[0], {});
  assert.throws(
    () => createActionTaskBindingRegistry({
      taskPolicyRegistry: fakeTaskPolicyRegistry(proxiedPolicies)
    }),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_DESCRIPTOR_INVALID')
  );

  let taskKeyReads = 0;
  const accessorPolicies = mutableTaskPolicies();
  const target = accessorPolicies.find((policy) => policy.channel === 'monthly-balance:export');
  const stableTaskKey = target.taskKey;
  Object.defineProperty(target, 'taskKey', {
    enumerable: true,
    configurable: true,
    get() {
      taskKeyReads += 1;
      return taskKeyReads < 4 ? stableTaskKey : 'wrong-on-fourth-read';
    }
  });
  assert.throws(
    () => createActionTaskBindingRegistry({
      taskPolicyRegistry: fakeTaskPolicyRegistry(accessorPolicies)
    }),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_DESCRIPTOR_INVALID')
  );
  assert.equal(taskKeyReads, 0);
});

test('initializer 只接受 frozen exact plain registry host，拒绝 Map、array prototype 与可变 host', () => {
  const policies = mutableTaskPolicies();
  assert.throws(
    () => initializeActionTaskBindingRegistry({ list: () => policies }),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_REGISTRY_HOST_INVALID')
  );
  const mapHost = Object.freeze(new Map([['list', () => policies]]));
  assert.throws(
    () => initializeActionTaskBindingRegistry(mapHost),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_REGISTRY_HOST_INVALID')
  );
  const replacedPrototypeHost = { list: () => policies };
  Object.setPrototypeOf(replacedPrototypeHost, []);
  Object.freeze(replacedPrototypeHost);
  assert.throws(
    () => initializeActionTaskBindingRegistry(replacedPrototypeHost),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_REGISTRY_HOST_INVALID')
  );
});

test('list 抛出的 hostile message accessor 不被读取且包装为稳定 cause-safe 错误', () => {
  let messageReads = 0;
  const hostileCause = {};
  Object.defineProperty(hostileCause, 'message', {
    get() {
      messageReads += 1;
      throw new Error('message getter 不得执行');
    }
  });
  const host = Object.freeze({
    list() {
      throw hostileCause;
    }
  });
  assert.throws(
    () => initializeActionTaskBindingRegistry(host),
    (error) => {
      assert.equal(error instanceof ActionTaskBindingRegistryError, true);
      assert.equal(error.code, 'ACTION_TASK_BINDING_TASK_POLICY_LIST_FAILED');
      assert.equal(error.message, 'TaskPolicyRegistry.list() 执行失败');
      assert.deepEqual(error.details, { cause: 'UNTRUSTED_CAUSE_SUPPRESSED' });
      return true;
    }
  );
  assert.equal(messageReads, 0);
});

test('non-enumerable/symbol/sparse TaskPolicy list data fail closed', () => {
  const hiddenPolicy = mutableTaskPolicies();
  Object.defineProperty(hiddenPolicy[0], 'hiddenAction', {
    value: 'hidden:action',
    enumerable: false
  });
  assert.throws(
    () => validateBindingAuthority(fakeTaskPolicyRegistry(hiddenPolicy)),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_DESCRIPTOR_INVALID')
  );

  const symbolPolicy = mutableTaskPolicies();
  symbolPolicy[0][Symbol('hidden')] = 'hidden:action';
  assert.throws(
    () => validateBindingAuthority(fakeTaskPolicyRegistry(symbolPolicy)),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_DESCRIPTOR_INVALID')
  );

  const sparsePolicies = mutableTaskPolicies();
  delete sparsePolicies[3];
  assert.throws(
    () => validateBindingAuthority(fakeTaskPolicyRegistry(sparsePolicies)),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_LIST_INVALID')
  );
});

test('构造后 caller object/array mutation 与 allowedTaskKeys 返回数组 mutation 均不能改 authority', () => {
  const policies = mutableTaskPolicies();
  const registry = createActionTaskBindingRegistry({
    taskPolicyRegistry: fakeTaskPolicyRegistry(policies)
  });
  const originalPolicy = policies.find((policy) => policy.channel === 'monthly-balance:export');
  originalPolicy.taskKey = 'mutated-after-construction';
  policies.length = 0;

  assert.deepEqual(
    registry.assertPair('statement:generate-all', 'monthly-balance:export'),
    { actionKey: 'statement:generate-all', expectedTaskKey: 'monthly-balance:export' }
  );
  const first = registry.allowedTaskKeys('statement:generate-all');
  const second = registry.allowedTaskKeys('statement:generate-all');
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => first.push('bankBuRecon:run'), TypeError);
  assert.deepEqual(second, ['monthly-balance:assemble', 'monthly-balance:export']);

  const snapshotA = bindingSnapshot();
  const snapshotB = bindingSnapshot();
  assert.notEqual(snapshotA, snapshotB);
  assert.notEqual(snapshotA['statement:generate-all'], snapshotB['statement:generate-all']);
  assert.equal(Object.isFrozen(snapshotA), true);
  assert.equal(Object.isFrozen(snapshotA['statement:generate-all']), true);
});

test('assertPair 只接受 exact pair，missing/empty/mismatch 与交换 bank-bu pair fail closed', () => {
  const registry = initializeActionTaskBindingRegistry(realTaskPolicyHost());
  assert.deepEqual(
    registry.assertPair('statement:generate-all', 'monthly-balance:export'),
    { actionKey: 'statement:generate-all', expectedTaskKey: 'monthly-balance:export' }
  );
  assert.throws(
    () => registry.assertPair('missing:action', 'monthly-balance:export'),
    expectCode('ACTION_TASK_BINDING_ACTION_UNKNOWN')
  );
  assert.throws(
    () => registry.assertPair('background-execution:canary', ''),
    expectCode('ACTION_TASK_BINDING_TASK_KEY_REQUIRED')
  );
  assert.throws(
    () => registry.assertPair('statement:generate-all', 'bankBuRecon:run'),
    expectCode('ACTION_TASK_BINDING_PAIR_REJECTED')
  );
  assert.throws(
    () => registry.assertPair('bank-bu:export-aggregate', 'bankBuRecon:export:single'),
    expectCode('ACTION_TASK_BINDING_PAIR_REJECTED')
  );
});

test('assertPair non-string hostile identity 不读取、不插值且返回稳定错误 code', () => {
  const registry = initializeActionTaskBindingRegistry(realTaskPolicyHost());
  let primitiveReads = 0;
  const hostileObject = {
    [Symbol.toPrimitive]() {
      primitiveReads += 1;
      throw new Error('hostile identity 不得 coercion');
    }
  };
  let proxyReads = 0;
  const hostileProxy = new Proxy({}, {
    get() {
      proxyReads += 1;
      throw new Error('hostile identity 不得读取');
    }
  });

  for (const hostileAction of [hostileObject, hostileProxy, Symbol('action')]) {
    assert.throws(
      () => registry.assertPair(hostileAction, 'monthly-balance:export'),
      expectCode('ACTION_TASK_BINDING_ACTION_TYPE_INVALID')
    );
  }
  for (const hostileTaskKey of [hostileObject, hostileProxy, Symbol('task')]) {
    assert.throws(
      () => registry.assertPair('statement:generate-all', hostileTaskKey),
      expectCode('ACTION_TASK_BINDING_TASK_KEY_TYPE_INVALID')
    );
  }
  assert.equal(primitiveReads, 0);
  assert.equal(proxyReads, 0);
});

test('one-to-many authority 的全部真实 pair 接受且返回值不暴露内部 Set', () => {
  const registry = initializeActionTaskBindingRegistry(realTaskPolicyHost());
  const expected = [
    'position-reconciliation:bank:apply-import',
    'position-reconciliation:run:import-result',
    'position-reconciliation:source:apply-import',
    'position-reconciliation:source:prepare-import'
  ];
  assert.deepEqual(registry.allowedTaskKeys('position:import'), expected);
  for (const taskKey of expected) {
    assert.equal(registry.assertPair('position:import', taskKey).expectedTaskKey, taskKey);
  }
});

test('真实 inventory taskKey/channel mismatch 与 duplicate 均给稳定结构化错误', () => {
  const mismatch = mutableTaskPolicies();
  mismatch.find((policy) => policy.channel === 'account-mapping:save').taskKey = 'wrong:key';
  assert.throws(
    () => initializeActionTaskBindingRegistry(fakeTaskPolicyRegistry(mismatch)),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_IDENTITY_MISMATCH')
  );

  const duplicate = mutableTaskPolicies();
  replacePolicyIdentity(duplicate, 'balance-adjustment:save', 'account-mapping:save');
  assert.throws(
    () => initializeActionTaskBindingRegistry(fakeTaskPolicyRegistry(duplicate)),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_DUPLICATE')
  );
});

test('等数量 unbound substitution 由冻结134-key digest拒绝', () => {
  const policies = mutableTaskPolicies();
  replacePolicyIdentity(
    policies,
    'account-mapping:save',
    'account-mapping:equal-size-unbound-substitution'
  );
  assert.equal(
    policies.filter((policy) => ['reserve', 'no-file'].includes(policy.batchPolicy)).length,
    134
  );
  assert.throws(
    () => initializeActionTaskBindingRegistry(fakeTaskPolicyRegistry(policies)),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_INVENTORY_DIGEST_MISMATCH')
  );
});

test('bound TaskPolicy 缺失即使 inventory 等数量也在 digest 前 fail closed', () => {
  const policies = mutableTaskPolicies();
  replacePolicyIdentity(
    policies,
    'monthly-balance:export',
    'monthly-balance:unbound-replacement'
  );
  assert.throws(
    () => initializeActionTaskBindingRegistry(fakeTaskPolicyRegistry(policies)),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_MISSING')
  );
});

function mainStartupAstErrors(source) {
  const ast = espree.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    range: true
  });
  const nodes = [];
  const parents = new Map();
  const visit = (node, parent = null) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (typeof node.type === 'string') {
      nodes.push(node);
      if (parent) parents.set(node, parent);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'parent' && key !== 'range') visit(value, node);
    }
  };
  visit(ast);
  const errors = [];
  const identifier = (node, name) => node && node.type === 'Identifier' && node.name === name;
  const member = (node, objectName, propertyName) => node
    && node.type === 'MemberExpression'
    && !node.computed
    && identifier(node.object, objectName)
    && identifier(node.property, propertyName);
  const calls = (name) => nodes.filter((node) => (
    node.type === 'CallExpression'
    && identifier(node.callee, name)
  ));
  const patternNames = (pattern, found = []) => {
    if (!pattern) return found;
    if (pattern.type === 'Identifier') found.push(pattern.name);
    else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        patternNames(property.type === 'RestElement' ? property.argument : property.value, found);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const item of pattern.elements) patternNames(item, found);
    } else if (pattern.type === 'AssignmentPattern') {
      patternNames(pattern.left, found);
    } else if (pattern.type === 'RestElement') {
      patternNames(pattern.argument, found);
    }
    return found;
  };
  const declaredNames = [];
  for (const node of nodes) {
    if (node.type === 'VariableDeclarator') patternNames(node.id, declaredNames);
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      if (node.id) patternNames(node.id, declaredNames);
      for (const parameter of node.params) patternNames(parameter, declaredNames);
    }
    if (node.type === 'CatchClause') patternNames(node.param, declaredNames);
    if (node.type === 'ClassDeclaration' && node.id) patternNames(node.id, declaredNames);
  }
  const reassigned = (name) => nodes.some((node) => (
    node.type === 'AssignmentExpression' && patternNames(node.left, []).includes(name)
  ) || (
    node.type === 'UpdateExpression' && identifier(node.argument, name)
  ));
  const directDeclarator = (name) => ast.body.flatMap((statement) => (
    statement.type === 'VariableDeclaration' ? statement.declarations : []
  )).filter((declaration) => declaration.id.type === 'Identifier' && declaration.id.name === name);
  const directCall = (name, callee) => {
    const declarations = directDeclarator(name);
    if (declarations.length !== 1) return null;
    const init = declarations[0].init;
    return init && init.type === 'CallExpression' && identifier(init.callee, callee)
      ? init
      : null;
  };

  const bindingModulePath = './main-process/background-execution/action-task-binding-registry';
  const bindingRequireCalls = nodes.filter((node) => node.type === 'CallExpression'
    && identifier(node.callee, 'require')
    && node.arguments.length === 1
    && node.arguments[0].type === 'Literal'
    && node.arguments[0].value === bindingModulePath);
  const bindingRequireDeclarations = ast.body.filter((statement) => (
    statement.type === 'VariableDeclaration'
    && statement.kind === 'const'
    && statement.declarations.length === 1
  )).flatMap((statement) => statement.declarations).filter((declaration) => (
    declaration.id.type === 'ObjectPattern'
    && declaration.id.properties.length === 1
    && declaration.id.properties[0].type === 'Property'
    && identifier(declaration.id.properties[0].key, 'initializeActionTaskBindingStartup')
    && identifier(declaration.id.properties[0].value, 'initializeActionTaskBindingStartup')
    && declaration.init
    && bindingRequireCalls.includes(declaration.init)
  ));
  const bindingImportStatement = bindingRequireDeclarations.length === 1
    ? parents.get(bindingRequireDeclarations[0])
    : null;
  if (bindingRequireCalls.length !== 1 || bindingRequireDeclarations.length !== 1) {
    errors.push('production binding exact top-level require');
  }
  const programDeclaredNames = ast.body.flatMap((statement) => {
    if (statement.type === 'VariableDeclaration') {
      return statement.declarations.flatMap((declaration) => patternNames(declaration.id, []));
    }
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(statement.type) && statement.id) {
      return [statement.id.name];
    }
    return [];
  });
  if (['require', 'module', 'arguments'].some((name) => programDeclaredNames.includes(name))) {
    errors.push('CommonJS wrapper loader bindings must not be shadowed');
  }
  if (bindingImportStatement?.type === 'VariableDeclaration') {
    const bootstrapNodes = nodes.filter((node) => Array.isArray(node.range)
      && node.range[0] < bindingImportStatement.range[0]);
    const loaderAliases = new Set(['require', 'module', 'arguments']);
    const moduleNamespaceRequire = (node) => node?.type === 'CallExpression'
      && identifier(node.callee, 'require')
      && node.arguments.length === 1
      && node.arguments[0].type === 'Literal'
      && ['module', 'node:module'].includes(node.arguments[0].value);
    const staticPropertyName = (node) => {
      if (!node || node.type !== 'MemberExpression') return null;
      if (!node.computed && node.property.type === 'Identifier') return node.property.name;
      if (node.computed && node.property.type === 'Literal'
          && typeof node.property.value === 'string') return node.property.value;
      return null;
    };
    const sensitiveValue = (node) => {
      if (!node) return false;
      if (node.type === 'ChainExpression') return sensitiveValue(node.expression);
      if (node.type === 'Identifier') return loaderAliases.has(node.name);
      if (node.type === 'MemberExpression') {
        return sensitiveValue(node.object) || moduleNamespaceRequire(node.object);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = staticPropertyName(node.callee);
        return ['bind', 'createRequire'].includes(method)
          && sensitiveValue(node.callee.object);
      }
      return moduleNamespaceRequire(node);
    };
    let aliasChanged = true;
    while (aliasChanged) {
      aliasChanged = false;
      for (const node of bootstrapNodes) {
        let names = [];
        let sourceValue = null;
        if (node.type === 'VariableDeclarator') {
          names = patternNames(node.id, []);
          sourceValue = node.init;
        } else if (node.type === 'AssignmentExpression') {
          names = patternNames(node.left, []);
          sourceValue = node.right;
        }
        if (!names.length || (!sensitiveValue(sourceValue)
          && !moduleNamespaceRequire(sourceValue))) continue;
        for (const name of names) {
          if (!loaderAliases.has(name)) {
            loaderAliases.add(name);
            aliasChanged = true;
          }
        }
      }
    }
    const targetSensitive = (target) => sensitiveValue(target)
      || patternNames(target, []).some((name) => loaderAliases.has(name));
    const loaderMutatorCall = (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') {
        return false;
      }
      const method = staticPropertyName(node.callee);
      if (identifier(node.callee.object, 'Object')
          && ['assign', 'defineProperties', 'defineProperty', 'setPrototypeOf'].includes(method)) {
        return sensitiveValue(node.arguments[0]);
      }
      if (identifier(node.callee.object, 'Reflect')
          && ['defineProperty', 'deleteProperty', 'set', 'setPrototypeOf'].includes(method)) {
        return sensitiveValue(node.arguments[0]);
      }
      return ['__defineGetter__', '__defineSetter__'].includes(method)
        && sensitiveValue(node.callee.object);
    };
    const loaderBootstrapMutation = bootstrapNodes.some((node) => {
      if (node.type === 'VariableDeclarator') {
        return sensitiveValue(node.init) && !moduleNamespaceRequire(node.init);
      }
      if (node.type === 'AssignmentExpression') {
        return targetSensitive(node.left) || sensitiveValue(node.right);
      }
      if (node.type === 'UpdateExpression') return targetSensitive(node.argument);
      if (node.type === 'UnaryExpression' && node.operator === 'delete') {
        return targetSensitive(node.argument);
      }
      return loaderMutatorCall(node);
    });
    if (loaderBootstrapMutation) {
      errors.push('CommonJS loader/cache/module identity immutable before production import');
    }
  }
  if (declaredNames.filter((name) => name === 'initializeActionTaskBindingStartup').length !== 1
      || declaredNames.filter((name) => name === 'runActionTaskBindingStartup').length !== 1
      || reassigned('initializeActionTaskBindingStartup')
      || reassigned('runActionTaskBindingStartup')) {
    errors.push('production binding identifiers unshadowed and immutable');
  }
  const frozenObject = (node, expected) => {
    if (!node || node.type !== 'CallExpression'
        || node.callee.type !== 'MemberExpression'
        || !identifier(node.callee.object, 'Object')
        || !identifier(node.callee.property, 'freeze')
        || node.arguments.length !== 1
        || node.arguments[0].type !== 'ObjectExpression') return false;
    const properties = node.arguments[0].properties;
    if (properties.length !== Object.keys(expected).length) return false;
    return properties.every((property) => property.type === 'Property'
      && !property.computed
      && property.kind === 'init'
      && identifier(property.key, property.key.name)
      && Object.prototype.hasOwnProperty.call(expected, property.key.name)
      && identifier(property.value, expected[property.key.name]));
  };
  const frozenTaskPolicyHost = (node) => {
    if (!node || node.type !== 'CallExpression'
        || node.callee.type !== 'MemberExpression'
        || !identifier(node.callee.object, 'Object')
        || !identifier(node.callee.property, 'freeze')
        || node.arguments.length !== 1
        || node.arguments[0].type !== 'ObjectExpression'
        || node.arguments[0].properties.length !== 1) return false;
    const property = node.arguments[0].properties[0];
    const bindCall = property.value;
    return property.type === 'Property'
      && identifier(property.key, 'list')
      && bindCall.type === 'CallExpression'
      && bindCall.callee.type === 'MemberExpression'
      && identifier(bindCall.callee.property, 'bind')
      && bindCall.callee.object.type === 'MemberExpression'
      && identifier(bindCall.callee.object.object, 'taskPolicyRegistry')
      && identifier(bindCall.callee.object.property, 'list')
      && bindCall.arguments.length === 1
      && identifier(bindCall.arguments[0], 'taskPolicyRegistry');
  };

  const policyCall = directCall('taskPolicyRegistry', 'createTaskPolicyRegistry');
  const startupDeclarations = ast.body.flatMap((statement) => (
    statement.type === 'VariableDeclaration' ? statement.declarations : []
  )).filter((declaration) => declaration.id.type === 'ObjectPattern'
    && declaration.id.properties.length === 2
    && declaration.id.properties.some((property) => (
      identifier(property.key, 'actionTaskBindingRegistry')
      && identifier(property.value, 'actionTaskBindingRegistry')
    ))
    && declaration.id.properties.some((property) => (
      identifier(property.key, 'run')
      && identifier(property.value, 'runActionTaskBindingStartup')
    )));
  const startupCall = startupDeclarations.length === 1
    && startupDeclarations[0].init.type === 'CallExpression'
    && identifier(
      startupDeclarations[0].init.callee,
      'initializeActionTaskBindingStartup'
    )
    ? startupDeclarations[0].init
    : null;
  const hostDeclarations = directDeclarator('taskPolicyBindingHost');
  if (!policyCall || policyCall.arguments.length !== 0) errors.push('policy direct call');
  if (hostDeclarations.length !== 1
      || !frozenTaskPolicyHost(hostDeclarations[0].init)) {
    errors.push('host direct exact declaration');
  }
  if (!startupCall
      || startupCall.arguments.length !== 2
      || !identifier(startupCall.arguments[0], 'taskPolicyBindingHost')
      || !frozenObject(startupCall.arguments[1], {
        initializeDatabase: 'initializeApplication',
        registerIpc: 'registerAllIpcHandlers'
      })) errors.push('startup direct exact call');
  if (startupDeclarations.length !== 1) {
    errors.push('startup registry retained');
  }
  if (calls('createTaskPolicyRegistry').length !== 1
      || calls('initializeActionTaskBindingStartup').length !== 1
      || calls('initializeActionTaskBindingRegistry').length !== 0) {
    errors.push('initializer call uniqueness');
  }
  const runCalls = calls('runActionTaskBindingStartup');
  if (runCalls.length !== 1 || parents.get(runCalls[0])?.type !== 'AwaitExpression') {
    errors.push('startup run unique awaited use');
  }
  const readyIfStatements = ast.body.filter((statement) => (
    statement.type === 'IfStatement' && identifier(statement.test, 'hasSingleInstanceLock')
  ));
  let successCallback = null;
  if (readyIfStatements.length === 1
      && readyIfStatements[0].consequent.type === 'ExpressionStatement') {
    const catchCall = readyIfStatements[0].consequent.expression;
    const thenCall = catchCall?.type === 'CallExpression'
      && catchCall.callee.type === 'MemberExpression'
      && !catchCall.callee.computed
      && identifier(catchCall.callee.property, 'catch')
      ? catchCall.callee.object
      : null;
    const readyCall = thenCall?.type === 'CallExpression'
      && thenCall.callee.type === 'MemberExpression'
      && !thenCall.callee.computed
      && identifier(thenCall.callee.property, 'then')
      ? thenCall.callee.object
      : null;
    const callback = thenCall?.arguments?.[0];
    if (catchCall?.arguments?.length === 1
        && thenCall?.arguments?.length === 1
        && readyCall?.type === 'CallExpression'
        && member(readyCall.callee, 'app', 'whenReady')
        && readyCall.arguments.length === 0
        && callback?.type === 'ArrowFunctionExpression'
        && callback.async
        && callback.params.length === 0
        && callback.body.type === 'BlockStatement') {
      successCallback = callback;
    }
  }
  if (!successCallback || nodes.filter((node) => (
    node.type === 'CallExpression' && member(node.callee, 'app', 'whenReady')
  )).length !== 1) {
    errors.push('unique top-level app.whenReady success callback');
  }
  const runCall = runCalls.length === 1 ? runCalls[0] : null;
  const runAwait = runCall ? parents.get(runCall) : null;
  const runStatement = runAwait ? parents.get(runAwait) : null;
  const runBlock = runStatement ? parents.get(runStatement) : null;
  const startupTry = runBlock ? parents.get(runBlock) : null;
  const callbackBlock = startupTry ? parents.get(startupTry) : null;
  const rethrowsStartupError = startupTry?.type === 'TryStatement'
    && startupTry.finalizer === null
    && startupTry.handler?.param?.type === 'Identifier'
    && startupTry.handler.body.body.at(-1)?.type === 'ThrowStatement'
    && identifier(
      startupTry.handler.body.body.at(-1).argument,
      startupTry.handler.param.name
    );
  if (!runCall
      || runStatement?.type !== 'ExpressionStatement'
      || runBlock?.type !== 'BlockStatement'
      || startupTry?.type !== 'TryStatement'
      || startupTry.block !== runBlock
      || callbackBlock !== successCallback?.body
      || !rethrowsStartupError) {
    errors.push('startup run direct in rethrowing whenReady success path');
  }
  const nearestFunction = (node) => {
    let current = parents.get(node);
    while (current && ![
      'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'
    ].includes(current.type)) current = parents.get(current);
    return current;
  };
  const isolatedPackagedCanaryReturn = (node) => {
    const block = parents.get(node);
    const guard = parents.get(block);
    return block?.type === 'BlockStatement'
      && guard?.type === 'IfStatement'
      && guard.consequent === block
      && guard.alternate === null
      && identifier(guard.test, 'packagedRuntimeModeSelected')
      && parents.get(guard) === successCallback?.body;
  };
  if (runCall && successCallback && nodes.some((node) => (
    node.type === 'ReturnStatement'
    && node.range[0] < runCall.range[0]
    && nearestFunction(node) === successCallback
    && !isolatedPackagedCanaryReturn(node)
  ))) {
    errors.push('startup run follows early return');
  }
  const databaseCalls = nodes.filter((node) => node.type === 'NewExpression'
    && identifier(node.callee, 'AppDatabase'));
  const rawIpcCalls = calls('registerAllIpcHandlers');
  const createWindowCalls = calls('createWindow').filter((call) => (
    call.arguments.length === 1
    && call.arguments[0].type === 'ObjectExpression'
    && call.arguments[0].properties.some((property) => (
      identifier(property.key, 'instrumentation')
      && property.value.type === 'Literal'
      && property.value.value === 'initial'
    ))
  ));
  if (databaseCalls.length !== 1 || rawIpcCalls.length !== 0) {
    errors.push('database/ipc continuation ownership');
  }
  if (startupCall && databaseCalls[0] && startupCall.range[1] >= databaseCalls[0].range[0]) {
    errors.push('binding source order before database');
  }
  const createWindowStatement = createWindowCalls.length === 1
    ? parents.get(parents.get(createWindowCalls[0]))
    : null;
  if (runCall && (createWindowCalls.length !== 1
      || createWindowStatement?.type !== 'ExpressionStatement'
      || parents.get(createWindowStatement) !== runBlock
      || runCall.range[0] >= createWindowCalls[0].range[0])) {
    errors.push('startup run before window');
  }
  return errors;
}

function proveMainUsesRealBindingLoader(mainSource, mainPath) {
  const importPattern = /^const \{ initializeActionTaskBindingStartup \} = require\('\.\/main-process\/background-execution\/action-task-binding-registry'\);$/gm;
  const importStatements = [...mainSource.matchAll(importPattern)].map((match) => match[0]);
  if (importStatements.length !== 1) return false;
  const proofFilename = `${mainPath}.action-task-binding-loader-proof.cjs`;
  const proofModule = new Module(proofFilename, module);
  proofModule.filename = proofFilename;
  proofModule.paths = Module._nodeModulePaths(path.dirname(mainPath));
  const loadedRequests = [];
  const realRequire = proofModule.require.bind(proofModule);
  proofModule.require = (request) => {
    loadedRequests.push(request);
    return realRequire(request);
  };
  proofModule._compile(
    `'use strict';\n${importStatements[0]}\nmodule.exports = initializeActionTaskBindingStartup;`,
    proofFilename
  );
  return loadedRequests.length === 1
    && loadedRequests[0]
      === './main-process/background-execution/action-task-binding-registry'
    && proofModule.exports === initializeActionTaskBindingStartup;
}

test('barrel export 与 Main Program.body startup reachability 使用同一 production seam', () => {
  assert.equal(
    backgroundExecution.initializeActionTaskBindingRegistry,
    initializeActionTaskBindingRegistry
  );
  assert.equal(
    backgroundExecution.initializeActionTaskBindingStartup,
    initializeActionTaskBindingStartup
  );
  assert.equal(typeof backgroundExecution.bindingSnapshot, 'function');
  assert.equal('ACTION_TASK_BINDINGS' in backgroundExecution, false);

  const invalid = mutableTaskPolicies();
  replacePolicyIdentity(invalid, 'monthly-balance:export', 'monthly-balance:missing-bound');
  assert.throws(
    () => backgroundExecution.initializeActionTaskBindingRegistry(
      fakeTaskPolicyRegistry(invalid)
    ),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_MISSING')
  );

  const mainPath = path.resolve(__dirname, '../../../../src/main.js');
  const mainSource = fs.readFileSync(mainPath, 'utf8');
  assert.deepEqual(mainStartupAstErrors(mainSource), []);
  assert.equal(proveMainUsesRealBindingLoader(mainSource, mainPath), true);

  const startupBlock = mainSource.match(
    /const \{ actionTaskBindingRegistry, run: runActionTaskBindingStartup \} = initializeActionTaskBindingStartup\([^\n]+\);/
  );
  assert.ok(startupBlock);
  const bindingImport = "const { initializeActionTaskBindingStartup } = require('./main-process/background-execution/action-task-binding-registry');";
  const fakeBindingLoader = "(modulePath) => modulePath === './main-process/background-execution/action-task-binding-registry' ? { initializeActionTaskBindingStartup: () => ({ actionTaskBindingRegistry: Object.freeze({}), run: async () => {} }) } : originalBindingRequire(modulePath)";
  const fakeBindingExport = "{ exports: { initializeActionTaskBindingStartup: () => ({ actionTaskBindingRegistry: Object.freeze({}), run: async () => {} }) } }";
  const mutants = {
    'conditional-initializer': mainSource.replace(startupBlock[0], `if (false) {\n${startupBlock[0]}\n}`),
    'initializer-in-early-return-function': mainSource.replace(
      startupBlock[0],
      `function unreachableBindingStartup() {\n  return;\n${startupBlock[0]}\n}`
    ),
    'initializer-in-swallowed-try-catch': mainSource.replace(
      startupBlock[0],
      `try {\n${startupBlock[0]}\n} catch (_error) {}`
    ),
    'duplicate-initializer': mainSource.replace(
      startupBlock[0],
      `${startupBlock[0]}\ninitializeActionTaskBindingStartup(taskPolicyBindingHost, Object.freeze({ initializeDatabase: initializeApplication, registerIpc: registerAllIpcHandlers }));`
    ),
    'unused-run': mainSource.replace(
      'await runActionTaskBindingStartup();',
      'await Promise.resolve();'
    ),
    'conditional-run': mainSource.replace(
      'await runActionTaskBindingStartup();',
      'if (false) { await runActionTaskBindingStartup(); }'
    ),
    'swallowed-run-error': mainSource.replace(
      'await runActionTaskBindingStartup();',
      'try { await runActionTaskBindingStartup(); } catch (_bindingError) {}'
    ),
    'run-after-early-return': mainSource.replace(
      'await runActionTaskBindingStartup();',
      'return;\n      await runActionTaskBindingStartup();'
    ),
    'fake-production-import': mainSource.replace(
      "require('./main-process/background-execution/action-task-binding-registry')",
      "require('./main-process/background-execution/fake-action-task-binding-registry')"
    ),
    'shadowed-run-identifier': mainSource.replace(
      'await runActionTaskBindingStartup();',
      'const runActionTaskBindingStartup = async () => {};\n      await runActionTaskBindingStartup();'
    ),
    'reassigned-import-identifier': mainSource.replace(
      bindingImport,
      `${bindingImport}\ninitializeActionTaskBindingStartup = () => ({ actionTaskBindingRegistry: {}, run: async () => {} });`
    ),
    'rebound-commonjs-require': mainSource.replace(
      bindingImport,
      `const originalBindingRequire = require;\nrequire = ${fakeBindingLoader};\n${bindingImport}`
    ),
    'destructured-commonjs-require-rebind': mainSource.replace(
      bindingImport,
      `const originalBindingRequire = require;\n[require] = [${fakeBindingLoader}];\n${bindingImport}`
    ),
    'arguments-loader-rebind': mainSource.replace(
      bindingImport,
      `const originalBindingRequire = require;\narguments[1] = ${fakeBindingLoader};\n${bindingImport}`
    ),
    'arguments-alias-loader-rebind': mainSource.replace(
      bindingImport,
      `const originalBindingRequire = require;\nconst commonJsArguments = arguments;\ncommonJsArguments[1] = ${fakeBindingLoader};\n${bindingImport}`
    ),
    'target-require-cache-replacement': mainSource.replace(
      bindingImport,
      `require.cache[require.resolve('./main-process/background-execution/action-task-binding-registry')] = ${fakeBindingExport};\n${bindingImport}`
    ),
    'target-require-cache-alias-replacement': mainSource.replace(
      bindingImport,
      `const commonJsCache = require.cache;\ncommonJsCache[require.resolve('./main-process/background-execution/action-task-binding-registry')] = ${fakeBindingExport};\n${bindingImport}`
    ),
    'module-loader-replacement': mainSource.replace(
      bindingImport,
      `const originalModuleLoad = module.constructor._load;\nmodule.constructor._load = (request, parent, isMain) => request === './main-process/background-execution/action-task-binding-registry' ? ${fakeBindingExport}.exports : originalModuleLoad(request, parent, isMain);\n${bindingImport}`
    )
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    assert.notDeepEqual(mainStartupAstErrors(mutant), [], name);
  }
});

test('真实 startup seam 严格执行 TaskPolicy→binding→DB→IPC 且 binding throw 时 continuation=0', async () => {
  const events = [];
  const realRegistry = createTaskPolicyRegistry();
  const host = Object.freeze({
    list() {
      events.push('task-policy');
      return realRegistry.list();
    }
  });
  const startup = initializeActionTaskBindingStartup(host, Object.freeze({
    async initializeDatabase() {
      events.push('database');
    },
    registerIpc() {
      events.push('ipc');
    }
  }));
  events.splice(1, 0, 'binding');
  await startup.run();
  assert.deepEqual(events, ['task-policy', 'binding', 'database', 'ipc']);
  await assert.rejects(
    () => startup.run(),
    expectCode('ACTION_TASK_BINDING_STARTUP_ALREADY_RUN')
  );

  let databaseCalls = 0;
  let ipcCalls = 0;
  const invalid = mutableTaskPolicies();
  replacePolicyIdentity(invalid, 'monthly-balance:export', 'monthly-balance:missing-bound');
  assert.throws(
    () => initializeActionTaskBindingStartup(
      fakeTaskPolicyRegistry(invalid),
      Object.freeze({
        async initializeDatabase() { databaseCalls += 1; },
        registerIpc() { ipcCalls += 1; }
      })
    ),
    expectCode('ACTION_TASK_BINDING_TASK_POLICY_MISSING')
  );
  assert.equal(databaseCalls, 0);
  assert.equal(ipcCalls, 0);
});
