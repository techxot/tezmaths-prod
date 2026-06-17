const express = require("express");
const router = express.Router();
const { verifyFirebaseToken } = require("../middlewares/firebaseAuth.middleware");
const { sendToAllUsers } = require("../services/notifications.service");
const { db } = require("../config/firebase");

// ─── POST /api/notifications/send ────────────────────────────────────────────
router.post("/send", verifyFirebaseToken, async (req, res) => {
  try {
    const { title, message, redirect = "" } = req.body.data || req.body;

    if (!title || !message) {
      return res.status(400).json({ error: { message: "Title and message are required" } });
    }

    // Client-side admin UI already saves the notification record to Firebase.
    // Server only sends FCM — no duplicate save here.
    const result = await sendToAllUsers(title, message, redirect);

    if (!result) {
      return res.status(500).json({
        error: { message: "sendToAllUsers returned null. Check server logs." },
      });
    }

    // Zero tokens is NOT a server error — return 200 with a warning
    if (result.sent === 0 && result.failure === 0) {
      return res.status(200).json({
        result,
        warning: "No FCM tokens found in database. Users may not have granted notification permission yet.",
      });
    }

    return res.json({ result });
  } catch (error) {
    console.error("send-notification error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to send notification" } });
  }
});

// ─── POST /api/notifications/schedule ────────────────────────────────────────
router.post("/schedule", verifyFirebaseToken, async (req, res) => {
  try {
    const { title, message, redirect = "", scheduledTime } = req.body.data || req.body;

    if (!title || !message || !scheduledTime) {
      return res.status(400).json({ error: { message: "Title, message and scheduledTime are required" } });
    }

    const notifRef = db.ref("notifications").push();
    await notifRef.set({
      title,
      message,
      redirect,
      status: "scheduled",
      scheduledTime,
      createdAt: Date.now(),
    });

    return res.json({ result: { notifId: notifRef.key, scheduledTime } });
  } catch (error) {
    console.error("schedule-notification error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to schedule notification" } });
  }
});

// ─── DELETE /api/notifications/:notifId ──────────────────────────────────────
router.delete("/:notifId", verifyFirebaseToken, async (req, res) => {
  try {
    const { notifId } = req.params;
    await db.ref(`notifications/${notifId}`).remove();
    return res.json({ result: { success: true } });
  } catch (error) {
    console.error("delete-notification error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to delete notification" } });
  }
});

// ─── POST /api/notifications/resend ──────────────────────────────────────────
router.post("/resend", verifyFirebaseToken, async (req, res) => {
  try {
    const { notifId, title, message, redirect = "" } = req.body.data || req.body;

    if (!notifId || !title || !message) {
      return res.status(400).json({ error: { message: "notifId, title and message are required" } });
    }

    const sendResult = await sendToAllUsers(title, message, redirect);

    await db.ref(`notifications/${notifId}`).update({
      status: "sent",
      sentTime: Date.now(),
    });

    return res.json({ result: sendResult });
  } catch (error) {
    console.error("resend-notification error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to resend" } });
  }
});

module.exports = router;