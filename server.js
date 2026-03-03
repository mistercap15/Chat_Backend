require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const logger = require('./utils/logger');
const { connectDB } = require('./config/db');
const { redis, pubClient, subClient } = require('./config/redis');
const { generalLimiter } = require('./middlewares/rateLimit');

const userRoutes = require('./routes/user');
const chatRoutes = require('./routes/chat');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const { handleSocketConnection, performMatch } = require('./controllers/chatController');
const { createMatchWorker } = require('./utils/matchQueue');

// ─── App & Server Setup ───────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((o) => o.trim())
  : '*';

const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Socket.IO: JWT Authentication ───────────────────────────────────────────

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication required. Provide a token in socket.handshake.auth.token'));
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // socket.userId   — available on local socket event handlers
    // socket.data.userId — serialised by the Redis adapter; available in
    //                      io.fetchSockets() responses from remote instances
    socket.userId = decoded.userId;
    socket.data.userId = decoded.userId;
    next();
  } catch (err) {
    logger.warn('Socket JWT verification failed', { error: err.message });
    next(new Error('Invalid or expired token.'));
  }
});

// ─── Socket.IO: Per-Event Rate Limiting ──────────────────────────────────────

const SOCKET_RATE_WINDOW = 1000; // ms
const SOCKET_MAX_EVENTS = 15;    // events per window per socket

io.on('connection', (socket) => {
  logger.info('Socket connected', { socketId: socket.id, userId: socket.userId });

  const eventTimestamps = new Map();

  socket.use(([event], next) => {
    const now = Date.now();
    const timestamps = (eventTimestamps.get(event) || []).filter(
      (t) => now - t < SOCKET_RATE_WINDOW
    );

    if (timestamps.length >= SOCKET_MAX_EVENTS) {
      logger.warn('Socket rate limit exceeded', { userId: socket.userId, event });
      return next(new Error(`Rate limit exceeded for event: ${event}`));
    }

    timestamps.push(now);
    eventTimestamps.set(event, timestamps);
    next();
  });

  handleSocketConnection(socket, io);
});

// ─── HTTP Middleware ──────────────────────────────────────────────────────────

app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
    credentials: true,
  })
);
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(generalLimiter);

// Attach Socket.IO instance to every request
app.use((req, _res, next) => {
  req.io = io;
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/admin', adminRoutes);

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] || 'unknown';
  const redisStatus = redis.status; // 'ready' | 'connecting' | 'close' | etc.
  const healthy = dbState === 1 && redisStatus === 'ready';

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    db: dbStatus,
    redis: redisStatus,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (_req, res) => res.json({ message: 'Chat API is running.' }));

// ─── 404 Handler ──────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} not found.` });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File too large. Maximum size is 5 MB.' });
  }
  if (err.message && err.message.includes('Only JPEG')) {
    return res.status(400).json({ message: err.message });
  }

  logger.error('Unhandled server error', { error: err.message, stack: err.stack, path: req.path });
  res.status(err.status || 500).json({ message: err.expose ? err.message : 'Internal server error.' });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  server.close(async () => {
    logger.info('HTTP server closed.');
    try {
      await Promise.all([
        mongoose.connection.close(),
        redis.quit(),
        pubClient.quit(),
        subClient.quit(),
      ]);
      logger.info('MongoDB and Redis connections closed.');
    } catch (err) {
      logger.error('Error during shutdown', { error: err.message });
    }
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 15000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

// ─── Start: DB + Redis first, then listen ────────────────────────────────────

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();

  // ❌ DO NOT call redis.connect()
  await Promise.all([
    pubClient.connect(),
    subClient.connect(),
  ]);

  io.adapter(createAdapter(pubClient, subClient));

  createMatchWorker(io, performMatch);
  logger.info('Matchmaking worker started');

  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on http://0.0.0.0:${PORT}`);
  });
};

start().catch((err) => {
  logger.error('Startup failed', { error: err.message });
  process.exit(1);
});
