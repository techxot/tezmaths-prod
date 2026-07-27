const admin = require("firebase-admin");

let serviceAccount;

// Support two initialization methods:
// 1. Single JSON env var (FIREBASE_SERVICE_ACCOUNT_JSON) — recommended, no newline issues
// 2. Individual env vars (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
} else {
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

  // Handle both formats:
  // 1. Literal \n characters (pasted as raw text in Railway UI)
  // 2. Actual newlines (Railway UI converted \n to real newlines when saving)
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  const privateKey = rawKey.includes("\\n")
    ? rawKey.replace(/\\n/g, "\n")   // literal \n → real newlines
    : rawKey;                          // already has real newlines

  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error("FIREBASE_PRIVATE_KEY is malformed");
  }

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