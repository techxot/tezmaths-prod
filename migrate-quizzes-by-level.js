/**
 * migrate-quizzes-by-level.js
 *
 * ONE-TIME migration: restructures /quizzes from a flat list to level-keyed paths.
 *
 * BEFORE (current — causes 8MB download per query):
 *   /quizzes/{quizId} → { level: 3, title: "...", questions: [...] }
 *
 * AFTER (target — per-level read costs ~400KB, not 8MB):
 *   /quizzes/{level}/{quizId} → { title: "...", questions: [...] }
 *
 * The server-side quiz.service.js is updated separately to read the new path.
 *
 * Run with: node migrate-quizzes-by-level.js
 * Safe to re-run — skips levels already migrated.
 * Does NOT delete the old flat quizzes until you verify and run with --commit-delete.
 */
require('dotenv').config();
const { db } = require('./src/config/firebase');

const DRY_RUN = !process.argv.includes('--write');
const DELETE_OLD = process.argv.includes('--commit-delete');

async function migrate() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  QUIZ STRUCTURE MIGRATION');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (add --write to apply)' : 'WRITE MODE'}`);
  if (DELETE_OLD) console.log('  ⚠️  DELETE OLD DATA: enabled (--commit-delete)');
  console.log(`${'='.repeat(60)}\n`);

  // 1. Read all quizzes (full download — this is intentional, one-time cost)
  console.log('📥 Reading /quizzes node...');
  const snap = await db.ref('quizzes').once('value');
  if (!snap.exists()) {
    console.log('❌ /quizzes node is empty. Nothing to migrate.');
    process.exit(0);
  }

  const rawQuizzes = snap.val();
  const sizeKB = (JSON.stringify(rawQuizzes).length / 1024).toFixed(1);
  console.log(`   Total size: ${sizeKB} KB\n`);

  // 2. Check if already migrated (level keys are numbers, not Firebase push IDs)
  const keys = Object.keys(rawQuizzes);
  const alreadyMigrated = keys.every(k => /^\d+$/.test(k));
  if (alreadyMigrated) {
    console.log('✅ /quizzes already uses level-keyed structure. Nothing to do.');
    process.exit(0);
  }

  // 3. Group quizzes by level
  const byLevel = {};
  let skipped = 0;

  for (const [quizId, quiz] of Object.entries(rawQuizzes)) {
    const level = quiz.level;
    if (!level || typeof level !== 'number') {
      console.warn(`   ⚠️  Skipping ${quizId} — missing or invalid level field`);
      skipped++;
      continue;
    }
    if (!byLevel[level]) byLevel[level] = {};
    // Remove the level field from the stored object (it's now encoded in the path)
    const { level: _level, ...quizWithoutLevel } = quiz;
    byLevel[level][quizId] = quizWithoutLevel;
  }

  const levels = Object.keys(byLevel).sort((a, b) => Number(a) - Number(b));
  console.log(`📊 Found ${keys.length - skipped} quizzes across ${levels.length} levels: [${levels.join(', ')}]`);
  if (skipped > 0) console.log(`   ⚠️  Skipped ${skipped} quizzes with missing level`);

  // 4. Print per-level summary
  console.log('\nPer-level breakdown:');
  for (const level of levels) {
    const quizIds = Object.keys(byLevel[level]);
    const sizeKB = (JSON.stringify(byLevel[level]).length / 1024).toFixed(1);
    console.log(`   Level ${String(level).padStart(3)}: ${quizIds.length} quizzes, ${sizeKB} KB`);
  }

  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN complete — no changes made.');
    console.log('   Run with --write to apply migration.');
    process.exit(0);
  }

  // 5. Write new structure under /quizzes/{level}/
  console.log('\n✍️  Writing new level-keyed structure...');
  const updates = {};
  for (const level of levels) {
    updates[level] = byLevel[level];
  }

  await db.ref('quizzes').update(updates);
  console.log(`✅ Written ${levels.length} level keys to /quizzes`);

  // 6. Optionally delete old flat keys
  if (DELETE_OLD) {
    console.log('\n🗑️  Deleting old flat quiz keys...');
    const deleteUpdates = {};
    for (const quizId of keys) {
      // Only delete keys that are NOT numeric (old flat structure)
      if (!/^\d+$/.test(quizId)) {
        deleteUpdates[quizId] = null;
      }
    }
    await db.ref('quizzes').update(deleteUpdates);
    console.log(`✅ Deleted ${Object.keys(deleteUpdates).length} old flat keys`);
  } else {
    console.log('\n⚠️  Old flat keys NOT deleted (safe mode).');
    console.log('   Verify the migration looks correct in Firebase console,');
    console.log('   then run again with --write --commit-delete to clean up.');
  }

  console.log('\n🎉 Migration complete!');
  console.log('   Next: deploy updated quiz.service.js that reads /quizzes/{level}');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
