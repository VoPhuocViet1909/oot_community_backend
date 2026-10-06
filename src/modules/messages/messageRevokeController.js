const { revokeMessage } = require("./messageRevokeService");
const { emitToUserSockets, onlineUsers } = require("../../socket/socketUserRegistry");
const { pool } = require("../../config/mysqlConfig");

/**
 * Extract participant user IDs from a conversationId.
 *
 *  - DM:  "dm:userA:userB"  → [userA, userB]
 *  - Group: "123" or "group_123" → needs DynamoDB lookup
 *
 * @param {string} conversationId
 * @returns {Promise<{ participants: string[] }>}
 */
async function getConversationParticipants(conversationId) {
  const normalized = String(conversationId ?? "").trim();

  if (normalized.startsWith("dm:")) {
    const parts = normalized.split(":");
    if (parts.length >= 3) {
      return { participants: [parts[1], parts[2]] };
    }
  }

  // Group: query group_members for all members
  try {
    const [rows] = await pool.query(
      "SELECT user_id FROM group_members WHERE group_id = ?",
      [normalized],
    );
    const participants = rows.map((row) => String(row.user_id));
    return { participants };
  } catch {
    return { participants: [] };
  }
}

/**
 * PUT /api/messages-extension/revoke
 *
 * Body: { conversationId: string, messageId: string }
 *
 * Replicates the error-code naming used in the service so the controller can
 * map them to HTTP status codes in a single switch block.
 */
async function revokeMessageHandler(req, res) {
  try {
    // ── 1. Extract & validate the authenticated user ──────────────────────
    const userId = req.user?.userId ?? req.user?.id ?? null;

    if (!userId) {
      return res.status(401).json({
        message: "Unauthorized: user identity could not be determined",
      });
    }

    // ── 2. Validate required body fields ──────────────────────────────────
    const { conversationId, messageId } = req.body;

    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }
    if (!messageId) {
      return res.status(400).json({ message: "messageId is required" });
    }

    // ── 3. Delegate to service ─────────────────────────────────────────────
    const result = await revokeMessage(conversationId, messageId, userId);

    // ── 4. Real-time: notify ALL conversation participants ─────────────────
    //
    // Two emission paths are needed:
    //   A. io.to(room)         → reaches sockets that have joined the room
    //   B. emitToUserSockets()  → reaches sockets even if not in the room
    //                              (e.g. user has the app open in a different tab,
    //                               or hasn't joined the room yet)
    const io = req.app.get("socketio");
    if (io) {
      const revokedPayload = {
        conversationId,
        messageId,
        revokedAt: result.revokedAt,
        revokedBy: result.revokedBy,
      };

      // Path A: broadcast via Socket.io room
      io.to(conversationId).emit("message:revoked", revokedPayload);

      // Path B: also emit directly to every participant's sockets
      const { participants } = await getConversationParticipants(conversationId);
      for (const participantId of participants) {
        emitToUserSockets(io, participantId, "message:revoked", revokedPayload);
      }

      // Path C: Auto-unpin synchronization
      if (result.updatedPinnedList) {
        io.to(conversationId).emit("message_pinned_updated", {
          roomId: conversationId,
          pinnedMessages: result.updatedPinnedList,
        });
      }
    }

    // ── 5. Respond ─────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: "Message has been revoked",
      data: result,
    });
  } catch (error) {
    const errorCode = error.code ?? "INTERNAL_ERROR";

    switch (errorCode) {
      case "BAD_REQUEST":
        return res.status(400).json({ message: error.message });

      case "NOT_FOUND":
        return res.status(404).json({ message: error.message });

      case "MESSAGE_NOT_FOUND":
        return res.status(404).json({ message: error.message });

      case "FORBIDDEN":
        return res.status(403).json({ message: error.message });

      case "ALREADY_REVOKED":
        return res.status(409).json({ message: error.message });

      default:
        console.error("[messageRevokeController] Unexpected error:", error);
        return res.status(500).json({
          message: "An unexpected error occurred while revoking the message",
        });
    }
  }
}

module.exports = { revokeMessageHandler };
