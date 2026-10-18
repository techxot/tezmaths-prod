const { admin, db } = require("../config/firebase");
const { getFirestore } = require("firebase-admin/firestore");

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
        // Query bounded batch of old rooms to avoid downloading massive datasets
        const roomsSnap = await db.ref("rooms")
            .orderByChild("createdAt")
            .endAt(cutoff)
            .limitToFirst(50)
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
 * Payment logs are tiny historical audit records (~150 bytes each).
 * Retained permanently for customer dispute resolution and Razorpay compliance.
 * Disabled to eliminate wasteful N-user loops and prevent bandwidth consumption.
 */
async function cleanupOldPaymentLogs() {
    return { removedLogs: 0 };
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
 * Removes Firestore battle rooms older than 6 hours.
 * Human battles now live in Firestore — this cleans up finished/abandoned rooms
 * along with their associated roomQuestions and matchmaking entries.
 * 
 * Note: Firestore batch limit is 500 operations, so we limit to 100 rooms
 * (each room = 3 deletes: room + questions + matchmaking = 300 ops max).
 */
async function cleanupOldFirestoreRooms() {
    const firestore = getFirestore();
    const cutoff = new Date(Date.now() - SIX_HOURS_MS);
    let removedCount = 0;

    try {
        // Query rooms with createdAt older than 6 hours
        const snapshot = await firestore.collection("rooms")
            .where("createdAt", "<", cutoff)
            .limit(100)
            .get();

        if (snapshot.empty) return { removedRooms: 0 };

        const batch = firestore.batch();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
            batch.delete(firestore.doc(`roomQuestions/${doc.id}`));
            batch.delete(firestore.doc(`matchmaking/${doc.id}`));
            removedCount++;
        });

        await batch.commit();
        console.log(`[Cleanup] Removed ${removedCount} old Firestore rooms`);
        return { removedRooms: removedCount };
    } catch (error) {
        console.error("[Cleanup] cleanupOldFirestoreRooms error:", error.message);
        return { removedRooms: 0, error: error.message };
    }
}

/**
 * Main cleanup function — runs all cleanup tasks.
 */
async function runCleanup() {
    console.log("[Cleanup] Starting scheduled cleanup...");
    const results = await Promise.allSettled([
        cleanupOldRooms(),
        cleanupOldFirestoreRooms(),
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

module.exports = { runCleanup, cleanupOldRooms, cleanupOldFirestoreRooms, cleanupOldPaymentLogs, cleanupOrphanedRoomQuestions };
