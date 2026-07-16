// measure-nodes.js — run with: node measure-nodes.js
require('dotenv').config();
const { db } = require('./src/config/firebase');

async function measureNodes() {
  const nodes = [
    'users',
    'rooms',
    'quizzes',
    'videos',
    'roomQuestions',
    'paymentLogs',
    'fcmTokens',
    'leaderboard',
    'practiceQuestions',
    'studyTopics',
    'studyContents',
    'notifications',
    'appConfig',
    'practiceTopics',
    'practiceTimerDurations',
    'practiceLevelSettings',
    'streakConfig',
    'leaderboardConfig',
    'practiceConfig',
    'achievements',
    'adSettings',
    'subscriptionPricing',
    'featureLocks',
    'quizLevels',
    'usernames',
    'presence',
    'matchmaking',
    'userRooms',
  ];

  let totalKB = 0;

  console.log('\n==========================================');
  console.log('  FIREBASE NODE SIZE MEASUREMENT');
  console.log('==========================================\n');

  for (const node of nodes) {
    try {
      const snap = await db.ref(node).once('value');
      const json = JSON.stringify(snap.val() || {});
      const sizeBytes = json.length;
      const sizeKB = sizeBytes / 1024;
      const sizeMB = sizeBytes / (1024 * 1024);
      totalKB += sizeKB;

      const display = sizeMB >= 1
        ? `${sizeMB.toFixed(2)} MB`
        : `${sizeKB.toFixed(1)} KB`;

      const bar = '█'.repeat(Math.min(50, Math.ceil(sizeKB / 100)));
      console.log(`/${node.padEnd(22)} ${display.padStart(10)}  ${bar}`);
    } catch (error) {
      console.log(`/${node.padEnd(22)}  ERROR: ${error.message}`);
    }
  }

  console.log('\n──────────────────────────────────────────');
  console.log(`  TOTAL: ${(totalKB / 1024).toFixed(2)} MB (${totalKB.toFixed(0)} KB)`);
  console.log('──────────────────────────────────────────\n');

  process.exit(0);
}

measureNodes();
