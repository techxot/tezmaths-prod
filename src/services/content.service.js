const { db } = require("../config/firebase");

/**
 * Content Cache Service — Server-side proxy for static content data.
 *
 * Caches Firebase data indefinitely (no TTL). Only refreshes on:
 * 1. First request (cache empty)
 * 2. Admin explicitly invalidates via API
 *
 * This eliminates direct Firebase reads from the app for:
 * practiceTopics, practiceQuestions, quizLevels, videos, studyWall, appConfig
 */

// In-memory caches
const practiceTopicsCache = { data: null };
const practiceQuestionsCache = new Map(); // keyed by topicId
const quizLevelsCache = { data: null };
const videosCache = { data: null };
const studyWallCache = { data: null };
const appConfigCache = { data: null };

// ─── Practice Topics ──────────────────────────────────────────────────────────

async function getPracticeTopics() {
  if (practiceTopicsCache.data !== null) {
    return practiceTopicsCache.data;
  }

  const snapshot = await db.ref("practiceTopics").once("value");
  const data = snapshot.exists() ? snapshot.val() : [];

  practiceTopicsCache.data = data;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Practice topics cache loaded: ${count} topics`);

  return data;
}

// ─── Practice Questions (per topicId) ─────────────────────────────────────────

async function getPracticeQuestions(topicId) {
  const cached = practiceQuestionsCache.get(topicId);
  if (cached !== undefined) {
    return cached;
  }

  const snapshot = await db.ref(`practiceQuestions/${topicId}`).once("value");
  const data = snapshot.exists() ? snapshot.val() : [];

  practiceQuestionsCache.set(topicId, data);
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Practice questions cache loaded for topic ${topicId}: ${count} questions`);

  return data;
}

// ─── Quiz Levels ──────────────────────────────────────────────────────────────

async function getQuizLevels() {
  if (quizLevelsCache.data !== null) {
    return quizLevelsCache.data;
  }

  const snapshot = await db.ref("quizLevels").once("value");
  const data = snapshot.exists() ? snapshot.val() : [];

  quizLevelsCache.data = data;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Quiz levels cache loaded: ${count} levels`);

  return data;
}

// ─── Videos ───────────────────────────────────────────────────────────────────

async function getVideos() {
  if (videosCache.data !== null) {
    return videosCache.data;
  }

  const snapshot = await db.ref("videos").once("value");
  const data = snapshot.exists() ? snapshot.val() : [];

  videosCache.data = data;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Videos cache loaded: ${count} videos`);

  return data;
}

// ─── Study Wall ───────────────────────────────────────────────────────────────

async function getStudyWall() {
  if (studyWallCache.data !== null) {
    return studyWallCache.data;
  }

  const snapshot = await db.ref("studyWall").once("value");
  const data = snapshot.exists() ? snapshot.val() : [];

  studyWallCache.data = data;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`[content.service] Study wall cache loaded: ${count} items`);

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

// ─── App Config (combined settings) ───────────────────────────────────────────

async function getAppConfig() {
  if (appConfigCache.data !== null) {
    return appConfigCache.data;
  }

  // Fetch all config nodes in parallel
  const [adSettingsSnap, subscriptionPricingSnap, practiceTimerSnap, practiceLevelSnap] = await Promise.all([
    db.ref("adSettings").once("value"),
    db.ref("subscriptionPricing").once("value"),
    db.ref("practiceTimerDurations").once("value"),
    db.ref("practiceLevelSettings").once("value"),
  ]);

  const data = {
    adSettings: adSettingsSnap.exists() ? adSettingsSnap.val() : {},
    subscriptionPricing: subscriptionPricingSnap.exists() ? subscriptionPricingSnap.val() : {},
    practiceTimerDurations: practiceTimerSnap.exists() ? practiceTimerSnap.val() : {},
    practiceLevelSettings: practiceLevelSnap.exists() ? practiceLevelSnap.val() : {},
  };

  appConfigCache.data = data;
  console.log(`[content.service] App config cache loaded: adSettings, subscriptionPricing, practiceTimerDurations, practiceLevelSettings`);

  return data;
}

// ─── Cache Invalidation ───────────────────────────────────────────────────────

/**
 * Invalidate a specific cache by key.
 * For practiceQuestions, pass topicId to clear a specific topic, or omit to clear all.
 */
function invalidate(cacheKey, topicId) {
  switch (cacheKey) {
    case "practiceTopics":
      practiceTopicsCache.data = null;
      console.log(`[content.service] Cache invalidated: practiceTopics`);
      break;
    case "practiceQuestions":
      if (topicId) {
        practiceQuestionsCache.delete(topicId);
        console.log(`[content.service] Cache invalidated: practiceQuestions/${topicId}`);
      } else {
        practiceQuestionsCache.clear();
        console.log(`[content.service] Cache invalidated: all practiceQuestions`);
      }
      break;
    case "quizLevels":
      quizLevelsCache.data = null;
      console.log(`[content.service] Cache invalidated: quizLevels`);
      break;
    case "videos":
      videosCache.data = null;
      console.log(`[content.service] Cache invalidated: videos`);
      break;
    case "studyWall":
      studyWallCache.data = null;
      console.log(`[content.service] Cache invalidated: studyWall`);
      break;
    case "studyTopics":
      studyTopicsCache.data = null;
      console.log(`[content.service] Cache invalidated: studyTopics`);
      break;
    case "appConfig":
      appConfigCache.data = null;
      console.log(`[content.service] Cache invalidated: appConfig`);
      break;
    default:
      console.log(`[content.service] Unknown cache key: ${cacheKey}`);
      return false;
  }
  return true;
}

/**
 * Invalidate all caches.
 */
function invalidateAll() {
  practiceTopicsCache.data = null;
  practiceQuestionsCache.clear();
  quizLevelsCache.data = null;
  videosCache.data = null;
  studyWallCache.data = null;
  studyTopicsCache.data = null;
  appConfigCache.data = null;
  console.log(`[content.service] All content caches invalidated`);
}

module.exports = {
  getPracticeTopics,
  getPracticeQuestions,
  getQuizLevels,
  getVideos,
  getStudyWall,
  getStudyTopics,
  getAppConfig,
  invalidate,
  invalidateAll,
};
