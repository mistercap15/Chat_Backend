const { Expo } = require('expo-server-sdk');
const User = require('../models/User');
const Chat = require('../models/Chat');
const { activeRooms, randomChatMessages } = require('../utils/activeRooms');
const logger = require('../utils/logger');
const { sendPushToUser, templates } = require('../utils/pushNotifications');

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// ─── Update Push Token ────────────────────────────────────────────────────────

/**
 * PUT /api/users/push-token
 * Registers or clears the Expo push token for the authenticated user.
 * Body: { token: string | null }
 */
exports.updatePushToken = async (req, res) => {
  try {
    const userId = req.userId;
    const { token } = req.body;

    // Allow null/empty to clear the token (e.g. user revokes notification permission)
    if (token !== null && token !== undefined && token !== '') {
      if (!Expo.isExpoPushToken(token)) {
        return res.status(400).json({ message: 'Invalid Expo push token format.' });
      }
    }

    await User.findByIdAndUpdate(userId, {
      expoPushToken: token || null,
    });

    logger.info('Push token updated', { userId, hasToken: !!token });
    return res.status(200).json({ message: token ? 'Push token registered.' : 'Push token cleared.' });
  } catch (err) {
    logger.error('Error in updatePushToken', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Update User ─────────────────────────────────────────────────────────────

exports.updateUser = async (req, res) => {
  try {
    const userId = req.userId; // set by auth middleware
    const { user_name, gender, bio, interests } = req.body;

    if (!user_name || typeof user_name !== 'string' || user_name.trim().length < 2) {
      return res.status(400).json({ message: 'Username must be at least 2 characters.' });
    }
    if (user_name.trim().length > 30) {
      return res.status(400).json({ message: 'Username must not exceed 30 characters.' });
    }
    if (!gender || !['Male', 'Female', 'Unknown'].includes(gender)) {
      return res.status(400).json({ message: 'Gender must be Male, Female, or Unknown.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const nameConflict = await User.findOne({ user_name: user_name.trim(), _id: { $ne: userId } });
    if (nameConflict) {
      return res.status(409).json({ message: 'Username already taken.' });
    }

    user.user_name = user_name.trim();
    user.gender = gender;
    user.bio = bio ? String(bio).trim().slice(0, 300) : '';
    user.interests = Array.isArray(interests)
      ? interests.map((i) => String(i).trim()).slice(0, 20)
      : [];

    await user.save();
    logger.info('User updated', { userId });

    return res.status(200).json({
      message: 'Profile updated successfully.',
      user: {
        _id: user._id,
        user_name: user.user_name,
        gender: user.gender,
        bio: user.bio,
        interests: user.interests,
      },
    });
  } catch (err) {
    logger.error('Error in updateUser', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Upload Profile Picture ───────────────────────────────────────────────────

exports.uploadProfilePicture = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No image file uploaded.' });
    }

    const userId = req.userId;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const relativePath = `/uploads/${req.file.filename}`;
    user.profilePicture = relativePath;
    await user.save();

    logger.info('Profile picture updated', { userId });
    return res.status(200).json({ message: 'Profile picture updated.', profilePicture: relativePath });
  } catch (err) {
    logger.error('Error in uploadProfilePicture', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Send Friend Request ──────────────────────────────────────────────────────

exports.sendFriendRequest = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId } = req.body;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      return res.status(400).json({ message: 'Invalid friendId.' });
    }
    if (userId === friendId) {
      return res.status(400).json({ message: 'Cannot send friend request to yourself.' });
    }

    const [user, friend] = await Promise.all([
      User.findById(userId),
      User.findById(friendId),
    ]);

    if (!user || !friend) {
      return res.status(404).json({ message: 'User not found.' });
    }
    if (user.friends.some((id) => id.toString() === friendId)) {
      return res.status(400).json({ message: 'Already friends.' });
    }
    if (friend.friendRequests.some((r) => r.fromUserId.toString() === userId && r.status === 'pending')) {
      return res.status(400).json({ message: 'Friend request already sent.' });
    }

    friend.friendRequests.push({ fromUserId: userId, status: 'pending' });
    await friend.save();

    req.io.to(friendId).emit('friend_request_received', {
      fromUserId: userId,
      fromUsername: user.user_name,
    });

    const room = activeRooms.get(userId);
    if (room && room.type === 'random' && room.partnerId === friendId) {
      req.io.to(room.roomId).emit('friend_request_status', {
        fromUserId: userId,
        toUserId: friendId,
        fromUsername: user.user_name,
        status: 'sent',
      });
    }

    // Push notification — fire-and-forget, do not await to avoid blocking response
    sendPushToUser(
      friendId,
      templates.friendRequest(user.user_name, userId),
      User
    ).catch((err) => logger.error('Push failed for friendRequest', { error: err.message }));

    logger.info('Friend request sent', { fromUserId: userId, toUserId: friendId });
    return res.status(200).json({ message: 'Friend request sent.' });
  } catch (err) {
    logger.error('Error in sendFriendRequest', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Accept Friend Request ────────────────────────────────────────────────────

exports.acceptFriendRequest = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId } = req.body;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      return res.status(400).json({ message: 'Invalid friendId.' });
    }

    const [user, friend] = await Promise.all([
      User.findById(userId),
      User.findById(friendId),
    ]);

    if (!user || !friend) {
      return res.status(404).json({ message: 'User not found.' });
    }
    if (user.friends.some((id) => id.toString() === friendId)) {
      return res.status(400).json({ message: 'Already friends.' });
    }

    const request = user.friendRequests.find((r) => r.fromUserId.toString() === friendId);
    if (!request || request.status !== 'pending') {
      return res.status(400).json({ message: 'No pending friend request from this user.' });
    }

    user.friends.push(friendId);
    friend.friends.push(userId);
    user.friendRequests = user.friendRequests.filter((r) => r.fromUserId.toString() !== friendId);

    await Promise.all([user.save(), friend.save()]);

    // Persist any random chat messages into permanent chat history
    const roomId = [userId, friendId].sort().join('-');
    const messages = randomChatMessages.get(roomId) || [];
    if (messages.length > 0) {
      let chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
      if (!chat) {
        chat = new Chat({ participants: [userId, friendId], messages: [] });
      }
      chat.messages.push(...messages);
      await chat.save();
      randomChatMessages.delete(roomId);
    }

    activeRooms.delete(userId);
    activeRooms.delete(friendId);

    req.io.to(userId).emit('friend_request_accepted', { userId, friendId, friendUsername: friend.user_name });
    req.io.to(friendId).emit('friend_request_accepted', { userId: friendId, friendId: userId, friendUsername: user.user_name });
    req.io.to(userId).emit('friend_added', { friendId, friendUsername: friend.user_name });
    req.io.to(friendId).emit('friend_added', { friendId: userId, friendUsername: user.user_name });

    // Push notification to the original requester (friendId sent the request, userId accepted it)
    sendPushToUser(
      friendId,
      templates.friendAccepted(user.user_name, userId),
      User
    ).catch((err) => logger.error('Push failed for friendAccepted', { error: err.message }));

    logger.info('Friend request accepted', { userId, friendId });
    return res.status(200).json({ message: 'Friend request accepted.' });
  } catch (err) {
    logger.error('Error in acceptFriendRequest', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Reject Friend Request ────────────────────────────────────────────────────

exports.rejectFriendRequest = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId } = req.body;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      return res.status(400).json({ message: 'Invalid friendId.' });
    }

    const [user, friend] = await Promise.all([
      User.findById(userId),
      User.findById(friendId),
    ]);

    if (!user || !friend) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const hasPending = user.friendRequests.some((r) => r.fromUserId.toString() === friendId);
    if (!hasPending) {
      return res.status(400).json({ message: 'No pending friend request from this user.' });
    }

    user.friendRequests = user.friendRequests.filter((r) => r.fromUserId.toString() !== friendId);
    friend.friendRequests = friend.friendRequests.filter((r) => r.fromUserId.toString() !== userId);
    await Promise.all([user.save(), friend.save()]);

    const room = activeRooms.get(userId);
    if (room && room.type === 'random' && room.partnerId === friendId) {
      req.io.to(room.roomId).emit('friend_request_status', {
        fromUserId: friendId,
        toUserId: userId,
        status: 'rejected',
      });
    }

    logger.info('Friend request rejected', { userId, friendId });
    return res.status(200).json({ message: 'Friend request rejected.' });
  } catch (err) {
    logger.error('Error in rejectFriendRequest', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Remove Friend ────────────────────────────────────────────────────────────

exports.removeFriend = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId } = req.params;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      return res.status(400).json({ message: 'Invalid friendId.' });
    }

    const [user, friend] = await Promise.all([
      User.findById(userId),
      User.findById(friendId),
    ]);

    if (!user || !friend) {
      return res.status(404).json({ message: 'User not found.' });
    }
    if (!user.friends.some((id) => id.toString() === friendId)) {
      return res.status(400).json({ message: 'Not friends with this user.' });
    }

    user.friends = user.friends.filter((id) => id.toString() !== friendId);
    friend.friends = friend.friends.filter((id) => id.toString() !== userId);

    await Promise.all([
      user.save(),
      friend.save(),
      Chat.deleteOne({ participants: { $all: [userId, friendId] } }),
    ]);

    req.io.to(userId).emit('friend_removed', { removedUserId: friendId });
    req.io.to(friendId).emit('friend_removed', { removedUserId: userId });

    logger.info('Friend removed', { userId, friendId });
    return res.status(200).json({ message: 'Friend removed successfully.' });
  } catch (err) {
    logger.error('Error in removeFriend', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Delete Account ───────────────────────────────────────────────────────────

exports.deleteUser = async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const friendIds = user.friends.map((id) => id.toString());

    await Promise.all([
      User.updateMany({ friends: userId }, { $pull: { friends: userId } }),
      User.updateMany(
        { 'friendRequests.fromUserId': userId },
        { $pull: { friendRequests: { fromUserId: userId } } }
      ),
      Chat.deleteMany({ participants: userId }),
    ]);

    // Clean up in-memory state
    activeRooms.delete(userId);
    for (const [key, room] of activeRooms) {
      if (room.partnerId === userId) {
        randomChatMessages.delete(room.roomId); // Fix: use room.roomId, not key
        activeRooms.delete(key);
      }
    }

    // Notify friends
    friendIds.forEach((fid) => {
      req.io.to(fid).emit('friend_removed', { removedUserId: userId });
    });
    req.io.to(userId).emit('user_deleted', { userId });

    await User.findByIdAndDelete(userId);

    logger.info('User account deleted', { userId });
    return res.status(200).json({ message: 'Account deleted successfully.' });
  } catch (err) {
    logger.error('Error in deleteUser', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Get Friends ──────────────────────────────────────────────────────────────

exports.getFriends = async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId)
      .populate('friends', 'user_name gender bio profilePicture lastSeen');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.status(200).json({ friends: user.friends });
  } catch (err) {
    logger.error('Error in getFriends', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Get Pending Friend Requests ──────────────────────────────────────────────

exports.getPendingFriendRequests = async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId)
      .populate('friendRequests.fromUserId', 'user_name gender profilePicture');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const pending = user.friendRequests
      .filter((r) => r.status === 'pending')
      .map((r) => ({
        fromUserId: r.fromUserId._id.toString(),
        fromUsername: r.fromUserId.user_name || 'Anonymous',
        gender: r.fromUserId.gender,
        profilePicture: r.fromUserId.profilePicture,
      }));

    return res.status(200).json({ friendRequests: pending });
  } catch (err) {
    logger.error('Error in getPendingFriendRequests', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Get User By ID (public) ──────────────────────────────────────────────────

exports.getUserById = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId || !OBJECT_ID_RE.test(userId)) {
      return res.status(400).json({ message: 'Invalid userId.' });
    }

    const user = await User.findById(userId)
      .select('user_name gender bio interests profilePicture lastSeen');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.status(200).json({
      _id: user._id,
      user_name: user.user_name,
      gender: user.gender,
      bio: user.bio,
      interests: user.interests,
      profilePicture: user.profilePicture,
      lastSeen: user.lastSeen,
    });
  } catch (err) {
    logger.error('Error in getUserById', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};
