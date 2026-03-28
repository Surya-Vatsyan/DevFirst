'use strict';

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
const MAX_TRACKED_IPS = 10000;
const CLEANUP_INTERVAL = 200;

const requestCountByIp = new Map();
let requestCounter = 0;

const getClientIp = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim().length > 0) {
    return forwardedFor.split(',')[0].trim();
  }

  if (typeof req.ip === 'string' && req.ip.trim().length > 0) {
    return req.ip;
  }

  if (req.socket && typeof req.socket.remoteAddress === 'string' && req.socket.remoteAddress.trim().length > 0) {
    return req.socket.remoteAddress;
  }

  return 'unknown';
};

const cleanupRateLimitStore = (now) => {
  for (const [ipAddress, entry] of requestCountByIp.entries()) {
    if (!entry || now - entry.windowStart >= WINDOW_MS * 2) {
      requestCountByIp.delete(ipAddress);
    }
  }

  if (requestCountByIp.size > MAX_TRACKED_IPS) {
    const overflow = requestCountByIp.size - MAX_TRACKED_IPS;
    const oldestKeys = requestCountByIp.keys();
    for (let index = 0; index < overflow; index += 1) {
      const oldestKey = oldestKeys.next();
      if (oldestKey.done) {
        break;
      }
      requestCountByIp.delete(oldestKey.value);
    }
  }
};

const rateLimitMiddleware = (req, _res, next) => {
  if (req.path === '/health') {
    return next();
  }

  const now = Date.now();
  const ipAddress = getClientIp(req);
  const currentEntry = requestCountByIp.get(ipAddress);

  if (!currentEntry || now - currentEntry.windowStart >= WINDOW_MS) {
    requestCountByIp.set(ipAddress, {
      windowStart: now,
      count: 1
    });
  } else {
    currentEntry.count += 1;
    requestCountByIp.set(ipAddress, currentEntry);
  }

  const updatedEntry = requestCountByIp.get(ipAddress);
  if (updatedEntry.count > MAX_REQUESTS_PER_WINDOW) {
    const error = new Error('Rate limit exceeded. Try again in a minute.');
    error.statusCode = 429;
    return next(error);
  }

  requestCounter += 1;
  if (requestCounter % CLEANUP_INTERVAL === 0) {
    cleanupRateLimitStore(now);
  }

  return next();
};

module.exports = rateLimitMiddleware;
