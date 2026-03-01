const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { redis } = require('../config/redis');

/**
 * Creates a RedisStore for express-rate-limit backed by ioredis.
 * Using Redis means rate limit counters are shared across ALL server instances —
 * without this, each instance has its own counter so limits are easily bypassed.
 */
const makeStore = (prefix) =>
  new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix,
  });

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:general:'),
  message: { message: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:auth:'),
  message: { message: 'Too many authentication attempts, please try again later.' },
});

const messageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:msg:'),
  message: { message: 'Message rate limit exceeded, slow down.' },
});

module.exports = { generalLimiter, authLimiter, messageLimiter };
