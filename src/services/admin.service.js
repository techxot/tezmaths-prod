const { db } = require("../config/firebase");

let cachedUsers = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (1 day)

/**
 * Fetches paginated, searchable user list for admin panel.
 * @param {{ page?: number, limit?: number, search?: string }} options
 * @returns {{ users: object[], total: number, page: number, limit: number, totalPages: number }}
 */
async function getUsers({ page = 1, limit = 50, search = "" } = {}) {
  const now = Date.now();

  // Refresh cache if expired or missing
  if (!cachedUsers || now - cacheTimestamp > CACHE_TTL_MS) {
    const snapshot = await db.ref("users").once("value");
    if (!snapshot.exists()) {
      cachedUsers = [];
    } else {
      const data = snapshot.val();
      cachedUsers = Object.entries(data)
        .map(([id, u]) => ({ id, ...u }))
        .filter((u) => u.email !== "tezmaths@admin.com")
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    cacheTimestamp = now;
  }

  // Apply search filter
  let filtered = cachedUsers;
  if (search && search.trim()) {
    const q = search.toLowerCase().trim();
    filtered = cachedUsers.filter(
      (u) =>
        (u.username && u.username.toLowerCase().includes(q)) ||
        (u.fullName && u.fullName.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.phoneNumber && u.phoneNumber.includes(search.trim()))
    );
  }

  // Paginate
  const total = filtered.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (safePage - 1) * limit;
  const users = filtered.slice(startIndex, startIndex + limit);

  // Global stats (across all users, not just current page)
  const contactsOkCount = cachedUsers.filter((u) => u.contacts?.permissionGranted).length;

  return { users, total, page: safePage, limit, totalPages, contactsOkCount };
}

function invalidateCache() {
  cachedUsers = null;
  cacheTimestamp = 0;
}

/**
 * Returns dashboard stats derived from the cached users (no extra Firebase read).
 */
let cachedQuizCount = null;
let cachedVideoCount = null;
let contentCacheTimestamp = 0;
const CONTENT_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

async function getDashboardStats() {
  // Ensure cache is populated
  await getUsers({ page: 1, limit: 1 });

  let totalUsers = cachedUsers.length;
  let totalReferrals = 0;
  let totalPoints = 0;

  cachedUsers.forEach((u) => {
    totalReferrals += u.referrals || 0;
    totalPoints += u.totalPoints || 0;
  });

  // Cache quiz/video counts — avoid downloading full nodes every call
  const now = Date.now();
  if (cachedQuizCount === null || now - contentCacheTimestamp > CONTENT_CACHE_TTL) {
    const [quizzesSnap, videosSnap] = await Promise.all([
      db.ref("quizzes").once("value"),
      db.ref("videos").once("value"),
    ]);
    cachedQuizCount = quizzesSnap.exists() ? Object.keys(quizzesSnap.val()).length : 0;
    cachedVideoCount = videosSnap.exists() ? Object.keys(videosSnap.val()).length : 0;
    contentCacheTimestamp = now;
  }

  return {
    totalUsers,
    totalReferrals,
    totalReferralPoints: totalReferrals * 10,
    totalQuizzes: cachedQuizCount,
    totalVideos: cachedVideoCount,
    totalPointsDistributed: totalPoints,
  };
}

/**
 * Returns referral rankings derived from cached users.
 */
async function getReferralStats() {
  // Ensure cache is populated
  await getUsers({ page: 1, limit: 1 });

  let totalUsers = cachedUsers.length;
  let totalReferrals = 0;
  const referrers = [];

  cachedUsers.forEach((u) => {
    const r = u.referrals || 0;
    totalReferrals += r;
    if (r > 0) {
      referrers.push({
        userId: u.id,
        username: u.username || "Unknown",
        fullName: u.fullName || u.username || "Unknown",
        referrals: r,
        points: r * 10,
      });
    }
  });

  // Sort by referrals descending, take top 20
  referrers.sort((a, b) => b.referrals - a.referrals);
  const topReferrers = referrers.slice(0, 20);

  return {
    totalUsers,
    totalReferrals,
    totalReferralPoints: totalReferrals * 10,
    topReferrers,
  };
}

module.exports = { getUsers, invalidateCache, getDashboardStats, getReferralStats };
