/**
 * roomState.js — Redis-backed shared state for active chat rooms and matchmaking.
 *
 * Replaces the old in-memory Map/Set in activeRooms.js.
 * All functions are async. Safe to use across multiple server instances
 * because state lives in Redis, not process memory.
 *
 * Key layout:
 *   room:{userId}          → JSON { roomId, type: 'random'|'friend', partnerId }  TTL: 24h
 *   randmsg:{roomId}       → Redis List of JSON message strings                   TTL: 24h
 *   searching              → Redis Set of userIds waiting for a random match
 */

const { redis } = require('../config/redis');

const ROOM_TTL = 24 * 60 * 60; // 24 hours in seconds
const RANDMSG_TTL = 24 * 60 * 60;

// ─── Active Rooms ─────────────────────────────────────────────────────────────

const setRoom = (userId, room) =>
  redis.set(`room:${userId}`, JSON.stringify(room), 'EX', ROOM_TTL);

const getRoom = async (userId) => {
  const data = await redis.get(`room:${userId}`);
  return data ? JSON.parse(data) : null;
};

const hasRoom = async (userId) => {
  const n = await redis.exists(`room:${userId}`);
  return n === 1;
};

const deleteRoom = (userId) => redis.del(`room:${userId}`);

// ─── Searching Users (matchmaking queue) ──────────────────────────────────────

const addSearching = (userId) => redis.sadd('searching', userId);
const removeSearching = (userId) => redis.srem('searching', userId);
const isSearching = async (userId) => {
  const n = await redis.sismember('searching', userId);
  return n === 1;
};

/**
 * Atomic matchmaking via Lua script.
 *
 * Behaviour:
 *   - If a candidate (not self) is found in the searching set:
 *       Removes BOTH the candidate and userId from the set.
 *       Returns the candidateId string.
 *   - If no candidate is found:
 *       Adds userId to the searching set (or is a no-op if already there).
 *       Returns null.
 *
 * Because Lua scripts run atomically in Redis there are no race conditions —
 * two concurrent calls cannot claim the same candidate.
 */
const MATCH_SCRIPT = `
  local candidates = redis.call('SMEMBERS', KEYS[1])
  for _, cid in ipairs(candidates) do
    if cid ~= ARGV[1] then
      redis.call('SREM', KEYS[1], cid)
      redis.call('SREM', KEYS[1], ARGV[1])
      return cid
    end
  end
  redis.call('SADD', KEYS[1], ARGV[1])
  return nil
`;

const atomicMatch = async (userId) => {
  const result = await redis.eval(MATCH_SCRIPT, 1, 'searching', userId);
  return result || null;
};

// ─── Random Chat Messages ─────────────────────────────────────────────────────

const pushRandomMessage = async (roomId, msg) => {
  const key = `randmsg:${roomId}`;
  await redis.rpush(key, JSON.stringify(msg));
  await redis.expire(key, RANDMSG_TTL);
};

const getRandomMessages = async (roomId) => {
  const items = await redis.lrange(`randmsg:${roomId}`, 0, -1);
  return items.map((s) => JSON.parse(s));
};

const deleteRandomMessages = (roomId) => redis.del(`randmsg:${roomId}`);

module.exports = {
  // Rooms
  setRoom,
  getRoom,
  hasRoom,
  deleteRoom,
  // Searching
  addSearching,
  removeSearching,
  isSearching,
  atomicMatch,
  // Random chat messages
  pushRandomMessage,
  getRandomMessages,
  deleteRandomMessages,
};
