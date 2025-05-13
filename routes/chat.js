const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');

const log = (message, data) => {
  console.log(`[${new Date().toISOString()}] ChatRoutes: ${message}`, data || '');
};

// Log incoming requests
router.use((req, res, next) => {
  log(`${req.method} ${req.path}`, { body: req.body, params: req.params });
  next();
});

router.post('/send', chatController.sendMessage);
router.post('/send-random', chatController.sendRandomMessage);
router.get('/:userId/:friendId', chatController.getChatHistory);
router.post('/seen', chatController.markMessageSeen);

module.exports = router;