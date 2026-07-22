/**
 * One-time migration: Populate /quizLevels from existing /quizzes node.
 * Run with: node migrate-quiz-levels.js
 */
require("dotenv").config();
const { db } = require("./src/config/firebase");

async function migrateQuizLevels() {
    console.log("Migrating quiz levels to /quizLevels...");

    const snapshot = await db.ref("quizzes").once("value");
    if (!snapshot.exists()) { console.log("No quizzes found"); process.exit(0); }

    const levelsSet = new Set();
    snapshot.forEach((child) => {
        const quiz = child.val();
        if (quiz && quiz.level) levelsSet.add(Number(quiz.level));
    });

    const levels = Array.from(levelsSet).sort((a, b) => a - b);
    const updates = {};
    for (const level of levels) {
        updates[`quizLevels/${level}`] = true;
    }

    if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);
    }

    console.log(`✅ Created /quizLevels with ${levels.length} levels: [${levels.join(", ")}]`);
    process.exit(0);
}

migrateQuizLevels().catch((e) => { console.error(e); process.exit(1); });
