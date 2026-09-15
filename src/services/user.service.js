const { db } = require("../config/firebase");

/**
 * User Data Service — Server-side reads/writes for authenticated user data.
 *
 * Routes user profile/stats/progress reads through Railway instead of direct
 * client-to-Firebase reads, reducing Firebase download bandwidth.
 */

// ─── Read merged user data ────────────────────────────────────────────────────

/**
 * Reads users/{uid}/profile, users/{uid}/stats, and users/{uid}/progress in
 * parallel and returns them merged into a single flat object.
 *
 * Any missing subnode is treated as an empty object so the remaining subnodes
 * still merge cleanly.
 *
 * @param {string} uid - Authenticated user id.
 * @returns {Promise<Object>} Merged { ...profile, ...stats, ...progress }.
 */
async function getUserData(uid) {
  const [profileSnap, statsSnap, progressSnap] = await Promise.all([
    db.ref(`users/${uid}/profile`).once("value"),
    db.ref(`users/${uid}/stats`).once("value"),
    db.ref(`users/${uid}/progress`).once("value"),
  ]);

  const profile = profileSnap.exists() ? profileSnap.val() : {};
  const stats = statsSnap.exists() ? statsSnap.val() : {};
  const progress = progressSnap.exists() ? progressSnap.val() : {};

  return { ...profile, ...stats, ...progress };
}

// ─── Stats field whitelist ────────────────────────────────────────────────────

/**
 * The only stats fields that may be written to users/{uid}/stats.
 */
const STATS_FIELDS = [
  "totalPoints",
  "highScore",
  "currentLevel",
  "streak",
  "completedLevels",
];

/**
 * Returns a new object containing only the allowed Stats_Fields keys that are
 * present on the input, discarding every other key. Keys that do not exist on
 * the input are not added to the result.
 *
 * @param {Object} input - Arbitrary object (e.g. a request body).
 * @returns {Object} A new object with only whitelisted, present keys.
 */
function filterStatsFields(input) {
  const source = input || {};
  const result = {};

  for (const key of STATS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key];
    }
  }

  return result;
}

// ─── Write user stats ─────────────────────────────────────────────────────────

/**
 * Filters the provided fields to the allowed Stats_Fields whitelist and writes
 * them to users/{uid}/stats using an update (merge) write.
 *
 * @param {string} uid - Authenticated user id.
 * @param {Object} fields - Candidate stats fields to write.
 * @returns {Promise<void>}
 */
async function updateUserStats(uid, fields) {
  const filtered = filterStatsFields(fields);
  await db.ref(`users/${uid}/stats`).update(filtered);
}

module.exports = {
  getUserData,
  updateUserStats,
  filterStatsFields,
};
