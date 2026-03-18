// crypto-utils.js — AES-256-GCM encryption for credentials
const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_ENV = "OPENCLAW_SECRETS_KEY";

function getKey() {
  let key = process.env[KEY_ENV];
  if (!key) {
    // Auto-generate and persist if not set (dev mode)
    const keyFile = require("path").join(require("os").homedir(), ".openclaw", ".secrets-key");
    const fs = require("fs");
    if (fs.existsSync(keyFile)) {
      key = fs.readFileSync(keyFile, "utf-8").trim();
    } else {
      key = crypto.randomBytes(32).toString("hex");
      fs.mkdirSync(require("path").dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
    }
    process.env[KEY_ENV] = key;
  }
  // Key must be 32 bytes (64 hex chars)
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error(`${KEY_ENV} must be 64 hex chars (32 bytes). Got ${buf.length} bytes.`);
  }
  return buf;
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store as: tag(16) + encrypted
  return {
    encrypted: Buffer.concat([tag, encrypted]),
    iv,
  };
}

function decrypt(encryptedBuf, ivBuf) {
  const key = getKey();
  const tag = encryptedBuf.slice(0, 16);
  const data = encryptedBuf.slice(16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf);
  decipher.setAuthTag(tag);
  return decipher.update(data, null, "utf8") + decipher.final("utf8");
}

function maskCredentials(provider, creds) {
  // Return safe metadata about what's configured, never the actual values
  const masked = {};
  for (const [k, v] of Object.entries(creds)) {
    if (typeof v === "string" && v.length > 0) {
      masked[k] = v.slice(0, 4) + "****" + v.slice(-4);
    } else if (v !== null && v !== undefined) {
      masked[k] = "***set***";
    } else {
      masked[k] = null;
    }
  }
  return masked;
}

// Provider-specific required fields
const PROVIDER_FIELDS = {
  instagram: {
    required: ["access_token"],
    optional: ["page_id", "instagram_business_id"],
    label: "Instagram / Meta Graph API",
    help: "Obtenha em developers.facebook.com > Graph API Explorer. Permissoes: instagram_basic, instagram_manage_insights, pages_show_list",
  },
  youtube: {
    required: ["api_key"],
    optional: ["channel_id"],
    label: "YouTube Data API v3",
    help: "Crie em console.cloud.google.com > APIs & Services > Credentials. Ative YouTube Data API v3",
  },
  google_ads: {
    required: ["developer_token", "client_id", "client_secret", "refresh_token"],
    optional: ["customer_id", "login_customer_id"],
    label: "Google Ads API",
    help: "developer_token em ads.google.com/aw/apicenter. OAuth2 em console.cloud.google.com",
  },
  tiktok: {
    required: ["access_token"],
    optional: ["open_id"],
    label: "TikTok for Business API",
    help: "Obtenha em developers.tiktok.com > My Apps",
  },
  linkedin: {
    required: ["access_token"],
    optional: ["organization_id"],
    label: "LinkedIn Marketing API",
    help: "Obtenha em linkedin.com/developers > My Apps",
  },
  twitter: {
    required: ["bearer_token"],
    optional: ["user_id"],
    label: "X (Twitter) API v2",
    help: "Obtenha em developer.twitter.com > Projects & Apps",
  },
};

module.exports = { encrypt, decrypt, maskCredentials, PROVIDER_FIELDS };
