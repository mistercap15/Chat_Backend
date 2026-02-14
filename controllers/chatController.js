const User = require('../models/User');
const Chat = require('../models/Chat');
const { activeRooms, randomChatMessages } = require('../utils/activeRooms');
const {
  isValidObjectId,
  toObjectIdString,
  hasId,
  buildRoomId,
  normalizeMessageText,
} = require('../utils/chatHelpers');

const searchingUsers = new Set();
const DISCONNECT_GRACE_PERIOD = 30000;
const EVENT_RATE_WINDOW_MS = 1000;
const MAX_EVENTS_PER_WINDOW = 20;
const MAX_MESSAGE_LENGTH = 1000;

const log = (message, data) => {
  console.log(`[${new Date().toISOString()}] ChatController: ${message}`, data || '');
};

const userSocketBuckets = new Map();

const getParticipantsHash = (userId, friendId) => [toObjectIdString(userId), toObjectIdString(friendId)].sort().join('_');

const findDirectChat = async (userId, friendId) => {
  const participantsHash = getParticipantsHash(userId, friendId);
  return Chat.findOne({ participantsHash });
};

const cleanupUserRoom = (io, userId) => {
  const room = activeRooms.get(userId);
  if (!room) return;

  io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: userId });
  activeRooms.delete(userId);
  if (room.partnerId) {
    activeRooms.delete(room.partnerId);
  }
  if (room.type === 'random') {
    randomChatMessages.delete(room.roomId);
  }
  log('Cleaned up room state', { userId, roomId: room.roomId, partnerId: room.partnerId, type: room.type });
};

const getSocketByUserId = (io, userId) => {
  for (const [, socket] of io.sockets.sockets) {
    if (socket.userId === userId && socket.connected) {
      return socket;
    }
  }
  return null;
};

const emitAppError = (socket, message, code = 'BAD_REQUEST') => {
  socket.emit('app_error', { code, message });
};

const enforceRateLimit = (socket) => {
  const now = Date.now();
  const bucket = userSocketBuckets.get(socket.id) || [];
  const recent = bucket.filter((stamp) => now - stamp < EVENT_RATE_WINDOW_MS);
  recent.push(now);
  userSocketBuckets.set(socket.id, recent);
  return recent.length <= MAX_EVENTS_PER_WINDOW;
};

const handleSocketConnection = (socket, io) => {
  log('User connected', { socketId: socket.id });

  socket.onAny((eventName) => {
    if (!enforceRateLimit(socket)) {
      emitAppError(socket, `Rate limit exceeded for event ${eventName}`, 'RATE_LIMIT');
      return;
    }
  });

  socket.on('set_username', async ({ userId, username }) => {
    if (!isValidObjectId(userId)) {
      emitAppError(socket, 'Invalid userId');
      return;
    }

    socket.userId = toObjectIdString(userId);
    socket.username = typeof username === 'string' && username.trim() ? username.trim() : 'Anonymous';
    socket.join(socket.userId);

    const room = activeRooms.get(socket.userId);
    if (room) {
      socket.join(room.roomId);
      log('User rejoined room', { userId: socket.userId, roomId: room.roomId, partnerId: room.partnerId });
    }
  });

  socket.on('start_search', async ({ userId, username }) => {
    if (!isValidObjectId(userId)) {
      emitAppError(socket, 'Invalid userId');
      return;
    }

    const normalizedUserId = toObjectIdString(userId);
    if (searchingUsers.has(normalizedUserId) || activeRooms.has(normalizedUserId)) {
      emitAppError(socket, 'Already in a search or active chat', 'STATE_CONFLICT');
      return;
    }

    try {
      const user = await User.findById(normalizedUserId).select('user_name friends');
      if (!user) {
        emitAppError(socket, 'User not found', 'NOT_FOUND');
        return;
      }

      socket.userId = normalizedUserId;
      socket.username = user.user_name || username || 'Anonymous';
      searchingUsers.add(normalizedUserId);
      await tryMatchUser(normalizedUserId, socket, io);
    } catch (error) {
      searchingUsers.delete(normalizedUserId);
      emitAppError(socket, 'Server error during search', 'SERVER_ERROR');
    }
  });

  socket.on('stop_search', ({ userId }) => {
    if (!isValidObjectId(userId)) return;
    searchingUsers.delete(toObjectIdString(userId));
  });

  socket.on('start_friend_chat', async ({ userId, friendId }) => {
    if (!isValidObjectId(userId) || !isValidObjectId(friendId)) {
      emitAppError(socket, 'Invalid userId or friendId');
      return;
    }

    const normalizedUserId = toObjectIdString(userId);
    const normalizedFriendId = toObjectIdString(friendId);

    try {
      const [user, friend] = await Promise.all([
        User.findById(normalizedUserId).select('user_name friends'),
        User.findById(normalizedFriendId).select('user_name'),
      ]);

      if (!user || !friend || !hasId(user.friends, normalizedFriendId)) {
        emitAppError(socket, 'User or friend not found, or users are not friends', 'FORBIDDEN');
        return;
      }

      const roomId = buildRoomId(normalizedUserId, normalizedFriendId);
      activeRooms.set(normalizedUserId, { roomId, type: 'friend', partnerId: normalizedFriendId });
      activeRooms.set(normalizedFriendId, { roomId, type: 'friend', partnerId: normalizedUserId });

      socket.join(roomId);
      io.to(normalizedFriendId).socketsJoin(roomId);

      const chat = await findDirectChat(normalizedUserId, normalizedFriendId);

      io.to(normalizedUserId).emit('friend_chat_started', {
        partnerId: normalizedFriendId,
        partnerName: friend.user_name,
      });
      io.to(normalizedFriendId).emit('friend_chat_started', {
        partnerId: normalizedUserId,
        partnerName: user.user_name,
      });
      io.to(roomId).emit('chat_history', { messages: chat ? chat.messages : [] });
    } catch (error) {
      emitAppError(socket, 'Server error starting friend chat', 'SERVER_ERROR');
    }
  });

  socket.on('leave_friend_chat', ({ userId, friendId }) => {
    if (!isValidObjectId(userId) || !isValidObjectId(friendId)) return;

    const normalizedUserId = toObjectIdString(userId);
    const normalizedFriendId = toObjectIdString(friendId);
    const room = activeRooms.get(normalizedUserId);

    if (room && room.type === 'friend' && room.partnerId === normalizedFriendId) {
      socket.leave(room.roomId);
      activeRooms.delete(normalizedUserId);
      activeRooms.delete(normalizedFriendId);
      io.to(normalizedFriendId).emit('partner_disconnected', { disconnectedUserId: normalizedUserId });
    }
  });

  socket.on('leave_chat', ({ toUserId }) => {
    if (!socket.userId || !isValidObjectId(toUserId)) return;

    const normalizedToUserId = toObjectIdString(toUserId);
    const room = activeRooms.get(socket.userId);
    if (room && room.type === 'random' && room.partnerId === normalizedToUserId) {
      cleanupUserRoom(io, socket.userId);
    }
  });

  socket.on('typing', ({ toUserId, fromUserId }) => {
    if (!isValidObjectId(fromUserId) || !isValidObjectId(toUserId)) return;

    const normalizedFromUserId = toObjectIdString(fromUserId);
    const normalizedToUserId = toObjectIdString(toUserId);
    const room = activeRooms.get(normalizedFromUserId);
    if (room && room.partnerId === normalizedToUserId) {
      io.to(room.roomId).emit('partner_typing', { fromUserId: normalizedFromUserId });
    }
  });

  socket.on('message_seen', ({ toUserId, fromUserId, timestamp }) => {
    if (!isValidObjectId(fromUserId) || !isValidObjectId(toUserId) || !timestamp) return;

    const normalizedFromUserId = toObjectIdString(fromUserId);
    const normalizedToUserId = toObjectIdString(toUserId);
    const room = activeRooms.get(normalizedFromUserId);
    if (room && room.partnerId === normalizedToUserId) {
      io.to(room.roomId).emit('message_seen', { fromUserId: normalizedFromUserId, timestamp });
    }
  });

  socket.on('send_message', ({ toUserId, message, fromUserId, timestamp }) => {
    if (!isValidObjectId(fromUserId) || !isValidObjectId(toUserId) || !timestamp) {
      emitAppError(socket, 'Invalid message payload');
      return;
    }

    const normalizedMessage = normalizeMessageText(message);
    if (!normalizedMessage || normalizedMessage.length > MAX_MESSAGE_LENGTH) {
      emitAppError(socket, `Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters`);
      return;
    }

    const normalizedFromUserId = toObjectIdString(fromUserId);
    const normalizedToUserId = toObjectIdString(toUserId);
    const room = activeRooms.get(normalizedFromUserId);

    if (room && room.partnerId === normalizedToUserId) {
      io.to(room.roomId).emit('receive_message', {
        message: normalizedMessage,
        fromUserId: normalizedFromUserId,
        timestamp,
      });

      if (room.type === 'random') {
        const messages = randomChatMessages.get(room.roomId) || [];
        const dedupeWindow = 1000;
        const ts = Number(timestamp);
        const recentMessages = messages.filter((msg) => Math.abs(new Date(msg.timestamp).getTime() - ts) < dedupeWindow);

        if (!recentMessages.some((msg) => msg.text === normalizedMessage && msg.senderId === normalizedFromUserId)) {
          messages.push({ senderId: normalizedFromUserId, text: normalizedMessage, timestamp: new Date(ts), seen: false });
          randomChatMessages.set(room.roomId, messages);
        }
      }
      return;
    }

    emitAppError(socket, 'Not in a valid chat room', 'STATE_CONFLICT');
  });

  socket.on('disconnect', () => {
    if (!socket.userId) {
      userSocketBuckets.delete(socket.id);
      return;
    }

    const userId = socket.userId;
    searchingUsers.delete(userId);

    setTimeout(() => {
      const userSocket = getSocketByUserId(io, userId);
      if (!userSocket) {
        cleanupUserRoom(io, userId);
      }
    }, DISCONNECT_GRACE_PERIOD);

    userSocketBuckets.delete(socket.id);
  });
};

async function tryMatchUser(userId, socket, io) {
  try {
    const user = await User.findById(userId).select('user_name friends');
    if (!user || !searchingUsers.has(userId)) {
      searchingUsers.delete(userId);
      return;
    }

    const otherUsers = [...searchingUsers].filter((id) => id !== userId);
    if (!otherUsers.length) {
      setTimeout(() => tryMatchUser(userId, socket, io), 1000);
      return;
    }

    const friendIds = (user.friends || []).map((id) => toObjectIdString(id));
    let matchedUser = null;

    for (const otherUserId of otherUsers) {
      if (activeRooms.has(otherUserId) || friendIds.includes(otherUserId)) {
        continue;
      }

      const otherUser = await User.findById(otherUserId).select('friends user_name');
      if (!otherUser) continue;

      if (!hasId(otherUser.friends, userId)) {
        matchedUser = otherUserId;
        break;
      }
    }

    if (!matchedUser) {
      setTimeout(() => tryMatchUser(userId, socket, io), 1000);
      return;
    }

    searchingUsers.delete(userId);
    searchingUsers.delete(matchedUser);

    const matchedUserData = await User.findById(matchedUser).select('user_name');
    const roomId = buildRoomId(userId, matchedUser);

    activeRooms.set(userId, { roomId, type: 'random', partnerId: matchedUser });
    activeRooms.set(matchedUser, { roomId, type: 'random', partnerId: userId });
    randomChatMessages.set(roomId, []);

    socket.join(roomId);
    const matchedUserSocket = getSocketByUserId(io, matchedUser);

    if (!matchedUserSocket) {
      searchingUsers.add(userId);
      activeRooms.delete(userId);
      activeRooms.delete(matchedUser);
      randomChatMessages.delete(roomId);
      emitAppError(socket, 'Matched user disconnected, retrying search', 'MATCH_RETRY');
      return;
    }

    matchedUserSocket.join(roomId);
    socket.emit('match_found', {
      partnerId: matchedUser,
      partnerName: matchedUserData?.user_name || 'Anonymous',
      roomId,
    });

    matchedUserSocket.emit('match_found', {
      partnerId: userId,
      partnerName: user.user_name || 'Anonymous',
      roomId,
    });

    io.to(roomId).emit('chat_ready', { roomId });
  } catch (error) {
    searchingUsers.delete(userId);
    emitAppError(socket, 'Server error during matching', 'SERVER_ERROR');
  }
}

const sendMessage = async (req, res) => {
  try {
    const { userId, friendId, message } = req.body;

    if (!isValidObjectId(userId) || !isValidObjectId(friendId)) {
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const normalizedMessage = normalizeMessageText(message);
    if (!normalizedMessage || normalizedMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ message: `Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.` });
    }

    const [user, friend] = await Promise.all([
      User.findById(userId).select('friends'),
      User.findById(friendId).select('_id'),
    ]);

    if (!user || !friend || !hasId(user.friends, friendId)) {
      return res.status(403).json({ message: 'Users are not friends.' });
    }

    const participantsHash = getParticipantsHash(userId, friendId);
    let chat = await Chat.findOne({ participantsHash });

    if (!chat) {
      chat = new Chat({
        participants: [userId, friendId],
        participantsHash,
        messages: [],
      });
    }

    const timestamp = new Date();
    const messageData = {
      senderId: userId,
      text: normalizedMessage,
      timestamp,
      seen: false,
    };

    chat.messages.push(messageData);
    await chat.save();

    const roomId = buildRoomId(userId, friendId);
    req.io.to(roomId).emit('receive_message', {
      message: normalizedMessage,
      fromUserId: userId,
      timestamp: timestamp.getTime(),
    });

    res.status(200).json({ message: 'Message sent.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const sendRandomMessage = async (req, res) => {
  try {
    const { userId, partnerId, message } = req.body;

    if (!isValidObjectId(userId) || !isValidObjectId(partnerId)) {
      return res.status(400).json({ message: 'Invalid userId or partnerId.' });
    }

    const normalizedMessage = normalizeMessageText(message);
    if (!normalizedMessage || normalizedMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ message: `Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.` });
    }

    const room = activeRooms.get(toObjectIdString(userId));
    if (!room || room.type !== 'random' || room.partnerId !== toObjectIdString(partnerId)) {
      return res.status(403).json({ message: 'Not in a random chat with this user.' });
    }

    const messages = randomChatMessages.get(room.roomId) || [];
    messages.push({
      senderId: toObjectIdString(userId),
      text: normalizedMessage,
      timestamp: new Date(),
      seen: false,
    });
    randomChatMessages.set(room.roomId, messages);

    req.io.to(room.roomId).emit('receive_message', {
      message: normalizedMessage,
      fromUserId: toObjectIdString(userId),
      timestamp: Date.now(),
    });

    res.status(200).json({ message: 'Message sent.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getChatHistory = async (req, res) => {
  try {
    const { userId, friendId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = req.query.before ? Number(req.query.before) : null;

    if (!isValidObjectId(userId) || !isValidObjectId(friendId)) {
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const chat = await findDirectChat(userId, friendId);
    if (!chat) {
      return res.status(200).json({ messages: [], hasMore: false });
    }

    let messages = [...chat.messages];
    if (before) {
      messages = messages.filter((msg) => new Date(msg.timestamp).getTime() < before);
    }

    const sliced = messages.slice(-limit);
    const hasMore = messages.length > sliced.length;

    res.status(200).json({ messages: sliced, hasMore });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const markMessageSeen = async (req, res) => {
  try {
    const { userId, friendId, timestamp } = req.body;

    if (!isValidObjectId(userId) || !isValidObjectId(friendId) || !timestamp) {
      return res.status(400).json({ message: 'Invalid userId, friendId, or timestamp.' });
    }

    const chat = await findDirectChat(userId, friendId);
    if (!chat) {
      return res.status(404).json({ message: 'Chat not found.' });
    }

    const message = chat.messages.find(
      (msg) => msg.timestamp.getTime() === Number(timestamp) && toObjectIdString(msg.senderId) === toObjectIdString(friendId)
    );

    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    message.seen = true;
    await chat.save();

    const roomId = buildRoomId(userId, friendId);
    req.io.to(roomId).emit('message_seen', { fromUserId: userId, timestamp });

    res.status(200).json({ message: 'Message marked as seen.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  handleSocketConnection,
  sendMessage,
  sendRandomMessage,
  getChatHistory,
  markMessageSeen,
};
