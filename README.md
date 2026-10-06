# CNM_ott_community-backend

## Send file or image message

Upload the file to the backend via `POST /api/uploads/direct` (multipart, field `file`), which proxies it to Cloudinary and returns the public `url`. Then send that URL as a normal message payload.

### Socket.io

Emit `send-message` with this payload shape:

```json
{
  "conversationId": "channel:1",
  "senderId": 12,
  "contentType": "image",
  "content": "",
  "attachments": [
    {
      "url": "https://res.cloudinary.com/<cloud-name>/image/upload/v.../uploads/image-1.png",
      "key": "uploads/image-1",
      "name": "image-1.png",
      "mimeType": "image/png",
      "size": 245678
    }
  ]
}
```

### HTTP

You can also use:

- `POST /api/messages`
- `POST /api/messages/channel`
- `POST /api/messages/direct`

The body format is the same as the Socket payload. For channel/direct routes, you can pass `channelId` or `directChatId` instead of `conversationId`.

## Postman test flow

Use the `OTT File Attachments` folder in `api.json` in this order:

1. `POST /api/uploads/direct` (multipart file upload)
2. `POST send attached channel message`
3. `GET verify channel messages`

# OTT Community Backend

Backend phục vụ ứng dụng OTT Community, được xây dựng trên Node.js, Express và Socket.io. Hệ thống sử dụng kiến trúc mô-đun (Modular Architecture) để dễ dàng mở rộng và bảo trì.

## 🚀 Công nghệ sử dụng

- **Runtime**: Node.js
- **Framework**: Express.js
- **Real-time**: Socket.io (Hỗ trợ Chat, Presence)
- **Database**: 
  - **MySQL**: Lưu trữ Users, Messages, Groups, Channels, Friendships, Calls, Posts, Stories, Reminders (schema tại `src/db/schema.sql`, tự khởi tạo lúc boot).
  - **Redis**: Quản lý bộ nhớ hội thoại của bot AI và caching (có fallback in-memory khi không có Redis).
- **Storage**: Cloudinary (Lưu trữ Media/Files, free tier).
- **Auth**: JWT (AccessToken & RefreshToken).

## 📂 Cấu trúc dự án

Dự án được tổ chức theo mô hình mô-đun:

```text
├── /src
│   ├── /modules
│   │   ├── /auth          # Đăng ký, đăng nhập, JWT, Refresh Token
│   │   ├── /users         # Quản lý Profile, Danh bạ (Friends), Tìm kiếm
│   │   ├── /chat          # Tin nhắn, Nhóm (Groups), Kênh (Channels)
│   │   ├── /presence      # Trạng thái Online/Offline (Real-time)
│   │   └── /media         # Xử lý Upload Media qua Cloudinary (backend proxy)
│   ├── /common            # Middlewares & Utils dùng chung (JWT, Auth Check)
│   ├── /config            # Cấu hình MySQL, Cloudinary, Firebase, Redis
│   ├── /db                # schema.sql + initSchema.js (khởi tạo bảng MySQL lúc boot)
│   ├── /socket            # Logic xử lý WebSocket tập trung (socketHandler)
│   └── app.js             # Entry point của Server
├── /uploads               # Thư mục lưu trữ file tạm thời
├── .env                  # Biến môi trường
├── ecosystem.config.js    # Cấu hình PM2 (chạy trên VM 110)
└── docker-compose.yml     # Chạy MySQL & Redis nhanh chóng
```

## 🛠 Cài đặt & Chạy dự án

### 1. Cài đặt Dependencies
```bash
npm install
```

### 2. Cấu hình Biến môi trường
Tạo file `.env` từ các thông tin cần thiết:
- `PORT`: Cổng chạy server (mặc định 4000).
- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`: Cấu hình MySQL (mặc định khớp `docker-compose.yml`: 127.0.0.1:3306, root/root, ott_community_db).
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`: Cấu hình Cloudinary (thay cho S3).
- `JWT_SECRET`, `JWT_REFRESH_SECRET`: Khóa bảo mật JWT.
- `REDIS_HOST`, `REDIS_PORT`: (tùy chọn) Redis cho bộ nhớ hội thoại bot AI.
- `FIREBASE_SERVICE_ACCOUNT_BASE64` (hoặc `FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY`): Firebase Admin cho push notification (FCM).

### 3. Khởi chạy Infrastructure (Docker)
Để chạy MySQL và Redis nhanh chóng:
```bash
docker-compose up -d
```

### 4. Chạy Server
**Chế độ Development (với nodemon):**
```bash
npm run dev
```

**Chế độ Production:**
```bash
npm start
```

## 📡 API Endpoints (Sơ lược)

### Auth
- `POST /api/auth/register`: Đăng ký tài khoản.
- `POST /api/auth/login`: Đăng nhập.
- `POST /api/auth/refresh`: Làm mới token.

### Users & Friends
- `GET /api/users/me`: Lấy thông tin cá nhân.
- `GET /api/friends`: Lấy danh sách bạn bè.
- `POST /api/friends/request`: Gửi lời mời kết bạn.

### Chat & Media
- `GET /api/messages/conversations/:id`: Lấy lịch sử tin nhắn.
- `POST /api/uploads/direct`: Upload file ảnh/video/voice lên Cloudinary (multipart, field `file`).

## 🔌 Socket Events

Server sử dụng Socket.io để xử lý các sự kiện thời gian thực:
- `join_room`: Tham gia phòng chat.
- `send_message`: Gửi tin nhắn real-time.
- `typing_start` / `typing_stop`: Hiệu ứng đang soạn tin.
- `mark_read`: Đánh dấu tin nhắn đã đọc.
- `vote_poll`: Bình chọn trong chat.
- `start_live_location` / `update_live_location` / `stop_live_location`: Chia sẻ vị trí trực tiếp.

> **Note:** Video/voice call functionality (Agora-based) is planned for Phase 2.

---
© 2024 OTT Community Team




test CI/CD lần 1
