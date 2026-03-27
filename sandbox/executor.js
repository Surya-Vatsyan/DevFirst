'use strict';

const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const EXECUTION_TIMEOUT_MS = 5000;
const DOCKER_IMAGE = 'node:18';
const MEMORY_LIMIT = '100m';
const CPU_LIMIT = '0.5';
const ENTRY_FILE_PATTERN = /^[A-Za-z0-9._\-/\\]+$/;

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

  let stats;
  try {
    stats = await fs.stat(resolvedPath);
  } catch {
    throw new Error(`Invalid codePath: directory does not exist (${resolvedPath})`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Invalid codePath: not a directory (${resolvedPath})`);
  }

  return resolvedPath;
}

function buildDockerArgs(codePath, entryFile) {
  return [
    'run',
    '--rm',
    `--memory=${MEMORY_LIMIT}`,
    `--cpus=${CPU_LIMIT}`,
    '--network=none',
    '-v',
    `${codePath}:/app`,
    DOCKER_IMAGE,
    'node',
    `/app/${entryFile}`
  ];
}

function runDocker({ codePath, entryFile }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finalize = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const dockerArgs = buildDockerArgs(codePath, entryFile);
    const child = spawn('docker', dockerArgs, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, EXECUTION_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timeout);
      finalize({
        success: false,
        stdout,
        stderr,
        error: `Failed to start Docker process: ${error.message}`,
        executionTime: Date.now() - startedAt
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);

      if (timedOut) {
        finalize({
          success: false,
          stdout,
          stderr,
          error: `Execution timed out after ${EXECUTION_TIMEOUT_MS}ms`,
          executionTime: Date.now() - startedAt
        });
        return;
      }

      if (signal) {
        finalize({
          success: false,
          stdout,
          stderr,
          error: `Execution terminated by signal: ${signal}`,
          executionTime: Date.now() - startedAt
        });
        return;
      }

      if (code === 0) {
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
        error: `Execution failed with exit code: ${code}`,
        executionTime: Date.now() - startedAt
      });
    });
  });
}

async function executeSandbox(input = {}) {
  const startedAt = Date.now();

  try {
    const { codePath, entryFile } = input;
    const safeCodePath = await sanitizeCodePath(codePath);
    const safeEntryFile = sanitizeEntryFile(entryFile);
    return runDocker({ codePath: safeCodePath, entryFile: safeEntryFile });
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
