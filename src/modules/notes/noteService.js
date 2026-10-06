const { pool } = require("../../config/mysqlConfig");
const { saveMessage } = require("../messages/messageService");

function toString(value) {
  return String(value ?? "").trim();
}

async function isConversationMember(conversationId, userId) {
  const cid = toString(conversationId);
  const uid = toString(userId);
  if (!cid || !uid) return false;

  if (cid.startsWith("dm:")) {
    const parts = cid.split(":");
    return parts.length >= 3 && (parts[1] === uid || parts[2] === uid);
  }

  const groupId = cid.startsWith("channel:") ? cid.slice("channel:".length) : cid;
  const [rows] = await pool.query(
    "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1",
    [groupId, uid],
  );

  return rows.length > 0;
}

async function pinNoteMessage(conversationId, message, userId) {
  const pinData = {
    id: message.id,
    content: message.content,
    contentType: message.contentType,
    senderId: message.senderId,
    senderName: message.senderDisplayName || "Bạn",
    createdAt: message.createdAt,
  };

  if (conversationId.startsWith("dm:")) {
    const friendService = require("../users/friendService");
    const parts = conversationId.split(":");
    const record = await friendService.findExistingRecord(parts[1], parts[2]);
    if (!record) throw new Error("Không tìm thấy thông tin bạn bè");
    return friendService.pinMessage(record.friendshipId, pinData, userId);
  }

  const groupService = require("../groups/groupService");
  return groupService.pinMessage(conversationId, pinData, userId);
}

async function createNote({ conversationId, creatorId, content, pinToTop }) {
  const cid = toString(conversationId);
  const uid = toString(creatorId);
  const noteContent = toString(content);

  if (!cid) throw new Error("conversationId is required");
  if (!uid) throw new Error("creatorId is required");
  if (!noteContent) throw new Error("content is required");

  const isMember = await isConversationMember(cid, uid);
  if (!isMember) {
    const error = new Error("Bạn không có quyền tạo ghi chú trong cuộc trò chuyện này");
    error.status = 403;
    throw error;
  }

  const message = await saveMessage({
    conversationId: cid,
    senderId: uid,
    contentType: "note",
    content: noteContent,
  });

  let pinnedMessages = null;
  let pinError = null;

  if (pinToTop === true) {
    try {
      pinnedMessages = await pinNoteMessage(cid, message, uid);
    } catch (error) {
      pinError = error.message;
    }
  }

  return { note: message, message, pinnedMessages, pinError };
}

module.exports = {
  createNote,
};
