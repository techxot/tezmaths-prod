const { admin, db } = require("../config/firebase");

async function sendToAllUsers(title, message, redirect = "") {
  try {
    // Pull tokens from the 'users' node because older app versions 
    // only saved it there, or the fcmTokens node might have been cleared.
    const snap = await db.ref("users").once("value");
    if (!snap.exists()) {
      console.log("No FCM tokens found");
      return { sent: 0, failure: 0 };
    }

    const tokenToUser = {};
    const rawData = snap.val();
    
    for (const [userId, userData] of Object.entries(rawData)) {
      if (userData && userData.fcmToken) {
        tokenToUser[userData.fcmToken] = userId;
      }
    }

    const tokens = Object.keys(tokenToUser);
    if (tokens.length === 0) return { sent: 0, failure: 0 };

    console.log(`Sending to ${tokens.length} devices...`);

    const messages = tokens.map((token) => ({
      token,
      notification: { title, body: message },
      data: { redirect: redirect || "" },

      // ── Android config ────────────────────────────────────────────────────────
      android: {
        priority: "high",                   // wake up device even in Doze mode
        notification: {
          sound: "default",
          channelId: "default-v2",           // MUST match channel created in notificationService.js
          priority: "high",
          defaultSound: true,
          defaultVibrateTimings: true,
          notificationCount: 1,
        },
      },

      // ── iOS / APNs config ─────────────────────────────────────────────────────
      // CRITICAL: Without this block, iOS devices receive nothing.
      // FCM requires explicit APNs headers for iOS push delivery.
      apns: {
        headers: {
          "apns-priority": "10",          // 10 = immediate delivery (vs 5 = power-saving)
          "apns-push-type": "alert",      // required for iOS 13+
        },
        payload: {
          aps: {
            alert: {
              title,
              body: message,
            },
            sound: "default",
            badge: 1,
            "mutable-content": 1,       // allows notification service extensions
            "content-available": 1,     // wake app in background for data processing
          },
        },
      },
    }));

    let success = 0;
    let failure = 0;

    // FCM allows max 500 per batch
    for (let i = 0; i < messages.length; i += 500) {
      const batch = messages.slice(i, i + 500);
      const response = await admin.messaging().sendEach(batch);
      success += response.successCount;
      failure += response.failureCount;

      // Clean up invalid tokens using the pre-built reverse map
      // O(1) lookup per failed token to find the owning userId
      const removeOps = [];
      response.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code;
          const failedToken = batch[idx].token;
          console.log(`Token failed: ${failedToken.slice(0, 20)}... — ${code}`);

          // These codes mean the token is permanently invalid
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-argument'
          ) {
            const userId = tokenToUser[failedToken];
            if (userId) {
              removeOps.push(
                db.ref(`users/${userId}/fcmToken`).remove()
              );
              console.log(`Queued stale token removal for user: ${userId}`);
            }
          }
        }
      });

      // Execute all removals in parallel
      if (removeOps.length > 0) {
        try {
          await Promise.all(removeOps);
          console.log(`Removed ${removeOps.length} stale token(s)`);
        } catch (cleanupErr) {
          console.error("Stale token cleanup failed:", cleanupErr.message);
        }
      }
    }

    console.log(`FCM result: success=${success} failure=${failure}`);
    return { sent: success, failure };
  } catch (error) {
    console.error("sendToAllUsers error:", error);
    throw error;
  }
}

async function processScheduledNotifications() {
  try {
    const now = Date.now();
    const snapshot = await db
      .ref("notifications")
      .orderByChild("status")
      .equalTo("scheduled")
      .once("value");

    if (!snapshot.exists()) return;

    const notifications = snapshot.val();
    const updates = {};

    for (const [notifId, notif] of Object.entries(notifications)) {
      if (notif.scheduledTime <= now) {
        console.log(`Sending scheduled: ${notif.title}`);
        await sendToAllUsers(notif.title, notif.message, notif.redirect || "");
        updates[`notifications/${notifId}/status`] = "sent";
        updates[`notifications/${notifId}/sentTime`] = now;
      }
    }

    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
    }
  } catch (error) {
    console.error("processScheduledNotifications error:", error.message);
  }
}

module.exports = { sendToAllUsers, processScheduledNotifications };
