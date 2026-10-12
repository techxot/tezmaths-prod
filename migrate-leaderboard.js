require("dotenv").config();
const { db } = require("./src/config/firebase");

/**
 * One-time migration script to populate the /leaderboard node from /users.
 * Run with: node migrate-leaderboard.js
 *
 * This creates a lightweight /leaderboard/{userId} entry for each user
 * containing only the fields needed for ranking: username, fullName, highScore, highScoreTime.
 */
async function migrateLeaderboard() {
  console.log("Migrating leaderboard data from /users to /leaderboard...");

  const snapshot = await db.ref("users").once("value");
  if (!snapshot.exists()) {
    console.log("No users found. Nothing to migrate.");
    process.exit(0);
  }

  const users = snapshot.val();
  const updates = {};
  let count = 0;
  let skipped = 0;

  for (const [userId, user] of Object.entries(users)) {
    if (!user || typeof user !== "object") continue;

    const email = (user.profile?.email || user.email || "").toLowerCase().trim();
    const rawUsername = (user.profile?.username || user.username || "").trim();
    const rawFullName = (user.profile?.fullName || user.fullName || "").trim();

    // Skip admin accounts
    if (email === "tezmaths@admin.com" || rawUsername.toLowerCase() === "admin") {
      skipped++;
      continue;
    }

    // Skip users with no name data at all
    if (!rawUsername && !rawFullName) {
      skipped++;
      continue;
    }

    const rawScore = user.stats?.highScore !== undefined ? user.stats.highScore : user.highScore;
    const highScore = typeof rawScore === "number" && !isNaN(rawScore) ? Math.max(0, rawScore) : 0;

    const rawTime = user.stats?.highScoreTime !== undefined ? user.stats.highScoreTime : user.highScoreTime;
    const highScoreTime = typeof rawTime === "number" && !isNaN(rawTime) ? Math.max(0, rawTime) : 0;

    updates[`leaderboard/${userId}`] = {
      username: rawUsername || "Unknown",
      fullName: rawFullName || "Unknown",
      highScore,
      highScoreTime,
    };
    count++;
  }

  if (Object.keys(updates).length > 0) {
    const entries = Object.entries(updates);
    const BATCH_SIZE = 250;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const chunk = Object.fromEntries(entries.slice(i, i + BATCH_SIZE));
      await db.ref().update(chunk);
    }
  }

  console.log(`✅ Migrated ${count} users to /leaderboard node`);
  console.log(`   Skipped: ${skipped} (admin or incomplete accounts)`);
  process.exit(0);
}

migrateLeaderboard().catch((e) => {
  console.error("❌ Migration failed:", e.message);
  process.exit(1);
});
