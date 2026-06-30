const { db } = require("../config/firebase");

let cachedUsers = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

module.exports = { getUsers, invalidateCache };
