const { firebaseAuth } = require("../config/firebase");

/**
 * Socket.IO authentication middleware.
 * Verifies Firebase ID token from the handshake auth payload.
 * On success, attaches userId and userData to the socket.
 *
 * @param {import("socket.io").Socket} socket
 * @param {Function} next
 */
async function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Authentication required"));

  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    socket.userId = decoded.uid;
    socket.userData = decoded;
    next();
  } catch (err) {
    next(new Error("Invalid or expired token"));
  }
}

module.exports = { socketAuthMiddleware };
