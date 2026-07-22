/**
 * One-time migration: Split flat users/{uid} into subnodes:
 *   users/{uid}/profile/
 *   users/{uid}/stats/
 *   users/{uid}/progress/
 *   users/{uid}/meta/
 *   paymentHistory/{uid}/ (moved from users/{uid}/payments)
 *
 * Run with: node migrate-user-nodes.js
 *
 * Uses the same Firebase credentials from .env as the backend server.
 */
require("dotenv").config();
const admin = require("firebase-admin");

// ─── Initialize using same .env vars as the backend ───────────────────────────
const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_DATABASE_URL } = process.env;

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_DATABASE_URL) {
  console.error("ERROR: Missing Firebase credentials in .env");
  console.error("Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_DATABASE_URL");
  process.exit(1);
}

const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

if (!privateKey.includes("BEGIN PRIVATE KEY")) {
  console.error("ERROR: FIREBASE_PRIVATE_KEY is malformed — missing 'BEGIN PRIVATE KEY'");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL: FIREBASE_DATABASE_URL,
  });
}

const db = admin.database();

// ─── Field mapping ────────────────────────────────────────────────────────────

const PROFILE_FIELDS = [
  "username", "fullName", "avatar", "email", "phoneNumber",
  "photoURL", "providerId", "createdAt",
];

const STATS_FIELDS = [
  "totalPoints", "highScore", "highScoreTime", "streak", "currentLevel",
  "highestCompletedLevelCompleted", "referrals", "referralsSent", "xp",
  "lastPlayedDate", "lastPlayedLevel",
];

const PROGRESS_FIELDS = [
  "completedLevels", "completedQuizzes", "lastCompletionDate", "practiceProgress",
];

const META_FIELDS = [
  "isnewuser", "lastActivity",
];

// ─── Migration logic ──────────────────────────────────────────────────────────

function categorizeField(key) {
  if (PROFILE_FIELDS.includes(key)) return "profile";
  if (STATS_FIELDS.includes(key)) return "stats";
  if (PROGRESS_FIELDS.includes(key)) return "progress";
  if (META_FIELDS.includes(key)) return "meta";
  return null; // unknown field — will be placed in profile as fallback
}

async function migrateUsers() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  USER NODE SPLIT MIGRATION");
  console.log("  Target: tezmaths-staging");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const snapshot = await db.ref("users").once("value");
  if (!snapshot.exists()) {
    console.log("No users found. Exiting.");
    process.exit(0);
  }

  const users = snapshot.val();
  const userIds = Object.keys(users);
  console.log(`Found ${userIds.length} users to migrate.\n`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches of 50 to avoid overwhelming the database
  const BATCH_SIZE = 50;

  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);
    const updates = {};

    for (const uid of batch) {
      const userData = users[uid];

      // Skip if already migrated (has profile subnode as an object)
      if (userData.profile && typeof userData.profile === "object" && userData.profile.username) {
        skipped++;
        continue;
      }

      const profile = {};
      const stats = {};
      const progress = {};
      const meta = {};

      for (const [key, value] of Object.entries(userData)) {
        if (key === "payments") continue; // handled separately
        if (key === "fcmToken") continue; // already migrated to /fcmTokens
        if (key === "contacts") continue; // leave as-is (admin feature)

        const category = categorizeField(key);
        switch (category) {
          case "profile": profile[key] = value; break;
          case "stats": stats[key] = value; break;
          case "progress": progress[key] = value; break;
          case "meta": meta[key] = value; break;
          default:
            // Unknown fields go to profile as a safe fallback
            profile[key] = value;
            break;
        }
      }

      // Build multi-path update for this user
      updates[`users/${uid}/profile`] = profile;
      updates[`users/${uid}/stats`] = stats;
      updates[`users/${uid}/progress`] = progress;
      updates[`users/${uid}/meta`] = meta;

      // Move payments to paymentHistory/{uid}
      if (userData.payments) {
        updates[`paymentHistory/${uid}`] = userData.payments;
        updates[`users/${uid}/payments`] = null; // delete from user node
      }

      // Remove old flat fields (set them to null)
      const allFieldsToRemove = [
        ...PROFILE_FIELDS, ...STATS_FIELDS, ...PROGRESS_FIELDS, ...META_FIELDS,
        "levelsScores", // legacy field
      ];
      for (const field of allFieldsToRemove) {
        if (userData[field] !== undefined) {
          updates[`users/${uid}/${field}`] = null;
        }
      }

      migrated++;
    }

    // Execute batch update atomically
    if (Object.keys(updates).length > 0) {
      try {
        await db.ref().update(updates);
        console.log(`  ✓ Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} users processed`);
      } catch (err) {
        console.error(`  ✗ Batch ${Math.floor(i / BATCH_SIZE) + 1} FAILED:`, err.message);
        errors += batch.length;
        migrated -= batch.length;
      }
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  MIGRATION COMPLETE`);
  console.log(`  ✓ Migrated: ${migrated}`);
  console.log(`  → Skipped (already migrated): ${skipped}`);
  console.log(`  ✗ Errors: ${errors}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  process.exit(errors > 0 ? 1 : 0);
}

migrateUsers().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
