/**
 * matchQueue.js — BullMQ-based matchmaking retry queue.
 *
 * When a user starts searching and no immediate match is found, a delayed
 * BullMQ job is queued. The worker retries every 3 seconds for up to 15
 * attempts (~45 seconds total). If still no match, the user is removed from
 * the searching set and notified with 'no_match_found'.
 *
 * The worker is created via createMatchWorker(io) so that it has access to
 * the Socket.IO instance for emitting events across all server instances
 * (via the Redis adapter).
 */

const { Queue, Worker } = require('bullmq');
const { BULLMQ_REDIS_OPTS } = require('../config/redis');
const logger = require('./logger');

const MAX_ATTEMPTS = 15;       // 15 × 3s = ~45 seconds
const RETRY_DELAY_MS = 3000;
const INITIAL_DELAY_MS = 3000;

const matchQueue = new Queue('matching', {
  connection: BULLMQ_REDIS_OPTS,
  defaultJobOptions: {
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'fixed', delay: RETRY_DELAY_MS },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

/**
 * Enqueues a matchmaking retry job for a user.
 * Uses jobId = match:{userId} to prevent duplicate jobs per user.
 * A second call while a job is already queued is safely ignored.
 */
const enqueueMatchRetry = async (userId) => {
  await matchQueue.add(
    'try-match',
    { userId },
    {
      delay: INITIAL_DELAY_MS,
      jobId: `match:${userId}`,
    }
  );
};

/**
 * Removes any queued matchmaking job for a user (e.g. when they stop searching).
 */
const cancelMatchRetry = async (userId) => {
  const job = await matchQueue.getJob(`match:${userId}`);
  if (job) await job.remove().catch(() => {});
};

/**
 * Creates and starts the BullMQ worker.
 *
 * @param {import('socket.io').Server} io - The Socket.IO server instance
 * @param {Function} performMatch - Shared match completion function from chatController
 */
const createMatchWorker = (io, performMatch) => {
  const {
    isSearching,
    atomicMatch,
    removeSearching,
  } = require('./roomState');

  const worker = new Worker(
    'matching',
    async (job) => {
      const { userId } = job.data;

      // User may have stopped searching or already been matched
      const stillSearching = await isSearching(userId);
      if (!stillSearching) return;

      // Attempt atomic match (Lua script — no race conditions)
      const candidateId = await atomicMatch(userId);
      if (!candidateId) {
        // No match yet — throw so BullMQ retries after RETRY_DELAY_MS
        throw new Error('no_match');
      }

      // Match found — complete the match
      logger.info('BullMQ worker matched users', { userId, candidateId });
      await performMatch(userId, candidateId, io);
    },
    { connection: BULLMQ_REDIS_OPTS }
  );

  // 'failed' fires only after ALL retry attempts are exhausted
  worker.on('failed', async (job, err) => {
    if (!job) return;
    if (err.message === 'no_match') {
      // Timed out — clean up and tell the user
      const { userId } = job.data;
      await removeSearching(userId).catch(() => {});
      io.to(userId).emit('no_match_found', {
        message: 'No match found. Try again.',
      });
      logger.info('Matchmaking timed out', { userId });
    } else {
      logger.error('Match worker unexpected error', {
        jobId: job.id,
        error: err.message,
      });
    }
  });

  worker.on('error', (err) => {
    logger.error('Match worker connection error', { error: err.message });
  });

  return worker;
};

module.exports = { matchQueue, enqueueMatchRetry, cancelMatchRetry, createMatchWorker };
