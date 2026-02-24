const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate } = require('../middlewares/auth');
const upload = require('../middlewares/upload');

// Public: view any user's profile
router.get('/:userId', userController.getUserById);

// All routes below require a valid JWT
router.use(authenticate);

router.put('/profile', userController.updateUser);
router.post('/profile/picture', upload.single('image'), userController.uploadProfilePicture);

router.post('/friend-request/send', userController.sendFriendRequest);
router.post('/friend-request/accept', userController.acceptFriendRequest);
router.post('/friend-request/reject', userController.rejectFriendRequest);

router.get('/me/friends', userController.getFriends);
router.get('/me/friend-requests', userController.getPendingFriendRequests);

router.delete('/friends/:friendId', userController.removeFriend);
router.delete('/account', userController.deleteUser);

// Push notification token management
router.put('/push-token', userController.updatePushToken);

module.exports = router;
