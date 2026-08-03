const { MAX_CONCURRENT_SESSIONS } = require("./battleSession");

/**
 * Tracks player readiness per room.
 * Map<roomId, Map<uid, socket>>
 * When both players signal ready, createSession is called.
 * @type {Map<string, Map<string, object>>}
 */
const readyPlayers = new Map();

/**
 * Registers all event handlers for an authenticated socket connection.
 *
 * @param {import("socket.io").Server} io - Socket.IO server instance
 * @param {object} socket - The authenticated socket instance
 * @param {import("./matchmaking").MatchmakingQueue} matchmakingQueue - Matchmaking queue instance
 * @param {import("./battleSession").BattleSessionManager} battleSessionManager - Battle session manager instance
 */
function registerHandlers(io, socket, matchmakingQueue, battleSessionManager) {
  const uid = socket.userId;

  // --- find_match ---
  // Requirement 3.1: Add player to matchmaking queue
  // Requirement 13.2, 13.3: Check server capacity first
  socket.on("find_match", () => {
    // Check capacity before allowing matchmaking
    if (battleSessionManager.getActiveSessionCount() >= MAX_CONCURRENT_SESSIONS) {
      socket.emit("server_full", {});
      return;
    }

    matchmakingQueue.addPlayer(socket);
  });

  // --- cancel_match ---
  // Requirement 3.6: Remove player from queue and acknowledge
  socket.on("cancel_match", () => {
    matchmakingQueue.removePlayer(socket.id);
    socket.emit("cancel_match_ack", {});
  });

  // --- ready_for_battle ---
  // Requirement 4.1: Track readiness, when both players ready call createSession
  socket.on("ready_for_battle", ({ roomId }) => {
    if (!roomId) return;

    if (!readyPlayers.has(roomId)) {
      readyPlayers.set(roomId, new Map());
    }

    const roomReady = readyPlayers.get(roomId);
    roomReady.set(uid, socket);

    // When both players are ready, create the session
    if (roomReady.size === 2) {
      const players = Array.from(roomReady.values());
      const player1Socket = players[0];
      const player2Socket = players[1];

      // Clean up the readiness tracking for this room
      readyPlayers.delete(roomId);

      // Create the battle session
      battleSessionManager.createSession(roomId, player1Socket, player2Socket);
    }
  });

  // --- submit_answer ---
  // Requirement 5.1: Validate and score answer submission
  socket.on("submit_answer", ({ roomId, questionIndex, answer }) => {
    if (!roomId || questionIndex === undefined || answer === undefined) return;

    battleSessionManager.submitAnswer(roomId, uid, answer, questionIndex);
  });

  // --- leave_battle ---
  // Requirement 12.1: Intentional leave, end session immediately
  socket.on("leave_battle", ({ roomId }) => {
    if (!roomId) return;

    battleSessionManager.handleLeave(roomId, uid);
  });

  // --- disconnect ---
  // Requirement 3.5: Remove from matchmaking queue on disconnect
  // Requirement 8.1: Handle battle disconnect if in active session
  socket.on("disconnect", () => {
    // Remove from matchmaking queue
    matchmakingQueue.removePlayer(socket.id);

    // Clean up any ready_for_battle tracking
    for (const [roomId, roomReady] of readyPlayers.entries()) {
      if (roomReady.has(uid)) {
        roomReady.delete(uid);
        if (roomReady.size === 0) {
          readyPlayers.delete(roomId);
        }
      }
    }

    // Check if player is in an active battle session and handle disconnect
    for (const [roomId, session] of battleSessionManager.sessions.entries()) {
      if (session.status === "playing" && session.players[uid]) {
        battleSessionManager.handleDisconnect(roomId, uid);
        break; // A player can only be in one session at a time
      }
    }
  });
}

/**
 * Returns the ready players map (for testing purposes).
 * @returns {Map<string, Map<string, object>>}
 */
function getReadyPlayers() {
  return readyPlayers;
}

module.exports = { registerHandlers, getReadyPlayers };
