'use strict';

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const unzipper = require('unzipper');
const logger = require('../utils/logger');

const ALLOWED_EXTENSIONS = new Set(['.js', '.json', '.ts']);
const MAX_ZIP_ENTRIES = 5000;
const uploadsRootDirectory = path.join(__dirname, '..', '..', 'uploads');

const throwBadRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
};

const normalizeEntryPath = (entryPath) => {
  const safeEntryPath = String(entryPath || '').replace(/\\/g, '/');
  const normalizedPath = path.posix.normalize(safeEntryPath);

  if (
    !normalizedPath ||
    normalizedPath === '.' ||
    normalizedPath === '..' ||
    normalizedPath.includes('\0') ||
    path.posix.isAbsolute(normalizedPath) ||
    normalizedPath.startsWith('../')
  ) {
    throwBadRequest('ZIP contains unsafe file path');
  }

  return normalizedPath;
};

const resolveDestinationPath = (extractionDirectory, relativeEntryPath) => {
  const destinationPath = path.resolve(extractionDirectory, relativeEntryPath);
  const resolvedExtractionDirectory = path.resolve(extractionDirectory);

  if (
    destinationPath !== resolvedExtractionDirectory &&
    !destinationPath.startsWith(`${resolvedExtractionDirectory}${path.sep}`)
  ) {
    throwBadRequest('ZIP extraction attempted unsafe path traversal');
  }

  return destinationPath;
};

const openArchive = async (zipFilePath) => {
  try {
    return await unzipper.Open.file(zipFilePath);
  } catch (_error) {
    throwBadRequest('Invalid or corrupted ZIP file');
  }
};

const extractZipFile = async ({ zipFilePath, requestId }) => {
  if (!zipFilePath || typeof zipFilePath !== 'string') {
    throwBadRequest('ZIP file path is required');
  }

  const archive = await openArchive(zipFilePath);
  const archiveEntries = Array.isArray(archive.files) ? archive.files : [];

  if (archiveEntries.length === 0) {
    throwBadRequest('ZIP archive is empty');
  }

  if (archiveEntries.length > MAX_ZIP_ENTRIES) {
    const error = new Error('ZIP has too many files');
    error.statusCode = 413;
    throw error;
  }

  const extractionFolderId = randomUUID();
  const extractionDirectory = path.join(uploadsRootDirectory, extractionFolderId);
  await fsPromises.mkdir(extractionDirectory, { recursive: true });

  const extractedFiles = [];
  const seenRelativePaths = new Set();

  for (const entry of archiveEntries) {
    if (entry.type !== 'File') {
      continue;
    }

    const relativeEntryPath = normalizeEntryPath(entry.path);
    const extension = path.extname(relativeEntryPath).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      continue;
    }

    if (seenRelativePaths.has(relativeEntryPath)) {
      throwBadRequest('ZIP contains duplicate file paths');
    }

    seenRelativePaths.add(relativeEntryPath);
    const destinationPath = resolveDestinationPath(extractionDirectory, relativeEntryPath);

    await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
    await pipeline(entry.stream(), fs.createWriteStream(destinationPath, { flags: 'wx' }));

    extractedFiles.push(relativeEntryPath);
  }

  if (extractedFiles.length === 0) {
    throwBadRequest('ZIP does not contain allowed files (.js, .json, .ts)');
  }

  logger.info('ZIP extraction completed', {
    requestId,
    extractionFolderId,
    totalFiles: extractedFiles.length
  });

  return {
    extractionFolder: `uploads/${extractionFolderId}`,
    extractedFiles,
    totalFiles: extractedFiles.length
  };
};

module.exports = {
  extractZipFile
};
