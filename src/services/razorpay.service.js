const razorpay = require("../config/razorpay");
const { db } = require("../config/firebase");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function addMonthsFrom(baseTimestamp, duration) {
  const baseDate = baseTimestamp ? new Date(baseTimestamp) : new Date();
  const now = new Date();
  const start = baseDate.getTime() > now.getTime() ? baseDate : now;
  const next = new Date(start);
  next.setMonth(next.getMonth() + (duration === "yearly" ? 12 : 1));
  return next.getTime();
}

async function writePaymentLog(userId, key, data) {
  try {
    await db.ref(`paymentLogs/${userId}/${key}`).set({ ...data, loggedAt: Date.now() });
  } catch (e) {
    console.error("Failed to write payment log:", e.message);
  }
}

// ─── Create Subscription (mandate / auto-renew) ───────────────────────────────

async function createSubscription({ userId, duration, razorpayPlanId }) {
  const normalizedDuration = duration === "yearly" ? "yearly" : "monthly";

  const subscription = await razorpay.subscriptions.create({
    plan_id: razorpayPlanId,
    total_count: normalizedDuration === "yearly" ? 12 : 120,
    quantity: 1,
    customer_notify: 1,
    notes: { userId, duration: normalizedDuration },
  });

  await db.ref(`users/${userId}`).update({
    subscriptionStatus: "created",
    autoRenew: true,
    razorpaySubscriptionId: subscription.id,
    subscriptionDuration: normalizedDuration,
    subscriptionPlan: razorpayPlanId,
    subscriptionCreatedAt: Date.now(),
  });

  await writePaymentLog(userId, subscription.id, {
    type: "subscription_created",
    subscriptionId: subscription.id,
    razorpayPlanId,
    duration: normalizedDuration,
    razorpayStatus: subscription.status || "created",
  });

  return { subscriptionId: subscription.id };
}

// ─── Cancel Subscription ──────────────────────────────────────────────────────

async function cancelSubscription(userId) {
  const userSnap = await db.ref(`users/${userId}`).once("value");
  const user = userSnap.val() || {};

  if (!user.razorpaySubscriptionId) {
    throw new Error("No active subscription found for this user.");
  }

  // cancel() returns the subscription object with current_end
  const cancelledSub = await razorpay.subscriptions.cancel(user.razorpaySubscriptionId, true);

  // current_end is Unix seconds → convert to ms. Fallback to existing value if missing.
  const endDate = cancelledSub.current_end
    ? cancelledSub.current_end * 1000
    : (user.subscriptionEndDate || Date.now());

  await db.ref(`users/${userId}`).update({
    autoRenew: false,
    subscriptionStatus: "cancelled",
    cancelledAt: Date.now(),
    subscriptionEndDate: endDate,   // ← accurate end date written here
  });

  await writePaymentLog(userId, `cancel_${Date.now()}`, {
    type: "subscription_cancel_requested",
    subscriptionId: user.razorpaySubscriptionId,
    endDate,
  });

  return { success: true, endDate };
}

// ─── Create Order (one-time payment fallback) ─────────────────────────────────

async function createOrder({ userId, amount, planId, duration }) {
  const order = await razorpay.orders.create({
    amount: Math.round(amount * 100), // paise
    currency: "INR",
    receipt: `rcpt_${userId}_${Date.now()}`.slice(0, 40),
    notes: { userId, planId: planId || "", duration: duration || "monthly" },
  });

  await writePaymentLog(userId, order.id, {
    type: "order_created",
    orderId: order.id,
    amount,
    planId,
    duration,
  });

  return { orderId: order.id };
}

// ─── Handle Webhook Event ─────────────────────────────────────────────────────

async function handleWebhookEvent(event, payload) {
  const subscriptionEntity = payload?.subscription?.entity || null;
  const paymentEntity = payload?.payment?.entity || null;
  const entity = subscriptionEntity || paymentEntity || null;

  const userId =
    entity?.notes?.userId ||
    subscriptionEntity?.notes?.userId ||
    paymentEntity?.notes?.userId ||
    null;

  const duration =
    entity?.notes?.duration === "yearly" ? "yearly" : "monthly";

  console.log(`Webhook: ${event} | userId: ${userId || "N/A"}`);

  if (!userId) {
    console.warn("Webhook: No userId in notes, skipping");
    return;
  }

  const userRef = db.ref(`users/${userId}`);

  if (event === "subscription.authenticated" || event === "subscription.activated") {
    await userRef.update({
      subscriptionStatus: "active",
      autoRenew: true,
      isPremium: true,
      razorpaySubscriptionId: subscriptionEntity?.id || entity?.id || null,
      subscriptionDuration: duration,
      subscriptionPlan: subscriptionEntity?.plan_id || entity?.plan_id || null,
      subscriptionStartDate: Date.now(),
      subscriptionLabel: duration === "yearly" ? "Yearly" : "Monthly",
    });
    await writePaymentLog(userId, `activated_${Date.now()}`, {
      type: event,
      subscriptionId: subscriptionEntity?.id || entity?.id || null,
      duration,
    });
    console.log(`Activated: ${userId}`);
    return;
  }

  if (event === "subscription.charged") {
    const endDateSnap = await userRef.child("subscriptionEndDate").once("value");
    const currentEndDate = endDateSnap.val() || null;
    const newEndDate = addMonthsFrom(currentEndDate, duration);

    await userRef.update({
      isPremium: true,
      subscriptionStatus: "active",
      subscriptionDuration: duration,
      subscriptionEndDate: newEndDate,
      lastPaymentDate: Date.now(),
      autoRenew: true,
      razorpaySubscriptionId: subscriptionEntity?.id || entity?.id || null,
      subscriptionPlan: subscriptionEntity?.plan_id || entity?.plan_id || null,
      subscriptionLabel: duration === "yearly" ? "Yearly" : "Monthly",
    });
    await writePaymentLog(userId, `charged_${Date.now()}`, {
      type: "subscription_charged",
      subscriptionId: subscriptionEntity?.id || entity?.id || null,
      paymentId: paymentEntity?.id || null,
      duration,
      newEndDate,
    });
    console.log(`Renewed: ${userId} → new end: ${new Date(newEndDate).toISOString()}`);
    return;
  }

  if (event === "subscription.cancelled") {
    const endDate = subscriptionEntity?.current_end
      ? subscriptionEntity.current_end * 1000
      : null;

    await userRef.update({
      autoRenew: false,
      subscriptionStatus: "cancelled",
      cancelledAt: Date.now(),
      ...(endDate && { subscriptionEndDate: endDate }),  // only overwrite if Razorpay provides it
    });
    await writePaymentLog(userId, `cancelled_${Date.now()}`, { type: "subscription_cancelled", subscriptionId: subscriptionEntity?.id || entity?.id || null });
    console.log(`Cancelled: ${userId}`);
    return;
  }

  if (event === "subscription.completed") {
    await userRef.update({ isPremium: false, autoRenew: false, subscriptionStatus: "completed" });
    await writePaymentLog(userId, `completed_${Date.now()}`, { type: "subscription_completed" });
    return;
  }

  if (event === "subscription.halted") {
    await userRef.update({ isPremium: false, autoRenew: false, subscriptionStatus: "halted" });
    await writePaymentLog(userId, `halted_${Date.now()}`, { type: "subscription_halted" });
    console.warn(`Halted (payment failed): ${userId}`);
    return;
  }

  if (event === "subscription.paused") {
    await userRef.update({ autoRenew: false, subscriptionStatus: "paused" });
    await writePaymentLog(userId, `paused_${Date.now()}`, { type: "subscription_paused" });
    return;
  }

  if (event === "subscription.resumed") {
    await userRef.update({ autoRenew: true, subscriptionStatus: "active", isPremium: true });
    await writePaymentLog(userId, `resumed_${Date.now()}`, { type: "subscription_resumed" });
    return;
  }

  await writePaymentLog(userId, `ignored_${Date.now()}`, { type: "ignored_event", event });
  console.log(`Ignored webhook event: ${event}`);
}

module.exports = { createSubscription, cancelSubscription, createOrder, handleWebhookEvent };