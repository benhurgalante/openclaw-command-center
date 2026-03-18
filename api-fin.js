// api-fin.js — Financial Data Unifier endpoints for OpenClaw
// Real column names: accounts(account_name, account_type, currency_code, institution_id, external_ref, provider, is_active, opened_on, metadata)
// transactions(account_id, category_id, cost_center_id, batch_id, direction, amount, currency_code, booked_at, posted_at, description, counterparty, external_id, status, notes)
// categories(parent_id, code, name, category_kind, direction, is_active)
// cost_centers(parent_id, code, name, is_active)
// raw_transactions(batch_id, row_data, row_hash)
// ingestion_batches(source_system, source_descriptor, source_checksum, received_at, processed_at, processed_by, status, error_message)
const db = require("./db");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

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

function registerFinRoutes(router) {

  // ==================== ACCOUNTS ====================

  router.get("/api/fin/accounts", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `SELECT a.*, i.name as institution_name
       FROM fin.accounts a LEFT JOIN fin.institutions i ON a.institution_id = i.id
       WHERE a.tenant_id = $1 AND a.deleted_at IS NULL ORDER BY a.account_name`, [tid]
    );
    return res.rows;
  });

  router.post("/api/fin/accounts", async (req, body) => {
    const tid = await getTenantId(req);
    let institutionId = body.institution_id || null;
    if (!institutionId && body.institution_name) {
      const existing = await db.query("SELECT id FROM fin.institutions WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) AND deleted_at IS NULL", [tid, body.institution_name]);
      if (existing.rows.length > 0) { institutionId = existing.rows[0].id; }
      else {
        const ins = await db.query("INSERT INTO fin.institutions (tenant_id, name, institution_type) VALUES ($1, $2, $3) RETURNING id", [tid, body.institution_name, body.institution_type || "bank"]);
        institutionId = ins.rows[0].id;
      }
    }
    const res = await db.query(
      `INSERT INTO fin.accounts (tenant_id, institution_id, account_name, account_type, currency_code, metadata)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tid, institutionId, body.account_name || body.name, body.account_type || body.type || "checking",
       body.currency_code || "BRL", JSON.stringify(body.metadata || {})]
    );
    return res.rows[0];
  });

  // ==================== CATEGORIES ====================

  router.get("/api/fin/categories", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query("SELECT * FROM fin.categories WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY category_kind, name", [tid]);
    return res.rows;
  });

  router.post("/api/fin/categories", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      "INSERT INTO fin.categories (tenant_id, parent_id, name, category_kind, direction, code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [tid, body.parent_id || null, body.name, body.category_kind || "expense", body.direction || "debit", body.code || null]
    );
    return res.rows[0];
  });

  // ==================== COST CENTERS ====================

  router.get("/api/fin/cost-centers", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query("SELECT * FROM fin.cost_centers WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY code", [tid]);
    return res.rows;
  });

  router.post("/api/fin/cost-centers", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      "INSERT INTO fin.cost_centers (tenant_id, code, name) VALUES ($1,$2,$3) RETURNING *",
      [tid, body.code, body.name]
    );
    return res.rows[0];
  });

  // ==================== TRANSACTIONS ====================

  router.get("/api/fin/transactions", async (req) => {
    const tid = await getTenantId(req);
    const limit = Math.min(parseInt(req.query.limit || "100"), 500);
    const offset = parseInt(req.query.offset || "0");
    let where = "t.tenant_id = $1 AND t.deleted_at IS NULL";
    const params = [tid];
    if (req.query.account_id) { params.push(req.query.account_id); where += ` AND t.account_id = $${params.length}`; }
    if (req.query.category_id) { params.push(req.query.category_id); where += ` AND t.category_id = $${params.length}`; }
    if (req.query.cost_center_id) { params.push(req.query.cost_center_id); where += ` AND t.cost_center_id = $${params.length}`; }
    if (req.query.direction) { params.push(req.query.direction); where += ` AND t.direction = $${params.length}`; }
    if (req.query.from) { params.push(req.query.from); where += ` AND t.booked_at >= $${params.length}`; }
    if (req.query.to) { params.push(req.query.to); where += ` AND t.booked_at <= $${params.length}`; }
    if (req.query.min_amount) { params.push(req.query.min_amount); where += ` AND t.amount >= $${params.length}`; }
    if (req.query.max_amount) { params.push(req.query.max_amount); where += ` AND t.amount <= $${params.length}`; }
    if (req.query.search) { params.push(`%${req.query.search}%`); where += ` AND (t.description ILIKE $${params.length} OR t.counterparty ILIKE $${params.length})`; }

    const countRes = await db.query(`SELECT count(*) FROM fin.transactions t WHERE ${where}`, params);
    const res = await db.query(
      `SELECT t.*, a.account_name, c.name as category_name, cc.name as cost_center_name
       FROM fin.transactions t
       LEFT JOIN fin.accounts a ON t.account_id = a.id
       LEFT JOIN fin.categories c ON t.category_id = c.id
       LEFT JOIN fin.cost_centers cc ON t.cost_center_id = cc.id
       WHERE ${where} ORDER BY t.booked_at DESC, t.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { items: res.rows, total: parseInt(countRes.rows[0].count), limit, offset };
  });

  router.post("/api/fin/transactions", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `INSERT INTO fin.transactions (tenant_id, account_id, category_id, cost_center_id, direction, amount, currency_code, booked_at, description, counterparty, external_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tid, body.account_id, body.category_id || null, body.cost_center_id || null,
       body.direction || (body.amount >= 0 ? "inflow" : "outflow"),
       Math.abs(body.amount), body.currency_code || "BRL",
       body.booked_at || body.date || new Date().toISOString(),
       body.description || null, body.counterparty || null, body.external_id || null, body.notes || null]
    );
    return res.rows[0];
  });

  // ==================== UPLOAD / IMPORT SPREADSHEETS ====================

  router.post("/api/fin/upload", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.filePath || !body.accountId) throw { status: 400, message: "filePath and accountId required" };

    const ext = path.extname(body.filePath).toLowerCase();
    let rows = [];

    if (ext === ".csv") {
      const { parse } = require("csv-parse/sync");
      const content = fs.readFileSync(body.filePath, "utf-8");
      rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } else if (ext === ".xlsx" || ext === ".xls") {
      const XLSX = require("xlsx");
      const wb = XLSX.readFile(body.filePath);
      const sheet = wb.Sheets[body.sheet || wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    } else {
      throw { status: 400, message: "Unsupported format. Use .csv, .xlsx, or .xls" };
    }

    if (rows.length === 0) throw { status: 400, message: "No data rows found" };

    const mapping = body.mapping || {};
    const dateCol = mapping.date || Object.keys(rows[0]).find(k => /data|date/i.test(k)) || "date";
    const amountCol = mapping.amount || Object.keys(rows[0]).find(k => /valor|amount|value/i.test(k)) || "amount";
    const descCol = mapping.description || Object.keys(rows[0]).find(k => /descri|desc/i.test(k)) || "description";
    const counterpartyCol = mapping.counterparty || Object.keys(rows[0]).find(k => /benefici|counterparty|favorecido/i.test(k)) || null;

    const fileChecksum = crypto.createHash("sha256").update(fs.readFileSync(body.filePath)).digest("hex").slice(0, 32);

    const batchRes = await db.query(
      "INSERT INTO fin.ingestion_batches (tenant_id, source_system, source_descriptor, source_checksum, status) VALUES ($1,$2,$3,$4,'pending') RETURNING id",
      [tid, ext.replace(".", ""), body.filePath, fileChecksum]
    );
    const batchId = batchRes.rows[0].id;

    let imported = 0, errors = 0;
    const errorDetails = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const rawDate = row[dateCol];
        const rawAmount = row[amountCol];
        const desc = row[descCol] || "";
        const counterparty = counterpartyCol ? (row[counterpartyCol] || null) : null;

        if (!rawDate || rawAmount === undefined || rawAmount === "") {
          errors++; errorDetails.push({ row: i + 1, error: "Missing date or amount" }); continue;
        }

        let amount = typeof rawAmount === "number" ? rawAmount :
          parseFloat(String(rawAmount).replace(/\./g, "").replace(",", "."));
        if (isNaN(amount)) { errors++; errorDetails.push({ row: i + 1, error: `Invalid amount: ${rawAmount}` }); continue; }

        let dateVal = rawDate;
        if (typeof rawDate === "string" && rawDate.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
          const [d, m, y] = rawDate.split("/"); dateVal = `${y}-${m}-${d}`;
        }

        const direction = amount >= 0 ? "inflow" : "outflow";
        const rowHash = crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 32);

        await db.query(
          "INSERT INTO fin.raw_transactions (tenant_id, batch_id, row_data, row_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [tid, batchId, JSON.stringify(row), rowHash]
        );

        await db.query(
          `INSERT INTO fin.transactions (tenant_id, account_id, batch_id, direction, amount, currency_code, booked_at, description, counterparty)
           VALUES ($1,$2,$3,$4,$5,'BRL',$6,$7,$8)`,
          [tid, body.accountId, batchId, direction, Math.abs(amount), dateVal, desc, counterparty]
        );

        imported++;
      } catch (err) {
        errors++; errorDetails.push({ row: i + 1, error: err.message });
      }
    }

    await db.query("UPDATE fin.ingestion_batches SET status = $1, processed_at = now() WHERE id = $2",
      [errors > 0 && imported > 0 ? "partial" : errors > 0 ? "error" : "ok", batchId]);

    return { batchId, totalRows: rows.length, imported, errors, errorDetails: errorDetails.slice(0, 20) };
  });

  // ==================== FINANCIAL DASHBOARD / STATS ====================

  router.get("/api/fin/stats", async (req) => {
    const tid = await getTenantId(req);
    const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);

    const [totals, byCategory, byAccount, byCostCenter, monthly] = await Promise.all([
      db.query(`SELECT direction, count(*), sum(amount) as total FROM fin.transactions WHERE tenant_id = $1 AND booked_at BETWEEN $2 AND $3 AND deleted_at IS NULL GROUP BY direction`, [tid, from, to]),
      db.query(`SELECT c.name as category, c.category_kind, sum(t.amount) as total, count(*) FROM fin.transactions t LEFT JOIN fin.categories c ON t.category_id = c.id WHERE t.tenant_id = $1 AND t.booked_at BETWEEN $2 AND $3 AND t.deleted_at IS NULL GROUP BY c.name, c.category_kind ORDER BY sum(t.amount) DESC LIMIT 20`, [tid, from, to]),
      db.query(`SELECT a.account_name, sum(t.amount) as total, count(*) FROM fin.transactions t JOIN fin.accounts a ON t.account_id = a.id WHERE t.tenant_id = $1 AND t.booked_at BETWEEN $2 AND $3 AND t.deleted_at IS NULL GROUP BY a.account_name ORDER BY sum(t.amount) DESC`, [tid, from, to]),
      db.query(`SELECT cc.name, cc.code, sum(t.amount) as total, count(*) FROM fin.transactions t JOIN fin.cost_centers cc ON t.cost_center_id = cc.id WHERE t.tenant_id = $1 AND t.booked_at BETWEEN $2 AND $3 AND t.deleted_at IS NULL GROUP BY cc.name, cc.code ORDER BY sum(t.amount) DESC`, [tid, from, to]),
      db.query(`SELECT date_trunc('month', booked_at)::date as month, direction, sum(amount) as total, count(*) FROM fin.transactions WHERE tenant_id = $1 AND booked_at BETWEEN $2 AND $3 AND deleted_at IS NULL GROUP BY month, direction ORDER BY month`, [tid, from, to]),
    ]);

    const totalsMap = {};
    for (const r of totals.rows) totalsMap[r.direction] = { count: parseInt(r.count), total: parseFloat(r.total) };
    const credits = (totalsMap.inflow?.total || 0) + (totalsMap.credit?.total || 0);
    const debits = (totalsMap.outflow?.total || 0) + (totalsMap.debit?.total || 0);

    return {
      period: { from, to },
      totals: totalsMap,
      balance: credits - debits,
      byCategory: byCategory.rows,
      byAccount: byAccount.rows,
      byCostCenter: byCostCenter.rows,
      monthly: monthly.rows,
    };
  });

  router.get("/api/fin/batches", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query("SELECT * FROM fin.ingestion_batches WHERE tenant_id = $1 ORDER BY received_at DESC LIMIT 50", [tid]);
    return res.rows;
  });
}

module.exports = { registerFinRoutes };
