/**
 * BotOpponent — Server-side bot logic that simulates a human player answering
 * questions during a battle session. Uses the same name pool, timing, and
 * accuracy as the original client-side ComputerOpponent.
 *
 * The bot listens for battle_start, next_question, and battle_end events on its
 * BotSocket and calls BattleSessionManager.submitAnswer() directly.
 */

const OPPONENT_NAMES = [
  "Arjun", "Priya", "Rohan", "Ananya", "Vikram",
  "Sneha", "Aditya", "Kavya", "Rahul", "Ishaan",
  "Aarav", "Simran", "Rudra", "Neel", "Aadhya",
  "Karan", "Meera", "Shaurya", "Naina", "Varun",
  "Myra", "Tushar", "Veer", "Riya", "Sahil",
  "Kriti", "Dev", "Pooja", "Aryan", "Saanvi",
  "Ishita", "Parth", "Komal", "Ayush", "Shreya",
  "Chirag", "Diya", "Kabir", "Payal", "Manav",
  "Daksh", "Aarti", "Mohit", "Navya", "Om",
  "Radhika", "Kunal", "Muskaan", "Harsh",
  "Isha", "Gaurav", "Pari", "Abhishek", "Nikhil",
  "Preeti", "Tanay", "Sonal", "Saurabh", "Aarohi",
  "Deepak", "Sakshi", "Reyansh", "Heena", "Raj",
  "Jyoti", "Pranav", "Neha", "Ashish", "Bhavna",
  "Yuvraj", "Rekha", "Shrey", "Alka", "Samar",
  "Sunita", "Uday", "Divya", "Amit", "Seema",
  "Laksh", "Ritik", "Vivek", "Hemant", "Anurag",
  "Pankaj", "Ritesh", "Lokesh", "Naveen", "Tarun",
  "Vinay", "Rakesh", "Ajay", "Dinesh", "Naresh",
  "Sanjay", "Monika", "Anjali", "Pallavi", "Rashmi",
  "Nidhi", "Garima", "Shruti", "Tanvi", "Pihu", "Khushi",
];

class BotOpponent {
  /**
   * Generates a random bot identity (username, avatar, userId).
   * @returns {{ username: string, avatar: number, userId: string }}
   */
  static generateIdentity() {
    const username = OPPONENT_NAMES[Math.floor(Math.random() * OPPONENT_NAMES.length)];
    const avatar = Math.floor(Math.random() * 6); // 0-5
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let userId = "cpu_";
    for (let i = 0; i < 20; i++) {
      userId += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return { username, avatar, userId };
  }

  /**
   * @param {import("./botSocket").BotSocket} botSocket - The bot's socket adapter
   * @param {import("./battleSession").BattleSessionManager} battleSessionManager - Session manager reference
   * @param {string} roomId - Room ID for this battle
   */
  constructor(botSocket, battleSessionManager, roomId) {
    this.socket = botSocket;
    this.bsm = battleSessionManager;
    this.roomId = roomId;
    this.userId = botSocket.userId;
    this.answerTimer = null;
    this._setupListeners();
  }

  /**
   * Registers event listeners on the bot socket for battle lifecycle events.
   * @private
   */
  _setupListeners() {
    this.socket.on("battle_start", (data) => {
      console.log(`[BotOpponent] Received battle_start for room ${this.roomId}, questionIndex: ${data.questionIndex}`);
      this._scheduleAnswer(data);
    });
    this.socket.on("next_question", (data) => {
      console.log(`[BotOpponent] Received next_question for room ${this.roomId}, questionIndex: ${data.questionIndex}`);
      this._scheduleAnswer(data);
    });
    this.socket.on("battle_end", () => {
      console.log(`[BotOpponent] Received battle_end for room ${this.roomId}`);
      this._cleanup();
    });
  }

  /**
   * Schedules an answer submission after a random delay (1000-3000ms).
   * Cancels any previously pending answer timer first.
   * @param {object} data - Event data containing questionIndex
   * @private
   */
  _scheduleAnswer(data) {
    this._cancelPendingAnswer();
    const delay = 1000 + Math.floor(Math.random() * 2001); // 1000-3000ms
    console.log(`[BotOpponent] Scheduling answer for question ${data.questionIndex} in ${delay}ms`);
    this.answerTimer = setTimeout(() => {
      const answer = this._generateAnswer(data.questionIndex);
      console.log(`[BotOpponent] Submitting answer "${answer}" for question ${data.questionIndex} in room ${this.roomId}`);
      this.bsm.submitAnswer(this.roomId, this.userId, answer, data.questionIndex);
    }, delay);
  }

  /**
   * Generates an answer for the given question.
   * 80% chance of correct answer, 20% chance of wrong answer (±1-5 offset).
   * Falls back to correct answer for non-numeric values.
   * @param {number} questionIndex - Index of the current question
   * @returns {string} The answer string
   * @private
   */
  _generateAnswer(questionIndex) {
    const session = this.bsm.getSession(this.roomId);
    if (!session) return "0";

    const question = session.questions[questionIndex];
    if (!question) return "0";

    const correct = question.correctAnswer;

    if (Math.random() < 0.8) {
      return String(correct);
    }

    // Wrong answer: ± random(1-5) from correct
    const numCorrect = parseFloat(correct);
    if (isNaN(numCorrect)) {
      return String(correct);
    }

    const offset = (Math.random() < 0.5 ? 1 : -1) * (Math.floor(Math.random() * 5) + 1);
    return String(numCorrect + offset);
  }

  /**
   * Cancels any pending answer timer.
   * @private
   */
  _cancelPendingAnswer() {
    if (this.answerTimer) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }
  }

  /**
   * Cleans up the bot: cancels timers, removes listeners, leaves the room.
   * @private
   */
  _cleanup() {
    this._cancelPendingAnswer();
    this.socket.removeAllListeners();
    // Unregister bot from sockets map and leave the room
    this.socket.destroy(this.roomId);
  }
}

module.exports = { BotOpponent, OPPONENT_NAMES };
