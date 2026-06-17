const { firebaseAuth } = require("../config/firebase");

const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: { message: "No token provided", status: "UNAUTHENTICATED" } });
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await firebaseAuth.verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Firebase token verification failed:", error.message);
    return res.status(401).json({ error: { message: "Invalid or expired token. Please log in again.", status: "UNAUTHENTICATED" } });
  }
};

module.exports = { verifyFirebaseToken };