const express = require('express');
const { createUser, addFriend, removeFriend } = require('../controllers/userController');

const router = express.Router();

router.post('/create', createUser);
router.post('/add-friend', addFriend);
router.post('/remove-friend', removeFriend);

module.exports = router;
