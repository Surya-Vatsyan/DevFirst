'use strict';

const getHealthStatus = () => ({
  status: 'ok',
  timestamp: new Date().toISOString()
});

module.exports = {
  getHealthStatus
};
