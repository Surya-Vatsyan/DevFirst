'use strict';

const fsPromises = require('fs/promises');
const path = require('path');
const logger = require('../utils/logger');

const projectRootDirectory = path.join(__dirname, '..', '..');
const reportsDirectory = path.join(projectRootDirectory, 'reports');
const SAFE_REPORT_ID_REGEX = /^[a-zA-Z0-9-]+$/;

const getReportById = async (req, res, next) => {
  try {
    const reportId = req.params ? req.params.reportId : '';
    if (!SAFE_REPORT_ID_REGEX.test(reportId)) {
      const error = new Error('Invalid reportId');
      error.statusCode = 400;
      throw error;
    }

    const reportPath = path.join(reportsDirectory, `${reportId}.json`);
    let reportContent;
    try {
      reportContent = await fsPromises.readFile(reportPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        logger.warn('Report file not found', {
          requestId: req.requestId,
          reportId
        });
        res.status(404).json({
          success: false,
          message: 'Report not found',
          requestId: req.requestId
        });
        return;
      }

      logger.warn('Failed to read report file', {
        requestId: req.requestId,
        reportId,
        errorMessage: error.message
      });
      throw error;
    }

    const report = JSON.parse(reportContent);
    logger.info('Report retrieved successfully', {
      requestId: req.requestId,
      reportId
    });

    res.status(200).json({
      success: true,
      data: report,
      requestId: req.requestId
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getReportById
};
