const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticateAdmin } = require('../middlewares/adminAuth');

router.use(authenticateAdmin);

router.get('/stats', adminController.getStats);
router.get('/users', adminController.listUsers);
router.delete('/users/:userId', adminController.deleteUser);

module.exports = router;
