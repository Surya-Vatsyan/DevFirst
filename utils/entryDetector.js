'use strict';

const path = require('path');

const PREFERRED_FILES = ['index.js', 'app.js', 'server.js'];
const NODE_MODULES_SEGMENT = /(^|[\\/])node_modules([\\/]|$)/i;

function isValidPath(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isIgnoredPath(filePath) {
  return NODE_MODULES_SEGMENT.test(filePath);
}

function toBaseNameLower(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return path.posix.basename(normalized).toLowerCase();
}

function isJsFile(filePath) {
  return /\.js$/i.test(filePath);
}

function detectEntryFile(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return null;
  }

  const candidates = files.filter((filePath) => {
    return isValidPath(filePath) && !isIgnoredPath(filePath);
  });

  for (const preferred of PREFERRED_FILES) {
    const match = candidates.find((filePath) => {
      return toBaseNameLower(filePath) === preferred;
    });
    if (match) {
      return match;
    }
  }

  const firstJs = candidates.find((filePath) => isJsFile(filePath));
  return firstJs || null;
}

module.exports = {
  detectEntryFile
};
