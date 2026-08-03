const { db } = require("../config/firebase");

/**
 * Matchmaking queue that pairs players using FIFO logic.
 * Players are matched based on earliest `joinedAt` timestamp.
 * A 15-second timeout emits `match_timeout` if no match is found.
 */
class MatchmakingQueue {
  /**
   * @param {import("socket.io").Server} io - Socket.IO server instance
   * @param {object} [battleSessionManager] - BattleSessionManager instance (used for capacity checks)
   */
  constructor(io, battleSessionManager = null) {
    this.io = io;
    this.battleSessionManager = battleSessionManager;

    /** @type {Array<{uid: string, socketId: string, socket: object, username: string, avatar: number, joinedAt: number}>} */
    this.queue = [];

    /** @type {Map<string, NodeJS.Timeout>} Map of socketId -> timeout reference */
    this.timeouts = new Map();
  }

  /**
   * Adds a player to the matchmaking queue and attempts pairing.
   * Prevents duplicate entries for the same UID.
   * Starts a 15-second timeout for the player.
   *
   * @param {object} socket - The authenticated socket instance
   */
  addPlayer(socket) {
    const uid = socket.userId;
    const socketId = socket.id;
    const username = socket.userData?.username || socket.handshake?.auth?.username || "Player";
    const avatar = socket.userData?.avatar ?? socket.handshake?.auth?.avatar ?? 0;

    // Prevent duplicate entries (Requirement 3.7)
    if (this.isPlayerQueued(uid)) {
      return;
    }

    const entry = {
      uid,
      socketId,
      socket,
      username,
      avatar,
      joinedAt: Date.now(),
    };

    this.queue.push(entry);

    // Start 15-second timeout (Requirement 9.5 / match_timeout)
    const timeout = setTimeout(() => {
      this._handleTimeout(socketId);
    }, 15000);
    this.timeouts.set(socketId, timeout);

    // Attempt to pair players (Requirement 3.2)
    this._pairingPromise = this._attemptPairing();
  }

  /**
   * Removes a player from the queue by socketId.
   * Used on disconnect or cancel_match.
   *
   * @param {string} socketId - The socket ID of the player to remove
   */
  removePlayer(socketId) {
    const index = this.queue.findIndex((entry) => entry.socketId === socketId);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }

    // Clear the timeout for this player
    if (this.timeouts.has(socketId)) {
      clearTimeout(this.timeouts.get(socketId));
      this.timeouts.delete(socketId);
    }
  }

  /**
   * Checks if a player is already in the queue.
   *
   * @param {string} uid - Firebase UID
   * @returns {boolean}
   */
  isPlayerQueued(uid) {
    return this.queue.some((entry) => entry.uid === uid);
  }

  /**
   * Returns the current queue length.
   *
   * @returns {number}
   */
  getQueueSize() {
    return this.queue.length;
  }

  /**
   * Attempts to pair the two longest-waiting players (FIFO).
   * Called after each addPlayer.
   * @private
   */
  async _attemptPairing() {
    if (this.queue.length < 2) {
      return;
    }

    // Sort by joinedAt ascending (earliest first) to enforce FIFO
    this.queue.sort((a, b) => a.joinedAt - b.joinedAt);

    // Take the two earliest players
    const player1 = this.queue.shift();
    const player2 = this.queue.shift();

    // Clear their timeouts
    this._clearTimeout(player1.socketId);
    this._clearTimeout(player2.socketId);

    // Generate a unique room ID
    const roomId = this._generateRoomId();

    // Create room in Firebase RTDB (Requirement 3.3)
    try {
      await this._createFirebaseRoom(roomId, player1, player2);
    } catch (err) {
      console.error(`[Matchmaking] Failed to create Firebase room ${roomId}:`, err.message);
      // Put players back in queue on failure
      this.queue.unshift(player1, player2);
      return;
    }

    // Emit match_found to both players (Requirement 3.4)
    player1.socket.emit("match_found", {
      roomId,
      opponent: {
        username: player2.username,
        avatar: player2.avatar,
        uid: player2.uid,
      },
    });

    player2.socket.emit("match_found", {
      roomId,
      opponent: {
        username: player1.username,
        avatar: player1.avatar,
        uid: player1.uid,
      },
    });
  }

  /**
   * Handles timeout for a queued player — emits match_timeout.
   * @param {string} socketId
   * @private
   */
  _handleTimeout(socketId) {
    const index = this.queue.findIndex((entry) => entry.socketId === socketId);
    if (index === -1) {
      // Player already removed (matched or cancelled)
      this.timeouts.delete(socketId);
      return;
    }

    const player = this.queue[index];
    this.queue.splice(index, 1);
    this.timeouts.delete(socketId);

    // Emit match_timeout to the player (Requirement 9.5)
    player.socket.emit("match_timeout", {});
  }

  /**
   * Clears a player's timeout by socketId.
   * @param {string} socketId
   * @private
   */
  _clearTimeout(socketId) {
    if (this.timeouts.has(socketId)) {
      clearTimeout(this.timeouts.get(socketId));
      this.timeouts.delete(socketId);
    }
  }

  /**
   * Creates a room record in Firebase RTDB with status "waiting".
   * @param {string} roomId
   * @param {object} player1
   * @param {object} player2
   * @private
   */
  async _createFirebaseRoom(roomId, player1, player2) {
    const roomData = {
      status: "waiting",
      createdAt: Date.now(),
      players: {
        [player1.uid]: {
          username: player1.username,
          avatar: player1.avatar,
          uid: player1.uid,
          ready: false,
        },
        [player2.uid]: {
          username: player2.username,
          avatar: player2.avatar,
          uid: player2.uid,
          ready: false,
        },
      },
    };

    await db.ref(`rooms/${roomId}`).set(roomData);
  }

  /**
   * Generates a unique room ID.
   * @returns {string}
   * @private
   */
  _generateRoomId() {
    const crypto = require("crypto");
    return crypto.randomUUID();
  }
}

module.exports = { MatchmakingQueue };
