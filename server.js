require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const userRoutes = require('./routes/user');
const chatRoutes = require('./routes/chat');
const { handleSocketConnection } = require('./controllers/chatController');
const { connectDB } = require('./config/db');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
});

const log = (message, data) => {
  console.log(`[${new Date().toISOString()}] Server: ${message}`, data || '');
};

// Rate limiting for socket events
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 1000; // 1 second
const MAX_EVENTS = 10; // Max 10 events per second per socket
io.use((socket, next) => {
  const socketId = socket.id;
  const now = Date.now();
  const events = rateLimit.get(socketId) || [];

  // Remove old events
  rateLimit.set(socketId, events.filter((t) => now - t < RATE_LIMIT_WINDOW));

  if (events.length >= MAX_EVENTS) {
    log(`Rate limit exceeded for socket ${socketId}`);
    return next(new Error('Rate limit exceeded'));
  }

  events.push(now);
  rateLimit.set(socketId, events);
  next();
});

app.use(cors());
app.use(express.json());

// Middleware to attach io to req
app.use((req, res, next) => {
  log(`${req.method} ${req.path}`, { body: req.body, params: req.params });
  req.io = io;
  if (!req.io) {
    log('Socket.IO instance not attached to req');
    return res.status(500).json({ message: 'Socket.IO instance not available' });
  }
  next();
});

// Routes
app.use('/api/users', userRoutes);
app.use('/api/chats', chatRoutes);

// Socket.IO connection
io.on('connection', (socket) => {
  log('New socket connection', { socketId: socket.id });
  handleSocketConnection(socket, io);
});

// Connect to MongoDB
connectDB()
  .then(() => {
    log('MongoDB connected successfully');
  })
  .catch((err) => {
    log('MongoDB connection error', { error: err.message });
    process.exit(1); // Exit process on DB connection failure
  });

// Global error handler
app.use((err, req, res, next) => {
  log('Server error', { error: err.message, stack: err.stack });
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  log(`Server running on http://0.0.0.0:${PORT}`);
});