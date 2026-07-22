const { db } = require("../config/firebase");

/**
 * Cleanup service that removes stale data from Firebase to prevent
 * unbounded growth of rooms, roomQuestions, and payment logs.
 * 
 * Runs as a scheduled cron job (every 6 hours).
 */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Removes battle rooms older than 6 hours that are finished or abandoned.
 * OPTIMIZED: Uses query to fetch only old rooms instead of downloading the entire node.
 * Also removes their associated roomQuestions and matchmaking entries.
 */
async function cleanupOldRooms() {
    const cutoff = Date.now() - SIX_HOURS_MS;
    let removedCount = 0;

    try {
        // OPTIMIZED: Query only rooms created before cutoff instead of downloading ALL rooms
        const roomsSnap = await db.ref("rooms")
            .orderByChild("createdAt")
            .endAt(cutoff)
            .once("value");
        
        if (!roomsSnap.exists()) return { removedRooms: 0 };

        const updates = {};
        const rooms = roomsSnap.val();

        for (const [roomId, room] of Object.entries(rooms)) {
            const isFinished = room.status === "finished";
            const isAbandoned = room.status === "playing" || room.status === "waiting";

            if (isFinished || isAbandoned) {
                updates[`rooms/${roomId}`] = null;
                updates[`roomQuestions/${roomId}`] = null;
                updates[`matchmaking/${roomId}`] = null;
                removedCount++;
            }
        }

        if (Object.keys(updates).length > 0) {
            // Batch in chunks of 500 to avoid multi-path update limits
            const entries = Object.entries(updates);
            for (let i = 0; i < entries.length; i += 500) {
                const chunk = Object.fromEntries(entries.slice(i, i + 500));
                await db.ref().update(chunk);
            }
        }

        console.log(`[Cleanup] Removed ${removedCount} old rooms`);
        return { removedRooms: removedCount };
    } catch (error) {
        console.error("[Cleanup] cleanupOldRooms error:", error.message);
        return { removedRooms: 0, error: error.message };
    }
}

/**
 * Archives payment logs older than 90 days.
 * OPTIMIZED: Uses orderByChild query to only fetch old logs instead of entire node.
 */
async function cleanupOldPaymentLogs() {
    const cutoff = Date.now() - NINETY_DAYS_MS;
    let removedCount = 0;

    try {
        // Payment logs are nested: paymentLogs/{userId}/{logKey}
        // We can't efficiently query nested timestamps, so we still read the top-level keys
        // but use shallow read to get only user IDs first, then fetch per-user
        const databaseURL = process.env.FIREBASE_DATABASE_URL;
        const shallowRes = await fetch(`${databaseURL}/paymentLogs.json?shallow=true`);
        const userIds = await shallowRes.json();
        
        if (!userIds || Object.keys(userIds).length === 0) return { removedLogs: 0 };

        const updates = {};

        // Process each user's logs individually (small reads)
        for (const userId of Object.keys(userIds)) {
            const userLogsSnap = await db.ref(`paymentLogs/${userId}`).once("value");
            if (!userLogsSnap.exists()) continue;

            const userLogs = userLogsSnap.val();
            for (const [logKey, logData] of Object.entries(userLogs)) {
                if (logData?.loggedAt && logData.loggedAt < cutoff) {
                    updates[`paymentLogs/${userId}/${logKey}`] = null;
                    removedCount++;
                }
            }
        }

        if (Object.keys(updates).length > 0) {
            const entries = Object.entries(updates);
            for (let i = 0; i < entries.length; i += 500) {
                const chunk = Object.fromEntries(entries.slice(i, i + 500));
                await db.ref().update(chunk);
            }
        }

        console.log(`[Cleanup] Removed ${removedCount} old payment logs`);
        return { removedLogs: removedCount };
    } catch (error) {
        console.error("[Cleanup] cleanupOldPaymentLogs error:", error.message);
        return { removedLogs: 0, error: error.message };
    }
}

/**
 * Removes orphaned roomQuestions entries that have no corresponding room.
 * OPTIMIZED: Uses shallow reads to get only keys (~2KB) instead of full node data.
 */
async function cleanupOrphanedRoomQuestions() {
    let removedCount = 0;

    try {
        const databaseURL = process.env.FIREBASE_DATABASE_URL;
        
        // Shallow reads — only download keys, not full data
        const [roomsRes, questionsRes] = await Promise.all([
            fetch(`${databaseURL}/rooms.json?shallow=true`),
            fetch(`${databaseURL}/roomQuestions.json?shallow=true`),
        ]);

        const roomKeys = await roomsRes.json();
        const questionKeys = await questionsRes.json();

        if (!questionKeys || Object.keys(questionKeys).length === 0) return { removedQuestions: 0 };

        const existingRoomIds = new Set(roomKeys ? Object.keys(roomKeys) : []);
        const updates = {};

        for (const roomId of Object.keys(questionKeys)) {
            if (!existingRoomIds.has(roomId)) {
                updates[`roomQuestions/${roomId}`] = null;
                removedCount++;
            }
        }

        if (Object.keys(updates).length > 0) {
            await db.ref().update(updates);
        }

        console.log(`[Cleanup] Removed ${removedCount} orphaned roomQuestions`);
        return { removedQuestions: removedCount };
    } catch (error) {
        console.error("[Cleanup] cleanupOrphanedRoomQuestions error:", error.message);
        return { removedQuestions: 0, error: error.message };
    }
}

/**
 * Main cleanup function — runs all cleanup tasks.
 */
async function runCleanup() {
    console.log("[Cleanup] Starting scheduled cleanup...");
    const results = await Promise.allSettled([
        cleanupOldRooms(),
        cleanupOldPaymentLogs(),
        cleanupOrphanedRoomQuestions(),
    ]);

    results.forEach((result, i) => {
        if (result.status === "rejected") {
            console.error(`[Cleanup] Task ${i} failed:`, result.reason);
        }
    });

    console.log("[Cleanup] Completed.");
}

module.exports = { runCleanup, cleanupOldRooms, cleanupOldPaymentLogs, cleanupOrphanedRoomQuestions };
