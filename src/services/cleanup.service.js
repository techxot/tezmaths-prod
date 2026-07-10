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
 * Also removes their associated roomQuestions and matchmaking entries.
 */
async function cleanupOldRooms() {
    const cutoff = Date.now() - SIX_HOURS_MS;
    let removedCount = 0;

    try {
        const roomsSnap = await db.ref("rooms").once("value");
        if (!roomsSnap.exists()) return { removedRooms: 0 };

        const updates = {};
        const rooms = roomsSnap.val();

        for (const [roomId, room] of Object.entries(rooms)) {
            const isOld = (room.createdAt || 0) < cutoff;
            const isFinished = room.status === "finished";
            const isAbandoned = isOld && (room.status === "playing" || room.status === "waiting");

            if (isFinished || isAbandoned) {
                updates[`rooms/${roomId}`] = null;
                updates[`roomQuestions/${roomId}`] = null;
                updates[`matchmaking/${roomId}`] = null;
                removedCount++;
            }
        }

        if (Object.keys(updates).length > 0) {
            await db.ref().update(updates);
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
 * Moves them to a paymentLogsArchive node (or deletes if archival isn't needed).
 * This keeps the paymentLogs node small for active queries.
 */
async function cleanupOldPaymentLogs() {
    const cutoff = Date.now() - NINETY_DAYS_MS;
    let removedCount = 0;

    try {
        const logsSnap = await db.ref("paymentLogs").once("value");
        if (!logsSnap.exists()) return { removedLogs: 0 };

        const updates = {};
        const allLogs = logsSnap.val();

        for (const [userId, userLogs] of Object.entries(allLogs)) {
            if (!userLogs || typeof userLogs !== "object") continue;

            for (const [logKey, logData] of Object.entries(userLogs)) {
                if (logData?.loggedAt && logData.loggedAt < cutoff) {
                    updates[`paymentLogs/${userId}/${logKey}`] = null;
                    removedCount++;
                }
            }
        }

        if (Object.keys(updates).length > 0) {
            // Batch in chunks of 500 to avoid Firebase multi-path update limits
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
 */
async function cleanupOrphanedRoomQuestions() {
    let removedCount = 0;

    try {
        const [roomsSnap, questionsSnap] = await Promise.all([
            db.ref("rooms").once("value"),
            db.ref("roomQuestions").once("value"),
        ]);

        if (!questionsSnap.exists()) return { removedQuestions: 0 };

        const existingRoomIds = new Set(
            roomsSnap.exists() ? Object.keys(roomsSnap.val()) : []
        );

        const updates = {};
        const questionRoomIds = Object.keys(questionsSnap.val());

        for (const roomId of questionRoomIds) {
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
