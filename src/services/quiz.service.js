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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get quizzes for a specific level.
 * Memory (0 Firebase reads) → _cache/quizzes/{level} (~30KB) → /quizzes/{level} (fallback ~30KB).
 * Lazy loaded on-demand: NEVER downloads all levels in bulk.
 */
async function getQuizzesByLevel(level) {

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
 * Get random lightweight questions for battles.
 * Gathers questions from levels 1-10, picks `count` randomly, and returns
 * ONLY the fields needed for the battle UI (~15 KB instead of 2.5 MB).
 */
async function getBattleQuestions(count = 25) {
  const pool = [];
  for (let lvl = 1; lvl <= 10; lvl++) {
    const quizzes = await getQuizzesByLevel(lvl);
    if (Array.isArray(quizzes)) {
      for (const qz of quizzes) {
        if (Array.isArray(qz.questions)) {
          for (const q of qz.questions) {
            const questionText = q.questionText || q.question;
            const correctAnswer = q.correctAnswer !== undefined ? String(q.correctAnswer) : "";
            if (questionText && correctAnswer) {
              pool.push({
                question: questionText,
                questionText: questionText,
                correctAnswer: correctAnswer,
                options: q.options || [],
                timeLimit: 15,
                points: 4,
                explanation: q.explanation || "",
                level: lvl,
              });
            }
          }
        }
      }
    }
  }

  // Shuffle pool (Fisher-Yates)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, count);
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

module.exports = { getQuizzesByLevel, getBattleQuestions, invalidateLevel, invalidateAll, getCacheStats };
