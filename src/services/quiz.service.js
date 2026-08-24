const { db } = require("../config/firebase");

/**
 * Quiz Cache Service — Server-side proxy for quiz data.
 *
 * Railway has an ephemeral filesystem so disk cache is useless across deploys.
 * Instead we use Firebase itself as the persistent cache store under _cache/quizzes/{level}.
 *
 * Read flow per level:
 *   1. In-memory map        — 0 Firebase reads (process lifetime)
 *   2. _cache/quizzes/{level} — ~400KB read from cache node (survives deploys)
 *   3. /quizzes/{level}     — ~400KB read from real data (first ever or after invalidation)
 *      └─ writes result back to _cache/quizzes/{level}
 *
 * Firebase reads per level: 1 ever (until invalidated by admin)
 */

const quizCache = new Map(); // in-memory: level → { data, timestamp }
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Firebase persistent cache helpers ───────────────────────────────────────

async function loadFromFirebaseCache(level) {
  try {
    const snap = await db.ref(`_cache/quizzes/${level}`).once("value");
    if (!snap.exists()) return null;
    const entry = snap.val();
    if (!entry || !Array.isArray(entry.data) || entry.data.length === 0) return null;
    if (Date.now() - entry.timestamp >= CACHE_TTL_MS) return null; // expired
    return entry;
  } catch {
    return null;
  }
}

async function saveToFirebaseCache(level, data, timestamp) {
  try {
    await db.ref(`_cache/quizzes/${level}`).set({ data, timestamp });
  } catch (err) {
    console.warn(`[quiz.service] Firebase cache write failed for level ${level}:`, err.message);
  }
}

async function deleteFromFirebaseCache(level) {
  try {
    await db.ref(`_cache/quizzes/${level}`).remove();
  } catch (_) {}
}

// ─── Warm in-memory cache from Firebase cache node on startup ─────────────────
// Runs once at module init — loads all cached levels into memory so the first
// request per level is served from memory, not Firebase.
let warmupPromise = null;

function warmupCache() {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    try {
      const snap = await db.ref("_cache/quizzes").once("value");
      if (!snap.exists()) return;
      const now = Date.now();
      let loaded = 0;
      snap.forEach((child) => {
        const entry = child.val();
        if (entry && Array.isArray(entry.data) && entry.data.length > 0 && now - entry.timestamp < CACHE_TTL_MS) {
          quizCache.set(Number(child.key), { data: entry.data, timestamp: entry.timestamp });
          loaded++;
        }
      });
      if (loaded > 0) console.log(`[quiz.service] ✅ Warmed ${loaded} levels from _cache/quizzes — 0 /quizzes reads needed`);
    } catch (err) {
      console.warn("[quiz.service] Cache warmup failed:", err.message);
    }
  })();
  return warmupPromise;
}

// Kick off warmup immediately on module load
warmupCache();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get quizzes for a specific level.
 * Memory → Firebase cache node → real /quizzes/{level} node (last resort).
 */
async function getQuizzesByLevel(level) {
  await warmupCache(); // ensure warmup has run before first use

  const now = Date.now();
  const cached = quizCache.get(level);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[quiz.service] ⚡ Level ${level} → MEMORY CACHE`);
    return cached.data;
  }

  // L2: Firebase cache node — survives Railway deploys
  const fbCached = await loadFromFirebaseCache(level);
  if (fbCached) {
    quizCache.set(level, fbCached);
    console.log(`[quiz.service] ✅ Level ${level} loaded from _cache/quizzes — 0 /quizzes reads`);
    return fbCached.data;
  }

  // L3: Real Firebase data — only on first ever request or after invalidation
  console.log(`[quiz.service] Cache miss level ${level} — fetching /quizzes/${level}`);
  const snapshot = await db.ref(`quizzes/${level}`).once("value");

  if (!snapshot.exists()) {
    const empty = { data: [], timestamp: now };
    quizCache.set(level, empty);
    return [];
  }

  const quizzes = [];
  snapshot.forEach((child) => {
    quizzes.push({ id: child.key, level, ...child.val() });
  });

  quizCache.set(level, { data: quizzes, timestamp: now });
  await saveToFirebaseCache(level, quizzes, now); // persist for next deploy
  console.log(`[quiz.service] ✅ Level ${level} cached: ${quizzes.length} quizzes, ~${Math.round(JSON.stringify(quizzes).length / 1024)} KB`);

  return quizzes;
}

/**
 * Invalidate cache for a specific level (called when admin updates quizzes).
 */
async function invalidateLevel(level) {
  quizCache.delete(level);
  await deleteFromFirebaseCache(level);
  console.log(`[quiz.service] Cache invalidated for level ${level}`);
}

/**
 * Invalidate all quiz cache (called when admin does bulk operations).
 */
async function invalidateAll() {
  quizCache.clear();
  try {
    await db.ref("_cache/quizzes").remove();
  } catch (_) {}
  console.log("[quiz.service] All quiz cache invalidated");
}

/**
 * Get cache stats for monitoring.
 */
function getCacheStats() {
  const stats = { cachedLevels: quizCache.size, levels: {} };
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
