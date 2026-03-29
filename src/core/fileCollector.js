'use strict';

const fsPromises = require('fs/promises');
const path = require('path');

const JS_EXTENSION = '.js';
const NODE_MODULES_DIRECTORY = 'node_modules';

const toPortablePath = (basePath, absolutePath) => path.relative(basePath, absolutePath).split(path.sep).join('/');

const isJsFile = (absolutePath) => path.extname(absolutePath).toLowerCase() === JS_EXTENSION;

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

module.exports = {
  validateProjectPath,
  collectFilesRecursively,
  buildJsFileEntries
};
