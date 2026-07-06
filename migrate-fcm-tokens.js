/**
 * One-time migration: Populate /fcmTokens/{userId} flat index from /users/{userId}/fcmToken.
 * Run with: node migrate-fcm-tokens.js
 */
require("dotenv").config();
const { db } = require("./src/config/firebase");

async function migrateFcmTokens() {
    console.log("Migrating FCM tokens to /fcmTokens index...");

    const snapshot = await db.ref("users").once("value");
    if (!snapshot.exists()) { console.log("No users found"); process.exit(0); }

    const users = snapshot.val();
    const updates = {};
    let count = 0;

    for (const [userId, user] of Object.entries(users)) {
        if (user.fcmToken) {
            updates[`fcmTokens/${userId}`] = user.fcmToken;
            count++;
        }
    }

    if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);
    }

    console.log(`✅ Migrated ${count} FCM tokens to /fcmTokens index`);
    process.exit(0);
}

migrateFcmTokens().catch((e) => { console.error(e); process.exit(1); });
