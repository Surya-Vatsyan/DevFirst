'use strict';

const healthService = require('../services/health.service');

const getHealth = (req, res, next) => {
  try {
    const health = healthService.getHealthStatus();
    res.status(200).json({
      success: true,
      data: health
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getHealth
};
