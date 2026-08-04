const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const calls = [];
const activeUri = { scheme: 'file', fsPath: 'C:\\workspace\\active.xaml' };
const vscode = {
  Position: class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Uri: {
    file(path) {
      return { scheme: 'file', fsPath: path };
    }
  },
  commands: {
    executeCommand(command, ...args) {
      calls.push({ command, args });
      if (command === 'test.prompted') return new Promise(() => {});
      return command === 'test.awaited' ? Promise.resolve('result') : Promise.resolve();
    }
  },
  window: {
    activeTextEditor: { document: { uri: activeUri } }
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
};
const { _test } = require('./extension');
Module._load = originalLoad;

test.beforeEach(() => {
  calls.length = 0;
});

test('keeps legacy commandArgs argument resolution and result behavior', async () => {
  const result = { steps: [] };
  await _test.executeCommandStep({
    type: 'commandArgs',
    command: 'test.awaited',
    args: [
      { kind: 'activeDocumentUri' },
      { kind: 'fileUri', path: 'C:\\workspace\\other.xaml' },
      { kind: 'position', line: 4, character: 2 },
      { unchanged: true }
    ],
    afterMs: 1
  }, result);

  assert.deepEqual(calls, [{
    command: 'test.awaited',
    args: [
      activeUri,
      { scheme: 'file', fsPath: 'C:\\workspace\\other.xaml' },
      new vscode.Position(4, 2),
      { unchanged: true }
    ]
  }]);
  assert.deepEqual(result.steps, [{
    type: 'commandArgs',
    command: 'test.awaited',
    result: 'result',
    error: null
  }]);
});

test('starts an ordinary command with arguments before answering prompts in order', async () => {
  const result = { steps: [] };
  await _test.executeCommandStep({
    type: 'command',
    command: 'test.prompted',
    args: [
      { kind: 'activeDocumentUri' },
      { kind: 'position', line: 4, character: 2 }
    ],
    answers: [{ accept: true }, { accept: true }],
    settleMs: 1,
    afterMs: 1
  }, result);

  assert.deepEqual(calls.map(call => call.command), [
    'test.prompted',
    'workbench.action.acceptSelectedQuickOpenItem',
    'workbench.action.acceptSelectedQuickOpenItem'
  ]);
  assert.deepEqual(calls[0].args, [activeUri, new vscode.Position(4, 2)]);
  assert.deepEqual(result.steps[0].answers.map(answer => answer.kind), ['accept', 'accept']);
});
