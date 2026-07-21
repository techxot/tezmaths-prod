const { db } = require("../config/firebase");

let cachedLeaderboard = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Computes the top-10 leaderboard and optionally includes the requesting user's rank.
 * Reads from the lightweight /leaderboard node instead of the full /users node.
 * @param {string|null} requestingUserId - UID from the verified Firebase token, or null for unauthenticated.
 * @returns {{ leaderboard: LeaderboardEntry[], currentUser?: LeaderboardEntry }}
 */
async function getLeaderboard(requestingUserId = null) {
  const now = Date.now();

  if (!cachedLeaderboard || now - cacheTimestamp > CACHE_TTL_MS) {
    // Read from lightweight /leaderboard node instead of full /users
    const snapshot = await db.ref("leaderboard")
      .orderByChild("highScore")
      .limitToLast(100) // Get top 100 — enough for ranking
      .once("value");

    if (!snapshot.exists()) {
      // Fallback: if /leaderboard node is empty, try /users (backward compat)
      return await getLeaderboardFromUsers(requestingUserId);
    }

    const entries = [];
    snapshot.forEach((child) => {
      const data = child.val();
      entries.push({
        userId: child.key,
        fullName: data.fullName || "Unknown",
        username: data.username || "Unknown",
        highScore: data.highScore ?? 0,
        highScoreTime: data.highScoreTime ?? 0,
      });
    });

    // Sort descending by highScore, then ascending by highScoreTime for ties
    entries.sort((a, b) => {
      if (b.highScore !== a.highScore) return b.highScore - a.highScore;
      if (a.highScoreTime > 0 && b.highScoreTime > 0) {
        return a.highScoreTime - b.highScoreTime;
      }
      return 0;
    });

    cachedLeaderboard = entries.map((user, index) => ({ ...user, rank: index + 1 }));
    cacheTimestamp = now;
  }

  const top10 = cachedLeaderboard.slice(0, 10);
  let currentUser = undefined;

  if (requestingUserId) {
    const inTop10 = top10.some((u) => u.userId === requestingUserId);
    if (!inTop10) {
      currentUser = cachedLeaderboard.find((u) => u.userId === requestingUserId);
      if (!currentUser) {
        // User has no entry in leaderboard yet — assign last rank
        currentUser = {
          userId: requestingUserId,
          fullName: "Unknown",
          username: "Unknown",
          highScore: 0,
          highScoreTime: 0,
          rank: cachedLeaderboard.length + 1,
        };
      }
    }
  }

  return { leaderboard: top10, currentUser };
}

/**
 * Fallback for when /leaderboard node doesn't exist yet (pre-migration).
 * OPTIMIZED: Instead of downloading ALL /users (14 MB), returns empty and logs a warning.
 * The migration script should be run to populate /leaderboard before this is needed.
 */
async function getLeaderboardFromUsers(requestingUserId) {
  console.warn("[Leaderboard] FALLBACK TRIGGERED — /leaderboard node is empty. Run migrate-leaderboard.js to populate it.");
  
  // Return empty rather than downloading 14 MB of all users
  // The admin should run the migration script to fix this
  return { 
    leaderboard: [], 
    currentUser: requestingUserId ? {
      userId: requestingUserId,
      fullName: "Unknown",
      username: "Unknown",
      highScore: 0,
      highScoreTime: 0,
      rank: 1,
    } : undefined 
  };
}

function invalidateCache() {
  cachedLeaderboard = null;
  cacheTimestamp = 0;
}

module.exports = { getLeaderboard, invalidateCache };
