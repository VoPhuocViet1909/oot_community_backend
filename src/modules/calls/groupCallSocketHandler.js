'use strict';

const groupCallService = require('./groupCallService');
const { onlineUsers: defaultOnlineUsers } = require('../../socket/socketUserRegistry');
const { getUserById } = require('../users/userService');
const { sendPushNotificationForCall } = require('../notifications/notificationService');

// ── Reconnect grace timers for group calls ──────────────────────────────────
// Separate from direct call timers in callSocketHandler.js
const groupReconnectTimers = new Map(); // key: "sessionId:userId" → setTimeout

function startGroupReconnectTimer(io, sessionId, userId, onlineUsers, timeoutMs) {
  const key = `${sessionId}:${userId}`;
  if (groupReconnectTimers.has(key)) return;

  const timer = setTimeout(async () => {
    groupReconnectTimers.delete(key);
    try {
      const result = await groupCallService.endCallDueToDisconnect(sessionId, userId);
      if (result.ended) {
        await broadcastSessionEnded(io, sessionId, onlineUsers, 'disconnect_timeout');
        const session = await require('./groupCallRepository').getSession(sessionId);
        emitConversationCallEnded(io, session, 'disconnect_timeout');
      } else {
        // Notify remaining participants that this user left
        const groupCallRepo = require('./groupCallRepository');
        const joinedParticipants = await groupCallRepo.getJoinedParticipants(sessionId);
        for (const p of joinedParticipants) {
          const targetSockets = getUserSockets(io, p.userId, onlineUsers);
          for (const s of targetSockets) {
            s.emit('group-call:participant-left', {
              sessionId,
              leftUserId: userId,
              reason: 'disconnect_timeout',
            });
          }
        }
      }
    } catch (err) {
      console.error(`[GROUP_CALL] Reconnect timeout error for ${sessionId}:${userId}:`, err.message);
    }
  }, timeoutMs || 30000); // 30s default

  groupReconnectTimers.set(key, timer);
}

function cancelGroupReconnectTimer(sessionId, userId) {
  const key = `${sessionId}:${userId}`;
  const timer = groupReconnectTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    groupReconnectTimers.delete(key);
  }
}

function cancelAllGroupReconnectTimers(sessionId) {
  const prefix = `${sessionId}:`;
  for (const [key, timer] of groupReconnectTimers.entries()) {
    if (key.startsWith(prefix)) {
      clearTimeout(timer);
      groupReconnectTimers.delete(key);
    }
  }
}

/**
 * GROUP CALL SOCKET HANDLER — CLEAN REBUILD
 *
 * Registers group-specific socket events only.
 * Does NOT touch direct call logic.
 */

function getSocketUserId(socket) {
  return socket.userId || socket.user?.userId || socket.user?.id;
}

/**
 * Look up user display info from the users table.
 */
async function getUserDisplayInfo(userId) {
  try {
    const u = await getUserById(String(userId));
    return {
      displayName: u?.display_name || u?.username || String(userId),
      avatarUrl: u?.avatar_url || null,
    };
  } catch {
    return { displayName: String(userId), avatarUrl: null };
  }
}

/**
 * Generate deterministic Agora UID from userId (same algorithm as groupCallService.hashCode).
 */
function hashCode(str) {
  let hash = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Enrich a list of participants with displayName, avatarUrl, and agoraUid.
 * @param {Array<{userId: string, role?: string, status?: string}>} participants
 * @returns {Promise<Array<{userId, displayName, avatarUrl, agoraUid, role, status}>>}
 */
async function enrichParticipants(participants) {
  return Promise.all(
    (participants || []).map(async (p) => {
      const info = await getUserDisplayInfo(p.userId);
      return {
        userId: p.userId,
        displayName: info.displayName,
        avatarUrl: info.avatarUrl,
        agoraUid: hashCode(p.userId),
        ...(p.role !== undefined && { role: p.role }),
        ...(p.status !== undefined && { status: p.status }),
      };
    }),
  );
}

function registerGroupCallSocketHandlers(io, socket, onlineUsers = defaultOnlineUsers) {
  // ── group-call:start ──────────────────────────────────────────────────────
  socket.on('group-call:start', async (data) => {
    try {
      const { conversationId } = data;
      const userId = getSocketUserId(socket);
      if (!userId || !conversationId) return;

      console.log(`[GROUP_CALL_START] userId=${userId} conversationId=${conversationId}`);

      // Resolve group members from the socket room or data
      const memberUserIds = data.memberUserIds || [];
      if (!memberUserIds.includes(userId)) {
        memberUserIds.unshift(userId);
      }

      const result = await groupCallService.startGroupCall({
        conversationId,
        hostUserId: userId,
        memberUserIds,
      });

      const { session, hostJoinPayload, inviteeUserIds } = result;

      // Send join payload to host (the caller)
      const enrichedParticipants = await enrichParticipants(result.participants);

      socket.emit('group-call:started', {
        sessionId: session.id,
        callType: 'GROUP',
        channelName: session.channelName,
        token: hostJoinPayload.token,
        uid: hostJoinPayload.uid,
        conversationId,
        participants: enrichedParticipants,
      });

      // Emit incoming to each invitee
      for (const inviteeId of inviteeUserIds) {
        const sockets = getUserSockets(io, inviteeId, onlineUsers);
        const socketCount = sockets.length;
        console.log(`[GROUP_CALL_INCOMING_EMIT] userId=${inviteeId} socketCount=${socketCount}`);

        for (const s of sockets) {
          s.emit('group-call:incoming', {
            sessionId: session.id,
            callType: 'GROUP',
            conversationId,
            channelName: session.channelName,
            hostUserId: userId,
            participants: enrichedParticipants,
          });
        }
      }
      // FCM push notification for invitees
      const hostDisplayInfo = await getUserDisplayInfo(userId);
      sendPushNotificationForCall({
        recipients: inviteeUserIds,
        callerName: hostDisplayInfo.displayName,
        data: {
          callType: 'GROUP',
          callId: session.id,
          conversationId,
          channelName: session.channelName,
          callerId: userId,
        }
      }).catch(err => console.error('[FCM_PUSH_ERROR]', err));

    } catch (err) {
      console.error('[GROUP_CALL_START_ERROR]', err.message);
      socket.emit('group-call:error', { message: err.message });
    }
  });

  // ── group-call:accept ─────────────────────────────────────────────────────
  socket.on('group-call:accept', async (data) => {
    try {
      const sessionId = data.sessionId || data.callId;
      const userId = getSocketUserId(socket);
      if (!userId || !sessionId) return;

      console.log(`[GROUP_CALL_ACCEPT] sessionId=${sessionId} userId=${userId}`);

      const joinPayload = await groupCallService.acceptGroupCall({ sessionId, userId });

      // Send join info ONLY to the accepting user
      socket.emit('group-call:accepted', joinPayload);

      console.log(`[GROUP_CALL_ACCEPTED_EMIT] sessionId=${sessionId} userId=${userId}`);

      // Broadcast participant-joined to all already-JOINED participants
      // We need to get joined participants to notify them
      const groupCallRepo = require('./groupCallRepository');
      const joinedParticipants = await groupCallRepo.getJoinedParticipants(sessionId);
      const enrichedJoined = await enrichParticipants(joinedParticipants);

      for (const p of joinedParticipants) {
        if (String(p.userId) === String(userId)) continue; // skip self
        const targetSockets = getUserSockets(io, p.userId, onlineUsers);
        for (const s of targetSockets) {
          s.emit('group-call:participant-joined', {
            sessionId,
            joinedUserId: userId,
            participants: enrichedJoined,
          });
        }
      }

      // Also notify still-RINGING participants so they know someone joined
      const allParticipants = await groupCallRepo.getParticipantsBySession(sessionId);
      const enrichedAll = await enrichParticipants(allParticipants);
      const ringingParticipants = allParticipants.filter(
        (p) => p.status === 'RINGING' || p.status === 'INVITED'
      );
      for (const p of ringingParticipants) {
        const targetSockets = getUserSockets(io, p.userId, onlineUsers);
        for (const s of targetSockets) {
          s.emit('group-call:state', {
            sessionId,
            status: 'ACTIVE',
            participants: enrichedAll,
          });
        }
      }
    } catch (err) {
      console.error('[GROUP_CALL_ACCEPT_ERROR]', err.message);
      socket.emit('group-call:error', { message: err.message });
    }
  });

  // ── group-call:reject ─────────────────────────────────────────────────────
  socket.on('group-call:reject', async (data) => {
    try {
      const sessionId = data.sessionId || data.callId;
      const userId = getSocketUserId(socket);
      if (!userId || !sessionId) return;

      await groupCallService.rejectGroupCall({ sessionId, userId });

      // Broadcast to already-joined participants
      const groupCallRepo = require('./groupCallRepository');
      const joinedParticipants = await groupCallRepo.getJoinedParticipants(sessionId);
      for (const p of joinedParticipants) {
        const targetSockets = getUserSockets(io, p.userId, onlineUsers);
        for (const s of targetSockets) {
          s.emit('group-call:participant-rejected', {
            sessionId,
            rejectedUserId: userId,
          });
        }
      }

      // Check if session ended
      const session = await groupCallRepo.getSession(sessionId);
      if (session && session.status === 'ENDED') {
        await broadcastSessionEnded(io, sessionId, onlineUsers);
        emitConversationCallEnded(io, session, 'all_rejected');
      }
    } catch (err) {
      console.error('[GROUP_CALL_REJECT_ERROR]', err.message);
    }
  });

  // ── group-call:leave ──────────────────────────────────────────────────────
  socket.on('group-call:leave', async (data) => {
    try {
      const sessionId = data.sessionId || data.callId;
      const userId = getSocketUserId(socket);
      if (!userId || !sessionId) return;

      console.log(`[GROUP_CALL_LEAVE] sessionId=${sessionId} userId=${userId}`);

      await groupCallService.leaveGroupCall({ sessionId, userId });

      // Broadcast to remaining joined participants
      const groupCallRepo = require('./groupCallRepository');
      const joinedParticipants = await groupCallRepo.getJoinedParticipants(sessionId);
      for (const p of joinedParticipants) {
        const targetSockets = getUserSockets(io, p.userId, onlineUsers);
        for (const s of targetSockets) {
          s.emit('group-call:participant-left', {
            sessionId,
            leftUserId: userId,
          });
        }
      }

      // Check if session ended
      const session = await groupCallRepo.getSession(sessionId);
      if (session && session.status === 'ENDED') {
        await broadcastSessionEnded(io, sessionId, onlineUsers);
        emitConversationCallEnded(io, session, 'all_left');
      }
    } catch (err) {
      console.error('[GROUP_CALL_LEAVE_ERROR]', err.message);
    }
  });

  // ── group-call:end ────────────────────────────────────────────────────────
  socket.on('group-call:end', async (data) => {
    try {
      const sessionId = data.sessionId || data.callId;
      const userId = getSocketUserId(socket);
      if (!userId || !sessionId) return;

      console.log(`[GROUP_CALL_END] sessionId=${sessionId} userId=${userId}`);

      const result = await groupCallService.endGroupCall({
        sessionId,
        userId,
        reason: 'host_ended',
      });

      // Broadcast ended to ALL participants
      await broadcastSessionEnded(io, sessionId, onlineUsers, result.reason);
      const session = await require('./groupCallRepository').getSession(sessionId);
      emitConversationCallEnded(io, session, result.reason);
    } catch (err) {
      console.error('[GROUP_CALL_END_ERROR]', err.message);
    }
  });

  // ── Reconnect: check if user was in a group call with disconnected state ──
  const userId = getSocketUserId(socket);
  (async () => {
    try {
      const groupCallRepo = require('./groupCallRepository');
      const activeSession = await groupCallRepo.getActiveSessionForUser(userId);
      if (!activeSession) return;

      const participant = (activeSession.participants || []).find(
        (p) => String(p.userId) === String(userId)
      );
      if (!participant) return;

      const norm = (s) => String(s || '').toLowerCase();
      if (norm(participant.status) === 'reconnecting') {
        // User was disconnected — reconnect them
        cancelGroupReconnectTimer(activeSession.id, userId);

        const result = await groupCallService.handleReconnect(activeSession.id, userId);
        if (!result) return;

        const { session, tokenPayload } = result;

        // Join call room
        socket.join(`call:${activeSession.id}`);

        // Send fresh token to reconnecting user
        socket.emit('call:participant-reconnected', {
          callId: activeSession.id,
          userId,
          token: tokenPayload.token,
          uid: tokenPayload.uid,
          channelName: tokenPayload.channelName,
        });

        // Notify other participants
        const joinedParticipants = await groupCallRepo.getJoinedParticipants(activeSession.id);
        for (const p of joinedParticipants) {
          if (String(p.userId) === String(userId)) continue;
          const targetSockets = getUserSockets(io, p.userId, onlineUsers);
          for (const s of targetSockets) {
            s.emit('call:participant-reconnected', {
              callId: activeSession.id,
              userId,
            });
          }
        }

        console.log(`[GROUP_CALL_RECONNECT] User ${userId} reconnected to group call ${activeSession.id}`);
      } else if (norm(participant.status) === 'joined') {
        // User is already joined — just rejoin the socket room
        socket.join(`call:${activeSession.id}`);
        console.log(`[GROUP_CALL_RECONNECT] User ${userId} re-joined group call room ${activeSession.id}`);
      }
    } catch (err) {
      console.error(`[GROUP_CALL_RECONNECT] Reconnect check error for user ${userId}:`, err.message);
    }
  })();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function broadcastSessionEnded(io, sessionId, onlineUsers, reason = 'ended') {
  const groupCallRepo = require('./groupCallRepository');
  const session = await groupCallRepo.getSession(sessionId);
  const allParticipants = await groupCallRepo.getParticipantsBySession(sessionId);
  
  for (const p of allParticipants) {
    const targetSockets = getUserSockets(io, p.userId, onlineUsers);
    for (const s of targetSockets) {
      s.emit('group-call:ended', {
        sessionId,
        callId: sessionId,
        conversationId: session?.conversationId || null,
        reason,
      });
    }
  }
}

function emitConversationCallEnded(io, session, reason = 'ended') {
  if (!session?.conversationId) return;

  io.to(String(session.conversationId)).emit('group_call_ended', {
    type: 'GROUP_CALL',
    status: 'ended',
    phase: 'ended',
    conversationId: String(session.conversationId),
    callId: String(session.id || session.callId),
    reason,
    content: 'Cuộc gọi đã kết thúc',
  });
}

function getUserSockets(io, userId, onlineUsers) {
  const sockets = [];
  const socketIds = onlineUsers.get(String(userId));
  if (socketIds) {
    for (const sid of socketIds) {
      const s = io.sockets.sockets.get(sid);
      if (s) sockets.push(s);
    }
  }
  return sockets;
}

/**
 * Handle socket disconnect for group calls.
 * Called from socketHandler.js when a socket disconnects.
 * Checks if the user was in an active group call and starts reconnect timer.
 */
async function handleGroupCallDisconnect(io, userId, socketId, onlineUsers) {
  if (!userId) return;

  try {
    // Check if user has other sockets connected (multi-device)
    const userKey = String(userId);
    const remainingSockets = onlineUsers.get(userKey);
    if (remainingSockets && remainingSockets.size > 0) return;

    // Check if user is in an active group call
    const groupCallRepo = require('./groupCallRepository');
    const activeSession = await groupCallRepo.getActiveSessionForUser(userId);
    if (!activeSession) return;

    const participant = (activeSession.participants || []).find(
      (p) => String(p.userId) === String(userId)
    );
    if (!participant) return;

    const norm = (s) => String(s || '').toLowerCase();
    if (norm(participant.status) !== 'joined') return;

    // Mark participant as disconnected
    await groupCallService.handleDisconnect(activeSession.id, userId);

    // Notify other participants
    const joinedParticipants = await groupCallRepo.getJoinedParticipants(activeSession.id);
    for (const p of joinedParticipants) {
      if (String(p.userId) === String(userId)) continue;
      const targetSockets = getUserSockets(io, p.userId, onlineUsers);
      for (const s of targetSockets) {
        s.emit('call:participant-disconnected', {
          callId: activeSession.id,
          userId,
          graceMs: 30000,
        });
      }
    }

    // Start reconnect grace timer
    startGroupReconnectTimer(io, activeSession.id, userId, onlineUsers, 30000);

    console.log(`[GROUP_CALL_DISCONNECT] User ${userId} disconnected from group call ${activeSession.id}, reconnect grace started (30s)`);
  } catch (err) {
    console.error(`[GROUP_CALL_DISCONNECT] Error for user ${userId}:`, err.message);
  }
}

module.exports = {
  registerGroupCallHandlers: registerGroupCallSocketHandlers,
  registerGroupCallSocketHandlers,
  handleGroupCallDisconnect,
  startGroupReconnectTimer,
};
