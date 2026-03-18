'use strict';

const { env } = require('../config/env');
const logger = require('../utils/logger');

const errorMiddleware = (error, req, res, _next) => {
  const isBodyParserSyntaxError = error instanceof SyntaxError && error.status === 400 && 'body' in error;
  const statusCode = isBodyParserSyntaxError
    ? 400
    : Number.isInteger(error.statusCode)
      ? error.statusCode
      : 500;
  const message = isBodyParserSyntaxError
    ? 'Malformed JSON payload'
    : statusCode >= 500
      ? 'Internal server error'
      : error.message;

  logger.error('Unhandled request error', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    statusCode,
    error: error.message
  });

  res.status(statusCode).json({
    success: false,
    message,
    requestId: req.requestId,
    ...(env.isProduction ? {} : { details: error.message })
  });
};

module.exports = errorMiddleware;
