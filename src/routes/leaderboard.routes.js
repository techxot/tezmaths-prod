const express = require("express");
const router = express.Router();
const { firebaseAuth } = require("../config/firebase");
const { getLeaderboard } = require("../services/leaderboard.service");

// GET /api/leaderboard — optionally authenticated
router.get("/", async (req, res) => {
  try {
    let userId = null;

    // Try to extract user from token if provided (not required)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split("Bearer ")[1];
        const decoded = await firebaseAuth.verifyIdToken(token);
        userId = decoded.uid;
      } catch (_) {
        // Token invalid — proceed without user context
      }
    }

    const result = await getLeaderboard(userId);
    return res.json(result);
  } catch (error) {
    console.error("Leaderboard error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to fetch leaderboard" } });
  }
});

module.exports = router;
