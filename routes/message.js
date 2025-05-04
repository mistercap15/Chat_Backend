const express = require('express');
const { sendMessage, getChatHistory } = require('../controllers/messageController');

const router = express.Router();

router.post('/send', sendMessage);
router.get('/history', getChatHistory);

module.exports = router;
