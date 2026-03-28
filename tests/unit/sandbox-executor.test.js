'use strict';

const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFakeChildProcess, createCleanupChildProcess } = require('../helpers/fake-child-process');

describe('sandbox executor', () => {
  let executeSandbox;
  let spawn;
  let tempDirectoryPath;

  beforeEach(async () => {
    jest.resetModules();
    jest.doMock('child_process', () => ({
      spawn: jest.fn()
    }));
    ({ executeSandbox } = require('../../sandbox/executor'));
    ({ spawn } = require('child_process'));

    tempDirectoryPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devguard-sandbox-test-'));
    await fsPromises.writeFile(path.join(tempDirectoryPath, 'index.js'), 'console.log("ok");', 'utf8');
  });

  afterEach(async () => {
    if (tempDirectoryPath) {
      await fsPromises.rm(tempDirectoryPath, { recursive: true, force: true });
    }
  });

  test('times out infinite loop execution', async () => {
    const runningChild = createFakeChildProcess();
    runningChild.kill = jest.fn();

    spawn.mockImplementation((_command, args) => {
      if (args[0] === 'run') {
        return runningChild;
      }
      return createCleanupChildProcess();
    });

    const result = await executeSandbox({
      codePath: tempDirectoryPath,
      entryFile: 'index.js'
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Execution timed out');
    expect(result.executionTime).toBeGreaterThanOrEqual(5000);
    expect(runningChild.kill).toHaveBeenCalled();
  });

  test('maps fork bomb to process limit exceeded', async () => {
    spawn.mockImplementation((_command, args) => {
      if (args[0] === 'run') {
        const child = createFakeChildProcess();
        setImmediate(() => {
          child.stderr.emit('data', Buffer.from('fork: Resource temporarily unavailable'));
          child.emit('close', 1, null);
        });
        return child;
      }
      return createCleanupChildProcess();
    });

    const result = await executeSandbox({
      codePath: tempDirectoryPath,
      entryFile: 'index.js'
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Process limit exceeded');
  });

  test('maps blocked network call to sandbox restriction', async () => {
    spawn.mockImplementation((_command, args) => {
      if (args[0] === 'run') {
        const child = createFakeChildProcess();
        setImmediate(() => {
          child.stderr.emit('data', Buffer.from('Operation not permitted'));
          child.emit('close', 1, null);
        });
        return child;
      }
      return createCleanupChildProcess();
    });

    const result = await executeSandbox({
      codePath: tempDirectoryPath,
      entryFile: 'index.js'
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Sandbox restriction triggered');
  });
});
