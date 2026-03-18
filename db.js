// db.js — PostgreSQL connection pool for OpenClaw
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE || "openclaw",
  user: process.env.PGUSER || "openclaw",
  password: process.env.PGPASSWORD || "openclaw2026",
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

// Current active tenant for RLS context
let _activeTenantId = null;

function setActiveTenant(tenantId) {
  _activeTenantId = tenantId;
}

function getActiveTenant() {
  return _activeTenantId;
}

// Query with automatic tenant context for RLS
// Wraps each query in a transaction that sets app.tenant_id
async function query(text, params) {
  if (!_activeTenantId) {
    // No tenant context — raw query (ok for core.tenants, health checks, etc.)
    return pool.query(text, params);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.tenant_id = '${_activeTenantId}'`);
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Transaction with tenant context
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (_activeTenantId) {
      await client.query(`SET LOCAL app.tenant_id = '${_activeTenantId}'`);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Explicit tenant-scoped execution
async function withTenant(tenantId, fn) {
  const prev = _activeTenantId;
  _activeTenantId = tenantId;
  try {
    return await fn();
  } finally {
    _activeTenantId = prev;
  }
}

// Health check (no tenant context needed)
async function healthCheck() {
  try {
    const res = await pool.query("SELECT NOW() as now, current_database() as db");
    return { ok: true, ...res.rows[0], pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { pool, query, transaction, withTenant, healthCheck, setActiveTenant, getActiveTenant };
