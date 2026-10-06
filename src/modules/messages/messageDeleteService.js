const { pool } = require("../../config/mysqlConfig");

/**
 * Marks a message as "deleted for me" for the given user.
 *
 * Mechanism: the userId is appended to the `deletedFor` array on the message
 * object stored in DynamoDB. The message itself is NOT modified or removed —
 * other participants still see it normally.
 *
 * @param {string} conversationId  - DynamoDB primary key (e.g. "channel:1" or "dm:1:2")
 * @param {string} messageId       - The `id` field of the target message inside the messages array
 * @param {string} userId         - The id of the requesting user (extracted from JWT)
 * @returns {Promise<object>}      - { conversationId, messageId, deletedFor: string[] }
 * @throws {Error} with code "BAD_REQUEST"     - missing conversationId or messageId
 * @throws {Error} with code "NOT_FOUND"       - conversation not found in DynamoDB
 * @throws {Error} with code "MESSAGE_NOT_FOUND" - no message with the given id in this conversation
 * @throws {Error} with code "ALREADY_DELETED_FOR_ME" - user already deleted this message
 */
async function deleteMessageForMe(conversationId, messageId, userId) {
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
  const normalizedUserId = String(userId);

  // 1. Fetch the conversation row
  let rows;
  try {
    [rows] = await pool.query(
      "SELECT messages FROM messages WHERE conversation_id = ? LIMIT 1",
      [conversationId],
    );
  } catch (dbError) {
    console.error("[messageDeleteService] MySQL SELECT failed:", dbError);
    const err = new Error("Failed to fetch conversation from database");
    err.code = "INTERNAL_ERROR";
    throw err;
  }

  if (!rows[0]) {
    const err = new Error(`Conversation "${conversationId}" not found`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const messages = Array.isArray(rows[0].messages)
    ? rows[0].messages.slice()
    : [];

  // 2. Locate the target message
  const msgIndex = messages.findIndex(
    (m) => String(m.id) === normalizedMessageId,
  );

  if (msgIndex === -1) {
    const err = new Error(
      `Message with id "${messageId}" not found in conversation "${conversationId}"`,
    );
    err.code = "MESSAGE_NOT_FOUND";
    throw err;
  }

  const targetMsg = messages[msgIndex];

  // 3. Initialize deletedFor array if not present
  const existingDeletedFor = Array.isArray(targetMsg.deletedFor)
    ? targetMsg.deletedFor
    : [];

  // 4. Idempotency: if user already deleted this message, return success
  //    instead of throwing an error, matching Zalo's UX.
  if (existingDeletedFor.map(String).includes(normalizedUserId)) {
    const err = new Error("You have already deleted this message for yourself");
    err.code = "ALREADY_DELETED_FOR_ME";
    throw err;
  }

  // 5. Append userId to deletedFor (ensure uniqueness)
  const updatedDeletedFor = [...new Set([...existingDeletedFor, normalizedUserId])];

  // 6. Update the message in-place within the messages array
  messages[msgIndex] = {
    ...targetMsg,
    deletedFor: updatedDeletedFor,
  };

  // 7. Persist the updated messages array back to MySQL
  try {
    await pool.query(
      `INSERT INTO messages (conversation_id, messages, updated_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE messages = VALUES(messages), updated_at = VALUES(updated_at)`,
      [conversationId, JSON.stringify(messages), new Date().toISOString()],
    );
  } catch (dbError) {
    console.error("[messageDeleteService] MySQL UPSERT failed:", dbError);
    const err = new Error("Failed to persist message deletion to database");
    err.code = "INTERNAL_ERROR";
    throw err;
  }

  return {
    conversationId,
    messageId: normalizedMessageId,
    deletedFor: updatedDeletedFor,
    deletedForMeAt: new Date().toISOString(),
  };
}

module.exports = { deleteMessageForMe };
