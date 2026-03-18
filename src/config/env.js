'use strict';

const ALLOWED_NODE_ENVS = ['development', 'test', 'production'];

const parsePort = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return parsed;
};

const nodeEnv = process.env.NODE_ENV || 'development';
if (!ALLOWED_NODE_ENVS.includes(nodeEnv)) {
  throw new Error('NODE_ENV must be development, test, or production');
}

const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: parsePort(process.env.PORT || '3000')
};

module.exports = {
  env
};
