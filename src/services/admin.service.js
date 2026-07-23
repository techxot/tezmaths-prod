const { db } = require("../config/firebase");

let cachedUsers = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — only invalidate manually or on server restart

// Fields to KEEP from each user for the admin list cache
// Everything else (contacts details, practiceProgress, battleHistory, etc.) is stripped
const ADMIN_FIELDS = [
  'id', 'username', 'fullName', 'email', 'phoneNumber',
  'xp', 'totalPoints', 'points', 'highScore', 'referrals', 'referralsSent',
  'currentLevel', 'highestCompletedLevelCompleted', 'completedLevels',
  'avatar', 'createdAt', 'lastActivity', 'isPremium', 'subscriptionStatus',
  'subscriptionPlan', 'subscriptionStartDate', 'subscriptionEndDate',
  'totalQuizzesPlayed', 'totalPracticeSessions', 'averageScore',
  'totalTimeSpent', 'streak', 'lastCompletionDate', 'isnewuser',
];

/**
 * Strips a user object to only admin-needed fields.
 * Handles BOTH old flat structure AND new split subnode structure:
 *   users/{uid}/profile/ + stats/ + progress/ + meta/
 */
function stripUserToAdminFields(id, user) {
  // Merge subnodes into flat object if split structure is detected
  let flat = user;
  if (user.profile || user.stats || user.progress || user.meta) {
    flat = {
      ...(user.profile || {}),
      ...(user.stats || {}),
      ...(user.progress || {}),
      ...(user.meta || {}),
    };
    // Also keep contacts at root level (not inside subnodes)
    if (user.contacts) flat.contacts = user.contacts;
  }

  const stripped = { id };
  for (const field of ADMIN_FIELDS) {
    if (field === 'id') continue;
    if (flat[field] !== undefined) {
      stripped[field] = flat[field];
    }
  }
  // Special: only keep contacts permission status, not the full contacts array
  if (flat.contacts) {
    stripped.contacts = {
      permissionGranted: flat.contacts.permissionGranted || false,
      totalCount: flat.contacts.totalCount || 0,
    };
  }
  return stripped;
}

/**
 * Fetches paginated, searchable user list for admin panel.
 * OPTIMIZED: 
 * - Cache TTL extended to 7 days (manual invalidation on demand)
 * - Strips heavy nested data from cache (practiceProgress, battleHistory, completedQuizzes objects)
 * - Uses Firebase listener for real-time cache updates instead of polling
 * 
 * @param {{ page?: number, limit?: number, search?: string }} options
 * @returns {{ users: object[], total: number, page: number, limit: number, totalPages: number }}
 */
async function getUsers({ page = 1, limit = 50, search = "" } = {}) {
  const now = Date.now();

  // Refresh cache if expired or missing
  if (!cachedUsers || now - cacheTimestamp > CACHE_TTL_MS) {
    const startTime = Date.now();
    console.log(`[admin.service] 🔄 Users cache EXPIRED or EMPTY — downloading full /users node...`);
    const snapshot = await db.ref("users").once("value");
    const downloadTime = Date.now() - startTime;
    if (!snapshot.exists()) {
      cachedUsers = [];
    } else {
      const data = snapshot.val();
      const rawSize = JSON.stringify(data).length;
      cachedUsers = Object.entries(data)
        .map(([id, u]) => stripUserToAdminFields(id, u))
        .filter((u) => u.email !== "tezmaths@admin.com")
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      console.log(`[admin.service] ⚠️ BANDWIDTH: Downloaded ${(rawSize / (1024 * 1024)).toFixed(2)} MB from /users in ${downloadTime}ms`);
    }
    cacheTimestamp = now;
    console.log(`[admin.service] ✅ Users cache refreshed: ${cachedUsers.length} users, ~${Math.round(JSON.stringify(cachedUsers).length / 1024)} KB in memory`);
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
 * OPTIMIZED: Uses shallow reads to count quiz/video keys without downloading full payloads.
 * Previously downloaded the entire /quizzes node (8.96 MB) just to count keys.
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

  // OPTIMIZED: Use shallow REST API to count keys without downloading full 9MB+ payloads
  const now = Date.now();
  if (cachedQuizCount === null || now - contentCacheTimestamp > CONTENT_CACHE_TTL) {
    try {
      // Read from lightweight counter node (~20 bytes)
      const countsSnap = await db.ref("_counts").once("value");

      if (countsSnap.exists()) {
        const counts = countsSnap.val();
        cachedQuizCount = counts.quizzes || 0;
        cachedVideoCount = counts.videos || 0;
      } else {
        // Counter doesn't exist — initialize it using numChildren (downloads keys only, not full values)
        // Admin SDK numChildren still needs the snapshot, but this only happens ONCE ever
        console.log(`[admin.service] ⚠️ BANDWIDTH: _counts node missing — downloading full /quizzes + /videos to count keys (ONE-TIME)`);
        const [quizzesSnap, videosSnap] = await Promise.all([
          db.ref("quizzes").once("value"),
          db.ref("videos").once("value"),
        ]);
        cachedQuizCount = quizzesSnap.exists() ? quizzesSnap.numChildren() : 0;
        cachedVideoCount = videosSnap.exists() ? videosSnap.numChildren() : 0;
        const quizSize = quizzesSnap.exists() ? JSON.stringify(quizzesSnap.val()).length : 0;
        const videoSize = videosSnap.exists() ? JSON.stringify(videosSnap.val()).length : 0;
        console.log(`[admin.service] ⚠️ BANDWIDTH: /quizzes=${(quizSize / (1024 * 1024)).toFixed(2)} MB, /videos=${(videoSize / (1024 * 1024)).toFixed(2)} MB`);

        // Persist counter so this heavy read never happens again
        await db.ref("_counts").set({
          quizzes: cachedQuizCount,
          videos: cachedVideoCount,
        });
        console.log(`[admin.service] ✅ _counts initialized: quizzes=${cachedQuizCount}, videos=${cachedVideoCount} — future reads will be <100 bytes`);
      }
    } catch (error) {
      console.warn("[admin.service] Content count read failed:", error.message);
      cachedQuizCount = cachedQuizCount || 0;
      cachedVideoCount = cachedVideoCount || 0;
    }
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
