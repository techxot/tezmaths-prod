/**
 * One-time script to set admin custom claim on a Firebase Auth user.
 * 
 * Usage:
 *   1. First create the user in Firebase Console (Authentication → Users → Add user)
 *      Email: tezmaths@admin.com
 *      Password: admin@t32m392
 * 
 *   2. Run this script:
 *      node set-admin-claim.js
 * 
 *   3. The user will need to log out and log back in for the claim to take effect.
 */

require("dotenv").config();
const { firebaseAuth } = require("./src/config/firebase");

const ADMIN_EMAIL = "tezmaths@admin.com";

async function setAdminClaim() {
    try {
        // Get the user by email
        const user = await firebaseAuth.getUserByEmail(ADMIN_EMAIL);
        console.log(`Found user: ${user.uid} (${user.email})`);

        // Set admin custom claim
        await firebaseAuth.setCustomUserClaims(user.uid, { admin: true });
        console.log(`✅ Admin claim set for ${ADMIN_EMAIL}`);
        console.log("The user needs to log out and log back in for the claim to take effect.");
    } catch (error) {
        if (error.code === "auth/user-not-found") {
            console.error(`❌ User ${ADMIN_EMAIL} not found in Firebase Auth.`);
            console.error("Create the user first in Firebase Console → Authentication → Users → Add user");
        } else {
            console.error("❌ Error:", error.message);
        }
    }
    process.exit(0);
}

setAdminClaim();
