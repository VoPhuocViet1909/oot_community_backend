const { pool } = require('../../config/mysqlConfig');

async function getChannelsByGroup(groupId) {
  const groupKey = String(groupId);

  const [rows] = await pool.query('SELECT * FROM channels WHERE group_id = ?', [groupKey]);

  const sorted = rows.slice().sort((a, b) => {
    const aTime = a.created_at || '';
    const bTime = b.created_at || '';
    return aTime.localeCompare(bTime);
  });

  return sorted.map((row) => ({
    id: row.channel_id,
    groupId: row.group_id,
    name: row.name,
    type: row.type,
    lastMessageId: row.last_message_id,
    createdAt: row.created_at
  }));
}

async function getChannelById(channelId) {
  const [rows] = await pool.query('SELECT * FROM channels WHERE channel_id = ? LIMIT 1', [String(channelId)]);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.channel_id,
    groupId: row.group_id,
    name: row.name,
    type: row.type,
    lastMessageId: row.last_message_id,
    createdAt: row.created_at
  };
}

module.exports = {
  getChannelsByGroup,
  getChannelById
};
