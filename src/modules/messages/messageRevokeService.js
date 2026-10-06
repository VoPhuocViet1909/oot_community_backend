const { pool } = require("../../config/mysqlConfig");

/**
 * Revokes (deletes) a message within a conversation.
 *
 * Rules:
 *   - Only the original sender (message.senderId) may revoke their own message.
 *   - The revoked message keeps its `id` and `createdAt` but its content is
 *     wiped and its `contentType` is set to "revoked" so the UI can render the
 *     placeholder "Tin nhắn đã được thu hồi" state.
 *
 * @param {string} conversationId  - DynamoDB primary key (e.g. "channel:1" or "dm:1:2")
 * @param {string} messageId       - The `id` field of the message inside the messages array
 * @param {string} userId         - The id of the requesting user (extracted from JWT)
 * @returns {Promise<object>}      - The revoked message object
 * @throws {Error} with code "MESSAGE_NOT_FOUND"  - when no message with the given id exists
 * @throws {Error} with code "FORBIDDEN"          - when userId !== message.senderId
 */
async function revokeMessage(conversationId, messageId, userId) {
  if (!conversationId) {
    const err = new Error("conversationId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }
  if (!messageId) {
    const err = new Error("messageId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const normalizedMessageId = String(messageId);

  // 1. Fetch the conversation row
  const [rows] = await pool.query(
    "SELECT messages FROM messages WHERE conversation_id = ? LIMIT 1",
    [conversationId],
  );

  if (!rows[0]) {
    const err = new Error(`Conversation "${conversationId}" not found`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const messages = Array.isArray(rows[0].messages)
    ? rows[0].messages.slice()
    : [];

  // 2. Locate the target message
  const msgIndex = messages.findIndex((m) => String(m.id) === normalizedMessageId);

  if (msgIndex === -1) {
    const err = new Error(`Message with id "${messageId}" not found in conversation "${conversationId}"`);
    err.code = "MESSAGE_NOT_FOUND";
    throw err;
  }

  const targetMsg = messages[msgIndex];

  // 3. Permission check – only the sender may revoke their own message
  if (String(targetMsg.senderId) !== String(userId)) {
    const err = new Error("You can only revoke your own messages");
    err.code = "FORBIDDEN";
    throw err;
  }

  // 4. Skip if already revoked
  if (targetMsg.contentType === "revoked") {
    const err = new Error("This message has already been revoked");
    err.code = "ALREADY_REVOKED";
    throw err;
  }

  // 5. Apply the revocation in place
  messages[msgIndex] = {
    ...targetMsg,
    contentType: "revoked",
    content: null,
    attachments: null,
    reactions: null,
  };

  // 6. Persist the updated messages array back to MySQL
  await pool.query(
    `INSERT INTO messages (conversation_id, messages, updated_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE messages = VALUES(messages), updated_at = VALUES(updated_at)`,
    [conversationId, JSON.stringify(messages), new Date().toISOString()],
  );

  // 7. Auto-unpin the message if it was pinned in friendship or group
  let updatedPinnedList = null;
  if (conversationId.startsWith("dm:")) {
    const parts = conversationId.split(":");
    if (parts.length >= 3) {
      try {
        const friendService = require("../users/friendService");
        const rec = await friendService.findExistingRecord(parts[1], parts[2]);
        if (rec) {
          let pinned = Array.isArray(rec.pinnedMessages) ? rec.pinnedMessages : [];
          const isPinned = pinned.some(m => String(m.id) === normalizedMessageId);
          if (isPinned) {
            pinned = pinned.filter(m => String(m.id) !== normalizedMessageId);
            await pool.query(
              "UPDATE friendships SET pinned_messages = ?, updated_at = ? WHERE friendship_id = ?",
              [JSON.stringify(pinned), new Date().toISOString(), String(rec.friendshipId)],
            );
            updatedPinnedList = pinned;
          }
        }
      } catch (err) {
        console.error("[revokeMessage] Error unpinning from friendship:", err);
      }
    }
  } else {
    // Group chat
    try {
      const [groupRows] = await pool.query(
        "SELECT pinned_messages FROM groups_ WHERE group_id = ? LIMIT 1",
        [String(conversationId)],
      );
      const g = groupRows[0];
      if (g) {
        let pinned = Array.isArray(g.pinned_messages) ? g.pinned_messages : [];
        const isPinned = pinned.some(m => String(m.id) === normalizedMessageId);
        if (isPinned) {
          pinned = pinned.filter(m => String(m.id) !== normalizedMessageId);
          await pool.query(
            "UPDATE groups_ SET pinned_messages = ?, updated_at = ? WHERE group_id = ?",
            [JSON.stringify(pinned), new Date().toISOString(), String(conversationId)],
          );
          updatedPinnedList = pinned;
        }
      }
    } catch (err) {
      console.error("[revokeMessage] Error unpinning from group:", err);
    }
  }

  return {
    conversationId,
    messageId: normalizedMessageId,
    revokedAt: new Date().toISOString(),
    revokedBy: userId,
    updatedPinnedList,
  };
}

module.exports = { revokeMessage };
