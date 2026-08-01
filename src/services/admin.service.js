const { db } = require("../config/firebase");

/**
 * Admin Service — User list with Firebase-backed persistent cache.
 *
 * Railway has an ephemeral filesystem — disk cache is wiped on every deploy.
 * We use Firebase _cache/adminUsers to persist the stripped user list across deploys.
 *
 * Read flow:
 *   1. In-memory (cachedUsers array)         — 0 Firebase reads (process lifetime)
 *   2. _cache/adminUsers                     — ~250KB read (survives Railway deploys)
 *   3. Full /users download                  — 18MB (first ever deploy only)
 *      └─ writes stripped result to _cache/adminUsers
 *
 * While running: child_changed/added/removed listeners on /users keep cache current.
 * Each user change = ~5KB incremental update, not 18MB re-download.
 */

let cachedUsers = null;
let cacheTimestamp = 0;
let userListener = null;

const FIREBASE_CACHE_PATH = "_cache/adminUsers";

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

// ─── Firebase persistent cache ────────────────────────────────────────────────

async function loadFromFirebaseCache() {
  try {
    const snap = await db.ref(FIREBASE_CACHE_PATH).once("value");
    if (!snap.exists()) return false;
    const entry = snap.val();
    if (!entry || !Array.isArray(entry.users) || entry.users.length === 0) return false;
    cachedUsers = entry.users;
    cacheTimestamp = entry.timestamp || Date.now();
    const sizeKB = Math.round(JSON.stringify(cachedUsers).length / 1024);
    console.log(`[admin.service] ✅ Loaded ${cachedUsers.length} users from _cache/adminUsers (~${sizeKB} KB) — 0 /users reads`);
    return true;
  } catch (err) {
    console.warn("[admin.service] Firebase cache load failed:", err.message);
    return false;
  }
}

// Debounced Firebase cache save — avoid hammering on rapid consecutive updates
let fbSaveTimer = null;
function scheduleFirebaseSave() {
  if (fbSaveTimer) clearTimeout(fbSaveTimer);
  fbSaveTimer = setTimeout(async () => {
    fbSaveTimer = null;
    try {
      await db.ref(FIREBASE_CACHE_PATH).set({
        users: cachedUsers,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn("[admin.service] Firebase cache save failed:", err.message);
    }
  }, 5000); // batch updates, write 5s after last change
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrapUsersCache() {
  if (cachedUsers !== null) return; // already loaded

  // L1: Try Firebase cache node first (survives Railway deploys)
  const fromCache = await loadFromFirebaseCache();

  if (!fromCache) {
    // Cold start — full /users download, one-time cost
    console.log("[admin.service] 🔄 Cold start — downloading full /users node (one-time)...");
    const start = Date.now();
    const snapshot = await db.ref("users").once("value");
    const elapsed = Date.now() - start;

    if (snapshot.exists()) {
      const data = snapshot.val();
      const rawMB = (JSON.stringify(data).length / (1024 * 1024)).toFixed(2);
      cachedUsers = Object.entries(data)
        .map(([id, u]) => stripUserToAdminFields(id, u))
        .filter((u) => u.email !== "tezmaths@admin.com")
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      cacheTimestamp = Date.now();
      const strippedKB = Math.round(JSON.stringify(cachedUsers).length / 1024);
      console.log(`[admin.service] ⚠️  Downloaded ${rawMB} MB in ${elapsed}ms → stripped to ${strippedKB} KB, saving to _cache/adminUsers`);
      // Save immediately (not debounced) so next deploy doesn't re-download
      await db.ref(FIREBASE_CACHE_PATH).set({ users: cachedUsers, timestamp: cacheTimestamp });
    } else {
      cachedUsers = [];
    }
  }

  // Attach incremental listener to keep cache current
  attachIncrementalListener();
}

function attachIncrementalListener() {
  if (userListener) return;

  const usersRef = db.ref("users");

  const onChildChanged = usersRef.on("child_changed", (snap) => {
    if (!cachedUsers) return;
    const uid = snap.key;
    const updated = stripUserToAdminFields(uid, snap.val() || {});
    if (updated.email === "tezmaths@admin.com") return;
    const idx = cachedUsers.findIndex((u) => u.id === uid);
    if (idx >= 0) cachedUsers[idx] = updated;
    scheduleFirebaseSave();
  });

  const onChildAdded = usersRef.on("child_added", (snap) => {
    if (!cachedUsers) return;
    const uid = snap.key;
    if (cachedUsers.some((u) => u.id === uid)) return; // skip existing on initial attach
    const stripped = stripUserToAdminFields(uid, snap.val() || {});
    if (stripped.email === "tezmaths@admin.com") return;
    cachedUsers.unshift(stripped);
    scheduleFirebaseSave();
  });

  const onChildRemoved = usersRef.on("child_removed", (snap) => {
    if (!cachedUsers) return;
    cachedUsers = cachedUsers.filter((u) => u.id !== snap.key);
    scheduleFirebaseSave();
  });

  userListener = { usersRef, onChildChanged, onChildAdded, onChildRemoved };
  console.log("[admin.service] ✅ Incremental user listener attached");
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getUsers({ page = 1, limit = 50, search = "" } = {}) {
  await bootstrapUsersCache();

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

  const total = filtered.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (safePage - 1) * limit;
  const users = filtered.slice(startIndex, startIndex + limit);
  const contactsOkCount = cachedUsers.filter((u) => u.contacts?.permissionGranted).length;

  return { users, total, page: safePage, limit, totalPages, contactsOkCount };
}

async function invalidateCache() {
  cachedUsers = null;
  cacheTimestamp = 0;
  if (userListener) {
    userListener.usersRef.off("child_changed", userListener.onChildChanged);
    userListener.usersRef.off("child_added", userListener.onChildAdded);
    userListener.usersRef.off("child_removed", userListener.onChildRemoved);
    userListener = null;
  }
  try { await db.ref(FIREBASE_CACHE_PATH).remove(); } catch (_) {}
  console.log("[admin.service] Cache invalidated");
}

// ─── Dashboard stats ──────────────────────────────────────────────────────────

let cachedQuizCount = null;
let cachedVideoCount = null;
let contentCacheTimestamp = 0;
const CONTENT_CACHE_TTL = 12 * 60 * 60 * 1000;

async function getDashboardStats() {
  await bootstrapUsersCache();

  let totalReferrals = 0;
  let totalPoints = 0;
  cachedUsers.forEach((u) => {
    totalReferrals += u.referrals || 0;
    totalPoints += u.totalPoints || 0;
  });

  const now = Date.now();
  if (cachedQuizCount === null || now - contentCacheTimestamp > CONTENT_CACHE_TTL) {
    try {
      const countsSnap = await db.ref("_counts").once("value");
      if (countsSnap.exists()) {
        const counts = countsSnap.val();
        cachedQuizCount = counts.quizzes || 0;
        cachedVideoCount = counts.videos || 0;
      } else {
        // Use shallow=true to get only keys — avoids downloading full 9MB /quizzes node
        const databaseURL = process.env.FIREBASE_DATABASE_URL;
        const [quizzesRes, videosRes] = await Promise.all([
          fetch(`${databaseURL}/quizzes.json?shallow=true`),
          fetch(`${databaseURL}/videos.json?shallow=true`),
        ]);
        const quizzesKeys = await quizzesRes.json();
        const videosKeys = await videosRes.json();
        cachedQuizCount = quizzesKeys ? Object.keys(quizzesKeys).length : 0;
        cachedVideoCount = videosKeys ? Object.keys(videosKeys).length : 0;
        await db.ref("_counts").set({ quizzes: cachedQuizCount, videos: cachedVideoCount });
      }
    } catch (err) {
      console.warn("[admin.service] Content count read failed:", err.message);
      cachedQuizCount = cachedQuizCount || 0;
      cachedVideoCount = cachedVideoCount || 0;
    }
    contentCacheTimestamp = now;
  }

  return {
    totalUsers: cachedUsers.length,
    totalReferrals,
    totalReferralPoints: totalReferrals * 10,
    totalQuizzes: cachedQuizCount,
    totalVideos: cachedVideoCount,
    totalPointsDistributed: totalPoints,
  };
}

async function getReferralStats() {
  await bootstrapUsersCache();

  let totalReferrals = 0;
  const referrers = [];
  cachedUsers.forEach((u) => {
    const r = u.referrals || 0;
    totalReferrals += r;
    if (r > 0) referrers.push({ userId: u.id, username: u.username || "Unknown", fullName: u.fullName || u.username || "Unknown", referrals: r, points: r * 10 });
  });
  referrers.sort((a, b) => b.referrals - a.referrals);

  return {
    totalUsers: cachedUsers.length,
    totalReferrals,
    totalReferralPoints: totalReferrals * 10,
    topReferrers: referrers.slice(0, 20),
  };
}

module.exports = { getUsers, invalidateCache, getDashboardStats, getReferralStats };
