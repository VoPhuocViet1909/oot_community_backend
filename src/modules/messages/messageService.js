const { pool } = require("../../config/mysqlConfig");
const { randomUUID } = require("crypto");
const { uploadBuffer } = require("../media/uploadService");
const { getGroupsForUser } = require("../groups/groupService");

// Bảng messages trong MySQL (primary key: conversation_id)
// Mỗi conversationId sẽ là 1 row chứa mảng messages (JSON column)
const BOT_AI_AVATAR_URL =
  process.env.BOT_AI_AVATAR_URL || "/botai-avatar.svg";

// conversationId vẫn giữ dạng "channel:1" hoặc "direct:1" để tương thích với API hiện tại

// Các giá trị contentType hợp lệ (backward compatible)
const VALID_CONTENT_TYPES = new Set([
  "text",
  "image",
  "file",
  "video",
  "emoji",
  "sticker",
  "system",
  // Loại tin nhắn vị trí — lưu tọa độ {lat, lng} dưới dạng locationData
  "location",
  // Loại tin nhắn bình chọn (poll)
  "poll",
  "reminder",
  "reminder_due",
  "note",
  // Call log entry — schema-only placeholder for future Agora call integration (Phase 2)
  // Stored in ott_messages with callData sub-document. No business logic here.
  "call_log",
  // Group call active message — system message when a group call starts
  "group_call_active",
]);

/**
 * Sanitize và chuẩn hóa contentType.
 * - Giá trị không hợp lệ → mặc định "text"
 * - Cho phép: text | image | file | video | emoji | sticker | system | location | poll | call_log
 */
function normalizeContentType(raw) {
  const ct = String(raw || "text")
    .toLowerCase()
    .trim();
  return VALID_CONTENT_TYPES.has(ct) ? ct : "text";
}

/**
 * Lấy mảng messages của một conversation từ MySQL.
 * @param {string} conversationId
 * @returns {Promise<Array|null>} mảng messages, hoặc null nếu conversation chưa tồn tại
 */
async function getConversationMessages(conversationId) {
  const [rows] = await pool.query(
    "SELECT messages FROM messages WHERE conversation_id = ? LIMIT 1",
    [conversationId],
  );
  if (!rows[0]) return null;
  return Array.isArray(rows[0].messages) ? rows[0].messages : [];
}

/**
 * Ghi lại toàn bộ mảng messages của một conversation (read-modify-write pattern).
 * @param {string} conversationId
 * @param {Array} messages
 */
async function putConversationMessages(conversationId, messages) {
  await pool.query(
    `INSERT INTO messages (conversation_id, messages, updated_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE messages = VALUES(messages), updated_at = VALUES(updated_at)`,
    [conversationId, JSON.stringify(messages), new Date().toISOString()],
  );
}

/**
 * Lấy thông tin cơ bản của tin nhắn gốc để hiển thị trong reply preview.
 * @param {string} conversationId - ID của cuộc trò chuyện
 * @param {string|number} replyToId - ID của tin nhắn cần trả lời
 * @returns {Promise<object|null>} - Thông tin cơ bản của tin nhắn gốc
 */
async function getRepliedMessageInfo(conversationId, replyToId) {
  if (!replyToId) return null;

  try {
    const existingMessages = await getConversationMessages(conversationId);

    if (!existingMessages) {
      return null;
    }

    const originalMessage = existingMessages.find(
      (msg) => String(msg.id) === String(replyToId),
    );

    if (!originalMessage) return null;

    const senderInfo = await enrichSenderInfo(originalMessage.senderId);

    return {
      id: originalMessage.id,
      content: originalMessage.content,
      contentType: originalMessage.contentType,
      senderId: originalMessage.senderId,
      senderDisplayName: senderInfo.senderDisplayName,
      senderAvatarUrl: senderInfo.senderAvatarUrl,
      attachments: originalMessage.attachments || null,
    };
  } catch (error) {
    console.error("[getRepliedMessageInfo] Error fetching replied message:", error.message);
    return null;
  }
}

/**
 * Validate dữ liệu sticker trước khi lưu.
 * stickerUrl hoặc stickerId phải có ít nhất 1 cái.
 * @param {object} stickerData - { stickerId?, stickerUrl?, stickerPack?, stickerName? }
 * @throws {Error} nếu dữ liệu sticker không hợp lệ
 */
function validateStickerData(stickerData) {
  if (!stickerData || typeof stickerData !== "object") {
    throw new Error("sticker data must be a non-null object");
  }
  if (!stickerData.stickerId && !stickerData.stickerUrl) {
    throw new Error("stickerId or stickerUrl is required for sticker messages");
  }
  // stickerUrl nếu có phải là URL hợp lệ
  if (stickerData.stickerUrl) {
    try {
      new URL(stickerData.stickerUrl);
    } catch {
      throw new Error("stickerUrl must be a valid URL");
    }
  }
}

/**
 * Validate dữ liệu emoji.
 * Emoji hợp lệ phải là chuỗi Unicode emoji (ít nhất 1 ký tự).
 * @param {string} content - chuỗi emoji
 * @throws {Error} nếu dữ liệu emoji không hợp lệ
 */
function validateEmojiData(content) {
  if (!content || typeof content !== "string" || !content.trim()) {
    throw new Error("emoji content is required and must be a non-empty string");
  }
  // Cho phép 1 emoji đơn hoặc chuỗi emoji (VD: "👍" hoặc "🎉🎊")
  // Chỉ cần non-empty string là đủ, không cần kiểm tra unicode sâu
}
async function enrichSenderInfo(senderId) {
  if (String(senderId) === "ai-bot") {
    return {
      senderDisplayName: "BotAI",
      senderAvatarUrl: BOT_AI_AVATAR_URL,
    };
  }

  try {
    const [rows] = await pool.query(
      "SELECT display_name, username, avatar_url FROM users WHERE user_id = ? LIMIT 1",
      [String(senderId)],
    );
    const u = rows[0];
    return {
      senderDisplayName: u?.display_name || u?.username || String(senderId),
      senderAvatarUrl: u?.avatar_url || null,
    };
  } catch {
    return { senderDisplayName: String(senderId), senderAvatarUrl: null };
  }
}

async function saveMessage(payload) {
  // ── Validate ──────────────────────────────────────────────
  if (!payload.conversationId) {
    throw new Error("conversationId is required");
  }
  if (!payload.senderId) {
    throw new Error("senderId is required");
  }

  const contentType = normalizeContentType(payload.contentType);

  // Emoji và sticker KHÔNG bắt buộc payload.content (chúng dùng sticker metadata riêng)
  if (contentType === "text" || contentType === "file") {
    if (!payload.content || !String(payload.content).trim()) {
      throw new Error("content is required for text/file messages");
    }
  }

  // Validate sticker metadata
  if (contentType === "sticker") {
    validateStickerData(payload.stickerData || {});
    // content của sticker = tên/ID để hiển thị, không dùng trim() rỗng
    if (!payload.content) {
      payload.content =
        payload.stickerData?.stickerId ||
        payload.stickerData?.stickerName ||
        "[sticker]";
    }
  }

  // Validate emoji
  if (contentType === "emoji") {
    validateEmojiData(payload.content);
  }

  // Validate poll: phải có pollData với pollOptions (tối thiểu 2 options)
  if (contentType === "poll") {
    const pollData = payload.pollData;
    if (!pollData || typeof pollData !== "object") {
      throw new Error("pollData là bắt buộc cho tin nhắn bình chọn");
    }
    if (!Array.isArray(pollData.pollOptions) || pollData.pollOptions.length < 2) {
      throw new Error("pollOptions phải có ít nhất 2 lựa chọn");
    }
    // Mỗi option phải có text
    for (const option of pollData.pollOptions) {
      if (!option.text || typeof option.text !== "string" || !option.text.trim()) {
        throw new Error("Mỗi lựa chọn bình chọn phải có nội dung text");
      }
    }
    // Content (question) là bắt buộc cho poll
    if (!payload.content || !String(payload.content).trim()) {
      throw new Error("content (câu hỏi bình chọn) là bắt buộc");
    }
  }

  // Validate location: phải có locationData với lat và lng hợp lệ
  if (contentType === "location") {
    const loc = payload.locationData;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      throw new Error("locationData với lat và lng (number) là bắt buộc cho tin nhắn vị trí");
    }
    // Content mặc định hiển thị tọa độ nếu không được truyền vào
    if (!payload.content) {
      payload.content = `📍 ${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
    }
  }

  const createdAt = new Date().toISOString();
  const id = Date.now();

  // Lấy thông tin tin nhắn gốc nếu có replyTo
  let replyTo = null;
  if (payload.replyTo) {
    replyTo = await getRepliedMessageInfo(payload.conversationId, payload.replyTo);
  }

  const newMessage = {
    id,
    senderId: payload.senderId,
    contentType,
    content: String(payload.content || "").trim(),
    // stickerData chỉ tồn tại khi contentType === "sticker"
    ...(contentType === "sticker" && payload.stickerData
      ? { stickerData: { ...payload.stickerData } }
      : {}),
    // locationData chỉ tồn tại khi contentType === "location" — lưu {lat, lng, label?, isLive?, liveUntil?}
    ...(contentType === "location" && payload.locationData
      ? {
          locationData: {
            lat: payload.locationData.lat,
            lng: payload.locationData.lng,
            label: payload.locationData.label || null,
            // Fields live location
            isLive: payload.locationData.isLive === true,
            liveUntil: payload.locationData.liveUntil || null,
          },
        }
      : {}),
    // pollData chỉ tồn tại khi contentType === "poll" — lưu pollOptions và pollSettings
    ...(contentType === "poll" && payload.pollData
      ? {
          pollData: {
            pollOptions: payload.pollData.pollOptions.map((opt) => ({
              id: opt.id || String(Date.now() + Math.random()),
              text: String(opt.text).trim(),
              voterIds: Array.isArray(opt.voterIds) ? opt.voterIds : [],
            })),
            pollSettings: {
              multipleChoice: payload.pollData.pollSettings?.multipleChoice === true,
              allowAddOption: payload.pollData.pollSettings?.allowAddOption === true,
            },
          },
        }
      : {}),
    ...(payload.reminderData
      ? {
          reminderData: {
            reminderId: String(payload.reminderData.reminderId || ""),
            remindAt: payload.reminderData.remindAt || null,
            repeat: payload.reminderData.repeat || "none",
            status: payload.reminderData.status || "active",
          },
        }
      : {}),
    // callData chỉ tồn tại khi contentType === "call_log" — lưu metadata cuộc gọi
    ...((contentType === "call_log" || contentType === "group_call_active") && payload.callData
      ? { callData: { ...payload.callData } }
      : {}),
    attachments: payload.attachments || null,
    reactions: payload.reactions || null,
    storyReply: payload.storyReply || null,
    // replyTo: lưu ID của tin nhắn gốc đang được trả lời
    replyTo: payload.replyTo || null,
    mentions: Array.isArray(payload.mentions) ? payload.mentions.map(String) : [],
    createdAt,
  };

  // Lấy conversation hiện tại (nếu có)
  const existingMessages = await getConversationMessages(payload.conversationId);
  const messages = existingMessages ? existingMessages.slice() : [];
  messages.push(newMessage);

  await putConversationMessages(payload.conversationId, messages);

  return {
    id: newMessage.id,
    conversationId: payload.conversationId,
    senderId: newMessage.senderId,
    contentType: newMessage.contentType,
    content: newMessage.content,
    ...(newMessage.stickerData ? { stickerData: newMessage.stickerData } : {}),
    // Trả về locationData để frontend render bản đồ
    ...(newMessage.locationData ? { locationData: newMessage.locationData } : {}),
    // Trả về pollData để frontend hiển thị bình chọn
    ...(newMessage.pollData ? { pollData: newMessage.pollData } : {}),
    ...(newMessage.callData ? { callData: newMessage.callData } : {}),
    ...(newMessage.reminderData ? { reminderData: newMessage.reminderData } : {}),
    attachments: newMessage.attachments,
    reactions: newMessage.reactions,
    storyReply: newMessage.storyReply,
    replyTo: newMessage.replyTo,
    mentions: newMessage.mentions,
    // Trả về đầy đủ thông tin replyTo đã populate để frontend hiển thị
    ...(replyTo ? { replyToMessage: replyTo } : {}),
    createdAt: newMessage.createdAt,
  };
}

async function getMessagesForConversation(conversationId, currentUserId) {
  if (!conversationId) return [];

  const existingMessages = await getConversationMessages(conversationId);

  if (!existingMessages) {
    return [];
  }

  // Filter out messages this user has hidden via "delete for me"
  let messages = existingMessages;
  if (currentUserId) {
    messages = messages.filter(
      (msg) => !msg.deletedFor?.map(String).includes(String(currentUserId)),
    );
  }

  // Sort by createdAt ascending
  messages = messages.slice().sort((a, b) => {
    const aTime = a.createdAt || "";
    const bTime = b.createdAt || "";
    return aTime.localeCompare(bTime);
  });

  // Build a map of messageId -> message for quick lookup of replied messages
  const messageMap = new Map();
  messages.forEach((msg) => {
    messageMap.set(String(msg.id), msg);
  });

  // Enrich mỗi tin nhắn với displayName/avatarUrl của người gửi và thông tin replyTo
  const enriched = await Promise.all(
    messages.map(async (msg) => {
      const info = await enrichSenderInfo(msg.senderId);

      // Lấy thông tin tin nhắn gốc nếu có replyTo
      let replyToMessage = null;
      if (msg.replyTo) {
        const repliedMsg = messageMap.get(String(msg.replyTo));
        if (repliedMsg) {
          const repliedSenderInfo = await enrichSenderInfo(repliedMsg.senderId);
          replyToMessage = {
            id: repliedMsg.id,
            content: repliedMsg.content,
            contentType: repliedMsg.contentType,
            senderId: repliedMsg.senderId,
            senderDisplayName: repliedSenderInfo.senderDisplayName,
            senderAvatarUrl: repliedSenderInfo.senderAvatarUrl,
            attachments: repliedMsg.attachments || null,
          };
        }
      }

      return {
        id: msg.id,
        conversationId,
        senderId: msg.senderId,
        contentType: msg.contentType,
        content: msg.content,
        ...(msg.stickerData ? { stickerData: msg.stickerData } : {}),
        // locationData được giữ nguyên khi đọc lại từ DB
        ...(msg.locationData ? { locationData: msg.locationData } : {}),
        // pollData được giữ nguyên khi đọc lại từ DB
        ...(msg.pollData ? { pollData: msg.pollData } : {}),
        ...(msg.callData ? { callData: msg.callData } : {}),
        ...(msg.reminderData ? { reminderData: msg.reminderData } : {}),
        attachments: msg.attachments || null,
        reactions: msg.reactions || null,
        storyReply: msg.storyReply || null,
        replyTo: msg.replyTo || null,
        mentions: msg.mentions || [],
        createdAt: msg.createdAt,
        senderDisplayName: info.senderDisplayName,
        senderAvatarUrl: info.senderAvatarUrl,
        // Trả về đầy đủ thông tin replyTo đã populate
        ...(replyToMessage ? { replyToMessage } : {}),
      };
    }),
  );

  return enriched;
}

function resolveAttachmentType(mimetype, originalname) {
  if (mimetype) {
    if (mimetype.startsWith("image/")) return "image";
    if (mimetype.startsWith("video/")) return "video";
    if (mimetype.startsWith("audio/")) return "voice";
  }
  
  if (originalname) {
    const ext = String(originalname).split('.').pop().toLowerCase();
    if (['wav', 'mp3', 'm4a', 'aac', 'webm', 'ogg'].includes(ext)) return "voice";
    if (['mp4', 'mov', 'avi'].includes(ext)) return "video";
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return "image";
  }
  
  return "file";
}

async function uploadFileToS3(file) {
  if (!file) {
    throw new Error("file is required");
  }

  const { url } = await uploadBuffer({
    buffer: file.buffer,
    keyPrefix: "messages",
    contentType: file.mimetype,
  });

  return {
    url,
    mimetype: file.mimetype,
    size: file.size,
    originalname: file.originalname,
  };
}

async function saveFileMessage(data) {
  const senderId = data.sender_id || data.senderId;
  const receiverId = data.receiver_id || data.receiverId || null;
  const channelId = data.channel_id || data.channelId || null;
  const groupId = data.group_id || data.groupId || data.roomId || data.conversationId || null;

  if (!senderId) {
    throw new Error("sender_id is required");
  }
  if (!receiverId && !channelId && !groupId) {
    throw new Error("receiver_id, channel_id, or group_id is required");
  }
  if (!data.attachment || !data.attachment.url) {
    throw new Error("attachment metadata is required");
  }

  const conversationId = groupId
    ? groupId
    : channelId
    ? `channel:${channelId}`
    : `dm:${[String(senderId), String(receiverId)].sort((a, b) => Number(a) - Number(b)).join(":")}`;

  const attachmentType = resolveAttachmentType(data.attachment.mimetype, data.attachment.originalname);
  const messageType = attachmentType;
  const persistedMessageId = randomUUID();
  const createdAt = new Date().toISOString();

  const fileMessage = {
    id: persistedMessageId,
    senderId,
    contentType: messageType,
    content: data.attachment.originalname || "[file]",
    attachments: [
      {
        url: data.attachment.url,
        type: attachmentType,
        size: data.attachment.size,
      },
    ],
    reactions: null,
    createdAt,
  };

  // Ưu tiên lưu đồng nhất với saveMessage để không lệch schema dữ liệu.
  const existingMessages = await getConversationMessages(conversationId);
  const messages = existingMessages ? existingMessages.slice() : [];
  messages.push(fileMessage);

  await putConversationMessages(conversationId, messages);

  const item = {
    id: persistedMessageId,
    message_id: persistedMessageId,
    conversation_id: conversationId,
    sender_id: senderId,
    receiver_id: receiverId,
    channel_id: channelId,
    attachments: [
      {
        url: data.attachment.url,
        type: attachmentType,
        size: data.attachment.size,
      },
    ],
    type: messageType,
    created_at: createdAt,
  };

  return item;
}
async function saveStickerMessage(data) {
  const senderId = data.senderId;
  const conversationId = data.conversationId;

  if (!senderId) {
    throw new Error("senderId is required");
  }
  if (!conversationId) {
    throw new Error("conversationId is required");
  }
  validateStickerData(data.stickerData || {});

  return saveMessage({
    senderId,
    conversationId,
    contentType: "sticker",
    content:
      data.stickerData?.stickerName ||
      data.stickerData?.stickerId ||
      "[sticker]",
    stickerData: data.stickerData,
  });
}

function toLowerSafe(value) {
  return String(value ?? "").toLowerCase();
}

function normalizeDateInput(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateBoundary(value, bound) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const suffix = bound === "end" ? "T23:59:59.999" : "T00:00:00.000";
    const date = new Date(`${raw}${suffix}`);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime();
}

function getMessageTimeMs(message) {
  const createdAt = normalizeDateInput(message?.createdAt);
  return createdAt ? createdAt.getTime() : null;
}

function messageMatchesSearchFilters(message, { keyword, senderId, fromMs, toMs }) {
  if (senderId && String(message.senderId) !== senderId) {
    return false;
  }

  const createdAtMs = getMessageTimeMs(message);
  if ((fromMs != null || toMs != null) && createdAtMs == null) {
    return false;
  }
  if (fromMs != null && createdAtMs != null && createdAtMs < fromMs) {
    return false;
  }
  if (toMs != null && createdAtMs != null && createdAtMs > toMs) {
    return false;
  }

  if (!keyword) return true;
  return toLowerSafe(buildSearchHaystack(message)).includes(keyword);
}

function isDmConversationAccessible(conversationId, userId) {
  if (!conversationId.startsWith("dm:")) return false;
  const parts = conversationId.slice(3).split(":").map((p) => String(p).trim());
  if (parts.length !== 2) return false;
  return parts.includes(String(userId));
}

function buildSearchHaystack(message) {
  const attachmentText = Array.isArray(message.attachments)
    ? message.attachments
        .map((attachment) => [attachment?.name, attachment?.url, attachment?.type]
          .filter(Boolean)
          .join(" "))
        .join(" ")
    : "";

  const stickerText = message.stickerData
    ? [message.stickerData.stickerId, message.stickerData.stickerName, message.stickerData.stickerPack]
        .filter(Boolean)
        .join(" ")
    : "";

  return [
    message.content,
    message.contentType,
    message.senderDisplayName,
    message.senderUsername,
    attachmentText,
    stickerText,
  ]
    .filter(Boolean)
    .join(" ");
}

async function searchMessagesInConversation({
  conversationId,
  keyword,
  senderId,
  fromDate,
  toDate,
  limit = 50,
  currentUserId,
}) {
  if (!conversationId) {
    throw new Error("conversationId is required");
  }

  const existingMessages = await getConversationMessages(conversationId);

  let messages = existingMessages ? existingMessages.slice() : [];

  if (currentUserId) {
    messages = messages.filter(
      (msg) => !msg.deletedFor?.map(String).includes(String(currentUserId)),
    );
  }

  const normalizedKeyword = toLowerSafe(keyword).trim();
  const normalizedSenderId = senderId != null && String(senderId).trim() !== ""
    ? String(senderId).trim()
    : "";
  const fromMs = parseDateBoundary(fromDate, "start");
  const toMs = parseDateBoundary(toDate, "end");

  let filtered = messages.filter((msg) => {
    return messageMatchesSearchFilters(msg, {
      keyword: normalizedKeyword,
      senderId: normalizedSenderId,
      fromMs,
      toMs,
    });
  });

  filtered = filtered
    .slice()
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));

  const maxResults = Math.max(1, Math.min(Number(limit) || 50, 200));
  const paged = filtered.slice(0, maxResults);

  const enriched = await Promise.all(
    paged.map(async (msg) => {
      const info = await enrichSenderInfo(msg.senderId);
      return {
        id: msg.id,
        conversationId,
        senderId: msg.senderId,
        contentType: msg.contentType,
        content: msg.content,
        ...(msg.stickerData ? { stickerData: msg.stickerData } : {}),
        ...(msg.pollData ? { pollData: msg.pollData } : {}),
        ...(msg.reminderData ? { reminderData: msg.reminderData } : {}),
        attachments: msg.attachments || null,
        reactions: msg.reactions || null,
        createdAt: msg.createdAt,
        senderDisplayName: info.senderDisplayName,
        senderAvatarUrl: info.senderAvatarUrl,
      };
    }),
  );

  return {
    conversationId,
    keyword: normalizedKeyword,
    filters: {
      senderId: normalizedSenderId || null,
      fromDate: fromDate || null,
      toDate: toDate || null,
      limit: maxResults,
    },
    count: enriched.length,
    data: enriched,
  };
}

async function searchMessagesForUserGlobal({
  keyword,
  fromDate,
  toDate,
  limit = 50,
  currentUserId,
}) {
  if (!currentUserId) {
    throw new Error("currentUserId is required");
  }

  const userId = String(currentUserId);
  const normalizedKeyword = toLowerSafe(keyword).trim();
  const fromMs = parseDateBoundary(fromDate, "start");
  const toMs = parseDateBoundary(toDate, "end");
  const maxResults = Math.max(1, Math.min(Number(limit) || 50, 200));

  let userGroups = [];
  try {
    userGroups = await getGroupsForUser(userId);
  } catch {
    userGroups = [];
  }
  const allowedGroupIds = new Set(
    (userGroups || []).map((group) => String(group.groupId || "")).filter(Boolean),
  );

  const rows = [];
  const [conversationRows] = await pool.query(
    "SELECT conversation_id, messages FROM messages",
  );

  for (const item of conversationRows || []) {
    const conversationId = String(item?.conversation_id || "").trim();
    if (!conversationId) continue;

    const accessible = conversationId.startsWith("dm:")
      ? isDmConversationAccessible(conversationId, userId)
      : allowedGroupIds.has(conversationId);

    if (!accessible) continue;

    const messages = Array.isArray(item.messages) ? item.messages : [];
    for (const msg of messages) {
      if (msg?.deletedFor?.map(String).includes(userId)) {
        continue;
      }

      const match = messageMatchesSearchFilters(msg, {
        keyword: normalizedKeyword,
        senderId: "",
        fromMs,
        toMs,
      });
      if (!match) continue;

      rows.push({ ...msg, conversationId });
    }
  }

  rows.sort((a, b) => {
    const aMs = getMessageTimeMs(a) || 0;
    const bMs = getMessageTimeMs(b) || 0;
    return bMs - aMs;
  });

  const paged = rows.slice(0, maxResults);
  const enriched = await Promise.all(
    paged.map(async (msg) => {
      const info = await enrichSenderInfo(msg.senderId);
      return {
        id: msg.id,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        contentType: msg.contentType,
        content: msg.content,
        ...(msg.stickerData ? { stickerData: msg.stickerData } : {}),
        ...(msg.pollData ? { pollData: msg.pollData } : {}),
        attachments: msg.attachments || null,
        reactions: msg.reactions || null,
        createdAt: msg.createdAt,
        senderDisplayName: info.senderDisplayName,
        senderAvatarUrl: info.senderAvatarUrl,
      };
    }),
  );

  return {
    keyword: normalizedKeyword,
    filters: {
      fromDate: fromDate || null,
      toDate: toDate || null,
      limit: maxResults,
    },
    count: enriched.length,
    data: enriched,
  };
}

function resolveTimeRangeBounds(timeRange) {
  const now = new Date();
  const normalized = String(timeRange || "").trim().toLowerCase();

  if (!normalized) {
    return {};
  }

  if (normalized === "morning") {
    const from = new Date(now);
    from.setHours(5, 0, 0, 0);
    const to = new Date(now);
    to.setHours(11, 59, 59, 999);
    return { fromDate: from.toISOString(), toDate: to.toISOString() };
  }

  const lastHoursMatch = normalized.match(/^last_(\d+)_hours$/);
  if (lastHoursMatch) {
    const hours = Number(lastHoursMatch[1] || 0);
    if (hours > 0) {
      const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
      return { fromDate: from.toISOString(), toDate: now.toISOString() };
    }
  }

  return {};
}

async function fetchMessages({
  conversationId,
  timeRange,
  focus,
  currentUserId,
  limit = 30,
}) {
  const bounds = resolveTimeRangeBounds(timeRange);
  const messages = await getMessagesForConversation(conversationId, currentUserId);
  let data = messages.slice();

  if (bounds.fromDate || bounds.toDate) {
    const fromMs = bounds.fromDate ? new Date(bounds.fromDate).getTime() : null;
    const toMs = bounds.toDate ? new Date(bounds.toDate).getTime() : null;

    data = data.filter((item) => {
      const createdMs = item?.createdAt ? new Date(item.createdAt).getTime() : null;
      if (createdMs == null) return false;
      if (fromMs != null && createdMs < fromMs) return false;
      if (toMs != null && createdMs > toMs) return false;
      return true;
    });
  }

  data = data.slice(-Math.max(1, Math.min(Number(limit) || 30, 50)));

  return {
    conversationId,
    timeRange: timeRange || null,
    focus: focus || "general",
    count: data.length,
    data,
  };
}
/**
 * Dừng phên chia sẻ vị trí trực tiếp.
 * Cập nhật field locationData.isLive = false và locationData.liveUntil = now
 * cho tin nhắn tương ứng trong DynamoDB.
 *
 * @param {string} conversationId - ID phòng
 * @param {string|number} messageId - ID tin nhắn live location
 * @param {string} stoppedAt - ISO string thời điểm dừng
 * @returns {Promise<object|null>} tin nhắn đã cập nhật, hoặc null nếu không tìm thấy
 */
async function stopLiveLocationMessage(conversationId, messageId, stoppedAt) {
  if (!conversationId || !messageId) {
    throw new Error("conversationId và messageId là bắt buộc");
  }

  const existingMessages = await getConversationMessages(conversationId);

  if (!existingMessages) {
    return null;
  }

  const messages = existingMessages.slice();
  const idx = messages.findIndex((m) => String(m.id) === String(messageId));
  if (idx === -1) return null;

  const msg = messages[idx];
  if (!msg.locationData) return null;

  // Cập nhật in-place
  messages[idx] = {
    ...msg,
    locationData: {
      ...msg.locationData,
      isLive: false,
      liveUntil: stoppedAt || new Date().toISOString(),
    },
  };

  // Ghi lại toàn bộ mảng messages
  await putConversationMessages(conversationId, messages);

  return messages[idx];
}

/**
 * Mark a group_call_active message as ended when the group call finishes.
 * Finds the message by callId in callData, sets callStatus to "ended" and endedAt.
 *
 * IDEMPOTENT: if message already marked ended, returns it without writing.
 *
 * @param {string} conversationId
 * @param {string} callId - The group call session ID
 * @param {string} [endedAt] - ISO timestamp (defaults to now)
 * @returns {Promise<Object|null>} The updated message or null if not found
 */
async function markGroupCallActiveMessageEnded(conversationId, callId, endedAt) {
  if (!conversationId || !callId) return null;

  const existingMessages = await getConversationMessages(conversationId);

  if (!existingMessages) {
    return null;
  }

  const messages = existingMessages.slice();
  const idx = messages.findIndex(
    (m) => m.contentType === "group_call_active" && m.callData?.callId === callId,
  );
  if (idx === -1) return null;

  const msg = messages[idx];
  if (!msg.callData) return null;

  // Idempotent: already ended
  if (msg.callData.callStatus === "ended") return msg;

  const now = endedAt || new Date().toISOString();

  // Update in-place
  messages[idx] = {
    ...msg,
    content: "Cuộc gọi nhóm đã kết thúc",
    callData: {
      ...msg.callData,
      callStatus: "ended",
      endedAt: now,
    },
  };

  // Write back full messages array
  await putConversationMessages(conversationId, messages);

  // Broadcast message update realtime
  try {
    const { getIO } = require("../../socket/socketHandler");
    const io = getIO();
    if (io) {
      const updatedMessage = messages[idx];
      console.log(`[message:updated] Broadcasting update to room ${conversationId}`, updatedMessage.id);
      io.to(conversationId).emit("message:updated", {
        conversationId,
        messageId: String(updatedMessage.id),
        contentType: updatedMessage.contentType,
        content: updatedMessage.content,
        callData: updatedMessage.callData,
        updatedAt: updatedMessage.callData?.endedAt || now,
      });
    }
  } catch (emitErr) {
    console.error("[message:updated] Failed to broadcast:", emitErr.message);
  }

  return messages[idx];
}

module.exports = {
  saveMessage,
  saveStickerMessage,
  getMessagesForConversation,
  getRepliedMessageInfo,
  uploadFileToS3,
  saveFileMessage,
  searchMessagesInConversation,
  searchMessagesForUserGlobal,
  fetchMessages,
  stopLiveLocationMessage,
  markGroupCallActiveMessageEnded,
  enrichSenderInfo,
};
