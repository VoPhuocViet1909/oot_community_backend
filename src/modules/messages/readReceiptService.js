/**
 * Read Receipts Service
 * Handles storing and retrieving read receipts for messages
 * Uses MySQL for persistence
 */
const { pool } = require("../../config/mysqlConfig");

/**
 * Look up a user's display_name/avatar_url from the users table.
 * read_receipts no longer stores a denormalized readerName/readerAvatar
 * (unlike the old DynamoDB item), so any receipt we read back enriches
 * from `users` to keep the same output shape callers expect.
 */
async function getUserBasicInfo(userId) {
  try {
    const [rows] = await pool.query(
      "SELECT display_name, username, avatar_url FROM users WHERE user_id = ? LIMIT 1",
      [String(userId)],
    );
    const u = rows[0];
    return {
      displayName: u?.display_name || u?.username || String(userId),
      avatarUrl: u?.avatar_url || null,
    };
  } catch {
    return { displayName: String(userId), avatarUrl: null };
  }
}

/**
 * Save a read receipt
 * @param {Object} data - { conversationId, messageId, userId, readerName, readerAvatar }
 *
 * NOTE on the read-receipt key-shape fix: the old DynamoDB key was
 * (conversationId, messageId) so a second reader's receipt overwrote the
 * first reader's receipt for the same message. The new MySQL PK is
 * (conversation_id, message_id, user_id), so every reader gets their own
 * row and this upsert only ever touches that one reader's row.
 */
async function saveReadReceipt(data) {
  const { conversationId, messageId, userId, readerName, readerAvatar } = data;

  if (!conversationId) {
    throw new Error("conversationId is required");
  }
  if (!messageId) {
    throw new Error("messageId is required");
  }
  if (!userId) {
    throw new Error("userId is required");
  }

  const readAt = new Date().toISOString();

  const receipt = {
    conversationId,
    messageId: String(messageId),
    userId: String(userId),
    readerName: readerName || null,
    readerAvatar: readerAvatar || null,
    readAt,
  };

  try {
    await pool.query(
      `INSERT INTO read_receipts (conversation_id, message_id, user_id, read_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE read_at = VALUES(read_at)`,
      [conversationId, receipt.messageId, receipt.userId, readAt],
    );

    console.log(`[readReceipts] Saved read receipt for message ${messageId} by user ${userId}`);
    return receipt;
  } catch (error) {
    console.error(`[readReceipts] Error saving read receipt:`, error.message);
    throw error;
  }
}

/**
 * Get read receipts for a specific message.
 * With the new (conversation_id, message_id, user_id) PK this naturally
 * returns ALL readers of the message (previously only ever a single,
 * possibly-wrong, receipt due to the old key-shape bug).
 * @param {string} conversationId
 * @param {string} messageId
 */
async function getReadReceiptsForMessage(conversationId, messageId) {
  if (!conversationId || !messageId) {
    return [];
  }

  try {
    const [rows] = await pool.query(
      "SELECT conversation_id, message_id, user_id, read_at FROM read_receipts WHERE conversation_id = ? AND message_id = ?",
      [conversationId, String(messageId)],
    );

    const enriched = await Promise.all(
      rows.map(async (row) => {
        const info = await getUserBasicInfo(row.user_id);
        return {
          conversationId: row.conversation_id,
          messageId: row.message_id,
          userId: row.user_id,
          readerName: info.displayName,
          readerAvatar: info.avatarUrl,
          readAt: row.read_at,
        };
      }),
    );

    return enriched;
  } catch (error) {
    console.error(`[readReceipts] Error getting receipts for message:`, error.message);
    return [];
  }
}

/**
 * Get the latest read receipt for a user in a conversation
 * This indicates the last message the user has read
 * @param {string} conversationId
 * @param {string} userId
 */
async function getUserLastReadMessage(conversationId, userId) {
  if (!conversationId || !userId) {
    return null;
  }

  try {
    const [rows] = await pool.query(
      `SELECT conversation_id, message_id, user_id, read_at
       FROM read_receipts
       WHERE conversation_id = ? AND user_id = ?
       ORDER BY read_at DESC
       LIMIT 1`,
      [conversationId, String(userId)],
    );

    if (!rows[0]) return null;

    return {
      conversationId: rows[0].conversation_id,
      messageId: rows[0].message_id,
      userId: rows[0].user_id,
      readAt: rows[0].read_at,
    };
  } catch (error) {
    console.error(`[readReceipts] Error getting last read message:`, error.message);
    return null;
  }
}

/**
 * Check if a user has read a specific message
 * @param {string} conversationId
 * @param {string} messageId
 * @param {string} userId
 */
async function hasUserReadMessage(conversationId, messageId, userId) {
  if (!conversationId || !messageId || !userId) {
    return false;
  }

  try {
    const [rows] = await pool.query(
      "SELECT 1 FROM read_receipts WHERE conversation_id = ? AND message_id = ? AND user_id = ? LIMIT 1",
      [conversationId, String(messageId), String(userId)],
    );

    return rows.length > 0;
  } catch (error) {
    console.warn(`[readReceipts] Error checking read status:`, error.message);
    return false;
  }
}

/**
 * Mark all messages in a conversation as read by a user
 * This updates the user's read cursor to the latest message
 * @param {string} conversationId
 * @param {string} messageId - The latest message the user has read
 * @param {string} userId
 * @param {string} readerName
 * @param {string} readerAvatar
 */
async function markConversationAsRead(conversationId, messageId, userId, readerName, readerAvatar) {
  return saveReadReceipt({
    conversationId,
    messageId: String(messageId),
    userId: String(userId),
    readerName,
    readerAvatar,
  });
}

module.exports = {
  saveReadReceipt,
  getReadReceiptsForMessage,
  getUserLastReadMessage,
  hasUserReadMessage,
  markConversationAsRead,
};
