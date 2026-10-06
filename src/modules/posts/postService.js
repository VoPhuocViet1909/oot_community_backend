const { randomUUID } = require('crypto');
const { pool } = require('../../config/mysqlConfig');
const userService = require('../users/userService');

/* ─── row <-> app object mapping ─────────────────────────────────────────── */

function mapPostRow(row) {
  if (!row) return null;
  return {
    postId: row.post_id,
    userId: row.user_id,
    authorName: row.author_name,
    authorAvatar: row.author_avatar,
    content: row.content,
    media: Array.isArray(row.media) ? row.media : [],
    likes: Array.isArray(row.likes) ? row.likes : [],
    likeCount: row.like_count || 0,
    commentCount: row.comment_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCommentRow(row) {
  if (!row) return null;
  return {
    commentId: row.comment_id,
    postId: row.post_id,
    userId: row.user_id,
    authorName: row.author_name,
    authorAvatar: row.author_avatar,
    content: row.content,
    parentCommentId: row.parent_comment_id || null,
    rootCommentId: row.root_comment_id || row.comment_id,
    likes: Array.isArray(row.likes) ? row.likes : [],
    likeCount: row.like_count || 0,
    createdAt: row.created_at,
  };
}

async function enrichLikes(likes) {
  const ids = Array.isArray(likes) ? likes : [];
  return Promise.all(ids.map(async (userId) => {
    try {
      const user = await userService.getUserById(userId);
      return {
        userId: String(userId),
        displayName: user?.display_name || user?.username || 'Người dùng',
        avatarUrl: user?.avatar_url || null,
      };
    } catch {
      return { userId: String(userId), displayName: 'Người dùng', avatarUrl: null };
    }
  }));
}

async function enrichPost(post) {
  return {
    ...post,
    likes: Array.isArray(post.likes) ? post.likes : [],
    likeCount: Array.isArray(post.likes) ? post.likes.length : (post.likeCount || 0),
    likeUsers: await enrichLikes(post.likes),
  };
}

// ─── Posts ────────────────────────────────────────────────────────────────────

async function createPost(userId, { content, media }) {
  if (!userId) throw new Error('Thiếu userId');
  if (!content && (!media || media.length === 0)) {
    throw new Error('Bài viết cần có nội dung hoặc hình ảnh/video');
  }

  const postId = randomUUID();
  const now = new Date().toISOString();

  const user = await userService.getUserById(userId);
  if (!user) throw new Error('Không tìm thấy người dùng');

  const item = {
    postId,
    userId: String(userId),
    authorName: user.display_name || user.username || 'Unknown',
    authorAvatar: user.avatar_url || null,
    content: String(content || '').trim(),
    media: Array.isArray(media) ? media : [], // [{url, type: 'image'|'video', name?}]
    likes: [],       // array of userIds who liked
    likeCount: 0,
    commentCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await pool.query(
    `INSERT INTO posts
      (post_id, user_id, author_name, author_avatar, content, media, likes, like_count, comment_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.postId,
      item.userId,
      item.authorName,
      item.authorAvatar,
      item.content,
      JSON.stringify(item.media),
      JSON.stringify(item.likes),
      item.likeCount,
      item.commentCount,
      item.createdAt,
      item.updatedAt,
    ],
  );

  return item;
}

async function getPostById(postId) {
  if (!postId) return null;
  const [rows] = await pool.query('SELECT * FROM posts WHERE post_id = ? LIMIT 1', [String(postId)]);
  const post = mapPostRow(rows[0]);
  return post ? enrichPost(post) : null;
}

async function getFeedPosts(userId, { limit = 20, lastKey } = {}) {
  // Get the user's friend list
  const friendService = require('../users/friendService');
  let friendIds = [];
  try {
    const friends = await friendService.getFriends(userId);
    friendIds = (friends || []).map(f => String(f.friend_id || f.userId));
  } catch (e) {
    console.warn('[PostService] Could not load friends for feed:', e.message);
  }

  // Include the user's own posts
  const allowedUserIds = [String(userId), ...friendIds];

  // Friend-id list is known upfront, so query directly for those authors
  const [rows] = await pool.query(
    'SELECT * FROM posts WHERE user_id IN (?) ORDER BY created_at DESC LIMIT ?',
    [allowedUserIds, limit],
  );

  const feedPosts = rows.map(mapPostRow);

  return {
    posts: await Promise.all(feedPosts.map(enrichPost)),
    count: feedPosts.length,
  };
}

async function getUserPosts(userId, { limit = 20 } = {}) {
  const [rows] = await pool.query(
    'SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [String(userId), limit],
  );

  const posts = rows.map(mapPostRow);

  return { posts: await Promise.all(posts.map(enrichPost)), count: posts.length };
}

async function updatePost(postId, userId, { content } = {}) {
  const post = await getPostById(postId);
  if (!post) throw new Error('Bài viết không tồn tại');
  if (String(post.userId) !== String(userId)) {
    throw new Error('Bạn không có quyền chỉnh sửa bài viết này');
  }
  if (Date.now() - new Date(post.createdAt).getTime() >= 7 * 24 * 60 * 60 * 1000) {
    throw new Error('Bài viết quá 7 ngày không thể chỉnh sửa');
  }

  const nextContent = String(content || '').trim();
  if (!nextContent && (!post.media || post.media.length === 0)) {
    throw new Error('Bài viết cần có nội dung hoặc hình ảnh/video');
  }

  const updatedAt = new Date().toISOString();
  await pool.query(
    'UPDATE posts SET content = ?, updated_at = ? WHERE post_id = ?',
    [nextContent, updatedAt, String(postId)],
  );

  return getPostById(postId);
}

async function toggleLike(postId, userId) {
  const post = await getPostById(postId);
  if (!post) throw new Error('Bài viết không tồn tại');

  const likes = Array.isArray(post.likes) ? post.likes : [];
  const userIdStr = String(userId);
  const alreadyLiked = likes.includes(userIdStr);

  let newLikes;
  if (alreadyLiked) {
    newLikes = likes.filter(id => id !== userIdStr);
  } else {
    newLikes = [...likes, userIdStr];
  }

  await pool.query(
    'UPDATE posts SET likes = ?, like_count = ?, updated_at = ? WHERE post_id = ?',
    [JSON.stringify(newLikes), newLikes.length, new Date().toISOString(), String(postId)],
  );

  return {
    liked: !alreadyLiked,
    likeCount: newLikes.length,
    likes: newLikes,
    likeUsers: await enrichLikes(newLikes),
  };
}

async function deletePost(postId, userId) {
  const post = await getPostById(postId);
  if (!post) throw new Error('Bài viết không tồn tại');
  if (String(post.userId) !== String(userId)) {
    throw new Error('Bạn không có quyền xóa bài viết này');
  }

  await pool.query('DELETE FROM posts WHERE post_id = ?', [String(postId)]);

  return { deleted: true };
}

// ─── Comments ────────────────────────────────────────────────────────────────

async function createComment(postId, userId, { content, parentCommentId }) {
  if (!postId || !userId) throw new Error('Thiếu postId hoặc userId');
  if (!content || !content.trim()) throw new Error('Bình luận không được để trống');

  const post = await getPostById(postId);
  if (!post) throw new Error('Bài viết không tồn tại');

  const user = await userService.getUserById(userId);
  if (!user) throw new Error('Không tìm thấy người dùng');

  const commentId = randomUUID();
  const now = new Date().toISOString();
  let parentComment = null;

  if (parentCommentId) {
    const [parentRows] = await pool.query(
      'SELECT * FROM comments WHERE comment_id = ? LIMIT 1',
      [String(parentCommentId)],
    );
    parentComment = mapCommentRow(parentRows[0]);
    if (!parentComment || String(parentComment.postId) !== String(postId)) {
      throw new Error('Bình luận gốc không tồn tại');
    }
  }

  const comment = {
    commentId,
    postId: String(postId),
    userId: String(userId),
    authorName: user.display_name || user.username || 'Unknown',
    authorAvatar: user.avatar_url || null,
    content: String(content).trim(),
    parentCommentId: parentComment ? String(parentComment.commentId) : null,
    rootCommentId: parentComment ? String(parentComment.rootCommentId || parentComment.commentId) : commentId,
    likes: [],
    likeCount: 0,
    createdAt: now,
  };

  await pool.query(
    `INSERT INTO comments
      (comment_id, post_id, user_id, author_name, author_avatar, content, parent_comment_id, root_comment_id, likes, like_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      comment.commentId,
      comment.postId,
      comment.userId,
      comment.authorName,
      comment.authorAvatar,
      comment.content,
      comment.parentCommentId,
      comment.rootCommentId,
      JSON.stringify(comment.likes),
      comment.likeCount,
      comment.createdAt,
    ],
  );

  // Update post comment count
  await pool.query(
    'UPDATE posts SET comment_count = comment_count + 1, updated_at = ? WHERE post_id = ?',
    [now, String(postId)],
  );

  return comment;
}

async function getComments(postId, { limit = 50 } = {}) {
  const [rows] = await pool.query('SELECT * FROM comments WHERE post_id = ?', [String(postId)]);

  const comments = rows
    .map(mapCommentRow)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, limit);

  const enrichedComments = await Promise.all(comments.map(async (comment) => ({
    ...comment,
    parentCommentId: comment.parentCommentId || null,
    rootCommentId: comment.rootCommentId || comment.commentId,
    likes: Array.isArray(comment.likes) ? comment.likes : [],
    likeCount: Array.isArray(comment.likes) ? comment.likes.length : (comment.likeCount || 0),
    likeUsers: await enrichLikes(comment.likes),
  })));

  return { comments: enrichedComments, count: enrichedComments.length };
}

async function toggleCommentLike(commentId, userId) {
  const [rows] = await pool.query('SELECT * FROM comments WHERE comment_id = ? LIMIT 1', [String(commentId)]);
  const comment = mapCommentRow(rows[0]);
  if (!comment) throw new Error('Bình luận không tồn tại');

  const likes = Array.isArray(comment.likes) ? comment.likes : [];
  const userIdStr = String(userId);
  const alreadyLiked = likes.includes(userIdStr);
  const newLikes = alreadyLiked ? likes.filter(id => id !== userIdStr) : [...likes, userIdStr];

  await pool.query(
    'UPDATE comments SET likes = ?, like_count = ? WHERE comment_id = ?',
    [JSON.stringify(newLikes), newLikes.length, String(commentId)],
  );

  return {
    liked: !alreadyLiked,
    likeCount: newLikes.length,
    likes: newLikes,
    likeUsers: await enrichLikes(newLikes),
  };
}

async function updateComment(commentId, userId, content) {
  if (!content || !String(content).trim()) throw new Error('Bình luận không được để trống');

  const [rows] = await pool.query('SELECT * FROM comments WHERE comment_id = ? LIMIT 1', [String(commentId)]);
  const comment = mapCommentRow(rows[0]);
  if (!comment) throw new Error('Bình luận không tồn tại');
  if (String(comment.userId) !== String(userId)) {
    throw new Error('Bạn không có quyền chỉnh sửa bình luận này');
  }

  const updatedAt = new Date().toISOString();
  const nextContent = String(content).trim();
  await pool.query(
    'UPDATE comments SET content = ? WHERE comment_id = ?',
    [nextContent, String(commentId)],
  );

  return { ...comment, content: nextContent, updatedAt };
}

async function deleteComment(commentId, userId) {
  const [rows] = await pool.query('SELECT * FROM comments WHERE comment_id = ? LIMIT 1', [String(commentId)]);
  const comment = mapCommentRow(rows[0]);
  if (!comment) throw new Error('Bình luận không tồn tại');
  if (String(comment.userId) !== String(userId)) {
    throw new Error('Bạn không có quyền xóa bình luận này');
  }

  const [branchRows] = await pool.query('SELECT * FROM comments WHERE post_id = ?', [String(comment.postId)]);
  const allComments = branchRows.map(mapCommentRow);
  const deletedIds = new Set([String(commentId)]);
  let foundChild = true;
  while (foundChild) {
    foundChild = false;
    for (const item of allComments) {
      if (item.parentCommentId && deletedIds.has(String(item.parentCommentId)) && !deletedIds.has(String(item.commentId))) {
        deletedIds.add(String(item.commentId));
        foundChild = true;
      }
    }
  }

  await Promise.all([...deletedIds].map(id => pool.query('DELETE FROM comments WHERE comment_id = ?', [id])));

  // Decrease comment count on post
  try {
    await pool.query(
      'UPDATE posts SET comment_count = comment_count - ? WHERE post_id = ?',
      [deletedIds.size, String(comment.postId)],
    );
  } catch (e) {
    console.warn('Failed to decrease comment count:', e.message);
  }

  return { deleted: true, deletedCommentIds: [...deletedIds] };
}

module.exports = {
  createPost,
  getPostById,
  getFeedPosts,
  getUserPosts,
  updatePost,
  toggleLike,
  deletePost,
  createComment,
  getComments,
  updateComment,
  toggleCommentLike,
  deleteComment,
};
