const mongoose = require('mongoose');
const User = require('../models/User');
const Chat = require('../models/Chat');
const { activeRooms, randomChatMessages } = require('../utils/activeRooms');
const { isValidObjectId, toObjectIdString, hasId, buildRoomId } = require('../utils/chatHelpers');

const log = (message, data) => {
  console.log(`[${new Date().toISOString()}] UserController: ${message}`, data || '');
};

const validateGender = (gender) => ['Male', 'Female', 'Unknown'].includes(gender);

const normalizeProfileInput = ({ user_name, bio, interests }) => ({
  user_name: typeof user_name === 'string' ? user_name.trim() : '',
  bio: typeof bio === 'string' ? bio.trim() : '',
  interests: Array.isArray(interests) ? [...new Set(interests.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))] : [],
});

const ensureChatDocument = async (userId, friendId, session = null) => {
  const participantsHash = [toObjectIdString(userId), toObjectIdString(friendId)].sort().join('_');
  let chat = await Chat.findOne({ participantsHash }).session(session || null);

  if (!chat) {
    chat = new Chat({
      participants: [userId, friendId],
      participantsHash,
      messages: [],
    });
    await chat.save({ session });
  }

  return chat;
};

exports.createUser = async (req, res) => {
  log('Received createUser request', { body: req.body });

  try {
    const { userId, gender } = req.body;
    const profile = normalizeProfileInput(req.body);

    if (!profile.user_name || !gender) {
      return res.status(400).json({ message: 'Username and gender are required.' });
    }

    if (!validateGender(gender)) {
      return res.status(400).json({ message: 'Invalid gender.' });
    }

    let user;

    if (isValidObjectId(userId)) {
      user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      const existingUser = await User.findOne({ user_name: profile.user_name, _id: { $ne: userId } });
      if (existingUser) {
        return res.status(409).json({ message: 'Username already in use.' });
      }

      user.user_name = profile.user_name;
      user.gender = gender;
      user.bio = profile.bio;
      user.interests = profile.interests;
    } else {
      const existingUser = await User.findOne({ user_name: profile.user_name });
      if (existingUser) {
        return res.status(409).json({ message: 'Username already in use.' });
      }

      user = new User({
        user_name: profile.user_name,
        gender,
        bio: profile.bio,
        interests: profile.interests,
        friends: [],
        friendRequests: [],
      });
    }

    await user.save();

    return res.status(isValidObjectId(userId) ? 200 : 201).json({
      message: isValidObjectId(userId) ? 'User updated.' : 'User created.',
      user: {
        _id: user._id,
        user_name: user.user_name,
        gender: user.gender,
        bio: user.bio,
        interests: user.interests,
        friends: user.friends,
      },
    });
  } catch (err) {
    log('Error in createUser', { error: err.message });
    return res.status(500).json({ message: err.message });
  }
};

exports.updateUser = async (req, res) => {
  log('Received updateUser request', { body: req.body });

  try {
    const { userId, gender } = req.body;
    const profile = normalizeProfileInput(req.body);

    if (!isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid userId.' });
    }

    if (!profile.user_name || !gender) {
      return res.status(400).json({ message: 'Username and gender are required.' });
    }

    if (!validateGender(gender)) {
      return res.status(400).json({ message: 'Invalid gender.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const existingUser = await User.findOne({ user_name: profile.user_name, _id: { $ne: userId } });
    if (existingUser) {
      return res.status(409).json({ message: 'Username already in use.' });
    }

    user.user_name = profile.user_name;
    user.gender = gender;
    user.bio = profile.bio;
    user.interests = profile.interests;
    await user.save();

    return res.status(200).json({
      message: 'User updated successfully.',
      user: {
        _id: user._id,
        user_name: user.user_name,
        gender: user.gender,
        bio: user.bio,
        interests: user.interests,
        friends: user.friends,
      },
    });
  } catch (err) {
    log('Error in updateUser', { error: err.message });
    return res.status(500).json({ message: err.message });
  }
};

exports.sendFriendRequest = async (req, res) => {
  log('Received sendFriendRequest request', { body: req.body });

  try {
    const { userId, friendId } = req.body;

    if (!isValidObjectId(userId) || !isValidObjectId(friendId)) {
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const normalizedUserId = toObjectIdString(userId);
    const normalizedFriendId = toObjectIdString(friendId);

    if (normalizedUserId === normalizedFriendId) {
      return res.status(400).json({ message: 'Cannot send friend request to self.' });
    }

    const [user, friend] = await Promise.all([User.findById(normalizedUserId), User.findById(normalizedFriendId)]);
    if (!user || !friend) {
      return res.status(404).json({ message: 'User or friend not found.' });
    }

    if (hasId(user.friends, normalizedFriendId)) {
      return res.status(400).json({ message: 'Already friends.' });
    }

    if (friend.friendRequests.some((request) => toObjectIdString(request.fromUserId) === normalizedUserId && request.status === 'pending')) {
      return res.status(409).json({ message: 'Friend request already sent.' });
    }

    friend.friendRequests.push({
      fromUserId: normalizedUserId,
      status: 'pending',
    });
    await friend.save();

    req.io.to(normalizedFriendId).emit('friend_request_received', {
      fromUserId: normalizedUserId,
      fromUsername: user.user_name,
    });

    const room = activeRooms.get(normalizedUserId);
    if (room && room.type === 'random' && room.partnerId === normalizedFriendId) {
      req.io.to(room.roomId).emit('friend_request_status', {
        fromUserId: normalizedUserId,
        toUserId: normalizedFriendId,
        status: 'sent',
      });
    }

    return res.status(200).json({ message: 'Friend request sent.' });
  } catch (err) {
    log('Error in sendFriendRequest', { error: err.message });
    return res.status(500).json({ message: err.message });
  }
};

exports.acceptFriendRequest = async (req, res) => {
  log('Received acceptFriendRequest request', { body: req.body });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId, friendId } = req.body;
    if (!isValidObjectId(userId) || !isValidObjectId(friendId)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const normalizedUserId = toObjectIdString(userId);
    const normalizedFriendId = toObjectIdString(friendId);

    const [user, friend] = await Promise.all([
      User.findById(normalizedUserId).session(session),
      User.findById(normalizedFriendId).session(session),
    ]);

    if (!user || !friend) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User or friend not found.' });
    }

    const request = user.friendRequests.find(
      (entry) => toObjectIdString(entry.fromUserId) === normalizedFriendId && entry.status === 'pending'
    );

    if (!request) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'No pending friend request.' });
    }

    if (!hasId(user.friends, normalizedFriendId)) {
      user.friends.push(normalizedFriendId);
    }
    if (!hasId(friend.friends, normalizedUserId)) {
      friend.friends.push(normalizedUserId);
    }

    user.friendRequests = user.friendRequests.filter(
      (entry) => !(toObjectIdString(entry.fromUserId) === normalizedFriendId && entry.status === 'pending')
    );

    await user.save({ session });
    await friend.save({ session });

    const roomId = buildRoomId(normalizedUserId, normalizedFriendId);
    const messages = randomChatMessages.get(roomId) || [];

    if (messages.length) {
      const chat = await ensureChatDocument(normalizedUserId, normalizedFriendId, session);
      chat.messages.push(...messages);
      await chat.save({ session });
      randomChatMessages.delete(roomId);
    }

    activeRooms.delete(normalizedUserId);
    activeRooms.delete(normalizedFriendId);

    await session.commitTransaction();

    req.io.to(normalizedUserId).emit('friend_request_accepted', {
      userId: normalizedUserId,
      friendId: normalizedFriendId,
      friendUsername: friend.user_name,
    });

    req.io.to(normalizedFriendId).emit('friend_request_accepted', {
      userId: normalizedFriendId,
      friendId: normalizedUserId,
      friendUsername: user.user_name,
    });

    req.io.to(normalizedUserId).emit('friend_added', {
      friendId: normalizedFriendId,
      friendUsername: friend.user_name,
    });

    req.io.to(normalizedFriendId).emit('friend_added', {
      friendId: normalizedUserId,
      friendUsername: user.user_name,
    });

    return res.status(200).json({ message: 'Friend request accepted.' });
  } catch (err) {
    await session.abortTransaction();
    log('Error in acceptFriendRequest', { error: err.message });
    return res.status(500).json({ message: err.message });
  } finally {
    session.endSession();
  }
};

exports.rejectFriendRequest = async (req, res) => {
  log('Received rejectFriendRequest request', { body: req.body });

  try {
    const { userId, friendId } = req.body;

    if (!isValidObjectId(userId) || !isValidObjectId(friendId)) {
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const normalizedUserId = toObjectIdString(userId);
    const normalizedFriendId = toObjectIdString(friendId);

    const [user, friend] = await Promise.all([User.findById(normalizedUserId), User.findById(normalizedFriendId)]);
    if (!user || !friend) {
      return res.status(404).json({ message: 'User or friend not found.' });
    }

    const previousCount = user.friendRequests.length;
    user.friendRequests = user.friendRequests.filter(
      (entry) => !(toObjectIdString(entry.fromUserId) === normalizedFriendId && entry.status === 'pending')
    );

    if (user.friendRequests.length === previousCount) {
      return res.status(400).json({ message: 'No pending friend request.' });
    }

    await user.save();

    const room = activeRooms.get(normalizedUserId);
    if (room && room.type === 'random' && room.partnerId === normalizedFriendId) {
      req.io.to(room.roomId).emit('friend_request_status', {
        fromUserId: normalizedFriendId,
        toUserId: normalizedUserId,
        status: 'rejected',
      });
    }

    return res.status(200).json({ message: 'Friend request rejected.' });
  } catch (err) {
    log('Error in rejectFriendRequest', { error: err.message });
    return res.status(500).json({ message: err.message });
  }
};

exports.removeFriend = async (req, res) => {
  log('Received removeFriend request', { params: req.params });

  try {
    const { userId, friendId } = req.params;

    if (!isValidObjectId(userId) || !isValidObjectId(friendId)) {
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const normalizedUserId = toObjectIdString(userId);
    const normalizedFriendId = toObjectIdString(friendId);

    const [user, friend] = await Promise.all([User.findById(normalizedUserId), User.findById(normalizedFriendId)]);
    if (!user || !friend) {
      return res.status(404).json({ message: 'User or friend not found.' });
    }

    if (!hasId(user.friends, normalizedFriendId)) {
      return res.status(400).json({ message: 'Not friends with this user.' });
    }

    user.friends = user.friends.filter((id) => toObjectIdString(id) !== normalizedFriendId);
    friend.friends = friend.friends.filter((id) => toObjectIdString(id) !== normalizedUserId);

    await Promise.all([
      Chat.deleteOne({ participantsHash: buildRoomId(normalizedUserId, normalizedFriendId) }),
      user.save(),
      friend.save(),
    ]);

    req.io.to(normalizedUserId).emit('friend_removed', { removedUserId: normalizedFriendId });
    req.io.to(normalizedFriendId).emit('friend_removed', { removedUserId: normalizedUserId });

    return res.status(200).json({ message: 'Friend removed successfully.' });
  } catch (err) {
    log('Error in removeFriend', { error: err.message });
    return res.status(500).json({ message: err.message });
  }
};

exports.deleteUser = async (req, res) => {
  log('Received deleteUser request', { body: req.body });

  try {
    const { userId } = req.body;
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid userId.' });
    }

    const normalizedUserId = toObjectIdString(userId);
    const user = await User.findById(normalizedUserId);

    if (!user) {
      return res.status(200).json({ message: 'User already deleted or not found.' });
    }

    await Promise.all([
      User.updateMany({ friends: normalizedUserId }, { $pull: { friends: normalizedUserId } }),
      User.updateMany({ 'friendRequests.fromUserId': normalizedUserId }, { $pull: { friendRequests: { fromUserId: normalizedUserId } } }),
      Chat.deleteMany({ participants: normalizedUserId }),
    ]);

    activeRooms.delete(normalizedUserId);
    for (const [memberId, room] of activeRooms.entries()) {
      if (room.partnerId === normalizedUserId) {
        activeRooms.delete(memberId);
        randomChatMessages.delete(room.roomId);
      }
    }

    user.friends.forEach((friendId) => {
      req.io.to(toObjectIdString(friendId)).emit('friend_removed', { removedUserId: normalizedUserId });
    });

    await User.findByIdAndDelete(normalizedUserId);
    req.io.to(normalizedUserId).emit('user_deleted', { userId: normalizedUserId });

    return res.status(200).json({ message: 'User deleted successfully.' });
  } catch (err) {
    log('Error in deleteUser', { error: err.message, stack: err.stack });
    return res.status(500).json({ message: 'Failed to delete user.', error: err.message });
  }
};

exports.getFriends = async (req, res) => {
  log('Received getFriends request', { params: req.params });

  try {
    const { userId } = req.params;
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid userId.' });
    }

    const user = await User.findById(userId).populate('friends', 'user_name');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.status(200).json({ friends: user.friends });
  } catch (err) {
    log('Error in getFriends', { error: err.message });
    return res.status(500).json({ message: err.message });
  }
};

exports.getPendingFriendRequests = async (req, res) => {
  log('Received getPendingFriendRequests request', { params: req.params });

  try {
    const { userId } = req.params;
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid userId.' });
    }

    const user = await User.findById(userId).populate('friendRequests.fromUserId', 'user_name');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const friendRequests = user.friendRequests
      .filter((request) => request.status === 'pending' && request.fromUserId)
      .map((request) => ({
        fromUserId: toObjectIdString(request.fromUserId._id),
        fromUsername: request.fromUserId.user_name || 'Anonymous',
      }));

    return res.status(200).json({ friendRequests });
  } catch (err) {
    log('Error in getPendingFriendRequests', { error: err.message });
    return res.status(500).json({ message: err.message });
  }
};

exports.getUserById = async (req, res) => {
  log('Received getUserById request', { params: req.params });

  try {
    const { userId } = req.params;
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid userId.' });
    }

    const user = await User.findById(userId).select('user_name gender bio interests');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.status(200).json({
      _id: user._id,
      user_name: user.user_name,
      gender: user.gender,
      bio: user.bio,
      interests: user.interests,
    });
  } catch (err) {
    log('Error in getUserById', { error: err.message });
    return res.status(500).json({ message: err.message });
  }
};
