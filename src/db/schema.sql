-- MySQL schema replacing the previous DynamoDB tables.
-- Timestamps are stored as VARCHAR ISO-8601 strings (not DATETIME) because the
-- application already generates them with `new Date().toISOString()` and
-- passes them through as plain strings everywhere (API responses, sort keys).
-- Array/blob fields that DynamoDB stored as whole-item attributes (pinnedMessages,
-- likes, participants, the per-conversation messages array, ...) are kept as
-- JSON columns and read-modify-written the same way the service code already did.

CREATE TABLE IF NOT EXISTS users (
  user_id VARCHAR(64) NOT NULL PRIMARY KEY,
  id BIGINT NULL,
  username VARCHAR(100) NULL,
  password_hash VARCHAR(255) NULL,
  email VARCHAR(255) NULL,
  phone_number VARCHAR(32) NULL,
  display_name VARCHAR(100) NULL,
  avatar_url TEXT NULL,
  cover_image TEXT NULL,
  email_verified TINYINT(1) NOT NULL DEFAULT 0,
  phone_verified TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'offline',
  fcm_tokens JSON NULL,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,
  INDEX idx_users_id (id),
  INDEX idx_users_username (username),
  INDEX idx_users_email (email),
  INDEX idx_users_phone (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS friendships (
  friendship_id VARCHAR(64) NOT NULL PRIMARY KEY,
  sender_id VARCHAR(64) NOT NULL,
  receiver_id VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  nickname_sender VARCHAR(100) NULL,
  nickname_receiver VARCHAR(100) NULL,
  chat_bg_url_sender TEXT NULL,
  chat_bg_url_receiver TEXT NULL,
  pinned_messages JSON NULL,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,
  INDEX idx_friendships_sender (sender_id),
  INDEX idx_friendships_receiver (receiver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS groups_ (
  group_id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NULL,
  description TEXT NULL,
  avatar_url TEXT NULL,
  type VARCHAR(32) NULL,
  member_count INT NOT NULL DEFAULT 0,
  created_by VARCHAR(64) NULL,
  invite_code VARCHAR(32) NULL,
  is_approval_required TINYINT(1) NOT NULL DEFAULT 0,
  allow_send_links VARCHAR(16) NOT NULL DEFAULT 'ALL',
  spam_filter_level INT NOT NULL DEFAULT 1,
  pinned_messages JSON NULL,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,
  INDEX idx_groups_invite_code (invite_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS group_members (
  group_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'MEMBER',
  joined_at VARCHAR(32) NULL,
  PRIMARY KEY (group_id, user_id),
  INDEX idx_group_members_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS group_requests (
  group_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  created_at VARCHAR(32) NULL,
  PRIMARY KEY (group_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS channels (
  channel_id VARCHAR(64) NOT NULL PRIMARY KEY,
  group_id VARCHAR(64) NULL,
  name VARCHAR(255) NULL,
  type VARCHAR(32) NULL,
  last_message_id VARCHAR(64) NULL,
  created_at VARCHAR(32) NULL,
  INDEX idx_channels_group (group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
  conversation_id VARCHAR(191) NOT NULL PRIMARY KEY,
  messages JSON NOT NULL,
  updated_at VARCHAR(32) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- PK deliberately includes user_id (unlike the old DynamoDB (conversationId,messageId)
-- key) so a second reader's receipt no longer overwrites the first reader's row.
CREATE TABLE IF NOT EXISTS read_receipts (
  conversation_id VARCHAR(191) NOT NULL,
  message_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  read_at VARCHAR(32) NULL,
  PRIMARY KEY (conversation_id, message_id, user_id),
  INDEX idx_read_receipts_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS call_sessions (
  call_id VARCHAR(64) NOT NULL PRIMARY KEY,
  conversation_id VARCHAR(191) NULL,
  call_type VARCHAR(16) NULL,
  call_mode VARCHAR(16) NULL,
  initiator_id VARCHAR(64) NULL,
  caller_id VARCHAR(64) NULL,
  provider VARCHAR(32) NULL,
  channel_name VARCHAR(191) NULL,
  participants JSON NULL,
  status VARCHAR(32) NULL,
  ended_reason VARCHAR(64) NULL,
  ended_by VARCHAR(64) NULL,
  started_at VARCHAR(32) NULL,
  ended_at VARCHAR(32) NULL,
  duration_seconds INT NOT NULL DEFAULT 0,
  call_log_created TINYINT(1) NOT NULL DEFAULT 0,
  active_call_message_created TINYINT(1) NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,
  INDEX idx_call_sessions_conversation (conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reminders (
  reminder_id VARCHAR(64) NOT NULL PRIMARY KEY,
  conversation_id VARCHAR(191) NULL,
  creator_id VARCHAR(64) NULL,
  content TEXT NULL,
  remind_at VARCHAR(32) NULL,
  repeat_rule VARCHAR(32) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,
  last_triggered_at VARCHAR(32) NULL,
  message_id VARCHAR(64) NULL,
  INDEX idx_reminders_status (status),
  INDEX idx_reminders_remind_at (remind_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS posts (
  post_id VARCHAR(64) NOT NULL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  author_name VARCHAR(100) NULL,
  author_avatar TEXT NULL,
  content TEXT NULL,
  media JSON NULL,
  likes JSON NULL,
  like_count INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,
  INDEX idx_posts_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS comments (
  comment_id VARCHAR(64) NOT NULL PRIMARY KEY,
  post_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  author_name VARCHAR(100) NULL,
  author_avatar TEXT NULL,
  content TEXT NULL,
  parent_comment_id VARCHAR(64) NULL,
  root_comment_id VARCHAR(64) NULL,
  likes JSON NULL,
  like_count INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NULL,
  INDEX idx_comments_post (post_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stories (
  story_id VARCHAR(64) NOT NULL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  author_name VARCHAR(100) NULL,
  author_avatar TEXT NULL,
  type VARCHAR(16) NULL,
  text TEXT NULL,
  media_url TEXT NULL,
  background_color VARCHAR(32) NULL,
  text_x FLOAT NULL,
  text_y FLOAT NULL,
  text_scale FLOAT NULL,
  text_rotation FLOAT NULL,
  is_highlighted TINYINT(1) NOT NULL DEFAULT 0,
  highlighted_at VARCHAR(32) NULL,
  likes JSON NULL,
  created_at VARCHAR(32) NULL,
  expires_at VARCHAR(32) NULL,
  INDEX idx_stories_user (user_id),
  INDEX idx_stories_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
