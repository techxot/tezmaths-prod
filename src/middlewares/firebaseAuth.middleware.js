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

const verifyAdmin = async (req, res, next) => {
  // First verify the token
  verifyFirebaseToken(req, res, (err) => {
    if (err) return; // verifyFirebaseToken already sent response
    // Check admin
    if (req.user.admin === true || req.user.email === "tezmaths@admin.com") {
      return next();
    }
    return res.status(403).json({ error: { message: "Admin access required", status: "FORBIDDEN" } });
  });
};

module.exports = { verifyFirebaseToken, verifyAdmin };