'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { executeCommandStep } = require('./command-step');

function createExecution(name, source, correlationId) {
  return {
    task: {
      name,
      source,
      execution: correlationId ? {
        options: {
          env: { WINAPP_TASK_CORRELATION_ID: correlationId }
        }
      } : undefined
    }
  };
}

function createHarness(executeCommand) {
  const order = [];
  let startListener;
  let endListener;
  let timeoutCallback;
  let disposeCount = 0;
  const dependencies = {
    tasks: {
      onDidStartTask(callback) {
        order.push('subscribe start');
        startListener = callback;
        return {
          dispose() {
            order.push('dispose start');
            disposeCount++;
          }
        };
      },
      onDidEndTaskProcess(callback) {
        order.push('subscribe end');
        endListener = callback;
        return {
          dispose() {
            order.push('dispose end');
            disposeCount++;
          }
        };
      }
    },
    timers: {
      setTimeout(callback) {
        timeoutCallback = () => {
          order.push('task timeout');
          callback();
        };
        return 42;
      },
      clearTimeout(handle) {
        assert.equal(handle, 42);
        order.push('clearTimeout');
      }
    },
    executeCommand: (...args) => {
      order.push('execute');
      return executeCommand(...args);
    },
    createCorrelationId: () => 'driver-id',
    resolveCommandArg: value => value,
    answer: async value => ({ kind: 'answer', value }),
    delay: async () => {}
  };
  return {
    dependencies,
    order,
    createExecution,
    emitTask(name, source, exitCode, correlationId) {
      const execution = this.createExecution(name, source, correlationId);
      endListener({ execution, exitCode });
      return execution;
    },
    emitStart(execution) {
      startListener({ execution });
    },
    emitExecution(execution, exitCode) {
      endListener({ execution, exitCode });
    },
    timeout() {
      timeoutCallback();
    },
    disposeCount: () => disposeCount
  };
}

test('subscribes before execution and returns matching task completion with args and answers', async () => {
  const options = { toolName: 'mt', argumentText: '-manifest input.manifest' };
  const launchedExecution = {
    task: {
      name: 'Run SDK Tool',
      source: 'WinApp',
      execution: { options: { env: { WINAPP_TASK_CORRELATION_ID: 'driver-id' } } }
    },
    terminate() {}
  };
  const unrelatedExecution = { task: { name: 'Run SDK Tool', source: 'WinApp' }, terminate() {} };
  const harness = createHarness((command, argument) => {
    assert.equal(command, 'winapp.tool');
    assert.deepEqual(argument, { ...options, correlationId: 'driver-id' });
    harness.emitExecution(unrelatedExecution, 9);
    harness.emitExecution(launchedExecution, 0);
    return launchedExecution;
  });

  const log = await executeCommandStep({
    command: 'winapp.tool',
    args: [options],
    answers: [{ accept: true }],
    waitForTask: true,
    taskName: 'Run SDK Tool',
    taskSource: 'WinApp',
    taskTimeoutMs: 5000
  }, harness.dependencies);

  assert.deepEqual(harness.order.slice(0, 3), ['subscribe start', 'subscribe end', 'execute']);
  assert.equal(log.result, launchedExecution);
  assert.deepEqual(log.answers, [{ kind: 'answer', value: { accept: true } }]);
  assert.deepEqual(log.task, { completed: true, exitCode: 0 });
  assert.equal(harness.disposeCount(), 2);
});

test('non-task command resolves after its answer without subscribing to tasks', async () => {
  let resolveCommand;
  const commandCompletion = new Promise(resolve => {
    resolveCommand = resolve;
  });
  const harness = createHarness((command, ...args) => {
    assert.equal(command, 'winapp.confirm');
    assert.deepEqual(args, ['resolved:first', 'resolved:second']);
    harness.order.push('command-waiting');
    return commandCompletion;
  });
  harness.dependencies.resolveCommandArg = value => {
    harness.order.push(`resolve:${value}`);
    return `resolved:${value}`;
  };
  harness.dependencies.answer = async value => {
    harness.order.push(`answer:${value.accept}`);
    resolveCommand('confirmed');
    return { kind: 'answer', value };
  };

  const log = await executeCommandStep({
    command: 'winapp.confirm',
    args: ['first', 'second'],
    answers: [{ accept: true }]
  }, harness.dependencies);

  assert.deepEqual(harness.order, [
    'resolve:first',
    'resolve:second',
    'execute',
    'command-waiting',
    'answer:true'
  ]);
  assert.ok(!harness.order.includes('subscribe start'));
  assert.ok(!harness.order.includes('subscribe end'));
  assert.equal(log.result, 'confirmed');
  assert.deepEqual(log.answers, [{ kind: 'answer', value: { accept: true } }]);
  assert.equal(log.task, undefined);
  assert.equal(harness.disposeCount(), 0);
});

test('after command resolution, matches only the known pre-seeded ID', async () => {
  const returnedExecution = { task: { name: 'Run SDK Tool', source: 'WinApp' } };
  const launchedExecution = createExecution(
    'Run SDK Tool',
    'WinApp',
    'driver-id'
  );
  launchedExecution.terminate = () => {};
  const unrelatedExecution = createExecution(
    'Run SDK Tool',
    'WinApp',
    'unrelated-id'
  );
  unrelatedExecution.terminate = () => {};
  const harness = createHarness(() => returnedExecution);
  let settled = false;
  const completion = executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    waitForTask: true,
    taskName: 'Run SDK Tool',
    taskSource: 'WinApp',
    taskTimeoutMs: 5000
  }, harness.dependencies).then(log => {
    settled = true;
    return log;
  });

  await Promise.resolve();
  await Promise.resolve();
  harness.emitExecution(unrelatedExecution, 9);
  await Promise.resolve();
  assert.equal(settled, false);

  harness.emitExecution(launchedExecution, 0);
  const log = await completion;
  assert.deepEqual(log.task, { completed: true, exitCode: 0 });
  assert.equal(harness.disposeCount(), 2);
});

test('correlates a known-ID completion before command result marshalling resolves', async () => {
  const harness = createHarness(() => {
    harness.emitTask('Run SDK Tool', 'WinApp', 9, 'concurrent-id');
    harness.emitTask('Run SDK Tool', 'WinApp', 0, 'driver-id');
    return new Promise(() => {});
  });

  const log = await executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    waitForTask: true,
    taskName: 'Run SDK Tool',
    taskSource: 'WinApp',
    taskTimeoutMs: 5000
  }, harness.dependencies);

  assert.equal(log.result, undefined);
  assert.deepEqual(log.task, { completed: true, exitCode: 0 });
  assert.equal(harness.disposeCount(), 2);
});

test('cancels task waiting immediately when command execution fails', async () => {
  let terminateCount = 0;
  const unrelatedExecution = {
    task: { name: 'Run SDK Tool', source: 'WinApp' },
    terminate() {
      terminateCount++;
    }
  };
  const harness = createHarness(() => {
    harness.emitExecution(unrelatedExecution, 1);
    throw new Error('boom');
  });
  harness.dependencies.delay = async () => {
    await Promise.resolve();
    assert.equal(harness.disposeCount(), 2, 'task wait should be cancelled before answer delays finish');
  };

  const log = await executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    answers: [{ accept: true }],
    waitForTask: true,
    taskTimeoutMs: 5000
  }, harness.dependencies);

  assert.match(log.error, /boom/);
  assert.deepEqual(log.task, {
    completed: false,
    cancelled: true,
    error: 'command failed before task launch'
  });
  assert.equal(harness.disposeCount(), 2);
  assert.equal(terminateCount, 0);
  assert.ok(!harness.order.includes('task timeout'));
});

test('cancels task waiting immediately when command execution returns a rejected promise', async () => {
  const harness = createHarness(() => Promise.reject(new Error('async boom')));

  const log = await executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    waitForTask: true,
    taskTimeoutMs: 5000
  }, harness.dependencies);

  assert.match(log.error, /async boom/);
  assert.deepEqual(log.task, {
    completed: false,
    cancelled: true,
    error: 'command failed before task launch'
  });
  assert.equal(harness.disposeCount(), 2);
  assert.ok(harness.order.includes('clearTimeout'));
  assert.ok(!harness.order.includes('task timeout'));
});

test('terminates the correlated execution before returning a structured timeout', async () => {
  const order = [];
  const execution = {
    task: { name: 'Run SDK Tool', source: 'WinApp' },
    terminate() {
      order.push('terminate');
    }
  };
  const harness = createHarness(() => execution);
  const completion = executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    waitForTask: true,
    taskTimeoutMs: 1234
  }, harness.dependencies);
  await Promise.resolve();
  await Promise.resolve();
  harness.timeout();

  const log = await completion;
  order.push('resolved');
  assert.deepEqual(log.task, {
    completed: false,
    error: 'task timeout after 1234ms'
  });
  assert.deepEqual(order, ['terminate', 'resolved']);
  assert.equal(harness.disposeCount(), 2);
});

test('returns a structured task timeout when command execution never settles', async () => {
  const harness = createHarness(() => new Promise(() => {}));
  const completion = executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    waitForTask: true,
    taskTimeoutMs: 1234
  }, harness.dependencies);
  await Promise.resolve();
  harness.timeout();

  const log = await completion;
  assert.deepEqual(log.task, {
    completed: false,
    error: 'task timeout after 1234ms'
  });
  assert.equal(log.result, undefined);
  assert.equal(log.error, undefined);
  assert.equal(harness.disposeCount(), 2);
});

test('captures a matching start event and terminates once when command resolves after timeout', async () => {
  let resolveCommand;
  let terminateCount = 0;
  const harness = createHarness(() => new Promise(resolve => {
    resolveCommand = resolve;
  }));
  const execution = harness.createExecution('Run SDK Tool', 'WinApp', 'driver-id');
  execution.terminate = () => {
    terminateCount++;
  };
  const completion = executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    waitForTask: true,
    taskName: 'Run SDK Tool',
    taskSource: 'WinApp',
    taskTimeoutMs: 1234
  }, harness.dependencies);
  await Promise.resolve();
  harness.emitStart(execution);
  harness.timeout();

  const log = await completion;
  resolveCommand(execution);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(log.task, {
    completed: false,
    error: 'task timeout after 1234ms'
  });
  assert.equal(terminateCount, 1);
  assert.equal(harness.disposeCount(), 2);
});

test('matching start events isolate concurrent tasks with identical names and sources', async () => {
  let matchingTerminateCount = 0;
  let unrelatedTerminateCount = 0;
  const harness = createHarness(() => new Promise(() => {}));
  const matchingExecution = harness.createExecution('Run SDK Tool', 'WinApp', 'driver-id');
  matchingExecution.terminate = () => {
    matchingTerminateCount++;
  };
  const unrelatedExecution = harness.createExecution('Run SDK Tool', 'WinApp', 'other-id');
  unrelatedExecution.terminate = () => {
    unrelatedTerminateCount++;
  };
  const completion = executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    waitForTask: true,
    taskName: 'Run SDK Tool',
    taskSource: 'WinApp',
    taskTimeoutMs: 1234
  }, harness.dependencies);
  await Promise.resolve();
  harness.emitStart(unrelatedExecution);
  harness.emitStart(matchingExecution);
  harness.timeout();

  const log = await completion;
  assert.deepEqual(log.task, {
    completed: false,
    error: 'task timeout after 1234ms'
  });
  assert.equal(matchingTerminateCount, 1);
  assert.equal(unrelatedTerminateCount, 0);
  assert.equal(harness.disposeCount(), 2);
});

test('known-ID event completion wins while a marshalled command result is unresolved', async () => {
  let resolveCommand;
  let returnedTerminateCount = 0;
  let launchedEventTerminateCount = 0;
  let unrelatedTerminateCount = 0;
  const returnedExecution = {
    task: { name: 'Run SDK Tool', source: 'WinApp' },
    terminate() {
      returnedTerminateCount++;
    }
  };
  const launchedEventExecution = createExecution('Run SDK Tool', 'WinApp', 'driver-id');
  launchedEventExecution.terminate = () => {
    launchedEventTerminateCount++;
  };
  const unrelatedExecution = createExecution('Run SDK Tool', 'WinApp', 'unrelated-id');
  unrelatedExecution.terminate = () => {
    unrelatedTerminateCount++;
  };
  const harness = createHarness(() => new Promise(resolve => {
    resolveCommand = resolve;
  }));
  const completion = executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    waitForTask: true,
    taskName: 'Run SDK Tool',
    taskSource: 'WinApp',
    taskTimeoutMs: 1234
  }, harness.dependencies);
  await Promise.resolve();
  harness.emitExecution(unrelatedExecution, 9);
  harness.emitExecution(launchedEventExecution, 0);

  const log = await completion;
  resolveCommand(returnedExecution);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(log.task, {
    completed: true,
    exitCode: 0
  });
  assert.equal(returnedTerminateCount, 0);
  assert.equal(launchedEventTerminateCount, 0);
  assert.equal(unrelatedTerminateCount, 0);
  assert.equal(harness.disposeCount(), 2);
});

test('handles a command rejection after task timeout without changing the timeout result', async () => {
  let rejectCommand;
  const harness = createHarness(() => new Promise((resolve, reject) => {
    rejectCommand = reject;
  }));
  const completion = executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    waitForTask: true,
    taskTimeoutMs: 1234
  }, harness.dependencies);
  await Promise.resolve();
  harness.timeout();

  const log = await completion;
  rejectCommand(new Error('late failure'));
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(log.task, {
    completed: false,
    error: 'task timeout after 1234ms'
  });
  assert.equal(log.error, undefined);
  assert.equal(harness.disposeCount(), 2);
});

test('WaitForTask ignores unrelated task names and sources', async () => {
  const launchedExecution = {
    task: {
      name: 'Run SDK Tool',
      source: 'WinApp',
      execution: { options: { env: { WINAPP_TASK_CORRELATION_ID: 'driver-id' } } }
    },
    terminate() {}
  };
  const harness = createHarness(() => {
    harness.emitTask('Build', 'WinApp', 0);
    harness.emitTask('Run SDK Tool', 'Other', 0);
    harness.emitExecution(launchedExecution, 3);
    return launchedExecution;
  });

  const log = await executeCommandStep({
    command: 'winapp.tool',
    args: [{ toolName: 'mt' }],
    waitForTask: true,
    taskName: 'Run SDK Tool',
    taskSource: 'WinApp',
    taskTimeoutMs: 5000
  }, harness.dependencies);

  assert.deepEqual(log.task, { completed: true, exitCode: 3 });
  assert.equal(harness.disposeCount(), 2);
});
