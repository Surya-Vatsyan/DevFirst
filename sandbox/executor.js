'use strict';

const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const EXECUTION_TIMEOUT_MS = 5000;
const DOCKER_IMAGE = 'node:18';
const MEMORY_LIMIT = '100m';
const CPU_LIMIT = '0.5';
const PIDS_LIMIT = '64';
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 2000;
const MAX_CONCURRENT_EXECUTIONS = 3;
const MAX_QUEUED_EXECUTIONS = 100;
const QUEUE_WAIT_TIMEOUT_MS = 10000;
const SANDBOX_USER = '1000:1000';
const TMPFS_CONFIG = '/tmp:rw,noexec,nosuid,size=16m';
const ENTRY_FILE_PATTERN = /^[A-Za-z0-9._\-/\\]+$/;
const OUTPUT_TRUNCATION_SUFFIX = '\n[output truncated]';

let activeExecutions = 0;
const executionQueue = [];

function sanitizeEntryFile(entryFile) {
  if (typeof entryFile !== 'string' || entryFile.trim() === '') {
    throw new Error('Invalid entryFile: expected a non-empty string');
  }

  if (entryFile.includes('\0')) {
    throw new Error('Invalid entryFile: null bytes are not allowed');
  }

  if (!ENTRY_FILE_PATTERN.test(entryFile)) {
    throw new Error('Invalid entryFile: contains unsupported characters');
  }

  const normalized = path.posix.normalize(entryFile.replace(/\\/g, '/'));
  const isTraversal =
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../');

  if (normalized.startsWith('/') || isTraversal) {
    throw new Error('Invalid entryFile: path traversal is not allowed');
  }

  return normalized;
}

async function sanitizeCodePath(codePath) {
  if (typeof codePath !== 'string' || codePath.trim() === '') {
    throw new Error('Invalid codePath: expected a non-empty string');
  }

  if (codePath.includes('\0')) {
    throw new Error('Invalid codePath: null bytes are not allowed');
  }

  const resolvedPath = path.resolve(codePath);
  const realPath = await fs.realpath(resolvedPath);

  let stats;
  try {
    stats = await fs.stat(realPath);
  } catch {
    throw new Error(`Invalid codePath: directory does not exist (${realPath})`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Invalid codePath: not a directory (${realPath})`);
  }

  return realPath;
}

async function validateEntryFileExists(codePath, entryFile) {
  const nativeEntryPath = entryFile.replace(/\//g, path.sep);
  const resolvedEntryPath = path.resolve(codePath, nativeEntryPath);
  const normalizedCodePath = path.resolve(codePath);

  if (
    resolvedEntryPath !== normalizedCodePath &&
    !resolvedEntryPath.startsWith(`${normalizedCodePath}${path.sep}`)
  ) {
    throw new Error('Invalid entryFile: resolved path is outside codePath');
  }

  let stats;
  try {
    stats = await fs.stat(resolvedEntryPath);
  } catch {
    throw new Error(`Invalid entryFile: file does not exist (${entryFile})`);
  }

  if (!stats.isFile()) {
    throw new Error(`Invalid entryFile: not a file (${entryFile})`);
  }
}

function buildContainerName() {
  return `devguard-sandbox-${randomUUID().replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase()}`;
}

function buildDockerArgs({ codePath, entryFile, containerName }) {
  return [
    'run',
    '--rm',
    '--name',
    containerName,
    `--memory=${MEMORY_LIMIT}`,
    `--cpus=${CPU_LIMIT}`,
    `--pids-limit=${PIDS_LIMIT}`,
    '--network=none',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--user=${SANDBOX_USER}`,
    '--read-only',
    '--tmpfs',
    TMPFS_CONFIG,
    '-v',
    `${codePath}:/app:ro`,
    DOCKER_IMAGE,
    'node',
    `/app/${entryFile}`
  ];
}

function createOutputCollector(maxBytes) {
  const chunks = [];
  let bytesWritten = 0;
  let truncated = false;

  return {
    push(chunk) {
      if (!chunk) {
        return;
      }

      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const remaining = maxBytes - bytesWritten;
      if (remaining <= 0) {
        truncated = true;
        return;
      }

      if (bufferChunk.length <= remaining) {
        chunks.push(bufferChunk);
        bytesWritten += bufferChunk.length;
        return;
      }

      chunks.push(bufferChunk.subarray(0, remaining));
      bytesWritten += remaining;
      truncated = true;
    },
    toText() {
      const baseText = Buffer.concat(chunks).toString('utf8');
      return truncated ? `${baseText}${OUTPUT_TRUNCATION_SUFFIX}` : baseText;
    }
  };
}

function mapExecutionError({ timedOut, processError, stderrText, code, signal }) {
  if (timedOut) {
    return 'Execution timed out';
  }

  if (processError) {
    const normalizedMessage = processError.message.toLowerCase();
    if (normalizedMessage.includes('eperm') || normalizedMessage.includes('eacces')) {
      return 'Sandbox restriction triggered';
    }
    return `Failed to start Docker process: ${processError.message}`;
  }

  const normalizedStderr = (stderrText || '').toLowerCase();
  if (normalizedStderr.includes('out of memory') || normalizedStderr.includes('oom') || normalizedStderr.includes('137')) {
    return 'Memory limit exceeded';
  }

  if (
    normalizedStderr.includes('pids limit') ||
    normalizedStderr.includes('too many processes') ||
    normalizedStderr.includes('resource temporarily unavailable') ||
    normalizedStderr.includes('fork')
  ) {
    return 'Process limit exceeded';
  }

  if (
    normalizedStderr.includes('permission denied') ||
    normalizedStderr.includes('operation not permitted') ||
    normalizedStderr.includes('read-only file system')
  ) {
    return 'Sandbox restriction triggered';
  }

  if (signal) {
    return `Execution terminated by signal: ${signal}`;
  }

  if (typeof code === 'number' && code !== 0) {
    return `Execution failed with exit code: ${code}`;
  }

  return 'Execution failed';
}

function forceCleanupContainer(containerName) {
  return new Promise((resolve) => {
    let cleanupProcess;
    try {
      cleanupProcess = spawn('docker', ['rm', '-f', containerName], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore']
      });
    } catch {
      resolve();
      return;
    }

    if (!cleanupProcess || typeof cleanupProcess.on !== 'function') {
      resolve();
      return;
    }

    const cleanupTimeout = setTimeout(() => {
      if (typeof cleanupProcess.kill === 'function') {
        cleanupProcess.kill('SIGKILL');
      }
      resolve();
    }, CLEANUP_TIMEOUT_MS);

    cleanupProcess.on('error', () => {
      clearTimeout(cleanupTimeout);
      resolve();
    });

    cleanupProcess.on('close', () => {
      clearTimeout(cleanupTimeout);
      resolve();
    });
  });
}

function processExecutionQueue() {
  while (activeExecutions < MAX_CONCURRENT_EXECUTIONS && executionQueue.length > 0) {
    const nextTask = executionQueue.shift();
    if (!nextTask || nextTask.expired) {
      continue;
    }

    if (nextTask.timeout) {
      clearTimeout(nextTask.timeout);
      nextTask.timeout = null;
    }

    nextTask.started = true;
    activeExecutions += 1;
    void nextTask.run();
  }
}

function enqueueExecution(runTask) {
  return new Promise((resolve, reject) => {
    if (executionQueue.length >= MAX_QUEUED_EXECUTIONS) {
      reject(new Error('Sandbox queue is full'));
      return;
    }

    const queuedTask = {
      started: false,
      expired: false,
      timeout: null,
      run: async () => {
        try {
          const result = await runTask();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          activeExecutions -= 1;
          processExecutionQueue();
        }
      }
    };

    queuedTask.timeout = setTimeout(() => {
      if (queuedTask.started || queuedTask.expired) {
        return;
      }

      queuedTask.expired = true;
      const pendingIndex = executionQueue.indexOf(queuedTask);
      if (pendingIndex !== -1) {
        executionQueue.splice(pendingIndex, 1);
      }

      reject(new Error('Sandbox queue wait timeout exceeded'));
    }, QUEUE_WAIT_TIMEOUT_MS);

    executionQueue.push(queuedTask);
    processExecutionQueue();
  });
}

function runDocker({ codePath, entryFile }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutCollector = createOutputCollector(OUTPUT_LIMIT_BYTES);
    const stderrCollector = createOutputCollector(OUTPUT_LIMIT_BYTES);
    const containerName = buildContainerName();
    let settled = false;
    let timedOut = false;
    let processError = null;
    let cleanupPromise = null;
    let timeout = null;

    const ensureCleanup = () => {
      if (!cleanupPromise) {
        cleanupPromise = forceCleanupContainer(containerName);
      }
      return cleanupPromise;
    };

    const finalize = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const finalizeInitializationFailure = () => {
      finalize({
        success: false,
        stdout: '',
        stderr: '',
        error: 'Sandbox process failed to initialize',
        executionTime: 0
      });
    };

    const complete = async ({ code, signal }) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      await ensureCleanup();

      const stdout = stdoutCollector.toText();
      const stderr = stderrCollector.toText();
      const mappedError = mapExecutionError({
        timedOut,
        processError,
        stderrText: stderr,
        code,
        signal
      });

      if (!timedOut && !processError && code === 0) {
        finalize({
          success: true,
          stdout,
          stderr,
          error: null,
          executionTime: Date.now() - startedAt
        });
        return;
      }

      finalize({
        success: false,
        stdout,
        stderr,
        error: mappedError,
        executionTime: Date.now() - startedAt
      });
    };

    const dockerArgs = buildDockerArgs({ codePath, entryFile, containerName });
    let child;
    try {
      child = spawn('docker', dockerArgs, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      processError = error;
      void complete({ code: null, signal: null });
      return;
    }

    if (!child) {
      void ensureCleanup();
      finalizeInitializationFailure();
      return;
    }

    if (child.stdout?.on) {
      child.stdout.on('data', (chunk) => {
        stdoutCollector.push(chunk);
      });
    }

    if (child.stderr?.on) {
      child.stderr.on('data', (chunk) => {
        stderrCollector.push(chunk);
      });
    }

    timeout = setTimeout(() => {
      timedOut = true;
      if (typeof child.kill === 'function') {
        child.kill('SIGKILL');
      }
      void ensureCleanup();
      void complete({ code: null, signal: 'SIGKILL' });
    }, EXECUTION_TIMEOUT_MS);

    child.on?.('error', (error) => {
      processError = error;
      void complete({ code: null, signal: null });
    });

    child.on?.('close', (code, signal) => {
      void complete({ code, signal });
    });
  });
}

async function executeSandbox(input = {}) {
  const startedAt = Date.now();

  try {
    const { codePath, entryFile } = input;
    const safeCodePath = await sanitizeCodePath(codePath);
    const safeEntryFile = sanitizeEntryFile(entryFile);
    await validateEntryFileExists(safeCodePath, safeEntryFile);
    return enqueueExecution(() => runDocker({ codePath: safeCodePath, entryFile: safeEntryFile }));
  } catch (error) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      error: error.message,
      executionTime: Date.now() - startedAt
    };
  }
}

module.exports = {
  executeSandbox
};
