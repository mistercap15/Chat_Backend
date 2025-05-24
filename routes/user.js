const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

router.post('/create', userController.createUser);
router.post('/send-friend-request', userController.sendFriendRequest);
router.post('/accept-friend-request', userController.acceptFriendRequest);
router.post('/reject-friend-request', userController.rejectFriendRequest);
router.delete('/remove-friend/:userId/:friendId', userController.removeFriend);
router.post('/delete', userController.deleteUser);
router.get('/friends/:userId', userController.getFriends);
router.get('/pending-friend-requests/:userId', userController.getPendingFriendRequests);
router.get('/:userId', userController.getUserById); // New route for getting user by ID

module.exports = router;