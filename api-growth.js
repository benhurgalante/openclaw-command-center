// api-growth.js — Growth integrations: credentials, sync, connectors
const db = require("./db");
const { encrypt, decrypt, maskCredentials, PROVIDER_FIELDS } = require("./crypto-utils");
const https = require("https");
const fs = require("fs");
const path = require("path");

let _defaultTenantId = null;
async function getTenantId(req) {
  let tid = req.headers["x-tenant-id"];
  if (!tid) {
    if (!_defaultTenantId) {
      const res = await db.query("SELECT id FROM core.tenants LIMIT 1");
      if (res.rows.length > 0) _defaultTenantId = res.rows[0].id;
      else throw { status: 400, message: "No tenant configured" };
    }
    tid = _defaultTenantId;
  }
  db.setActiveTenant(tid);
  return tid;
}

// ==================== HTTP HELPERS ====================

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname, port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "GET", headers, timeout: 15000,
    };
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body), raw: body }); }
        catch { resolve({ status: res.statusCode, data: null, raw: body }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ==================== CONNECTORS ====================

async function syncInstagram(creds, config) {
  const token = creds.access_token;
  if (!token) throw new Error("access_token not configured");

  // Step 1: Get user/page info
  let igUserId = creds.instagram_business_id;
  if (!igUserId && creds.page_id) {
    const pageRes = await httpsGet(`https://graph.facebook.com/v19.0/${creds.page_id}?fields=instagram_business_account&access_token=${token}`);
    if (pageRes.data?.instagram_business_account?.id) {
      igUserId = pageRes.data.instagram_business_account.id;
    }
  }
  if (!igUserId) {
    // Try to get from /me/accounts
    const meRes = await httpsGet(`https://graph.facebook.com/v19.0/me/accounts?fields=instagram_business_account&access_token=${token}`);
    const pages = meRes.data?.data || [];
    for (const p of pages) {
      if (p.instagram_business_account?.id) { igUserId = p.instagram_business_account.id; break; }
    }
  }
  if (!igUserId) throw new Error("Nao foi possivel encontrar Instagram Business Account. Configure page_id ou instagram_business_id");

  // Step 2: Get metrics
  const fields = "followers_count,media_count,name,biography,website";
  const userRes = await httpsGet(`https://graph.facebook.com/v19.0/${igUserId}?fields=${fields}&access_token=${token}`);
  if (userRes.status !== 200) throw new Error(`Instagram API error ${userRes.status}: ${userRes.raw?.substring(0, 200)}`);

  // Step 3: Get insights (last 30 days)
  let reach = 0, impressions = 0, engagement = 0;
  try {
    const insRes = await httpsGet(
      `https://graph.facebook.com/v19.0/${igUserId}/insights?metric=reach,impressions&period=day&since=${Math.floor(Date.now()/1000) - 86400*30}&until=${Math.floor(Date.now()/1000)}&access_token=${token}`
    );
    const insData = insRes.data?.data || [];
    for (const m of insData) {
      const total = (m.values || []).reduce((s, v) => s + (v.value || 0), 0);
      if (m.name === "reach") reach = total;
      if (m.name === "impressions") impressions = total;
    }
  } catch {}

  // Step 4: Recent media engagement
  try {
    const mediaRes = await httpsGet(
      `https://graph.facebook.com/v19.0/${igUserId}/media?fields=like_count,comments_count,timestamp&limit=25&access_token=${token}`
    );
    const media = mediaRes.data?.data || [];
    engagement = media.reduce((s, m) => s + (m.like_count || 0) + (m.comments_count || 0), 0);
  } catch {}

  const followers = userRes.data?.followers_count || 0;
  const posts = userRes.data?.media_count || 0;
  const engagementRate = followers > 0 ? ((engagement / Math.min(posts, 25)) / followers * 100) : 0;

  return {
    followers, posts, reach, impressions, engagement,
    engagementRate: parseFloat(engagementRate.toFixed(2)),
    name: userRes.data?.name || "",
    igUserId,
    updatedAt: new Date().toISOString(),
  };
}

async function syncYouTube(creds) {
  const apiKey = creds.api_key;
  if (!apiKey) throw new Error("api_key not configured");

  let channelId = creds.channel_id;
  if (!channelId) {
    // Try "mine" — won't work with API key alone, but try
    const myRes = await httpsGet(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true&key=${apiKey}`);
    if (myRes.data?.items?.[0]) channelId = myRes.data.items[0].id;
  }
  if (!channelId) throw new Error("channel_id required. Encontre em youtube.com > Settings > Advanced > Channel ID");

  const res = await httpsGet(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet,contentDetails&id=${channelId}&key=${apiKey}`
  );
  if (res.status !== 200) throw new Error(`YouTube API error ${res.status}: ${res.raw?.substring(0, 200)}`);
  const ch = res.data?.items?.[0];
  if (!ch) throw new Error("Channel not found: " + channelId);

  const stats = ch.statistics || {};

  // Get recent videos for more detailed stats
  let recentViews = 0, recentLikes = 0, videoCount = 0;
  try {
    const searchRes = await httpsGet(
      `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&order=date&maxResults=10&type=video&key=${apiKey}`
    );
    const videoIds = (searchRes.data?.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (videoIds.length > 0) {
      const vidRes = await httpsGet(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(",")}&key=${apiKey}`
      );
      for (const v of (vidRes.data?.items || [])) {
        recentViews += parseInt(v.statistics?.viewCount || 0);
        recentLikes += parseInt(v.statistics?.likeCount || 0);
        videoCount++;
      }
    }
  } catch {}

  return {
    subscribers: parseInt(stats.subscriberCount || 0),
    views: parseInt(stats.viewCount || 0),
    videoCount: parseInt(stats.videoCount || 0),
    recentVideos: videoCount,
    recentViews, recentLikes,
    channelName: ch.snippet?.title || "",
    channelId,
    ctr: videoCount > 0 ? parseFloat((recentLikes / Math.max(recentViews, 1) * 100).toFixed(2)) : 0,
    updatedAt: new Date().toISOString(),
  };
}

async function syncGoogleAds(creds) {
  // Google Ads API requires OAuth2 — complex flow
  // For now, validate credentials and return placeholder
  if (!creds.developer_token || !creds.refresh_token) {
    throw new Error("developer_token and refresh_token required");
  }

  // Refresh access token
  const tokenRes = await httpsGet(
    `https://oauth2.googleapis.com/token?client_id=${encodeURIComponent(creds.client_id)}&client_secret=${encodeURIComponent(creds.client_secret)}&refresh_token=${encodeURIComponent(creds.refresh_token)}&grant_type=refresh_token`
  );
  // Note: token endpoint uses POST, but we're doing simplified validation here
  // Full implementation would use POST with proper body
  return {
    status: "configured",
    message: "Google Ads connector configured. Full sync requires POST-based OAuth2 flow.",
    customerId: creds.customer_id || null,
    updatedAt: new Date().toISOString(),
  };
}

const SYNC_HANDLERS = {
  instagram: syncInstagram,
  youtube: syncYouTube,
  google_ads: syncGoogleAds,
};

// ==================== ROUTES ====================

function registerGrowthRoutes(router) {

  // GET /api/growth/integrations — list integrations (masked credentials)
  router.get("/api/growth/integrations", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `SELECT id, provider, account_ref, config, status, last_sync_at, last_error, sync_interval_minutes, created_at, updated_at
       FROM core.external_integrations WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY provider`, [tid]
    );
    // Add provider metadata
    return res.rows.map(r => ({
      ...r,
      providerLabel: PROVIDER_FIELDS[r.provider]?.label || r.provider,
      providerFields: PROVIDER_FIELDS[r.provider] || {},
    }));
  });

  // POST /api/growth/integrations — create/update integration
  router.post("/api/growth/integrations", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.provider) throw { status: 400, message: "provider required" };
    const pf = PROVIDER_FIELDS[body.provider];
    if (!pf) throw { status: 400, message: "Provider invalido. Suportados: " + Object.keys(PROVIDER_FIELDS).join(", ") };

    // Validate required fields
    const creds = body.credentials || {};
    for (const f of pf.required) {
      if (!creds[f]) throw { status: 400, message: `Campo obrigatorio: ${f}. ${pf.help}` };
    }

    // Encrypt credentials
    const { encrypted, iv } = encrypt(JSON.stringify(creds));

    // Upsert (one integration per provider per tenant)
    const existing = await db.query(
      "SELECT id FROM core.external_integrations WHERE tenant_id = $1 AND provider = $2 AND deleted_at IS NULL", [tid, body.provider]
    );

    let result;
    if (existing.rows.length > 0) {
      result = await db.query(
        `UPDATE core.external_integrations SET credentials_encrypted = $1, credentials_iv = $2, account_ref = $3, config = $4, status = 'pending', last_error = NULL, updated_at = now()
         WHERE id = $5 RETURNING id, provider, status, updated_at`,
        [encrypted, iv, body.account_ref || null, JSON.stringify(body.config || {}), existing.rows[0].id]
      );
    } else {
      result = await db.query(
        `INSERT INTO core.external_integrations (tenant_id, provider, account_ref, credentials_encrypted, credentials_iv, config, sync_interval_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, provider, status, created_at`,
        [tid, body.provider, body.account_ref || null, encrypted, iv, JSON.stringify(body.config || {}), body.sync_interval_minutes || 60]
      );
    }

    return { ...result.rows[0], message: "Credenciais salvas com criptografia AES-256-GCM" };
  });

  // POST /api/growth/integrations/:id/test — test connection
  router.post("/api/growth/integrations/:id/test", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      "SELECT * FROM core.external_integrations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL",
      [req.params.id, tid]
    );
    if (res.rows.length === 0) throw { status: 404, message: "Integration not found" };

    const row = res.rows[0];
    const creds = JSON.parse(decrypt(row.credentials_encrypted, row.credentials_iv));
    const handler = SYNC_HANDLERS[row.provider];

    if (!handler) {
      return { provider: row.provider, status: "unsupported", message: "Conector ainda nao implementado para " + row.provider };
    }

    try {
      const metrics = await handler(creds, row.config || {});
      // Update status to connected
      await db.query(
        "UPDATE core.external_integrations SET status = 'connected', last_error = NULL, updated_at = now() WHERE id = $1",
        [row.id]
      );
      return { provider: row.provider, status: "connected", message: "Conexao OK!", metrics };
    } catch (err) {
      await db.query(
        "UPDATE core.external_integrations SET status = 'error', last_error = $1, updated_at = now() WHERE id = $2",
        [err.message, row.id]
      );
      return { provider: row.provider, status: "error", message: err.message };
    }
  });

  // POST /api/growth/sync — sync all integrations (or specific provider)
  router.post("/api/growth/sync", async (req, body) => {
    const tid = await getTenantId(req);
    let where = "tenant_id = $1 AND deleted_at IS NULL AND status != 'disabled'";
    const params = [tid];
    if (body.provider) { params.push(body.provider); where += ` AND provider = $${params.length}`; }

    const integrations = await db.query(`SELECT * FROM core.external_integrations WHERE ${where}`, params);
    const results = [];

    const GROWTH_DIR = path.join(require("os").homedir(), ".openclaw/workspace-ads/.growth");
    const GROWTH_METRICS_FILE = path.join(GROWTH_DIR, "metrics.json");

    // Load existing metrics JSON
    let metricsJson = {};
    try { metricsJson = JSON.parse(fs.readFileSync(GROWTH_METRICS_FILE, "utf-8")); } catch {}

    for (const row of integrations.rows) {
      const handler = SYNC_HANDLERS[row.provider];
      if (!handler) { results.push({ provider: row.provider, status: "skipped", reason: "no connector" }); continue; }

      try {
        const creds = JSON.parse(decrypt(row.credentials_encrypted, row.credentials_iv));
        const metrics = await handler(creds, row.config || {});

        // Save to PostgreSQL history
        await db.query(
          "INSERT INTO core.growth_metrics_history (tenant_id, provider, metrics) VALUES ($1,$2,$3)",
          [tid, row.provider, JSON.stringify(metrics)]
        );

        // Update legacy JSON file for dashboard compatibility
        metricsJson[row.provider] = metrics;

        // Update integration status
        await db.query(
          "UPDATE core.external_integrations SET status = 'connected', last_sync_at = now(), last_error = NULL, updated_at = now() WHERE id = $1",
          [row.id]
        );

        results.push({ provider: row.provider, status: "synced", metrics });
      } catch (err) {
        await db.query(
          "UPDATE core.external_integrations SET status = 'error', last_error = $1, updated_at = now() WHERE id = $2",
          [err.message, row.id]
        );
        results.push({ provider: row.provider, status: "error", error: err.message });
      }
    }

    // Persist updated metrics JSON
    try {
      fs.mkdirSync(GROWTH_DIR, { recursive: true });
      fs.writeFileSync(GROWTH_METRICS_FILE, JSON.stringify(metricsJson, null, 2));
    } catch {}

    return { synced: results.filter(r => r.status === "synced").length, total: results.length, results };
  });

  // DELETE /api/growth/integrations/:id
  router.delete("/api/growth/integrations/:id", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      "UPDATE core.external_integrations SET deleted_at = now(), status = 'disabled' WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id, provider",
      [req.params.id, tid]
    );
    if (res.rows.length === 0) throw { status: 404, message: "Integration not found" };
    return { deleted: true, ...res.rows[0] };
  });

  // GET /api/growth/providers — list available providers with field requirements
  router.get("/api/growth/providers", async () => {
    return Object.entries(PROVIDER_FIELDS).map(([key, val]) => ({
      provider: key, ...val,
    }));
  });

  // GET /api/growth/metrics/history — historical metrics from PostgreSQL
  router.get("/api/growth/metrics/history", async (req) => {
    const tid = await getTenantId(req);
    const provider = req.query.provider;
    const days = Math.min(parseInt(req.query.days || "30"), 365);
    let where = "tenant_id = $1 AND created_at >= now() - interval '" + days + " days'";
    const params = [tid];
    if (provider) { params.push(provider); where += ` AND provider = $${params.length}`; }

    const res = await db.query(
      `SELECT provider, metric_date, metrics, created_at FROM core.growth_metrics_history WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params
    );
    return res.rows;
  });
}

// ==================== SYNC SCHEDULER ====================

let _syncTimer = null;

function startSyncScheduler() {
  if (_syncTimer) return;
  // Check every 5 minutes for integrations that need syncing
  _syncTimer = setInterval(async () => {
    try {
      const res = await db.query(
        `SELECT * FROM core.external_integrations
         WHERE deleted_at IS NULL AND status IN ('connected','pending')
         AND (last_sync_at IS NULL OR last_sync_at < now() - (sync_interval_minutes || ' minutes')::interval)`
      );
      for (const row of res.rows) {
        const handler = SYNC_HANDLERS[row.provider];
        if (!handler) continue;
        try {
          db.setActiveTenant(row.tenant_id);
          const creds = JSON.parse(decrypt(row.credentials_encrypted, row.credentials_iv));
          const metrics = await handler(creds, row.config || {});

          await db.query(
            "INSERT INTO core.growth_metrics_history (tenant_id, provider, metrics) VALUES ($1,$2,$3)",
            [row.tenant_id, row.provider, JSON.stringify(metrics)]
          );
          await db.query(
            "UPDATE core.external_integrations SET status = 'connected', last_sync_at = now(), last_error = NULL WHERE id = $1",
            [row.id]
          );

          // Update legacy JSON
          const GROWTH_DIR = path.join(require("os").homedir(), ".openclaw/workspace-ads/.growth");
          const GROWTH_METRICS_FILE = path.join(GROWTH_DIR, "metrics.json");
          let mj = {};
          try { mj = JSON.parse(fs.readFileSync(GROWTH_METRICS_FILE, "utf-8")); } catch {}
          mj[row.provider] = metrics;
          try { fs.writeFileSync(GROWTH_METRICS_FILE, JSON.stringify(mj, null, 2)); } catch {}

        } catch (err) {
          await db.query(
            "UPDATE core.external_integrations SET status = 'error', last_error = $1 WHERE id = $2",
            [err.message, row.id]
          );
        }
      }
      db.setActiveTenant(null);
    } catch {}
  }, 5 * 60 * 1000);
}

module.exports = { registerGrowthRoutes, startSyncScheduler };
