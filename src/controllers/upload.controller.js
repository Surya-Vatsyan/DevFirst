'use strict';

const logger = require('../utils/logger');
const zipExtractionService = require('../services/zip-extraction.service');
const codebaseAnalyzerService = require('../services/codebase-analyzer.service');

const uploadFile = async (req, res, next) => {
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
    const report = await codebaseAnalyzerService.analyzeExtractedFolder({
      extractionFolder: extractionResult.extractionFolder,
      requestId: req.requestId
    });

    logger.info('ZIP file uploaded', {
      requestId: req.requestId,
      fileName: req.file.filename,
      mimeType: req.file.mimetype,
      size: req.file.size,
      extractedFiles: extractionResult.totalFiles
    });

    res.status(201).json({
      success: true,
      message: 'File uploaded, extracted, and analyzed successfully',
      data: {
        fileName: req.file.filename,
        size: req.file.size,
        extractionFolder: extractionResult.extractionFolder,
        extractedFiles: extractionResult.extractedFiles,
        totalFiles: extractionResult.totalFiles,
        report
      },
      requestId: req.requestId
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  uploadFile
};
