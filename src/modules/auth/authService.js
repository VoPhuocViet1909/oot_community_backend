const { pool } = require('../../config/mysqlConfig');
const bcrypt = require('bcryptjs');

function normalizeUsername(input) {
  return String(input || '').trim().normalize('NFKC');
}

function normalizePhoneNumber(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  let digits = raw.replace(/\D/g, '');

  // +84xxxxxxxxx / 84xxxxxxxxx -> 0xxxxxxxxx
  if (digits.startsWith('84') && digits.length === 11) {
    digits = `0${digits.slice(2)}`;
  }

  // 9-digit local without leading 0 -> add 0
  if (digits.length === 9 && /^[3-9]/.test(digits)) {
    digits = `0${digits}`;
  }

  return digits;
}

function isValidPhoneNumber(phoneNumber) {
  return /^(0[3-9])[0-9]{8}$/.test(String(phoneNumber || ''));
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    id: row.id,
    username: row.username,
    password_hash: row.password_hash,
    email: row.email,
    phone_number: row.phone_number,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    email_verified: !!row.email_verified,
    phone_verified: !!row.phone_verified,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findUserByPhone(phoneNumber) {
  const normalizedInputPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedInputPhone) return null;

  const [rows] = await pool.query('SELECT * FROM users');
  const matched = rows.find((row) => normalizePhoneNumber(row.phone_number) === normalizedInputPhone);
  return matched ? mapUserRow(matched) : null;
}

async function findUserByUsername(username) {
  const normalizedInputUsername = normalizeUsername(username);
  if (!normalizedInputUsername) return null;

  const [rows] = await pool.query('SELECT * FROM users');
  const matched = rows.find((row) => normalizeUsername(row.username) === normalizedInputUsername);
  return matched ? mapUserRow(matched) : null;
}

async function findUsersByUsername(username) {
  const normalizedInputUsername = normalizeUsername(username);
  if (!normalizedInputUsername) return [];

  const [rows] = await pool.query('SELECT * FROM users');
  return rows
    .filter((row) => normalizeUsername(row.username) === normalizedInputUsername)
    .map(mapUserRow);
}

async function registerUser(payload) {
  const normalizedUsername = normalizeUsername(payload.username);

  if (!normalizedUsername) {
    throw new Error('Vui lòng nhập tên đăng nhập');
  }
  if (!payload.password || !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/.test(payload.password)) {
    throw new Error('Mật khẩu phải có ít nhất 6 ký tự, bao gồm chữ hoa, chữ thường và số');
  }

  const normalizedPhoneNumber = normalizePhoneNumber(payload.phone || payload.phoneNumber || payload.phone_number);
  if (!normalizedPhoneNumber) {
    throw new Error('Vui lòng nhập số điện thoại');
  }
  if (!isValidPhoneNumber(normalizedPhoneNumber)) {
    throw new Error('Số điện thoại không hợp lệ (phải bắt đầu bằng 0 và đủ 10 số)');
  }

  // KIỂM TRA DUY NHẤT: Giống Zalo, 1 SĐT chỉ 1 tài khoản
  const existingPhone = await findUserByPhone(normalizedPhoneNumber);
  if (existingPhone) {
    throw new Error('Số điện thoại này đã được đăng ký, vui lòng đăng nhập hoặc dùng số khác');
  }

  const existingUsername = await findUserByUsername(normalizedUsername);
  if (existingUsername) {
    throw new Error('Tên đăng nhập đã tồn tại');
  }

  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.email).trim())) {
    throw new Error('Email không hợp lệ');
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(payload.password, salt);

  const now = new Date().toISOString();
  const id = Date.now();
  const userId = String(id);

  const item = {
    userId,
    id,
    username: normalizedUsername,
    password_hash: passwordHash,
    email: payload.email ? String(payload.email).trim() : null,
    phone_number: normalizedPhoneNumber,
    display_name: payload.display_name || payload.displayName || normalizedUsername,
    avatar_url: null,
    email_verified: false,
    phone_verified: false,
    status: 'offline',
    created_at: now,
  };

  await pool.query(
    `INSERT INTO users
      (user_id, id, username, password_hash, email, phone_number, display_name, avatar_url, email_verified, phone_verified, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.userId,
      item.id,
      item.username,
      item.password_hash,
      item.email,
      item.phone_number,
      item.display_name,
      item.avatar_url,
      item.email_verified ? 1 : 0,
      item.phone_verified ? 1 : 0,
      item.status,
      item.created_at,
    ]
  );

  const { password_hash, ...userWithoutPassword } = item;
  return userWithoutPassword;
}

async function loginUser(payload) {
  const identifier = String(payload.username || '').trim();

  if (!identifier) {
    throw new Error('Vui lòng nhập tên đăng nhập hoặc số điện thoại');
  }
  if (!payload.password) {
    throw new Error('Vui lòng nhập mật khẩu');
  }

  let userToAuth = null;

  // Thử tìm theo số điện thoại trước nếu chuỗi chứa toàn số
  if (/^\d+$/.test(identifier) && identifier.length >= 8) {
    userToAuth = await findUserByPhone(identifier);
  }

  // Nếu không tìm thấy theo SĐT, thử tìm theo username
  if (!userToAuth) {
    const matchingUsers = await findUsersByUsername(identifier);
    if (matchingUsers.length > 0) {
      userToAuth = matchingUsers[0];
    }
  }

  if (!userToAuth) {
    throw new Error('Không tìm thấy tài khoản, vui lòng đăng ký trước');
  }

  const passwordMatch = await bcrypt.compare(payload.password, userToAuth.password_hash);
  if (!passwordMatch) {
    throw new Error('Tên đăng nhập hoặc mật khẩu không đúng');
  }

  const { password_hash, ...userWithoutPassword } = userToAuth;
  return userWithoutPassword;
}

module.exports = {
  registerUser,
  loginUser,
};
