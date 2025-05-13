const activeRooms = new Map(); // Map<userId, { roomId, type: 'random' | 'friend', partnerId }>
const randomChatMessages = new Map(); // Map<roomId, [{ senderId, text, timestamp, seen }]>

module.exports = { activeRooms, randomChatMessages };