'use strict';

const fsPromises = require('fs/promises');
const path = require('path');
const { executeSandbox } = require('../../sandbox/executor');

const SANDBOX_TIMEOUT_MS = 5000;
const SANDBOX_TIMEOUT_ERROR = 'Execution timed out';
const SANDBOX_SKIP_NO_ENTRY_ERROR = 'Execution skipped due to high-confidence absence of executable entry file';
const MEDIUM_RISK_NO_CLEAR_ENTRY_REASON = 'no clear executable entry file pattern';
const MEDIUM_RISK_ENTRY_READ_REASON = 'entry file could not be read for heuristic checks';
const MEDIUM_RISK_NON_EXECUTABLE_MODULE_REASON = 'entry file appears to be a non-executable module';
const CLEAR_EXECUTABLE_ENTRY_FILES = new Set(['index.js', 'app.js', 'server.js', 'main.js']);
const SANDBOX_UNSAFE_EXECUTION_PATTERNS = [
  {
    pattern: /\bapp\s*\.\s*listen\s*\(/i,
    reason: 'server pattern (app.listen)',
    confidence: 'high'
  },
  {
    pattern: /\bserver\s*\.\s*listen\s*\(/i,
    reason: 'server pattern (server.listen)',
    confidence: 'high'
  },
  {
    pattern: /\bhttp\s*\.\s*createServer\s*\(/i,
    reason: 'server pattern (http.createServer)',
    confidence: 'high'
  },
  {
    pattern: /\bwhile\s*\(\s*true\s*\)/i,
    reason: 'infinite loop pattern (while(true))',
    confidence: 'high'
  },
  {
    pattern: /\bfor\s*\(\s*;\s*;\s*\)/i,
    reason: 'infinite loop pattern (for(;;))',
    confidence: 'high'
  }
];
const ENTRYPOINT_EXPORT_PATTERNS = [/\bmodule\.exports\b/, /\bexports\./, /\bexport\s+default\b/, /\bexport\s+\{/];
const ENTRYPOINT_MAIN_GUARD_PATTERNS = [/require\.main\s*===\s*module/, /import\.meta\.url/];

const buildSkippedExecution = ({ entryFile, reason, confidence }) => ({
  attempted: false,
  success: false,
  decision: 'skipped',
  executionDecision: 'skipped',
  reason,
  error: reason,
  confidence,
  stdout: '',
  stderr: '',
  executionTime: 0,
  entryFile: typeof entryFile === 'string' ? entryFile : null
});

const buildAttemptedExecution = ({
  entryFile,
  success,
  error,
  stdout,
  stderr,
  executionTime,
  decision,
  reason,
  confidence
}) => ({
  attempted: true,
  success,
  decision,
  executionDecision: decision,
  reason,
  error,
  confidence,
  stdout,
  stderr,
  executionTime,
  entryFile: typeof entryFile === 'string' ? entryFile : null
});

const executeWithTimeout = async (taskFunction, timeoutMs, timeoutMessage) => {
  let timeoutHandle;

  return new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    Promise.resolve()
      .then(taskFunction)
      .then((result) => {
        clearTimeout(timeoutHandle);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
  });
};

const isClearExecutableEntry = (entryFile) => {
  if (typeof entryFile !== 'string' || entryFile.trim().length === 0) {
    return false;
  }

  const normalizedEntry = entryFile.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalizedEntry.includes('/')) {
    return false;
  }

  const baseName = path.posix.basename(normalizedEntry).toLowerCase();
  return CLEAR_EXECUTABLE_ENTRY_FILES.has(baseName);
};

const detectUnsafeSandboxPattern = (sourceCode) => {
  if (typeof sourceCode !== 'string' || sourceCode.trim().length === 0) {
    return null;
  }

  const matchedPattern = SANDBOX_UNSAFE_EXECUTION_PATTERNS.find((candidate) => candidate.pattern.test(sourceCode));
  if (!matchedPattern) {
    return null;
  }

  return {
    reason: matchedPattern.reason,
    confidence: matchedPattern.confidence
  };
};

const isLikelyNonExecutableModule = (sourceCode) => {
  if (typeof sourceCode !== 'string' || sourceCode.trim().length === 0) {
    return true;
  }

  const hasExports = ENTRYPOINT_EXPORT_PATTERNS.some((pattern) => pattern.test(sourceCode));
  if (!hasExports) {
    return false;
  }

  const hasMainGuard = ENTRYPOINT_MAIN_GUARD_PATTERNS.some((pattern) => pattern.test(sourceCode));
  if (hasMainGuard) {
    return false;
  }

  return !detectUnsafeSandboxPattern(sourceCode);
};

const runSandboxStage = async ({ projectPath, entryFile }) => {
  if (!entryFile) {
    return buildSkippedExecution({
      entryFile,
      reason: SANDBOX_SKIP_NO_ENTRY_ERROR,
      confidence: 'high'
    });
  }

  const mediumRiskReasons = [];
  if (!isClearExecutableEntry(entryFile)) {
    mediumRiskReasons.push(MEDIUM_RISK_NO_CLEAR_ENTRY_REASON);
  }

  const resolvedEntryFilePath = path.resolve(projectPath, String(entryFile));
  let entryFileContent = '';
  try {
    entryFileContent = await fsPromises.readFile(resolvedEntryFilePath, 'utf8');
  } catch (_error) {
    mediumRiskReasons.push(MEDIUM_RISK_ENTRY_READ_REASON);
  }

  if (entryFileContent.trim().length > 0) {
    const unsafePattern = detectUnsafeSandboxPattern(entryFileContent);
    if (unsafePattern && unsafePattern.confidence === 'high') {
      return buildSkippedExecution({
        entryFile,
        reason: `Execution skipped due to high-confidence ${unsafePattern.reason}`,
        confidence: 'high'
      });
    }

    if (unsafePattern && unsafePattern.confidence === 'medium') {
      mediumRiskReasons.push(unsafePattern.reason);
    }

    if (isLikelyNonExecutableModule(entryFileContent)) {
      mediumRiskReasons.push(MEDIUM_RISK_NON_EXECUTABLE_MODULE_REASON);
    }
  }

  const shouldForceExecution = mediumRiskReasons.length > 0;
  const decision = shouldForceExecution ? 'forced-execution' : 'executed';
  const reason = shouldForceExecution
    ? `Execution attempted despite medium-risk pattern (${mediumRiskReasons.join('; ')})`
    : 'Execution executed with no medium/high-risk heuristic signals';
  const confidence = shouldForceExecution ? 'medium' : 'medium';

  try {
    const executionResult = await executeWithTimeout(
      () =>
        executeSandbox({
          codePath: projectPath,
          entryFile
        }),
      SANDBOX_TIMEOUT_MS,
      SANDBOX_TIMEOUT_ERROR
    );

    return buildAttemptedExecution({
      entryFile,
      success: Boolean(executionResult && executionResult.success),
      error: executionResult && typeof executionResult.error === 'string' ? executionResult.error : '',
      stdout: executionResult && typeof executionResult.stdout === 'string' ? executionResult.stdout : '',
      stderr: executionResult && typeof executionResult.stderr === 'string' ? executionResult.stderr : '',
      executionTime: executionResult && Number.isFinite(executionResult.executionTime) ? executionResult.executionTime : 0,
      decision,
      reason,
      confidence
    });
  } catch (error) {
    return buildAttemptedExecution({
      entryFile,
      success: false,
      error: error && typeof error.message === 'string' ? error.message : '',
      stdout: '',
      stderr: '',
      executionTime: 0,
      decision,
      reason,
      confidence
    });
  }
};

module.exports = {
  runSandboxStage
};
