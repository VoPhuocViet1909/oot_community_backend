const { randomUUID } = require("crypto");
const { pool } = require("../../config/mysqlConfig");
const friendService = require("../users/friendService");
const userService = require("../users/userService");
const { saveMessage } = require("../messages/messageService");

const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const VALID_TYPES = new Set(["image", "text"]);

/* ─── row <-> app object mapping ─────────────────────────────────────────── */

function mapStoryRow(row) {
  if (!row) return null;
  return {
    storyId: row.story_id,
    userId: row.user_id,
    authorName: row.author_name,
    authorAvatar: row.author_avatar,
    type: row.type,
    text: row.text,
    mediaUrl: row.media_url,
    backgroundColor: row.background_color,
    textX: row.text_x,
    textY: row.text_y,
    textScale: row.text_scale,
    textRotation: row.text_rotation,
    isHighlighted: !!row.is_highlighted,
    highlightedAt: row.highlighted_at,
    likes: Array.isArray(row.likes) ? row.likes : [],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function normalizeStory(item) {
  return {
    ...item,
    isHighlighted: Boolean(item.isHighlighted),
    likes: Array.isArray(item.likes) ? item.likes : [],
    likeCount: Array.isArray(item.likes) ? item.likes.length : 0,
  };
}

async function createStory(userId, payload = {}) {
  const type = String(payload.type || "").trim().toLowerCase();
  const text = String(payload.text || "").trim();
  const mediaUrl = String(payload.mediaUrl || "").trim();
  const backgroundColor = String(payload.backgroundColor || "#2563EB").trim();
  const textX = Number.isFinite(Number(payload.textX)) ? Number(payload.textX) : 0;
  const textY = Number.isFinite(Number(payload.textY)) ? Number(payload.textY) : 0;
  const textScale = Number.isFinite(Number(payload.textScale)) ? Number(payload.textScale) : 1;
  const textRotation = Number.isFinite(Number(payload.textRotation)) ? Number(payload.textRotation) : 0;

  if (!VALID_TYPES.has(type)) throw new Error("Loại story không hợp lệ");
  if (type === "image" && !mediaUrl) throw new Error("Story ảnh cần có ảnh");
  if (type === "text" && !text) throw new Error("Story văn bản không được để trống");

  const user = await userService.getUserById(userId);
  if (!user) throw new Error("Không tìm thấy người dùng");

  const now = new Date();
  const item = {
    storyId: randomUUID(),
    userId: String(userId),
    authorName: user.display_name || user.username || "Người dùng",
    authorAvatar: user.avatar_url || null,
    type,
    text,
    mediaUrl: type === "image" ? mediaUrl : null,
    backgroundColor,
    textX,
    textY,
    textScale,
    textRotation,
    isHighlighted: false,
    highlightedAt: null,
    likes: [],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + STORY_LIFETIME_MS).toISOString(),
  };

  await pool.query(
    `INSERT INTO stories
      (story_id, user_id, author_name, author_avatar, type, text, media_url, background_color,
       text_x, text_y, text_scale, text_rotation, is_highlighted, highlighted_at, likes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.storyId,
      item.userId,
      item.authorName,
      item.authorAvatar,
      item.type,
      item.text,
      item.mediaUrl,
      item.backgroundColor,
      item.textX,
      item.textY,
      item.textScale,
      item.textRotation,
      item.isHighlighted ? 1 : 0,
      item.highlightedAt,
      JSON.stringify(item.likes),
      item.createdAt,
      item.expiresAt,
    ],
  );

  return normalizeStory(item);
}

async function getStory(storyId) {
  const [rows] = await pool.query(
    "SELECT * FROM stories WHERE story_id = ? LIMIT 1",
    [String(storyId)],
  );
  const story = mapStoryRow(rows[0]);
  return story ? normalizeStory(story) : null;
}

async function scanActiveStories() {
  const [rows] = await pool.query(
    "SELECT * FROM stories WHERE expires_at > ?",
    [new Date().toISOString()],
  );
  return rows.map(mapStoryRow).map(normalizeStory);
}

async function scanUserStories(userId) {
  const [rows] = await pool.query(
    "SELECT * FROM stories WHERE user_id = ?",
    [String(userId)],
  );
  return rows.map(mapStoryRow).map(normalizeStory);
}

async function getFeed(userId) {
  const friends = await friendService.getFriends(userId).catch(() => []);
  const allowedUserIds = new Set([
    String(userId),
    ...friends.map((friend) => String(friend.friend_id || friend.userId)),
  ]);
  const stories = (await scanActiveStories())
    .filter((story) => allowedUserIds.has(String(story.userId)))
    .sort((left, right) => {
      const leftIsMine = String(left.userId) === String(userId);
      const rightIsMine = String(right.userId) === String(userId);
      if (leftIsMine !== rightIsMine) return leftIsMine ? -1 : 1;
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });
  return { stories, count: stories.length };
}

async function getHighlights(userId) {
  const stories = (await scanUserStories(userId))
    .filter((story) => story.isHighlighted)
    .sort((left, right) =>
      new Date(right.highlightedAt || right.createdAt).getTime()
      - new Date(left.highlightedAt || left.createdAt).getTime());
  return { stories, count: stories.length };
}

async function getArchive(userId) {
  const stories = (await scanUserStories(userId))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  return { stories, count: stories.length };
}

async function toggleHighlight(storyId, userId) {
  const story = await getStory(storyId);
  if (!story) throw new Error("Không tìm thấy story");
  if (String(story.userId) !== String(userId)) {
    throw new Error("Bạn không có quyền ghim story này");
  }

  const isHighlighted = !story.isHighlighted;
  const highlightedAt = isHighlighted ? new Date().toISOString() : null;
  await pool.query(
    "UPDATE stories SET is_highlighted = ?, highlighted_at = ? WHERE story_id = ?",
    [isHighlighted ? 1 : 0, highlightedAt, String(storyId)],
  );

  return { ...story, isHighlighted, highlightedAt };
}

async function toggleLike(storyId, userId) {
  const story = await getStory(storyId);
  if (!story) throw new Error("Không tìm thấy story");

  const userIdString = String(userId);
  const alreadyLiked = story.likes.includes(userIdString);
  const likes = alreadyLiked
    ? story.likes.filter((id) => id !== userIdString)
    : [...story.likes, userIdString];

  await pool.query(
    "UPDATE stories SET likes = ? WHERE story_id = ?",
    [JSON.stringify(likes), String(storyId)],
  );

  return { ...story, likes, likeCount: likes.length, liked: !alreadyLiked };
}

function buildDmConversationId(leftUserId, rightUserId) {
  const ids = [String(leftUserId), String(rightUserId)];
  const areNumeric = ids.every((id) => Number.isFinite(Number(id)));
  return `dm:${ids.sort(areNumeric
    ? (left, right) => Number(left) - Number(right)
    : (left, right) => left.localeCompare(right)).join(":")}`;
}

async function replyToStory(storyId, senderId, content) {
  const story = await getStory(storyId);
  if (!story) throw new Error("Không tìm thấy story");
  const normalizedContent = String(content || "").trim();
  if (!normalizedContent) throw new Error("Tin nhắn không được để trống");
  if (String(story.userId) === String(senderId)) {
    throw new Error("Không thể tự trả lời story của chính mình");
  }

  return saveMessage({
    senderId: String(senderId),
    conversationId: buildDmConversationId(senderId, story.userId),
    contentType: "text",
    content: normalizedContent,
    storyReply: {
      storyId: story.storyId,
      authorName: story.authorName,
      type: story.type,
      text: story.text || "",
      mediaUrl: story.mediaUrl || null,
    },
  });
}

module.exports = {
  createStory,
  getFeed,
  getHighlights,
  getArchive,
  toggleHighlight,
  toggleLike,
  replyToStory,
};
