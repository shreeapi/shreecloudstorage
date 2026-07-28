<div align="center">

# ☁️ ShreeCloudStorage

### Unlimited Cloud Storage powered by your own Telegram Account

Upload • Stream • Share • Store

<p align="center">

<img src="https://img.shields.io/github/stars/shreeapi/telecloud-storage?style=for-the-badge">

<img src="https://img.shields.io/github/license/shreeapi/telecloud-storage?style=for-the-badge">

<img src="https://img.shields.io/badge/Telegram-MTProto-2CA5E0?style=for-the-badge&logo=telegram">

<img src="https://img.shields.io/badge/Node.js-Express-green?style=for-the-badge&logo=node.js">

<img src="https://img.shields.io/badge/React-Vite-61DAFB?style=for-the-badge&logo=react">

</p>

Store your files directly inside **Telegram Saved Messages** and access them from anywhere.

**No storage limits. No monthly subscriptions. No hidden fees.**

---

### 🌐 Website

https://your-domain.com

### 📖 Documentation

https://your-domain.com/docs

### 💬 Telegram

https://t.me/shreeapi

https://t.me/nepalimomoswala

</div>

---

# Overview

ShreeCloudStorage transforms your personal Telegram account into a free cloud storage platform.

Instead of saving files on our servers, every uploaded file is stored directly inside **your own Telegram Saved Messages** using Telegram's official MTProto protocol.

This allows:

- Unlimited storage*
- Large file uploads
- Video streaming
- Audio streaming
- Public sharing
- Private storage

without maintaining expensive storage servers.

> Files belong to you—not us.

---

# Why ShreeCloudStorage?

✅ Unlimited Storage

No storage subscriptions.

No monthly pricing.

Your Telegram account becomes your cloud drive.

---

✅ Your Data

Files remain inside **your own Telegram account**.

We never permanently store uploaded files.

---

✅ Stream Everything

Supports

- MP4
- MKV
- AVI
- MOV
- WEBM
- MP3
- FLAC

with instant seeking.

---

✅ Fast Uploads

- Drag & Drop
- Multiple Files
- Folder Upload
- Resume
- Live Speed
- ETA
- Background Upload

---

✅ Developer Friendly

Generate your own API Key.

Integrate with:

- Websites
- Mobile Apps
- Bots
- Scripts
- Desktop Apps

---

# Architecture

```
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

# Tech Stack

## Frontend

- React
- Vite
- CSS Variables
- React Router

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
- Metadata
- Folders
- Share Links

Files are **never stored** permanently on the server.

---

## Security

- Helmet
- Rate Limiting
- Session Encryption
- Secure Cookies
- HTTP Security Headers

---

# Quick Start

## Backend

```bash
cd backend

cp .env.example .env

npm install

npm start
```

---

## Frontend

```bash
cd frontend

npm install

npm run dev
```

---

Backend

```
http://localhost:4000
```

Frontend

```
http://localhost:5173
```

---

# Environment

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

# Login Flow

```
Phone Number

↓

Telegram OTP

↓

2FA Password

↓

Encrypted Session

↓

Dashboard
```

No bots.

No Telegram Login Widget.

Uses real Telegram authentication.

---

# QR Login

Prefer QR?

Open Telegram

Settings

↓

Devices

↓

Link Desktop Device

↓

Scan QR

↓

Done

Exactly like Telegram Desktop.

---

# Folder Support

- Create folders
- Upload inside folders
- Folder navigation
- Folder upload
- Automatic hierarchy

---

# Rename Files

Renaming updates

✔ Local Database

✔ Telegram Message Caption

Everything stays synchronized.

---

# Upload Manager

Supports

- Multiple Uploads
- Queue
- Live Progress
- Upload Speed
- ETA
- Cancel Upload
- Background Upload
- Floating Upload Window

Navigate anywhere while uploads continue.

---

# Streaming

Supports HTTP Range Requests.

Perfect for

- Movies
- TV Shows
- Music
- Podcasts

Instant seek.

No full download required.

---

# Sharing

Private Files

Public Links

Password Links

Revoke Anytime

Random Tokens

```
/public/<token>
```

---

# Admin Panel

```
/admin
```

Includes

- Users
- Storage Usage
- File Count
- Last Active
- Monitoring

Admin **cannot view Telegram sessions**.

---

# Developer API

Generate your own API key.

```
POST   /api/v1/upload

GET    /api/v1/files

GET    /api/v1/files/:id

GET    /api/v1/files/:id/stream

DELETE /api/v1/files/:id
```

Authentication

```
X-API-Key

or

Authorization: Bearer
```

---

# Security

The encrypted Telegram session is equivalent to a logged-in Telegram account.

Always:

- Protect SESSION_ENCRYPT_KEY
- Never commit .env
- Enable HTTPS
- Backup your secrets
- Add FLOOD_WAIT retries

---

# Important

Files larger than **20MB** are temporarily written to a short-lived file during upload because of Telegram library limitations.

The temporary file is automatically deleted after upload.

No permanent copy is kept.

---

# Roadmap

- Desktop App
- Android App
- iOS App
- WebDAV
- S3 API
- PostgreSQL
- Redis
- Worker Queue
- CDN
- AI Search
- OCR
- File Versioning

---

# Contributing

Pull Requests are welcome.

Feel free to open Issues or submit improvements.

---

# Credits

### Powered by ShreeAPI

### Designed by AnshAPI

GitHub

https://github.com/shreeapi/telecloud-storage

Telegram

https://t.me/shreeapi

https://t.me/nepalimomoswala

---

<div align="center">

## ⭐ Star this repository if you found it useful!

Made with ❤️ by **AnshAPI**

</div>
