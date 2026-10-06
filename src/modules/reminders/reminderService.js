const { randomUUID } = require("crypto");
const { pool } = require("../../config/mysqlConfig");
const { saveMessage, enrichSenderInfo } = require("../messages/messageService");

const VALID_REPEAT = new Set(["none", "daily", "weekly", "monthly"]);
const VALID_STATUS = new Set(["active", "completed", "cancelled"]);

function toString(value) {
  return String(value ?? "").trim();
}

function normalizeRepeat(value) {
  const repeat = toString(value).toLowerCase() || "none";
  return VALID_REPEAT.has(repeat) ? repeat : "none";
}

function parseRemindAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("remindAt không hợp lệ");
  }
  if (date.getTime() <= Date.now()) {
    throw new Error("remindAt phải ở tương lai");
  }
  return date;
}

function formatReminderTime(date) {
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildReminderMessageContent(content, remindAt, repeat) {
  const repeatText =
    repeat === "daily"
      ? "Lặp lại hằng ngày"
      : repeat === "weekly"
        ? "Lặp lại hằng tuần"
        : repeat === "monthly"
          ? "Lặp lại hằng tháng"
          : "Không lặp lại";

  return `[Nhắc hẹn]\n${content}\nThời gian: ${formatReminderTime(remindAt)}\nLặp lại: ${repeatText}`;
}

/* ─── row <-> app object mapping ─────────────────────────────────────────── */

function mapReminderRow(row) {
  if (!row) return null;
  return {
    reminderId: row.reminder_id,
    conversationId: row.conversation_id,
    creatorId: row.creator_id,
    content: row.content,
    remindAt: row.remind_at,
    repeat: row.repeat_rule,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTriggeredAt: row.last_triggered_at,
    messageId: row.message_id,
  };
}

// The `reminders` table is provisioned at boot via schema.sql/initSchema.js;
// kept as a no-op so existing callers (e.g. reminderScheduler) don't break.
async function ensureRemindersTable() {
  return Promise.resolve();
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

async function createReminder({
  conversationId,
  creatorId,
  content,
  remindAt,
  repeat,
}) {
  const cid = toString(conversationId);
  const uid = toString(creatorId);
  const reminderContent = toString(content);
  if (!cid) throw new Error("conversationId is required");
  if (!uid) throw new Error("creatorId is required");
  if (!reminderContent) throw new Error("content is required");

  const isMember = await isConversationMember(cid, uid);
  if (!isMember) {
    const error = new Error("Bạn không có quyền tạo nhắc hẹn trong cuộc trò chuyện này");
    error.status = 403;
    throw error;
  }

  const remindDate = parseRemindAt(remindAt);
  const normalizedRepeat = normalizeRepeat(repeat);
  const now = new Date().toISOString();
  const reminderId = randomUUID();

  const reminder = {
    reminderId,
    conversationId: cid,
    creatorId: uid,
    content: reminderContent,
    remindAt: remindDate.toISOString(),
    repeat: normalizedRepeat,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastTriggeredAt: null,
    messageId: null,
  };

  const message = await saveMessage({
    conversationId: cid,
    senderId: uid,
    contentType: "reminder",
    content: buildReminderMessageContent(
      reminderContent,
      remindDate,
      normalizedRepeat,
    ),
    reminderData: {
      reminderId,
      remindAt: reminder.remindAt,
      repeat: normalizedRepeat,
      status: "active",
    },
  });

  reminder.messageId = String(message.id);

  await pool.query(
    `INSERT INTO reminders
      (reminder_id, conversation_id, creator_id, content, remind_at, repeat_rule, status, created_at, updated_at, last_triggered_at, message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reminder.reminderId,
      reminder.conversationId,
      reminder.creatorId,
      reminder.content,
      reminder.remindAt,
      reminder.repeat,
      reminder.status,
      reminder.createdAt,
      reminder.updatedAt,
      reminder.lastTriggeredAt,
      reminder.messageId,
    ],
  );

  return { reminder, message };
}

async function listReminders({ userId, conversationId, status }) {
  const uid = toString(userId);
  const cid = toString(conversationId);
  const normalizedStatus = toString(status).toLowerCase();

  const whereClauses = [];
  const params = [];
  if (cid) {
    whereClauses.push("conversation_id = ?");
    params.push(cid);
  }
  if (normalizedStatus && VALID_STATUS.has(normalizedStatus)) {
    whereClauses.push("status = ?");
    params.push(normalizedStatus);
  }

  const sql = `SELECT * FROM reminders${whereClauses.length ? ` WHERE ${whereClauses.join(" AND ")}` : ""}`;
  const [dbRows] = await pool.query(sql, params);

  const rows = [];
  for (const dbRow of dbRows) {
    const item = mapReminderRow(dbRow);
    if (!(await isConversationMember(item.conversationId, uid))) continue;
    rows.push(item);
  }

  return rows.sort((a, b) => String(a.remindAt).localeCompare(String(b.remindAt)));
}

async function getReminder(reminderId, userId) {
  const [rows] = await pool.query(
    "SELECT * FROM reminders WHERE reminder_id = ? LIMIT 1",
    [toString(reminderId)],
  );
  const reminder = mapReminderRow(rows[0]);
  if (!reminder) return null;

  if (!(await isConversationMember(reminder.conversationId, userId))) {
    const error = new Error("Bạn không có quyền xem nhắc hẹn này");
    error.status = 403;
    throw error;
  }

  return reminder;
}

async function updateReminder(reminderId, userId, patch) {
  const existing = await getReminder(reminderId, userId);
  if (!existing) return null;
  if (String(existing.creatorId) !== String(userId)) {
    const error = new Error("Chỉ người tạo mới được sửa nhắc hẹn");
    error.status = 403;
    throw error;
  }

  const next = { ...existing };
  if (patch.content !== undefined) {
    const content = toString(patch.content);
    if (!content) throw new Error("content is required");
    next.content = content;
  }
  if (patch.remindAt !== undefined) {
    next.remindAt = parseRemindAt(patch.remindAt).toISOString();
  }
  if (patch.repeat !== undefined) {
    next.repeat = normalizeRepeat(patch.repeat);
  }
  if (patch.status !== undefined) {
    const status = toString(patch.status).toLowerCase();
    if (!VALID_STATUS.has(status)) throw new Error("status không hợp lệ");
    next.status = status;
  }
  next.updatedAt = new Date().toISOString();

  await pool.query(
    `UPDATE reminders
     SET content = ?, remind_at = ?, repeat_rule = ?, status = ?, updated_at = ?
     WHERE reminder_id = ?`,
    [next.content, next.remindAt, next.repeat, next.status, next.updatedAt, toString(reminderId)],
  );

  return next;
}

async function cancelReminder(reminderId, userId) {
  const existing = await getReminder(reminderId, userId);
  if (!existing) return null;
  if (String(existing.creatorId) !== String(userId)) {
    const error = new Error("Chỉ người tạo mới được hủy nhắc hẹn");
    error.status = 403;
    throw error;
  }

  await pool.query(
    "UPDATE reminders SET status = ?, updated_at = ? WHERE reminder_id = ?",
    ["cancelled", new Date().toISOString(), toString(reminderId)],
  );

  return { ...existing, status: "cancelled" };
}

async function findDueReminders(now = new Date()) {
  const [rows] = await pool.query(
    "SELECT * FROM reminders WHERE status = ? AND remind_at <= ?",
    ["active", now.toISOString()],
  );

  return rows.map(mapReminderRow);
}

async function markReminderFiring(reminderId) {
  const [result] = await pool.query(
    "UPDATE reminders SET status = ?, updated_at = ? WHERE reminder_id = ? AND status = ?",
    ["firing", new Date().toISOString(), toString(reminderId), "active"],
  );
  return result.affectedRows === 1;
}

function nextRepeatTime(reminder) {
  if (reminder.repeat === "none") return null;

  const next = new Date(reminder.remindAt);
  const now = Date.now();
  do {
    if (reminder.repeat === "daily") next.setDate(next.getDate() + 1);
    if (reminder.repeat === "weekly") next.setDate(next.getDate() + 7);
    if (reminder.repeat === "monthly") next.setMonth(next.getMonth() + 1);
  } while (next.getTime() <= now);

  return next.toISOString();
}

async function completeTriggeredReminder(reminder) {
  const nextRemindAt = nextRepeatTime(reminder);
  const now = new Date().toISOString();

  if (nextRemindAt) {
    await pool.query(
      `UPDATE reminders
       SET status = ?, remind_at = ?, last_triggered_at = ?, updated_at = ?
       WHERE reminder_id = ?`,
      ["active", nextRemindAt, now, now, toString(reminder.reminderId)],
    );
    return;
  }

  await pool.query(
    `UPDATE reminders
     SET status = ?, last_triggered_at = ?, updated_at = ?
     WHERE reminder_id = ?`,
    ["completed", now, now, toString(reminder.reminderId)],
  );
}

async function buildReminderDueMessage(reminder) {
  const senderInfo = await enrichSenderInfo(reminder.creatorId);
  return {
    id: `reminder-due-${reminder.reminderId}-${Date.now()}`,
    conversationId: reminder.conversationId,
    senderId: reminder.creatorId,
    senderDisplayName: senderInfo.senderDisplayName,
    senderAvatarUrl: senderInfo.senderAvatarUrl,
    contentType: "reminder_due",
    content: `[Đến giờ nhắc hẹn]\n${reminder.content}\nThời gian: ${formatReminderTime(new Date(reminder.remindAt))}`,
    reminderData: {
      reminderId: reminder.reminderId,
      remindAt: reminder.remindAt,
      repeat: reminder.repeat,
      status: "due",
    },
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  buildReminderMessageContent,
  buildReminderDueMessage,
  cancelReminder,
  completeTriggeredReminder,
  create: createReminder,
  createReminder,
  ensureRemindersTable,
  findDueReminders,
  getReminder,
  isConversationMember,
  listReminders,
  markReminderFiring,
  updateReminder,
};
