const { db } = require("../config/firebase");

let cachedLeaderboard = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Computes the top-10 leaderboard and optionally includes the requesting user's rank.
 * @param {string|null} requestingUserId - UID from the verified Firebase token, or null for unauthenticated.
 * @returns {{ leaderboard: LeaderboardEntry[], currentUser?: LeaderboardEntry }}
 */
async function getLeaderboard(requestingUserId = null) {
  const now = Date.now();

  if (!cachedLeaderboard || now - cacheTimestamp > CACHE_TTL_MS) {
    const snapshot = await db.ref("users").once("value");
    if (!snapshot.exists()) {
      throw new Error("Failed to read users from RTDB");
    }

    const users = snapshot.val();
    const ranked = Object.entries(users)
      .filter(([_, u]) => {
        const email = u.email || "";
        const username = (u.username || "").toLowerCase();
        return email !== "tezmaths@admin.com" && username !== "admin";
      })
      .map(([id, u]) => ({
        userId: id,
        fullName: u.fullName || "Unknown",
        username: u.username || "Unknown",
        highScore: u.highScore ?? 0,
        highScoreTime: u.highScoreTime ?? 0,
      }))
      .sort((a, b) => {
        if (b.highScore !== a.highScore) return b.highScore - a.highScore;
        if (a.highScoreTime > 0 && b.highScoreTime > 0) {
          return a.highScoreTime - b.highScoreTime;
        }
        return 0;
      })
      .map((user, index) => ({ ...user, rank: index + 1 }));

    cachedLeaderboard = ranked;
    cacheTimestamp = now;
  }

  const top10 = cachedLeaderboard.slice(0, 10);
  let currentUser = undefined;

  if (requestingUserId) {
    const inTop10 = top10.some((u) => u.userId === requestingUserId);
    if (!inTop10) {
      currentUser = cachedLeaderboard.find((u) => u.userId === requestingUserId);
      if (!currentUser) {
        // User has no highScore yet — assign last rank
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

function invalidateCache() {
  cachedLeaderboard = null;
  cacheTimestamp = 0;
}

module.exports = { getLeaderboard, invalidateCache };
