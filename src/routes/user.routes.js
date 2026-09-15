const express = require("express");
const router = express.Router();
const { verifyFirebaseToken } = require("../middlewares/firebaseAuth.middleware");
const { getUserData, updateUserStats } = require("../services/user.service");

// ─── GET /api/user ────────────────────────────────────────────────────────────
// Returns the authenticated user's merged profile + stats + progress data.
router.get("/", verifyFirebaseToken, async (req, res) => {
  try {
    const mergedData = await getUserData(req.user.uid);
    return res.status(200).json({ user: mergedData });
  } catch (error) {
    console.error("[user] GET /api/user error:", error.message);
    return res.status(500).json({ error: { message: "Failed to read user data" } });
  }
});

// ─── PUT /api/user/stats ──────────────────────────────────────────────────────
// Writes the authenticated user's whitelisted stats fields to Firebase.
router.put("/stats", verifyFirebaseToken, async (req, res) => {
  try {
    const { totalPoints } = req.body;

    if (totalPoints !== undefined && totalPoints <= 0) {
      return res.status(400).json({ error: { message: "totalPoints must be greater than 0" } });
    }

    await updateUserStats(req.user.uid, req.body);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("[user] PUT /api/user/stats error:", error.message);
    return res.status(500).json({ error: { message: "Failed to write user data" } });
  }
});

module.exports = router;
