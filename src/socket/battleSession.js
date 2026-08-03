const { db, admin } = require("../config/firebase");

/**
 * Maximum number of concurrent battle sessions allowed.
 * Prevents memory exhaustion on the Railway instance.
 */
const MAX_CONCURRENT_SESSIONS = 500;

/**
 * Maximum number of retry attempts for Firebase persistence.
 */
const MAX_PERSIST_RETRIES = 3;

/**
 * Base delay for exponential backoff on persistence retries (in milliseconds).
 * Delays: 1000ms, 2000ms, 4000ms
 */
const PERSIST_RETRY_BASE_DELAY_MS = 1000;

/**
 * Timeout for reading questions from Firebase RTDB (in milliseconds).
 */
const FIREBASE_READ_TIMEOUT_MS = 5000;

/**
 * Time limit per question (in seconds).
 */
const QUESTION_TIME_LIMIT = 15;

/**
 * Transition period between questions (in milliseconds).
 */
const TRANSITION_DELAY_MS = 3000;

/**
 * Reconnection window duration (in milliseconds).
 * A disconnected player has this long to rejoin before the battle ends.
 */
const RECONNECTION_WINDOW_MS = 30000;

/**
 * Delay before removing a finished session from memory (in milliseconds).
 * Requirement 13.1: Remove session within 60 seconds of battle end.
 */
const SESSION_CLEANUP_DELAY_MS = 60000;

/**
 * Interval for monitoring active sessions (in milliseconds).
 * Requirement 13.4: Log active session count every 60 seconds.
 */
const MONITORING_INTERVAL_MS = 60000;

/**
 * Maximum session duration before force-ending (in milliseconds).
 * Requirement 13.5: Force-end sessions active longer than 10 minutes.
 */
const MAX_SESSION_DURATION_MS = 10 * 60 * 1000;

/**
 * Total number of questions per battle session.
 */
const TOTAL_QUESTIONS = 25;

/**
 * BattleSessionManager manages in-memory battle state, timers, scoring,
 * and Firebase persistence for active battles.
 */
class BattleSessionManager {
  /**
   * @param {import("socket.io").Server} io - Socket.IO server instance
   */
  constructor(io) {
    this.io = io;

    /** @type {Map<string, object>} Map of roomId -> session object */
    this.sessions = new Map();

    /** @type {NodeJS.Timeout|null} Reference to the monitoring interval timer */
    this._monitoringInterval = null;
  }

  /**
   * Starts the periodic monitoring interval.
   * Logs active session count every 60 seconds (Requirement 13.4)
   * and force-ends stale sessions active longer than 10 minutes (Requirement 13.5).
   */
  startMonitoring() {
    if (this._monitoringInterval) return; // Already monitoring

    this._monitoringInterval = setInterval(() => {
      console.log(`[BattleSession] Active sessions: ${this.sessions.size}`);
      this._checkStaleSessions();
    }, MONITORING_INTERVAL_MS);
  }

  /**
   * Stops the monitoring interval. Used for cleanup in tests.
   */
  stopMonitoring() {
    if (this._monitoringInterval) {
      clearInterval(this._monitoringInterval);
      this._monitoringInterval = null;
    }
  }

  /**
   * Checks all sessions for staleness and force-ends any that have exceeded
   * the maximum session duration (10 minutes). Persists partial results
   * and disconnects both players.
   *
   * @private
   */
  _checkStaleSessions() {
    const now = Date.now();

    for (const [roomId, session] of this.sessions.entries()) {
      if (
        session.status === "playing" &&
        now - session.createdAt > MAX_SESSION_DURATION_MS
      ) {
        console.log(
          `[BattleSession] Force-ending stale session ${roomId} (active for ${Math.round((now - session.createdAt) / 1000)}s)`
        );

        // Force-end the session, persist partial results (Requirement 13.5)
        this.endSession(roomId, "timeout");

        // Disconnect both player sockets (Requirement 13.5)
        for (const [uid, player] of Object.entries(session.players)) {
          const playerSocket = this.io.sockets.sockets.get(player.socketId);
          if (playerSocket) {
            playerSocket.disconnect(true);
          }
        }
      }
    }
  }

  /**
   * Creates a new battle session for a matched pair of players.
   * Reads questions from Firebase, initializes in-memory state,
   * and emits `battle_start` to both players.
   *
   * @param {string} roomId - The Firebase room ID
   * @param {object} player1Socket - Authenticated socket for player 1
   * @param {object} player2Socket - Authenticated socket for player 2
   * @returns {Promise<object|null>} The created session object, or null on failure
   */
  async createSession(roomId, player1Socket, player2Socket) {
    // Enforce max concurrent sessions (Requirement 13.2, 13.3)
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      player1Socket.emit("server_full", {});
      player2Socket.emit("server_full", {});
      return null;
    }

    // Read questions from Firebase with 5-second timeout (Requirement 4.2, 4.6)
    let questions;
    try {
      questions = await this._readQuestionsWithTimeout(roomId);
    } catch (err) {
      const errorPayload = {
        message: err.message || "Failed to load battle questions",
        code: "QUESTION_LOAD_FAILED",
      };
      player1Socket.emit("battle_error", errorPayload);
      player2Socket.emit("battle_error", errorPayload);
      return null;
    }

    // Initialize in-memory session object
    const now = Date.now();
    const session = {
      roomId,
      players: {
        [player1Socket.userId]: {
          socketId: player1Socket.id,
          username: player1Socket.userData?.username || player1Socket.handshake?.auth?.username || "Player 1",
          avatar: player1Socket.userData?.avatar ?? player1Socket.handshake?.auth?.avatar ?? 0,
          score: 0,
          connected: true,
          disconnectedAt: null,
          answeredCurrent: false,
        },
        [player2Socket.userId]: {
          socketId: player2Socket.id,
          username: player2Socket.userData?.username || player2Socket.handshake?.auth?.username || "Player 2",
          avatar: player2Socket.userData?.avatar ?? player2Socket.handshake?.auth?.avatar ?? 0,
          score: 0,
          connected: true,
          disconnectedAt: null,
          answeredCurrent: false,
        },
      },
      questions,
      currentQuestionIndex: 0,
      questionStartTimestamp: now,
      status: "playing",
      questionTimer: null,
      transitionTimer: null,
      cleanupTimer: null,
      reconnectionTimers: {},
      createdAt: now,
      endedAt: null,
    };

    // Store session in memory
    this.sessions.set(roomId, session);

    // Join both players to the Socket.IO room
    player1Socket.join(roomId);
    player2Socket.join(roomId);

    // Emit battle_start to both players (Requirement 4.4, 4.5)
    const firstQuestion = questions[0];
    const battleStartPayload = {
      roomId,
      question: firstQuestion.question,
      questionIndex: 0,
      totalQuestions: questions.length,
      timeLimit: QUESTION_TIME_LIMIT,
      serverTimestamp: now,
    };

    player1Socket.emit("battle_start", battleStartPayload);
    player2Socket.emit("battle_start", battleStartPayload);

    // Start the question timer for the first question (Requirement 6.1)
    this._startQuestionTimer(roomId);

    return session;
  }

  /**
   * Processes an answer submission from a player.
   * Validates membership, timing, and deduplication before scoring.
   *
   * @param {string} roomId - The room ID of the battle session
   * @param {string} uid - The Firebase UID of the submitting player
   * @param {string} answer - The player's submitted answer
   * @param {number} questionIndex - The question index being answered
   * @returns {object} Result object with { success, reason? }
   */
  submitAnswer(roomId, uid, answer, questionIndex) {
    const session = this.sessions.get(roomId);

    // Session must exist
    if (!session) {
      return { success: false, reason: "session_not_found" };
    }

    // Validate player is a member of the session (Requirement 5.7)
    const player = session.players[uid];
    if (!player) {
      return { success: false, reason: "not_a_member" };
    }

    // Validate question timer hasn't expired (Requirement 5.5)
    const now = Date.now();
    const elapsed = now - session.questionStartTimestamp;
    if (elapsed > QUESTION_TIME_LIMIT * 1000) {
      // Emit time_expired to the submitter
      const submitterSocket = this.io.sockets.sockets.get(player.socketId);
      if (submitterSocket) {
        submitterSocket.emit("time_expired", { questionIndex });
      }
      return { success: false, reason: "time_expired" };
    }

    // Validate player hasn't already answered this question (Requirement 5.6)
    if (player.answeredCurrent) {
      return { success: false, reason: "already_answered" };
    }

    // Compare answer against stored correct answer (Requirement 5.1, 5.2)
    const currentQuestion = session.questions[questionIndex];
    const correct = answer === currentQuestion.correctAnswer;

    // Increment score by 4 if correct (Requirement 5.2)
    if (correct) {
      player.score += 4;
    }

    // Mark player as having answered (Requirement 5.6)
    player.answeredCurrent = true;

    // Emit answer_result to submitter (Requirement 5.3)
    const submitterSocket = this.io.sockets.sockets.get(player.socketId);
    if (submitterSocket) {
      submitterSocket.emit("answer_result", {
        correct,
        score: player.score,
        questionIndex,
      });
    }

    // Emit opponent_answered to the other player (Requirement 5.4)
    // Never include the answer text
    const opponentUid = Object.keys(session.players).find((id) => id !== uid);
    if (opponentUid) {
      const opponent = session.players[opponentUid];
      const opponentSocket = this.io.sockets.sockets.get(opponent.socketId);
      if (opponentSocket) {
        opponentSocket.emit("opponent_answered", {
          correct,
          score: player.score,
          questionIndex,
        });
      }
    }

    // Check if both players have answered to advance (Requirement 6.6)
    this._checkBothAnswered(roomId);

    return { success: true, correct };
  }

  /**
   * Retrieves an active session by roomId.
   *
   * @param {string} roomId - The room ID to look up
   * @returns {object|undefined} The session object, or undefined if not found
   */
  getSession(roomId) {
    return this.sessions.get(roomId);
  }

  /**
   * Returns the number of currently active (non-finished) sessions.
   *
   * @returns {number}
   */
  getActiveSessionCount() {
    return this.sessions.size;
  }

  /**
   * Reads questions from Firebase RTDB at `roomQuestions/{roomId}` with a 5-second timeout.
   * Throws if the read exceeds the timeout or if no questions are found.
   *
   * @param {string} roomId - The room ID to read questions for
   * @returns {Promise<Array>} Array of question objects
   * @private
   */
  async _readQuestionsWithTimeout(roomId) {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("Firebase question read timed out after 5 seconds"));
      }, FIREBASE_READ_TIMEOUT_MS);
    });

    const readPromise = db.ref(`roomQuestions/${roomId}`).once("value").then((snapshot) => {
      const data = snapshot.val();
      if (!data) {
        throw new Error("No questions found for this room");
      }
      // Handle both array and object formats from Firebase
      const questions = Array.isArray(data) ? data : Object.values(data);
      return questions;
    });

    return Promise.race([readPromise, timeoutPromise]);
  }

  /**
   * Starts the 15-second question timer for the current question.
   * On expiry, emits question_timeout and advances to the next question.
   *
   * @param {string} roomId - The room ID
   * @private
   */
  _startQuestionTimer(roomId) {
    const session = this.sessions.get(roomId);
    if (!session) return;

    // Clear any existing question timer
    if (session.questionTimer) {
      clearTimeout(session.questionTimer);
      session.questionTimer = null;
    }

    // Update the question start timestamp
    session.questionStartTimestamp = Date.now();

    // Start a 15-second timer (Requirement 6.1)
    session.questionTimer = setTimeout(() => {
      session.questionTimer = null;
      this._emitQuestionTimeout(roomId);
      this._advanceQuestion(roomId);
    }, QUESTION_TIME_LIMIT * 1000);
  }

  /**
   * Checks if both players have answered the current question.
   * If both have answered, clears the question timer and advances.
   *
   * @param {string} roomId - The room ID
   * @private
   */
  _checkBothAnswered(roomId) {
    const session = this.sessions.get(roomId);
    if (!session) return;

    const playerIds = Object.keys(session.players);
    const allAnswered = playerIds.every((uid) => session.players[uid].answeredCurrent);

    if (allAnswered) {
      // Clear the question timer since both answered early (Requirement 6.6)
      if (session.questionTimer) {
        clearTimeout(session.questionTimer);
        session.questionTimer = null;
      }
      this._advanceQuestion(roomId);
    }
  }

  /**
   * Emits question_timeout to both players with correct answer, scores, and question index.
   *
   * @param {string} roomId - The room ID
   * @private
   */
  _emitQuestionTimeout(roomId) {
    const session = this.sessions.get(roomId);
    if (!session) return;

    const currentQuestion = session.questions[session.currentQuestionIndex];
    const scores = {};
    for (const [uid, player] of Object.entries(session.players)) {
      scores[uid] = player.score;
    }

    const payload = {
      correctAnswer: currentQuestion.correctAnswer,
      scores,
      questionIndex: session.currentQuestionIndex,
    };

    // Emit to both players (Requirement 6.2)
    this.io.to(roomId).emit("question_timeout", payload);
  }

  /**
   * Advances to the next question after a 3-second transition period.
   * If the question limit is reached, ends the session.
   *
   * @param {string} roomId - The room ID
   * @private
   */
  _advanceQuestion(roomId) {
    const session = this.sessions.get(roomId);
    if (!session || session.status !== "playing") return;

    // Clear any existing transition timer
    if (session.transitionTimer) {
      clearTimeout(session.transitionTimer);
      session.transitionTimer = null;
    }

    // Wait 3 seconds (transition period) then advance (Requirement 6.3)
    session.transitionTimer = setTimeout(() => {
      session.transitionTimer = null;

      // Increment the question index
      session.currentQuestionIndex += 1;

      // Check if we've reached the question limit (Requirement 6.4)
      if (session.currentQuestionIndex >= TOTAL_QUESTIONS) {
        this.endSession(roomId, "completed");
        return;
      }

      // Reset answeredCurrent for both players
      for (const uid of Object.keys(session.players)) {
        session.players[uid].answeredCurrent = false;
      }

      // Emit next_question with ONLY question text, index, and server timestamp (Requirement 6.5, Property 17)
      const nextQuestion = session.questions[session.currentQuestionIndex];
      const now = Date.now();

      const payload = {
        question: nextQuestion.question,
        questionIndex: session.currentQuestionIndex,
        serverTimestamp: now,
      };

      this.io.to(roomId).emit("next_question", payload);

      // Start new question timer (Requirement 6.1)
      this._startQuestionTimer(roomId);
    }, TRANSITION_DELAY_MS);
  }

  /**
   * Handles a player disconnection during an active battle.
   * Marks the player as disconnected, notifies the opponent, and starts
   * a 30-second reconnection timer.
   *
   * @param {string} roomId - The room ID
   * @param {string} uid - The Firebase UID of the disconnected player
   */
  handleDisconnect(roomId, uid) {
    const session = this.sessions.get(roomId);
    if (!session || session.status !== "playing") return;

    const player = session.players[uid];
    if (!player) return;

    // Mark player as disconnected (Requirement 8.1)
    player.connected = false;
    player.disconnectedAt = Date.now();

    // Emit player_disconnected to opponent (Requirement 8.2)
    this.io.to(roomId).emit("player_disconnected", { uid });

    // Start 30-second reconnection timer (Requirement 8.3)
    session.reconnectionTimers[uid] = setTimeout(() => {
      delete session.reconnectionTimers[uid];
      this._handleReconnectionTimeout(roomId, uid);
    }, RECONNECTION_WINDOW_MS);
  }

  /**
   * Handles a player reconnecting to an active battle within the reconnection window.
   * Rejoins the player to the room, emits full state sync, and notifies the opponent.
   *
   * @param {string} roomId - The room ID
   * @param {string} uid - The Firebase UID of the reconnecting player
   * @param {object} socket - The new socket for the reconnecting player
   */
  handleReconnect(roomId, uid, socket) {
    const session = this.sessions.get(roomId);
    if (!session || session.status !== "playing") return;

    const player = session.players[uid];
    if (!player) return;

    // Update socket reference and mark connected (Requirement 8.4)
    player.socketId = socket.id;
    player.connected = true;
    player.disconnectedAt = null;

    // Clear reconnection timer (Requirement 8.4)
    if (session.reconnectionTimers[uid]) {
      clearTimeout(session.reconnectionTimers[uid]);
      delete session.reconnectionTimers[uid];
    }

    // Rejoin the Socket.IO room
    socket.join(roomId);

    // Build full state sync payload (Requirement 8.4, Property 16)
    const scores = {};
    const players = {};
    for (const [playerUid, playerData] of Object.entries(session.players)) {
      scores[playerUid] = playerData.score;
      players[playerUid] = {
        connected: playerData.connected,
        username: playerData.username,
        avatar: playerData.avatar,
        score: playerData.score,
      };
    }

    const now = Date.now();
    const elapsed = now - session.questionStartTimestamp;
    const timeRemaining = Math.max(0, QUESTION_TIME_LIMIT * 1000 - elapsed);

    const fullState = {
      roomId: session.roomId,
      currentQuestionIndex: session.currentQuestionIndex,
      questionStartTimestamp: session.questionStartTimestamp,
      scores,
      players,
      timeRemaining,
      status: session.status,
    };

    // Emit battle_state_sync ONLY to the reconnecting socket (Requirement 8.4, 11.5)
    socket.emit("battle_state_sync", { fullState });

    // Emit player_reconnected to the room (opponent receives it) (Requirement 8.5)
    this.io.to(roomId).emit("player_reconnected", { uid });
  }

  /**
   * Handles a player intentionally leaving a battle (emits `leave_battle`).
   * Marks the leaving player as disconnected and immediately ends the session
   * with reason "opponent_left", declaring the remaining player the winner.
   *
   * @param {string} roomId - The room ID
   * @param {string} uid - The Firebase UID of the leaving player
   */
  handleLeave(roomId, uid) {
    const session = this.sessions.get(roomId);
    if (!session || session.status !== "playing") return;

    const player = session.players[uid];
    if (!player) return;

    // Mark the leaving player as disconnected (Requirement 12.1)
    player.connected = false;
    player.disconnectedAt = Date.now();

    // End session immediately with reason "opponent_left" (Requirement 12.1, 12.2)
    this.endSession(roomId, "opponent_left");
  }

  /**
   * Called when a player's 30-second reconnection window expires.
   * If the player is still disconnected, ends the battle appropriately.
   *
   * @param {string} roomId - The room ID
   * @param {string} uid - The UID of the player whose timer expired
   * @private
   */
  _handleReconnectionTimeout(roomId, uid) {
    const session = this.sessions.get(roomId);
    if (!session || session.status !== "playing") return;

    const player = session.players[uid];
    if (!player || player.connected) return;

    // Check if BOTH players are disconnected (Requirement 12.5)
    const playerIds = Object.keys(session.players);
    const allDisconnected = playerIds.every(
      (id) => !session.players[id].connected
    );

    if (allDisconnected) {
      // Both players disconnected — end with no winner (Requirement 12.5)
      this.endSession(roomId, "both_disconnected");
    } else {
      // Only this player is still disconnected — opponent wins (Requirement 8.6)
      this.endSession(roomId, "opponent_disconnected");
    }
  }

  /**
   * Ends the battle session. Sets status to "finished", emits battle_end
   * with scores, winner, reason, and placements.
   * Full persistence logic will be implemented in task 5.1.
   *
   * @param {string} roomId - The room ID
   * @param {string} reason - The reason for ending ("completed", "opponent_left", "opponent_disconnected", "both_disconnected")
   */
  endSession(roomId, reason) {
    const session = this.sessions.get(roomId);
    if (!session) return;

    // Mark session as finished
    session.status = "finished";
    session.endedAt = Date.now();

    // Clear any active timers
    if (session.questionTimer) {
      clearTimeout(session.questionTimer);
      session.questionTimer = null;
    }
    if (session.transitionTimer) {
      clearTimeout(session.transitionTimer);
      session.transitionTimer = null;
    }
    // Clear any reconnection timers
    for (const uid of Object.keys(session.reconnectionTimers)) {
      clearTimeout(session.reconnectionTimers[uid]);
      delete session.reconnectionTimers[uid];
    }

    // Calculate winner and placements (Requirement 7.1)
    const playerEntries = Object.entries(session.players).map(([uid, player]) => ({
      uid,
      score: player.score,
      username: player.username,
    }));

    // Sort by descending score
    playerEntries.sort((a, b) => b.score - a.score);

    // Determine winner (null if tie)
    let winner = null;
    if (reason === "opponent_disconnected") {
      // The connected player wins (Requirement 8.6)
      const connectedPlayer = playerEntries.find(
        (entry) => session.players[entry.uid].connected
      );
      if (connectedPlayer) {
        winner = connectedPlayer.uid;
      }
    } else if (reason === "both_disconnected") {
      // No winner when both disconnected (Requirement 12.5)
      winner = null;
    } else if (reason === "opponent_left") {
      // The remaining connected player wins (Requirement 12.1)
      const connectedPlayer = playerEntries.find(
        (entry) => session.players[entry.uid].connected
      );
      if (connectedPlayer) {
        winner = connectedPlayer.uid;
      }
    } else {
      // Normal completion — highest score wins (Requirement 7.1)
      if (playerEntries.length === 2 && playerEntries[0].score !== playerEntries[1].score) {
        winner = playerEntries[0].uid;
      }
    }

    // Build placements
    const placements = playerEntries.map((entry, index) => ({
      userId: entry.uid,
      score: entry.score,
      placement: index + 1,
      username: entry.username,
    }));

    // Build scores map
    const scores = {};
    for (const [uid, player] of Object.entries(session.players)) {
      scores[uid] = player.score;
    }

    // Emit battle_end to both players (Requirement 7.2)
    const payload = {
      scores,
      winner,
      reason,
      placements,
    };

    this.io.to(roomId).emit("battle_end", payload);

    // Schedule cleanup to remove session from memory within 60 seconds (Requirement 13.1)
    session.cleanupTimer = setTimeout(() => {
      this.sessions.delete(roomId);
    }, SESSION_CLEANUP_DELAY_MS);

    // Persist results to Firebase (Requirements 7.3, 7.4, 7.5, 7.6)
    this._persistResults(roomId, session, { winner, reason, placements, scores });
  }

  /**
   * Persists battle results to Firebase RTDB with retry logic.
   * Writes room results and updates user stats.
   * Retries up to 3 times with exponential backoff (1s, 2s, 4s).
   * On failure, emits `persist_error` to both players and logs the payload.
   *
   * @param {string} roomId - The room ID
   * @param {object} session - The session object
   * @param {object} results - The computed results { winner, reason, placements, scores }
   * @private
   */
  async _persistResults(roomId, session, results) {
    const { winner, reason, placements, scores } = results;

    // Build room update payload (Requirement 7.3)
    const roomUpdate = {
      status: "finished",
      finishedAt: admin.database.ServerValue.TIMESTAMP,
      gameWinner: winner || null,
      gameEndReason: reason,
      results: placements,
    };

    // Add per-player data to players node
    const playersUpdate = {};
    for (const placement of placements) {
      playersUpdate[placement.userId] = {
        finalScore: placement.score,
        isWinner: winner === placement.userId,
        placement: placement.placement,
      };
    }
    roomUpdate.players = playersUpdate;

    // Attempt to write room results with retry
    const roomWriteSuccess = await this._retryWrite(
      () => db.ref(`rooms/${roomId}`).update(roomUpdate),
      roomId
    );

    if (!roomWriteSuccess) {
      this._emitPersistError(roomId, session, { roomUpdate, userStatsIntended: true });
      return;
    }

    // Update user stats (Requirement 7.4)
    const userStatsSuccess = await this._persistUserStats(session, winner, scores);

    if (!userStatsSuccess) {
      this._emitPersistError(roomId, session, { roomUpdate, userStats: scores });
      return;
    }
  }

  /**
   * Updates user stats in Firebase RTDB for each player.
   * Increments totalPoints, xp, battlesPlayed, battlesWon, and battlesLost.
   *
   * @param {object} session - The session object
   * @param {string|null} winner - The winner UID, or null for tie
   * @param {object} scores - Map of uid -> score
   * @returns {Promise<boolean>} True if all updates succeeded
   * @private
   */
  async _persistUserStats(session, winner, scores) {
    const playerUids = Object.keys(session.players);

    for (const uid of playerUids) {
      const score = scores[uid] || 0;
      const won = uid === winner;
      // XP: score earned in this battle (same as points for now)
      const xpGained = score;

      const statsUpdate = {};
      statsUpdate["totalPoints"] = admin.database.ServerValue.increment(score);
      statsUpdate["xp"] = admin.database.ServerValue.increment(xpGained);
      statsUpdate["battlesPlayed"] = admin.database.ServerValue.increment(1);
      statsUpdate["battlesWon"] = admin.database.ServerValue.increment(won ? 1 : 0);
      statsUpdate["battlesLost"] = admin.database.ServerValue.increment(won ? 0 : 1);

      const success = await this._retryWrite(
        () => db.ref(`users/${uid}`).update(statsUpdate),
        `users/${uid}`
      );

      if (!success) {
        return false;
      }
    }

    return true;
  }

  /**
   * Retries a Firebase write operation with exponential backoff.
   * Attempts: 3 times with delays of 1s, 2s, 4s.
   *
   * @param {Function} writeFn - Async function performing the write
   * @param {string} context - Description for logging purposes
   * @returns {Promise<boolean>} True if write succeeded, false if all retries exhausted
   * @private
   */
  async _retryWrite(writeFn, context) {
    for (let attempt = 0; attempt < MAX_PERSIST_RETRIES; attempt++) {
      try {
        await writeFn();
        return true;
      } catch (err) {
        const delay = PERSIST_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.error(
          `[BattleSession] Firebase write failed for ${context}, attempt ${attempt + 1}/${MAX_PERSIST_RETRIES}. ` +
          `Retrying in ${delay}ms. Error: ${err.message}`
        );

        if (attempt < MAX_PERSIST_RETRIES - 1) {
          await this._delay(delay);
        }
      }
    }

    return false;
  }

  /**
   * Emits a `persist_error` event to both players and logs the full result payload
   * for manual recovery.
   *
   * @param {string} roomId - The room ID
   * @param {object} session - The session object
   * @param {object} payload - The data that failed to persist
   * @private
   */
  _emitPersistError(roomId, session, payload) {
    console.error(
      `[BattleSession] All retries exhausted for room ${roomId}. ` +
      `Full result payload for manual recovery:`,
      JSON.stringify(payload)
    );

    this.io.to(roomId).emit("persist_error", {
      message: "Failed to save battle results after multiple attempts",
    });
  }

  /**
   * Returns a promise that resolves after the specified delay.
   *
   * @param {number} ms - Delay in milliseconds
   * @returns {Promise<void>}
   * @private
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { BattleSessionManager, MAX_CONCURRENT_SESSIONS, MAX_PERSIST_RETRIES, PERSIST_RETRY_BASE_DELAY_MS, QUESTION_TIME_LIMIT, TRANSITION_DELAY_MS, RECONNECTION_WINDOW_MS, TOTAL_QUESTIONS, SESSION_CLEANUP_DELAY_MS, MONITORING_INTERVAL_MS, MAX_SESSION_DURATION_MS };
