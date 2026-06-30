const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { config } = require("dotenv");
config();

const app = express();

// ─── CRITICAL: Webhook route needs raw body — must be BEFORE express.json() ──
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));

// ─── Standard middleware ──────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── TezMaths routes ──────────────────────────────────────────────────────────
const paymentsRouter = require("./routes/payments.routes");
const notificationsRouter = require("./routes/notifications.routes");
const migrationRouter = require("./routes/migration.routes");
const leaderboardRouter = require("./routes/leaderboard.routes");

app.use("/api/payments", paymentsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/migrate", migrationRouter);
app.use("/api/leaderboard", leaderboardRouter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// ─── Global error handler — ALWAYS returns JSON, never HTML ──────────────────
app.use((err, req, res, _next) => {
    console.error("Unhandled error:", err.message);
    res.status(500).json({ error: { message: err.message || "Internal server error" } });
});

// ─── Scheduled notifications cron (every 10 minutes) ─────────────────────────
const { processScheduledNotifications } = require("./services/notifications.service");
cron.schedule("*/10 * * * *", async () => {
    console.log("Running scheduled notifications check...");
    try { await processScheduledNotifications(); }
    catch (e) { console.error("Cron error:", e.message); }
}, { timezone: "Asia/Kolkata" });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;