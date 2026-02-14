# Anonymous Chat Backend - Robust Flow

## Recommended request flow

1. **User bootstrap**
   - Create/update anonymous profile (`/api/users/create`)
   - Receive userId and maintain local token/session

2. **Socket setup**
   - Open socket connection
   - Emit `set_username` with `userId`
   - Join private user room and any active chat room

3. **Matchmaking**
   - Emit `start_search`
   - Server pairs users not already friends
   - Both users receive `match_found` + `chat_ready`

4. **Messaging**
   - Message payload validated and normalized
   - Real-time message emitted to current room
   - Random chat messages cached in-memory and flushed on friend acceptance
   - Friend chat messages persisted to MongoDB (`Chat`)

5. **Friend request lifecycle**
   - `send-friend-request` creates a pending request
   - `accept-friend-request` uses transaction and ensures consistent friendship
   - Accept path can persist random chat transcript into durable history

6. **History and receipts**
   - `/api/chats/:userId/:friendId` supports pagination (`limit`, `before`)
   - `seen` updates persist and broadcast to active room

7. **Resilience**
   - Event-level socket rate limit
   - Grace-period disconnect handling
   - Deterministic room id strategy (`userA_userB` sorted)

## Next scaling phase

- Move `activeRooms`, `searchingUsers`, `randomChatMessages` to Redis.
- Add JWT auth middleware for REST and socket handshake.
- Split `Chat.messages` into separate `Message` collection for high-volume scale.
