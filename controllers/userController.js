const User = require('../models/User');
const Chat = require('../models/Chat');
const { activeRooms, randomChatMessages } = require('../utils/activeRooms');

const log = (message, data) => {
  console.log(`[${new Date().toISOString()}] UserController: ${message}`, data || '');
};

exports.createUser = async (req, res) => {
  log('Received createUser request', { body: req.body });
  try {
    const { user_name, gender, bio, interests, userId } = req.body;

    if (!user_name || !gender) {
      log('Validation failed: Missing required fields', { user_name, gender });
      return res.status(400).json({ message: 'Username and gender are required.' });
    }

    if (!['Male', 'Female', 'Unknown'].includes(gender)) {
      log('Validation failed: Invalid gender', { gender });
      return res.status(400).json({ message: 'Invalid gender.' });
    }

    let user;
    if (userId && /^[0-9a-fA-F]{24}$/.test(userId)) {
      log('Updating existing user', { userId });
      user = await User.findById(userId);
      if (!user) {
        log('User not found', { userId });
        return res.status(404).json({ message: 'User not found.' });
      }

      const existingUser = await User.findOne({ user_name, _id: { $ne: userId } });
      if (existingUser) {
        log('Username already in use', { user_name });
        return res.status(400).json({ message: 'Username already in use.' });
      }

      user.user_name = user_name;
      user.gender = gender;
      user.bio = bio || '';
      user.interests = interests || [];
    } else {
      log('Creating new user', { user_name });
      const existingUser = await User.findOne({ user_name });
      if (existingUser) {
        log('Username already in use', { user_name });
        return res.status(400).json({ message: 'Username already in use.' });
      }

      user = new User({
        user_name,
        gender,
        bio: bio || '',
        interests: interests || [],
        friends: [],
        friendRequests: [],
      });
    }

    await user.save();
    log('User saved successfully', { userId: user._id, user_name });

    res.status(201).json({
      message: userId ? 'User updated' : 'User created',
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
    res.status(500).json({ message: err.message });
  }
};

exports.sendFriendRequest = async (req, res) => {
  log('Received sendFriendRequest request', { body: req.body });
  try {
    const { userId, friendId } = req.body;

    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      log('Validation failed: Invalid userId or friendId', { userId, friendId });
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }
    if (userId === friendId) {
      log('Validation failed: Cannot send friend request to self', { userId });
      return res.status(400).json({ message: 'Cannot send friend request to self.' });
    }

    const user = await User.findById(userId);
    const friend = await User.findById(friendId);

    if (!user || !friend) {
      log('User or friend not found', { userId, friendId });
      return res.status(404).json({ message: 'User or friend not found.' });
    }

    if (user.friends.includes(friendId)) {
      log('Already friends', { userId, friendId });
      return res.status(400).json({ message: 'Already friends.' });
    }

    if (friend.friendRequests.some((req) => req.fromUserId.toString() === userId && req.status === 'pending')) {
      log('Friend request already sent', { userId, friendId });
      return res.status(400).json({ message: 'Friend request already sent.' });
    }

    friend.friendRequests.push({
      fromUserId: userId,
      status: 'pending',
    });

    await friend.save();
    log('Friend request saved', { fromUserId: userId, toUserId: friendId });

    req.io.to(friendId).emit('friend_request_received', {
      fromUserId: userId,
      fromUsername: user.user_name,
    });
    log('Emitted friend_request_received', { toUserId: friendId, fromUsername: user.user_name });

    res.status(200).json({ message: 'Friend request sent.' });
  } catch (err) {
    log('Error in sendFriendRequest', { error: err.message });
    res.status(500).json({ message: err.message });
  }
};

exports.acceptFriendRequest = async (req, res) => {
  log('Received acceptFriendRequest request', { body: req.body });
  try {
    const { userId, friendId } = req.body;

    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      log('Validation failed: Invalid userId or friendId', { userId, friendId });
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const user = await User.findById(userId);
    const friend = await User.findById(friendId);

    if (!user || !friend) {
      log('User or friend not found', { userId, friendId });
      return res.status(404).json({ message: 'User or friend not found.' });
    }

    if (user.friends.includes(friendId)) {
      log('Already friends', { userId, friendId });
      return res.status(400).json({ message: 'Already friends.' });
    }

    const request = user.friendRequests.find((req) => req.fromUserId.toString() === friendId);
    if (!request || request.status !== 'pending') {
      log('No pending friend request', { userId, friendId });
      return res.status(400).json({ message: 'No pending friend request.' });
    }

    user.friends.push(friendId);
    friend.friends.push(userId);
    user.friendRequests = user.friendRequests.filter((req) => req.fromUserId.toString() !== friendId);

    await user.save();
    await friend.save();
    log('Friendship established', { userId, friendId });

    // Persist random chat messages if they exist
    const roomId = [userId, friendId].sort().join('-');
    const messages = randomChatMessages.get(roomId) || [];
    if (messages.length > 0) {
      log('Persisting random chat messages', { roomId, messageCount: messages.length });
      let chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
      if (!chat) {
        chat = new Chat({
          participants: [userId, friendId],
          messages: [],
        });
      }
      chat.messages.push(...messages);
      await chat.save();
      randomChatMessages.delete(roomId);
      log('Messages persisted and cleared', { roomId });
    }

    activeRooms.delete(userId);
    activeRooms.delete(friendId);
    log('Cleared active rooms', { userId, friendId });

    req.io.to(userId).emit('friend_request_accepted', {
      friendId,
      friendUsername: friend.user_name,
    });
    req.io.to(friendId).emit('friend_request_accepted', {
      friendId: userId,
      friendUsername: user.user_name,
    });
    log('Emitted friend_request_accepted', { userId, friendId });

    res.status(200).json({ message: 'Friend request accepted.' });
  } catch (err) {
    log('Error in acceptFriendRequest', { error: err.message });
    res.status(500).json({ message: err.message });
  }
};

exports.rejectFriendRequest = async (req, res) => {
  log('Received rejectFriendRequest request', { body: req.body });
  try {
    const { userId, friendId } = req.body;

    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      log('Validation failed: Invalid userId or friendId', { userId, friendId });
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      log('User not found', { userId });
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!user.friendRequests.some((req) => req.fromUserId.toString() === friendId)) {
      log('No pending friend request', { userId, friendId });
      return res.status(400).json({ message: 'No pending friend request.' });
    }

    user.friendRequests = user.friendRequests.filter((req) => req.fromUserId.toString() !== friendId);
    await user.save();
    log('Friend request rejected', { userId, friendId });

    res.status(200).json({ message: 'Friend request rejected.' });
  } catch (err) {
    log('Error in rejectFriendRequest', { error: err.message });
    res.status(500).json({ message: err.message });
  }
};

exports.removeFriend = async (req, res) => {
  log('Received removeFriend request', { params: req.params });
  try {
    const { userId, friendId } = req.params;

    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      log('Validation failed: Invalid userId or friendId', { userId, friendId });
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const user = await User.findById(userId);
    const friend = await User.findById(friendId);

    if (!user || !friend) {
      log('User or friend not found', { userId, friendId });
      return res.status(404).json({ message: 'User or friend not found.' });
    }

    if (!user.friends.includes(friendId)) {
      log('Not friends with this user', { userId, friendId });
      return res.status(400).json({ message: 'Not friends with this user.' });
    }

    user.friends = user.friends.filter((id) => id.toString() !== friendId);
    friend.friends = friend.friends.filter((id) => id.toString() !== userId);

    await user.save();
    await friend.save();
    log('Friendship removed', { userId, friendId });

    req.io.to(userId).emit('friend_removed', { removedUserId: friendId });
    req.io.to(friendId).emit('friend_removed', { removedUserId: userId });
    log('Emitted friend_removed', { userId, friendId });

    res.status(200).json({ message: 'Friend removed successfully.' });
  } catch (err) {
    log('Error in removeFriend', { error: err.message });
    res.status(500).json({ message: err.message });
  }
};

exports.deleteUser = async (req, res) => {
  log('Received deleteUser request', { body: req.body });
  try {
    const { userId } = req.body;

    // Validate userId
    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
      log('Validation failed: Invalid userId', { userId });
      return res.status(400).json({ message: 'Invalid userId.' });
    }

    log('Attempting to find user', { userId });
    const user = await User.findById(userId);
    if (!user) {
      log('User not found or already deleted', { userId });
      return res.status(200).json({ message: 'User already deleted or not found.' });
    }

    log('Removing user from friends lists', { userId });
    await User.updateMany(
      { friends: userId },
      { $pull: { friends: userId } }
    );

    log('Clearing friend requests', { userId });
    await User.updateMany(
      { 'friendRequests.fromUserId': userId },
      { $pull: { friendRequests: { fromUserId: userId } } }
    );
    await User.updateMany(
      { _id: userId },
      { $set: { friendRequests: [] } }
    );

    log('Deleting user chats', { userId });
    await Chat.deleteMany({
      participants: userId,
    });

    log('Clearing socket states', { userId });
    activeRooms.delete(userId);
    for (const [roomId, room] of activeRooms) {
      if (room.partnerId === userId) {
        activeRooms.delete(roomId);
        randomChatMessages.delete(roomId);
      }
    }

    log('Notifying friends of removal', { userId });
    user.friends.forEach((friendId) => {
      req.io.to(friendId.toString()).emit('friend_removed', { removedUserId: userId });
    });

    log('Deleting user from database', { userId });
    await User.findByIdAndDelete(userId);

    log('Emitting user_deleted event', { userId });
    req.io.to(userId).emit('user_deleted', { userId });

    log('User deleted and event emitted', { userId });
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

    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
      log('Validation failed: Invalid userId', { userId });
      return res.status(400).json({ message: 'Invalid userId.' });
    }

    const user = await User.findById(userId).populate('friends', 'user_name');
    if (!user) {
      log('User not found', { userId });
      return res.status(404).json({ message: 'User not found.' });
    }

    log('Friends retrieved', { userId, friendCount: user.friends.length });
    res.status(200).json({ friends: user.friends });
  } catch (err) {
    log('Error in getFriends', { error: err.message });
    res.status(500).json({ message: err.message });
  }
};