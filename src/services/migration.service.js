const { db } = require("../config/firebase");

/**
 * Populates the `usernames/{normalized}` index from existing user data.
 * GUARDED: Checks if migration already ran before downloading all users.
 * Reads all users, builds a map of lowercased usernames to user IDs,
 * and writes via a single multi-path update for atomicity.
 *
 * @returns {{ migrated: number }} - Count of usernames indexed
 */
async function migrateUsernameIndex() {
  // Guard: Check if migration already ran by checking if usernames node exists
  const existingSnap = await db.ref("usernames").limitToFirst(1).once("value");
  if (existingSnap.exists()) {
    console.log("[Migration] usernames index already exists. Skipping. Use force=true to re-run.");
    return { migrated: 0, skipped: true };
  }

  const snapshot = await db.ref("users").once("value");
  if (!snapshot.exists()) return { migrated: 0 };

  const updates = {};
  let count = 0;

  snapshot.forEach((child) => {
    const user = child.val();
    if (user.username) {
      const normalized = user.username.toLowerCase();
      updates[`usernames/${normalized}`] = child.key;
      count++;
    }
  });

  if (count > 0) {
    await db.ref().update(updates);
  }

  return { migrated: count };
}

/**
 * Migrates FCM tokens from the legacy `fcmTokens/{userId}` node to `users/{userId}/fcmToken`.
 *
 * Steps:
 * 1. Reads both `users` and `fcmTokens` nodes in parallel
 * 2. Verifies all tokens in `fcmTokens/` exist in `users/{userId}/fcmToken`
 * 3. Copies missing tokens to the `users` node
 * 4. Removes the `fcmTokens` node ONLY after all tokens are confirmed present
 *
 * @returns {{ totalTokens: number, copiedCount: number, removed: boolean }}
 */
async function migrateFcmTokens() {
  const [usersSnap, tokensSnap] = await Promise.all([
    db.ref("users").once("value"),
    db.ref("fcmTokens").once("value"),
  ]);

  const users = usersSnap.val() || {};
  const tokens = tokensSnap.val() || {};

  const tokenEntries = Object.entries(tokens);
  const totalTokens = tokenEntries.length;

  if (totalTokens === 0) {
    return { totalTokens: 0, copiedCount: 0, removed: false };
  }

  // Identify tokens missing from users node and copy them
  let copiedCount = 0;
  for (const [userId, token] of tokenEntries) {
    if (!users[userId]?.fcmToken) {
      await db.ref(`users/${userId}/fcmToken`).set(token);
      copiedCount++;
    }
  }

  // Re-verify all tokens are now present before removing the legacy node
  // Re-read users node to confirm copies were successful
  const verifySnap = await db.ref("users").once("value");
  const verifiedUsers = verifySnap.val() || {};

  let allPresent = true;
  for (const [userId, token] of tokenEntries) {
    if (!verifiedUsers[userId]?.fcmToken) {
      allPresent = false;
      break;
    }
  }

  // DISABLED: Do NOT remove fcmTokens node — it's now the primary source for notifications.service.js
  // The old migration logic that deleted /fcmTokens is no longer valid.
  // if (allPresent) {
  //   await db.ref("fcmTokens").remove();
  // }

  return { totalTokens, copiedCount, removed: false, message: "fcmTokens removal disabled — node is now used by notifications service" };
}

/**
 * Populates the `quizLevels` node from existing quiz data.
 * Reads the `quizzes` node, extracts all unique level numbers,
 * and writes a lightweight map: `quizLevels/{level}: true`.
 *
 * This allows clients to fetch available levels (~100 bytes)
 * without downloading the entire quizzes node (~2MB).
 *
 * @returns {{ levels: number[], count: number }}
 */
async function migrateQuizLevels() {
  const snapshot = await db.ref("quizzes").once("value");
  if (!snapshot.exists()) return { levels: [], count: 0 };

  const levelsSet = new Set();

  snapshot.forEach((child) => {
    const quiz = child.val();
    if (quiz && quiz.level) {
      levelsSet.add(Number(quiz.level));
    }
  });

  const levels = Array.from(levelsSet).sort((a, b) => a - b);

  if (levels.length > 0) {
    const updates = {};
    for (const level of levels) {
      updates[`quizLevels/${level}`] = true;
    }
    await db.ref().update(updates);
  }

  return { levels, count: levels.length };
}

module.exports = { migrateUsernameIndex, migrateFcmTokens, migrateQuizLevels };
