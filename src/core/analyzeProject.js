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
const SEVERITY_VALUES = new Set(['low', 'medium', 'high']);
const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);

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

const enhanceFindingWithTaintMetadata = (finding) => ({
  ...finding,
  severity: normalizeSeverity(finding.severity),
  confidence: normalizeConfidence(finding.confidence),
  context:
    typeof finding.context === 'string' && finding.context.trim().length > 0
      ? finding.context
      : 'No taint flow context available.'
});

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

    findings.push(...fileFindings.map(enhanceFindingWithTaintMetadata));
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

    try {
      const aiResult = await aiService.explainCode(
        buildAiSnippet({
          relativePath: fileEntry.relativePath,
          fileContent
        })
      );

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
  const fallbackResult = {
    summary: {
      totalFiles: 0,
      issuesFound: 0
    },
    findings: [],
    execution: buildDefaultExecution(),
    aiReport: buildDefaultAiReport()
  };

  try {
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

    return {
      summary: {
        totalFiles: jsFileEntries.length,
        issuesFound: findings.length
      },
      findings,
      execution,
      aiReport
    };
  } catch (error) {
    fallbackResult.aiReport.summary = 'Project analysis failed.';
    fallbackResult.aiReport.errors.push(error.message);
    return fallbackResult;
  }
}

module.exports = {
  analyzeProject
};
