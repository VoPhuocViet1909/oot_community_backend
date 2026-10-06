const { pool } = require('../../config/mysqlConfig');

async function countRows(sql) {
  const [rows] = await pool.query(sql);
  return rows[0]?.cnt || 0;
}

async function getOverviewStats() {
  const [users, groups, messages] = await Promise.all([
    countRows('SELECT COUNT(*) AS cnt FROM users'),
    countRows('SELECT COUNT(*) AS cnt FROM groups_'),
    countRows('SELECT COUNT(*) AS cnt FROM messages'),
  ]);

  return {
    totalUsers: users,
    totalGroups: groups,
    totalMessages: messages
  };
}

module.exports = { getOverviewStats };
