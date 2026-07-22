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
    // Skip admin accounts
    if (user.email === "tezmaths@admin.com") {
      skipped++;
      continue;
    }
    if ((user.username || "").toLowerCase() === "admin") {
      skipped++;
      continue;
    }
    // Skip users with no name data at all
    if (!user.username && !user.fullName) {
      skipped++;
      continue;
    }

    updates[`leaderboard/${userId}`] = {
      username: user.username || "Unknown",
      fullName: user.fullName || "Unknown",
      highScore: user.highScore || user.totalPoints || 0,
      highScoreTime: user.highScoreTime || 0,
    };
    count++;
  }

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  console.log(`✅ Migrated ${count} users to /leaderboard node`);
  console.log(`   Skipped: ${skipped} (admin or incomplete accounts)`);
  process.exit(0);
}

migrateLeaderboard().catch((e) => {
  console.error("❌ Migration failed:", e.message);
  process.exit(1);
});
