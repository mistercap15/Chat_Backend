const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

const log = (message, data) => {
  console.log(`[${new Date().toISOString()}] UserRoutes: ${message}`, data || '');
};

// Log incoming requests
router.use((req, res, next) => {
  log(`${req.method} ${req.path}`, { body: req.body, params: req.params });
  next();
});

router.post('/create', userController.createUser);
router.post('/send-friend-request', userController.sendFriendRequest);
router.post('/accept-friend-request', userController.acceptFriendRequest);
router.post('/reject-friend-request', userController.rejectFriendRequest);
router.delete('/remove-friend/:userId/:friendId', userController.removeFriend);
router.post('/delete', userController.deleteUser);
router.get('/friends/:userId', userController.getFriends);

module.exports = router;