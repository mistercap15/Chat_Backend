const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { authenticate } = require('../middlewares/auth');
const { messageLimiter } = require('../middlewares/rateLimit');

// All chat endpoints require authentication
router.use(authenticate);

router.post('/send', messageLimiter, chatController.sendMessage);
router.post('/send-random', messageLimiter, chatController.sendRandomMessage);
router.get('/:friendId', chatController.getChatHistory);
router.post('/seen', chatController.markMessageSeen);

module.exports = router;
