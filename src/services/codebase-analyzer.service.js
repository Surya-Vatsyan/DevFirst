'use strict';

const fsPromises = require('fs/promises');
const path = require('path');
const logger = require('../utils/logger');

const LARGE_FILE_THRESHOLD_BYTES = 1024 * 1024;
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
    emptyFiles: []
  };

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
    }
  }

  logger.info('Codebase analysis completed', {
    requestId,
    extractionFolder,
    totalFiles: report.totalFiles,
    largeFiles: report.largeFiles.length,
    emptyFiles: report.emptyFiles.length
  });

  return report;
};

module.exports = {
  analyzeExtractedFolder
};
