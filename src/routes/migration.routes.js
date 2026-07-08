const express = require("express");
const router = express.Router();
const { verifyFirebaseToken } = require("../middlewares/firebaseAuth.middleware");
const { migrateUsernameIndex, migrateFcmTokens, migrateQuizLevels } = require("../services/migration.service");

// ─── POST /api/migrate/usernames ─────────────────────────────────────────────
router.post("/usernames", verifyFirebaseToken, async (req, res) => {
  try {
    const result = await migrateUsernameIndex();
    return res.json({ result });
  } catch (error) {
    console.error("Username migration error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to migrate usernames" } });
  }
});

// ─── POST /api/migrate/fcm-tokens ────────────────────────────────────────────
router.post("/fcm-tokens", verifyFirebaseToken, async (req, res) => {
  try {
    const result = await migrateFcmTokens();
    return res.json({ result });
  } catch (error) {
    console.error("FCM token migration error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to migrate FCM tokens" } });
  }
});

// ─── POST /api/migrate/quiz-levels ────────────────────────────────────────────
router.post("/quiz-levels", verifyFirebaseToken, async (req, res) => {
  try {
    const result = await migrateQuizLevels();
    return res.json({ result });
  } catch (error) {
    console.error("Quiz levels migration error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to migrate quiz levels" } });
  }
});

module.exports = router;
