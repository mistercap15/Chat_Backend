const mongoose = require('mongoose');

const isValidObjectId = (value) => typeof value === 'string' && mongoose.Types.ObjectId.isValid(value);

const toObjectIdString = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function') return value.toString();
  return '';
};

const hasId = (list, targetId) => {
  const target = toObjectIdString(targetId);
  return Array.isArray(list) && list.some((id) => toObjectIdString(id) === target);
};

const buildRoomId = (userA, userB) => [toObjectIdString(userA), toObjectIdString(userB)].sort().join('_');

const normalizeMessageText = (message) => (typeof message === 'string' ? message.trim() : '');

module.exports = {
  isValidObjectId,
  toObjectIdString,
  hasId,
  buildRoomId,
  normalizeMessageText,
};
