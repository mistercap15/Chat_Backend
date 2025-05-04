require('dotenv').config();  // Import dotenv to manage environment variables
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const userRoutes = require('./routes/user');
const messageRoutes = require('./routes/message');
const { handleSocketConnection } = require('./controllers/chatController');
const { connectDB } = require('./config/db');  // Import the DB connection logic

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',  // Allow all origins (you can specify your client URL for more security)
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/users', userRoutes);
app.use('/api/messages', messageRoutes);

// Socket events handling
io.on('connection', (socket) => handleSocketConnection(socket, io));

// MongoDB Connection
connectDB();  // Initialize MongoDB connection

server.listen(3000, '0.0.0.0', () => {
  console.log('Server is running on http://0.0.0.0:3000');
});

