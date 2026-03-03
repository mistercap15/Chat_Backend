const { Expo } = require('expo-server-sdk');
const { randomUUID } = require('crypto');
const path = require('path');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3, S3_BUCKET, S3_PUBLIC_URL } = require('../config/s3');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const {
  getRoom,
  deleteRoom,
  getRandomMessages,
  deleteRandomMessages,
} = require('../utils/roomState');
const logger = require('../utils/logger');
const { sendPushToUser, templates } = require('../utils/pushNotifications');

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// ─── Update Push Token ────────────────────────────────────────────────────────

exports.updatePushToken = async (req, res) => {
  try {
    const userId = req.userId;
    const { token } = req.body;

    if (token !== null && token !== undefined && token !== '') {
      if (!Expo.isExpoPushToken(token)) {
        return res.status(400).json({ message: 'Invalid Expo push token format.' });
      }
    }

    await User.findByIdAndUpdate(userId, { expoPushToken: token || null });

    logger.info('Push token updated', { userId, hasToken: !!token });
    return res.status(200).json({ message: token ? 'Push token registered.' : 'Push token cleared.' });
  } catch (err) {
    logger.error('Error in updatePushToken', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── Update User ──────────────────────────────────────────────────────────────

exports.updateUser = async (req, res) => {
  try {
    const userId = req.userId;
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

    // Delete the previous picture from S3 if it was uploaded there
    if (user.profilePicture && S3_BUCKET) {
      try {
        // S3 URLs look like https://bucket.s3.region.amazonaws.com/profiles/...
        // R2 URLs look like https://pub-xxx.r2.dev/profiles/... or custom domain
        // We store the full URL, so extract the key by stripping the base URL
        const oldUrl = user.profilePicture;
        if (oldUrl.startsWith('http')) {
          const urlObj = new URL(oldUrl);
          // The key is the pathname without the leading slash
          const key = urlObj.pathname.slice(1);
          if (key.startsWith('profiles/')) {
            await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
          }
        }
      } catch {
        // Non-fatal — old file may already be gone; log and continue
        logger.warn('Could not delete old profile picture from S3', { userId });
      }
    }

    const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const key = `profiles/${userId}-${randomUUID()}${ext}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const url = `${S3_PUBLIC_URL}/${key}`;
    user.profilePicture = url;
    await user.save();

    logger.info('Profile picture updated', { userId, key });
    return res.status(200).json({ message: 'Profile picture updated.', profilePicture: url });
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

    const room = await getRoom(userId);
    if (room && room.type === 'random' && room.partnerId === friendId) {
      req.io.to(room.roomId).emit('friend_request_status', {
        fromUserId: userId,
        toUserId: friendId,
        fromUsername: user.user_name,
        status: 'sent',
      });
    }

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

    // Migrate random chat messages from Redis → MongoDB before cleaning up
    const roomId = [userId, friendId].sort().join('-');
    const messages = await getRandomMessages(roomId);

    await Promise.all([user.save(), friend.save()]);

    if (messages.length > 0) {
      let chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
      if (!chat) {
        chat = await Chat.create({ participants: [userId, friendId], lastMessageAt: null });
      }
      await Message.insertMany(
        messages.map((m) => ({
          chatId: chat._id,
          senderId: m.senderId,
          text: m.text,
          seen: !!m.seen,
          createdAt: m.timestamp || new Date(),
          updatedAt: m.timestamp || new Date(),
        }))
      );
      chat.lastMessageAt = new Date();
      await chat.save();
    }

    // Clean up Redis state for both users
    await Promise.all([
      deleteRoom(userId),
      deleteRoom(friendId),
      deleteRandomMessages(roomId),
    ]);

    // Notify both users with a single consistent event.
    // friend_request_accepted is intentionally NOT emitted here — that event name
    // is reserved for the in-random-chat socket signal and must not collide with HTTP notifications.
    req.io.to(userId).emit('friend_added', { friendId, friendUsername: friend.user_name });
    req.io.to(friendId).emit('friend_added', { friendId: userId, friendUsername: user.user_name });

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
    await user.save();

    const room = await getRoom(userId);
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
      (async () => {
        const chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
        if (chat) {
          await Message.deleteMany({ chatId: chat._id });
          await Chat.deleteOne({ _id: chat._id });
        }
      })(),
    ]);

    // Clean up Redis friend-chat room state and evict both users' sockets from the room.
    // The friend chat room key uses underscore-joined sorted IDs (distinct from random chat rooms).
    const friendRoomId = [userId, friendId].sort().join('_');
    await Promise.all([deleteRoom(userId), deleteRoom(friendId)]).catch(() => {});
    req.io.in(userId).socketsLeave(friendRoomId);
    req.io.in(friendId).socketsLeave(friendRoomId);

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

    // Clean up DB records
    await Promise.all([
      User.updateMany({ friends: userId }, { $pull: { friends: userId } }),
      User.updateMany(
        { 'friendRequests.fromUserId': userId },
        { $pull: { friendRequests: { fromUserId: userId } } }
      ),
      (async () => {
        const chats = await Chat.find({ participants: userId }).select('_id');
        const chatIds = chats.map((c) => c._id);
        if (chatIds.length > 0) {
          await Message.deleteMany({ chatId: { $in: chatIds } });
          await Chat.deleteMany({ _id: { $in: chatIds } });
        }
      })(),
    ]);

    // Clean up Redis room state for this user
    const room = await getRoom(userId).catch(() => null);
    if (room) {
      await Promise.all([
        deleteRoom(userId),
        deleteRoom(room.partnerId),
        deleteRandomMessages(room.roomId),
      ]);
    }

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
