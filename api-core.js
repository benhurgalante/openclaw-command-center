// api-core.js — Core tenant/user/role management endpoints
// Table columns: tenants(slug, legal_name, status, metadata), users(email, full_name, password_hash, is_global_admin, status, profile)
// tenant_users(tenant_id, user_id, status, title, metadata), roles(tenant_id, name, description, is_system_role)
// user_roles(tenant_id, user_id, role_id), audit_log(tenant_id, actor_user_id, schema_name, table_name, record_pk, operation, old_data, new_data, event_at)
const db = require("./db");

let _defaultTenantId = null;

async function ensureDefaultTenant() {
  if (_defaultTenantId) return _defaultTenantId;
  const res = await db.query("SELECT id FROM core.tenants LIMIT 1");
  if (res.rows.length > 0) { _defaultTenantId = res.rows[0].id; return _defaultTenantId; }
  return null;
}

async function getTenantId(req) {
  const tid = req.headers["x-tenant-id"] || await ensureDefaultTenant();
  if (tid) db.setActiveTenant(tid);
  return tid;
}

function registerCoreRoutes(router) {

  // GET /api/core/tenants
  router.get("/api/core/tenants", async () => {
    const res = await db.query("SELECT * FROM core.tenants WHERE deleted_at IS NULL ORDER BY legal_name");
    return res.rows;
  });

  // POST /api/core/tenants
  router.post("/api/core/tenants", async (req, body) => {
    const res = await db.query(
      "INSERT INTO core.tenants (legal_name, slug, status, metadata) VALUES ($1,$2,$3,$4) RETURNING *",
      [body.legal_name || body.name, body.slug, body.status || "active", JSON.stringify(body.metadata || {})]
    );
    _defaultTenantId = null;
    return res.rows[0];
  });

  // GET /api/core/users
  router.get("/api/core/users", async (req) => {
    const tid = await getTenantId(req);
    if (!tid) return [];
    const res = await db.query(
      `SELECT u.id, u.email, u.full_name, u.status, u.is_global_admin, u.last_login_at, u.profile, u.created_at,
              tu.status as tenant_status, tu.title,
              array_agg(r.name) FILTER (WHERE r.name IS NOT NULL) as roles
       FROM core.users u
       JOIN core.tenant_users tu ON u.id = tu.user_id AND tu.tenant_id = $1
       LEFT JOIN core.user_roles ur ON u.id = ur.user_id AND ur.tenant_id = $1
       LEFT JOIN core.roles r ON ur.role_id = r.id
       WHERE u.deleted_at IS NULL AND tu.deleted_at IS NULL
       GROUP BY u.id, tu.status, tu.title ORDER BY u.full_name`,
      [tid]
    );
    return res.rows;
  });

  // POST /api/core/users
  router.post("/api/core/users", async (req, body) => {
    const tid = await getTenantId(req);
    if (!tid) throw { status: 400, message: "No tenant configured. Run POST /api/core/setup first." };
    return db.transaction(async (client) => {
      const userRes = await client.query(
        "INSERT INTO core.users (email, full_name, status, profile) VALUES ($1,$2,$3,$4) RETURNING *",
        [body.email, body.full_name || body.display_name || body.email.split("@")[0], body.status || "active", JSON.stringify(body.profile || {})]
      );
      const user = userRes.rows[0];
      await client.query(
        "INSERT INTO core.tenant_users (tenant_id, user_id, status, title) VALUES ($1,$2,$3,$4)",
        [tid, user.id, "active", body.title || null]
      );
      if (body.roles && body.roles.length > 0) {
        for (const roleName of body.roles) {
          const roleRes = await client.query("SELECT id FROM core.roles WHERE tenant_id = $1 AND name = $2", [tid, roleName]);
          if (roleRes.rows.length > 0) {
            await client.query("INSERT INTO core.user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [tid, user.id, roleRes.rows[0].id]);
          }
        }
      }
      return user;
    });
  });

  // PATCH /api/core/users/:id
  router.patch("/api/core/users/:id", async (req, body) => {
    const fields = ["full_name", "status", "profile"];
    const sets = [];
    const params = [req.params.id];
    for (const f of fields) {
      if (body[f] !== undefined) {
        params.push(f === "profile" ? JSON.stringify(body[f]) : body[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (sets.length === 0) throw { status: 400, message: "No fields to update" };
    sets.push("updated_at = now()");
    const res = await db.query(`UPDATE core.users SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING *`, params);
    if (res.rows.length === 0) throw { status: 404, message: "User not found" };
    return res.rows[0];
  });

  // GET /api/core/roles
  router.get("/api/core/roles", async (req) => {
    const tid = await getTenantId(req);
    if (!tid) return [];
    const res = await db.query("SELECT * FROM core.roles WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY name", [tid]);
    return res.rows;
  });

  // POST /api/core/roles
  router.post("/api/core/roles", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      "INSERT INTO core.roles (tenant_id, name, description) VALUES ($1,$2,$3) RETURNING *",
      [tid, body.name, body.description || null]
    );
    return res.rows[0];
  });

  // GET /api/core/audit
  router.get("/api/core/audit", async (req) => {
    const tid = await getTenantId(req);
    const limit = Math.min(parseInt(req.query.limit || "100"), 500);
    const res = await db.query(
      "SELECT * FROM core.audit_log WHERE tenant_id = $1 ORDER BY event_at DESC LIMIT $2", [tid, limit]
    );
    return res.rows;
  });

  // GET /api/core/db-health
  router.get("/api/core/db-health", async () => {
    return db.healthCheck();
  });

  // POST /api/core/setup — create default tenant, roles, admin user, seed categories
  router.post("/api/core/setup", async (req, body) => {
    return db.transaction(async (client) => {
      const existing = await client.query("SELECT id FROM core.tenants LIMIT 1");
      if (existing.rows.length > 0) {
        _defaultTenantId = existing.rows[0].id;
        return { status: "already_setup", tenantId: existing.rows[0].id };
      }

      // Create tenant
      const tenantRes = await client.query(
        "INSERT INTO core.tenants (legal_name, slug, status) VALUES ($1,$2,'active') RETURNING *",
        [body.tenant_name || "OpenClaw", body.tenant_slug || "openclaw"]
      );
      const tenant = tenantRes.rows[0];
      _defaultTenantId = tenant.id;

      // Set tenant context for RLS-protected tables
      await client.query(`SET LOCAL app.tenant_id = '${tenant.id}'`);

      // Create default roles
      const roleNames = ["admin", "operator", "viewer", "member"];
      for (const r of roleNames) {
        await client.query(
          "INSERT INTO core.roles (tenant_id, name, description, is_system_role) VALUES ($1,$2,$3,true)",
          [tenant.id, r, `${r.charAt(0).toUpperCase() + r.slice(1)} role`]
        );
      }

      // Create admin user
      const userRes = await client.query(
        "INSERT INTO core.users (email, full_name, is_global_admin, status) VALUES ($1,$2,true,'active') RETURNING *",
        [body.admin_email || "ben@openclaw.ai", body.admin_name || "Ben"]
      );
      const user = userRes.rows[0];

      // Assign to tenant
      await client.query("INSERT INTO core.tenant_users (tenant_id, user_id, status) VALUES ($1,$2,'active')", [tenant.id, user.id]);

      // Assign admin role
      const adminRole = await client.query("SELECT id FROM core.roles WHERE tenant_id = $1 AND name = 'admin'", [tenant.id]);
      if (adminRole.rows.length > 0) {
        await client.query("INSERT INTO core.user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [tenant.id, user.id, adminRole.rows[0].id]);
      }

      // Seed financial categories
      const categories = [
        { name: "Salários", kind: "expense", dir: "outflow" },
        { name: "Infraestrutura", kind: "expense", dir: "outflow" },
        { name: "Marketing", kind: "expense", dir: "outflow" },
        { name: "Software/SaaS", kind: "expense", dir: "outflow" },
        { name: "Impostos", kind: "expense", dir: "outflow" },
        { name: "Alimentação", kind: "expense", dir: "outflow" },
        { name: "Transporte", kind: "expense", dir: "outflow" },
        { name: "Outros Gastos", kind: "expense", dir: "outflow" },
        { name: "Vendas", kind: "income", dir: "inflow" },
        { name: "Serviços", kind: "income", dir: "inflow" },
        { name: "Assinaturas", kind: "income", dir: "inflow" },
        { name: "Outros Recebimentos", kind: "income", dir: "inflow" },
      ];
      for (const c of categories) {
        await client.query(
          "INSERT INTO fin.categories (tenant_id, name, category_kind, direction) VALUES ($1,$2,$3,$4)",
          [tenant.id, c.name, c.kind, c.dir]
        );
      }

      return { status: "setup_complete", tenantId: tenant.id, userId: user.id };
    });
  });
}

module.exports = { registerCoreRoutes };
