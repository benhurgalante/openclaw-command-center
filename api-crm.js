// api-crm.js — CRM REST endpoints for OpenClaw Command Center
// Real column names from schema:
// companies: name, tax_id, website, industry, size_segment, billing_country/state/city, owner_user_id, metadata
// contacts: first_name, last_name, email, phone, job_title, owner_user_id, company_id, metadata
// leads: source_system, source_record_id, status, first_name, last_name, company, email, phone, owner_user_id, converted_*
// deals: pipeline_id, stage_id, company_id, primary_contact_id, title, amount, currency_code, expected_close_at, owner_user_id, status, stage_entered_at, loss_reason, metadata
// pipeline_stages: stage_name, stage_order, probability, is_won_stage, is_closed_stage
// activities: deal_id, contact_id, company_id, activity_type, subject, body, due_at, done_at, actor_user_id
// notes: body, owner_user_id, company_id, contact_id, deal_id
// deal_stage_history: deal_id, from_stage_id, to_stage_id, changed_at, changed_by
const db = require("./db");

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

function registerCrmRoutes(router) {

  // ==================== PIPELINES ====================

  router.get("/api/crm/pipelines", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `SELECT p.*, (SELECT json_agg(s ORDER BY s.stage_order) FROM crm.pipeline_stages s WHERE s.pipeline_id = p.id AND s.deleted_at IS NULL) as stages
       FROM crm.pipelines p WHERE p.tenant_id = $1 AND p.deleted_at IS NULL ORDER BY p.created_at`, [tid]
    );
    return res.rows;
  });

  router.post("/api/crm/pipelines", async (req, body) => {
    const tid = await getTenantId(req);
    return db.transaction(async (client) => {
      const res = await client.query(
        "INSERT INTO crm.pipelines (tenant_id, name, is_default) VALUES ($1,$2,$3) RETURNING *",
        [tid, body.name, body.is_default || false]
      );
      const pipeline = res.rows[0];
      const stages = body.stages || [
        { stage_name: "Novo", stage_order: 0 },
        { stage_name: "Qualificado", stage_order: 1, probability: 25 },
        { stage_name: "Proposta", stage_order: 2, probability: 50 },
        { stage_name: "Negociação", stage_order: 3, probability: 75 },
        { stage_name: "Fechado Ganho", stage_order: 4, probability: 100, is_won_stage: true, is_closed_stage: true },
        { stage_name: "Fechado Perdido", stage_order: 5, probability: 0, is_closed_stage: true },
      ];
      for (const s of stages) {
        await client.query(
          "INSERT INTO crm.pipeline_stages (tenant_id, pipeline_id, stage_name, stage_order, probability, is_won_stage, is_closed_stage) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [tid, pipeline.id, s.stage_name, s.stage_order, s.probability || null, s.is_won_stage || false, s.is_closed_stage || false]
        );
      }
      const stagesRes = await client.query("SELECT * FROM crm.pipeline_stages WHERE pipeline_id = $1 ORDER BY stage_order", [pipeline.id]);
      pipeline.stages = stagesRes.rows;
      return pipeline;
    });
  });

  // ==================== COMPANIES ====================

  router.get("/api/crm/companies", async (req) => {
    const tid = await getTenantId(req);
    const search = req.query.search || "";
    const limit = Math.min(parseInt(req.query.limit || "50"), 200);
    const offset = parseInt(req.query.offset || "0");
    let where = "c.tenant_id = $1 AND c.deleted_at IS NULL";
    const params = [tid];
    if (search) { params.push(`%${search}%`); where += ` AND (c.name ILIKE $${params.length} OR c.website ILIKE $${params.length})`; }
    const countRes = await db.query(`SELECT count(*) FROM crm.companies c WHERE ${where}`, params);
    const res = await db.query(
      `SELECT c.* FROM crm.companies c WHERE ${where} ORDER BY c.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { items: res.rows, total: parseInt(countRes.rows[0].count), limit, offset };
  });

  router.post("/api/crm/companies", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `INSERT INTO crm.companies (tenant_id, name, tax_id, website, industry, size_segment, billing_country, billing_state, billing_city, owner_user_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [tid, body.name, body.tax_id || null, body.website || null, body.industry || null, body.size_segment || null,
       body.billing_country || null, body.billing_state || null, body.billing_city || null,
       body.owner_user_id || null, JSON.stringify(body.metadata || {})]
    );
    return res.rows[0];
  });

  router.get("/api/crm/companies/:id", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query("SELECT * FROM crm.companies WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL", [req.params.id, tid]);
    if (res.rows.length === 0) throw { status: 404, message: "Company not found" };
    const [contacts, deals] = await Promise.all([
      db.query("SELECT count(*) FROM crm.contacts WHERE company_id = $1 AND tenant_id = $2 AND deleted_at IS NULL", [req.params.id, tid]),
      db.query("SELECT count(*), COALESCE(sum(amount),0) as total FROM crm.deals WHERE company_id = $1 AND tenant_id = $2 AND deleted_at IS NULL", [req.params.id, tid]),
    ]);
    const company = res.rows[0];
    company.contacts_count = parseInt(contacts.rows[0].count);
    company.deals_count = parseInt(deals.rows[0].count);
    company.deals_total = parseFloat(deals.rows[0].total);
    return company;
  });

  router.patch("/api/crm/companies/:id", async (req, body) => {
    const tid = await getTenantId(req);
    const fields = ["name", "tax_id", "website", "industry", "size_segment", "billing_country", "billing_state", "billing_city", "owner_user_id"];
    const sets = []; const params = [req.params.id, tid];
    for (const f of fields) { if (body[f] !== undefined) { params.push(body[f]); sets.push(`${f} = $${params.length}`); } }
    if (body.metadata) { params.push(JSON.stringify(body.metadata)); sets.push(`metadata = $${params.length}`); }
    if (sets.length === 0) throw { status: 400, message: "No fields to update" };
    sets.push("updated_at = now()");
    const res = await db.query(`UPDATE crm.companies SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING *`, params);
    if (res.rows.length === 0) throw { status: 404, message: "Company not found" };
    return res.rows[0];
  });

  // ==================== CONTACTS ====================

  router.get("/api/crm/contacts", async (req) => {
    const tid = await getTenantId(req);
    const search = req.query.search || "";
    const companyId = req.query.company_id || null;
    const limit = Math.min(parseInt(req.query.limit || "50"), 200);
    const offset = parseInt(req.query.offset || "0");
    let where = "c.tenant_id = $1 AND c.deleted_at IS NULL";
    const params = [tid];
    if (search) { params.push(`%${search}%`); where += ` AND (c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length} OR c.email ILIKE $${params.length})`; }
    if (companyId) { params.push(companyId); where += ` AND c.company_id = $${params.length}`; }
    const countRes = await db.query(`SELECT count(*) FROM crm.contacts c WHERE ${where}`, params);
    const res = await db.query(
      `SELECT c.*, co.name as company_name FROM crm.contacts c LEFT JOIN crm.companies co ON c.company_id = co.id WHERE ${where} ORDER BY c.first_name, c.last_name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { items: res.rows, total: parseInt(countRes.rows[0].count), limit, offset };
  });

  router.post("/api/crm/contacts", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `INSERT INTO crm.contacts (tenant_id, company_id, first_name, last_name, email, phone, job_title, owner_user_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [tid, body.company_id || null, body.first_name, body.last_name || null,
       body.email || null, body.phone || null, body.job_title || null, body.owner_user_id || null, JSON.stringify(body.metadata || {})]
    );
    return res.rows[0];
  });

  router.patch("/api/crm/contacts/:id", async (req, body) => {
    const tid = await getTenantId(req);
    const fields = ["company_id", "first_name", "last_name", "email", "phone", "job_title", "owner_user_id"];
    const sets = []; const params = [req.params.id, tid];
    for (const f of fields) { if (body[f] !== undefined) { params.push(body[f]); sets.push(`${f} = $${params.length}`); } }
    if (sets.length === 0) throw { status: 400, message: "No fields to update" };
    sets.push("updated_at = now()");
    const res = await db.query(`UPDATE crm.contacts SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING *`, params);
    if (res.rows.length === 0) throw { status: 404, message: "Contact not found" };
    return res.rows[0];
  });

  // ==================== LEADS ====================

  router.get("/api/crm/leads", async (req) => {
    const tid = await getTenantId(req);
    const status = req.query.status || null;
    const limit = Math.min(parseInt(req.query.limit || "50"), 200);
    const offset = parseInt(req.query.offset || "0");
    let where = "l.tenant_id = $1 AND l.deleted_at IS NULL";
    const params = [tid];
    if (status) { params.push(status); where += ` AND l.status = $${params.length}`; }
    const countRes = await db.query(`SELECT count(*) FROM crm.leads l WHERE ${where}`, params);
    const res = await db.query(
      `SELECT l.* FROM crm.leads l WHERE ${where} ORDER BY l.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { items: res.rows, total: parseInt(countRes.rows[0].count), limit, offset };
  });

  router.post("/api/crm/leads", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `INSERT INTO crm.leads (tenant_id, first_name, last_name, company, email, phone, source_system, status, owner_user_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [tid, body.first_name || null, body.last_name || null, body.company || null,
       body.email || null, body.phone || null, body.source_system || null,
       body.status || "new", body.owner_user_id || null, JSON.stringify(body.metadata || {})]
    );
    return res.rows[0];
  });

  // ==================== DEALS ====================

  router.get("/api/crm/deals", async (req) => {
    const tid = await getTenantId(req);
    const pipelineId = req.query.pipeline_id || null;
    const stageId = req.query.stage_id || null;
    const status = req.query.status || null;
    const limit = Math.min(parseInt(req.query.limit || "50"), 200);
    const offset = parseInt(req.query.offset || "0");
    let where = "d.tenant_id = $1 AND d.deleted_at IS NULL";
    const params = [tid];
    if (pipelineId) { params.push(pipelineId); where += ` AND d.pipeline_id = $${params.length}`; }
    if (stageId) { params.push(stageId); where += ` AND d.stage_id = $${params.length}`; }
    if (status) { params.push(status); where += ` AND d.status = $${params.length}`; }
    const countRes = await db.query(`SELECT count(*) FROM crm.deals d WHERE ${where}`, params);
    const res = await db.query(
      `SELECT d.*, co.name as company_name, ct.first_name || ' ' || COALESCE(ct.last_name,'') as contact_name,
              ps.stage_name, p.name as pipeline_name
       FROM crm.deals d
       LEFT JOIN crm.companies co ON d.company_id = co.id
       LEFT JOIN crm.contacts ct ON d.primary_contact_id = ct.id
       LEFT JOIN crm.pipeline_stages ps ON d.stage_id = ps.id
       LEFT JOIN crm.pipelines p ON d.pipeline_id = p.id
       WHERE ${where} ORDER BY d.amount DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { items: res.rows, total: parseInt(countRes.rows[0].count), limit, offset };
  });

  router.post("/api/crm/deals", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `INSERT INTO crm.deals (tenant_id, pipeline_id, stage_id, company_id, primary_contact_id, title, amount, currency_code, expected_close_at, owner_user_id, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tid, body.pipeline_id, body.stage_id, body.company_id || null, body.primary_contact_id || null,
       body.title, body.amount || null, body.currency_code || "BRL", body.expected_close_at || null,
       body.owner_user_id || null, body.status || "open", JSON.stringify(body.metadata || {})]
    );
    return res.rows[0];
  });

  router.patch("/api/crm/deals/:id", async (req, body) => {
    const tid = await getTenantId(req);
    return db.transaction(async (client) => {
      const current = await client.query("SELECT * FROM crm.deals WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL", [req.params.id, tid]);
      if (current.rows.length === 0) throw { status: 404, message: "Deal not found" };
      const deal = current.rows[0];
      const fields = ["pipeline_id", "stage_id", "company_id", "primary_contact_id", "title", "amount", "currency_code", "expected_close_at", "owner_user_id", "status", "loss_reason", "closed_at"];
      const sets = []; const params = [req.params.id, tid];
      for (const f of fields) { if (body[f] !== undefined) { params.push(body[f]); sets.push(`${f} = $${params.length}`); } }
      if (body.metadata) { params.push(JSON.stringify(body.metadata)); sets.push(`metadata = $${params.length}`); }
      if (sets.length === 0) throw { status: 400, message: "No fields to update" };
      if (body.stage_id && body.stage_id !== deal.stage_id) { sets.push("stage_entered_at = now()"); }
      sets.push("updated_at = now()");
      const res = await client.query(`UPDATE crm.deals SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`, params);
      if (body.stage_id && body.stage_id !== deal.stage_id) {
        await client.query(
          "INSERT INTO crm.deal_stage_history (tenant_id, deal_id, from_stage_id, to_stage_id, changed_by) VALUES ($1,$2,$3,$4,$5)",
          [tid, req.params.id, deal.stage_id, body.stage_id, req.headers["x-actor"] || null]
        );
      }
      return res.rows[0];
    });
  });

  router.get("/api/crm/deals/:id/history", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `SELECT h.*, fs.stage_name as from_stage, ts.stage_name as to_stage
       FROM crm.deal_stage_history h
       LEFT JOIN crm.pipeline_stages fs ON h.from_stage_id = fs.id
       LEFT JOIN crm.pipeline_stages ts ON h.to_stage_id = ts.id
       WHERE h.deal_id = $1 AND h.tenant_id = $2 ORDER BY h.changed_at DESC`, [req.params.id, tid]
    );
    return res.rows;
  });

  // ==================== ACTIVITIES ====================

  router.get("/api/crm/activities", async (req) => {
    const tid = await getTenantId(req);
    const limit = Math.min(parseInt(req.query.limit || "50"), 200);
    let where = "a.tenant_id = $1 AND a.deleted_at IS NULL";
    const params = [tid];
    if (req.query.deal_id) { params.push(req.query.deal_id); where += ` AND a.deal_id = $${params.length}`; }
    if (req.query.contact_id) { params.push(req.query.contact_id); where += ` AND a.contact_id = $${params.length}`; }
    if (req.query.company_id) { params.push(req.query.company_id); where += ` AND a.company_id = $${params.length}`; }
    const res = await db.query(
      `SELECT a.* FROM crm.activities a WHERE ${where} ORDER BY COALESCE(a.due_at, a.created_at) DESC LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    return res.rows;
  });

  router.post("/api/crm/activities", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `INSERT INTO crm.activities (tenant_id, deal_id, contact_id, company_id, activity_type, subject, body, due_at, done_at, actor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [tid, body.deal_id || null, body.contact_id || null, body.company_id || null,
       body.activity_type || "note", body.subject || null, body.body || null,
       body.due_at || null, body.done_at || null, body.actor_user_id || null]
    );
    return res.rows[0];
  });

  // ==================== NOTES ====================

  router.post("/api/crm/notes", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      "INSERT INTO crm.notes (tenant_id, contact_id, company_id, deal_id, body, owner_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [tid, body.contact_id || null, body.company_id || null, body.deal_id || null, body.body, body.owner_user_id || null]
    );
    return res.rows[0];
  });

  // ==================== CRM STATS ====================

  router.get("/api/crm/stats", async (req) => {
    const tid = await getTenantId(req);
    const [companies, contacts, leads, deals, openDeals, wonDeals] = await Promise.all([
      db.query("SELECT count(*) FROM crm.companies WHERE tenant_id = $1 AND deleted_at IS NULL", [tid]),
      db.query("SELECT count(*) FROM crm.contacts WHERE tenant_id = $1 AND deleted_at IS NULL", [tid]),
      db.query("SELECT count(*), status FROM crm.leads WHERE tenant_id = $1 AND deleted_at IS NULL GROUP BY status", [tid]),
      db.query("SELECT count(*), COALESCE(sum(amount),0) as total FROM crm.deals WHERE tenant_id = $1 AND deleted_at IS NULL", [tid]),
      db.query("SELECT count(*), COALESCE(sum(amount),0) as total FROM crm.deals WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'open'", [tid]),
      db.query(`SELECT count(*), COALESCE(sum(d.amount),0) as total FROM crm.deals d JOIN crm.pipeline_stages ps ON d.stage_id = ps.id WHERE d.tenant_id = $1 AND d.deleted_at IS NULL AND ps.is_won_stage = true`, [tid]),
    ]);
    const leadsByStatus = {};
    for (const r of leads.rows) leadsByStatus[r.status] = parseInt(r.count);
    return {
      companies: parseInt(companies.rows[0].count),
      contacts: parseInt(contacts.rows[0].count),
      leads: leadsByStatus,
      deals: {
        total: parseInt(deals.rows[0].count),
        totalValue: parseFloat(deals.rows[0].total),
        open: { count: parseInt(openDeals.rows[0].count), value: parseFloat(openDeals.rows[0].total) },
        won: { count: parseInt(wonDeals.rows[0].count), value: parseFloat(wonDeals.rows[0].total) },
      },
    };
  });

  router.get("/api/crm/funnel", async (req) => {
    const tid = await getTenantId(req);
    const pipelineId = req.query.pipeline_id;
    if (!pipelineId) throw { status: 400, message: "pipeline_id required" };
    const res = await db.query(
      `SELECT ps.id, ps.stage_name, ps.stage_order, ps.is_won_stage, ps.is_closed_stage, ps.probability,
              count(d.id) as deal_count, COALESCE(sum(d.amount),0) as total_value
       FROM crm.pipeline_stages ps
       LEFT JOIN crm.deals d ON d.stage_id = ps.id AND d.tenant_id = $1 AND d.deleted_at IS NULL
       WHERE ps.pipeline_id = $2 AND ps.tenant_id = $1 AND ps.deleted_at IS NULL
       GROUP BY ps.id ORDER BY ps.stage_order`, [tid, pipelineId]
    );
    return res.rows;
  });
}

module.exports = { registerCrmRoutes };
