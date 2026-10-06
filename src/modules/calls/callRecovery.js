/**
 * Call recovery job — runs once on server boot.
 *
 * Restores in-memory timer state from DynamoDB so that calls which were
 * ringing or had disconnected participants when the server crashed/shutdown
 * are handled correctly after restart.
 *
 * Recovery rules:
 *   Ringing calls:
 *     - createdAt > RING_TIMEOUT_MS (30s) → timeout immediately (DB only)
 *     - createdAt < RING_TIMEOUT_MS       → rebuild remaining ring timer
 *
 *   Active calls with disconnected participants:
 *     - disconnectedAt > RECONNECT_GRACE_MS (15s) → end/leave by disconnect timeout (DB only)
 *     - disconnectedAt < RECONNECT_GRACE_MS       → rebuild remaining reconnect timer
 *
 *   Group call participants with reconnecting status:
 *     - status='reconnecting' + disconnectedAt > RECONNECT_GRACE_MS → mark LEFT, end session if empty
 *     - status='reconnecting' + disconnectedAt < RECONNECT_GRACE_MS → rebuild group reconnect timer
 *
 * Duplicate call_log prevention:
 *   All service functions use the existing callLogCreated guard (atomic conditional
 *   update) so recovery will never create duplicate call_log messages.
 */

const callRepository = require("./callRepository");
const callService = require("./callService");
const {
  startRingTimer,
  startReconnectTimer,
} = require("./callSocketHandler");
const {
  CALL_MODE,
  CALL_STATUS,
  PARTICIPANT_STATUS,
  CONNECTION_STATE,
  TIMEOUTS,
} = require("./call.constants");

// ─── Recovery Entry Point ────────────────────────────────────────────────────

/**
 * Recover call state on server boot.
 * Scans DynamoDB for orphaned ringing/active calls and either:
 *   - Cleans up expired ones (DB update only, no socket events)
 *   - Rebuilds in-memory timers for still-valid ones
 *
 * @param {Object} io - Socket.IO server instance (needed for timer callbacks)
 * @returns {Promise<{ ringingRecovered: number, ringingExpired: number, disconnectRecovered: number, disconnectExpired: number, groupDisconnectRecovered: number, groupDisconnectExpired: number }>}
 */
async function recoverCallsOnBoot(io) {
  const stats = {
    ringingRecovered: 0,
    ringingExpired: 0,
    disconnectRecovered: 0,
    disconnectExpired: 0,
    groupDisconnectRecovered: 0,
    groupDisconnectExpired: 0,
  };

  const now = Date.now();

  // ── 1. Recover ringing calls ────────────────────────────────────────────

  let ringingCalls;
  try {
    ringingCalls = await callRepository.findAllRinging();
  } catch (err) {
    console.error("[call-recovery] Failed to scan ringing calls:", err.message);
    ringingCalls = [];
  }

  for (const call of ringingCalls) {
    try {
      const createdAtMs = new Date(call.createdAt).getTime();
      const elapsed = now - createdAtMs;
      const remaining = TIMEOUTS.RING_TIMEOUT_MS - elapsed;

      if (remaining <= 0) {
        // Expired — timeout immediately (DB update only)
        await callService.timeoutRingCall(call.callId);
        stats.ringingExpired++;
        console.log(
          `[call-recovery] Ringing call ${call.callId} expired (elapsed=${elapsed}ms), timed out`,
        );
      } else {
        // Still valid — rebuild ring timer with remaining time
        if (call.callMode === CALL_MODE.DIRECT) {
          // Direct: one timer for the whole call
          startRingTimer(io, call.callId, null, CALL_MODE.DIRECT, remaining);
          stats.ringingRecovered++;
        } else {
          // Group: per-participant timer for each invited participant
          const invitedParticipants = (call.participants || []).filter(
            (p) => p.status === PARTICIPANT_STATUS.INVITED,
          );
          for (const p of invitedParticipants) {
            startRingTimer(io, call.callId, p.userId, CALL_MODE.GROUP, remaining);
          }
          if (invitedParticipants.length > 0) {
            stats.ringingRecovered++;
          }
        }
        console.log(
          `[call-recovery] Ringing call ${call.callId} recovered (remaining=${remaining}ms, mode=${call.callMode})`,
        );
      }
    } catch (err) {
      console.error(
        `[call-recovery] Error recovering ringing call ${call.callId}:`,
        err.message,
      );
    }
  }

  // ── 2. Recover active calls with disconnected participants ──────────────

  let activeCalls;
  try {
    activeCalls = await callRepository.findAllActive();
  } catch (err) {
    console.error("[call-recovery] Failed to scan active calls:", err.message);
    activeCalls = [];
  }

  for (const call of activeCalls) {
    const disconnectedParticipants = (call.participants || []).filter(
      (p) =>
        p.connectionState === CONNECTION_STATE.DISCONNECTED &&
        p.status === PARTICIPANT_STATUS.ACCEPTED,
    );

    for (const p of disconnectedParticipants) {
      try {
        if (!p.disconnectedAt) {
          // No disconnect timestamp — skip (shouldn't happen)
          continue;
        }

        const disconnectedAtMs = new Date(p.disconnectedAt).getTime();
        const elapsed = now - disconnectedAtMs;
        const remaining = TIMEOUTS.RECONNECT_GRACE_MS - elapsed;

        if (remaining <= 0) {
          // Expired — end/leave by disconnect timeout (DB update only)
          await callService.endCallDueToDisconnect(call.callId, p.userId);
          stats.disconnectExpired++;
          console.log(
            `[call-recovery] Participant ${p.userId} in call ${call.callId} ` +
              `disconnect expired (elapsed=${elapsed}ms), ended/left`,
          );
        } else {
          // Still valid — rebuild reconnect timer with remaining time
          startReconnectTimer(io, call.callId, p.userId, remaining);
          stats.disconnectRecovered++;
          console.log(
            `[call-recovery] Participant ${p.userId} in call ${call.callId} ` +
              `reconnect recovered (remaining=${remaining}ms)`,
          );
        }
      } catch (err) {
        console.error(
          `[call-recovery] Error recovering disconnect for ${p.userId} in call ${call.callId}:`,
          err.message,
        );
      }
    }
  }

  // ── 3. Recover group call participants with reconnecting status ────────
  // Group call rebuild system uses status='reconnecting' instead of connectionState

  let groupCallRepo;
  try {
    groupCallRepo = require("./groupCallRepository");
  } catch {}

  if (groupCallRepo) {
    let activeGroupCalls;
    try {
      const { pool } = require("../../config/mysqlConfig");
      const [rows] = await pool.query(
        `SELECT * FROM call_sessions WHERE status = ? AND (call_type = ? OR call_mode = ?)`,
        ["active", "GROUP", "group"],
      );
      activeGroupCalls = rows.map((row) => ({
        callId: row.call_id,
        callType: row.call_type,
        callMode: row.call_mode,
        conversationId: row.conversation_id,
        status: row.status,
        participants: Array.isArray(row.participants) ? row.participants : [],
      }));
    } catch (err) {
      console.error("[call-recovery] Failed to scan group calls:", err.message);
      activeGroupCalls = [];
    }

    for (const call of activeGroupCalls) {
      const reconnectingParticipants = (call.participants || []).filter(
        (p) => String(p.status || '').toLowerCase() === 'reconnecting' && p.disconnectedAt,
      );

      for (const p of reconnectingParticipants) {
        try {
          const disconnectedAtMs = new Date(p.disconnectedAt).getTime();
          const elapsed = now - disconnectedAtMs;
          const remaining = TIMEOUTS.RECONNECT_GRACE_MS - elapsed;

          if (remaining <= 0) {
            await groupCallRepo.updateParticipantStatus(call.callId, p.userId, 'left');
            const allParticipants = await groupCallRepo.getParticipantsBySession(call.callId);
            const norm = (s) => String(s || '').toLowerCase();
            const joinedCount = allParticipants.filter((pp) => norm(pp.status) === 'joined').length;
            const reconnectingCount = allParticipants.filter((pp) => norm(pp.status) === 'reconnecting').length;
            if (joinedCount === 0 && reconnectingCount === 0) {
              await groupCallRepo.endSession(call.callId, 'disconnect_timeout');
              stats.groupDisconnectExpired++;
              console.log(
                `[call-recovery] Group call ${call.callId} expired (all disconnected), ended`,
              );
            } else {
              stats.groupDisconnectExpired++;
              console.log(
                `[call-recovery] Participant ${p.userId} in group call ${call.callId} disconnect expired, marked LEFT`,
              );
            }
          } else {
            try {
              const { startGroupReconnectTimer } = require("./groupCallSocketHandler");
              const emptyOnlineUsers = new Map();
              startGroupReconnectTimer(io, call.callId, p.userId, emptyOnlineUsers, remaining);
              stats.groupDisconnectRecovered++;
            } catch (timerErr) {
              console.warn(`[call-recovery] Could not rebuild timer for group call ${call.callId}:${p.userId}:`, timerErr.message);
              stats.groupDisconnectRecovered++;
            }
            console.log(
              `[call-recovery] Participant ${p.userId} in group call ${call.callId} reconnect recovered (remaining=${remaining}ms)`,
            );
          }
        } catch (err) {
          console.error(
            `[call-recovery] Error recovering group call disconnect for ${p.userId} in ${call.callId}:`,
            err.message,
          );
        }
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  const total =
    stats.ringingRecovered +
    stats.ringingExpired +
    stats.disconnectRecovered +
    stats.disconnectExpired +
    stats.groupDisconnectRecovered +
    stats.groupDisconnectExpired;

  if (total > 0) {
    console.log(
      `[call-recovery] Recovery complete: ` +
        `${stats.ringingExpired} ringing expired, ` +
        `${stats.ringingRecovered} ringing recovered, ` +
        `${stats.disconnectExpired} disconnect expired, ` +
        `${stats.disconnectRecovered} disconnect recovered, ` +
        `${stats.groupDisconnectExpired} group disconnect expired, ` +
        `${stats.groupDisconnectRecovered} group disconnect recovered`,
    );
  } else {
    console.log("[call-recovery] No stale calls found — clean startup");
  }

  return stats;
}

module.exports = { recoverCallsOnBoot };
