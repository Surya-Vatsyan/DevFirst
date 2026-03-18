'use strict';

const { randomUUID } = require('crypto');

const requestContextMiddleware = (req, res, next) => {
  const incomingRequestId = req.headers['x-request-id'];
  const requestId =
    typeof incomingRequestId === 'string' && incomingRequestId.trim().length > 0
      ? incomingRequestId.trim()
      : randomUUID();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
};

module.exports = requestContextMiddleware;
