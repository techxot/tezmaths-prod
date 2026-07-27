const admin = require("firebase-admin");

let serviceAccount;

// Method 1: Single JSON env var (preferred — no newline issues)
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    console.log("[Firebase Admin] using FIREBASE_SERVICE_ACCOUNT_JSON");
  } catch (e) {
    console.warn("[Firebase Admin] FIREBASE_SERVICE_ACCOUNT_JSON parse failed:", e.message);
  }
}

// Method 2: Individual env vars (fallback)
if (!serviceAccount) {
  const requiredEnv = [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "FIREBASE_DATABASE_URL",
  ];

  for (const key of requiredEnv) {
    if (!process.env[key]) {
      throw new Error(`Missing required Firebase env var: ${key}`);
    }
  }

  // Handle all Railway private key storage formats
  let rawKey = process.env.FIREBASE_PRIVATE_KEY;

  // Strip surrounding quotes if Railway UI added them
  if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
    rawKey = rawKey.slice(1, -1);
  }

  // Convert literal \n to real newlines
  const privateKey = rawKey.includes("\\n")
    ? rawKey.replace(/\\n/g, "\n")
    : rawKey;

  serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  };
}

const databaseURL = process.env.FIREBASE_DATABASE_URL;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL,
  });

  console.log("[Firebase Admin] initialized", {
    projectId: serviceAccount.project_id || serviceAccount.projectId,
    databaseURL,
    clientEmail: serviceAccount.client_email || serviceAccount.clientEmail,
  });
}

const db = admin.database();
const firebaseAuth = admin.auth();
const messaging = admin.messaging();

module.exports = { admin, db, firebaseAuth, messaging };
