'use strict';

const fsPromises = require('fs/promises');
const path = require('path');
const aiService = require('./ai.service');
const logger = require('../utils/logger');

const MAX_FILES_PER_REQUEST = 5;
const MAX_CHUNKS_PER_FILE = 3;
const MAX_LINES_PER_CHUNK = 500;
const MAX_CHUNK_CHARACTERS = 7000;
const SEVERITY_PRIORITY = {
  high: 3,
  medium: 2,
  low: 1
};
const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);
const projectRootDirectory = path.join(__dirname, '..', '..');
const uploadsRootDirectory = path.join(projectRootDirectory, 'uploads');

const throwBadRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
};

const toPortablePath = (filePath) => filePath.split(path.sep).join('/');

const resolveExtractionDirectory = (extractionFolder) => {
  if (!extractionFolder || typeof extractionFolder !== 'string') {
    throwBadRequest('extractionFolder must be a non-empty string');
  }

  if (path.isAbsolute(extractionFolder) || extractionFolder.includes('\0')) {
    throwBadRequest('Invalid extraction folder path');
  }

  const resolvedUploadsRoot = path.resolve(uploadsRootDirectory);
  const resolvedExtractionDirectory = path.resolve(projectRootDirectory, extractionFolder);

  if (
    resolvedExtractionDirectory === resolvedUploadsRoot ||
    !resolvedExtractionDirectory.startsWith(`${resolvedUploadsRoot}${path.sep}`)
  ) {
    throwBadRequest('Unsafe extraction folder path');
  }

  return resolvedExtractionDirectory;
};

const resolveSafeFilePath = (extractionDirectory, inputPath) => {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throwBadRequest('Each selected file path must be a non-empty string');
  }

  if (inputPath.includes('\0')) {
    throwBadRequest('Invalid file path');
  }

  const resolvedExtractionDirectory = path.resolve(extractionDirectory);
  const resolvedFilePath = path.resolve(resolvedExtractionDirectory, inputPath);

  if (
    resolvedFilePath !== resolvedExtractionDirectory &&
    !resolvedFilePath.startsWith(`${resolvedExtractionDirectory}${path.sep}`)
  ) {
    throwBadRequest('Selected file path is outside extraction folder');
  }

  return resolvedFilePath;
};

const normalizeIssueForReport = (issueValue, filePath, chunkIndex) => {
  const chunkPrefix = chunkIndex ? `[chunk ${chunkIndex}] ` : '';

  if (typeof issueValue === 'string') {
    return {
      issue: `${chunkPrefix}${issueValue}`,
      severity: 'low',
      confidence: 'low',
      file: filePath
    };
  }

  if (!issueValue || typeof issueValue !== 'object' || Array.isArray(issueValue)) {
    return {
      issue: `${chunkPrefix}Invalid issue format returned by AI`,
      severity: 'low',
      confidence: 'low',
      file: filePath
    };
  }

  const issueText = typeof issueValue.issue === 'string' ? issueValue.issue.trim() : '';
  const severity =
    typeof issueValue.severity === 'string' && SEVERITY_PRIORITY[issueValue.severity.toLowerCase()]
      ? issueValue.severity.toLowerCase()
      : 'low';
  const confidence =
    typeof issueValue.confidence === 'string' && CONFIDENCE_VALUES.has(issueValue.confidence.toLowerCase())
      ? issueValue.confidence.toLowerCase()
      : 'low';

  if (!issueText) {
    return {
      issue: `${chunkPrefix}Unspecified issue from AI`,
      severity,
      confidence,
      file: filePath
    };
  }

  return {
    issue: `${chunkPrefix}${issueText}`,
    severity,
    confidence,
    file: filePath
  };
};

const addIssueForReport = (issueMap, issueEntry) => {
  const normalizedSeverity = SEVERITY_PRIORITY[issueEntry.severity] ? issueEntry.severity : 'low';
  const normalizedConfidence = CONFIDENCE_VALUES.has(issueEntry.confidence) ? issueEntry.confidence : 'low';
  const normalizedFile = typeof issueEntry.file === 'string' ? issueEntry.file : 'unknown';
  const normalizedIssue = typeof issueEntry.issue === 'string' ? issueEntry.issue : 'Unspecified issue';
  const issueKey = `${normalizedFile}::${normalizedSeverity}::${normalizedConfidence}::${normalizedIssue}`;

  if (!issueMap.has(issueKey)) {
    issueMap.set(issueKey, {
      issue: normalizedIssue,
      severity: normalizedSeverity,
      confidence: normalizedConfidence,
      file: normalizedFile
    });
  }
};

const buildGroupedIssuesByFile = (issues) => {
  const groupedMap = new Map();

  for (const issueEntry of issues) {
    if (!groupedMap.has(issueEntry.file)) {
      groupedMap.set(issueEntry.file, []);
    }

    groupedMap.get(issueEntry.file).push({
      issue: issueEntry.issue,
      severity: issueEntry.severity,
      confidence: issueEntry.confidence
    });
  }

  return Array.from(groupedMap.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([file, fileIssues]) => ({
      file,
      issues: fileIssues.sort((leftIssue, rightIssue) => {
        const leftPriority = SEVERITY_PRIORITY[leftIssue.severity] || 0;
        const rightPriority = SEVERITY_PRIORITY[rightIssue.severity] || 0;

        if (rightPriority !== leftPriority) {
          return rightPriority - leftPriority;
        }

        return leftIssue.issue.localeCompare(rightIssue.issue);
      })
    }));
};

const buildSummaryStats = (issues) => {
  const summaryStats = {
    high: 0,
    medium: 0,
    low: 0
  };

  for (const issueEntry of issues) {
    const severity = issueEntry && typeof issueEntry.severity === 'string' ? issueEntry.severity.toLowerCase() : 'low';
    if (severity === 'high') {
      summaryStats.high += 1;
    } else if (severity === 'medium') {
      summaryStats.medium += 1;
    } else {
      summaryStats.low += 1;
    }
  }

  return summaryStats;
};

const splitIntoChunks = (fileContent) => {
  const lines = fileContent.split(/\r?\n/);
  const chunks = [];
  const maxLineWindow = MAX_CHUNKS_PER_FILE * MAX_LINES_PER_CHUNK;
  const limitedLines = lines.slice(0, maxLineWindow);

  for (let index = 0; index < limitedLines.length; index += MAX_LINES_PER_CHUNK) {
    chunks.push(limitedLines.slice(index, index + MAX_LINES_PER_CHUNK).join('\n'));
  }

  return {
    chunks,
    totalLines: lines.length,
    truncated: lines.length > maxLineWindow
  };
};

const runDebuggerPipeline = async ({ extractionFolder, selectedFiles, requestId }) => {
  if (!Array.isArray(selectedFiles)) {
    throwBadRequest('selectedFiles must be an array');
  }

  const extractionDirectory = resolveExtractionDirectory(extractionFolder);
  const limitedFiles = selectedFiles.slice(0, MAX_FILES_PER_REQUEST);
  const issueMap = new Map();
  const uniqueFixes = new Set();
  let processedChunks = 0;

  for (const inputFilePath of limitedFiles) {
    const safeAbsolutePath = resolveSafeFilePath(extractionDirectory, inputFilePath);
    const relativePathFromExtraction = toPortablePath(path.relative(extractionDirectory, safeAbsolutePath));
    const displayFilePath = toPortablePath(path.join(extractionFolder, relativePathFromExtraction));

    let fileContent;
    try {
      fileContent = await fsPromises.readFile(safeAbsolutePath, 'utf8');
    } catch (error) {
      addIssueForReport(issueMap, {
        issue: 'Unable to read file',
        severity: 'medium',
        confidence: 'high',
        file: displayFilePath
      });
      logger.warn('AI orchestrator could not read selected file', {
        requestId,
        path: displayFilePath,
        errorMessage: error.message
      });
      continue;
    }

    if (!fileContent.trim()) {
      addIssueForReport(issueMap, {
        issue: 'File is empty and was skipped',
        severity: 'low',
        confidence: 'high',
        file: displayFilePath
      });
      continue;
    }

    const chunkResult = splitIntoChunks(fileContent);
    const chunksToAnalyze = chunkResult.chunks.slice(0, MAX_CHUNKS_PER_FILE);

    if (chunkResult.truncated) {
      addIssueForReport(issueMap, {
        issue: `Partial analysis: analyzed first ${MAX_CHUNKS_PER_FILE} chunks only`,
        severity: 'low',
        confidence: 'high',
        file: displayFilePath
      });
    }

    let chunkIndex = 0;
    for (const chunkContent of chunksToAnalyze) {
      chunkIndex += 1;

      let safeChunkContent = chunkContent;
      if (safeChunkContent.length > MAX_CHUNK_CHARACTERS) {
        safeChunkContent = safeChunkContent.slice(0, MAX_CHUNK_CHARACTERS);
        addIssueForReport(issueMap, {
          issue: `[chunk ${chunkIndex}] Chunk content was truncated before AI analysis`,
          severity: 'low',
          confidence: 'high',
          file: displayFilePath
        });
      }

      const snippetWithContext =
        `// file: ${displayFilePath}\n` +
        `// chunk: ${chunkIndex}/${chunksToAnalyze.length}\n` +
        safeChunkContent;

      try {
        const debuggerResult = await aiService.explainCode(snippetWithContext);
        processedChunks += 1;

        for (const issueValue of debuggerResult.issues) {
          const normalizedIssue = normalizeIssueForReport(issueValue, displayFilePath, chunkIndex);
          addIssueForReport(issueMap, normalizedIssue);
        }

        for (const fix of debuggerResult.fixes) {
          uniqueFixes.add(`[${displayFilePath}#${chunkIndex}] ${fix}`);
        }
      } catch (error) {
        addIssueForReport(issueMap, {
          issue: `[chunk ${chunkIndex}] AI analysis failed for chunk`,
          severity: 'medium',
          confidence: 'high',
          file: displayFilePath
        });
        logger.warn('AI chunk analysis failed', {
          requestId,
          path: displayFilePath,
          chunkIndex,
          errorMessage: error.message
        });
      }
    }
  }

  const issues = Array.from(issueMap.values())
    .sort((leftIssue, rightIssue) => {
      const leftPriority = SEVERITY_PRIORITY[leftIssue.severity] || 0;
      const rightPriority = SEVERITY_PRIORITY[rightIssue.severity] || 0;

      if (rightPriority !== leftPriority) {
        return rightPriority - leftPriority;
      }

      const fileComparison = leftIssue.file.localeCompare(rightIssue.file);
      if (fileComparison !== 0) {
        return fileComparison;
      }

      return leftIssue.issue.localeCompare(rightIssue.issue);
    });
  const files = buildGroupedIssuesByFile(issues);
  const summaryStats = buildSummaryStats(issues);
  const fixes = Array.from(uniqueFixes);

  const summary = `Analyzed ${limitedFiles.length} file(s) in ${processedChunks} chunk(s). Found ${issues.length} issue(s) and ${fixes.length} fix(es).`;

  logger.info('AI debugger orchestration completed', {
    requestId,
    extractionFolder,
    filesRequested: selectedFiles.length,
    filesProcessed: limitedFiles.length,
    processedChunks,
    issues: issues.length,
    fixes: fixes.length
  });

  return {
    summary,
    summaryStats,
    issues,
    files,
    fixes
  };
};

module.exports = {
  runDebuggerPipeline
};
