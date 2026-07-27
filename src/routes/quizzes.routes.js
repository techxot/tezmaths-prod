const express = require("express");
const router = express.Router();
const { verifyFirebaseToken, verifyAdmin } = require("../middlewares/firebaseAuth.middleware");
const { getQuizzesByLevel, invalidateLevel, invalidateAll, getCacheStats } = require("../services/quiz.service");

// ─── GET /api/quizzes/:level ─────────────────────────────────────────────────
// Public endpoint (authenticated users only) — serves cached quiz data
router.get("/:level", verifyFirebaseToken, async (req, res) => {
  try {
    const level = parseInt(req.params.level);
    if (isNaN(level) || level < 1 || level > 100) {
      return res.status(400).json({ error: { message: "Invalid level (must be 1-100)" } });
    }

    const quizzes = await getQuizzesByLevel(level);
    return res.json({ quizzes, level, count: quizzes.length });
  } catch (error) {
    console.error("[quizzes] GET /:level error:", error.message);
    return res.status(500).json({ error: { message: "Failed to fetch quizzes" } });
  }
});

// ─── POST /api/quizzes/invalidate/:level ─────────────────────────────────────
// Admin only — clears cache for a specific level after quiz update
router.post("/invalidate/:level", verifyAdmin, async (req, res) => {
  try {
    const level = parseInt(req.params.level);
    if (isNaN(level)) {
      return res.status(400).json({ error: { message: "Invalid level" } });
    }

    invalidateLevel(level);
    return res.json({ success: true, message: `Cache invalidated for level ${level}` });
  } catch (error) {
    console.error("[quizzes] POST /invalidate/:level error:", error.message);
    return res.status(500).json({ error: { message: "Failed to invalidate cache" } });
  }
});

// ─── POST /api/quizzes/invalidate-all ────────────────────────────────────────
// Admin only — clears all quiz cache (for bulk operations)
router.post("/invalidate-all", verifyAdmin, async (req, res) => {
  try {
    invalidateAll();
    return res.json({ success: true, message: "All quiz cache invalidated" });
  } catch (error) {
    console.error("[quizzes] POST /invalidate-all error:", error.message);
    return res.status(500).json({ error: { message: "Failed to invalidate cache" } });
  }
});

// ─── GET /api/quizzes/cache/stats ────────────────────────────────────────────
// Admin only — view cache status
router.get("/cache/stats", verifyAdmin, async (req, res) => {
  try {
    const stats = getCacheStats();
    return res.json(stats);
  } catch (error) {
    return res.status(500).json({ error: { message: "Failed to get cache stats" } });
  }
});

module.exports = router;
