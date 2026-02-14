require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const userRoutes = require('./routes/user');
const chatRoutes = require('./routes/chat');
const { handleSocketConnection } = require('./controllers/chatController');
const { connectDB } = require('./config/db');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'DELETE'],
  },
});

const log = (message, data) => {
  console.log(`[${new Date().toISOString()}] Server: ${message}`, data || '');
};

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  req.io = io;
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

app.use('/api/users', userRoutes);
app.use('/api/chats', chatRoutes);

io.on('connection', (socket) => {
  handleSocketConnection(socket, io);
});

app.use((err, req, res, next) => {
  log('Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      log(`Server running on http://0.0.0.0:${PORT}`);
    });
  })
  .catch((error) => {
    log('Failed to connect database', { error: error.message });
    process.exit(1);
  });
