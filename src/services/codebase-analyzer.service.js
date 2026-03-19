'use strict';

const fsPromises = require('fs/promises');
const path = require('path');
const logger = require('../utils/logger');

const LARGE_FILE_THRESHOLD_BYTES = 1024 * 1024;
const MANY_LINES_THRESHOLD = 200;
const MAX_SELECTED_FILES = 5;
const KEYWORD_REGEX = /\b(error|try|catch)\b/i;
const projectRootDirectory = path.join(__dirname, '..', '..');
const uploadsRootDirectory = path.join(projectRootDirectory, 'uploads');

const throwBadRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
};

const throwInternalError = (message) => {
  const error = new Error(message);
  error.statusCode = 500;
  throw error;
};

const toPortableRelativePath = (baseDirectory, absolutePath) =>
  path.relative(baseDirectory, absolutePath).split(path.sep).join('/');

const resolveExtractionDirectory = (extractionFolder) => {
  if (!extractionFolder || typeof extractionFolder !== 'string') {
    throwBadRequest('Extraction folder is required');
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

const getAllFilesRecursively = async (directoryPath) => {
  const allFiles = [];
  const directoriesToScan = [directoryPath];

  while (directoriesToScan.length > 0) {
    const currentDirectory = directoriesToScan.pop();
    const entries = await fsPromises.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        directoriesToScan.push(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        allFiles.push(absolutePath);
      }
    }
  }

  return allFiles;
};

const countFileLines = (fileContent) => {
  if (!fileContent) {
    return 0;
  }

  return fileContent.split(/\r?\n/).length;
};

const addSelectionReason = (selectedFileReasons, relativePath, reason) => {
  if (!selectedFileReasons.has(relativePath)) {
    selectedFileReasons.set(relativePath, new Set());
  }

  selectedFileReasons.get(relativePath).add(reason);
};

const buildSelectedFiles = (selectedFileReasons) => {
  const selectedFiles = [];
  const selectedFileSet = new Set();
  const reasonPriority = ['large', 'manyLines', 'keywords'];

  for (const reason of reasonPriority) {
    for (const [relativePath, reasons] of selectedFileReasons.entries()) {
      if (selectedFiles.length >= MAX_SELECTED_FILES) {
        return selectedFiles;
      }

      if (!reasons.has(reason) || selectedFileSet.has(relativePath)) {
        continue;
      }

      selectedFiles.push(relativePath);
      selectedFileSet.add(relativePath);
    }
  }

  return selectedFiles;
};

const analyzeExtractedFolder = async ({ extractionFolder, requestId }) => {
  const extractionDirectory = resolveExtractionDirectory(extractionFolder);

  let directoryStats;
  try {
    directoryStats = await fsPromises.stat(extractionDirectory);
  } catch (_error) {
    throwInternalError('Extracted folder not found for analysis');
  }

  if (!directoryStats.isDirectory()) {
    throwInternalError('Extracted folder is invalid');
  }

  const files = await getAllFilesRecursively(extractionDirectory);
  const report = {
    totalFiles: 0,
    jsFiles: 0,
    tsFiles: 0,
    jsonFiles: 0,
    largeFiles: [],
    emptyFiles: [],
    selectedFiles: []
  };
  const selectedFileReasons = new Map();

  for (const absoluteFilePath of files) {
    const relativePath = toPortableRelativePath(extractionDirectory, absoluteFilePath);
    const extension = path.extname(relativePath).toLowerCase();
    const fileStats = await fsPromises.stat(absoluteFilePath);

    report.totalFiles += 1;

    if (extension === '.js') {
      report.jsFiles += 1;
    } else if (extension === '.ts') {
      report.tsFiles += 1;
    } else if (extension === '.json') {
      report.jsonFiles += 1;
    }

    if (fileStats.size === 0) {
      report.emptyFiles.push(relativePath);
    }

    if (fileStats.size > LARGE_FILE_THRESHOLD_BYTES) {
      report.largeFiles.push(relativePath);
      addSelectionReason(selectedFileReasons, relativePath, 'large');
    }

    if (fileStats.size === 0) {
      continue;
    }

    let fileContent;
    try {
      fileContent = await fsPromises.readFile(absoluteFilePath, 'utf8');
    } catch (error) {
      logger.warn('Failed to read file during analysis', {
        requestId,
        path: relativePath,
        errorMessage: error.message
      });
      continue;
    }

    const lineCount = countFileLines(fileContent);
    if (lineCount > MANY_LINES_THRESHOLD) {
      addSelectionReason(selectedFileReasons, relativePath, 'manyLines');
    }

    if (KEYWORD_REGEX.test(fileContent)) {
      addSelectionReason(selectedFileReasons, relativePath, 'keywords');
    }
  }

  report.selectedFiles = buildSelectedFiles(selectedFileReasons);

  logger.info('Codebase analysis completed', {
    requestId,
    extractionFolder,
    totalFiles: report.totalFiles,
    largeFiles: report.largeFiles.length,
    emptyFiles: report.emptyFiles.length,
    selectedFiles: report.selectedFiles.length
  });

  return report;
};

module.exports = {
  analyzeExtractedFolder
};
