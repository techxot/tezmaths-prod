const { Server } = require("socket.io");
const { socketAuthMiddleware } = require("./auth");
const { MatchmakingQueue } = require("./matchmaking");
const { BattleSessionManager } = require("./battleSession");
const { registerHandlers } = require("./handlers");

/**
 * Connection registry: Maps Firebase UID to socketId.
 * Ensures only one active connection per user at any time.
 * @type {Map<string, string>}
 */
const connectionRegistry = new Map();

/**
 * Creates and configures the Socket.IO server instance.
 * Attaches to the existing HTTP server to share the same port.
 *
 * @param {import("http").Server} httpServer - The HTTP server instance
 * @returns {import("socket.io").Server} The configured Socket.IO server
 */
function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ["websocket", "polling"],
    pingInterval: 10000,
    pingTimeout: 5000,
    maxHttpBufferSize: 1e5,
  });

  // Instantiate shared services
  const battleSessionManager = new BattleSessionManager(io);
  const matchmakingQueue = new MatchmakingQueue(io, battleSessionManager);

  // Start memory monitoring (Requirement 13.4, 13.5)
  battleSessionManager.startMonitoring();

  // Register authentication middleware
  io.use(socketAuthMiddleware);

  io.on("connection", (socket) => {
    const uid = socket.userId;
    console.log(`Socket connected: ${socket.id} (uid: ${uid})`);

    // Enforce single connection per UID
    if (connectionRegistry.has(uid)) {
      const oldSocketId = connectionRegistry.get(uid);
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        console.log(`Disconnecting older socket ${oldSocketId} for uid: ${uid}`);
        oldSocket.disconnect(true);
      }
    }

    // Register the new socket
    connectionRegistry.set(uid, socket.id);

    // Register event handlers for this socket
    registerHandlers(io, socket, matchmakingQueue, battleSessionManager);

    socket.on("disconnect", (reason) => {
      console.log(`Socket disconnected: ${socket.id} (${reason})`);
      // Only remove from registry if this socket is still the registered one
      // (prevents removing a newer connection's entry)
      if (connectionRegistry.get(uid) === socket.id) {
        connectionRegistry.delete(uid);
      }
    });
  });

  return io;
}

/**
 * Returns the connection registry for testing purposes.
 * @returns {Map<string, string>}
 */
function getConnectionRegistry() {
  return connectionRegistry;
}

module.exports = { createSocketServer, getConnectionRegistry };
