const express = require("express");
const router = express.Router();
const { verifyAdmin } = require("../middlewares/firebaseAuth.middleware");
const { getUsers, getDashboardStats, getReferralStats } = require("../services/admin.service");

// GET /api/admin/users — admin-only, paginated user list with optional search
router.get("/users", verifyAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 10000));
    const search = req.query.search || "";

    const result = await getUsers({ page, limit, search });
    return res.json(result);
  } catch (error) {
    console.error("Admin getUsers error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to fetch users" } });
  }
});

// GET /api/admin/stats — dashboard stats (totalUsers, referrals, quizzes, videos, points)
router.get("/stats", verifyAdmin, async (req, res) => {
  try {
    const stats = await getDashboardStats();
    return res.json(stats);
  } catch (error) {
    console.error("Admin stats error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to fetch stats" } });
  }
});

// GET /api/admin/referrals — referral rankings and totals
router.get("/referrals", verifyAdmin, async (req, res) => {
  try {
    const referrals = await getReferralStats();
    return res.json(referrals);
  } catch (error) {
    console.error("Admin referrals error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to fetch referral stats" } });
  }
});

module.exports = router;
