/**
 * Data access layer for call_sessions (1:1 direct calls).
 *
 * All MySQL operations for call sessions live here.
 * Business logic (callService) depends on this — never on MySQL directly.
 *
 * @see callModel.js for the schema definition
 */

const { pool } = require("../../config/mysqlConfig");
const { CALL_STATUS, BLOCKING_STATUSES, PARTICIPANT_STATUS, CONNECTION_STATE, ENDED_REASON } = require("./call.constants");

// ─── Row <-> Session mapping ────────────────────────────────────────────────

/**
 * Map a call_sessions row (snake_case columns) back to the camelCase shape
 * produced by callModel.createCallSession() / previously stored in DynamoDB.
 *
 * @param {Object} row
 * @returns {Object|null}
 */
function mapRowToSession(row) {
  if (!row) return null;
  return {
    callId: row.call_id,
    conversationId: row.conversation_id,
    initiatorId: row.initiator_id,
    callMode: row.call_mode,
    callType: row.call_type,
    provider: row.provider,
    channelName: row.channel_name,
    participants: Array.isArray(row.participants) ? row.participants : [],
    status: row.status,
    endedReason: row.ended_reason,
    endedBy: row.ended_by,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    callLogCreated: !!row.call_log_created,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Map of camelCase callSession fields to call_sessions columns, used by the
// generic updateStatus() to build dynamic SET clauses safely (no raw key injection).
const FIELD_TO_COLUMN = {
  conversationId: "conversation_id",
  callType: "call_type",
  callMode: "call_mode",
  initiatorId: "initiator_id",
  callerId: "caller_id",
  provider: "provider",
  channelName: "channel_name",
  participants: "participants",
  status: "status",
  endedReason: "ended_reason",
  endedBy: "ended_by",
  startedAt: "started_at",
  endedAt: "ended_at",
  durationSeconds: "duration_seconds",
  callLogCreated: "call_log_created",
  activeCallMessageCreated: "active_call_message_created",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

// ─── Create ─────────────────────────────────────────────────────────────────

/**
 * Store a new call session in MySQL.
 * Uses the call_id PRIMARY KEY as a uniqueness guard (equivalent to the
 * previous DynamoDB conditional put on attribute_not_exists(callId)).
 *
 * @param {Object} callSession - The call session item from createCallSession()
 * @returns {Object} The stored item
 * @throws {Error} If callId already exists (mirrors the old ConditionalCheckFailedException)
 */
async function create(callSession) {
  const {
    callId,
    conversationId,
    initiatorId,
    callMode,
    callType,
    provider,
    channelName,
    participants,
    status,
    endedReason,
    endedBy,
    startedAt,
    endedAt,
    durationSeconds,
    callLogCreated,
    createdAt,
    updatedAt,
  } = callSession;

  try {
    await pool.query(
      `INSERT INTO call_sessions
        (call_id, conversation_id, call_type, call_mode, initiator_id, caller_id, provider,
         channel_name, participants, status, ended_reason, ended_by, started_at, ended_at,
         duration_seconds, call_log_created, active_call_message_created, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        callId,
        conversationId || null,
        callType || null,
        callMode || null,
        initiatorId || null,
        initiatorId || null, // caller_id: direct calls track only initiatorId; mirror it here
        provider || null,
        channelName || null,
        JSON.stringify(participants || []),
        status || null,
        endedReason || null,
        endedBy || null,
        startedAt || null,
        endedAt || null,
        durationSeconds || 0,
        callLogCreated ? 1 : 0,
        0,
        createdAt || null,
        updatedAt || null,
      ],
    );
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") {
      const dupErr = new Error(`Call ${callId} already exists`);
      dupErr.code = "CALL_ALREADY_EXISTS";
      throw dupErr;
    }
    throw err;
  }
  return callSession;
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Get a call session by callId.
 *
 * @param {string} callId
 * @returns {Object|null} The call session or null if not found
 */
async function getById(callId) {
  const [rows] = await pool.query(
    "SELECT * FROM call_sessions WHERE call_id = ? LIMIT 1",
    [callId],
  );
  return rows.length ? mapRowToSession(rows[0]) : null;
}

/**
 * Find an active or ringing call in a given conversation.
 *
 * @param {string} conversationId
 * @returns {Object|null} The active/ringing call session or null
 */
async function findActiveByConversation(conversationId) {
  const [rows] = await pool.query(
    `SELECT * FROM call_sessions
     WHERE conversation_id = ? AND status IN (?, ?, ?)
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(conversationId), CALL_STATUS.RINGING, CALL_STATUS.ACTIVE, CALL_STATUS.RECONNECTING],
  );
  return rows.length ? mapRowToSession(rows[0]) : null;
}

/**
 * Check if a user is currently busy in any active or ringing call.
 *
 * @param {string} userId
 * @returns {Promise<{busy: boolean, callId?: string}>}
 */
async function isUserBusy(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM call_sessions WHERE status IN (?, ?, ?)`,
    [CALL_STATUS.ACTIVE, CALL_STATUS.RINGING, CALL_STATUS.RECONNECTING],
  );
  const uid = String(userId);
  const items = rows
    .map(mapRowToSession)
    .filter((item) =>
      Array.isArray(item.participants) &&
      item.participants.some((p) => String(p.userId) === uid),
    );
  items.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  if (items.length > 0) {
    return { busy: true, callId: items[0].callId };
  }
  return { busy: false };
}

/**
 * Get call history for a conversation (all statuses), sorted by createdAt descending.
 * Uses keyset pagination over (created_at, call_id) in place of the old
 * DynamoDB LastEvaluatedKey/ExclusiveStartKey.
 *
 * @param {string} conversationId
 * @param {Object} [options]
 * @param {number} [options.limit=20] - Max items to return
 * @param {Object} [options.exclusiveStartKey] - { createdAt, callId } cursor, decoded by the caller
 * @returns {Promise<{items: Array, lastEvaluatedKey?: Object}>}
 */
async function getHistoryByConversation(
  conversationId,
  { limit = 20, exclusiveStartKey } = {},
) {
  const params = [String(conversationId)];
  let sql = `SELECT * FROM call_sessions WHERE conversation_id = ?`;

  if (exclusiveStartKey && exclusiveStartKey.createdAt && exclusiveStartKey.callId) {
    sql += ` AND (created_at, call_id) < (?, ?)`;
    params.push(exclusiveStartKey.createdAt, exclusiveStartKey.callId);
  }

  sql += ` ORDER BY created_at DESC, call_id DESC LIMIT ?`;
  // Fetch one extra row to detect whether there are more pages, mirroring
  // DynamoDB's LastEvaluatedKey semantics (only present when more data exists).
  params.push(limit + 1);

  const [rows] = await pool.query(sql, params);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(mapRowToSession);
  const lastEvaluatedKey = hasMore
    ? {
        createdAt: pageRows[pageRows.length - 1].created_at,
        callId: pageRows[pageRows.length - 1].call_id,
      }
    : null;

  return { items, lastEvaluatedKey };
}

// ─── Update ─────────────────────────────────────────────────────────────────

/**
 * Update the top-level status of a call session.
 *
 * @param {string} callId
 * @param {string} newStatus - One of CALL_STATUS values
 * @param {Object} [extraFields] - Additional fields to set (e.g. endedReason, endedBy, endedAt)
 * @returns {Object} The updated item
 */
async function updateStatus(callId, newStatus, extraFields = {}) {
  const now = new Date().toISOString();

  const setClauses = ["status = ?", "updated_at = ?"];
  const values = [newStatus, now];

  for (const [key, value] of Object.entries(extraFields)) {
    const column = FIELD_TO_COLUMN[key];
    if (!column) continue; // ignore unknown fields, same as before (no injection risk)
    setClauses.push(`${column} = ?`);
    values.push(key === "participants" ? JSON.stringify(value) : value);
  }

  values.push(callId);

  await pool.query(
    `UPDATE call_sessions SET ${setClauses.join(", ")} WHERE call_id = ?`,
    values,
  );
  return getById(callId);
}

/**
 * Transition a call from RINGING to ACTIVE.
 * Sets startedAt and updates status atomically.
 *
 * @param {string} callId
 * @returns {Object} The updated call session
 */
async function activateCall(callId) {
  const now = new Date().toISOString();
  await pool.query(
    `UPDATE call_sessions SET status = ?, started_at = ?, updated_at = ? WHERE call_id = ?`,
    [CALL_STATUS.ACTIVE, now, now, callId],
  );
  return getById(callId);
}

/**
 * End a call: set status=ended, endedAt, endedReason, endedBy, durationSeconds.
 *
 * @param {string} callId
 * @param {string} endedBy - userId who ended the call
 * @param {string} endedReason - One of ENDED_REASON values
 * @param {string} [startedAt] - The call's startedAt (for duration calculation)
 * @returns {Object} The updated call session
 */
async function endCall(callId, endedBy, endedReason, startedAt) {
  const now = new Date().toISOString();
  const durationSeconds = startedAt
    ? Math.floor((new Date(now).getTime() - new Date(startedAt).getTime()) / 1000)
    : 0;

  await pool.query(
    `UPDATE call_sessions
     SET status = ?, ended_at = ?, ended_by = ?, ended_reason = ?, duration_seconds = ?, updated_at = ?
     WHERE call_id = ?`,
    [CALL_STATUS.ENDED, now, String(endedBy), endedReason, Math.max(0, durationSeconds), now, callId],
  );
  return getById(callId);
}

// ─── Participant Updates ────────────────────────────────────────────────────

/**
 * Update a specific participant's fields within the participants list.
 *
 * MySQL JSON columns don't support updating an array element by index
 * directly from SQL in a single statement that's also easy to reason about,
 * so (like before) we read the full row, mutate in memory, and write back
 * (read-modify-write).
 *
 * @param {string} callId
 * @param {string} userId - The participant's userId
 * @param {Object} updates - Fields to set on the participant (e.g. { status, connectionState, joinedAt })
 * @returns {Object} The updated call session
 * @throws {Error} If participant not found
 */
async function updateParticipant(callId, userId, updates) {
  const call = await getById(callId);
  if (!call) throw new Error(`Call ${callId} not found`);

  const idx = call.participants.findIndex(
    (p) => p.userId === String(userId),
  );
  if (idx === -1) {
    throw new Error(
      `Participant ${userId} not found in call ${callId}`,
    );
  }

  call.participants[idx] = {
    ...call.participants[idx],
    ...updates,
  };
  call.updatedAt = new Date().toISOString();

  await pool.query(
    `UPDATE call_sessions SET participants = ?, updated_at = ? WHERE call_id = ?`,
    [JSON.stringify(call.participants), call.updatedAt, callId],
  );
  return call;
}

/**
 * Add a new participant to an existing call session.
 *
 * @param {string} callId
 * @param {Object} participant - Participant object (userId, role, status, etc.)
 * @returns {Object} The updated call session
 * @throws {Error} If call not found
 */
async function addParticipant(callId, participant) {
  const call = await getById(callId);
  if (!call) throw new Error(`Call ${callId} not found`);

  const exists = call.participants.some(
    (p) => p.userId === String(participant.userId),
  );
  if (exists) {
    throw new Error(
      `Participant ${participant.userId} already exists in call ${callId}`,
    );
  }

  call.participants.push({
    userId: String(participant.userId),
    role: participant.role || "callee",
    status: participant.status || PARTICIPANT_STATUS.INVITED,
    connectionState: CONNECTION_STATE.CONNECTED,
    joinedAt: null,
    leftAt: null,
    disconnectedAt: null,
    reconnectedAt: null,
  });
  call.updatedAt = new Date().toISOString();

  await pool.query(
    `UPDATE call_sessions SET participants = ?, updated_at = ? WHERE call_id = ?`,
    [JSON.stringify(call.participants), call.updatedAt, callId],
  );
  return call;
}

/**
 * Mark a participant as disconnected (socket lost).
 *
 * @param {string} callId
 * @param {string} userId
 * @returns {Object} The updated call session
 */
async function markParticipantDisconnected(callId, userId) {
  return updateParticipant(callId, userId, {
    connectionState: CONNECTION_STATE.DISCONNECTED,
    disconnectedAt: new Date().toISOString(),
  });
}

/**
 * Mark a participant as reconnected.
 *
 * @param {string} callId
 * @param {string} userId
 * @returns {Object} The updated call session
 */
async function markParticipantReconnected(callId, userId) {
  return updateParticipant(callId, userId, {
    connectionState: CONNECTION_STATE.CONNECTED,
    reconnectedAt: new Date().toISOString(),
  });
}

/**
 * Mark a participant as having left the call.
 *
 * @param {string} callId
 * @param {string} userId
 * @returns {Object} The updated call session
 */
async function markParticipantLeft(callId, userId) {
  return updateParticipant(callId, userId, {
    status: PARTICIPANT_STATUS.LEFT,
    leftAt: new Date().toISOString(),
  });
}

// ─── Idempotency ────────────────────────────────────────────────────────────

/**
 * Atomically set callLogCreated = true, but only if it is currently false.
 * Uses `UPDATE ... WHERE call_log_created = 0` as the atomic "only one writer
 * wins" lock, equivalent to the old DynamoDB ConditionExpression.
 *
 * @param {string} callId
 * @returns {Promise<boolean>} true if the flag was set (caller should create the log),
 *                              false if it was already true (caller should skip)
 */
async function markCallLogCreated(callId) {
  const [result] = await pool.query(
    `UPDATE call_sessions SET call_log_created = 1 WHERE call_id = ? AND call_log_created = 0`,
    [callId],
  );
  return result.affectedRows === 1; // 1 row affected => we won the race
}

// ─── Active Call Lookup ─────────────────────────────────────────────────────

/**
 * Find the active or ringing call that a user is currently participating in.
 *
 * @param {string} userId
 * @returns {Promise<Object|null>} The call session or null
 */
async function findActiveForUser(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM call_sessions WHERE status IN (?, ?, ?)`,
    [CALL_STATUS.ACTIVE, CALL_STATUS.RINGING, CALL_STATUS.RECONNECTING],
  );
  const uid = String(userId);
  const items = rows
    .map(mapRowToSession)
    .filter((item) =>
      Array.isArray(item.participants) &&
      item.participants.some((p) => String(p.userId) === uid),
    );
  items.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  return items.length > 0 ? items[0] : null;
}

// ─── Recovery Queries ────────────────────────────────────────────────────────

/**
 * Find all calls with status = RINGING (for boot-time recovery).
 * @returns {Promise<Object[]>} Array of ringing call sessions
 */
async function findAllRinging() {
  const [rows] = await pool.query(
    `SELECT * FROM call_sessions WHERE status = ?`,
    [CALL_STATUS.RINGING],
  );
  return rows.map(mapRowToSession);
}

/**
 * Find all calls with status = ACTIVE (for boot-time recovery).
 * @returns {Promise<Object[]>} Array of active call sessions
 */
async function findAllActive() {
  const [rows] = await pool.query(
    `SELECT * FROM call_sessions WHERE status = ?`,
    [CALL_STATUS.ACTIVE],
  );
  return rows.map(mapRowToSession);
}

/**
 * Force-end all stale calls in a conversation.
 * Used as a defensive cleanup when a new call is started but a stale call is blocking.
 *
 * @param {string} conversationId
 * @param {string} reason - Ended reason (e.g. SYSTEM_CLEANUP)
 * @returns {Promise<number>} Number of calls cleaned up
 */
async function cleanupStaleConversationCalls(conversationId, reason = ENDED_REASON.SYSTEM_CLEANUP) {
  const [rows] = await pool.query(
    `SELECT * FROM call_sessions WHERE conversation_id = ? AND status IN (?, ?, ?)`,
    [String(conversationId), CALL_STATUS.RINGING, CALL_STATUS.ACTIVE, CALL_STATUS.RECONNECTING],
  );
  const items = rows.map(mapRowToSession);
  let cleaned = 0;
  for (const item of items) {
    try {
      await updateStatus(item.callId, CALL_STATUS.ENDED, {
        endedAt: new Date().toISOString(),
        endedReason: reason,
        endedBy: "system",
      });
      cleaned++;
      console.log(`[call:stale-cleanup] callId=${item.callId} oldStatus=${item.status} newStatus=ended reason=${reason}`);
    } catch (err) {
      console.error(`[call:stale-cleanup] Failed to cleanup ${item.callId}:`, err.message);
    }
  }
  return cleaned;
}

module.exports = {
  create,
  getById,
  findActiveByConversation,
  findActiveForUser,
  isUserBusy,
  getHistoryByConversation,
  updateStatus,
  activateCall,
  endCall,
  updateParticipant,
  addParticipant,
  markParticipantDisconnected,
  markParticipantReconnected,
  markParticipantLeft,
  markCallLogCreated,
  findAllRinging,
  findAllActive,
  cleanupStaleConversationCalls,
};
