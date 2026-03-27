'use strict';

const fsPromises = require('fs/promises');
const { randomUUID } = require('crypto');
const path = require('path');
const logger = require('../utils/logger');
const zipExtractionService = require('../services/zip-extraction.service');
const codebaseAnalyzerService = require('../services/codebase-analyzer.service');
const aiOrchestratorService = require('../services/ai-orchestrator.service');
const { detectEntryFile } = require('../../utils/entryDetector');
const { executeSandbox } = require('../../sandbox/executor');

const projectRootDirectory = path.join(__dirname, '..', '..');
const reportsDirectory = path.join(projectRootDirectory, 'reports');

const cleanupUploadArtifacts = async ({ uploadedZipFilePath, extractionFolder, requestId }) => {
  if (uploadedZipFilePath) {
    try {
      await fsPromises.unlink(uploadedZipFilePath);
      logger.info('Uploaded ZIP file cleaned up', {
        requestId,
        path: uploadedZipFilePath
      });
    } catch (error) {
      logger.warn('Failed to clean up uploaded ZIP file', {
        requestId,
        path: uploadedZipFilePath,
        errorMessage: error.message
      });
    }
  }

  if (extractionFolder) {
    const extractionFolderPath = path.resolve(projectRootDirectory, extractionFolder);
    try {
      await fsPromises.rm(extractionFolderPath, {
        recursive: true,
        force: true
      });
      logger.info('Extracted folder cleaned up', {
        requestId,
        path: extractionFolderPath
      });
    } catch (error) {
      logger.warn('Failed to clean up extracted folder', {
        requestId,
        path: extractionFolderPath,
        errorMessage: error.message
      });
    }
  }
};

const scheduleCleanup = ({ uploadedZipFilePath, extractionFolder, requestId }) => {
  if (!uploadedZipFilePath && !extractionFolder) {
    return;
  }

  setImmediate(() => {
    void cleanupUploadArtifacts({ uploadedZipFilePath, extractionFolder, requestId });
  });
};

const persistReport = async ({ reportId, reportData, requestId }) => {
  try {
    await fsPromises.mkdir(reportsDirectory, { recursive: true });
    const reportFilePath = path.join(reportsDirectory, `${reportId}.json`);
    const payload = {
      reportId,
      timestamp: new Date().toISOString(),
      reportData
    };
    await fsPromises.writeFile(reportFilePath, JSON.stringify(payload, null, 2), 'utf8');
    logger.info('Analysis report saved', {
      requestId,
      reportId,
      path: reportFilePath
    });
  } catch (error) {
    logger.warn('Failed to save analysis report', {
      requestId,
      reportId,
      errorMessage: error.message
    });
  }
};

const uploadFile = async (req, res, next) => {
  const uploadedZipFilePath = req.file ? req.file.path : null;
  let extractionFolder;

  try {
    if (!req.file) {
      const error = new Error('File is required. Use form-data field "file"');
      error.statusCode = 400;
      throw error;
    }

    const extractionResult = await zipExtractionService.extractZipFile({
      zipFilePath: req.file.path,
      requestId: req.requestId
    });
    extractionFolder = extractionResult.extractionFolder;
    const report = await codebaseAnalyzerService.analyzeExtractedFolder({
      extractionFolder: extractionResult.extractionFolder,
      requestId: req.requestId
    });
    let execution = {
      attempted: false,
      success: false,
      error: '',
      stdout: '',
      stderr: '',
      executionTime: 0
    };

    let entryFile = null;
    try {
      entryFile = detectEntryFile(extractionResult.extractedFiles);
      logger.info('Entry file detection completed', {
        requestId: req.requestId,
        extractionFolder: extractionResult.extractionFolder,
        entryFile
      });

      if (entryFile) {
        logger.info('Sandbox execution started', {
          requestId: req.requestId,
          extractionFolder: extractionResult.extractionFolder,
          entryFile
        });

        const executionResult = await executeSandbox({
          codePath: extractionResult.extractionFolder,
          entryFile
        });

        execution = {
          attempted: true,
          success: Boolean(executionResult && executionResult.success),
          error: executionResult && typeof executionResult.error === 'string' ? executionResult.error : '',
          stdout: executionResult && typeof executionResult.stdout === 'string' ? executionResult.stdout : '',
          stderr: executionResult && typeof executionResult.stderr === 'string' ? executionResult.stderr : '',
          executionTime:
            executionResult && Number.isFinite(executionResult.executionTime) ? executionResult.executionTime : 0
        };

        logger.info('Sandbox execution completed', {
          requestId: req.requestId,
          extractionFolder: extractionResult.extractionFolder,
          entryFile,
          success: execution.success,
          executionTime: execution.executionTime,
          error: execution.error
        });
      } else {
        logger.info('Sandbox execution skipped: no entry file detected', {
          requestId: req.requestId,
          extractionFolder: extractionResult.extractionFolder
        });
      }
    } catch (executionError) {
      execution = {
        attempted: Boolean(entryFile),
        success: false,
        error: executionError.message,
        stdout: '',
        stderr: '',
        executionTime: 0
      };

      logger.warn('Sandbox execution failed', {
        requestId: req.requestId,
        extractionFolder: extractionResult.extractionFolder,
        entryFile,
        errorMessage: executionError.message
      });
    }

    report.execution = execution;

    const aiReport = await aiOrchestratorService.runDebuggerPipeline({
      extractionFolder: extractionResult.extractionFolder,
      selectedFiles: report.selectedFiles,
      requestId: req.requestId
    });
    const fallbackUsed = Boolean(aiReport && aiReport.fallbackUsed);
    const aiUsed = Boolean(aiReport && aiReport.aiUsed) && !fallbackUsed;
    const reportId = randomUUID();

    logger.info('ZIP file uploaded', {
      requestId: req.requestId,
      fileName: req.file.filename,
      mimeType: req.file.mimetype,
      size: req.file.size,
      extractedFiles: extractionResult.totalFiles,
      selectedFiles: report.selectedFiles.length
    });

    const responsePayload = {
      success: true,
      status: 'completed',
      aiUsed,
      fallbackUsed,
      filesAnalyzed: report.selectedFiles.length,
      message: 'Analysis completed successfully',
      data: {
        reportId,
        fileName: req.file.filename,
        size: req.file.size,
        extractionFolder: extractionResult.extractionFolder,
        extractedFiles: extractionResult.extractedFiles,
        totalFiles: extractionResult.totalFiles,
        report,
        aiReport
      },
      requestId: req.requestId
    };

    await persistReport({
      reportId,
      reportData: responsePayload,
      requestId: req.requestId
    });

    res.status(201).json(responsePayload);
  } catch (error) {
    next(error);
  } finally {
    scheduleCleanup({
      uploadedZipFilePath,
      extractionFolder,
      requestId: req.requestId
    });
  }
};

module.exports = {
  uploadFile
};
