'use strict';

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const unzipper = require('unzipper');
const logger = require('../utils/logger');

const ALLOWED_EXTENSIONS = new Set(['.js', '.json', '.ts']);
const MAX_ZIP_ENTRIES = 5000;
const MAX_ZIP_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_FILE_SIZE_BYTES = 2 * 1024 * 1024;
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

const getEntryUncompressedSize = (entry) => {
  if (entry && Number.isFinite(entry.uncompressedSize)) {
    return entry.uncompressedSize;
  }

  if (entry && entry.vars && Number.isFinite(entry.vars.uncompressedSize)) {
    return entry.vars.uncompressedSize;
  }

  return null;
};

const createSizeLimiter = (maxBytes, relativeEntryPath) => {
  let totalBytes = 0;

  return new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const error = new Error(`File too large in ZIP: ${relativeEntryPath}`);
        error.statusCode = 413;
        callback(error);
        return;
      }

      callback(null, chunk);
    }
  });
};

const extractZipFile = async ({ zipFilePath, requestId }) => {
  if (!zipFilePath || typeof zipFilePath !== 'string') {
    throwBadRequest('ZIP file path is required');
  }

  let zipStats;
  try {
    zipStats = await fsPromises.stat(zipFilePath);
  } catch {
    throwBadRequest('ZIP file not found');
  }

  if (!zipStats.isFile()) {
    throwBadRequest('ZIP file path is invalid');
  }

  if (zipStats.size > MAX_ZIP_SIZE_BYTES) {
    const error = new Error('ZIP file is too large');
    error.statusCode = 413;
    throw error;
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

  try {
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

      const uncompressedSize = getEntryUncompressedSize(entry);
      if (Number.isFinite(uncompressedSize) && uncompressedSize > MAX_EXTRACTED_FILE_SIZE_BYTES) {
        const error = new Error(`File too large in ZIP: ${relativeEntryPath}`);
        error.statusCode = 413;
        throw error;
      }

      if (seenRelativePaths.has(relativeEntryPath)) {
        throwBadRequest('ZIP contains duplicate file paths');
      }

      seenRelativePaths.add(relativeEntryPath);
      const destinationPath = resolveDestinationPath(extractionDirectory, relativeEntryPath);

      await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
      await pipeline(
        entry.stream(),
        createSizeLimiter(MAX_EXTRACTED_FILE_SIZE_BYTES, relativeEntryPath),
        fs.createWriteStream(destinationPath, { flags: 'wx' })
      );

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
  } catch (error) {
    await fsPromises.rm(extractionDirectory, { recursive: true, force: true });
    throw error;
  }
};

module.exports = {
  extractZipFile
};
