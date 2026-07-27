const { db } = require("../config/firebase");

/**
 * Quiz Cache Service — Server-side proxy for quiz data.
 * 
 * Instead of 500 clients each reading quizzes from Firebase (540KB × 500 = 270MB/day per level),
 * this service reads ONCE from Firebase and serves all clients from memory.
 * 
 * Firebase bandwidth: 1 read per level per cache TTL (vs 500 reads per level per day)
 */

// In-memory cache: { level: { data: [...], timestamp: number } }
const quizCache = new Map();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (matches client-side TTL)

/**
 * Get quizzes for a specific level.
 * Reads from cache if available, otherwise fetches from Firebase.
 */
async function getQuizzesByLevel(level) {
  const cached = quizCache.get(level);
  const now = Date.now();

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

  // Cache miss — fetch from Firebase
  const snapshot = await db.ref("quizzes")
    .orderByChild("level")
    .equalTo(level)
    .once("value");

  if (!snapshot.exists()) {
    quizCache.set(level, { data: [], timestamp: now });
    return [];
  }

  const quizzes = [];
  snapshot.forEach((child) => {
    quizzes.push({ id: child.key, ...child.val() });
  });

  quizCache.set(level, { data: quizzes, timestamp: now });
  console.log(`[quiz.service] Cache refreshed for level ${level}: ${quizzes.length} quizzes, ~${Math.round(JSON.stringify(quizzes).length / 1024)} KB`);

  return quizzes;
}

/**
 * Invalidate cache for a specific level (called when admin updates quizzes).
 */
function invalidateLevel(level) {
  quizCache.delete(level);
  console.log(`[quiz.service] Cache invalidated for level ${level}`);
}

/**
 * Invalidate all quiz cache (called when admin does bulk operations).
 */
function invalidateAll() {
  quizCache.clear();
  console.log(`[quiz.service] All quiz cache invalidated`);
}

/**
 * Get cache stats for monitoring.
 */
function getCacheStats() {
  const stats = {
    cachedLevels: quizCache.size,
    levels: {},
  };
  for (const [level, entry] of quizCache) {
    stats.levels[level] = {
      quizCount: entry.data.length,
      ageMinutes: Math.round((Date.now() - entry.timestamp) / 60000),
      sizeKB: Math.round(JSON.stringify(entry.data).length / 1024),
    };
  }
  return stats;
}

module.exports = { getQuizzesByLevel, invalidateLevel, invalidateAll, getCacheStats };
