/**
 * BotSocket — A lightweight Socket.IO socket interface adapter for the server-side bot.
 * Implements the minimal interface required by BattleSessionManager:
 * id, userId, userData, handshake, emit(), on(), join(), removeAllListeners().
 *
 * The BattleSessionManager treats this identically to a real socket connection.
 * The bot registers itself in io.sockets.sockets so that room broadcasts
 * (io.to(roomId).emit()) reach it through the normal Socket.IO adapter flow.
 */
class BotSocket {
  /**
   * @param {import("socket.io").Server} io - Socket.IO server instance
   * @param {string} username - Bot display name
   * @param {number} avatar - Bot avatar index (0-5)
   * @param {string} userId - Bot userId (cpu_xxx)
   */
  constructor(io, username, avatar, userId) {
    this.io = io;
    this.id = `bot_${this._randomId(16)}`;
    this.userId = userId;
    this.userData = { username, avatar };
    this.handshake = { auth: { username, avatar } };
    this._listeners = new Map();

    // Register this bot in the sockets map so io.to(roomId).emit() broadcasts reach it
    this.io.sockets.sockets.set(this.id, this);
  }

  /**
   * Delivers an event to all registered listeners for that event name.
   * Also handles the packet format that Socket.IO adapter uses internally.
   * @param {string} event - Event name
   * @param {*} data - Event payload
   */
  emit(event, data) {
    const handlers = this._listeners.get(event) || [];
    for (const handler of handlers) {
      handler(data);
    }
  }

  /**
   * Handles Socket.IO internal packet delivery (used by room broadcasts).
   * When io.to(roomId).emit(event, data) is called, the adapter calls
   * socket.packet() on each socket in the room.
   * @param {object} packet - The Socket.IO packet object
   */
  packet(packet) {
    // Socket.IO packet format: { type: 2, data: [eventName, ...args], nsp: '/' }
    if (packet && packet.data && Array.isArray(packet.data)) {
      const [event, ...args] = packet.data;
      this.emit(event, args[0]);
    }
  }

  /**
   * No-op for Socket.IO compatibility — prevents errors when the adapter
   * tries to notify about new broadcasts via the socket's client.
   */
  notifyOutgoingListeners() {}
  
  /**
   * No-op dispatch method for Socket.IO compatibility.
   */
  dispatch() {}

  /**
   * Registers an event listener.
   * @param {string} event - Event name
   * @param {Function} handler - Event handler function
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(handler);
  }

  /**
   * Joins a Socket.IO room via the adapter API so that
   * io.to(roomId).emit() broadcasts reach this bot.
   * @param {string} roomId - Room to join
   */
  join(roomId) {
    this.io.of("/").adapter.addAll(this.id, new Set([roomId]));
  }

  /**
   * Removes all registered event listeners.
   */
  removeAllListeners() {
    this._listeners.clear();
  }

  /**
   * Unregisters this bot from the sockets map and leaves the room.
   * Called during cleanup to prevent memory leaks.
   * @param {string} roomId - Room to leave
   */
  destroy(roomId) {
    this.io.sockets.sockets.delete(this.id);
    if (roomId) {
      this.io.of("/").adapter.del(this.id, roomId);
    }
  }

  /**
   * Generates a random alphanumeric string of the specified length.
   * @param {number} length - Desired string length
   * @returns {string}
   * @private
   */
  _randomId(length) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}

module.exports = { BotSocket };
