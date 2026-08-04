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

    // Generate and write battle questions
    const questions = await this._generateBattleQuestions(25);
    await db.ref(`roomQuestions/${roomId}`).set(questions);

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
   * Handles timeout for a queued player — creates a bot opponent and pairs them.
   * Replaces the previous match_timeout emission with bot creation logic.
   * @param {string} socketId
   * @private
   */
  async _handleTimeout(socketId) {
    const index = this.queue.findIndex((entry) => entry.socketId === socketId);
    if (index === -1) {
      // Player already removed (matched or cancelled)
      this.timeouts.delete(socketId);
      return;
    }

    const player = this.queue[index];
    this.queue.splice(index, 1);
    this.timeouts.delete(socketId);

    // Create bot and pair with waiting player
    const { BotSocket } = require("./botSocket");
    const { BotOpponent } = require("./botOpponent");

    const botIdentity = BotOpponent.generateIdentity();
    const botSocket = new BotSocket(this.io, botIdentity.username, botIdentity.avatar, botIdentity.userId);

    const roomId = this._generateRoomId();

    // Create Firebase room (same format as real matches)
    await this._createFirebaseRoom(roomId, player, {
      uid: botIdentity.userId,
      username: botIdentity.username,
      avatar: botIdentity.avatar,
    });

    // Generate and write battle questions to Firebase
    const questions = await this._generateBattleQuestions(25);
    await db.ref(`roomQuestions/${roomId}`).set(questions);

    // Join both to room
    player.socket.join(roomId);
    botSocket.join(roomId);

    // Emit match_found to human player
    player.socket.emit("match_found", {
      roomId,
      opponent: {
        username: botIdentity.username,
        avatar: botIdentity.avatar,
        uid: botIdentity.userId,
      },
    });

    // Emit match_found to bot (triggers ready_for_battle)
    botSocket.emit("match_found", { roomId, opponent: { username: player.username, avatar: player.avatar, uid: player.uid } });

    // Create BotOpponent (sets up battle_start / next_question listeners)
    const botOpponent = new BotOpponent(botSocket, this.battleSessionManager, roomId);

    // Bot auto-readies via the ready_for_battle handshake
    const { getReadyPlayers } = require("./handlers");
    const readyPlayers = getReadyPlayers();
    if (!readyPlayers.has(roomId)) {
      readyPlayers.set(roomId, new Map());
    }
    readyPlayers.get(roomId).set(botSocket.userId, botSocket);
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

  /**
   * Generates battle questions by reading from the quiz database (same approach as frontend).
   * Reads quizzes for levels 1-10, processes them, and selects 25 questions.
   * Falls back to random arithmetic if no quiz data is available.
   * @param {number} count - Number of questions to generate
   * @returns {Promise<Array<object>>} Array of question objects
   * @private
   */
  async _generateBattleQuestions(count) {
    const { getQuizzesByLevel } = require("../services/quiz.service");

    try {
      // Fetch quizzes for levels 1-10 (same as frontend's generateQuestions)
      const questionsByLevel = {};
      const levels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      const fetches = levels.map(async (level) => {
        const quizzes = await getQuizzesByLevel(level);
        return { level, quizzes };
      });

      const results = await Promise.all(fetches);

      let hasData = false;
      for (const { level, quizzes } of results) {
        if (quizzes && quizzes.length > 0) {
          hasData = true;
          questionsByLevel[level] = [];
          for (const quiz of quizzes) {
            if (quiz.questions) {
              const questions = Array.isArray(quiz.questions)
                ? quiz.questions
                : Object.values(quiz.questions);
              for (const q of questions) {
                if (q.questionText && q.correctAnswer !== undefined) {
                  questionsByLevel[level].push({
                    question: q.questionText,
                    correctAnswer: q.correctAnswer.toString(),
                    timeLimit: 15,
                    points: 4,
                    explanation: q.explanation || "",
                    level: level,
                  });
                }
              }
            }
          }
        }
      }

      if (!hasData) {
        return this._generateFallbackQuestions(count);
      }

      // Collect questions from levels (same logic as frontend collectQuestionsFromLevels)
      const availableLevels = Object.keys(questionsByLevel).map(Number).sort((a, b) => a - b);
      const battleQuestions = [];

      const getFromLevel = (level, max) => {
        if (!questionsByLevel[level] || questionsByLevel[level].length === 0) return [];
        const shuffled = this._shuffleArray([...questionsByLevel[level]]);
        return shuffled.slice(0, Math.min(max, shuffled.length));
      };

      // Levels 1-5: take up to 3 per level
      for (let level = 1; level <= 5 && battleQuestions.length < count; level++) {
        if (availableLevels.includes(level)) {
          battleQuestions.push(...getFromLevel(level, 3));
        }
      }

      // Levels 6-10: take up to 2 per level
      for (let level = 6; level <= 10 && battleQuestions.length < count; level++) {
        if (availableLevels.includes(level)) {
          battleQuestions.push(...getFromLevel(level, 2));
        }
      }

      // If still not enough, fill from remaining questions
      if (battleQuestions.length < count) {
        const allRemaining = [];
        for (const level of availableLevels) {
          if (questionsByLevel[level]) {
            const used = battleQuestions.filter((q) => q.level === level).length;
            allRemaining.push(...questionsByLevel[level].slice(used));
          }
        }
        const shuffled = this._shuffleArray(allRemaining);
        battleQuestions.push(...shuffled.slice(0, count - battleQuestions.length));
      }

      // If still short, pad with fallback questions
      if (battleQuestions.length < count) {
        const needed = count - battleQuestions.length;
        battleQuestions.push(...this._generateFallbackQuestions(needed));
      }

      return battleQuestions.slice(0, count);
    } catch (err) {
      console.error("[Matchmaking] Failed to generate questions from quizzes, using fallback:", err.message);
      return this._generateFallbackQuestions(count);
    }
  }

  /**
   * Shuffles an array using Fisher-Yates algorithm.
   * @param {Array} arr
   * @returns {Array}
   * @private
   */
  _shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Generates random arithmetic fallback questions.
   * Used when Firebase quiz data is unavailable.
   * @param {number} count
   * @returns {Array<object>}
   * @private
   */
  _generateFallbackQuestions(count) {
    const operations = [
      { op: "+", range: [1, 50] },
      { op: "-", range: [1, 30] },
      { op: "*", range: [1, 12] },
      { op: "÷", range: [1, 10] },
    ];

    const questions = [];
    const usedCombinations = new Set();

    for (let i = 0; i < count; i++) {
      let answer, questionText, signature;
      let attempts = 0;

      do {
        const operation = operations[Math.floor(Math.random() * operations.length)];
        let num1, num2;

        switch (operation.op) {
          case "+":
            num1 = Math.floor(Math.random() * operation.range[1]) + operation.range[0];
            num2 = Math.floor(Math.random() * operation.range[1]) + operation.range[0];
            answer = num1 + num2;
            questionText = `${num1} + ${num2}`;
            signature = `add_${num1}_${num2}`;
            break;
          case "-":
            num1 = Math.floor(Math.random() * operation.range[1]) + operation.range[0] + 10;
            num2 = Math.floor(Math.random() * Math.min(num1, operation.range[1])) + operation.range[0];
            answer = num1 - num2;
            questionText = `${num1} - ${num2}`;
            signature = `sub_${num1}_${num2}`;
            break;
          case "*":
            num1 = Math.floor(Math.random() * operation.range[1]) + operation.range[0];
            num2 = Math.floor(Math.random() * operation.range[1]) + operation.range[0];
            answer = num1 * num2;
            questionText = `${num1} × ${num2}`;
            signature = `mul_${num1}_${num2}`;
            break;
          case "÷":
            num2 = Math.floor(Math.random() * operation.range[1]) + operation.range[0];
            answer = Math.floor(Math.random() * operation.range[1]) + operation.range[0];
            num1 = num2 * answer;
            questionText = `${num1} ÷ ${num2}`;
            signature = `div_${num1}_${num2}`;
            break;
        }
        attempts++;
      } while (usedCombinations.has(signature) && attempts < 10);

      usedCombinations.add(signature);

      questions.push({
        question: questionText,
        correctAnswer: answer.toString(),
        timeLimit: 15,
        points: 4,
        explanation: `Calculate ${questionText}`,
        level: Math.floor(i / 5) + 1,
        signature,
      });
    }

    return questions;
  }
}

module.exports = { MatchmakingQueue };
