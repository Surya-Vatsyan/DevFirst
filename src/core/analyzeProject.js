'use strict';

const fsPromises = require('fs/promises');
const path = require('path');
const securityScanner = require('../services/securityScanner');
const aiService = require('../services/ai.service');
const { detectEntryFile } = require('../../utils/entryDetector');
const { executeSandbox } = require('../../sandbox/executor');

const JS_EXTENSION = '.js';
const NODE_MODULES_DIRECTORY = 'node_modules';
const MAX_AI_FILES = 5;
const MAX_AI_SNIPPET_CHARACTERS = 8000;
const MAX_AI_FILE_CHARACTERS = 8000;
const MAX_AI_TOTAL_CHARACTERS = 32000;
const SCAN_TIMEOUT_MS = 5000;
const SEVERITY_VALUES = new Set(['low', 'medium', 'high']);
const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);
const DEFAULT_CONTEXT = 'No taint flow context available.';
const DEFAULT_SUGGESTION = 'Review and remediate this issue.';
const DEFAULT_MESSAGE = 'Issue detected.';
const DEFAULT_FILE = 'unknown';

const buildDefaultSeveritySummary = () => ({
  high: 0,
  medium: 0,
  low: 0
});

const buildDefaultSummary = () => ({
  totalFiles: 0,
  issuesFound: 0,
  severity: buildDefaultSeveritySummary()
});

const buildDefaultExecution = () => ({
  attempted: false,
  success: false,
  error: '',
  stdout: '',
  stderr: '',
  executionTime: 0,
  entryFile: null
});

const buildDefaultAiReport = () => ({
  summary: 'AI analysis not executed.',
  files: [],
  fixes: [],
  aiUsed: false,
  fallbackUsed: false,
  errors: []
});

const toPortablePath = (basePath, absolutePath) => path.relative(basePath, absolutePath).split(path.sep).join('/');

const isJsFile = (absolutePath) => path.extname(absolutePath).toLowerCase() === JS_EXTENSION;

const normalizeSeverity = (value) => {
  if (typeof value !== 'string') {
    return 'low';
  }

  const normalized = value.toLowerCase();
  return SEVERITY_VALUES.has(normalized) ? normalized : 'low';
};

const normalizeConfidence = (value) => {
  if (typeof value !== 'string') {
    return 'low';
  }

  const normalized = value.toLowerCase();
  return CONFIDENCE_VALUES.has(normalized) ? normalized : 'low';
};

const normalizeLineNumber = (value) => (Number.isInteger(value) && value > 0 ? value : -1);

const normalizeFinding = (finding = {}) => {
  const normalized = finding && typeof finding === 'object' && !Array.isArray(finding) ? finding : {};

  return {
    ...normalized,
    severity: normalizeSeverity(normalized.severity),
    confidence: normalizeConfidence(normalized.confidence),
    file:
      typeof normalized.file === 'string' && normalized.file.trim().length > 0
        ? normalized.file
        : DEFAULT_FILE,
    line: normalizeLineNumber(normalized.line),
    message:
      typeof normalized.message === 'string' && normalized.message.trim().length > 0
        ? normalized.message
        : DEFAULT_MESSAGE,
    context:
      typeof normalized.context === 'string' && normalized.context.trim().length > 0 ? normalized.context : DEFAULT_CONTEXT,
    suggestion:
      typeof normalized.suggestion === 'string' && normalized.suggestion.trim().length > 0
        ? normalized.suggestion
        : DEFAULT_SUGGESTION
  };
};

const buildSeveritySummary = (findings) => {
  const severitySummary = buildDefaultSeveritySummary();

  for (const finding of findings) {
    const severity = normalizeSeverity(finding.severity);
    severitySummary[severity] += 1;
  }

  return severitySummary;
};

const normalizeExecution = (execution) => {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    return buildDefaultExecution();
  }

  return {
    attempted: Boolean(execution.attempted),
    success: Boolean(execution.success),
    error: typeof execution.error === 'string' ? execution.error : '',
    stdout: typeof execution.stdout === 'string' ? execution.stdout : '',
    stderr: typeof execution.stderr === 'string' ? execution.stderr : '',
    executionTime: Number.isFinite(execution.executionTime) && execution.executionTime >= 0 ? execution.executionTime : 0,
    entryFile: typeof execution.entryFile === 'string' ? execution.entryFile : null
  };
};

const normalizeAiReport = (aiReport) => {
  if (!aiReport || typeof aiReport !== 'object' || Array.isArray(aiReport)) {
    return buildDefaultAiReport();
  }

  return {
    summary: typeof aiReport.summary === 'string' ? aiReport.summary : buildDefaultAiReport().summary,
    files: Array.isArray(aiReport.files) ? aiReport.files : [],
    fixes: Array.isArray(aiReport.fixes) ? aiReport.fixes : [],
    aiUsed: Boolean(aiReport.aiUsed),
    fallbackUsed: Boolean(aiReport.fallbackUsed),
    errors: Array.isArray(aiReport.errors) ? aiReport.errors.map((errorValue) => String(errorValue)) : []
  };
};

const normalizeResult = ({ success, error, summary, findings, execution, aiReport }) => {
  const normalizedFindings = Array.isArray(findings) ? findings.map((finding) => normalizeFinding(finding)) : [];
  const resolvedSummary = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {};
  const totalFiles =
    Number.isInteger(resolvedSummary.totalFiles) && resolvedSummary.totalFiles >= 0 ? resolvedSummary.totalFiles : 0;
  const issuesFound =
    Number.isInteger(resolvedSummary.issuesFound) && resolvedSummary.issuesFound >= 0
      ? resolvedSummary.issuesFound
      : normalizedFindings.length;

  return {
    success: Boolean(success),
    error: typeof error === 'string' && error.trim().length > 0 ? error : null,
    summary: {
      totalFiles,
      issuesFound,
      severity: buildSeveritySummary(normalizedFindings)
    },
    findings: normalizedFindings,
    execution: normalizeExecution(execution),
    aiReport: normalizeAiReport(aiReport)
  };
};

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

const validateProjectPath = async (projectPath) => {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    throw new Error('projectPath must be a non-empty string');
  }

  if (projectPath.includes('\0')) {
    throw new Error('projectPath contains invalid null bytes');
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const stats = await fsPromises.stat(resolvedProjectPath);
  if (!stats.isDirectory()) {
    throw new Error('projectPath must point to a directory');
  }

  return resolvedProjectPath;
};

const collectFilesRecursively = async (projectPath) => {
  const files = [];
  const directoriesToScan = [projectPath];

  while (directoriesToScan.length > 0) {
    const currentDirectory = directoriesToScan.pop();
    const entries = await fsPromises.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === NODE_MODULES_DIRECTORY) {
          continue;
        }

        directoriesToScan.push(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  return files;
};

const buildJsFileEntries = (projectPath, absolutePaths) =>
  absolutePaths
    .filter((absolutePath) => isJsFile(absolutePath))
    .map((absolutePath) => ({
      absolutePath,
      relativePath: toPortablePath(projectPath, absolutePath)
    }));

const runStaticSecurityAnalysis = async (jsFileEntries) => {
  const findings = [];
  const readErrors = [];

  for (const fileEntry of jsFileEntries) {
    let fileContent;
    try {
      fileContent = await fsPromises.readFile(fileEntry.absolutePath, 'utf8');
    } catch (error) {
      readErrors.push(`Failed to read ${fileEntry.relativePath}: ${error.message}`);
      continue;
    }

    const fileFindings = securityScanner.scanFile({
      filePath: fileEntry.relativePath,
      fileContent
    });

    findings.push(...fileFindings.map((finding) => normalizeFinding(finding)));
  }

  return {
    findings,
    readErrors
  };
};

const runSandboxStage = async ({ projectPath, entryFile }) => {
  if (!entryFile) {
    return buildDefaultExecution();
  }

  try {
    const executionResult = await executeSandbox({
      codePath: projectPath,
      entryFile
    });

    return {
      attempted: true,
      success: Boolean(executionResult && executionResult.success),
      error: executionResult && typeof executionResult.error === 'string' ? executionResult.error : '',
      stdout: executionResult && typeof executionResult.stdout === 'string' ? executionResult.stdout : '',
      stderr: executionResult && typeof executionResult.stderr === 'string' ? executionResult.stderr : '',
      executionTime: executionResult && Number.isFinite(executionResult.executionTime) ? executionResult.executionTime : 0,
      entryFile
    };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      error: error.message,
      stdout: '',
      stderr: '',
      executionTime: 0,
      entryFile
    };
  }
};

const buildAiSnippet = ({ relativePath, fileContent }) => {
  const prefix = `// file: ${relativePath}\n`;
  const maxBodyLength = Math.max(0, MAX_AI_SNIPPET_CHARACTERS - prefix.length);
  return `${prefix}${fileContent.slice(0, maxBodyLength)}`;
};

const runAiLayer = async (jsFileEntries) => {
  const aiReport = buildDefaultAiReport();
  const targetFiles = jsFileEntries.slice(0, MAX_AI_FILES);
  const uniqueFixes = new Set();
  let aiCalls = 0;
  let nonFallbackCalls = 0;
  let totalAiCharacters = 0;

  if (targetFiles.length === 0) {
    aiReport.summary = 'No JavaScript files available for AI analysis.';
    return aiReport;
  }

  if (!process.env.OPENAI_API_KEY) {
    aiReport.summary = 'AI analysis skipped: OPENAI_API_KEY is not configured.';
    return aiReport;
  }

  for (const fileEntry of targetFiles) {
    let fileContent;
    try {
      fileContent = await fsPromises.readFile(fileEntry.absolutePath, 'utf8');
    } catch (error) {
      aiReport.errors.push(`Failed to read ${fileEntry.relativePath}: ${error.message}`);
      continue;
    }

    if (!fileContent.trim()) {
      continue;
    }

    if (fileContent.length > MAX_AI_FILE_CHARACTERS) {
      aiReport.errors.push(`AI input rejected for ${fileEntry.relativePath}: file content too large`);
      continue;
    }

    const snippet = buildAiSnippet({
      relativePath: fileEntry.relativePath,
      fileContent
    });

    if (totalAiCharacters + snippet.length > MAX_AI_TOTAL_CHARACTERS) {
      aiReport.errors.push('AI input rejected: total input size limit exceeded');
      break;
    }

    try {
      const aiResult = await aiService.explainCode(snippet);
      totalAiCharacters += snippet.length;

      aiCalls += 1;
      if (!aiResult.fallbackUsed) {
        nonFallbackCalls += 1;
      }

      for (const fix of Array.isArray(aiResult.fixes) ? aiResult.fixes : []) {
        uniqueFixes.add(fix);
      }

      aiReport.files.push({
        file: fileEntry.relativePath,
        summary: typeof aiResult.summary === 'string' ? aiResult.summary : '',
        issues: Array.isArray(aiResult.issues) ? aiResult.issues : [],
        fixes: Array.isArray(aiResult.fixes) ? aiResult.fixes : [],
        aiReliable: Boolean(aiResult.aiReliable),
        fallbackUsed: Boolean(aiResult.fallbackUsed),
        warning: typeof aiResult.warning === 'string' ? aiResult.warning : ''
      });
    } catch (error) {
      aiReport.errors.push(`AI analysis failed for ${fileEntry.relativePath}: ${error.message}`);
    }
  }

  aiReport.fixes = Array.from(uniqueFixes);
  aiReport.aiUsed = nonFallbackCalls > 0;
  aiReport.fallbackUsed = aiCalls > nonFallbackCalls;
  aiReport.summary = `Analyzed ${targetFiles.length} file(s) for AI explanations.`;

  return aiReport;
};

async function analyzeProject(projectPath) {
  const fallbackResult = normalizeResult({
    success: false,
    error: null,
    summary: buildDefaultSummary(),
    findings: [],
    execution: buildDefaultExecution(),
    aiReport: buildDefaultAiReport()
  });

  try {
    return await executeWithTimeout(
      async () => {
        const resolvedProjectPath = await validateProjectPath(projectPath);
        const allFiles = await collectFilesRecursively(resolvedProjectPath);
        const jsFileEntries = buildJsFileEntries(resolvedProjectPath, allFiles);
        const { findings, readErrors } = await runStaticSecurityAnalysis(jsFileEntries);
        const entryFile = detectEntryFile(jsFileEntries.map((fileEntry) => fileEntry.relativePath));
        const execution = await runSandboxStage({
          projectPath: resolvedProjectPath,
          entryFile
        });
        const aiReport = await runAiLayer(jsFileEntries);

        if (readErrors.length > 0) {
          aiReport.errors.push(...readErrors);
        }

        return normalizeResult({
          success: true,
          error: null,
          summary: {
            totalFiles: jsFileEntries.length,
            issuesFound: findings.length,
            severity: buildSeveritySummary(findings)
          },
          findings,
          execution,
          aiReport
        });
      },
      SCAN_TIMEOUT_MS,
      'Project scan timed out'
    );
  } catch (error) {
    fallbackResult.aiReport.summary = 'Project analysis failed.';
    fallbackResult.aiReport.errors.push(error.message);
    fallbackResult.success = false;
    fallbackResult.error = error.message;
    return normalizeResult(fallbackResult);
  }
}

module.exports = {
  analyzeProject
};
