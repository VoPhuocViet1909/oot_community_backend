/**
 * Core business logic for video/voice calls.
 *
 * Depends on: callModel, callRepository, callValidation, AgoraProvider,
 *             groupService (for membership), messageService (for call_log).
 *
 * No socket logic — socket events are handled separately in callSocketHandler (Phase 2c).
 * No REST logic — request/response handling is in callController.
 */

const { pool } = require("../../config/mysqlConfig");

const callModel = require("./callModel");
const callRepository = require("./callRepository");
const { CallError, validateStartCallInput, validateCallId, validateUserId } = require("./callValidation");
const AgoraProvider = require("./providers/agoraProvider");
const {
  CALL_STATUS,
  BLOCKING_STATUSES,
  CALL_MODE,
  CALL_TYPE,
  PARTICIPANT_STATUS,
  CONNECTION_STATE,
  ENDED_REASON,
  TIMEOUTS,
} = require("./call.constants");

// ─── Provider Singleton ─────────────────────────────────────────────────────

const agoraProvider = new AgoraProvider();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a conversation from the database to determine callMode and members.
 *
 * Strategy:
 * 1. Look up conversationId as a group_id in groups_.
 * 2. If found → group conversation. Members come from group_members.
 * 3. If not found → direct (DM) conversation. Members are derived from
 *    the "dm:userA:userB" convention (no dedicated DM table exists).
 *
 * @param {string} conversationId
 * @returns {Promise<{ callMode: "direct"|"group", members: string[], groupType?: string }>}
 */
async function resolveConversation(conversationId) {
  if (!conversationId || typeof conversationId !== "string" || !conversationId.trim()) {
    throw new CallError("conversationId is required", "INVALID_INPUT", 400);
  }

  const cid = conversationId.trim();

  // 1. Try looking up as a group in groups_
  const [groupRows] = await pool.query(
    "SELECT * FROM groups_ WHERE group_id = ? LIMIT 1",
    [cid],
  );
  const group = groupRows[0] || null;

  if (group) {
    // Group conversation — get members from group_members
    const [memberRows] = await pool.query(
      "SELECT user_id FROM group_members WHERE group_id = ?",
      [cid],
    );
    const members = memberRows.map((row) => String(row.user_id));
    if (members.length === 0) {
      throw new CallError(
        "Conversation has no members",
        "CONVERSATION_NOT_FOUND",
        404,
      );
    }
    return {
      callMode: CALL_MODE.GROUP,
      members,
      groupType: group.type || null,
    };
  }

  // 2. Not a group — treat as DM conversation
  // DMs use the convention "dm:userA:userB" with no dedicated DB table.
  if (!cid.startsWith("dm:")) {
    throw new CallError(
      "Conversation not found (not a group and not a valid DM format)",
      "CONVERSATION_NOT_FOUND",
      404,
    );
  }

  const parts = cid.slice(3).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new CallError(
      "Invalid DM conversationId format. Expected 'dm:userA:userB'",
      "INVALID_INPUT",
      400,
    );
  }

  const members = [String(parts[0]).trim(), String(parts[1]).trim()];
  return {
    callMode: CALL_MODE.DIRECT,
    members,
    groupType: null,
  };
}

async function isUserInGroupConversation(conversationId, userId) {
  if (!conversationId || !userId) return false;

  const [rows] = await pool.query(
    "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1",
    [String(conversationId), String(userId)],
  );

  return rows.length > 0;
}

/**
 * Create a call_log message in ott_messages when a call reaches a terminal state.
 * This is the ONLY place call_log messages are generated.
 *
 * IDEMPOTENT: checks callLogCreated flag before writing. Only one call_log
 * may ever exist per call session. Protected against retry, double end,
 * timeout race, and reconnect race.
 *
 * @param {Object} callSession - The ended call session (with final status)
 */
async function createCallLogMessage(callSession) {
  if (!callSession || !callSession.conversationId) return;

  // Idempotency guard: if already created, skip
  if (callSession.callLogCreated) return;

  const participants = callSession.participants || [];
  const acceptedCount = participants.filter(
    (p) => p.status === PARTICIPANT_STATUS.ACCEPTED,
  ).length;
  const rejectedCount = participants.filter(
    (p) => p.status === PARTICIPANT_STATUS.REJECTED,
  ).length;
  const missedCount = participants.filter(
    (p) => p.status === PARTICIPANT_STATUS.MISSED || p.status === PARTICIPANT_STATUS.INVITED,
  ).length;

  // Determine human-readable content
  const typeLabel =
    callSession.callType === CALL_TYPE.VIDEO ? "Cuộc gọi video" : "Cuộc gọi thoại";
  let statusSuffix = "";
  switch (callSession.endedReason) {
    case ENDED_REASON.USER_ENDED:
      statusSuffix = ` · ${formatDuration(callSession.durationSeconds)}`;
      break;
    case ENDED_REASON.CALLER_CANCELLED:
      statusSuffix = " · đã hủy";
      break;
    case ENDED_REASON.CALLEE_REJECTED:
      statusSuffix = " · đã từ chối";
      break;
    case ENDED_REASON.NO_ANSWER_TIMEOUT:
      statusSuffix = " · không trả lời";
      break;
    case ENDED_REASON.DISCONNECT_TIMEOUT:
      statusSuffix = " · mất kết nối";
      break;
    case ENDED_REASON.GROUP_EMPTY:
      statusSuffix = " · kết thúc";
      break;
    default:
      break;
  }

  const content = `${typeLabel}${statusSuffix}`;

  const callData = {
    callId: callSession.callId,
    callMode: callSession.callMode,
    callType: callSession.callType,
    callStatus: callSession.status,
    endedReason: callSession.endedReason || null,
    durationSeconds: callSession.durationSeconds || 0,
    startedAt: callSession.startedAt || null,
    initiatorId: callSession.initiatorId,
    acceptedCount,
    rejectedCount,
    missedCount,
  };

  // Mark callLogCreated = true BEFORE writing the message to prevent races.
  // If this fails (e.g. concurrent end-call), the flag prevents double-write.
  const marked = await callRepository.markCallLogCreated(callSession.callId);
  if (!marked) {
    // Another request already created the call_log — skip
    return;
  }

  // Use saveMessage from messageService to persist in ott_messages
  const { saveMessage } = require("../messages/messageService");
  const savedMessage = await saveMessage({
    conversationId: callSession.conversationId,
    senderId: callSession.initiatorId,
    content,
    contentType: "call_log",
    callData,
  });

  // Broadcast the call_log message realtime to the conversation room
  // so all participants see it immediately (same event as normal chat messages)
  try {
    const { getIO } = require("../../socket/socketHandler");
    const io = getIO();
    if (io && savedMessage) {
      const roomId = callSession.conversationId;
      console.log(`[call:system-message] Broadcasting call_log to room ${roomId}`, savedMessage.id);
      io.to(roomId).emit("receive_message", savedMessage);
    }
  } catch (emitErr) {
    console.error("[call:system-message] Failed to broadcast realtime:", emitErr.message);
  }
}

/**
 * Format seconds into a human-readable duration string.
 *
 * @param {number} seconds
 * @returns {string} e.g. "2:30" or "0:05"
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Generate an Agora token payload for a user joining a call.
 *
 * @param {string} channelName
 * @param {string} userId
 * @returns {{ appId: string, token: string, uid: number, channelName: string, expireAt: string }}
 */
function generateTokenPayload(channelName, userId) {
  const uid = agoraProvider.generateUid(userId);
  const token = agoraProvider.generateToken(channelName, uid);
  const expireAt = new Date(
    Date.now() + TIMEOUTS.TOKEN_EXPIRE_SECONDS * 1000,
  ).toISOString();

  return {
    appId: agoraProvider.getAppId(),
    token,
    uid,
    channelName,
    expireAt,
  };
}

// ─── Core Service Methods ───────────────────────────────────────────────────

/**
 * Start a new call in a conversation.
 *
 * @param {Object} params
 * @param {string} params.userId - The caller's userId
 * @param {string} params.conversationId - The conversation to call in
 * @param {string} params.callType - "audio" or "video"
 * @returns {Promise<{ callSession: Object, tokenPayload: Object, recipientIds: string[] }>}
 */
async function startCall({ userId, conversationId, callType }) {
  // 1. Validate input (no callMode determination here — comes from DB)
  const { callType: normalizedType } = validateStartCallInput({
    userId,
    conversationId,
    callType,
  });

  // 2. Resolve conversation from DB → determines callMode + members
  const conversation = await resolveConversation(conversationId);
  const { callMode, members } = conversation;

  // 3. Group calls are handled exclusively by the group call rebuild system
  //    (groupCallService + groupCallRepository). The unified callService only
  //    handles direct (1:1) calls. Reject any group call attempt here.
  if (callMode === CALL_MODE.GROUP) {
    throw new CallError(
      "Group calls must use the group call API (POST /api/calls/group/initiate).",
      "USE_GROUP_CALL_API",
      400,
    );
  }

  // 4. Verify caller is a member
  const callerId = String(userId);
  if (!members.includes(callerId)) {
    throw new CallError(
      "You are not a member of this conversation",
      "NOT_MEMBER",
      403,
    );
  }

  // 5. Direct call: exactly 2 members
  if (callMode === CALL_MODE.DIRECT && members.length !== 2) {
    throw new CallError(
      "Direct call requires exactly 2 members",
      "INVALID_CONVERSATION",
      400,
    );
  }

  // 6. Check no active call in this conversation (with stale-call recovery)
  const existingCall = await callRepository.findActiveByConversation(conversationId);
  if (existingCall) {
    const ageMs = Date.now() - new Date(existingCall.createdAt).getTime();
    console.log(
      `[call:active-check] conversationId=${conversationId} foundCallId=${existingCall.callId} ` +
      `status=${existingCall.status} ageMs=${ageMs} BLOCKING_STATUSES=${BLOCKING_STATUSES.join(",")}`,
    );

    let shouldCleanup = false;

    // Rule 1: Stale RINGING — exceeded ring timeout
    if (existingCall.status === CALL_STATUS.RINGING && ageMs > TIMEOUTS.RING_TIMEOUT_MS) {
      shouldCleanup = true;
    }

    // Rule 2: Direct call ACTIVE/RECONNECTING — all participants disconnected or left
    if (!shouldCleanup && callMode === CALL_MODE.DIRECT) {
      const staleableStatuses = [CALL_STATUS.ACTIVE, CALL_STATUS.RECONNECTING];
      if (staleableStatuses.includes(existingCall.status)) {
        const participants = existingCall.participants || [];
        const allGone = participants.length > 0 && participants.every((p) => {
          const terminal = [PARTICIPANT_STATUS.LEFT, PARTICIPANT_STATUS.REJECTED, PARTICIPANT_STATUS.MISSED];
          return terminal.includes(p.status) || p.connectionState === CONNECTION_STATE.DISCONNECTED;
        });
        if (allGone) {
          shouldCleanup = true;
        }
      }
    }

    // Rule 3: RECONNECTING — disconnect grace period expired (any call mode)
    if (!shouldCleanup && existingCall.status === CALL_STATUS.RECONNECTING) {
      const disconnectedParticipants = (existingCall.participants || []).filter(
        (p) => p.connectionState === CONNECTION_STATE.DISCONNECTED && p.disconnectedAt,
      );
      for (const p of disconnectedParticipants) {
        const disconnectAge = Date.now() - new Date(p.disconnectedAt).getTime();
        if (disconnectAge > TIMEOUTS.DISCONNECT_GRACE_MS) {
          shouldCleanup = true;
          break;
        }
      }
    }

    // Rule 4: Safety — any call older than 24h is definitely stale
    const MAX_CALL_AGE_MS = 24 * 60 * 60 * 1000;
    if (!shouldCleanup && ageMs > MAX_CALL_AGE_MS) {
      shouldCleanup = true;
    }

    if (shouldCleanup) {
      console.log(
        `[call:stale-cleanup] callId=${existingCall.callId} oldStatus=${existingCall.status} ` +
        `reason=AUTO_TIMEOUT_CLEANUP ageMs=${ageMs} callMode=${existingCall.callMode}`,
      );
      try {
        await callRepository.cleanupStaleConversationCalls(conversationId, ENDED_REASON.SYSTEM_CLEANUP);
      } catch (cleanupErr) {
        console.error(`[call:stale-cleanup] Error during cleanup:`, cleanupErr.message);
      }
      // Fall through — allow the new call
    } else {
      // Legitimately active call — block new call
      const receiverId = members.find((m) => m !== callerId) || "unknown";
      console.log(
        `[CALL_START_CONFLICT] callerId=${callerId} receiverId=${receiverId} ` +
        `existingCallId=${existingCall.callId} status=${existingCall.status}`,
      );
      throw new CallError(
        "An active call already exists in this conversation",
        "CALL_EXISTS",
        409,
      );
    }
  }
  console.log(`[call:start-allowed] conversationId=${conversationId}`);

  // 7. Check initiator not busy
  const callerBusy = await callRepository.isUserBusy(callerId);
  if (callerBusy.busy) {
    throw new CallError(
      "You are already in another call",
      "CALL_BUSY",
      409,
      { busyUserId: callerId, busyCallId: callerBusy.callId || null },
    );
  }

  // 8. Direct: check callee not busy
  if (callMode === CALL_MODE.DIRECT) {
    const calleeId = members.find((m) => m !== callerId);
    const calleeBusy = await callRepository.isUserBusy(calleeId);
    if (calleeBusy.busy) {
      throw new CallError(
        "The person you are trying to call is busy",
        "CALL_BUSY",
        409,
        { busyUserId: calleeId, busyCallId: calleeBusy.callId || null },
      );
    }
  }

  // 9. Build initial participants
  let initialParticipants = [];
  if (callMode === CALL_MODE.DIRECT) {
    const calleeId = members.find((m) => m !== callerId);
    initialParticipants = [
      { userId: calleeId, role: "callee", status: PARTICIPANT_STATUS.INVITED },
    ];
  } else {
    // Group: invite all other members
    initialParticipants = members
      .filter((m) => m !== callerId)
      .map((m) => ({
        userId: m,
        role: "member",
        status: PARTICIPANT_STATUS.INVITED,
      }));
  }

  // 10. Create call session (channelName defaults to callId in createCallSession)
  const callSession = callModel.createCallSession({
    conversationId,
    initiatorId: callerId,
    callMode,
    callType: normalizedType,
    channelName: null, // will default to callId
    initialParticipants,
  });

  // 11. Store in DynamoDB
  await callRepository.create(callSession);

  // 12. Generate token for initiator
  const tokenPayload = generateTokenPayload(callSession.channelName, callerId);

  // 13. Recipient IDs (who should receive call:incoming)
  // Always derive from the persisted call participants so group invite fan-out
  // cannot accidentally fall back to single-callee direct-call logic.
  const recipientIds = [
    ...new Set(
      callSession.participants
        .map((p) => String(p.userId))
        .filter((pid) => pid !== callerId),
    ),
  ];

  return { callSession, tokenPayload, recipientIds };
}

/**
 * Accept an incoming call.
 *
 * @param {Object} params
 * @param {string} params.userId - The accepting user's userId
 * @param {string} params.callId - The call session ID
 * @returns {Promise<{ callSession: Object, tokenPayload: Object }>}
 */
async function acceptCall({ userId, callId }) {
  validateUserId(userId);
  validateCallId(callId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }

  const uid = String(userId);
  const participant = callModel.findParticipant(call, uid);
  if (!participant) {
    throw new CallError("You are not a participant in this call", "NOT_PARTICIPANT", 403);
  }

  // Idempotent: if already accepted, return success (handles double-click / race)
  if (participant.status === PARTICIPANT_STATUS.ACCEPTED) {
    console.log(`[call:accept] ${uid} already accepted call ${callId} — idempotent return`);
    const tokenPayload = generateTokenPayload(call.channelName, uid);
    if (call.callMode === CALL_MODE.GROUP) {
      console.log(
        `[GROUP_JOIN_TOKEN] userId=${uid} callId=${callId} channelName=${call.channelName} uid=${tokenPayload.uid}`,
      );
    }
    return { callSession: call, tokenPayload };
  }

  if (call.status !== CALL_STATUS.RINGING && call.status !== CALL_STATUS.ACTIVE) {
    throw new CallError(
      `Call is not in a joinable state (current: ${call.status})`,
      "CALL_NOT_RINGING",
      400,
    );
  }

  if (participant.status !== PARTICIPANT_STATUS.INVITED) {
    throw new CallError(
      `Already responded (status: ${participant.status})`,
      "ALREADY_RESPONDED",
      400,
    );
  }

  const now = new Date().toISOString();

  // Mark participant as accepted
  const updated = await callRepository.updateParticipant(callId, uid, {
    status: PARTICIPANT_STATUS.ACCEPTED,
    joinedAt: now,
  });

  // Activate call if this is the first accept
  const alreadyActive = updated.status === CALL_STATUS.ACTIVE;
  let finalCall = updated;
  if (!alreadyActive) {
    finalCall = await callRepository.activateCall(callId);
  }

  // Generate token for this participant
  const tokenPayload = generateTokenPayload(finalCall.channelName, uid);
  if (finalCall.callMode === CALL_MODE.GROUP) {
    console.log(
      `[GROUP_JOIN_TOKEN] userId=${uid} callId=${callId} channelName=${finalCall.channelName} uid=${tokenPayload.uid}`,
    );
  }

  return { callSession: finalCall, tokenPayload };
}

/**
 * Reject an incoming call.
 *
 * @param {Object} params
 * @param {string} params.userId - The rejecting user's userId
 * @param {string} params.callId - The call session ID
 * @returns {Promise<{ ended: boolean, callSession?: Object }>}
 */
async function rejectCall({ userId, callId }) {
  validateUserId(userId);
  validateCallId(callId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }

  // Idempotent: if call already ended (e.g. caller cancelled while callee was rejecting), return success
  if (call.status === CALL_STATUS.ENDED) {
    console.log(`[call:reject] Call ${callId} already ended — idempotent return`);
    return { ended: true, callSession: call };
  }

  if (call.status !== CALL_STATUS.RINGING) {
    throw new CallError(
      `Call is not in ringing state (current: ${call.status})`,
      "CALL_NOT_RINGING",
      400,
    );
  }

  const uid = String(userId);
  const participant = callModel.findParticipant(call, uid);
  if (!participant) {
    throw new CallError("You are not a participant in this call", "NOT_PARTICIPANT", 403);
  }
  if (participant.status !== PARTICIPANT_STATUS.INVITED) {
    throw new CallError(
      `Already responded (status: ${participant.status})`,
      "ALREADY_RESPONDED",
      400,
    );
  }

  if (call.callMode === CALL_MODE.DIRECT) {
    // Direct: callee reject ends call for both
    const ended = await callRepository.endCall(
      callId,
      uid,
      ENDED_REASON.CALLEE_REJECTED,
      null, // no startedAt (never became active)
    );
    await createCallLogMessage(ended);
    return { ended: true, callSession: ended };
  }

  // Group: mark only this participant as rejected
  const updated = await callRepository.updateParticipant(callId, uid, {
    status: PARTICIPANT_STATUS.REJECTED,
  });

  // Check if call should end: all non-initiator invitees rejected/missed and no accepted
  const hasAccepted = updated.participants.some(
    (p) => p.status === PARTICIPANT_STATUS.ACCEPTED,
  );
  const hasPending = updated.participants.some(
    (p) =>
      p.userId !== call.initiatorId && p.status === PARTICIPANT_STATUS.INVITED,
  );

  if (!hasAccepted && !hasPending) {
    // Everyone rejected/missed, no one accepted → end call
    const ended = await callRepository.endCall(
      callId,
      uid,
      ENDED_REASON.NO_ANSWER_TIMEOUT,
      null,
    );
    await createCallLogMessage(ended);
    return { ended: true, callSession: ended };
  }

  return { ended: false, callSession: updated };
}

/**
 * Cancel a ringing call (initiator only).
 *
 * @param {Object} params
 * @param {string} params.userId - Must be the initiator
 * @param {string} params.callId - The call session ID
 * @returns {Promise<{ ended: boolean, callSession: Object }>}
 */
async function cancelCall({ userId, callId }) {
  validateUserId(userId);
  validateCallId(callId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }
  if (String(call.initiatorId) !== String(userId)) {
    throw new CallError(
      "Only the call initiator can cancel the call",
      "NOT_INITIATOR",
      403,
    );
  }

  // Idempotent: if call already ended, return success
  if (call.status === CALL_STATUS.ENDED) {
    console.log(`[call:cancel] Call ${callId} already ended — idempotent return`);
    return { ended: true, callSession: call };
  }

  // If call is already ACTIVE (callee accepted while caller was cancelling),
  // treat cancel as endCall instead
  if (call.status === CALL_STATUS.ACTIVE) {
    console.log(`[call:cancel] Call ${callId} already active — delegating to endCall`);
    const ended = await callRepository.endCall(
      callId,
      userId,
      ENDED_REASON.USER_ENDED,
      call.startedAt,
    );
    await createCallLogMessage(ended);
    return { ended: true, callSession: ended };
  }

  if (call.status !== CALL_STATUS.RINGING) {
    throw new CallError(
      `Can only cancel ringing calls (current: ${call.status})`,
      "CALL_NOT_RINGING",
      400,
    );
  }

  console.log(`[call:cancel] Cancelling ringing call ${callId} by ${userId}`);
  const ended = await callRepository.endCall(
    callId,
    userId,
    ENDED_REASON.CALLER_CANCELLED,
    null,
  );
  await createCallLogMessage(ended);
  return { ended: true, callSession: ended };
}

/**
 * End an active call.
 *
 * Rules:
 * - Direct: any participant ends for both (atomic)
 * - Group explicit end by initiator: ends for everyone
 * - Group leave: removes only that participant, including the initiator
 * - If no accepted participants remain in group: ends as group_empty
 *
 * @param {Object} params
 * @param {string} params.userId - The user ending/leaving
 * @param {string} params.callId - The call session ID
 * @returns {Promise<{ ended: boolean, selfOnly?: boolean, callSession: Object }>}
 */
async function endCall({ userId, callId, leaveOnly = false }) {
  validateUserId(userId);
  validateCallId(callId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }

  // Idempotent: if call already ended, return success
  if (call.status === CALL_STATUS.ENDED) {
    console.log(`[call:end] Call ${callId} already ended — idempotent return`);
    return { ended: true, selfOnly: false, callSession: call, noop: true };
  }

  // Can only end active or ringing calls
  const endableStatuses = [CALL_STATUS.ACTIVE, CALL_STATUS.RINGING];
  if (!endableStatuses.includes(call.status)) {
    throw new CallError(
      `Call cannot be ended (current status: ${call.status})`,
      "CALL_ALREADY_ENDED",
      400,
    );
  }

  const uid = String(userId);
  const participant = callModel.findParticipant(call, uid);
  if (!participant) {
    throw new CallError("You are not a participant in this call", "NOT_PARTICIPANT", 403);
  }

  if (call.callMode === CALL_MODE.DIRECT) {
    // Direct: any participant ends for both (atomic)
    const ended = await callRepository.endCall(
      callId,
      uid,
      ENDED_REASON.USER_ENDED,
      call.startedAt,
    );
    await createCallLogMessage(ended);
    return { ended: true, callSession: ended };
  }

  // Group call
  const isInitiator = String(call.initiatorId) === uid;
  if (!leaveOnly) {
    const currentActive = await callRepository.findActiveForUser(uid);
    if (currentActive && String(currentActive.callId) !== String(callId)) {
      console.warn(
        `[call:end:stale-ignored] userId=${uid} staleCallId=${callId} currentCallId=${currentActive.callId}`,
      );
      return { ended: false, selfOnly: true, callSession: call, noop: true };
    }
  }

  if (isInitiator && !leaveOnly) {
    // Initiator ends the entire call for everyone
    console.log(`[GROUP_END] userId=${uid} callId=${callId} reason=host_ended`);
    const ended = await callRepository.endCall(
      callId,
      uid,
      ENDED_REASON.USER_ENDED,
      call.startedAt,
    );
    await createCallLogMessage(ended);
    return { ended: true, callSession: ended };
  }

  // Group leave: remove only this participant. This is intentionally separate
  // from explicit host end so closing one popup cannot end the whole group.
  console.log(`[GROUP_LEAVE] userId=${uid} callId=${callId} leaveOnly=true`);
  const updated = await callRepository.markParticipantLeft(callId, uid);

  // Check if any accepted participants remain
  const hasAccepted = updated.participants.some(
    (p) =>
      p.userId !== uid && p.status === PARTICIPANT_STATUS.ACCEPTED,
  );

  if (!hasAccepted) {
    // No one left in the call → end it
    const ended = await callRepository.endCall(
      callId,
      uid,
      ENDED_REASON.GROUP_EMPTY,
      call.startedAt,
    );
    await createCallLogMessage(ended);
    console.log(`[GROUP_END] userId=${uid} callId=${callId} reason=all_left`);
    return { ended: true, selfOnly: true, callSession: ended };
  }

  return { ended: false, selfOnly: true, callSession: updated };
}

/**
 * Get a fresh Agora token for an active call participant.
 *
 * @param {Object} params
 * @param {string} params.userId - The requesting user
 * @param {string} params.callId - The call session ID
 * @returns {Promise<Object>} Token payload
 */
async function getCallToken({ userId, callId }) {
  validateUserId(userId);
  validateCallId(callId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }

  // Can only get tokens for active/ringing calls
  const validStatuses = [CALL_STATUS.ACTIVE, CALL_STATUS.RINGING];
  if (!validStatuses.includes(call.status)) {
    throw new CallError(
      `Cannot get token for call with status: ${call.status}`,
      "CALL_ENDED",
      400,
    );
  }

  const uid = String(userId);
  const participant = callModel.findParticipant(call, uid);
  if (!participant) {
    throw new CallError("You are not a participant in this call", "NOT_PARTICIPANT", 403);
  }

  return generateTokenPayload(call.channelName, uid);
}

/**
 * Get call history for a conversation.
 *
 * @param {Object} params
 * @param {string} params.userId - The requesting user
 * @param {string} params.conversationId - The conversation
 * @param {Object} [params.pagination] - { limit, exclusiveStartKey }
 * @returns {Promise<{ items: Object[], nextCursor?: string }>}
 */
async function getHistory({ userId, conversationId, pagination = {} }) {
  validateUserId(userId);
  if (!conversationId) {
    throw new CallError("conversationId is required", "INVALID_INPUT", 400);
  }

  // Verify user is a member of this conversation (DB lookup, no string parsing)
  const { members } = await resolveConversation(conversationId);
  if (!members.includes(String(userId))) {
    throw new CallError(
      "You are not a member of this conversation",
      "NOT_MEMBER",
      403,
    );
  }

  const result = await callRepository.getHistoryByConversation(
    conversationId,
    pagination,
  );

  return {
    items: result.items,
    nextCursor: result.lastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString("base64")
      : null,
  };
}

/**
 * Get the user's current active or ringing call (for crash/background recovery).
 *
 * Returns the call session if the user has an active/ringing call, plus a fresh
 * Agora token payload if the call is still joinable (ringing or active).
 *
 * @param {string} userId
 * @returns {Promise<{ callSession: Object|null, tokenPayload?: Object }>}
 */
async function getActiveCall(userId) {
  validateUserId(userId);

  const activeCall = await callRepository.findActiveForUser(userId);
  if (!activeCall) {
    return { callSession: null };
  }

  const uid = String(userId);
  const participant = callModel.findParticipant(activeCall, uid);

  // Generate token only if the call is joinable (ringing or active)
  let tokenPayload = null;
  if (
    participant &&
    (activeCall.status === CALL_STATUS.ACTIVE || activeCall.status === CALL_STATUS.RINGING)
  ) {
    tokenPayload = generateTokenPayload(activeCall.channelName, uid);
  }

  return {
    callSession: activeCall,
    tokenPayload,
  };
}

/**
 * Handle ringing timeout — called by socket handler when 30s timer fires.
 *
 * Direct call:
 *   - End the call with no_answer_timeout
 *   - Mark all non-accepted participants as missed
 *
 * Group call:
 *   - Mark all still-invited participants as missed
 *   - If no one accepted → end the call
 *   - If at least one accepted → keep call alive (invited participants just become missed)
 *
 * @param {string} callId
 * @returns {Promise<{ ended: boolean, callSession: Object, missedUserIds: string[] }>}
 */
async function timeoutRingCall(callId) {
  validateCallId(callId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }
  // Only process if still ringing
  if (call.status !== CALL_STATUS.RINGING) {
    return { ended: false, callSession: call, missedUserIds: [] };
  }

  const missedUserIds = [];

  // Mark all still-invited participants as missed
  for (const p of call.participants) {
    if (p.status === PARTICIPANT_STATUS.INVITED) {
      await callRepository.updateParticipant(callId, p.userId, {
        status: PARTICIPANT_STATUS.MISSED,
      });
      missedUserIds.push(p.userId);
    }
  }

  if (call.callMode === CALL_MODE.DIRECT) {
    // Direct: no one answered → end call
    const ended = await callRepository.endCall(
      callId,
      call.initiatorId,
      ENDED_REASON.NO_ANSWER_TIMEOUT,
      null,
    );
    await createCallLogMessage(ended);
    return { ended: true, callSession: ended, missedUserIds };
  }

  // Group: check if anyone accepted
  const hasAccepted = call.participants.some(
    (p) => p.status === PARTICIPANT_STATUS.ACCEPTED,
  );

  if (!hasAccepted) {
    // No one accepted → end the call
    const ended = await callRepository.endCall(
      callId,
      call.initiatorId,
      ENDED_REASON.NO_ANSWER_TIMEOUT,
      null,
    );
    await createCallLogMessage(ended);
    return { ended: true, callSession: ended, missedUserIds };
  }

  // At least one accepted → call continues, just refresh
  const refreshed = await callRepository.getById(callId);
  return { ended: false, callSession: refreshed, missedUserIds };
}

/**
 * Handle participant socket disconnect during an active call.
 * Marks the participant as disconnected in DB.
 *
 * @param {string} callId
 * @param {string} userId
 * @returns {Promise<Object>} Updated call session
 */
async function handleParticipantDisconnect(callId, userId) {
  validateCallId(callId);
  validateUserId(userId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }

  const uid = String(userId);
  const participant = callModel.findParticipant(call, uid);
  if (!participant || participant.status !== PARTICIPANT_STATUS.ACCEPTED) {
    // Not an active participant — nothing to do
    return call;
  }

  const updated = await callRepository.markParticipantDisconnected(callId, uid);
  return updated;
}

/**
 * Handle participant reconnect after a disconnect.
 * Marks the participant as reconnected and returns a fresh token.
 *
 * @param {string} callId
 * @param {string} userId
 * @returns {Promise<{ callSession: Object, tokenPayload: Object }>}
 */
async function handleParticipantReconnect(callId, userId) {
  validateCallId(callId);
  validateUserId(userId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }

  const uid = String(userId);
  const updated = await callRepository.markParticipantReconnected(callId, uid);
  const tokenPayload = generateTokenPayload(updated.channelName, uid);
  if (updated.callMode === CALL_MODE.GROUP) {
    console.log(
      `[GROUP_JOIN_TOKEN] userId=${uid} callId=${callId} channelName=${updated.channelName} uid=${tokenPayload.uid}`,
    );
  }

  return { callSession: updated, tokenPayload };
}

/**
 * End a call because a participant's reconnect grace period expired.
 *
 * Direct call: end the entire call (atomic).
 * Group call: mark participant as left, then check if call should end.
 *
 * @param {string} callId
 * @param {string} userId - The user whose reconnect timed out
 * @returns {Promise<{ ended: boolean, callSession: Object }>}
 */
async function endCallDueToDisconnect(callId, userId) {
  validateCallId(callId);
  validateUserId(userId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }

  // Only process active calls
  if (call.status !== CALL_STATUS.ACTIVE) {
    return { ended: false, callSession: call };
  }

  const uid = String(userId);

  if (call.callMode === CALL_MODE.DIRECT) {
    // Direct: disconnect timeout ends the call for both
    const ended = await callRepository.endCall(
      callId,
      uid,
      ENDED_REASON.DISCONNECT_TIMEOUT,
      call.startedAt,
    );
    await createCallLogMessage(ended);
    return { ended: true, callSession: ended };
  }

  // Group: mark the disconnected user as left
  const updated = await callRepository.markParticipantLeft(callId, uid);

  // Check if any accepted participants remain
  const hasAccepted = updated.participants.some(
    (p) => p.userId !== uid && p.status === PARTICIPANT_STATUS.ACCEPTED,
  );

  if (!hasAccepted) {
    const ended = await callRepository.endCall(
      callId,
      uid,
      ENDED_REASON.GROUP_EMPTY,
      call.startedAt,
    );
    await createCallLogMessage(ended);
    return { ended: true, callSession: ended };
  }

  return { ended: false, callSession: updated };
}

/**
 * Timeout a single participant in a group call (ring timer per-participant).
 * Direct calls should use timeoutRingCall instead.
 *
 * @param {string} callId
 * @param {string} userId - The participant whose ring timed out
 * @returns {Promise<{ ended: boolean, callSession: Object, missedUserIds: string[] }>}
 */
async function timeoutParticipant(callId, userId) {
  validateCallId(callId);
  validateUserId(userId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }

  const uid = String(userId);
  const participant = callModel.findParticipant(call, uid);

  // Only process if still invited
  if (!participant || participant.status !== PARTICIPANT_STATUS.INVITED) {
    return { ended: false, callSession: call, missedUserIds: [] };
  }

  // Mark as missed
  await callRepository.updateParticipant(callId, uid, {
    status: PARTICIPANT_STATUS.MISSED,
  });

  // Check if call should end
  const hasAccepted = call.participants.some(
    (p) => p.status === PARTICIPANT_STATUS.ACCEPTED,
  );
  const hasPending = call.participants.some(
    (p) =>
      p.userId !== call.initiatorId &&
      p.userId !== uid &&
      p.status === PARTICIPANT_STATUS.INVITED,
  );

  if (!hasAccepted && !hasPending) {
    // No one accepted and no one pending → end call
    const ended = await callRepository.endCall(
      callId,
      call.initiatorId,
      ENDED_REASON.NO_ANSWER_TIMEOUT,
      null,
    );
    await createCallLogMessage(ended);
    return { ended: true, callSession: ended, missedUserIds: [uid] };
  }

  const refreshed = await callRepository.getById(callId);
  return { ended: false, callSession: refreshed, missedUserIds: [uid] };
}

/**
 * Late-join an existing group call (socket handler delegates here).
 *
 * @param {Object} params
 * @param {string} params.userId - The joining user
 * @param {string} params.callId - The call session ID
 * @returns {Promise<{ callSession: Object, tokenPayload: Object }>}
 */
async function joinCall({ userId, callId }) {
  validateUserId(userId);
  validateCallId(callId);

  const call = await callRepository.getById(callId);
  if (!call) {
    throw new CallError("Call not found", "CALL_NOT_FOUND", 404);
  }
  const joinableStatuses = [CALL_STATUS.ACTIVE, CALL_STATUS.RINGING];
  if (!joinableStatuses.includes(call.status)) {
    throw new CallError("Call is not joinable", "CALL_NOT_ACTIVE", 400);
  }
  if (call.callMode !== CALL_MODE.GROUP) {
    throw new CallError("Cannot join a direct call", "NOT_GROUP_CALL", 400);
  }

  const uid = String(userId);
  const isCurrentMember = await isUserInGroupConversation(call.conversationId, uid);
  if (!isCurrentMember) {
    throw new CallError(
      "You are not a member of this group",
      "NOT_GROUP_MEMBER",
      403,
    );
  }

  const existing = callModel.findParticipant(call, uid);

  let updatedCall;
  if (existing) {
    // Already a participant — rejoin (update status to accepted)
    updatedCall = await callRepository.updateParticipant(callId, uid, {
      status: PARTICIPANT_STATUS.ACCEPTED,
      joinedAt: new Date().toISOString(),
    });
  } else {
    // New participant — add to call
    updatedCall = await callRepository.addParticipant(callId, {
      userId: uid,
      role: "member",
      status: PARTICIPANT_STATUS.ACCEPTED,
      joinedAt: new Date().toISOString(),
    });
  }

  if (call.status === CALL_STATUS.RINGING) {
    updatedCall = await callRepository.activateCall(callId);
  }

  const tokenPayload = generateTokenPayload(updatedCall.channelName, uid);
  console.log(
    `[GROUP_JOIN_TOKEN] userId=${uid} callId=${callId} channelName=${updatedCall.channelName} uid=${tokenPayload.uid}`,
  );

  return { callSession: updatedCall, tokenPayload };
}

/**
 * Dev/admin helper: force-clean all blocking calls in a conversation.
 * Use when a conversation is permanently stuck with a stale call.
 * @param {string} conversationId
 * @returns {Promise<number>} number of calls cleaned
 */
async function cleanupConversationCalls(conversationId) {
  console.log(`[call:dev-cleanup] conversationId=${conversationId} — force cleaning all blocking calls`);
  const cleaned = await callRepository.cleanupStaleConversationCalls(conversationId, ENDED_REASON.SYSTEM_CLEANUP);
  console.log(`[call:dev-cleanup] conversationId=${conversationId} cleaned=${cleaned}`);
  return cleaned;
}

module.exports = {
  startCall,
  acceptCall,
  rejectCall,
  cancelCall,
  endCall,
  getCallToken,
  getHistory,
  getActiveCall,
  timeoutRingCall,
  timeoutParticipant,
  handleParticipantDisconnect,
  handleParticipantReconnect,
  endCallDueToDisconnect,
  joinCall,
  cleanupConversationCalls,
};
