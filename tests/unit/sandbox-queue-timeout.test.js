'use strict';

const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFakeChildProcess, createCleanupChildProcess } = require('../helpers/fake-child-process');

describe('sandbox queue timeout protection', () => {
  let executeSandbox;
  let spawn;
  let tempDirectoryPath;
  let activeRunChildren;

  beforeEach(async () => {
    jest.resetModules();
    jest.doMock('child_process', () => ({
      spawn: jest.fn()
    }));
    ({ executeSandbox } = require('../../sandbox/executor'));
    ({ spawn } = require('child_process'));

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
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    global.setTimeout = (callback, delay, ...args) => {
      if (delay === 5000) {
        return { __devguardSkippedExecutionTimeout: true };
      }

      if (delay === 10000) {
        return originalSetTimeout(callback, 25, ...args);
      }

      return originalSetTimeout(callback, delay, ...args);
    };

    global.clearTimeout = (timer) => {
      if (timer && timer.__devguardSkippedExecutionTimeout) {
        return;
      }
      return originalClearTimeout(timer);
    };

    const waitForActiveChildren = (expectedCount, maxWaitMs = 1000) =>
      new Promise((resolve, reject) => {
        const startedAt = Date.now();

        const check = () => {
          if (activeRunChildren.length >= expectedCount) {
            resolve();
            return;
          }

          if (Date.now() - startedAt >= maxWaitMs) {
            reject(new Error(`Expected ${expectedCount} active executions, got ${activeRunChildren.length}`));
            return;
          }

          originalSetTimeout(check, 10);
        };

        check();
      });

    try {
      const firstThree = [
        executeSandbox({ codePath: tempDirectoryPath, entryFile: 'index.js' }).catch(() => null),
        executeSandbox({ codePath: tempDirectoryPath, entryFile: 'index.js' }).catch(() => null),
        executeSandbox({ codePath: tempDirectoryPath, entryFile: 'index.js' }).catch(() => null)
      ];

      await waitForActiveChildren(3);

      const queuedExecution = executeSandbox({
        codePath: tempDirectoryPath,
        entryFile: 'index.js'
      });

      try {
        const queuedOutcome = queuedExecution.then(
          () => ({ rejected: false, error: null }),
          (error) => ({ rejected: true, error })
        );

        const queuedResult = await queuedOutcome;
        expect(queuedResult.rejected).toBe(true);
        expect(queuedResult.error).toBeInstanceOf(Error);
        expect(queuedResult.error.message).toBe('Sandbox queue wait timeout exceeded');
      } finally {
        for (const child of activeRunChildren) {
          child.emit('close', 0, null);
        }
        await Promise.race([
          Promise.allSettled(firstThree),
          new Promise((resolve) => originalSetTimeout(resolve, 200))
        ]);
      }
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });
});
