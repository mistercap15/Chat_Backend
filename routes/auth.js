const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middlewares/auth');
const { authLimiter } = require('../middlewares/rateLimit');

// POST /api/auth/register — create account and receive JWT
router.post('/register', authLimiter, authController.register);

// POST /api/auth/token/refresh — exchange valid token for a fresh one
router.post('/token/refresh', authenticate, authController.refreshToken);

module.exports = router;
