const User = require('../models/User');
const Chat = require('../models/Chat');
const logger = require('../utils/logger');

/**
 * GET /api/admin/stats
 * Returns high-level application statistics.
 */
exports.getStats = async (_req, res) => {
  try {
    const [totalUsers, totalChats, newUsersToday] = await Promise.all([
      User.countDocuments(),
      Chat.countDocuments(),
      User.countDocuments({
        createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      }),
    ]);

    return res.status(200).json({ totalUsers, totalChats, newUsersToday });
  } catch (err) {
    logger.error('Error in getStats', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * GET /api/admin/users
 * Returns a paginated list of all users.
 * Query: page, limit, search
 */
exports.listUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const search = req.query.search ? String(req.query.search).trim() : '';

    const filter = search
      ? { user_name: { $regex: search, $options: 'i' } }
      : {};

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('user_name gender bio interests friends isActive createdAt lastSeen')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments(filter),
    ]);

    return res.status(200).json({
      users,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error('Error in listUsers', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * DELETE /api/admin/users/:userId
 * Force-deletes a user and all associated data.
 */
exports.deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
      return res.status(400).json({ message: 'Invalid userId.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    await Promise.all([
      User.updateMany({ friends: userId }, { $pull: { friends: userId } }),
      User.updateMany(
        { 'friendRequests.fromUserId': userId },
        { $pull: { friendRequests: { fromUserId: userId } } }
      ),
      Chat.deleteMany({ participants: userId }),
    ]);

    await User.findByIdAndDelete(userId);

    logger.info('Admin deleted user', { userId });
    return res.status(200).json({ message: 'User deleted.' });
  } catch (err) {
    logger.error('Error in admin deleteUser', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};
