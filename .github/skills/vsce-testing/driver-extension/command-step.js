'use strict';

const { randomUUID } = require('node:crypto');

function createTaskProcessWait(tasks, options, timers) {
  const maxBufferedEvents = 100;
  let finish;
  let correlatedExecution;
  let correlatedEventExecution;
  let correlationId = options.correlationId;
  let settled = false;
  let terminated = false;
  const bufferedEvents = [];
  const terminateCorrelatedExecution = () => {
    if (terminated) {
      return;
    }
    const execution = correlatedEventExecution || correlatedExecution;
    if (execution && typeof execution.terminate === 'function') {
      terminated = true;
      try {
        execution.terminate();
      } catch {}
    }
  };
  const getCorrelationId = execution =>
    execution?.task?.execution?.options?.env?.WINAPP_TASK_CORRELATION_ID;
  const hasMatchingIdentity = execution => {
    const task = execution?.task;
    return task?.name === options.taskName &&
      (!options.taskSource || task.source === options.taskSource);
  };
  const matchesExecution = execution => {
    if (!hasMatchingIdentity(execution)) {
      return false;
    }
    if (typeof correlationId === 'string' && correlationId.length > 0) {
      return getCorrelationId(execution) === correlationId;
    }
    return execution === correlatedExecution;
  };
  const completeFromEvent = event => {
    correlatedEventExecution = event.execution;
    finish({ completed: true, exitCode: event.exitCode });
  };
  const promise = new Promise((resolve) => {
    let timer;
    const startSubscription = tasks.onDidStartTask((event) => {
      if (matchesExecution(event.execution)) {
        correlatedEventExecution = event.execution;
      }
    });
    const endSubscription = tasks.onDidEndTaskProcess((event) => {
      if (matchesExecution(event.execution)) {
        completeFromEvent(event);
      } else if (!correlatedExecution) {
        bufferedEvents.push(event);
        if (bufferedEvents.length > maxBufferedEvents) {
          bufferedEvents.shift();
        }
      }
    });
    finish = (value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      startSubscription.dispose();
      endSubscription.dispose();
      resolve(value);
    };
    timer = timers.setTimeout(() => {
      terminateCorrelatedExecution();
      finish({ completed: false, error: `task timeout after ${options.timeoutMs}ms` });
    }, options.timeoutMs);
  });
  return {
    promise,
    correlate(execution) {
      if (correlatedExecution || settled) {
        return;
      }
      correlatedExecution = execution;
      correlationId ||= getCorrelationId(execution);
      const completion = bufferedEvents.find(event => matchesExecution(event.execution));
      if (completion) {
        correlatedEventExecution = completion.execution;
        finish({ completed: true, exitCode: completion.exitCode });
      }
    },
    cancel: () => finish({
      completed: false,
      cancelled: true,
      error: 'command failed before task launch'
    })
  };
}

async function executeCommandStep(step, dependencies) {
  const log = { type: 'command', command: step.command, answers: [] };
  const isCorrelatedToolTask = step.waitForTask && step.command === 'winapp.tool';
  const correlationId = isCorrelatedToolTask
    ? (dependencies.createCorrelationId || randomUUID)()
    : undefined;
  const taskWait = step.waitForTask
    ? createTaskProcessWait(dependencies.tasks, {
      taskName: step.taskName || 'Run SDK Tool',
      taskSource: step.taskSource,
      timeoutMs: step.taskTimeoutMs || 120000,
      correlationId
    }, dependencies.timers)
    : null;

  let execution;
  try {
    const commandArgs = (step.args || []).map(dependencies.resolveCommandArg);
    if (correlationId) {
      const options = commandArgs[0];
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('waitForTask with winapp.tool requires programmatic command options');
      }
      commandArgs[0] = { ...options, correlationId };
    }
    execution = Promise.resolve(dependencies.executeCommand(
      step.command,
      ...commandArgs
    )).then(value => ({ value }), error => {
      if (taskWait) {
        taskWait.cancel();
      }
      return { error: String(error) };
    });
  } catch (error) {
    if (taskWait) {
      taskWait.cancel();
    }
    execution = Promise.resolve({ error: String(error) });
  }
  if (taskWait) {
    execution.then((outcome) => {
      if (!outcome.error) {
        taskWait.correlate(outcome.value);
      }
    });
  }

  for (const answer of step.answers || []) {
    await dependencies.delay(step.settleMs || 1600);
    log.answers.push(await dependencies.answer(answer));
  }

  let outcome;
  if (taskWait) {
    const first = await Promise.race([
      execution.then(value => ({ type: 'command', value })),
      taskWait.promise.then(value => ({ type: 'task', value }))
    ]);
    if (first.type === 'task' && !first.value.cancelled) {
      log.task = first.value;
      await dependencies.delay(step.afterMs || 4000);
      return log;
    }
    outcome = first.type === 'command' ? first.value : await execution;
  } else {
    outcome = await execution;
  }
  if (outcome.error) {
    log.error = outcome.error;
    if (taskWait) {
      log.task = await taskWait.promise;
    }
  } else {
    log.result = outcome.value;
    if (taskWait) {
      log.task = await taskWait.promise;
    }
  }

  await dependencies.delay(step.afterMs || 4000);
  return log;
}

module.exports = { executeCommandStep };
