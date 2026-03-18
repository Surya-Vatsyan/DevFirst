'use strict';

const express = require('express');
const healthController = require('../controllers/health.controller');
const uploadController = require('../controllers/upload.controller');
const uploadZipMiddleware = require('../middlewares/upload.middleware');

const router = express.Router();

router.get('/health', healthController.getHealth);
router.post('/api/upload', uploadZipMiddleware, uploadController.uploadFile);

module.exports = router;
