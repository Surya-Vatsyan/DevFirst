'use strict';

const express = require('express');
const routes = require('./src/routes');
const requestContextMiddleware = require('./src/middlewares/request-context.middleware');
const requestLoggerMiddleware = require('./src/middlewares/request-logger.middleware');
const rateLimitMiddleware = require('./src/middlewares/rate-limit.middleware');
const errorMiddleware = require('./src/middlewares/error.middleware');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestContextMiddleware);
app.use(requestLoggerMiddleware);
app.use(rateLimitMiddleware);
app.use(routes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    requestId: req.requestId
  });
});

app.use(errorMiddleware);

module.exports = app;
