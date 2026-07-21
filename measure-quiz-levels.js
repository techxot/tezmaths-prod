// measure-quiz-levels.js — Measures actual download size per quiz level
// Run: node measure-quiz-levels.js
require('dotenv').config();
const { db } = require('./src/config/firebase');

async function measureQuizLevels() {
  console.log('\n==========================================');
  console.log('  QUIZ NODE SIZE — PER LEVEL BREAKDOWN');
  console.log('==========================================\n');

  // First: measure the FULL /quizzes node
  const fullSnap = await db.ref('quizzes').once('value');
  const fullJson = JSON.stringify(fullSnap.val() || {});
  console.log(`FULL /quizzes node: ${(fullJson.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Total quiz entries: ${fullSnap.numChildren()}\n`);

  // Measure each level via indexed query (what QuizCacheService does)
  let totalFilteredSize = 0;
  for (let level = 1; level <= 15; level++) {
    const snap = await db.ref('quizzes')
      .orderByChild('level')
      .equalTo(level)
      .once('value');
    
    if (!snap.exists()) {
      console.log(`  Level ${level.toString().padStart(2)}: (empty)`);
      continue;
    }

    const json = JSON.stringify(snap.val());
    const sizeKB = json.length / 1024;
    const sizeMB = json.length / (1024 * 1024);
    totalFilteredSize += json.length;

    // Count questions inside
    let questionCount = 0;
    snap.forEach((child) => {
      const quiz = child.val();
      if (quiz.questions) {
        questionCount += Array.isArray(quiz.questions) ? quiz.questions.length : Object.keys(quiz.questions).length;
      }
    });

    console.log(`  Level ${level.toString().padStart(2)}: ${sizeKB.toFixed(1)} KB (${sizeMB.toFixed(3)} MB) — ${questionCount} questions, ${snap.numChildren()} quiz entries`);
  }

  console.log(`\n──────────────────────────────────────────`);
  console.log(`  Total (all levels summed): ${(totalFilteredSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Full node size:            ${(fullJson.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Difference (orphan data):  ${((fullJson.length - totalFilteredSize) / 1024 / 1024).toFixed(2)} MB`);
  console.log(`──────────────────────────────────────────\n`);

  // Check: are there quiz entries WITHOUT a "level" field?
  let noLevelCount = 0;
  let noLevelSize = 0;
  fullSnap.forEach((child) => {
    const quiz = child.val();
    if (quiz.level === undefined || quiz.level === null) {
      noLevelCount++;
      noLevelSize += JSON.stringify(quiz).length;
    }
  });
  
  if (noLevelCount > 0) {
    console.log(`⚠️  WARNING: ${noLevelCount} quiz entries have NO "level" field!`);
    console.log(`   These are invisible to orderByChild("level") queries but still exist in /quizzes`);
    console.log(`   Their size: ${(noLevelSize / 1024 / 1024).toFixed(2)} MB\n`);
  }

  // Now simulate what happens during a battle (levels 1-10 fetched)
  console.log('── Battle Simulation (levels 1-10) ────────');
  let battleTotal = 0;
  for (let level = 1; level <= 10; level++) {
    const snap = await db.ref('quizzes')
      .orderByChild('level')
      .equalTo(level)
      .once('value');
    if (snap.exists()) {
      battleTotal += JSON.stringify(snap.val()).length;
    }
  }
  console.log(`  Total download for levels 1-10: ${(battleTotal / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  (This is what one user downloads per battle if cache is cold)\n`);

  process.exit(0);
}

measureQuizLevels().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
