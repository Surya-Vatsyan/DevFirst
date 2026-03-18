'use strict';

const logger = require('../utils/logger');

const requestLoggerMiddleware = (req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    logger.info('HTTP request completed', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });

  next();
};

module.exports = requestLoggerMiddleware;
