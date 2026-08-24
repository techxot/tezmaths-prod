const { db } = require("../config/firebase");

/**
 * Content Cache Service — Server-side proxy for static content data.
 *
 * Railway has an ephemeral filesystem so disk cache is useless across deploys.
 * We use Firebase _cache/content/* to persist data across deploys.
 *
 * Read flow per cache key:
 *   1. In-memory        — 0 Firebase reads (process lifetime)
 *   2. _cache/content/X — reads persisted cache (~KB, survives deploys)
 *   3. Real source node — reads actual data (first ever or after invalidation)
 *      └─ writes result back to _cache/content/X
 *
 * Firebase reads per key: 1 ever (until admin invalidates)
 */

// ─── In-memory caches ─────────────────────────────────────────────────────────
const practiceTopicsCache = { data: null };
const practiceQuestionsCache = new Map(); // keyed by topicId
const quizLevelsCache = { data: null };
const videosCache = { data: null };
const studyWallCache = { data: null };
const appConfigCache = { data: null };
const studyTopicsCache = { data: null };
const studyContentsCache = new Map(); // keyed by topicId

// ─── Firebase persistent cache helpers ───────────────────────────────────────

async function loadFromFbCache(key) {
  try {
    const snap = await db.ref(`_cache/content/${key}`).once("value");
    if (!snap.exists()) return null;
    const entry = snap.val();
    if (!entry || entry.data === undefined || entry.data === null) return null;
    return entry.data;
  } catch {
    return null;
  }
}

async function saveToFbCache(key, data) {
  try {
    await db.ref(`_cache/content/${key}`).set({ data, savedAt: Date.now() });
  } catch (err) {
    console.warn(`[content.service] Firebase cache write failed for ${key}:`, err.message);
  }
}

async function deleteFromFbCache(key) {
  try {
    await db.ref(`_cache/content/${key}`).remove();
  } catch (_) {}
}

// ─── Warmup on startup ────────────────────────────────────────────────────────
// Load all cached content into memory on first module require so the first
// user request per endpoint is served from memory, not Firebase.
let warmupDone = false;
let warmupPromise = null;

function warmup() {
  if (warmupDone || warmupPromise) return warmupPromise || Promise.resolve();
  warmupPromise = (async () => {
    try {
      const snap = await db.ref("_cache/content").once("value");
      if (!snap.exists()) return;
      const cached = snap.val();

      if (cached.practiceTopics?.data !== undefined) {
        practiceTopicsCache.data = cached.practiceTopics.data;
        console.log(`[content.service] ✅ practiceTopics warmed from _cache`);
      }
      if (cached.quizLevels?.data !== undefined) {
        quizLevelsCache.data = cached.quizLevels.data;
        console.log(`[content.service] ✅ quizLevels warmed from _cache`);
      }
      if (cached.videos?.data !== undefined) {
        videosCache.data = cached.videos.data;
        console.log(`[content.service] ✅ videos warmed from _cache`);
      }
      if (cached.studyWall?.data !== undefined) {
        studyWallCache.data = cached.studyWall.data;
        console.log(`[content.service] ✅ studyWall warmed from _cache`);
      }
      if (cached.appConfig?.data !== undefined) {
        appConfigCache.data = cached.appConfig.data;
        console.log(`[content.service] ✅ appConfig warmed from _cache`);
      }
      if (cached.studyTopics?.data !== undefined) {
        studyTopicsCache.data = cached.studyTopics.data;
        console.log(`[content.service] ✅ studyTopics warmed from _cache`);
      }
      // studyContents are per-topicId — load all cached topics
      if (cached.studyContents) {
        for (const [topicId, entry] of Object.entries(cached.studyContents)) {
          if (entry && entry.data !== undefined) {
            studyContentsCache.set(topicId, entry.data);
          }
        }
        console.log(`[content.service] ✅ studyContents warmed: ${studyContentsCache.size} topics`);
      }
      // practiceQuestions are per-topicId — load all cached topics
      if (cached.practiceQuestions) {
        for (const [topicId, entry] of Object.entries(cached.practiceQuestions)) {
          if (entry && entry.data !== undefined) {
            practiceQuestionsCache.set(topicId, entry.data);
          }
        }
        console.log(`[content.service] ✅ practiceQuestions warmed: ${practiceQuestionsCache.size} topics`);
      }
    } catch (err) {
      console.warn("[content.service] Warmup failed:", err.message);
    } finally {
      warmupDone = true;
    }
  })();
  return warmupPromise;
}

// Kick off warmup immediately on module load
warmup();

// ─── Practice Topics ──────────────────────────────────────────────────────────

async function getPracticeTopics() {
  await warmup();
  if (practiceTopicsCache.data !== null) return practiceTopicsCache.data;

  // L2: Firebase cache node
  const fbData = await loadFromFbCache("practiceTopics");
  if (fbData !== null) {
    practiceTopicsCache.data = fbData;
    console.log(`[content.service] ✅ practiceTopics loaded from _cache`);
    return fbData;
  }

  // L3: Real source
  const snapshot = await db.ref("practiceTopics").once("value");
  const data = snapshot.exists() ? snapshot.val() : [];
  practiceTopicsCache.data = data;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Practice topics cache loaded: ${count} topics`);
  await saveToFbCache("practiceTopics", data);
  return data;
}

// ─── Practice Questions (per topicId) ─────────────────────────────────────────

async function getPracticeQuestions(topicId) {
  await warmup();
  if (practiceQuestionsCache.has(topicId)) return practiceQuestionsCache.get(topicId);

  // L2: Firebase cache node
  const fbData = await loadFromFbCache(`practiceQuestions/${topicId}`);
  if (fbData !== null) {
    practiceQuestionsCache.set(topicId, fbData);
    console.log(`[content.service] ✅ practiceQuestions/${topicId} loaded from _cache`);
    return fbData;
  }

  // L3: Real source
  const snapshot = await db.ref(`practiceQuestions/${topicId}`).once("value");
  const data = snapshot.exists() ? snapshot.val() : [];
  practiceQuestionsCache.set(topicId, data);
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Practice questions cache loaded for topic ${topicId}: ${count} questions`);
  await saveToFbCache(`practiceQuestions/${topicId}`, data);
  return data;
}

// ─── Quiz Levels ──────────────────────────────────────────────────────────────

async function getQuizLevels() {
  await warmup();
  if (quizLevelsCache.data !== null) return quizLevelsCache.data;

  const fbData = await loadFromFbCache("quizLevels");
  if (fbData !== null) {
    quizLevelsCache.data = fbData;
    console.log(`[content.service] ✅ quizLevels loaded from _cache`);
    return fbData;
  }

  const snapshot = await db.ref("quizLevels").once("value");
  const data = snapshot.exists() ? snapshot.val() : [];
  quizLevelsCache.data = data;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Quiz levels cache loaded: ${count} levels`);
  await saveToFbCache("quizLevels", data);
  return data;
}

// ─── Videos ───────────────────────────────────────────────────────────────────

async function getVideos() {
  await warmup();
  if (videosCache.data !== null) return videosCache.data;

  const fbData = await loadFromFbCache("videos");
  if (fbData !== null) {
    videosCache.data = fbData;
    console.log(`[content.service] ✅ videos loaded from _cache`);
    return fbData;
  }

  const snapshot = await db.ref("videos").once("value");
  const data = snapshot.exists() ? snapshot.val() : [];
  videosCache.data = data;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Videos cache loaded: ${count} videos`);
  await saveToFbCache("videos", data);
  return data;
}

// ─── Study Wall ───────────────────────────────────────────────────────────────

async function getStudyWall() {
  await warmup();
  if (studyWallCache.data !== null) return studyWallCache.data;

  const fbData = await loadFromFbCache("studyWall");
  if (fbData !== null) {
    studyWallCache.data = fbData;
    console.log(`[content.service] ✅ studyWall loaded from _cache`);
    return fbData;
  }

  const snapshot = await db.ref("studyWall").once("value");
  const data = snapshot.exists() ? snapshot.val() : [];
  studyWallCache.data = data;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Study wall cache loaded: ${count} items`);
  await saveToFbCache("studyWall", data);
  return data;
}

// ─── Study Topics ─────────────────────────────────────────────────────────────

const studyTopicsCache = { data: null };

async function getStudyTopics() {
  if (studyTopicsCache.data !== null) {
    return studyTopicsCache.data;
  }

  const snapshot = await db.ref("studyTopics").once("value");
  const data = snapshot.exists() ? snapshot.val() : [];

  studyTopicsCache.data = data;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Study topics cache loaded: ${count} topics`);

  return data;
}

// ─── Study Content (per topicId) ──────────────────────────────────────────────

const studyContentsCache = new Map(); // keyed by topicId

async function getStudyContent(topicId) {
  const cached = studyContentsCache.get(topicId);
  if (cached !== undefined) {
    return cached;
  }

  // Data is nested: studyContents/{topicId}/{contentId}
  const snapshot = await db.ref(`studyContents/${topicId}`).once("value");
  const data = snapshot.exists() ? snapshot.val() : null;

  studyContentsCache.set(topicId, data);
  const count = data ? Object.keys(data).length : 0;
  console.log(`[content.service] Study content cache loaded for topic ${topicId}: ${count} items`);

  return data;
}

// ─── App Config (combined settings) ───────────────────────────────────────────

async function getAppConfig() {
  await warmup();
  if (appConfigCache.data !== null) return appConfigCache.data;

  const fbData = await loadFromFbCache("appConfig");
  if (fbData !== null) {
    appConfigCache.data = fbData;
    console.log(`[content.service] ✅ appConfig loaded from _cache`);
    return fbData;
  }

  const [adSettingsSnap, subscriptionPricingSnap, practiceTimerSnap, practiceLevelSnap, featureLocksSnap] = await Promise.all([
    db.ref("adSettings").once("value"),
    db.ref("subscriptionPricing").once("value"),
    db.ref("practiceTimerDurations").once("value"),
    db.ref("practiceLevelSettings").once("value"),
    db.ref("featureLocks").once("value"),
  ]);

  const data = {
    adSettings: adSettingsSnap.exists() ? adSettingsSnap.val() : {},
    subscriptionPricing: subscriptionPricingSnap.exists() ? subscriptionPricingSnap.val() : {},
    practiceTimerDurations: practiceTimerSnap.exists() ? practiceTimerSnap.val() : {},
    practiceLevelSettings: practiceLevelSnap.exists() ? practiceLevelSnap.val() : {},
    featureLocks: featureLocksSnap.exists() ? featureLocksSnap.val() : {},
  };

  appConfigCache.data = data;
  console.log(`[content.service] App config cache loaded: adSettings, subscriptionPricing, practiceTimerDurations, practiceLevelSettings`);
  await saveToFbCache("appConfig", data);
  return data;
}

// ─── Study Topics ─────────────────────────────────────────────────────────────

async function getStudyTopics() {
  await warmup();
  if (studyTopicsCache.data !== null) return studyTopicsCache.data;

  const fbData = await loadFromFbCache("studyTopics");
  if (fbData !== null) {
    studyTopicsCache.data = fbData;
    console.log(`[content.service] ✅ studyTopics loaded from _cache`);
    return fbData;
  }

  const snapshot = await db.ref("studyTopics").once("value");
  const data = snapshot.exists() ? snapshot.val() : {};
  studyTopicsCache.data = data;
  const count = typeof data === "object" ? Object.keys(data).length : 0;
  console.log(`[content.service] Study topics cache loaded: ${count} topics`);
  await saveToFbCache("studyTopics", data);
  return data;
}

// ─── Study Contents (per topicId) ─────────────────────────────────────────────

async function getStudyContent(topicId) {
  await warmup();
  if (studyContentsCache.has(topicId)) return studyContentsCache.get(topicId);

  const fbData = await loadFromFbCache(`studyContents/${topicId}`);
  if (fbData !== null) {
    studyContentsCache.set(topicId, fbData);
    console.log(`[content.service] ✅ studyContents/${topicId} loaded from _cache`);
    return fbData;
  }

  const snapshot = await db.ref(`studyContents/${topicId}`).once("value");
  const data = snapshot.exists() ? snapshot.val() : {};
  studyContentsCache.set(topicId, data);
  const count = typeof data === "object" ? Object.keys(data).length : 0;
  console.log(`[content.service] Study contents cache loaded for topic ${topicId}: ${count} items`);
  await saveToFbCache(`studyContents/${topicId}`, data);
  return data;
}

// ─── Cache Invalidation ───────────────────────────────────────────────────────

async function invalidate(cacheKey, topicId) {
  switch (cacheKey) {
    case "practiceTopics":
      practiceTopicsCache.data = null;
      await deleteFromFbCache("practiceTopics");
      console.log(`[content.service] Cache invalidated: practiceTopics`);
      break;
    case "practiceQuestions":
      if (topicId) {
        practiceQuestionsCache.delete(topicId);
        await deleteFromFbCache(`practiceQuestions/${topicId}`);
        console.log(`[content.service] Cache invalidated: practiceQuestions/${topicId}`);
      } else {
        practiceQuestionsCache.clear();
        await deleteFromFbCache("practiceQuestions");
        console.log(`[content.service] Cache invalidated: all practiceQuestions`);
      }
      break;
    case "quizLevels":
      quizLevelsCache.data = null;
      await deleteFromFbCache("quizLevels");
      console.log(`[content.service] Cache invalidated: quizLevels`);
      break;
    case "videos":
      videosCache.data = null;
      await deleteFromFbCache("videos");
      console.log(`[content.service] Cache invalidated: videos`);
      break;
    case "studyWall":
      studyWallCache.data = null;
      await deleteFromFbCache("studyWall");
      console.log(`[content.service] Cache invalidated: studyWall`);
      break;
    case "studyTopics":
      studyTopicsCache.data = null;
      console.log(`[content.service] Cache invalidated: studyTopics`);
      break;
    case "studyContents":
      studyContentsCache.clear();
      console.log(`[content.service] Cache invalidated: studyContents`);
      break;
    case "appConfig":
      appConfigCache.data = null;
      await deleteFromFbCache("appConfig");
      console.log(`[content.service] Cache invalidated: appConfig`);
      break;
    default:
      console.log(`[content.service] Unknown cache key: ${cacheKey}`);
      return false;
  }
  return true;
}

async function invalidateAll() {
  practiceTopicsCache.data = null;
  practiceQuestionsCache.clear();
  quizLevelsCache.data = null;
  videosCache.data = null;
  studyWallCache.data = null;
  studyTopicsCache.data = null;
  studyContentsCache.clear();
  appConfigCache.data = null;
  try { await db.ref("_cache/content").remove(); } catch (_) {}
  console.log(`[content.service] All content caches invalidated`);
}

module.exports = {
  getPracticeTopics,
  getPracticeQuestions,
  getQuizLevels,
  getVideos,
  getStudyWall,
  getStudyTopics,
  getStudyContent,
  getAppConfig,
  invalidate,
  invalidateAll,
};
