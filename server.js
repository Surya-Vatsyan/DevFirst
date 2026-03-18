'use strict';

require('dotenv').config();

const app = require('./app');
const { env } = require('./src/config/env');
const logger = require('./src/utils/logger');

const server = app.listen(env.port, () => {
  logger.info('HTTP server started', {
    environment: env.nodeEnv,
    port: env.port
  });
});

server.on('error', (error) => {
  logger.error('HTTP server failed to start', { error: error.message });
  process.exit(1);
});

const shutdown = () => {
  logger.info('Shutdown signal received');
  server.close((error) => {
    if (error) {
      logger.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
    logger.info('HTTP server stopped');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason instanceof Error ? reason.message : String(reason)
  });
  process.exit(1);
});
