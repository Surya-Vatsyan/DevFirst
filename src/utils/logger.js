'use strict';

const pino = require('pino');
const { env } = require('../config/env');

const defaultLevel = env.isProduction ? 'info' : 'debug';
const level = process.env.LOG_LEVEL || defaultLevel;

const transport = env.isProduction
  ? undefined
  : pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: true,
        translateTime: 'SYS:standard'
      }
    });

const logger = pino(
  {
    level,
    redact: {
      paths: [
        'password',
        '*.password',
        'token',
        '*.token',
        'apiKey',
        '*.apiKey',
        'authorization',
        '*.authorization',
        'headers.authorization'
      ],
      censor: '[REDACTED]'
    }
  },
  transport
);

const sanitizeMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  return metadata;
};

const appLogger = {
  info: (message, metadata = {}) => logger.info(sanitizeMetadata(metadata), message),
  warn: (message, metadata = {}) => logger.warn(sanitizeMetadata(metadata), message),
  error: (message, metadata = {}) => logger.error(sanitizeMetadata(metadata), message),
  debug: (message, metadata = {}) => logger.debug(sanitizeMetadata(metadata), message)
};

module.exports = appLogger;
