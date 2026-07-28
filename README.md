<div align="center">

# ☁️ ShreeCloudStorage

### Unlimited Cloud Storage Powered by Your Own Telegram Account

Upload • Stream • Share • Store

<p align="center">
  <a href="https://shreecloudstudio.vercel.app/">
    <img src="https://img.shields.io/badge/Live-Demo-blue?style=for-the-badge&logo=vercel">
  </a>
  <a href="https://github.com/shreeapi/telecloud-storage">
    <img src="https://img.shields.io/github/stars/shreeapi/telecloud-storage?style=for-the-badge">
  </a>
  <a href="https://github.com/shreeapi/telecloud-storage/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/shreeapi/telecloud-storage?style=for-the-badge">
  </a>
  <img src="https://img.shields.io/badge/Telegram-MTProto-2CA5E0?style=for-the-badge&logo=telegram">
  <img src="https://img.shields.io/badge/Node.js-Express-339933?style=for-the-badge&logo=node.js">
  <img src="https://img.shields.io/badge/React-Vite-61DAFB?style=for-the-badge&logo=react">
</p>

**Store your files directly inside Telegram Saved Messages.**

**Unlimited Storage • Video Streaming • Public Sharing • Modern Dashboard**

</div>

---

# 📚 Table of Contents

- [Overview](#-overview)
- [Why ShreeCloudStorage?](#-why-shreecloudstorage)
- [Features](#-features)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Quick Start](#-quick-start)
- [Environment Variables](#-environment-variables)
- [Login Flow](#-login-flow)
- [QR Login](#-qr-login)
- [Folder Management](#-folder-management)
- [Streaming](#-streaming)
- [Sharing](#-sharing)
- [Admin Panel](#-admin-panel)
- [Developer API](#-developer-api)
- [Security](#-security)
- [Roadmap](#-roadmap)
- [Links](#-links)
- [Credits](#-credits)

---

# ☁️ Overview

ShreeCloudStorage transforms your **Telegram Saved Messages** into your own personal cloud storage.

Instead of uploading files to expensive storage servers, every uploaded file is securely stored inside **your own Telegram account** using Telegram's official **MTProto protocol**.

Because of this, you get:

- 🚀 Unlimited Storage*
- 🎬 Video Streaming
- 🎵 Audio Streaming
- 📁 Folder Management
- 🔗 Public Sharing
- 🔒 Private Files
- ⚡ Fast Uploads

without paying monthly cloud storage fees.

> **Your files belong to your Telegram account—not our servers.**

---

# 🚀 Why ShreeCloudStorage?

### ☁️ Unlimited Storage

No storage subscriptions.

No monthly pricing.

No upgrade plans.

Your Telegram account becomes your cloud drive.

---

### 🔒 Your Data

Files stay inside your own Telegram account.

We never permanently store uploaded files.

---

### 🎬 Stream Everything

Supports

- MP4
- MKV
- AVI
- MOV
- WEBM
- MP3
- FLAC

with instant seeking using HTTP Range Requests.

---

### ⚡ Fast Uploads

- Drag & Drop
- Folder Upload
- Multiple Uploads
- Background Uploads
- Live Upload Speed
- ETA
- Upload Queue

---

### 👨‍💻 Developer Friendly

Every user can generate their own API Key.

Perfect for

- Websites
- Bots
- Mobile Apps
- Desktop Apps
- Scripts

---

# ✨ Features

- 📱 Telegram Login
- 🔐 MTProto Authentication
- 📂 Folder Support
- 📤 Drag & Drop Upload
- 📁 Folder Upload
- 🎬 Video Streaming
- 🎵 Audio Streaming
- 📷 Image Preview
- 📄 PDF Preview
- ❤️ Favorite Files
- 📌 Pin Files
- 🔍 Search Files
- 🗑 Trash & Restore
- 📊 Storage Statistics
- 🔗 Public Share Links
- 🔒 Private Links
- ⚡ Live Upload Progress
- 🌙 Dark Mode
- ☀️ Light Mode
- 📱 Mobile Responsive
- 💻 Modern Dashboard

---

# 🏗 Architecture

```text
            Browser

               │

               ▼

       React Frontend

               │

          REST API

               │

               ▼

      Express Backend

               │

            GramJS

               │

      Telegram MTProto

               │

      Saved Messages

               │

             Files
```

---

# ⚙ Tech Stack

## Frontend

- React
- Vite
- CSS Variables
- React Router
- Axios

---

## Backend

- Node.js
- Express
- GramJS
- MTProto

---

## Database

Lightweight JSON Database

Stores only

- Users
- File Metadata
- Folders
- Share Links

Actual files remain inside Telegram.

---

## Security

- Helmet
- Rate Limiting
- Secure Cookies
- Session Encryption
- HTTP Security Headers

---

# 🚀 Quick Start

## Clone Repository

```bash
git clone https://github.com/shreeapi/telecloud-storage.git

cd telecloud-storage
```

---

## Backend

```bash
cd backend

cp .env.example .env

npm install

npm start
```

Backend

```
http://localhost:4000
```

---

## Frontend

```bash
cd frontend

npm install

npm run dev
```

Frontend

```
http://localhost:5173
```

---

# 🔑 Environment Variables

```env
TG_API_ID=

TG_API_HASH=

SESSION_ENCRYPT_KEY=

JWT_SECRET=

PUBLIC_BASE_URL=

ADMIN_ID=

ADMIN_PASSWORD=
```

---

# 📱 Login Flow

```text
Phone Number

↓

Telegram sends OTP

↓

Enter OTP

↓

(Optional) 2FA Password

↓

Encrypted Telegram Session

↓

Dashboard
```

No bots.

No Telegram Login Widget.

Uses Telegram's official MTProto authentication.

---

# 📷 QR Login

Don't want to type a code?

Open Telegram

```
Settings

↓

Devices

↓

Link Desktop Device

↓

Scan QR

↓

Done
```

Works exactly like Telegram Desktop.

---

# 📂 Folder Management

- Create Folders
- Rename Folders
- Folder Upload
- Navigate Between Folders
- Automatic Folder Hierarchy

---

# ✏ Rename Files

Renaming updates

- Local Database
- Telegram Message Caption

Everything remains synchronized.

---

# ⬆ Upload Manager

Supports

- Multiple Uploads
- Queue
- Upload Progress
- Upload Speed
- ETA
- Background Uploads
- Cancel Upload
- Floating Upload Window

Continue browsing while uploads keep running.

---

# 🎬 Streaming

Supports HTTP Range Requests.

Perfect for

- Movies
- TV Shows
- Music
- Podcasts

Instant seeking without downloading the entire file.

---

# 🔗 Sharing

Generate

- Public Links
- Private Files

Share format

```
/public/<token>
```

Public links can be revoked anytime.

---

# 🛠 Admin Panel

```
/admin
```

Includes

- Users
- Storage Usage
- File Count
- Last Active
- Monitoring Dashboard

Telegram session strings are never displayed.

---

# 🔌 Developer API

Generate your own API Key.

### Upload

```http
POST /api/v1/upload
```

### List Files

```http
GET /api/v1/files
```

### File Details

```http
GET /api/v1/files/:id
```

### Stream File

```http
GET /api/v1/files/:id/stream
```

### Delete File

```http
DELETE /api/v1/files/:id
```

Authentication

```http
X-API-Key: tc_xxxxxxxxxxxxxx
```

or

```http
Authorization: Bearer tc_xxxxxxxxxxxxxx
```

---

# 🔒 Security

Every Telegram session is encrypted before storage.

Please remember:

- Never expose `SESSION_ENCRYPT_KEY`
- Never commit `.env`
- Always use HTTPS
- Protect your API credentials
- Implement FLOOD_WAIT retries for production
- Enable backups for your metadata database

---

# ⚠ Important Notice

Files larger than **20 MB** may be temporarily written to a short-lived file during upload because of Telegram library limitations.

The temporary file is automatically deleted immediately after upload completes.

No permanent copy is stored on the server.

---

# 🛣 Roadmap

- [ ] PostgreSQL Support
- [ ] Redis Cache
- [ ] Multi Device Login
- [ ] Desktop Client
- [ ] Android App
- [ ] iOS App
- [ ] WebDAV
- [ ] S3 Compatible API
- [ ] OCR Search
- [ ] AI Auto Tagging
- [ ] File Versioning
- [ ] Background Workers
- [ ] Upload Resume
- [ ] Faster Streaming

---

# 🤝 Contributing

Contributions are always welcome.

Feel free to:

- Open an Issue
- Submit a Pull Request
- Suggest New Features
- Report Bugs

---

# 🔗 Links

| Platform | Link |
|----------|------|
| 🌐 Website | **[ShreeCloudStorage](https://shreecloudstudio.vercel.app/)** |
| 💻 GitHub | **[telecloud-storage](https://github.com/shreeapi/telecloud-storage)** |
| 📢 Telegram Channel | **[@shreeapi](https://t.me/shreeapi)** |
| 👨‍💻 Developer | **[@nepalimomoswala](https://t.me/nepalimomoswala)** |

---

# ❤️ Credits

<div align="center">

## Powered by **ShreeAPI**

## Designed by **AnshAPI**

<br>

🌐 **Website**  
https://shreecloudstudio.vercel.app/

💻 **GitHub**  
https://github.com/shreeapi/telecloud-storage

📢 **Telegram**  
https://t.me/shreeapi

👨‍💻 **Developer**  
https://t.me/nepalimomoswala

---

### ⭐ If you like this project, please Star the repository!

Made with ❤️ by **AnshAPI**

</div>
