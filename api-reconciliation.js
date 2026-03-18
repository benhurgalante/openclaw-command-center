// api-reconciliation.js — Bank reconciliation endpoints
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

function registerReconciliationRoutes(router) {

  // ==================== STATEMENTS (EXTRATOS) ====================

  // GET /api/fin/statements — list bank statements
  router.get("/api/fin/statements", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `SELECT s.*, a.account_name,
        (SELECT count(*) FROM fin.statement_lines sl WHERE sl.statement_id = s.id AND sl.tenant_id = $1) as line_count,
        (SELECT count(*) FROM fin.statement_lines sl
         JOIN fin.reconciliations r ON r.line_id = sl.id AND r.tenant_id = $1
         WHERE sl.statement_id = s.id AND sl.tenant_id = $1) as reconciled_count
       FROM fin.statements s
       JOIN fin.accounts a ON s.account_id = a.id
       WHERE s.tenant_id = $1
       ORDER BY s.period_end DESC, s.created_at DESC`,
      [tid]
    );
    return res.rows;
  });

  // POST /api/fin/statements/upload — import bank statement from CSV/OFX
  router.post("/api/fin/statements/upload", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.accountId) throw { status: 400, message: "accountId required" };

    let lines = [];
    let openingBalance = parseFloat(body.openingBalance || 0);
    let closingBalance = parseFloat(body.closingBalance || 0);
    let periodStart = body.periodStart || null;
    let periodEnd = body.periodEnd || null;

    // Parse from filePath (CSV) or inline data
    if (body.filePath) {
      const ext = path.extname(body.filePath).toLowerCase();
      const content = fs.readFileSync(body.filePath, "utf-8");

      if (ext === ".csv") {
        const { parse } = require("csv-parse/sync");
        const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
        const mapping = body.mapping || {};
        const dateCol = mapping.date || Object.keys(rows[0] || {}).find(k => /data|date/i.test(k)) || "date";
        const amountCol = mapping.amount || Object.keys(rows[0] || {}).find(k => /valor|amount|value/i.test(k)) || "amount";
        const descCol = mapping.description || Object.keys(rows[0] || {}).find(k => /descri|desc|historico|hist/i.test(k)) || "description";
        const refCol = mapping.ref || Object.keys(rows[0] || {}).find(k => /doc|ref|numero|num/i.test(k)) || null;

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          let dateVal = row[dateCol] || "";
          if (dateVal.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
            const [d, m, y] = dateVal.split("/");
            dateVal = `${y}-${m}-${d}`;
          }
          let amount = typeof row[amountCol] === "number" ? row[amountCol] :
            parseFloat(String(row[amountCol] || "0").replace(/\./g, "").replace(",", "."));
          if (isNaN(amount)) continue;

          lines.push({
            occurred_at: dateVal,
            description: row[descCol] || "",
            amount: amount,
            external_ref: refCol ? (row[refCol] || null) : null,
          });
        }
      } else if (ext === ".ofx") {
        // Basic OFX parser
        const txnBlocks = content.split("<STMTTRN>").slice(1);
        for (const block of txnBlocks) {
          const get = (tag) => { const m = block.match(new RegExp(`<${tag}>([^<\\n]+)`)); return m ? m[1].trim() : null; };
          const dtposted = get("DTPOSTED");
          const trnamt = get("TRNAMT");
          const memo = get("MEMO") || get("NAME") || "";
          const fitid = get("FITID");
          if (!dtposted || !trnamt) continue;
          const dateStr = `${dtposted.slice(0, 4)}-${dtposted.slice(4, 6)}-${dtposted.slice(6, 8)}`;
          lines.push({
            occurred_at: dateStr,
            description: memo,
            amount: parseFloat(trnamt),
            external_ref: fitid,
          });
        }
        // Extract balances from OFX
        const balMatch = content.match(/<BALAMT>([^<\n]+)/);
        if (balMatch) closingBalance = parseFloat(balMatch[1]);
        const dtStart = content.match(/<DTSTART>(\d{8})/);
        const dtEnd = content.match(/<DTEND>(\d{8})/);
        if (dtStart) periodStart = `${dtStart[1].slice(0, 4)}-${dtStart[1].slice(4, 6)}-${dtStart[1].slice(6, 8)}`;
        if (dtEnd) periodEnd = `${dtEnd[1].slice(0, 4)}-${dtEnd[1].slice(4, 6)}-${dtEnd[1].slice(6, 8)}`;
      } else {
        throw { status: 400, message: "Formato nao suportado. Use .csv ou .ofx" };
      }
    } else if (body.lines && Array.isArray(body.lines)) {
      lines = body.lines;
    } else {
      throw { status: 400, message: "filePath or lines[] required" };
    }

    if (lines.length === 0) throw { status: 400, message: "No statement lines found" };

    // Auto-detect period
    if (!periodStart) periodStart = lines.reduce((min, l) => l.occurred_at < min ? l.occurred_at : min, lines[0].occurred_at);
    if (!periodEnd) periodEnd = lines.reduce((max, l) => l.occurred_at > max ? l.occurred_at : max, lines[0].occurred_at);

    // Calculate balance from lines if not provided
    if (!closingBalance && !body.closingBalance) {
      closingBalance = openingBalance + lines.reduce((sum, l) => sum + l.amount, 0);
    }

    // Get account currency
    const accRes = await db.query("SELECT currency_code FROM fin.accounts WHERE id = $1 AND tenant_id = $2", [body.accountId, tid]);
    const currency = accRes.rows[0]?.currency_code || "BRL";

    // Create statement
    const stmtRes = await db.query(
      `INSERT INTO fin.statements (tenant_id, account_id, period_start, period_end, opening_balance, closing_balance, currency_code, source_system, source_descriptor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [tid, body.accountId, periodStart, periodEnd, openingBalance, closingBalance, currency,
       body.source || "upload", body.filePath || "manual"]
    );
    const statementId = stmtRes.rows[0].id;

    // Insert statement lines
    let inserted = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      await db.query(
        `INSERT INTO fin.statement_lines (tenant_id, statement_id, line_no, occurred_at, description, amount, currency_code, external_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tid, statementId, i + 1, line.occurred_at, line.description, line.amount, currency, line.external_ref || null]
      );
      inserted++;
    }

    return { ok: true, statementId, periodStart, periodEnd, openingBalance, closingBalance, linesInserted: inserted };
  });

  // GET /api/fin/statements/:id/lines — get statement lines with reconciliation status
  router.get("/api/fin/statements/:id/lines", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `SELECT sl.*,
        r.id as recon_id, r.transaction_id as matched_txn_id, r.matched_amount, r.status as recon_status,
        t.description as txn_description, t.counterparty as txn_counterparty, t.amount as txn_amount, t.direction as txn_direction, t.booked_at as txn_date
       FROM fin.statement_lines sl
       LEFT JOIN fin.reconciliations r ON r.line_id = sl.id AND r.tenant_id = $1
       LEFT JOIN fin.transactions t ON r.transaction_id = t.id
       WHERE sl.statement_id = $2 AND sl.tenant_id = $1
       ORDER BY sl.line_no`,
      [tid, req.params.id]
    );
    return res.rows;
  });

  // DELETE /api/fin/statements/:id — delete statement and its lines
  router.delete("/api/fin/statements/:id", async (req) => {
    const tid = await getTenantId(req);
    await db.query("DELETE FROM fin.statements WHERE id = $1 AND tenant_id = $2", [req.params.id, tid]);
    return { ok: true, deleted: req.params.id };
  });

  // ==================== AUTO-MATCHING ====================

  // POST /api/fin/reconciliation/auto-match — automatically match statement lines to transactions
  router.post("/api/fin/reconciliation/auto-match", async (req, body) => {
    const tid = await getTenantId(req);
    const statementId = body.statementId;
    if (!statementId) throw { status: 400, message: "statementId required" };

    // Get statement info
    const stmt = await db.query("SELECT * FROM fin.statements WHERE id = $1 AND tenant_id = $2", [statementId, tid]);
    if (stmt.rows.length === 0) throw { status: 404, message: "Statement not found" };
    const statement = stmt.rows[0];

    // Get unreconciled statement lines
    const linesRes = await db.query(
      `SELECT sl.* FROM fin.statement_lines sl
       WHERE sl.statement_id = $1 AND sl.tenant_id = $2
         AND sl.id NOT IN (SELECT line_id FROM fin.reconciliations WHERE tenant_id = $2)
       ORDER BY sl.line_no`,
      [statementId, tid]
    );

    const tolerance = parseFloat(body.tolerance || 0.01); // cents tolerance
    const dateTolerance = parseInt(body.dateTolerance || 3); // days tolerance
    const matched = [];
    const unmatched = [];
    const alreadyUsedTxns = new Set();

    for (const line of linesRes.rows) {
      // Search for matching transactions by amount + date range
      const candidates = await db.query(
        `SELECT t.* FROM fin.transactions t
         WHERE t.tenant_id = $1
           AND t.account_id = $2
           AND t.deleted_at IS NULL
           AND ABS(t.amount - $3) <= $4
           AND t.booked_at BETWEEN ($5::date - $6 * interval '1 day') AND ($5::date + $6 * interval '1 day')
           AND t.reconciled_status = 'unreconciled'
           AND t.id NOT IN (SELECT transaction_id FROM fin.reconciliations WHERE tenant_id = $1)
         ORDER BY ABS(t.amount - $3), ABS(EXTRACT(epoch FROM t.booked_at - $5::timestamptz))
         LIMIT 5`,
        [tid, statement.account_id, Math.abs(line.amount), tolerance, line.occurred_at, dateTolerance]
      );

      // Score candidates
      let bestMatch = null;
      let bestScore = 0;

      for (const txn of candidates.rows) {
        if (alreadyUsedTxns.has(txn.id)) continue;

        let score = 0;

        // Exact amount match
        const amtDiff = Math.abs(parseFloat(txn.amount) - Math.abs(parseFloat(line.amount)));
        if (amtDiff === 0) score += 50;
        else if (amtDiff <= 0.01) score += 40;
        else score += Math.max(0, 30 - amtDiff * 10);

        // Date proximity (closer = better)
        const lineDate = new Date(line.occurred_at);
        const txnDate = new Date(txn.booked_at);
        const dayDiff = Math.abs((lineDate - txnDate) / 86400000);
        if (dayDiff === 0) score += 30;
        else if (dayDiff <= 1) score += 20;
        else score += Math.max(0, 15 - dayDiff * 3);

        // Direction match
        const lineDirection = line.amount >= 0 ? "inflow" : "outflow";
        if (txn.direction === lineDirection || txn.direction === (line.amount >= 0 ? "credit" : "debit")) {
          score += 10;
        }

        // Description similarity (simple word overlap)
        if (txn.description && line.description) {
          const txnWords = new Set(txn.description.toLowerCase().split(/\s+/).filter(w => w.length > 2));
          const lineWords = line.description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const overlap = lineWords.filter(w => txnWords.has(w)).length;
          score += Math.min(10, overlap * 3);
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = { ...txn, score };
        }
      }

      const minScore = parseFloat(body.minScore || 50);
      if (bestMatch && bestScore >= minScore) {
        alreadyUsedTxns.add(bestMatch.id);

        // Create reconciliation record
        await db.query(
          `INSERT INTO fin.reconciliations (tenant_id, transaction_id, line_id, matched_amount, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [tid, bestMatch.id, line.id, Math.abs(line.amount),
           Math.abs(parseFloat(bestMatch.amount) - Math.abs(parseFloat(line.amount))) <= tolerance ? "reconciled" : "partial"]
        );

        // Update transaction status
        await db.query(
          "UPDATE fin.transactions SET reconciled_status = 'reconciled', reconciled_amount = $1, reconciled_at = now() WHERE id = $2 AND tenant_id = $3",
          [Math.abs(line.amount), bestMatch.id, tid]
        );

        matched.push({
          lineNo: line.line_no,
          lineDesc: line.description,
          lineAmount: line.amount,
          lineDate: line.occurred_at,
          txnId: bestMatch.id,
          txnDesc: bestMatch.description,
          txnAmount: bestMatch.amount,
          txnDate: bestMatch.booked_at,
          score: bestScore,
        });
      } else {
        unmatched.push({
          lineNo: line.line_no,
          lineId: line.id,
          description: line.description,
          amount: line.amount,
          date: line.occurred_at,
          bestScore: bestScore,
          bestCandidate: bestMatch ? { id: bestMatch.id, description: bestMatch.description, amount: bestMatch.amount } : null,
        });
      }
    }

    return {
      ok: true,
      statementId,
      totalLines: linesRes.rows.length,
      matched: matched.length,
      unmatched: unmatched.length,
      matchRate: linesRes.rows.length > 0 ? Math.round(matched.length / linesRes.rows.length * 100) : 0,
      matchedDetails: matched,
      unmatchedDetails: unmatched,
    };
  });

  // ==================== MANUAL MATCHING ====================

  // POST /api/fin/reconciliation/match — manually match a statement line to a transaction
  router.post("/api/fin/reconciliation/match", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.lineId || !body.transactionId) throw { status: 400, message: "lineId and transactionId required" };

    // Get line amount
    const lineRes = await db.query("SELECT amount FROM fin.statement_lines WHERE id = $1 AND tenant_id = $2", [body.lineId, tid]);
    if (lineRes.rows.length === 0) throw { status: 404, message: "Statement line not found" };

    await db.query(
      `INSERT INTO fin.reconciliations (tenant_id, transaction_id, line_id, matched_amount, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, transaction_id, line_id) DO UPDATE SET matched_amount = $4, status = $5, matched_at = now()`,
      [tid, body.transactionId, body.lineId, Math.abs(lineRes.rows[0].amount), body.status || "reconciled"]
    );

    await db.query(
      "UPDATE fin.transactions SET reconciled_status = $1, reconciled_amount = $2, reconciled_at = now() WHERE id = $3 AND tenant_id = $4",
      [body.status || "reconciled", Math.abs(lineRes.rows[0].amount), body.transactionId, tid]
    );

    return { ok: true, matched: { lineId: body.lineId, transactionId: body.transactionId } };
  });

  // DELETE /api/fin/reconciliation/match — unmatch a reconciliation
  router.delete("/api/fin/reconciliation/match", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.lineId) throw { status: 400, message: "lineId required" };

    const recon = await db.query("SELECT transaction_id FROM fin.reconciliations WHERE line_id = $1 AND tenant_id = $2", [body.lineId, tid]);
    if (recon.rows.length > 0) {
      await db.query("UPDATE fin.transactions SET reconciled_status = 'unreconciled', reconciled_amount = NULL, reconciled_at = NULL WHERE id = $1 AND tenant_id = $2",
        [recon.rows[0].transaction_id, tid]);
    }
    await db.query("DELETE FROM fin.reconciliations WHERE line_id = $1 AND tenant_id = $2", [body.lineId, tid]);
    return { ok: true, unmatched: body.lineId };
  });

  // ==================== RECONCILIATION DASHBOARD ====================

  // GET /api/fin/reconciliation/summary — overview of reconciliation status
  router.get("/api/fin/reconciliation/summary", async (req) => {
    const tid = await getTenantId(req);

    const [statusCounts, byAccount, recentStatements, unreconciledTotal] = await Promise.all([
      db.query(
        `SELECT reconciled_status, count(*), sum(amount) as total
         FROM fin.transactions WHERE tenant_id = $1 AND deleted_at IS NULL
         GROUP BY reconciled_status`, [tid]),
      db.query(
        `SELECT a.account_name, a.id as account_id,
          count(*) FILTER (WHERE t.reconciled_status = 'reconciled') as reconciled,
          count(*) FILTER (WHERE t.reconciled_status = 'unreconciled') as unreconciled,
          count(*) FILTER (WHERE t.reconciled_status = 'mismatch') as mismatch,
          sum(t.amount) FILTER (WHERE t.reconciled_status = 'unreconciled') as unreconciled_amount
         FROM fin.transactions t
         JOIN fin.accounts a ON t.account_id = a.id
         WHERE t.tenant_id = $1 AND t.deleted_at IS NULL
         GROUP BY a.account_name, a.id
         ORDER BY unreconciled_amount DESC NULLS LAST`, [tid]),
      db.query(
        `SELECT s.*, a.account_name,
          (SELECT count(*) FROM fin.statement_lines sl WHERE sl.statement_id = s.id AND sl.tenant_id = $1) as total_lines,
          (SELECT count(*) FROM fin.statement_lines sl
           JOIN fin.reconciliations r ON r.line_id = sl.id AND r.tenant_id = $1
           WHERE sl.statement_id = s.id AND sl.tenant_id = $1) as matched_lines
         FROM fin.statements s
         JOIN fin.accounts a ON s.account_id = a.id
         WHERE s.tenant_id = $1
         ORDER BY s.period_end DESC LIMIT 10`, [tid]),
      db.query(
        `SELECT count(*), sum(amount) as total
         FROM fin.transactions
         WHERE tenant_id = $1 AND deleted_at IS NULL AND reconciled_status = 'unreconciled'`, [tid]),
    ]);

    const statusMap = {};
    for (const r of statusCounts.rows) {
      statusMap[r.reconciled_status] = { count: parseInt(r.count), total: parseFloat(r.total || 0) };
    }

    return {
      status: statusMap,
      unreconciledTotal: {
        count: parseInt(unreconciledTotal.rows[0]?.count || 0),
        amount: parseFloat(unreconciledTotal.rows[0]?.total || 0),
      },
      byAccount: byAccount.rows,
      recentStatements: recentStatements.rows.map(s => ({
        ...s,
        matchRate: s.total_lines > 0 ? Math.round(parseInt(s.matched_lines) / parseInt(s.total_lines) * 100) : 0,
      })),
    };
  });

  // GET /api/fin/reconciliation/unmatched — get unreconciled transactions for matching
  router.get("/api/fin/reconciliation/unmatched", async (req) => {
    const tid = await getTenantId(req);
    const accountId = req.query.account_id;
    const limit = Math.min(parseInt(req.query.limit || "50"), 200);

    let where = "t.tenant_id = $1 AND t.deleted_at IS NULL AND t.reconciled_status = 'unreconciled'";
    const params = [tid];
    if (accountId) { params.push(accountId); where += ` AND t.account_id = $${params.length}`; }

    const res = await db.query(
      `SELECT t.*, a.account_name
       FROM fin.transactions t
       JOIN fin.accounts a ON t.account_id = a.id
       WHERE ${where}
       ORDER BY t.booked_at DESC LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    return { items: res.rows, count: res.rows.length };
  });

  // POST /api/fin/reconciliation/find-candidates — find transaction candidates for a statement line
  router.post("/api/fin/reconciliation/find-candidates", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.lineId) throw { status: 400, message: "lineId required" };

    const lineRes = await db.query(
      `SELECT sl.*, s.account_id FROM fin.statement_lines sl
       JOIN fin.statements s ON sl.statement_id = s.id
       WHERE sl.id = $1 AND sl.tenant_id = $2`, [body.lineId, tid]);
    if (lineRes.rows.length === 0) throw { status: 404, message: "Line not found" };
    const line = lineRes.rows[0];

    const dateTol = parseInt(body.dateTolerance || 5);
    const candidates = await db.query(
      `SELECT t.*, a.account_name FROM fin.transactions t
       JOIN fin.accounts a ON t.account_id = a.id
       WHERE t.tenant_id = $1 AND t.account_id = $2 AND t.deleted_at IS NULL
         AND t.reconciled_status = 'unreconciled'
         AND t.booked_at BETWEEN ($3::date - $4 * interval '1 day') AND ($3::date + $4 * interval '1 day')
       ORDER BY ABS(t.amount - $5), ABS(EXTRACT(epoch FROM t.booked_at - $3::timestamptz))
       LIMIT 20`,
      [tid, line.account_id, line.occurred_at, dateTol, Math.abs(line.amount)]
    );

    return {
      line: { id: line.id, date: line.occurred_at, description: line.description, amount: line.amount },
      candidates: candidates.rows.map(t => ({
        ...t,
        amountDiff: Math.abs(parseFloat(t.amount) - Math.abs(parseFloat(line.amount))),
        dateDiff: Math.round(Math.abs(new Date(t.booked_at) - new Date(line.occurred_at)) / 86400000),
      })),
    };
  });
}

module.exports = { registerReconciliationRoutes };
