const { pool } = require('../../config/mysqlConfig');
const crypto = require('crypto');

const { onlineUsers } = require('../../socket/socketUserRegistry');

function getActiveIO() {
  return require('../../socket/socketHandler').getIO();
}

function forceJoinGroup(userId, groupId) {
  const io = getActiveIO();
  if (!io) return;
  const sockets = onlineUsers.get(String(userId));
  if (sockets) {
    sockets.forEach(sockId => {
      const socket = io.sockets.sockets.get(sockId);
      if (socket) socket.join(String(groupId));
    });
  }
}

function forceLeaveGroup(userId, groupId) {
  const io = getActiveIO();
  if (!io) return;
  const sockets = onlineUsers.get(String(userId));
  if (sockets) {
    sockets.forEach(sockId => {
      const socket = io.sockets.sockets.get(sockId);
      if (socket) socket.leave(String(groupId));
    });
  }
}

async function checkUserInGroup(groupId, userId) {
  const groupKey = String(groupId || '').trim();
  const userKey = String(userId || '').trim();
  if (!groupKey || !userKey) return false;

  const [rows] = await pool.query(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1',
    [groupKey, userKey]
  );

  return rows.length > 0;
}

async function cleanupGroupIfEmpty(groupId) {
  const groupKey = String(groupId || '').trim();
  if (!groupKey) return false;

  const [rows] = await pool.query(
    'SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ?',
    [groupKey]
  );
  const count = rows[0] ? Number(rows[0].cnt) : 0;

  if (count > 0) return false;

  await pool.query('DELETE FROM groups_ WHERE group_id = ?', [groupKey]);

  const io = getActiveIO();
  if (io) {
    io.to(groupKey).emit('group:deleted', { groupId: groupKey });
  }

  return true;
}

function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

async function createGroup(payload) {
  if (!payload.name) {
    throw new Error('Group name is required');
  }

  const now = new Date().toISOString();
  // groupId là khoá chính (string)
  const groupId = `group_${Date.now()}`;

  const ownerId = payload.ownerId || payload.createdBy || null;
  const userIds = Array.isArray(payload.userIds) ? payload.userIds.filter(u => u && String(u) !== String(ownerId)) : [];

  const groupItem = {
    groupId,
    name: payload.name,
    description: payload.description || '',
    avatar_url: null,
    type: payload.type || 'public_community',
    member_count: (ownerId ? 1 : 0) + userIds.length,
    created_by: ownerId,
    created_at: now,
    inviteCode: generateInviteCode(),
    isApprovalRequired: false,
    allowSendLinks: payload.allowSendLinks || 'ALL', // 'ALL' hoặc 'ADMINS_ONLY'
    spamFilterLevel: payload.spamFilterLevel !== undefined ? payload.spamFilterLevel : 1 // 0: Tắt, 1: Vừa, 2: Gắt gao
  };

  // Transaction: group INSERT + all member INSERTs atomically. A crash mid-way
  // now rolls back fully instead of leaving a group with partial membership.
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      `INSERT INTO groups_ (group_id, name, description, avatar_url, type, member_count, created_by, invite_code, is_approval_required, allow_send_links, spam_filter_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        groupItem.groupId,
        groupItem.name,
        groupItem.description,
        groupItem.avatar_url,
        groupItem.type,
        groupItem.member_count,
        groupItem.created_by,
        groupItem.inviteCode,
        0,
        groupItem.allowSendLinks,
        groupItem.spamFilterLevel,
        now,
        now
      ]
    );

    if (ownerId) {
      await connection.query(
        'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        [groupId, String(ownerId), 'OWNER', now]
      );
    }

    for (const uid of userIds) {
      await connection.query(
        'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        [groupId, String(uid), 'MEMBER', now]
      );
    }

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  return groupItem;
}

async function listGroups() {
  const [rows] = await pool.query('SELECT * FROM groups_');

  const sorted = rows.slice().sort((a, b) => {
    const aTime = a.created_at || '';
    const bTime = b.created_at || '';
    return bTime.localeCompare(aTime);
  });

  return sorted.map((g) => ({
    groupId: g.group_id,
    name: g.name,
    description: g.description,
    topic: g.type,
    avatarUrl: g.avatar_url,
    memberCount: g.member_count,
    createdBy: g.created_by,
    createdAt: g.created_at,
    isApprovalRequired: !!g.is_approval_required,
    allowSendLinks: g.allow_send_links || 'ALL',
    spamFilterLevel: g.spam_filter_level !== undefined && g.spam_filter_level !== null ? g.spam_filter_level : 1
  }));
}

async function getGroupById(groupId) {
  const [rows] = await pool.query('SELECT * FROM groups_ WHERE group_id = ? LIMIT 1', [String(groupId)]);
  const g = rows[0];
  if (!g) return null;

  return {
    groupId: g.group_id,
    name: g.name,
    description: g.description,
    topic: g.type,
    avatarUrl: g.avatar_url,
    memberCount: g.member_count,
    createdBy: g.created_by,
    createdAt: g.created_at,
    isApprovalRequired: !!g.is_approval_required,
    pinnedMessages: g.pinned_messages || [],
    allowSendLinks: g.allow_send_links || 'ALL',
    spamFilterLevel: g.spam_filter_level !== undefined && g.spam_filter_level !== null ? g.spam_filter_level : 1
  };
}

async function addMemberToGroup(groupId, userId, role = 'member') {
  const now = new Date().toISOString();
  const groupKey = String(groupId);
  const userKey = String(userId);

  await pool.query(
    `INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), joined_at = VALUES(joined_at)`,
    [groupKey, userKey, role, now]
  );

  return { groupId: groupKey, userId: userKey, role };
}

async function addMembersToGroup(groupId, requestUserId, userIds) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);

  const [reqRows] = await pool.query(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1',
    [groupKey, reqUserKey]
  );

  if (!reqRows.length) {
    const err = new Error('403 Forbidden: You are not a member of this group');
    err.status = 403;
    throw err;
  }

  const [currentMembers] = await pool.query('SELECT user_id FROM group_members WHERE group_id = ?', [groupKey]);
  const existingUserIds = currentMembers.map(m => m.user_id);

  const newMembers = (Array.isArray(userIds) ? userIds : []).filter(uid => uid && !existingUserIds.includes(String(uid)) && String(uid) !== reqUserKey);

  const now = new Date().toISOString();
  const newMemberObjects = [];

  for (const uid of newMembers) {
    await pool.query(
      'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [groupKey, String(uid), 'MEMBER', now]
    );

    // Lấy thông tin user
    const [uRows] = await pool.query('SELECT * FROM users WHERE user_id = ? LIMIT 1', [String(uid)]);
    const u = uRows[0] || {};
    newMemberObjects.push({
      userId: String(uid),
      displayName: u.display_name || u.username || String(uid),
      username: u.username || u.display_name || String(uid),
      avatarUrl: u.avatar_url || null,
      role: 'MEMBER',
      joinedAt: now
    });
  }

  if (newMembers.length > 0) {
    await pool.query('UPDATE groups_ SET member_count = member_count + ? WHERE group_id = ?', [newMembers.length, groupKey]);

    // NOTE: socket emit 'group:members_added' is handled by groupController.addMembers
    // to ensure only 1 emit with full payload (including groupData). No emit here to avoid duplication.
  }

  return { addedCount: newMembers.length, addedMembers: newMemberObjects };
}

async function kickMember(groupId, requestUserId, targetUserId) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);
  const targetKey = String(targetUserId);

  if (reqUserKey === targetKey) {
    const err = new Error('400 Bad Request: You cannot kick yourself. Please leave the group instead.');
    err.status = 400;
    throw err;
  }

  const [reqRows] = await pool.query('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, reqUserKey]);
  const reqMember = reqRows[0];

  if (!reqMember) {
    const err = new Error('403 Forbidden: You are not in this group');
    err.status = 403;
    throw err;
  }

  const reqRole = (reqMember.role || 'MEMBER').toUpperCase();
  if (reqRole !== 'OWNER' && reqRole !== 'DEPUTY') {
    const err = new Error('403 Forbidden: Only OWNER or DEPUTY can kick members');
    err.status = 403;
    throw err;
  }

  const [targetRows] = await pool.query('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, targetKey]);
  const targetMember = targetRows[0];

  if (!targetMember) {
    const err = new Error('404 Not Found: Target user is not in the group');
    err.status = 404;
    throw err;
  }

  const targetRole = (targetMember.role || 'MEMBER').toUpperCase();
  if (reqRole === 'DEPUTY' && targetRole !== 'MEMBER') {
    const err = new Error('403 Forbidden: DEPUTY can only kick roles of MEMBER level');
    err.status = 403;
    throw err;
  }

  await pool.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupKey, targetKey]);

  // NOTE: non-conditional decrement, no floor-at-zero guard — preserved from the original behavior.
  await pool.query('UPDATE groups_ SET member_count = member_count - ? WHERE group_id = ?', [1, groupKey]);

  forceLeaveGroup(targetKey, groupKey);
  await cleanupGroupIfEmpty(groupKey);

  return { message: 'Member kicked successfully' };
}

async function updateRole(groupId, requestUserId, targetUserId, newRole) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);
  const targetKey = String(targetUserId);
  const roleUpper = String(newRole).toUpperCase();

  if (roleUpper !== 'DEPUTY' && roleUpper !== 'MEMBER') {
    const err = new Error('400 Bad Request: newRole must be either DEPUTY or MEMBER');
    err.status = 400;
    throw err;
  }

  const [reqRows] = await pool.query('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, reqUserKey]);
  const reqMember = reqRows[0];

  if (!reqMember || (reqMember.role || '').toUpperCase() !== 'OWNER') {
    const err = new Error('403 Forbidden: Only OWNER can update roles');
    err.status = 403;
    throw err;
  }

  const [targetRows] = await pool.query('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, targetKey]);
  const targetMember = targetRows[0];

  if (!targetMember) {
    const err = new Error('404 Not Found: Target user is not in the group');
    err.status = 404;
    throw err;
  }

  if ((targetMember.role || '').toUpperCase() === 'OWNER') {
    const err = new Error('400 Bad Request: Cannot change the role of the OWNER using this API');
    err.status = 400;
    throw err;
  }

  await pool.query('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', [roleUpper, groupKey, targetKey]);

  const io = getActiveIO();
  if (io) {
    io.to(groupKey).emit('SERVER:ROLE_UPDATED', {
      groupId: groupKey,
      targetUserId: targetKey,
      newRole: roleUpper
    });
  }

  return { message: 'Role updated successfully', newRole: roleUpper };
}

async function leaveGroup(groupId, requestUserId, newOwnerId = null) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);

  const [reqRows] = await pool.query('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, reqUserKey]);
  const reqMember = reqRows[0];

  if (!reqMember) {
    const err = new Error('404 Not Found: You are not a member of this group');
    err.status = 404;
    throw err;
  }

  // Get all members to check count
  const [allMembers] = await pool.query('SELECT user_id, role FROM group_members WHERE group_id = ?', [groupKey]);

  if ((reqMember.role || '').toUpperCase() === 'OWNER') {
    if (allMembers.length > 1) {
      if (!newOwnerId) {
        const err = new Error('Bạn phải nhường quyền Trưởng nhóm (OWNER) cho người khác trước khi rời');
        err.status = 400;
        throw err;
      }

      const newOwnerKey = String(newOwnerId);
      const newOwner = allMembers.find(m => m.user_id === newOwnerKey);
      if (!newOwner) {
        const err = new Error('Người được chọn làm Trưởng nhóm mới không có trong nhóm');
        err.status = 400;
        throw err;
      }

      // Promote new owner
      await pool.query('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', ['OWNER', groupKey, newOwnerKey]);

      // Update creator in groups_ table
      await pool.query('UPDATE groups_ SET created_by = ? WHERE group_id = ?', [newOwnerKey, groupKey]);

      // Emit event owner_transferred
      const io = getActiveIO();
      if (io) {
        io.to(groupKey).emit('group:owner_transferred', { newOwnerId: newOwnerKey, oldOwnerId: reqUserKey });
        // And also update role socket for frontend compatibility
        io.to(groupKey).emit('SERVER:ROLE_UPDATED', { targetUserId: newOwnerKey, newRole: 'OWNER', groupId: groupKey });
      }
    } else {
      // It's the last member (owner), disband the group entirely
      return await disbandGroup(groupKey, reqUserKey);
    }
  }

  await pool.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupKey, reqUserKey]);

  // NOTE: non-conditional decrement, no floor-at-zero guard — preserved from the original behavior.
  await pool.query('UPDATE groups_ SET member_count = member_count - ? WHERE group_id = ?', [1, groupKey]);

  forceLeaveGroup(reqUserKey, groupKey);
  await cleanupGroupIfEmpty(groupKey);

  return { message: 'Successfully left the group' };
}

async function getGroupsForUser(userId) {
  const userKey = String(userId);

  // Single JOIN replaces the old Scan-by-userId + N GetItems (N+1) pattern.
  const [rows] = await pool.query(
    'SELECT g.* FROM groups_ g JOIN group_members gm ON gm.group_id = g.group_id WHERE gm.user_id = ?',
    [userKey]
  );

  return rows.map((g) => ({
    groupId: g.group_id,
    name: g.name,
    description: g.description,
    topic: g.type,
    avatarUrl: g.avatar_url,
    memberCount: g.member_count,
    createdBy: g.created_by,
    createdAt: g.created_at,
    isApprovalRequired: !!g.is_approval_required,
    pinnedMessages: g.pinned_messages || [],
    allowSendLinks: g.allow_send_links || 'ALL',
    spamFilterLevel: g.spam_filter_level !== undefined && g.spam_filter_level !== null ? g.spam_filter_level : 1
  }));
}

async function getGroupMembers(groupId) {
  const groupKey = String(groupId || '').trim();
  if (!groupKey) {
    throw new Error('Group ID is required');
  }

  // Single JOIN against users replaces the old Query + N GetItems (N+1) pattern.
  const [rows] = await pool.query(
    `SELECT gm.user_id, gm.role, gm.joined_at, u.display_name, u.username, u.avatar_url
     FROM group_members gm
     LEFT JOIN users u ON u.user_id = gm.user_id
     WHERE gm.group_id = ?`,
    [groupKey]
  );

  if (!rows.length) return [];

  return rows.map((row) => {
    const uid = String(row.user_id || '');
    return {
      userId: uid,
      displayName: row.display_name || row.username || uid,
      username: row.username || row.display_name || uid,
      avatarUrl: row.avatar_url || null,
      role: row.role || 'member',
      joinedAt: row.joined_at || null,
    };
  });
}

async function getInviteLink(groupId) {
  const group = await getGroupById(groupId);
  if (!group) {
    throw new Error('Group not found');
  }

  const [rows] = await pool.query('SELECT invite_code FROM groups_ WHERE group_id = ? LIMIT 1', [String(groupId)]);
  const inviteCode = rows[0] ? rows[0].invite_code : null;
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000';
  const inviteLink = `${baseUrl}/join/${inviteCode}`;

  return { inviteCode, inviteLink };
}

function mapGroupItem(g) {
  return {
    groupId: g.group_id,
    name: g.name,
    description: g.description,
    topic: g.type,
    avatarUrl: g.avatar_url,
    memberCount: g.member_count,
    createdBy: g.created_by,
    createdAt: g.created_at,
    isApprovalRequired: !!g.is_approval_required,
    inviteCode: g.invite_code,
    allowSendLinks: g.allow_send_links || 'ALL',
    spamFilterLevel: g.spam_filter_level !== undefined && g.spam_filter_level !== null ? g.spam_filter_level : 1
  };
}

async function getGroupByInviteCode(inviteCode) {
  const normalizedCode = String(inviteCode || '').trim().toLowerCase();
  if (!normalizedCode) {
    throw new Error('Invalid invite code');
  }

  const [rows] = await pool.query('SELECT * FROM groups_ WHERE invite_code = ? LIMIT 1', [normalizedCode]);

  if (!rows.length) {
    throw new Error('Invalid invite code or group not found');
  }

  return mapGroupItem(rows[0]);
}

async function joinGroupByInviteCode(userId, inviteCode) {
  // Normalize inviteCode to lowercase to match storage (generated via crypto.randomBytes)
  const normalizedCode = String(inviteCode).trim().toLowerCase();

  const [rows] = await pool.query('SELECT * FROM groups_ WHERE invite_code = ? LIMIT 1', [normalizedCode]);

  if (!rows.length) {
    throw new Error('Invalid invite code or group not found');
  }

  const group = rows[0];
  const groupId = group.group_id;
  const userKey = String(userId);
  const needsApproval = !!group.is_approval_required;

  const [memberRows] = await pool.query('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupId, userKey]);

  if (memberRows.length > 0) {
    throw new Error('User is already a member of this group');
  }

  if (needsApproval) {
    const reqRes = await requestToJoin(groupId, userId);
    return { ...reqRes, group: mapGroupItem(group), groupId, status: 'PENDING' };
  }

  await addMemberToGroup(groupId, userKey, 'MEMBER');

  await pool.query('UPDATE groups_ SET member_count = member_count + ? WHERE group_id = ?', [1, groupId]);

  const [uRows] = await pool.query('SELECT * FROM users WHERE user_id = ? LIMIT 1', [userKey]);
  const u = uRows[0] || {};
  const newMemberObj = {
    userId: userKey,
    displayName: u.display_name || u.username || userKey,
    username: u.username || u.display_name || userKey,
    avatarUrl: u.avatar_url || null,
    role: 'MEMBER',
    joinedAt: new Date().toISOString()
  };

  forceJoinGroup(userKey, groupId);
  const io = getActiveIO();
  if (io) {
    io.to(groupId).emit('group:members_added', {
      groupId,
      newMembers: [newMemberObj],
      addedBy: userKey
    });
  }

  return { groupId, group: mapGroupItem(group), userId: userKey, role: 'MEMBER', status: 'JOINED' };
}

async function updateGroupSettings(groupId, requestUserId, settings) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);

  const [reqRows] = await pool.query('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, reqUserKey]);
  const reqMember = reqRows[0];

  if (!reqMember || (reqMember.role !== 'OWNER' && reqMember.role !== 'owner')) {
    const err = new Error('403 Forbidden: Only OWNER can update settings');
    err.status = 403;
    throw err;
  }

  const setClauses = [];
  const values = [];
  let changed = false;

  if (settings.isApprovalRequired !== undefined) {
    setClauses.push('is_approval_required = ?');
    values.push(Boolean(settings.isApprovalRequired) ? 1 : 0);
    changed = true;
  }

  if (settings.name !== undefined) {
    const name = String(settings.name).trim();
    if (!name) {
      const err = new Error('400 Bad Request: Group name is required');
      err.status = 400;
      throw err;
    }
    setClauses.push('name = ?');
    values.push(name);
    changed = true;
  }

  if (settings.description !== undefined) {
    setClauses.push('description = ?');
    values.push(String(settings.description || ''));
    changed = true;
  }

  const nextAvatarUrl = settings.avatarUrl !== undefined ? settings.avatarUrl : settings.avatar_url;
  if (nextAvatarUrl !== undefined) {
    setClauses.push('avatar_url = ?');
    values.push(nextAvatarUrl || null);
    changed = true;
  }

  if (settings.allowSendLinks !== undefined) {
    setClauses.push('allow_send_links = ?');
    values.push(String(settings.allowSendLinks));
    changed = true;
  }

  if (settings.spamFilterLevel !== undefined) {
    setClauses.push('spam_filter_level = ?');
    values.push(Number(settings.spamFilterLevel));
    changed = true;
  }

  if (changed) {
    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(groupKey);

    await pool.query(`UPDATE groups_ SET ${setClauses.join(', ')} WHERE group_id = ?`, values);

    const io = getActiveIO();
    if (io) {
      io.to(groupKey).emit('SERVER:GROUP_SETTINGS_UPDATED', {
        groupId: groupKey,
        settings: {
          name: settings.name !== undefined ? String(settings.name).trim() : undefined,
          description: settings.description !== undefined ? String(settings.description || '') : undefined,
          avatarUrl: nextAvatarUrl !== undefined ? nextAvatarUrl || null : undefined,
          isApprovalRequired: settings.isApprovalRequired,
          allowSendLinks: settings.allowSendLinks,
          spamFilterLevel: settings.spamFilterLevel
        }
      });
    }
  }

  return { message: 'Settings updated successfully' };
}

async function debugGetMembers(userId) {
  const userKey = String(userId);
  const [rows] = await pool.query('SELECT group_id, user_id, role, joined_at FROM group_members WHERE user_id = ?', [userKey]);
  return rows.map(r => ({ groupId: r.group_id, userId: r.user_id, role: r.role, joined_at: r.joined_at }));
}

async function disbandGroup(groupId, requestUserId) {
  const groupKey = String(groupId);
  const userKey = String(requestUserId);

  const [members] = await pool.query('SELECT user_id, role FROM group_members WHERE group_id = ?', [groupKey]);

  const requester = members.find(m => m.user_id === userKey);

  if (!requester || (requester.role !== 'owner' && requester.role !== 'OWNER')) {
    const error = new Error('403 Forbidden: You are not the OWNER of this group');
    error.status = 403;
    throw error;
  }

  // delete members
  await pool.query('DELETE FROM group_members WHERE group_id = ?', [groupKey]);

  // Xoá nhóm
  await pool.query('DELETE FROM groups_ WHERE group_id = ?', [groupKey]);

  const io = getActiveIO();
  if (io) {
    io.to(groupKey).emit('SERVER:GROUP_DISBANDED', {
      groupId: groupKey
    });
  }

  for (const m of members) {
    forceLeaveGroup(m.user_id, groupKey);
  }

  return { message: 'Group disbanded successfully' };
}

async function requestToJoin(groupId, userId) {
  const groupKey = String(groupId);
  const userKey = String(userId);
  const now = new Date().toISOString();

  // Kiểm tra đã là thành viên chưa
  const [memberRows] = await pool.query('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, userKey]);
  if (memberRows.length > 0) {
    const error = new Error('400 Bad Request: You are already a member');
    error.status = 400;
    throw error;
  }

  await pool.query(
    `INSERT INTO group_requests (group_id, user_id, status, created_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), created_at = VALUES(created_at)`,
    [groupKey, userKey, 'PENDING', now]
  );

  const io = getActiveIO();
  if (io) {
    io.to(groupKey).emit('SERVER:NEW_JOIN_REQUEST', {
      groupId: groupKey,
      userId: userKey
    });
  }

  return { message: 'Request sent successfully' };
}

async function getPendingRequests(groupId) {
  const groupKey = String(groupId);

  const [pendingReqs] = await pool.query(
    "SELECT * FROM group_requests WHERE group_id = ? AND status = 'PENDING'",
    [groupKey]
  );

  if (!pendingReqs.length) return [];

  const profiles = await Promise.all(
    pendingReqs.map(async (req) => {
      const [uRows] = await pool.query('SELECT * FROM users WHERE user_id = ? LIMIT 1', [req.user_id]);
      const u = uRows[0] || {};
      return {
        userId: req.user_id,
        status: req.status,
        createdAt: req.created_at,
        displayName: u.display_name || u.username || req.user_id,
        avatarUrl: u.avatar_url || null,
      };
    })
  );

  return profiles;
}

async function handleJoinRequest(groupId, requestUserId, targetUserId, action) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);
  const targetKey = String(targetUserId);

  const [reqRows] = await pool.query('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, reqUserKey]);
  const reqMember = reqRows[0];

  if (!reqMember || (reqMember.role !== 'OWNER' && reqMember.role !== 'DEPUTY' && reqMember.role !== 'owner' && reqMember.role !== 'deputy')) {
    const error = new Error('403 Forbidden: Only OWNER or DEPUTY can handle requests');
    error.status = 403;
    throw error;
  }

  const [joinReqRows] = await pool.query('SELECT * FROM group_requests WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, targetKey]);

  if (!joinReqRows.length) {
    const error = new Error('404 Not Found: Request not found');
    error.status = 404;
    throw error;
  }

  if (action === 'APPROVE') {
    await pool.query('DELETE FROM group_requests WHERE group_id = ? AND user_id = ?', [groupKey, targetKey]);

    await addMemberToGroup(groupKey, targetKey, 'MEMBER');

    const [uRows] = await pool.query('SELECT * FROM users WHERE user_id = ? LIMIT 1', [targetKey]);
    const u = uRows[0] || {};
    const newMemberObj = {
      userId: targetKey,
      displayName: u.display_name || u.username || targetKey,
      username: u.username || u.display_name || targetKey,
      avatarUrl: u.avatar_url || null,
      role: 'MEMBER',
      joinedAt: new Date().toISOString()
    };

    await pool.query('UPDATE groups_ SET member_count = member_count + ? WHERE group_id = ?', [1, groupKey]);

    forceJoinGroup(targetKey, groupKey);
    const io = getActiveIO();
    if (io) {
      io.to(groupKey).emit('group:members_added', {
        groupId: groupKey,
        newMembers: [newMemberObj],
        addedBy: reqUserKey
      });
      // also emit to targetUser privately so their UI updates
      io.to(targetKey).emit('SERVER:JOIN_REQUEST_APPROVED', { groupId: groupKey });
    }
    return { message: 'Request approved' };
  } else if (action === 'REJECT') {
    await pool.query('DELETE FROM group_requests WHERE group_id = ? AND user_id = ?', [groupKey, targetKey]);
    return { message: 'Request rejected' };
  } else {
    const error = new Error('400 Bad Request: Invalid action');
    error.status = 400;
    throw error;
  }
}

async function pinMessage(groupId, message, requestUserId) {
  const groupKey = String(groupId);
  const [rows] = await pool.query('SELECT pinned_messages FROM groups_ WHERE group_id = ? LIMIT 1', [groupKey]);
  const g = rows[0];
  if (!g) throw new Error('Group not found');

  // Kiểm tra quyền (OWNER/DEPUTY)
  const [memberRows] = await pool.query('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, String(requestUserId)]);
  const member = memberRows[0];
  if (!member || (member.role !== 'OWNER' && member.role !== 'owner' && member.role !== 'DEPUTY' && member.role !== 'deputy')) {
    throw new Error('Only OWNER or DEPUTY can pin messages');
  }

  let pinned = Array.isArray(g.pinned_messages) ? g.pinned_messages : [];
  pinned = pinned.filter(m => String(m.id) !== String(message.id));

  const pinObj = {
    ...message,
    pinnedBy: String(requestUserId),
    pinnedAt: new Date().toISOString()
  };
  pinned.unshift(pinObj);

  await pool.query('UPDATE groups_ SET pinned_messages = ? WHERE group_id = ?', [JSON.stringify(pinned), groupKey]);

  return pinned;
}

async function unpinMessage(groupId, messageId, requestUserId) {
  const groupKey = String(groupId);
  const [rows] = await pool.query('SELECT pinned_messages FROM groups_ WHERE group_id = ? LIMIT 1', [groupKey]);
  const g = rows[0];
  if (!g) throw new Error('Group not found');

  // Kiểm tra quyền
  const [memberRows] = await pool.query('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupKey, String(requestUserId)]);
  const member = memberRows[0];
  if (!member || (member.role !== 'OWNER' && member.role !== 'owner' && member.role !== 'DEPUTY' && member.role !== 'deputy')) {
    throw new Error('Only OWNER or DEPUTY can unpin messages');
  }

  let pinned = Array.isArray(g.pinned_messages) ? g.pinned_messages : [];

  // Kiểm tra quyền:
  // 1. Nếu là OWNER/DEPUTY thì được gỡ mọi ghim
  // 2. Nếu là MEMBER thì chỉ được gỡ ghim do chính mình tạo
  const pinToUnpin = pinned.find(m => String(m.id) === String(messageId));

  const isPinner = pinToUnpin && String(pinToUnpin.pinnedBy) === String(requestUserId);
  const isHighRole = member && (member.role === 'OWNER' || member.role === 'owner' || member.role === 'DEPUTY' || member.role === 'deputy');

  if (pinToUnpin && pinToUnpin.pinnedBy && !isPinner && !isHighRole) {
    throw new Error('Bạn không có quyền gỡ tin nhắn này');
  }

  pinned = pinned.filter(m => String(m.id) !== String(messageId));

  await pool.query('UPDATE groups_ SET pinned_messages = ? WHERE group_id = ?', [JSON.stringify(pinned), groupKey]);

  return pinned;
}

module.exports = {
  createGroup,
  listGroups,
  getGroupById,
  addMemberToGroup,
  addMembersToGroup,
  kickMember,
  updateRole,
  leaveGroup,
  checkUserInGroup,
  getGroupMembers,
  getGroupsForUser,
  getInviteLink,
  getGroupByInviteCode,
  joinGroupByInviteCode,
  debugGetMembers,
  disbandGroup,
  requestToJoin,
  getPendingRequests,
  handleJoinRequest,
  updateGroupSettings,
  pinMessage,
  unpinMessage,
};
