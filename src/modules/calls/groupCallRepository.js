'use strict';

const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/mysqlConfig');

const SESSION_STATUS = {
  RINGING: 'ringing',
  ACTIVE: 'active',
  ENDED: 'ended',
  FAILED: 'failed',
};

const PARTICIPANT_STATUS = {
  INVITED: 'invited',
  RINGING: 'ringing',
  JOINED: 'joined',
  LEFT: 'left',
  REJECTED: 'rejected',
  MISSED: 'missed',
  RECONNECTING: 'reconnecting',
};

function nowIso() {
  return new Date().toISOString();
}

function toStoredStatus(status) {
  return String(status || '').toLowerCase();
}

function toServiceStatus(status) {
  return String(status || '').toUpperCase();
}

function isLiveSession(session) {
  const status = toStoredStatus(session?.status);
  return status === SESSION_STATUS.RINGING || status === SESSION_STATUS.ACTIVE;
}

function isLiveParticipant(participant) {
  const status = toStoredStatus(participant?.status);
  return (
    status === PARTICIPANT_STATUS.JOINED ||
    status === PARTICIPANT_STATUS.RINGING ||
    status === PARTICIPANT_STATUS.INVITED ||
    status === PARTICIPANT_STATUS.RECONNECTING
  );
}

function toStoredParticipant(participant) {
  return {
    userId: String(participant.userId),
    role: participant.role || 'MEMBER',
    status: toStoredStatus(participant.status || PARTICIPANT_STATUS.INVITED),
    joinedAt: participant.joinedAt || null,
    leftAt: participant.leftAt || null,
  };
}

function toServiceParticipant(participant) {
  return {
    ...participant,
    role: participant.role || 'MEMBER',
    status: toServiceStatus(participant.status),
  };
}

function toServiceSession(session) {
  if (!session) return null;
  return {
    ...session,
    id: session.callId,
    hostUserId: session.callerId || session.initiatorId,
    status: toServiceStatus(session.status),
    participants: Array.isArray(session.participants)
      ? session.participants.map(toServiceParticipant)
      : [],
  };
}

// ─── Row <-> Raw session mapping ────────────────────────────────────────────

/**
 * Map a call_sessions row (snake_case columns) back to the internal raw
 * session shape this module mutates in place before writing back.
 */
function mapRowToRawSession(row) {
  if (!row) return null;
  return {
    callId: row.call_id,
    callType: row.call_type,
    callMode: row.call_mode,
    conversationId: row.conversation_id,
    callerId: row.caller_id,
    initiatorId: row.initiator_id,
    status: row.status,
    channelName: row.channel_name,
    participants: Array.isArray(row.participants) ? row.participants : [],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endedReason: row.ended_reason,
    endedBy: row.ended_by,
    activeCallMessageCreated: !!row.active_call_message_created,
    callLogCreated: !!row.call_log_created,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Overwrite the full row for a session, mirroring the old PutCommand
 * (whole-item overwrite) used after a read-modify-write.
 */
async function putSession(session) {
  await pool.query(
    `UPDATE call_sessions SET
       call_type = ?, call_mode = ?, conversation_id = ?, caller_id = ?, initiator_id = ?,
       status = ?, channel_name = ?, participants = ?, started_at = ?, ended_at = ?,
       ended_reason = ?, ended_by = ?, active_call_message_created = ?, call_log_created = ?,
       updated_at = ?
     WHERE call_id = ?`,
    [
      session.callType || null,
      session.callMode || null,
      session.conversationId || null,
      session.callerId || null,
      session.initiatorId || null,
      session.status || null,
      session.channelName || null,
      JSON.stringify(session.participants || []),
      session.startedAt || null,
      session.endedAt || null,
      session.endedReason || null,
      session.endedBy || null,
      session.activeCallMessageCreated ? 1 : 0,
      session.callLogCreated ? 1 : 0,
      session.updatedAt || null,
      session.callId,
    ],
  );
  return session;
}

// call_sessions is provisioned by src/db/initSchema.js at boot, matching the
// rest of the backend — nothing to do here at runtime.
async function ensureTables() {
  return undefined;
}

async function createSession({ conversationId, channelName, hostUserId }) {
  const now = nowIso();
  const callId = `gc_${uuidv4().replace(/-/g, '').slice(0, 20)}`;
  const item = {
    callId,
    callType: 'GROUP',
    callMode: 'group',
    conversationId: String(conversationId),
    callerId: String(hostUserId),
    initiatorId: String(hostUserId),
    status: SESSION_STATUS.RINGING,
    channelName,
    participants: [],
    startedAt: null,
    endedAt: null,
    endedReason: null,
    endedBy: null,
    activeCallMessageCreated: false,
    callLogCreated: false,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await pool.query(
      `INSERT INTO call_sessions
        (call_id, conversation_id, call_type, call_mode, initiator_id, caller_id, provider,
         channel_name, participants, status, ended_reason, ended_by, started_at, ended_at,
         duration_seconds, call_log_created, active_call_message_created, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.callId,
        item.conversationId,
        item.callType,
        item.callMode,
        item.initiatorId,
        item.callerId,
        'agora',
        item.channelName,
        JSON.stringify(item.participants),
        item.status,
        item.endedReason,
        item.endedBy,
        item.startedAt,
        item.endedAt,
        0,
        0,
        0,
        item.createdAt,
        item.updatedAt,
      ],
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      const dupErr = new Error(`Session ${callId} already exists`);
      dupErr.code = 'SESSION_ALREADY_EXISTS';
      throw dupErr;
    }
    throw err;
  }

  return toServiceSession(item);
}

async function getRawSession(sessionId) {
  const [rows] = await pool.query(
    'SELECT * FROM call_sessions WHERE call_id = ? LIMIT 1',
    [String(sessionId)],
  );
  return rows.length ? mapRowToRawSession(rows[0]) : null;
}

async function getSession(sessionId) {
  const raw = await getRawSession(sessionId);
  return toServiceSession(raw);
}

async function updateSessionStatus(sessionId, status, endReason = null) {
  const session = await getRawSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const storedStatus = toStoredStatus(status);
  const ended = storedStatus === SESSION_STATUS.ENDED || storedStatus === SESSION_STATUS.FAILED;
  const now = nowIso();

  session.status = storedStatus;
  session.updatedAt = now;
  if (storedStatus === SESSION_STATUS.ACTIVE && !session.startedAt) {
    session.startedAt = now;
  }
  if (ended) {
    session.endedAt = now;
    session.endedReason = endReason;
  }

  await putSession(session);
  return toServiceSession(session);
}

async function endSession(sessionId, endReason = 'host_ended') {
  return updateSessionStatus(sessionId, SESSION_STATUS.ENDED, endReason);
}

async function createParticipant({ sessionId, userId, role = 'MEMBER', status = 'INVITED' }) {
  const session = await getRawSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const participant = toStoredParticipant({
    userId,
    role,
    status,
    joinedAt: toStoredStatus(status) === PARTICIPANT_STATUS.JOINED ? nowIso() : null,
  });

  const participants = Array.isArray(session.participants) ? session.participants : [];
  const idx = participants.findIndex((p) => String(p.userId) === String(userId));
  if (idx >= 0) {
    participants[idx] = {
      ...participants[idx],
      ...participant,
    };
  } else {
    participants.push(participant);
  }

  session.participants = participants;
  session.updatedAt = nowIso();
  await putSession(session);

  return toServiceParticipant(participant);
}

async function getParticipant(sessionId, userId) {
  const session = await getRawSession(sessionId);
  const participant = (session?.participants || []).find(
    (p) => String(p.userId) === String(userId),
  );
  return participant ? toServiceParticipant(participant) : null;
}

async function getParticipantsBySession(sessionId) {
  const session = await getRawSession(sessionId);
  return (session?.participants || []).map(toServiceParticipant);
}

async function getJoinedParticipants(sessionId) {
  const participants = await getParticipantsBySession(sessionId);
  return participants.filter((p) => toStoredStatus(p.status) === PARTICIPANT_STATUS.JOINED);
}

async function updateParticipantStatus(sessionId, userId, status) {
  const session = await getRawSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const participants = Array.isArray(session.participants) ? session.participants : [];
  const idx = participants.findIndex((p) => String(p.userId) === String(userId));
  if (idx === -1) throw new Error(`Participant ${userId} not found in session ${sessionId}`);

  const storedStatus = toStoredStatus(status);
  const updated = {
    ...participants[idx],
    status: storedStatus,
  };

  if (storedStatus === PARTICIPANT_STATUS.JOINED) {
    updated.joinedAt = nowIso();
  } else if (
    storedStatus === PARTICIPANT_STATUS.LEFT ||
    storedStatus === PARTICIPANT_STATUS.REJECTED ||
    storedStatus === PARTICIPANT_STATUS.MISSED
  ) {
    updated.leftAt = nowIso();
  }

  participants[idx] = updated;
  session.participants = participants;
  session.updatedAt = nowIso();
  await putSession(session);

  return toServiceParticipant(updated);
}

async function getActiveSessionByConversation(conversationId) {
  const [rows] = await pool.query(
    `SELECT * FROM call_sessions
     WHERE conversation_id = ? AND (call_type = ? OR call_mode = ?) AND status IN (?, ?)`,
    [String(conversationId), 'GROUP', 'group', SESSION_STATUS.RINGING, SESSION_STATUS.ACTIVE],
  );

  const items = rows.map(mapRowToRawSession);
  const active = items
    .sort((a, b) =>
      String(b.startedAt || b.createdAt || '').localeCompare(String(a.startedAt || a.createdAt || '')),
    )[0];

  return toServiceSession(active || null);
}

async function getActiveSessionForUser(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM call_sessions WHERE (call_type = ? OR call_mode = ?) AND status IN (?, ?)`,
    ['GROUP', 'group', SESSION_STATUS.RINGING, SESSION_STATUS.ACTIVE],
  );

  const items = rows.map(mapRowToRawSession);
  const uid = String(userId);
  const active = items
    .filter((item) =>
      (item.participants || []).some(
        (participant) => String(participant.userId) === uid && isLiveParticipant(participant),
      ),
    )
    .sort((a, b) =>
      String(b.startedAt || b.createdAt || '').localeCompare(String(a.startedAt || a.createdAt || '')),
    )[0];

  return toServiceSession(active || null);
}

async function countJoinedParticipants(sessionId) {
  const joined = await getJoinedParticipants(sessionId);
  return joined.length;
}

async function markActiveCallMessageCreated(sessionId) {
  const [result] = await pool.query(
    `UPDATE call_sessions SET active_call_message_created = 1
     WHERE call_id = ? AND active_call_message_created = 0`,
    [String(sessionId)],
  );
  return result.affectedRows === 1;
}

async function markCallLogCreated(sessionId) {
  const [result] = await pool.query(
    `UPDATE call_sessions SET call_log_created = 1 WHERE call_id = ? AND call_log_created = 0`,
    [String(sessionId)],
  );
  return result.affectedRows === 1;
}

// ─── Disconnect / Reconnect ─────────────────────────────────────────────────

/**
 * Mark a participant as disconnected (socket lost).
 * Sets status to 'reconnecting' and records disconnectedAt.
 */
async function markParticipantDisconnected(sessionId, userId) {
  const session = await getRawSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const participants = Array.isArray(session.participants) ? session.participants : [];
  const idx = participants.findIndex((p) => String(p.userId) === String(userId));
  if (idx === -1) throw new Error(`Participant ${userId} not found`);

  participants[idx] = {
    ...participants[idx],
    status: 'reconnecting',
    disconnectedAt: nowIso(),
  };

  session.participants = participants;
  session.updatedAt = nowIso();
  await putSession(session);
  return toServiceSession(session);
}

/**
 * Mark a participant as reconnected after a disconnect.
 * Sets status back to 'joined' and records reconnectedAt.
 */
async function markParticipantReconnected(sessionId, userId) {
  const session = await getRawSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const participants = Array.isArray(session.participants) ? session.participants : [];
  const idx = participants.findIndex((p) => String(p.userId) === String(userId));
  if (idx === -1) throw new Error(`Participant ${userId} not found`);

  participants[idx] = {
    ...participants[idx],
    status: 'joined',
    reconnectedAt: nowIso(),
  };

  session.participants = participants;
  session.updatedAt = nowIso();
  await putSession(session);
  return toServiceSession(session);
}

module.exports = {
  ensureTables,
  createSession,
  getSession,
  updateSessionStatus,
  endSession,
  createParticipant,
  getParticipant,
  getParticipantsBySession,
  getJoinedParticipants,
  updateParticipantStatus,
  getActiveSessionByConversation,
  getActiveSessionForUser,
  countJoinedParticipants,
  markActiveCallMessageCreated,
  markCallLogCreated,
  markParticipantDisconnected,
  markParticipantReconnected,
};
