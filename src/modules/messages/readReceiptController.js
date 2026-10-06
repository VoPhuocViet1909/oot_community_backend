/**
 * Read Receipt Controller
 * Handles HTTP endpoints for read receipt operations
 */
const readReceiptService = require("./readReceiptService");
const messageService = require("./messageService");
const { pool } = require("../../config/mysqlConfig");

/**
 * Get read receipts for a specific message
 * GET /api/messages/read-receipts/:conversationId/:messageId
 */
async function getReadReceiptsForMessage(req, res) {
  try {
    const currentUserId = req.user?.userId ?? req.user?.id ?? null;
    const { conversationId, messageId } = req.params;

    if (!conversationId || !messageId) {
      return res.status(400).json({ message: "conversationId and messageId are required" });
    }

    const receipts = await readReceiptService.getReadReceiptsForMessage(conversationId, messageId);

    // Filter out the current user from the receipts list (they shouldn't see their own read receipt)
    const otherReaders = receipts.filter(r => String(r.userId) !== String(currentUserId));

    res.json({
      messageId,
      conversationId,
      readCount: otherReaders.length,
      readers: otherReaders.map(r => ({
        userId: r.userId,
        readerName: r.readerName,
        readerAvatar: r.readerAvatar,
        readAt: r.readAt,
      })),
    });
  } catch (error) {
    console.error("[readReceipts] Error getting receipts:", error.message);
    res.status(500).json({ message: error.message });
  }
}

/**
 * Get read status for multiple messages in a conversation
 * GET /api/messages/read-receipts/conversation/:conversationId?messageIds=id1,id2,id3
 */
async function getReadStatusForMessages(req, res) {
  try {
    const currentUserId = req.user?.userId ?? req.user?.id ?? null;
    const { conversationId } = req.params;
    const { messageIds } = req.query;

    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }

    if (!messageIds) {
      return res.status(400).json({ message: "messageIds query parameter is required" });
    }

    const messageIdList = messageIds.split(",").map(id => id.trim()).filter(Boolean);

    // Get read receipts for all messages
    const readStatusMap = {};

    for (const messageId of messageIdList) {
      const receipts = await readReceiptService.getReadReceiptsForMessage(conversationId, messageId);
      // Filter out current user and other readers
      const otherReaders = receipts.filter(r => String(r.userId) !== String(currentUserId));

      if (otherReaders.length > 0) {
        readStatusMap[messageId] = {
          isRead: true,
          readers: otherReaders.map(r => ({
            userId: r.userId,
            readerName: r.readerName,
            readerAvatar: r.readerAvatar,
            readAt: r.readAt,
          })),
        };
      } else {
        readStatusMap[messageId] = {
          isRead: false,
          readers: [],
        };
      }
    }

    res.json({
      conversationId,
      statuses: readStatusMap,
    });
  } catch (error) {
    console.error("[readReceipts] Error getting read statuses:", error.message);
    res.status(500).json({ message: error.message });
  }
}

/**
 * Get user's last read position in a conversation
 * GET /api/messages/read-receipts/last-read/:conversationId
 */
async function getLastReadPosition(req, res) {
  try {
    const currentUserId = req.user?.userId ?? req.user?.id ?? null;
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }

    const lastRead = await readReceiptService.getUserLastReadMessage(conversationId, currentUserId);

    if (!lastRead) {
      return res.json({
        conversationId,
        hasReadMessages: false,
        lastReadMessageId: null,
        lastReadAt: null,
      });
    }

    res.json({
      conversationId,
      hasReadMessages: true,
      lastReadMessageId: lastRead.messageId,
      lastReadAt: lastRead.readAt,
    });
  } catch (error) {
    console.error("[readReceipts] Error getting last read position:", error.message);
    res.status(500).json({ message: error.message });
  }
}

/**
 * Mark a message as read
 * POST /api/messages/read-receipts
 */
async function markAsRead(req, res) {
  try {
    const currentUserId = req.user?.userId ?? req.user?.id ?? null;
    const { conversationId, messageId } = req.body;

    if (!conversationId || !messageId) {
      return res.status(400).json({ message: "conversationId and messageId are required" });
    }

    if (!currentUserId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    // Get user display info
    const userInfo = await getUserDisplayInfo(currentUserId);

    // Save the read receipt
    const receipt = await readReceiptService.saveReadReceipt({
      conversationId,
      messageId: String(messageId),
      userId: String(currentUserId),
      readerName: userInfo.displayName,
      readerAvatar: userInfo.avatarUrl,
    });

    // Emit socket event to notify the sender
    const io = req.app.get("socketio");
    if (io) {
      const message = await getMessageInfo(conversationId, messageId);
      if (message) {
        const senderId = message.senderId;

        // For DMs, emit to the other participant
        if (conversationId.startsWith("dm:")) {
          const parts = conversationId.split(":");
          if (parts.length >= 3) {
            const recipientId = parts[1] === String(currentUserId) ? parts[2] : parts[1];
            io.to(`user:${recipientId}`).emit("message_read", {
              conversationId,
              messageId: String(messageId),
              readerId: String(currentUserId),
              readerName: userInfo.displayName,
              readerAvatar: userInfo.avatarUrl,
              readAt: receipt.readAt,
            });
          }
        } else {
          // For group chats, emit to the room
          io.to(conversationId).emit("message_read", {
            conversationId,
            messageId: String(messageId),
            readerId: String(currentUserId),
            readerName: userInfo.displayName,
            readerAvatar: userInfo.avatarUrl,
            readAt: receipt.readAt,
          });
        }
      }
    }

    res.status(201).json({
      success: true,
      receipt,
    });
  } catch (error) {
    console.error("[readReceipts] Error marking as read:", error.message);
    res.status(500).json({ message: error.message });
  }
}

/**
 * Helper: Get user display info
 */
async function getUserDisplayInfo(userId) {
  try {
    // Try to get from messageService user lookup if available
    if (typeof messageService.getUserInfo === "function") {
      const userInfo = await messageService.getUserInfo(userId);
      return {
        displayName: userInfo?.displayName || userInfo?.name || userId,
        avatarUrl: userInfo?.avatarUrl || userInfo?.avatar || userInfo?.avatar_url || null,
      };
    }

    // Fallback: get from users table directly
    const [rows] = await pool.query(
      "SELECT display_name, username, avatar_url FROM users WHERE user_id = ? LIMIT 1",
      [String(userId)],
    );

    if (rows[0]) {
      return {
        displayName: rows[0].display_name || rows[0].username || userId,
        avatarUrl: rows[0].avatar_url || null,
      };
    }

    return {
      displayName: userId,
      avatarUrl: null,
    };
  } catch (error) {
    console.warn(`[readReceipts] Could not get user info for ${userId}:`, error.message);
    return {
      displayName: userId,
      avatarUrl: null,
    };
  }
}

/**
 * Helper: Get message info (senderId)
 */
async function getMessageInfo(conversationId, messageId) {
  try {
    const messages = await messageService.getMessagesForConversation(conversationId, null);
    return messages.find(m => String(m.id || m.messageId) === String(messageId));
  } catch (error) {
    console.warn(`[readReceipts] Could not get message info:`, error.message);
    return null;
  }
}

module.exports = {
  getReadReceiptsForMessage,
  getReadStatusForMessages,
  getLastReadPosition,
  markAsRead,
};
