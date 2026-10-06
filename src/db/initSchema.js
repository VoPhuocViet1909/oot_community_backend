const fs = require('fs');
const path = require('path');
const { pool } = require('../config/mysqlConfig');

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await pool.query(statement);
  }

  // eslint-disable-next-line no-console
  console.log('[MySQL] Schema ready');
}

module.exports = { initSchema };
