#!/usr/bin/env node
// Send a local screenshot to a Zoom Team Chat channel via an Incoming Webhook
// (signature-authenticated connection). Flow per Zoom KB0067640:
//   1. POST ?format=upload  -> uploadLink, uploadToken, userId
//   2. POST file to uploadLink (multipart) -> Zoom-File-ID response header
//   3. POST ?format=img with [{ text, img: [fileId] }]
//
// Usage:  node sendScreenshot.js <path-to-image> ["optional message"]
// Env:    ZOOM_WEBHOOK_URL, ZOOM_WEBHOOK_SECRET
//         ZOOM_SIGNATURE_ENCODING=base64|base64url  (default base64)

const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs/promises');
const path = require('node:path');

// integrations.zoom.us resolves to IPv6 first on some networks where IPv6 is
// unreachable, making fetch fail intermittently; prefer IPv4.
dns.setDefaultResultOrder('ipv4first');

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function getConfig() {
  loadEnv();
  const webhookUrl = process.env.ZOOM_WEBHOOK_URL;
  const secret = process.env.ZOOM_WEBHOOK_SECRET;
  const missing = [];
  if (!webhookUrl) missing.push('ZOOM_WEBHOOK_URL');
  if (!secret) missing.push('ZOOM_WEBHOOK_SECRET');
  if (missing.length) {
    throw new Error(`Missing required env var(s): ${missing.join(', ')} (set them in .env)`);
  }
  const encoding = (process.env.ZOOM_SIGNATURE_ENCODING || 'base64').toLowerCase();
  if (!['base64', 'base64url'].includes(encoding)) {
    throw new Error('ZOOM_SIGNATURE_ENCODING must be "base64" or "base64url"');
  }
  return { webhookUrl, secret, encoding };
}

// signature = base64(HMAC_SHA256("{format}&{timestamp}&{input message}", secret))
function sign(format, timestamp, body, secret, encoding) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${format}&${timestamp}&${body}`)
    .digest(encoding);
}

// Webhook URL with query params set, safe for logging (token path redacted).
function redactUrl(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/');
  const last = parts.pop();
  parts.push(last ? `${last.slice(0, 4)}…` : last);
  u.pathname = parts.join('/');
  return `${u.origin}${u.pathname}${u.search}`;
}

class ZoomWebhookError extends Error {
  constructor(step, status, body) {
    super(`${step} failed: HTTP ${status}${body ? ` - ${body}` : ''}`);
    this.name = 'ZoomWebhookError';
    this.step = step;
    this.status = status;
    this.body = body;
  }
}

async function callWebhook(config, format, body) {
  const timestamp = Date.now().toString();
  const url = new URL(config.webhookUrl);
  url.searchParams.set('format', format);
  url.searchParams.set('timestamp', timestamp);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: sign(format, timestamp, body, config.secret, config.encoding),
      'Content-Type': 'application/json',
    },
    body: body || undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ZoomWebhookError(`format=${format} (${redactUrl(url)})`, res.status, text);
  }
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return json;
}

// Zoom's casing for these fields isn't pinned down in the docs, so match loosely.
function pick(obj, ...names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const [k, v] of Object.entries(obj || {})) {
    if (wanted.includes(k.toLowerCase())) return v;
  }
  return undefined;
}

async function getUploadInfo(config) {
  const json = await callWebhook(config, 'upload', '');
  const info = {
    uploadLink: pick(json, 'uploadLink', 'upload_link'),
    uploadToken: pick(json, 'uploadToken', 'upload_token'),
    userId: pick(json, 'userId', 'uploadUserId', 'user_id'),
  };
  if (!info.uploadLink || !info.uploadToken || !info.userId) {
    throw new Error(
      `format=upload response missing fields; got keys: ${Object.keys(json).join(', ') || '(none)'}`
    );
  }
  return info;
}

async function uploadFile({ uploadLink, uploadToken, userId }, filePath) {
  const data = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const form = new FormData();
  form.append(
    'file',
    new Blob([data], { type: MIME_TYPES[ext] || 'application/octet-stream' }),
    path.basename(filePath)
  );

  const res = await fetch(uploadLink, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${uploadToken}`,
      'Zoom-File-Meta': JSON.stringify({ ownerType: 'user', ownerId: userId }),
    },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new ZoomWebhookError('File upload', res.status, text);

  const fileId = res.headers.get('zoom-file-id');
  if (!fileId) {
    throw new Error(`File upload returned HTTP ${res.status} but no Zoom-File-ID header. Body: ${text}`);
  }
  return fileId;
}

async function sendImageMessage(config, fileId, message) {
  const body = JSON.stringify([{ text: message, img: [fileId] }]);
  return callWebhook(config, 'img', body);
}

/**
 * Upload a local image and post it to the Zoom channel with a message.
 * Resolves with { fileId, response } only after Zoom accepts the img message.
 */
async function sendScreenshot(filePath, message) {
  const config = getConfig();
  const absPath = path.resolve(filePath);
  await fs.access(absPath);
  const text =
    message || `Screenshot: ${path.basename(absPath)} (${new Date().toISOString()})`;

  const uploadInfo = await getUploadInfo(config);
  const fileId = await uploadFile(uploadInfo, absPath);
  const response = await sendImageMessage(config, fileId, text);
  return { fileId, response };
}

/** Post a plain-text message to the Zoom channel (format=message). */
async function sendMessage(text) {
  return callWebhook(getConfig(), 'message', text);
}

module.exports = { sendScreenshot, sendMessage, sign };

if (require.main === module) {
  const [filePath, message] = process.argv.slice(2);
  if (!filePath) {
    console.error('Usage: node sendScreenshot.js <path-to-image> ["message"]');
    process.exit(2);
  }
  sendScreenshot(filePath, message)
    .then(({ fileId, response }) => {
      console.log(`[zoom] Success. File ID: ${fileId}`);
      console.log(`[zoom] img response: ${JSON.stringify(response)}`);
    })
    .catch((err) => {
      console.error(`[zoom] Error: ${err.message}`);
      if (err.cause) console.error(`[zoom] Cause: ${err.cause.message || err.cause}`);
      process.exit(1);
    });
}
