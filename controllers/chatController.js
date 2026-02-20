const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Chat = require('../models/Chat');
const { activeRooms, randomChatMessages } = require('../utils/activeRooms');
const logger = require('../utils/logger');

const searchingUsers = new Set();
const DISCONNECT_GRACE_PERIOD = 60000; // 60 seconds
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// ─── Socket.IO Connection Handler ─────────────────────────────────────────────

const handleSocketConnection = (socket, io) => {
  logger.info('Socket connected', { socketId: socket.id, userId: socket.userId });

  // Immediately join the user's personal room for direct events
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

  // ── start_search ─────────────────────────────────────────────────────────────
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

  // ── stop_search ───────────────────────────────────────────────────────────────
  socket.on('stop_search', () => {
    searchingUsers.delete(socket.userId);
    logger.info('User stopped searching', { userId: socket.userId });
  });

  // ── start_friend_chat ─────────────────────────────────────────────────────────
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

      const chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });

      io.to(userId).emit('friend_chat_started', { partnerId: friendId, partnerName: friend.user_name });
      io.to(friendId).emit('friend_chat_started', { partnerId: userId, partnerName: user.user_name });
      io.to(roomId).emit('chat_history', { messages: chat ? chat.messages : [] });

      logger.info('Friend chat started', { userId, friendId, roomId });
    } catch (err) {
      logger.error('Error in start_friend_chat', { userId, error: err.message });
      socket.emit('error', { message: 'Server error starting friend chat.' });
    }
  });

  // ── leave_friend_chat ─────────────────────────────────────────────────────────
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

  // ── leave_chat (random) ───────────────────────────────────────────────────────
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

  // ── typing ────────────────────────────────────────────────────────────────────
  socket.on('typing', ({ toUserId }) => {
    const userId = socket.userId;

    if (!toUserId || !OBJECT_ID_RE.test(toUserId)) return;

    const room = activeRooms.get(userId);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('partner_typing', { fromUserId: userId });
    }
  });

  // ── stop_typing ───────────────────────────────────────────────────────────────
  socket.on('stop_typing', ({ toUserId }) => {
    const userId = socket.userId;

    if (!toUserId || !OBJECT_ID_RE.test(toUserId)) return;

    const room = activeRooms.get(userId);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('partner_stop_typing', { fromUserId: userId });
    }
  });

  // ── message_seen ──────────────────────────────────────────────────────────────
  socket.on('message_seen', ({ toUserId, timestamp }) => {
    const userId = socket.userId;

    if (!toUserId || !timestamp || !OBJECT_ID_RE.test(toUserId)) return;

    const room = activeRooms.get(userId);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('message_seen', { fromUserId: userId, timestamp });
    }
  });

  // ── send_message ──────────────────────────────────────────────────────────────
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

    // Buffer random chat messages for later persistence on friend request accept
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

  // ── friend_request_sent (socket notification) ─────────────────────────────────
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

  // ── friend_request_accepted (socket notification) ─────────────────────────────
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

  // ── friend_request_rejected (socket notification) ─────────────────────────────
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

  // ── disconnect ────────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const userId = socket.userId;
    if (!userId) return;

    searchingUsers.delete(userId);
    logger.info('Socket disconnected', { userId, reason });

    const room = activeRooms.get(userId);
    if (!room) return;

    // Grace period: only evict if user doesn't reconnect
    setTimeout(() => {
      const stillInRoom = activeRooms.get(userId);
      if (!stillInRoom) return; // Already cleaned up (e.g. user left intentionally)

      // Check if user has a new socket connected
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

// ─── Match Logic ──────────────────────────────────────────────────────────────

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
      // Matched user disconnected between search and match
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

    socket.emit('match_found', { partnerId: matchedUserId, partnerName: matchedUser?.user_name || 'Anonymous' });
    matchedSocket.emit('match_found', { partnerId: userId, partnerName: user.user_name || 'Anonymous' });
    io.to(roomId).emit('chat_ready');
  } catch (err) {
    searchingUsers.delete(userId);
    logger.error('Error in tryMatchUser', { userId, error: err.message });
    socket.emit('error', { message: 'Server error during matching.' });
  }
}

// ─── HTTP: Send Message (friend chat) ────────────────────────────────────────

const sendMessage = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId, message } = req.body;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      return res.status(400).json({ message: 'Invalid friendId.' });
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ message: 'Message cannot be empty.' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ message: 'Message must not exceed 2000 characters.' });
    }

    const user = await User.findById(userId).select('friends');
    if (!user || !user.friends.some((id) => id.toString() === friendId)) {
      return res.status(403).json({ message: 'You are not friends with this user.' });
    }

    let chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
    if (!chat) {
      chat = new Chat({ participants: [userId, friendId], messages: [] });
    }

    const timestamp = new Date();
    chat.messages.push({ senderId: userId, text: message.trim(), timestamp, seen: false });
    await chat.save();

    const roomId = [userId, friendId].sort().join('_');
    req.io.to(roomId).emit('receive_message', {
      message: message.trim(),
      fromUserId: userId,
      timestamp: timestamp.getTime(),
    });

    return res.status(200).json({ message: 'Message sent.' });
  } catch (err) {
    logger.error('Error in sendMessage', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── HTTP: Validate Random Chat (no persistence — socket handles delivery) ────

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

    // Actual message delivery happens over socket; this endpoint just validates state.
    return res.status(200).json({ message: 'Room active.' });
  } catch (err) {
    logger.error('Error in sendRandomMessage', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── HTTP: Get Chat History ───────────────────────────────────────────────────

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

    const total = chat.messages.length;
    const startIndex = Math.max(0, total - page * limit);
    const endIndex = total - (page - 1) * limit;
    const messages = chat.messages.slice(startIndex, endIndex);

    return res.status(200).json({ messages, total, page, limit });
  } catch (err) {
    logger.error('Error in getChatHistory', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ─── HTTP: Mark Message Seen ──────────────────────────────────────────────────

const markMessageSeen = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId, timestamp } = req.body;

    if (!friendId || !OBJECT_ID_RE.test(friendId) || !timestamp) {
      return res.status(400).json({ message: 'Invalid friendId or timestamp.' });
    }

    const chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
    if (!chat) {
      return res.status(404).json({ message: 'Chat not found.' });
    }

    const message = chat.messages.find(
      (m) => m.timestamp.getTime() === Number(timestamp) && m.senderId.toString() === friendId
    );
    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    message.seen = true;
    await chat.save();

    const roomId = [userId, friendId].sort().join('_');
    req.io.to(roomId).emit('message_seen', { fromUserId: userId, timestamp });

    return res.status(200).json({ message: 'Message marked as seen.' });
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
