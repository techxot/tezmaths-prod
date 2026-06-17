const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { verifyFirebaseToken } = require("../middlewares/firebaseAuth.middleware");
const {
  createSubscription,
  cancelSubscription,
  createOrder,
  handleWebhookEvent,
} = require("../services/razorpay.service");

// ─── POST /api/payments/create-subscription ───────────────────────────────────
router.post("/create-subscription", verifyFirebaseToken, async (req, res) => {
  try {
    const { userId, duration, razorpayPlanId } = req.body.data || req.body;

    if (!userId || !razorpayPlanId) {
      return res.status(400).json({ error: { message: "Missing userId or razorpayPlanId" } });
    }

    // User can only create subscription for themselves
    if (req.user.uid !== userId) {
      return res.status(403).json({ error: { message: "Permission denied" } });
    }

    const result = await createSubscription({ userId, duration, razorpayPlanId });
    return res.json({ result });
  } catch (error) {
    console.error("create-subscription error:", error.message);
    const msg = error?.error?.description || error?.description || error?.message || "Failed to create subscription";
    return res.status(500).json({ error: { message: msg } });
  }
});

// ─── POST /api/payments/cancel-subscription ───────────────────────────────────
router.post("/cancel-subscription", verifyFirebaseToken, async (req, res) => {
  try {
    const { userId } = req.body.data || req.body;

    if (!userId) {
      return res.status(400).json({ error: { message: "Missing userId" } });
    }

    if (req.user.uid !== userId) {
      return res.status(403).json({ error: { message: "Permission denied" } });
    }

    const result = await cancelSubscription(userId);
    return res.json({ result });
  } catch (error) {
    console.error("cancel-subscription error:", error.message);
    return res.status(500).json({ error: { message: error.message || "Failed to cancel subscription" } });
  }
});

// ─── POST /api/payments/create-order ─────────────────────────────────────────
router.post("/create-order", verifyFirebaseToken, async (req, res) => {
  try {
    const { userId, amount, planId, duration } = req.body.data || req.body;

    if (!userId || !amount) {
      return res.status(400).json({ error: { message: "Missing userId or amount" } });
    }

    if (req.user.uid !== userId) {
      return res.status(403).json({ error: { message: "Permission denied" } });
    }

    const result = await createOrder({ userId, amount, planId, duration });
    return res.json({ result });
  } catch (error) {
    console.error("create-order error:", error.message);
    const msg = error?.error?.description || error?.description || error?.message || "Failed to create order";
    return res.status(500).json({ error: { message: msg } });
  }
});

// ─── POST /api/payments/webhook ───────────────────────────────────────────────
// NOTE: This route uses raw body — configured in index.js before json middleware
router.post("/webhook", async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];

  try {
    const rawBody = req.body; // Buffer, thanks to express.raw() in index.js
    const expectedSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (signature !== expectedSig) {
      console.error("Webhook: Invalid signature — rejected");
      return res.status(400).send("Invalid signature");
    }

    const parsed = JSON.parse(rawBody.toString("utf8"));
    await handleWebhookEvent(parsed.event, parsed.payload);
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook processing error:", error.message);
    return res.status(500).send("Error");
  }
});

// ─── GET /api/payments/webhook (health check) ────────────────────────────────
router.get("/webhook", (_req, res) => res.status(200).json({ status: "Razorpay webhook is live." }));

module.exports = router;