'use strict';

const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { executeSandbox } = require('../../sandbox/executor');

function isDockerReady() {
  try {
    const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
      timeout: 5000
    });

    if (result.error) {
      return false;
    }

    return result.status === 0;
  } catch {
    return false;
  }
}

const describeIfDocker = isDockerReady() ? describe : describe.skip;

describeIfDocker('sandbox attack simulation', () => {
  let tempDirectories = [];

  async function createSandboxProject(code, entryFile = 'index.js') {
    const tempDirectoryPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devguard-attack-'));
    tempDirectories.push(tempDirectoryPath);

    await fsPromises.writeFile(path.join(tempDirectoryPath, entryFile), code, 'utf8');

    return {
      codePath: tempDirectoryPath,
      entryFile
    };
  }

  afterEach(async () => {
    await Promise.allSettled(
      tempDirectories.map((directoryPath) =>
        fsPromises.rm(directoryPath, { recursive: true, force: true })
      )
    );
    tempDirectories = [];
  });

  test('times out infinite loop attack', async () => {
    const sandboxInput = await createSandboxProject('while (true) {}');
    const result = await executeSandbox(sandboxInput);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Execution timed out');
  });

  test('blocks memory exhaustion attack', async () => {
    const sandboxInput = await createSandboxProject(`
      const chunks = [];
      while (true) {
        chunks.push(Buffer.alloc(16 * 1024 * 1024, 'a'));
      }
    `);
    const result = await executeSandbox(sandboxInput);

    expect(result.success).toBe(false);
    expect(String(result.error || '').toLowerCase()).toMatch(/memory|limit/);
  });

  test('handles filesystem probing safely', async () => {
    const sandboxInput = await createSandboxProject(`
      const fs = require('fs');
      console.log(JSON.stringify(fs.readdirSync('/')));
    `);

    await expect(executeSandbox(sandboxInput)).resolves.toEqual(
      expect.objectContaining({
        success: expect.any(Boolean),
        stdout: expect.any(String),
        stderr: expect.any(String),
        executionTime: expect.any(Number)
      })
    );
  });

  test('does not leak sensitive environment variables', async () => {
    const sandboxInput = await createSandboxProject('console.log(JSON.stringify(process.env));');
    const result = await executeSandbox(sandboxInput);

    expect(result.success).toBe(true);
    expect(result.stdout).not.toMatch(/OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|DEVGUARD_API_KEY/);
  });

  test('times out cpu burn attack', async () => {
    const sandboxInput = await createSandboxProject(`
      // Tight loop to simulate CPU burn
      while (true) {
        Math.imul(1234567, 9876543);
      }
    `);
    const result = await executeSandbox(sandboxInput);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Execution timed out');
  });
});
