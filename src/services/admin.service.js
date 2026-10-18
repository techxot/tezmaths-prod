const fs = require("fs");
const path = require("path");
const { db } = require("../config/firebase");

/**
 * Admin Service — User list with Local Disk and Firebase-backed persistent cache.
 *
 * Prevents bulk /users downloads (14.12 MB) on cold start:
 *   1. Local disk cache (.cache/admin-users.json) — 0 Firebase bandwidth
 *   2. Firebase _cache/adminUsers                — stripped cache
 *   3. Single-flight mutex (bootstrapPromise)    — prevents concurrent parallel downloads
 */

let cachedUsers = null;
let cacheTimestamp = 0;
let bootstrapPromise = null;

const CACHE_DIR = path.join(__dirname, "../../.cache");
const LOCAL_CACHE_PATH = path.join(CACHE_DIR, "admin-users.json");
const FIREBASE_CACHE_PATH = "_cache/adminUsers";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days persistent TTL

// Fields to keep per user — heavy nested data stripped
const ADMIN_FIELDS = [
  'id', 'username', 'fullName', 'email', 'phoneNumber',
  'xp', 'totalPoints', 'points', 'highScore', 'referrals', 'referralsSent',
  'currentLevel', 'highestCompletedLevelCompleted', 'completedLevels',
  'avatar', 'createdAt', 'lastActivity', 'isPremium', 'subscriptionStatus',
  'subscriptionPlan', 'subscriptionStartDate', 'subscriptionEndDate',
  'totalQuizzesPlayed', 'totalPracticeSessions', 'averageScore',
  'totalTimeSpent', 'streak', 'lastCompletionDate', 'isnewuser',
];

function stripUserToAdminFields(id, user) {
  let flat = user;
  if (user.profile || user.stats || user.progress || user.meta) {
    flat = {
      ...(user.profile || {}),
      ...(user.stats || {}),
      ...(user.progress || {}),
      ...(user.meta || {}),
    };
    if (user.contacts) flat.contacts = user.contacts;
  }
  const stripped = { id };
  for (const field of ADMIN_FIELDS) {
    if (field === 'id') continue;
    if (flat[field] !== undefined) stripped[field] = flat[field];
  }
  if (flat.contacts) {
    stripped.contacts = {
      permissionGranted: flat.contacts.permissionGranted || false,
      totalCount: flat.contacts.totalCount || 0,
    };
  }
  return stripped;
}

// ─── Local Disk Persistent Cache (0 Firebase bandwidth) ──────────────────────

function loadFromDiskCache() {
  try {
    if (fs.existsSync(LOCAL_CACHE_PATH)) {
      const raw = fs.readFileSync(LOCAL_CACHE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users) && parsed.users.length > 0) {
        cachedUsers = parsed.users;
        cacheTimestamp = parsed.timestamp || Date.now();
        console.log(`[admin.service] ✅ Loaded ${cachedUsers.length} users from LOCAL DISK cache — 0 Firebase reads!`);
        return true;
      }
    }
  } catch (err) {
    console.warn("[admin.service] Local disk cache load failed:", err.message);
  }
  return false;
}

function saveToDiskCache(users, timestamp) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(LOCAL_CACHE_PATH, JSON.stringify({ users, timestamp }));
    console.log(`[admin.service] 💾 Saved ${users.length} users to local disk cache`);
  } catch (err) {
    console.warn("[admin.service] Local disk cache save failed:", err.message);
  }
}

// ─── Firebase Persistent Cache ────────────────────────────────────────────────

async function loadFromFirebaseCache() {
  try {
    const snap = await db.ref(FIREBASE_CACHE_PATH).once("value");
    if (!snap.exists()) return false;
    const entry = snap.val();
    if (!entry || !Array.isArray(entry.users) || entry.users.length === 0) return false;
    cachedUsers = entry.users;
    cacheTimestamp = entry.timestamp || Date.now();
    saveToDiskCache(cachedUsers, cacheTimestamp);
    console.log(`[admin.service] ✅ Loaded ${cachedUsers.length} users from Firebase _cache/adminUsers`);
    return true;
  } catch (err) {
    console.warn("[admin.service] Firebase cache load failed:", err.message);
    return false;
  }
}

// ─── Bootstrap (Single-flight mutex protected) ────────────────────────────────

async function bootstrapUsersCache() {
  const now = Date.now();
  if (cachedUsers !== null && now - cacheTimestamp < CACHE_TTL_MS) return;

  // Single-flight mutex: ensure only ONE request fetches at a time
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    try {
      // Step 1: Try local disk cache first (0 Firebase network reads)
      if (loadFromDiskCache()) return;

      // Step 2: Try Firebase _cache/adminUsers
      const fromFb = await loadFromFirebaseCache();
      if (fromFb) return;

      // Step 3: Safeguard — NEVER auto-download 14MB /users table!
      console.warn("[admin.service] ⚠️ No cache found on disk or _cache/adminUsers. Skipping bulk /users download to prevent bandwidth spikes.");
      cachedUsers = cachedUsers || [];
      cacheTimestamp = Date.now();
    } finally {
      bootstrapPromise = null;
    }
  })();

  return bootstrapPromise;
}

// ─── Incremental Sync (Syncs only newly registered users — tiny ~10KB read) ──

let lastNewUsersCheck = 0;
const SYNC_INTERVAL_MS = 60 * 1000; // Check at most once per minute

async function syncNewUsers() {
  const now = Date.now();
  if (now - lastNewUsersCheck < SYNC_INTERVAL_MS) return;
  lastNewUsersCheck = now;

  try {
    // 1. Check live count from _counts node (<0.1 KB)
    const countSnap = await db.ref("_counts/users").once("value");
    const liveCount = countSnap.exists() ? (countSnap.val() || 0) : 0;
    const cachedCount = cachedUsers ? cachedUsers.length : 0;
    const diff = liveCount > cachedCount ? liveCount - cachedCount : 0;

    // Fetch exactly the count of new users (min 15, max 500 for safety)
    const fetchLimit = diff > 0 ? Math.min(Math.max(diff, 15), 500) : 15;

    const snap = await db.ref("users").limitToLast(fetchLimit).once("value");
    if (!snap.exists()) return;

    const rawData = snap.val();
    const existingIds = new Set((cachedUsers || []).map((u) => u.id));
    const newUsers = [];

    for (const [id, user] of Object.entries(rawData)) {
      if (!existingIds.has(id)) {
        const stripped = stripUserToAdminFields(id, user);
        if (stripped.email !== "tezmaths@admin.com") {
          newUsers.push(stripped);
        }
      }
    }

    if (newUsers.length > 0) {
      newUsers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      cachedUsers = [...newUsers, ...(cachedUsers || [])];
      cacheTimestamp = Date.now();
      saveToDiskCache(cachedUsers, cacheTimestamp);
      console.log(`[admin.service] 🔄 Synced ${newUsers.length} newly registered user(s) into cache (total: ${cachedUsers.length})`);
    }
  } catch (err) {
    console.warn("[admin.service] New users incremental sync error:", err.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getUsers({ page = 1, limit = 50, search = "" } = {}) {
  await bootstrapUsersCache();
  await syncNewUsers();

  let filtered = cachedUsers || [];
  if (search && search.trim()) {
    const q = search.toLowerCase().trim();
    filtered = filtered.filter(
      (u) =>
        (u.username && u.username.toLowerCase().includes(q)) ||
        (u.fullName && u.fullName.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.phoneNumber && u.phoneNumber.includes(search.trim()))
    );

    // Search fallback: if not in cache, check if username exists in Firebase index
    if (filtered.length === 0) {
      try {
        const usernameSnap = await db.ref(`usernames/${q}`).once("value");
        if (usernameSnap.exists()) {
          const uid = usernameSnap.val();
          const userSnap = await db.ref(`users/${uid}`).once("value");
          if (userSnap.exists()) {
            const singleUser = stripUserToAdminFields(uid, userSnap.val());
            cachedUsers = [singleUser, ...(cachedUsers || [])];
            saveToDiskCache(cachedUsers, cacheTimestamp);
            filtered = [singleUser];
          }
        }
      } catch (_) {}
    }
  }

  const total = filtered.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (safePage - 1) * limit;
  const users = filtered.slice(startIndex, startIndex + limit);
  const contactsOkCount = filtered.filter((u) => u.contacts?.permissionGranted).length;

  return { users, total, page: safePage, limit, totalPages, contactsOkCount };
}

async function invalidateCache() {
  cachedUsers = null;
  cacheTimestamp = 0;
  try {
    if (fs.existsSync(LOCAL_CACHE_PATH)) fs.unlinkSync(LOCAL_CACHE_PATH);
  } catch (_) {}
  console.log("[admin.service] In-memory & disk cache invalidated (Firebase cache preserved)");
}

// ─── Dashboard stats (Lightweight — Never downloads /users) ────────────────────

let cachedQuizCount = null;
let cachedVideoCount = null;
let contentCacheTimestamp = 0;
const CONTENT_CACHE_TTL = 12 * 60 * 60 * 1000;

async function getDashboardStats() {
  // If cachedUsers is already in memory or on disk, use it; otherwise DO NOT download 14MB!
  if (cachedUsers === null) {
    loadFromDiskCache();
  }

  let totalUsers = cachedUsers ? cachedUsers.length : 0;
  let totalReferrals = 0;
  let totalPoints = 0;

  if (cachedUsers && cachedUsers.length > 0) {
    cachedUsers.forEach((u) => {
      totalReferrals += u.referrals || 0;
      totalPoints += u.totalPoints || 0;
    });
  }

  const now = Date.now();
  if (cachedQuizCount === null || now - contentCacheTimestamp > CONTENT_CACHE_TTL) {
    try {
      const countsSnap = await db.ref("_counts").once("value");
      if (countsSnap.exists()) {
        const counts = countsSnap.val();
        cachedQuizCount = counts.quizzes || 0;
        cachedVideoCount = counts.videos || 0;
        if (counts.users) totalUsers = Math.max(totalUsers, counts.users);
      }
    } catch (err) {
      console.warn("[admin.service] Content count read failed:", err.message);
      cachedQuizCount = cachedQuizCount || 0;
      cachedVideoCount = cachedVideoCount || 0;
    }
    contentCacheTimestamp = now;
  }

  return {
    totalUsers: totalUsers || 0,
    totalReferrals,
    totalReferralPoints: totalReferrals * 10,
    totalQuizzes: cachedQuizCount || 0,
    totalVideos: cachedVideoCount || 0,
    totalPointsDistributed: totalPoints,
  };
}

async function getReferralStats() {
  await bootstrapUsersCache();

  let totalReferrals = 0;
  const referrers = [];
  const list = cachedUsers || [];
  list.forEach((u) => {
    const r = u.referrals || 0;
    totalReferrals += r;
    if (r > 0) referrers.push({ userId: u.id, username: u.username || "Unknown", fullName: u.fullName || u.username || "Unknown", referrals: r, points: r * 10 });
  });
  referrers.sort((a, b) => b.referrals - a.referrals);

  return {
    totalUsers: list.length,
    totalReferrals,
    totalReferralPoints: totalReferrals * 10,
    topReferrers: referrers.slice(0, 20),
  };
}

module.exports = { getUsers, invalidateCache, getDashboardStats, getReferralStats };
