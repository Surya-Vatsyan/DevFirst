'use strict';

const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createFakeChildProcess, createCleanupChildProcess } = require('../helpers/fake-child-process');

jest.mock('child_process', () => ({
  spawn: jest.fn()
}));

describe('sandbox queue timeout protection', () => {
  let executeSandbox;
  let tempDirectoryPath;
  let activeRunChildren;

  beforeEach(async () => {
    jest.resetModules();
    spawn.mockReset();
    ({ executeSandbox } = require('../../sandbox/executor'));

    tempDirectoryPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devguard-sandbox-queue-'));
    await fsPromises.writeFile(path.join(tempDirectoryPath, 'index.js'), 'console.log("ok");', 'utf8');

    activeRunChildren = [];
    spawn.mockImplementation((_command, args) => {
      if (args[0] === 'run') {
        const runChild = createFakeChildProcess();
        activeRunChildren.push(runChild);
        return runChild;
      }
      return createCleanupChildProcess();
    });
  });

  afterEach(async () => {
    for (const child of activeRunChildren) {
      child.emit('close', 0, null);
    }

    if (tempDirectoryPath) {
      await fsPromises.rm(tempDirectoryPath, { recursive: true, force: true });
    }
  });

  test('rejects requests that wait in queue for too long', async () => {
    const firstThree = [
      executeSandbox({ codePath: tempDirectoryPath, entryFile: 'index.js' }),
      executeSandbox({ codePath: tempDirectoryPath, entryFile: 'index.js' }),
      executeSandbox({ codePath: tempDirectoryPath, entryFile: 'index.js' })
    ];

    const queuedExecution = executeSandbox({
      codePath: tempDirectoryPath,
      entryFile: 'index.js'
    });

    const queuedResult = await queuedExecution;
    expect(queuedResult.success).toBe(false);
    expect(queuedResult.error).toBe('Sandbox queue wait timeout exceeded');

    for (const child of activeRunChildren) {
      child.emit('close', 0, null);
    }
    await Promise.all(firstThree);
  });
});
