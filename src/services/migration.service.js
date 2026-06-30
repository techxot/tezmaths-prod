const { db } = require("../config/firebase");

/**
 * Populates the `usernames/{normalized}` index from existing user data.
 * Reads all users, builds a map of lowercased usernames to user IDs,
 * and writes via a single multi-path update for atomicity.
 *
 * @returns {{ migrated: number }} - Count of usernames indexed
 */
async function migrateUsernameIndex() {
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

  // Only remove fcmTokens node if ALL tokens are verified present in users
  if (allPresent) {
    await db.ref("fcmTokens").remove();
  }

  return { totalTokens, copiedCount, removed: allPresent };
}

module.exports = { migrateUsernameIndex, migrateFcmTokens };
