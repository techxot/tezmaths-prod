const { admin, db } = require("../config/firebase");

async function sendToAllUsers(title, message, redirect = "") {
  try {
    // Read from lightweight /fcmTokens/{userId} index instead of full /users (saves ~17MB)
    const startTime = Date.now();
    const tokensSnap = await db.ref("fcmTokens").once("value");
    const downloadTime = Date.now() - startTime;
    
    if (!tokensSnap.exists()) {
      console.log("[notifications] No FCM tokens found in /fcmTokens index");
      return { sent: 0, failure: 0 };
    }

    const rawSize = JSON.stringify(tokensSnap.val()).length;
    console.log(`[notifications] ⚠️ BANDWIDTH: Downloaded ${(rawSize / 1024).toFixed(1)} KB from /fcmTokens in ${downloadTime}ms`);

    const tokenToUser = {};
    const rawTokens = tokensSnap.val();
    
    for (const [userId, token] of Object.entries(rawTokens)) {
      if (token && typeof token === "string") {
        tokenToUser[token] = userId;
      }
    }

    const tokens = Object.keys(tokenToUser);
    if (tokens.length === 0) return { sent: 0, failure: 0 };

    console.log(`Sending to ${tokens.length} devices...`);

    const messages = tokens.map((token) => ({
      token,
      notification: { title, body: message },
      data: { redirect: redirect || "" },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "default-v2",
          priority: "high",
          defaultSound: true,
          defaultVibrateTimings: true,
          notificationCount: 1,
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
          "apns-push-type": "alert",
        },
        payload: {
          aps: {
            alert: { title, body: message },
            sound: "default",
            badge: 1,
            "mutable-content": 1,
            "content-available": 1,
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

      // Clean up invalid tokens
      const removeOps = [];
      response.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code;
          const failedToken = batch[idx].token;

          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-argument'
          ) {
            const userId = tokenToUser[failedToken];
            if (userId) {
              removeOps.push(
                db.ref(`fcmTokens/${userId}`).remove(),
                db.ref(`users/${userId}/fcmToken`).remove()
              );
            }
          }
        }
      });

      if (removeOps.length > 0) {
        await Promise.allSettled(removeOps);
        console.log(`Removed ${removeOps.length / 2} stale token(s)`);
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