'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const multer = require('multer');

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ZIP_EXTENSION = '.zip';
const ALLOWED_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'multipart/x-zip'
]);

const uploadsDirectory = path.join(__dirname, '..', '..', 'uploads');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDirectory);
  },
  filename: (_req, _file, cb) => {
    cb(null, `${randomUUID()}${ZIP_EXTENSION}`);
  }
});

const fileFilter = (_req, file, cb) => {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const hasAllowedExtension = extension === ZIP_EXTENSION;
  const hasAllowedMimeType = ALLOWED_MIME_TYPES.has(file.mimetype);

  if (!hasAllowedExtension || !hasAllowedMimeType) {
    const error = new Error('Only .zip files are allowed');
    error.statusCode = 400;
    return cb(error);
  }

  return cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1
  }
});

const uploadZipMiddleware = (req, res, next) => {
  upload.single('file')(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        error.statusCode = 413;
        error.message = 'File too large. Max allowed size is 10MB';
      } else {
        error.statusCode = 400;
      }
    }

    return next(error);
  });
};

module.exports = uploadZipMiddleware;
