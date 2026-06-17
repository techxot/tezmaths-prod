const admin = require("firebase-admin");

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

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
const databaseURL = process.env.FIREBASE_DATABASE_URL;

if (!privateKey.includes("BEGIN PRIVATE KEY")) {
  throw new Error("FIREBASE_PRIVATE_KEY is malformed");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
    databaseURL,
  });

  console.log("[Firebase Admin] initialized", {
    projectId,
    databaseURL,
    clientEmail,
  });
}

const db = admin.database();
const firebaseAuth = admin.auth();
const messaging = admin.messaging();

module.exports = { admin, db, firebaseAuth, messaging };