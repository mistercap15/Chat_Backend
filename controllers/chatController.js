const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const { activeRooms, randomChatMessages } = require('../utils/activeRooms');
const logger = require('../utils/logger');
const { sendPushToUser, isUserActiveInRoom, templates } = require('../utils/pushNotifications');

const searchingUsers = new Set();
const DISCONNECT_GRACE_PERIOD = 60000; // 60 seconds
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const CLIENT_MESSAGE_ID_RE = /^[a-zA-Z0-9_-]{8,120}$/;

const getOrCreateChat = async (userId, friendId) => {
  let chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
  if (!chat) {
    chat = await Chat.create({ participants: [userId, friendId], lastMessageAt: null });
  }
  return chat;
};

// ─── Socket.IO Connection Handler ─────────────────────────────────────────────

const handleSocketConnection = (socket, io) => {
  logger.info('Socket connected', { socketId: socket.id, userId: socket.userId });

  if (socket.userId) {
    socket.join(socket.userId);

    const existingRoom = activeRooms.get(socket.userId);
    if (existingRoom) {
      socket.join(existingRoom.roomId);
      logger.info('User rejoined active room on reconnect', {
        userId: socket.userId,
        roomId: existingRoom.roomId,
      });
    }
  }

  socket.on('start_search', async () => {
    const userId = socket.userId;

    if (searchingUsers.has(userId) || activeRooms.has(userId)) {
      socket.emit('error', { message: 'Already in a search or chat.' });
      return;
    }

    try {
      const user = await User.findById(userId).select('user_name friends');
      if (!user) {
        socket.emit('error', { message: 'User not found.' });
        return;
      }
      socket.username = user.user_name;
      searchingUsers.add(userId);
      logger.info('User started searching', { userId });
      await tryMatchUser(userId, socket, io);
    } catch (err) {
      searchingUsers.delete(userId);
      logger.error('Error in start_search', { userId, error: err.message });
      socket.emit('error', { message: 'Server error during search.' });
    }
  });

  socket.on('stop_search', () => {
    searchingUsers.delete(socket.userId);
    logger.info('User stopped searching', { userId: socket.userId });
  });

  socket.on('start_friend_chat', async ({ friendId }) => {
    const userId = socket.userId;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      socket.emit('error', { message: 'Invalid friendId.' });
      return;
    }

    try {
      const [user, friend] = await Promise.all([
        User.findById(userId).select('user_name friends'),
        User.findById(friendId).select('user_name'),
      ]);

      if (!user || !friend) {
        socket.emit('error', { message: 'User or friend not found.' });
        return;
      }
      if (!user.friends.some((id) => id.toString() === friendId)) {
        socket.emit('error', { message: 'You are not friends with this user.' });
        return;
      }

      const roomId = [userId, friendId].sort().join('_');
      activeRooms.set(userId, { roomId, type: 'friend', partnerId: friendId });
      socket.join(roomId);
      io.to(friendId).socketsJoin(roomId);

      const chat = await getOrCreateChat(userId, friendId);
      const messages = await Message.find({ chatId: chat._id }).sort({ createdAt: -1 }).limit(50).lean();

      io.to(userId).emit('friend_chat_started', { partnerId: friendId, partnerName: friend.user_name });
      io.to(friendId).emit('friend_chat_started', { partnerId: userId, partnerName: user.user_name });
      io.to(roomId).emit('chat_history', {
        messages: messages.reverse().map((m) => ({
          _id: m._id,
          senderId: m.senderId,
          text: m.text,
          timestamp: m.createdAt,
          seen: m.seen,
          clientMessageId: m.clientMessageId,
        })),
      });

      logger.info('Friend chat started', { userId, friendId, roomId });
    } catch (err) {
      logger.error('Error in start_friend_chat', { userId, error: err.message });
      socket.emit('error', { message: 'Server error starting friend chat.' });
    }
  });

  socket.on('leave_friend_chat', ({ friendId }) => {
    const userId = socket.userId;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) return;

    const room = activeRooms.get(userId);
    if (room && room.type === 'friend' && room.partnerId === friendId) {
      socket.leave(room.roomId);
      activeRooms.delete(userId);
      io.to(friendId).emit('partner_left', { userId });
      logger.info('User left friend chat', { userId, friendId });
    }
  });

  socket.on('leave_chat', ({ toUserId }) => {
    const userId = socket.userId;

    if (!toUserId || !OBJECT_ID_RE.test(toUserId)) return;

    const room = activeRooms.get(userId);
    if (room && room.type === 'random' && room.partnerId === toUserId) {
      io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: userId });
      socket.leave(room.roomId);
      activeRooms.delete(userId);
      activeRooms.delete(toUserId);
      randomChatMessages.delete(room.roomId);
      logger.info('User left random chat', { userId, toUserId, roomId: room.roomId });
    }
  });

  socket.on('typing', ({ toUserId }) => {
    const userId = socket.userId;

    if (!toUserId || !OBJECT_ID_RE.test(toUserId)) return;

    const room = activeRooms.get(userId);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('partner_typing', { fromUserId: userId });
    }
  });

  socket.on('stop_typing', ({ toUserId }) => {
    const userId = socket.userId;

    if (!toUserId || !OBJECT_ID_RE.test(toUserId)) return;

    const room = activeRooms.get(userId);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('partner_stop_typing', { fromUserId: userId });
    }
  });

  socket.on('message_seen', ({ toUserId, timestamp }) => {
    const userId = socket.userId;

    if (!toUserId || !timestamp || !OBJECT_ID_RE.test(toUserId)) return;

    const room = activeRooms.get(userId);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('message_seen', { fromUserId: userId, timestamp });
    }
  });

  socket.on('send_message', ({ toUserId, message, timestamp }) => {
    const userId = socket.userId;

    if (!toUserId || !message || !OBJECT_ID_RE.test(toUserId)) {
      socket.emit('error', { message: 'Invalid message payload.' });
      return;
    }
    if (typeof message !== 'string' || message.trim().length === 0 || message.length > 2000) {
      socket.emit('error', { message: 'Message must be 1–2000 characters.' });
      return;
    }

    const room = activeRooms.get(userId);
    if (!room || room.partnerId !== toUserId) {
      socket.emit('error', { message: 'Not in a valid chat room with this user.' });
      return;
    }

    const ts = timestamp || Date.now();
    io.to(room.roomId).emit('receive_message', {
      message: message.trim(),
      fromUserId: userId,
      timestamp: ts,
    });

    if (room.type === 'random') {
      const messages = randomChatMessages.get(room.roomId) || [];
      const dedupWindow = 1000;
      const isDupe = messages.some(
        (m) =>
          m.text === message.trim() &&
          m.senderId === userId &&
          Math.abs(new Date(m.timestamp).getTime() - ts) < dedupWindow
      );
      if (!isDupe) {
        messages.push({ senderId: userId, text: message.trim(), timestamp: new Date(ts), seen: false });
        randomChatMessages.set(room.roomId, messages);
      }
    }
  });

  socket.on('friend_request_sent', ({ toUserId, fromUsername }) => {
    const userId = socket.userId;

    if (!toUserId || !OBJECT_ID_RE.test(toUserId)) return;

    const room = activeRooms.get(userId);
    if (room && room.type === 'random' && room.partnerId === toUserId) {
      io.to(room.roomId).emit('friend_request_status', {
        fromUserId: userId,
        toUserId,
        fromUsername,
        status: 'sent',
      });
      io.to(toUserId).emit('friend_request_received', { fromUserId: userId, fromUsername });
    }
  });

  socket.on('friend_request_accepted', async ({ friendId }) => {
    const userId = socket.userId;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) return;

    const room = activeRooms.get(userId);
    if (room && room.type === 'random' && room.partnerId === friendId) {
      io.to(room.roomId).emit('friend_request_accepted', { userId, friendId });
      io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: userId });
      io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: friendId });
      socket.leave(room.roomId);
      io.to(friendId).socketsLeave(room.roomId);
      activeRooms.delete(userId);
      activeRooms.delete(friendId);
      randomChatMessages.delete(room.roomId);
    }
  });

  socket.on('friend_request_rejected', ({ friendId }) => {
    const userId = socket.userId;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) return;

    const room = activeRooms.get(userId);
    if (room && room.type === 'random' && room.partnerId === friendId) {
      io.to(room.roomId).emit('friend_request_status', {
        fromUserId: friendId,
        toUserId: userId,
        status: 'rejected',
      });
    }
  });

  socket.on('disconnect', (reason) => {
    const userId = socket.userId;
    if (!userId) return;

    searchingUsers.delete(userId);
    logger.info('Socket disconnected', { userId, reason });

    const room = activeRooms.get(userId);
    if (!room) return;

    setTimeout(() => {
      const stillInRoom = activeRooms.get(userId);
      if (!stillInRoom) return;

      let hasActiveSocket = false;
      for (const [, s] of io.sockets.sockets) {
        if (s.userId === userId && s.connected) {
          hasActiveSocket = true;
          break;
        }
      }

      if (!hasActiveSocket) {
        io.to(stillInRoom.roomId).emit('partner_disconnected', { disconnectedUserId: userId });
        activeRooms.delete(userId);
        activeRooms.delete(stillInRoom.partnerId);
        randomChatMessages.delete(stillInRoom.roomId);
        logger.info('User removed after grace period', { userId, roomId: stillInRoom.roomId });
      }
    }, DISCONNECT_GRACE_PERIOD);
  });
};

async function tryMatchUser(userId, socket, io) {
  try {
    const user = await User.findById(userId).select('user_name friends');
    if (!user || !searchingUsers.has(userId)) {
      searchingUsers.delete(userId);
      return;
    }

    const candidates = [...searchingUsers].filter((id) => id !== userId);
    if (candidates.length === 0) {
      setTimeout(() => tryMatchUser(userId, socket, io), 2000);
      return;
    }

    const friendSet = new Set(user.friends.map((id) => id.toString()));
    let matchedUserId = null;

    for (const candidateId of candidates) {
      if (activeRooms.has(candidateId) || friendSet.has(candidateId)) continue;
      const candidate = await User.findById(candidateId).select('friends');
      if (candidate && !candidate.friends.some((id) => id.toString() === userId)) {
        matchedUserId = candidateId;
        break;
      }
    }

    if (!matchedUserId) {
      setTimeout(() => tryMatchUser(userId, socket, io), 2000);
      return;
    }

    searchingUsers.delete(userId);
    searchingUsers.delete(matchedUserId);

    const matchedUser = await User.findById(matchedUserId).select('user_name');
    const roomId = [userId, matchedUserId].sort().join('-');

    activeRooms.set(userId, { roomId, type: 'random', partnerId: matchedUserId });
    activeRooms.set(matchedUserId, { roomId, type: 'random', partnerId: userId });
    randomChatMessages.set(roomId, []);

    socket.join(roomId);

    let matchedSocket = null;
    for (const [, s] of io.sockets.sockets) {
      if (s.userId === matchedUserId) {
        matchedSocket = s;
        break;
      }
    }

    if (!matchedSocket) {
      searchingUsers.add(userId);
      activeRooms.delete(userId);
      activeRooms.delete(matchedUserId);
      randomChatMessages.delete(roomId);
      socket.emit('error', { message: 'Matched user disconnected. Retrying...' });
      setTimeout(() => tryMatchUser(userId, socket, io), 1000);
      return;
    }

    matchedSocket.join(roomId);
    logger.info('Match created', { userId, matchedUserId, roomId });

    const userPartnerName = user.user_name || 'Anonymous';
    const matchedPartnerName = matchedUser?.user_name || 'Anonymous';

    socket.emit('match_found', { partnerId: matchedUserId, partnerName: matchedPartnerName });
    matchedSocket.emit('match_found', { partnerId: userId, partnerName: userPartnerName });
    io.to(roomId).emit('chat_ready');

    Promise.all([
      sendPushToUser(userId, templates.randomMatchFound(matchedPartnerName, matchedUserId), User),
      sendPushToUser(matchedUserId, templates.randomMatchFound(userPartnerName, userId), User),
    ]).catch((err) => logger.error('Push failed for randomMatch', { error: err.message }));
  } catch (err) {
    searchingUsers.delete(userId);
    logger.error('Error in tryMatchUser', { userId, error: err.message });
    socket.emit('error', { message: 'Server error during matching.' });
  }
}

const sendMessage = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId, message, clientMessageId } = req.body;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      return res.status(400).json({ message: 'Invalid friendId.' });
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ message: 'Message cannot be empty.' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ message: 'Message must not exceed 2000 characters.' });
    }
    if (clientMessageId && (typeof clientMessageId !== 'string' || !CLIENT_MESSAGE_ID_RE.test(clientMessageId))) {
      return res.status(400).json({ message: 'Invalid clientMessageId format.' });
    }

    const user = await User.findById(userId).select('user_name friends');
    if (!user || !user.friends.some((id) => id.toString() === friendId)) {
      return res.status(403).json({ message: 'You are not friends with this user.' });
    }

    const chat = await getOrCreateChat(userId, friendId);

    if (clientMessageId) {
      const existingMessage = await Message.findOne({ chatId: chat._id, senderId: userId, clientMessageId });
      if (existingMessage) {
        return res.status(200).json({
          message: 'Message already processed.',
          messageId: existingMessage._id,
          timestamp: existingMessage.createdAt.getTime(),
          deduped: true,
        });
      }
    }

    const trimmedMessage = message.trim();
    const newMessage = await Message.create({
      chatId: chat._id,
      senderId: userId,
      text: trimmedMessage,
      seen: false,
      clientMessageId: clientMessageId || null,
    });

    chat.lastMessageAt = newMessage.createdAt;
    await chat.save();

    const roomId = [userId, friendId].sort().join('_');
    req.io.to(roomId).emit('receive_message', {
      _id: newMessage._id,
      message: trimmedMessage,
      fromUserId: userId,
      timestamp: newMessage.createdAt.getTime(),
      clientMessageId: newMessage.clientMessageId,
    });

    if (!isUserActiveInRoom(req.io, friendId, roomId)) {
      sendPushToUser(
        friendId,
        templates.newMessage(user.user_name, trimmedMessage, userId),
        User
      ).catch((err) => logger.error('Push failed for sendMessage', { error: err.message }));
    }

    return res.status(200).json({
      message: 'Message sent.',
      messageId: newMessage._id,
      timestamp: newMessage.createdAt.getTime(),
      deduped: false,
    });
  } catch (err) {
    logger.error('Error in sendMessage', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

const sendRandomMessage = async (req, res) => {
  try {
    const userId = req.userId;
    const { partnerId } = req.body;

    if (!partnerId || !OBJECT_ID_RE.test(partnerId)) {
      return res.status(400).json({ message: 'Invalid partnerId.' });
    }

    const room = activeRooms.get(userId);
    if (!room || room.type !== 'random' || room.partnerId !== partnerId) {
      return res.status(403).json({ message: 'Not in a random chat with this user.' });
    }

    return res.status(200).json({ message: 'Room active.' });
  } catch (err) {
    logger.error('Error in sendRandomMessage', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

const getChatHistory = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId } = req.params;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      return res.status(400).json({ message: 'Invalid friendId.' });
    }

    const user = await User.findById(userId).select('friends');
    if (!user || !user.friends.some((id) => id.toString() === friendId)) {
      return res.status(403).json({ message: 'You are not friends with this user.' });
    }

    const chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
    if (!chat) {
      return res.status(200).json({ messages: [], total: 0, page, limit });
    }

    const total = await Message.countDocuments({ chatId: chat._id });
    const skip = Math.max(0, total - page * limit);
    const docs = await Message.find({ chatId: chat._id })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const messages = docs.map((m) => ({
      _id: m._id,
      senderId: m.senderId,
      text: m.text,
      timestamp: m.createdAt,
      seen: m.seen,
      seenAt: m.seenAt,
      clientMessageId: m.clientMessageId,
    }));

    return res.status(200).json({ messages, total, page, limit });
  } catch (err) {
    logger.error('Error in getChatHistory', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

const markMessageSeen = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId, timestamp, messageId } = req.body;

    if (!friendId || !OBJECT_ID_RE.test(friendId) || (!timestamp && !messageId)) {
      return res.status(400).json({ message: 'Invalid payload. Provide friendId and messageId or timestamp.' });
    }

    const chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
    if (!chat) {
      return res.status(404).json({ message: 'Chat not found.' });
    }

    const query = { chatId: chat._id, senderId: friendId };
    if (messageId && OBJECT_ID_RE.test(String(messageId))) {
      query._id = messageId;
    } else {
      query.createdAt = new Date(Number(timestamp));
    }

    const updated = await Message.findOneAndUpdate(
      query,
      { seen: true, seenAt: new Date() },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    const roomId = [userId, friendId].sort().join('_');
    req.io.to(roomId).emit('message_seen', {
      fromUserId: userId,
      timestamp: updated.createdAt.getTime(),
      messageId: updated._id,
    });

    return res.status(200).json({ message: 'Message marked as seen.', messageId: updated._id });
  } catch (err) {
    logger.error('Error in markMessageSeen', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

module.exports = {
  handleSocketConnection,
  sendMessage,
  sendRandomMessage,
  getChatHistory,
  markMessageSeen,
};
