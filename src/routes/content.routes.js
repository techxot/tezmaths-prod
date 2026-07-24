const express = require("express");
const router = express.Router();
const { verifyFirebaseToken, verifyAdmin } = require("../middlewares/firebaseAuth.middleware");
const {
  getPracticeTopics,
  getPracticeQuestions,
  getQuizLevels,
  getVideos,
  getStudyWall,
  getAppConfig,
  invalidate,
  invalidateAll,
} = require("../services/content.service");

// ─── GET /api/content/practice-topics ─────────────────────────────────────────
router.get("/practice-topics", verifyFirebaseToken, async (req, res) => {
  try {
    const data = await getPracticeTopics();
    return res.json({ practiceTopics: data });
  } catch (error) {
    console.error("[content] GET /practice-topics error:", error.message);
    return res.status(500).json({ error: { message: "Failed to fetch practice topics" } });
  }
});

// ─── GET /api/content/practice-questions/:topicId ─────────────────────────────
router.get("/practice-questions/:topicId", verifyFirebaseToken, async (req, res) => {
  try {
    const { topicId } = req.params;
    if (!topicId) {
      return res.status(400).json({ error: { message: "topicId is required" } });
    }

    const data = await getPracticeQuestions(topicId);
    return res.json({ practiceQuestions: data, topicId });
  } catch (error) {
    console.error("[content] GET /practice-questions/:topicId error:", error.message);
    return res.status(500).json({ error: { message: "Failed to fetch practice questions" } });
  }
});

// ─── GET /api/content/quiz-levels ─────────────────────────────────────────────
router.get("/quiz-levels", verifyFirebaseToken, async (req, res) => {
  try {
    const data = await getQuizLevels();
    return res.json({ quizLevels: data });
  } catch (error) {
    console.error("[content] GET /quiz-levels error:", error.message);
    return res.status(500).json({ error: { message: "Failed to fetch quiz levels" } });
  }
});

// ─── GET /api/content/videos ──────────────────────────────────────────────────
router.get("/videos", verifyFirebaseToken, async (req, res) => {
  try {
    const data = await getVideos();
    return res.json({ videos: data });
  } catch (error) {
    console.error("[content] GET /videos error:", error.message);
    return res.status(500).json({ error: { message: "Failed to fetch videos" } });
  }
});

// ─── GET /api/content/study-wall ──────────────────────────────────────────────
router.get("/study-wall", verifyFirebaseToken, async (req, res) => {
  try {
    const data = await getStudyWall();
    return res.json({ studyWall: data });
  } catch (error) {
    console.error("[content] GET /study-wall error:", error.message);
    return res.status(500).json({ error: { message: "Failed to fetch study wall" } });
  }
});

// ─── GET /api/content/app-config ──────────────────────────────────────────────
router.get("/app-config", verifyFirebaseToken, async (req, res) => {
  try {
    const data = await getAppConfig();
    return res.json({ appConfig: data });
  } catch (error) {
    console.error("[content] GET /app-config error:", error.message);
    return res.status(500).json({ error: { message: "Failed to fetch app config" } });
  }
});

// ─── POST /api/content/invalidate/:cacheKey ───────────────────────────────────
// Admin only — invalidates specific cache
// For practiceQuestions, optionally pass ?topicId=xxx to invalidate a specific topic
router.post("/invalidate/:cacheKey", verifyAdmin, async (req, res) => {
  try {
    const { cacheKey } = req.params;
    const { topicId } = req.query;

    const validKeys = ["practiceTopics", "practiceQuestions", "quizLevels", "videos", "studyWall", "appConfig"];
    if (!validKeys.includes(cacheKey)) {
      return res.status(400).json({ error: { message: `Invalid cacheKey. Must be one of: ${validKeys.join(", ")}` } });
    }

    const success = invalidate(cacheKey, topicId);
    if (success) {
      const detail = cacheKey === "practiceQuestions" && topicId ? `${cacheKey}/${topicId}` : cacheKey;
      return res.json({ success: true, message: `Cache invalidated: ${detail}` });
    }
    return res.status(400).json({ error: { message: "Failed to invalidate cache" } });
  } catch (error) {
    console.error("[content] POST /invalidate/:cacheKey error:", error.message);
    return res.status(500).json({ error: { message: "Failed to invalidate cache" } });
  }
});

// ─── POST /api/content/invalidate-all ─────────────────────────────────────────
// Admin only — invalidates all content caches
router.post("/invalidate-all", verifyAdmin, async (req, res) => {
  try {
    invalidateAll();
    return res.json({ success: true, message: "All content caches invalidated" });
  } catch (error) {
    console.error("[content] POST /invalidate-all error:", error.message);
    return res.status(500).json({ error: { message: "Failed to invalidate all caches" } });
  }
});

module.exports = router;
