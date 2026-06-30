const express = require("express");
const router = express.Router();
const { verifyFirebaseToken } = require("../middlewares/firebaseAuth.middleware");
const { migrateUsernameIndex, migrateFcmTokens } = require("../services/migration.service");

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

module.exports = router;
