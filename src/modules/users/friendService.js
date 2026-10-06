const { pool } = require('../../config/mysqlConfig');

/* ─── row <-> app object mapping ─────────────────────────────────────────── */

function mapFriendshipRow(row) {
  if (!row) return null;
  return {
    friendshipId: row.friendship_id,
    sender_id: row.sender_id,
    receiver_id: row.receiver_id,
    status: row.status,
    nickname_sender: row.nickname_sender,
    nickname_receiver: row.nickname_receiver,
    chatBgUrl_sender: row.chat_bg_url_sender,
    chatBgUrl_receiver: row.chat_bg_url_receiver,
    pinnedMessages: row.pinned_messages || [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* ─── helpers ─────────────────────────────────────────────────────────────── */

async function findExistingRecord(senderId, receiverId) {
  const uid = String(senderId);
  const rid = String(receiverId);

  const [rows] = await pool.query(
    `SELECT * FROM friendships
     WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
     LIMIT 1`,
    [uid, rid, rid, uid]
  );

  return rows[0] ? mapFriendshipRow(rows[0]) : null;
}

async function putOrUpdateFriendship(item) {
  await pool.query(
    `INSERT INTO friendships (friendship_id, sender_id, receiver_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE sender_id = VALUES(sender_id), receiver_id = VALUES(receiver_id),
       status = VALUES(status), updated_at = VALUES(updated_at)`,
    [item.friendshipId, item.sender_id, item.receiver_id, item.status, item.created_at, item.updated_at]
  );
}

async function updateFriendshipStatus(friendshipId, userId, status) {
  await pool.query('UPDATE friendships SET status = ?, updated_at = ? WHERE friendship_id = ?', [
    status,
    new Date().toISOString(),
    String(friendshipId),
  ]);
}

async function getFriendshipByFriendshipId(friendshipId) {
  const [rows] = await pool.query('SELECT * FROM friendships WHERE friendship_id = ?', [String(friendshipId)]);
  return rows[0] ? mapFriendshipRow(rows[0]) : null;
}

/* ─── public functions ─────────────────────────────────────────────────────── */

async function sendFriendRequest(senderId, receiverId) {
  const sender = String(senderId);
  const receiver = String(receiverId);

  if (sender === receiver) {
    const err = new Error('Không thể gửi lời mời kết bạn cho chính mình');
    err.statusCode = 400;
    throw err;
  }

  // Kiểm tra bản ghi đã tồn tại (theo cả 2 chiều)
  const existing = await findExistingRecord(sender, receiver);

  if (existing) {
    if (existing.status === 'accepted') {
      const err = new Error('Hai tài khoản đã là bạn bè');
      err.statusCode = 409;
      throw err;
    }
    if (existing.status === 'pending') {
      const err = new Error('Lời mời kết bạn đã tồn tại');
      err.statusCode = 409;
      throw err;
    }
    if (existing.status === 'rejected') {
      // Cập nhật lại thành pending
      await updateFriendshipStatus(existing.friendshipId, sender, 'pending');
      return {
        id: existing.friendshipId,
        sender_id: sender,
        receiver_id: receiver,
        status: 'pending',
      };
    }
  }

  const friendshipId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  const item = {
    friendshipId,
    sender_id: sender,
    receiver_id: receiver,
    status: 'pending',
    created_at: now,
    updated_at: now,
  };

  await putOrUpdateFriendship(item);

  return {
    id: friendshipId,
    sender_id: sender,
    receiver_id: receiver,
    status: 'pending',
  };
}

async function acceptFriendRequest(friendshipId, userId) {
  const rec = await getFriendshipByFriendshipId(friendshipId);

  if (!rec) {
    const err = new Error('Không tìm thấy lời mời kết bạn hoặc bạn không có quyền thực hiện');
    err.statusCode = 404;
    throw err;
  }

  if (String(rec.receiver_id) !== String(userId)) {
    const err = new Error('Không tìm thấy lời mời kết bạn hoặc bạn không có quyền thực hiện');
    err.statusCode = 404;
    throw err;
  }

  if (rec.status !== 'pending') {
    const err = new Error(`Không thể chấp nhận lời mời có trạng thái: ${rec.status}`);
    err.statusCode = 400;
    throw err;
  }

  await updateFriendshipStatus(friendshipId, userId, 'accepted');

  return {
    id: friendshipId,
    sender_id: rec.sender_id,
    receiver_id: rec.receiver_id,
    status: 'accepted',
    sender_info: {
      id: rec.sender_id,
      display_name: '',
      username: '',
      avatar_url: null,
    },
  };
}

async function rejectFriendRequest(friendshipId, userId) {
  const rec = await getFriendshipByFriendshipId(friendshipId);

  if (!rec) {
    const err = new Error('Không tìm thấy lời mời kết bạn hoặc bạn không có quyền thực hiện');
    err.statusCode = 404;
    throw err;
  }

  if (String(rec.receiver_id) !== String(userId)) {
    const err = new Error('Không tìm thấy lời mời kết bạn hoặc bạn không có quyền thực hiện');
    err.statusCode = 404;
    throw err;
  }

  if (rec.status !== 'pending') {
    const err = new Error(`Không thể từ chối lời mời có trạng thái: ${rec.status}`);
    err.statusCode = 400;
    throw err;
  }

  await pool.query('DELETE FROM friendships WHERE friendship_id = ?', [String(friendshipId)]);

  return { id: friendshipId, status: 'rejected' };
}

async function getPendingRequests(userId) {
  const uid = String(userId);

  const [rows] = await pool.query(
    "SELECT * FROM friendships WHERE receiver_id = ? AND status = 'pending'",
    [uid]
  );

  const items = rows.map(mapFriendshipRow).sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const userService = require('./userService');
  const enriched = await Promise.all(
    items.map(async (item) => {
      const senderInfo = await userService.getUserById(item.sender_id);
      return {
        id: item.friendshipId,
        sender_id: item.sender_id,
        receiver_id: item.receiver_id,
        status: item.status,
        created_at: item.created_at,
        updated_at: item.updated_at,
        sender_display_name: senderInfo?.display_name || senderInfo?.displayName || '',
        sender_username: senderInfo?.username || '',
        sender_avatar_url: senderInfo?.avatar_url || senderInfo?.avatarUrl || null,
      };
    })
  );

  return enriched;
}

async function getFriends(userId) {
  const uid = String(userId);

  const [rows] = await pool.query(
    "SELECT * FROM friendships WHERE (sender_id = ? OR receiver_id = ?) AND status = 'accepted'",
    [uid, uid]
  );

  const items = rows.map(mapFriendshipRow).sort((a, b) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );

  const userService = require('./userService');
  const enriched = await Promise.all(
    items.map(async (item) => {
      const friendId = String(item.sender_id) === uid ? item.receiver_id : item.sender_id;
      const friendInfo = await userService.getUserById(friendId);
      // Nickname & Background: mỗi hướng lưu riêng
      const isSender = String(item.sender_id) === uid;
      const nickname = isSender ? (item.nickname_sender || null) : (item.nickname_receiver || null);
      const chatBgUrl = isSender ? (item.chatBgUrl_sender || null) : (item.chatBgUrl_receiver || null);
      const originalName = friendInfo?.display_name || friendInfo?.displayName || '';
      return {
        friendshipId: item.friendshipId,
        friend_id: friendId,
        status: item.status,
        updated_at: item.updated_at,
        friend_display_name: nickname || originalName,
        friend_original_name: originalName,
        friend_username: friendInfo?.username || '',
        friend_avatar_url: friendInfo?.avatar_url || friendInfo?.avatarUrl || null,
        nickname: nickname,
        chatBgUrl: chatBgUrl,
        pinnedMessages: item.pinnedMessages || [],
      };
    })
  );

  return enriched;
}

/**
 * Cập nhật nickname cho bạn bè (lưu theo hướng: ai đặt thì lưu cho người đó)
 */
async function updateNickname(friendshipId, userId, nickname) {
  const rec = await getFriendshipByFriendshipId(friendshipId);
  if (!rec) {
    const err = new Error('Không tìm thấy quan hệ bạn bè');
    err.statusCode = 404;
    throw err;
  }

  const uid = String(userId);
  const isSender = String(rec.sender_id) === uid;
  const column = isSender ? 'nickname_sender' : 'nickname_receiver';

  await pool.query(`UPDATE friendships SET ${column} = ?, updated_at = ? WHERE friendship_id = ?`, [
    nickname || null,
    new Date().toISOString(),
    String(friendshipId),
  ]);

  return { friendshipId, nickname: nickname || null };
}

/**
 * Lấy / cập nhật cài đặt chat (background) cho một conversation
 */
async function updateChatBackground(userId, friendshipId, bgUrl, bothSides = false) {
  const rec = await getFriendshipByFriendshipId(friendshipId);
  if (!rec) throw new Error('Không tìm thấy quan hệ bạn bè');

  const uid = String(userId);
  const isSender = String(rec.sender_id) === uid;
  const now = new Date().toISOString();

  if (bothSides) {
    await pool.query(
      'UPDATE friendships SET chat_bg_url_sender = ?, chat_bg_url_receiver = ?, updated_at = ? WHERE friendship_id = ?',
      [bgUrl || null, bgUrl || null, now, String(friendshipId)]
    );
  } else {
    const column = isSender ? 'chat_bg_url_sender' : 'chat_bg_url_receiver';
    await pool.query(`UPDATE friendships SET ${column} = ?, updated_at = ? WHERE friendship_id = ?`, [
      bgUrl || null,
      now,
      String(friendshipId),
    ]);
  }

  return { friendshipId, chatBgUrl: bgUrl || null };
}

async function getChatBackground(userId, friendshipId) {
  const rec = await getFriendshipByFriendshipId(friendshipId);
  if (!rec) return null;
  const isSender = String(rec.sender_id) === String(userId);
  return isSender ? (rec.chatBgUrl_sender || null) : (rec.chatBgUrl_receiver || null);
}

async function pinMessage(friendshipId, message, pinnedBy) {
  const rec = await getFriendshipByFriendshipId(friendshipId);
  if (!rec) throw new Error('Không tìm thấy quan hệ bạn bè');

  let pinned = Array.isArray(rec.pinnedMessages) ? rec.pinnedMessages : [];
  // Tránh trùng lặp
  pinned = pinned.filter(m => String(m.id) !== String(message.id));

  const pinObj = {
    ...message,
    pinnedBy: String(pinnedBy),
    pinnedAt: new Date().toISOString(),
  };
  pinned.unshift(pinObj); // Thêm vào đầu danh sách

  await pool.query('UPDATE friendships SET pinned_messages = ?, updated_at = ? WHERE friendship_id = ?', [
    JSON.stringify(pinned),
    new Date().toISOString(),
    String(friendshipId),
  ]);
  return pinned;
}

async function unpinMessage(friendshipId, messageId, requestUserId) {
  const rec = await getFriendshipByFriendshipId(friendshipId);
  if (!rec) throw new Error('Không tìm thấy quan hệ bạn bè');

  let pinned = Array.isArray(rec.pinnedMessages) ? rec.pinnedMessages : [];

  // Kiểm tra quyền: Chỉ người ghim mới được gỡ (hoặc tin nhắn cũ chưa có pinnedBy)
  const pinToUnpin = pinned.find(m => String(m.id) === String(messageId));
  if (pinToUnpin && pinToUnpin.pinnedBy && String(pinToUnpin.pinnedBy) !== String(requestUserId)) {
    throw new Error('Bạn chỉ có thể gỡ tin nhắn do chính mình ghim');
  }

  pinned = pinned.filter(m => String(m.id) !== String(messageId));

  await pool.query('UPDATE friendships SET pinned_messages = ?, updated_at = ? WHERE friendship_id = ?', [
    JSON.stringify(pinned),
    new Date().toISOString(),
    String(friendshipId),
  ]);
  return pinned;
}

/**
 * Hủy kết bạn - xóa friendship khỏi database
 */
async function unfriend(friendshipId, userId) {
  const rec = await getFriendshipByFriendshipId(friendshipId);

  if (!rec) {
    const err = new Error('Không tìm thấy quan hệ bạn bè');
    err.statusCode = 404;
    throw err;
  }

  const uid = String(userId);
  const isParticipant = String(rec.sender_id) === uid || String(rec.receiver_id) === uid;

  if (!isParticipant) {
    const err = new Error('Bạn không có quyền hủy kết bạn này');
    err.statusCode = 403;
    throw err;
  }

  if (rec.status !== 'accepted') {
    const err = new Error('Chỉ có thể hủy kết bạn khi đã là bạn bè');
    err.statusCode = 400;
    throw err;
  }

  await pool.query('DELETE FROM friendships WHERE friendship_id = ?', [String(friendshipId)]);

  return {
    friendshipId,
    status: 'unfriended',
    unfriended_by: uid,
  };
}

module.exports = {
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  getPendingRequests,
  getFriends,
  updateNickname,
  updateChatBackground,
  getChatBackground,
  pinMessage,
  unpinMessage,
  unfriend,
  findExistingRecord,
};
