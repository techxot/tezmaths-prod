/**
 * One-time script to run the username migration.
 * Run with: node run-migration.js
 * 
 * This bypasses the HTTP endpoint and runs the migration directly.
 * Safe to run multiple times — it just overwrites with the same data.
 */
require("dotenv").config();
const { migrateUsernameIndex, migrateFcmTokens } = require("./src/services/migration.service");

async function main() {
  console.log("Starting username migration...");
  try {
    const result = await migrateUsernameIndex();
    console.log("✅ Username migration complete:", result);
  } catch (error) {
    console.error("❌ Username migration failed:", error.message);
  }

  console.log("\nStarting FCM token migration...");
  try {
    const result = await migrateFcmTokens();
    console.log("✅ FCM token migration complete:", result);
  } catch (error) {
    console.error("❌ FCM token migration failed:", error.message);
  }

  // Give Firebase time to flush writes, then exit
  setTimeout(() => process.exit(0), 3000);
}

main();
