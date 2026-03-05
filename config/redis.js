const Redis = require('ioredis');
const logger = require('../utils/logger');

const REDIS_OPTS = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  lazyConnect: true,
  retryStrategy: (times) => {
    if (times > 10) return null; // stop retrying — let the app crash/alert
    return Math.min(times * 100, 3000);
  },
  enableOfflineQueue: true,
};

const createClient = (name) => {
  const client = new Redis(REDIS_OPTS);
  client.on('connect', () => logger.info(`Redis [${name}] connected`));
  client.on('ready', () => logger.info(`Redis [${name}] ready`));
  client.on('error', (err) => logger.error(`Redis [${name}] error`, { error: err.message }));
  client.on('close', () => logger.warn(`Redis [${name}] connection closed`));
  client.on('reconnecting', () => logger.warn(`Redis [${name}] reconnecting`));
  return client;
};

// Main client — used for all regular commands and roomState
const redis = createClient('main');

// Dedicated pub/sub clients for Socket.IO Redis adapter
// These cannot share a connection with the command client
const pubClient = createClient('pub');
const subClient = createClient('sub');

// Connection options as a plain object — used by BullMQ which manages its own connections
const BULLMQ_REDIS_OPTS = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,    // required by BullMQ
};

module.exports = { redis, pubClient, subClient, BULLMQ_REDIS_OPTS };
