// api-data-unifier.js — Data Unifier (Coletor de Dados Multi-Sistema)
// Collects, normalizes, and unifies data from multiple external systems
const db = require("./db");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

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

// ==================== SCHEMA INIT ====================

async function ensureSchema() {
  const client = await db.pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS core.data_sources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        name TEXT NOT NULL,
        system_type TEXT NOT NULL DEFAULT 'custom',
        source_type TEXT NOT NULL DEFAULT 'api',
        description TEXT,
        config JSONB NOT NULL DEFAULT '{}',
        normalization_rules JSONB NOT NULL DEFAULT '{}',
        playbook_id TEXT,
        schedule_cron TEXT,
        last_collection_at TIMESTAMPTZ,
        last_status TEXT DEFAULT 'pending',
        last_error TEXT,
        total_collections INTEGER DEFAULT 0,
        total_records INTEGER DEFAULT 0,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS core.collection_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        source_id UUID NOT NULL REFERENCES core.data_sources(id) ON DELETE CASCADE,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        status TEXT DEFAULT 'running',
        records_collected INTEGER DEFAULT 0,
        records_normalized INTEGER DEFAULT 0,
        records_deduplicated INTEGER DEFAULT 0,
        error TEXT,
        metadata JSONB DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS core.collected_data (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        source_id UUID NOT NULL REFERENCES core.data_sources(id) ON DELETE CASCADE,
        run_id UUID REFERENCES core.collection_runs(id) ON DELETE SET NULL,
        data_type TEXT NOT NULL DEFAULT 'record',
        raw_data JSONB NOT NULL,
        normalized_data JSONB,
        dedup_hash TEXT,
        status TEXT DEFAULT 'raw',
        collected_at TIMESTAMPTZ DEFAULT NOW(),
        normalized_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_collected_data_source ON core.collected_data(source_id);
      CREATE INDEX IF NOT EXISTS idx_collected_data_dedup ON core.collected_data(dedup_hash);
      CREATE INDEX IF NOT EXISTS idx_collected_data_type ON core.collected_data(data_type);
      CREATE INDEX IF NOT EXISTS idx_collection_runs_source ON core.collection_runs(source_id);
    `);
  } finally {
    client.release();
  }
}

// ==================== NORMALIZATION ENGINE ====================

function normalizeRecord(raw, rules) {
  if (!rules || Object.keys(rules).length === 0) return raw;
  const normalized = {};

  // Column mapping: { "Nome Completo": "name", "Data Nasc.": "birth_date" }
  const mapping = rules.columnMapping || {};

  for (const [key, value] of Object.entries(raw)) {
    const targetKey = mapping[key] || key;
    let val = value;

    // Date normalization
    if (rules.dateColumns && rules.dateColumns.includes(targetKey)) {
      val = normalizeDate(val);
    }

    // Currency normalization (pt-BR: 1.234,56 → 1234.56)
    if (rules.currencyColumns && rules.currencyColumns.includes(targetKey)) {
      val = normalizeCurrency(val);
    }

    // Text normalization
    if (rules.textColumns && rules.textColumns.includes(targetKey)) {
      val = normalizeText(val);
    }

    // Phone normalization
    if (rules.phoneColumns && rules.phoneColumns.includes(targetKey)) {
      val = normalizePhone(val);
    }

    // CPF/CNPJ normalization
    if (rules.docColumns && rules.docColumns.includes(targetKey)) {
      val = normalizeDocument(val);
    }

    normalized[targetKey] = val;
  }

  // Computed fields
  if (rules.computedFields) {
    for (const [field, expr] of Object.entries(rules.computedFields)) {
      try {
        // Simple template: "${first_name} ${last_name}"
        normalized[field] = expr.replace(/\$\{(\w+)\}/g, (_, k) => normalized[k] || "");
      } catch { /* skip */ }
    }
  }

  return normalized;
}

function normalizeDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  // dd/mm/yyyy or dd-mm-yyyy
  const brMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (brMatch) return `${brMatch[3]}-${brMatch[2].padStart(2, "0")}-${brMatch[1].padStart(2, "0")}`;
  // yyyy-mm-dd already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // mm/dd/yyyy (US)
  const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch && parseInt(usMatch[1]) > 12) return `${usMatch[3]}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
  // Try Date parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}

function normalizeCurrency(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim().replace(/[R$\s]/g, "");
  // pt-BR: 1.234,56
  if (/^\-?\d{1,3}(\.\d{3})*,\d{2}$/.test(s)) {
    return parseFloat(s.replace(/\./g, "").replace(",", "."));
  }
  // en-US: 1,234.56
  if (/^\-?\d{1,3}(,\d{3})*\.\d{2}$/.test(s)) {
    return parseFloat(s.replace(/,/g, ""));
  }
  const n = parseFloat(s.replace(/,/g, "."));
  return isNaN(n) ? val : n;
}

function normalizeText(val) {
  if (!val) return val;
  return String(val).trim().replace(/\s+/g, " ");
}

function normalizePhone(val) {
  if (!val) return null;
  const digits = String(val).replace(/\D/g, "");
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  if (digits.length === 13 && digits.startsWith("55")) return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  return val;
}

function normalizeDocument(val) {
  if (!val) return null;
  const digits = String(val).replace(/\D/g, "");
  if (digits.length === 11) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  if (digits.length === 14) return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
  return val;
}

function computeDedupHash(record, dedupKeys) {
  if (!dedupKeys || dedupKeys.length === 0) return null;
  const vals = dedupKeys.map(k => String(record[k] || "").toLowerCase().trim()).join("|");
  return crypto.createHash("sha256").update(vals).digest("hex").slice(0, 16);
}

// ==================== COLLECTION EXECUTORS ====================

async function collectFromAPI(source) {
  const cfg = source.config;
  if (!cfg.url) throw new Error("config.url required for API source");

  return new Promise((resolve, reject) => {
    const url = new URL(cfg.url);
    const mod = url.protocol === "https:" ? https : http;
    const headers = { ...(cfg.headers || {}) };
    if (cfg.authToken) headers["Authorization"] = `Bearer ${cfg.authToken}`;
    if (cfg.apiKey) headers["X-API-Key"] = cfg.apiKey;

    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: cfg.method || "GET",
      headers,
      timeout: 30000,
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          // Support nested data path: "data.results" -> data.data.results
          let records = data;
          if (cfg.dataPath) {
            for (const key of cfg.dataPath.split(".")) {
              records = records?.[key];
            }
          }
          if (!Array.isArray(records)) records = [records];
          resolve(records);
        } catch {
          resolve([{ raw_response: body }]);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("API timeout")); });
    if (cfg.body) req.write(typeof cfg.body === "string" ? cfg.body : JSON.stringify(cfg.body));
    req.end();
  });
}

function collectFromCSV(source) {
  const cfg = source.config;
  if (!cfg.filePath) throw new Error("config.filePath required for CSV source");
  const content = fs.readFileSync(cfg.filePath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  const sep = cfg.separator || (content.includes(";") ? ";" : ",");
  const headers = lines[0].split(sep).map(h => h.trim().replace(/^["']|["']$/g, ""));
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(sep).map(v => v.trim().replace(/^["']|["']$/g, ""));
    const record = {};
    headers.forEach((h, j) => { record[h] = vals[j] || ""; });
    records.push(record);
  }
  return records;
}

async function collectFromPlaybook(source) {
  // Run a playbook and collect the extracted data
  const cfg = source.config;
  const operatorDir = path.join(require("os").homedir(), ".openclaw/workspace-operator");
  const { getPlaybook, compilePlaybook } = require(path.join(operatorDir, "playbook-engine"));
  const { sendCommand, ensureBrowser, isRunning } = require(path.join(operatorDir, "operator-client"));

  const pb = getPlaybook(source.playbook_id || cfg.playbookId);
  if (!pb) throw new Error(`Playbook ${source.playbook_id || cfg.playbookId} not found`);

  const vars = cfg.vars || {};
  const steps = compilePlaybook(pb, vars);

  if (!isRunning() && pb.system) {
    await ensureBrowser(pb.system);
  }

  const extractedData = [];
  for (const step of steps) {
    if (step.wait) await new Promise(r => setTimeout(r, step.wait));
    const result = await sendCommand(step.command, step.args || []);
    // Collect extracted data from extract/extract-table commands
    if (step.command === "extract-table" && result.data) {
      extractedData.push(...(Array.isArray(result.data) ? result.data : [result.data]));
    } else if (step.command === "extract" && result.data) {
      extractedData.push({ value: result.data, label: step.label || step.args?.[0] });
    }
  }
  return extractedData;
}

function collectFromJSON(source) {
  const cfg = source.config;
  if (cfg.data && Array.isArray(cfg.data)) return cfg.data;
  if (cfg.filePath) {
    const content = fs.readFileSync(cfg.filePath, "utf-8");
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [data];
  }
  throw new Error("config.data[] or config.filePath required for JSON source");
}

// ==================== XLSX COLLECTOR ====================

function collectFromXLSX(filePath, cfg = {}) {
  const XLSX = require("xlsx");
  const workbook = XLSX.readFile(filePath, { type: "file", cellDates: true });
  const sheetName = cfg.sheet || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found in ${filePath}`);

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  return rows;
}

// ==================== PDF COLLECTOR ====================

async function collectFromPDF(filePath, cfg = {}) {
  const pdfParse = require("pdf-parse");
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  const text = data.text;

  // Try to detect tabular data in PDF
  const lines = text.split("\n").filter(l => l.trim());

  if (cfg.mode === "raw" || cfg.mode === "text") {
    // Return raw text blocks (for unstructured PDFs)
    return lines.filter(l => l.trim().length > 3).map((line, i) => ({
      _line_no: i + 1,
      _raw_text: line.trim(),
      _source_file: path.basename(filePath),
    }));
  }

  // Auto-detect: try tabular extraction
  // Strategy: find lines with consistent separators (tabs, multiple spaces, pipes)
  const tabular = tryExtractTable(lines, cfg);
  if (tabular && tabular.length > 0) return tabular;

  // Fallback: key-value extraction (common in cadastro PDFs)
  const keyValues = tryExtractKeyValues(lines);
  if (keyValues && Object.keys(keyValues).length > 2) return [keyValues];

  // Final fallback: raw lines
  return lines.filter(l => l.trim().length > 3).map((line, i) => ({
    _line_no: i + 1,
    _raw_text: line.trim(),
    _source_file: path.basename(filePath),
  }));
}

function tryExtractTable(lines, cfg = {}) {
  // Detect separator: tab, pipe, or multiple spaces (3+)
  const separators = [
    { name: "tab", regex: /\t/, split: /\t/ },
    { name: "pipe", regex: /\|/, split: /\s*\|\s*/ },
    { name: "semicolon", regex: /;/, split: /\s*;\s*/ },
    { name: "spaces", regex: /\s{3,}/, split: /\s{3,}/ },
  ];

  for (const sep of separators) {
    // Count lines matching this separator
    const matching = lines.filter(l => sep.regex.test(l));
    if (matching.length < 3) continue; // Need at least header + 2 data rows

    // First matching line is header
    const headerIdx = lines.findIndex(l => sep.regex.test(l));
    const headerLine = lines[headerIdx];
    const headers = headerLine.split(sep.split).map(h => h.trim()).filter(Boolean);
    if (headers.length < 2) continue;

    const records = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (!sep.regex.test(lines[i])) continue;
      const vals = lines[i].split(sep.split).map(v => v.trim());
      if (vals.filter(Boolean).length < 2) continue;
      const record = {};
      headers.forEach((h, j) => { record[h] = vals[j] || ""; });
      record._source_file = cfg._fileName || "";
      records.push(record);
    }

    if (records.length > 0) return records;
  }

  return null;
}

function tryExtractKeyValues(lines) {
  // Detect patterns like "Campo: Valor" or "Campo     Valor"
  const result = {};
  let kvCount = 0;

  for (const line of lines) {
    // Pattern: "Key: Value"
    const colonMatch = line.match(/^([^:]{2,40}):\s+(.+)$/);
    if (colonMatch) {
      const key = colonMatch[1].trim();
      const val = colonMatch[2].trim();
      if (key && val && !/^[\d\s\-\/]+$/.test(key)) {
        result[key] = val;
        kvCount++;
      }
    }
  }

  return kvCount >= 2 ? result : null;
}

// ==================== DIRECTORY SCANNER ====================

function scanDirectory(dirPath, cfg = {}) {
  const extensions = cfg.extensions || [".csv", ".xlsx", ".xls", ".pdf", ".json"];
  const recursive = cfg.recursive !== false;
  const files = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && recursive) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          const stat = fs.statSync(fullPath);
          files.push({
            path: fullPath,
            name: entry.name,
            ext,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            dir: path.dirname(fullPath).replace(dirPath, "").replace(/^[\/\\]/, "") || "/",
          });
        }
      }
    }
  }

  walk(dirPath);
  return files.sort((a, b) => b.modified.localeCompare(a.modified));
}

async function collectFromDirectory(source) {
  const cfg = source.config;
  if (!cfg.directoryPath) throw new Error("config.directoryPath required for directory source");

  if (!fs.existsSync(cfg.directoryPath)) {
    throw new Error(`Directory not found: ${cfg.directoryPath}. Se e uma pasta Windows, verifique se o mount SMB esta ativo.`);
  }

  const files = scanDirectory(cfg.directoryPath, {
    extensions: cfg.extensions || [".csv", ".xlsx", ".xls", ".pdf", ".json"],
    recursive: cfg.recursive !== false,
  });

  // Filter by modification date if tracking processed files
  const processedFile = path.join(require("os").homedir(), ".openclaw/agent-chats/.unifier-processed.json");
  let processed = {};
  try { processed = JSON.parse(fs.readFileSync(processedFile, "utf-8")); } catch { }
  const sourceProcessed = processed[source.id] || {};

  // Filter: only new or modified files
  const newFiles = cfg.forceAll ? files : files.filter(f => {
    const prev = sourceProcessed[f.path];
    return !prev || prev !== f.modified;
  });

  if (newFiles.length === 0) return [];

  const allRecords = [];

  for (const file of newFiles) {
    try {
      let records = [];
      const fileCfg = { ...cfg, _fileName: file.name };

      switch (file.ext) {
        case ".csv":
          records = collectFromCSV({ config: { filePath: file.path, separator: cfg.separator } });
          break;
        case ".xlsx":
        case ".xls":
          records = collectFromXLSX(file.path, fileCfg);
          break;
        case ".pdf":
          records = await collectFromPDF(file.path, fileCfg);
          break;
        case ".json":
          records = collectFromJSON({ config: { filePath: file.path } });
          break;
      }

      // Tag each record with source file info
      for (const rec of records) {
        rec._source_file = file.name;
        rec._source_dir = file.dir;
        rec._file_modified = file.modified;
      }

      allRecords.push(...records);

      // Mark as processed
      sourceProcessed[file.path] = file.modified;
    } catch (err) {
      console.error(`[DataUnifier] Error processing ${file.path}:`, err.message);
      // Continue with other files
      allRecords.push({
        _source_file: file.name,
        _error: err.message,
        _source_dir: file.dir,
      });
    }
  }

  // Save processed state
  processed[source.id] = sourceProcessed;
  try { fs.writeFileSync(processedFile, JSON.stringify(processed, null, 2)); } catch { }

  return allRecords;
}

// ==================== SCHEDULER ====================

let _schedulerTimer = null;
const _lastRun = new Map();

function startUnifierScheduler() {
  if (_schedulerTimer) return;
  _schedulerTimer = setInterval(async () => {
    try {
      const res = await db.pool.query(
        "SELECT * FROM core.data_sources WHERE enabled = true AND schedule_cron IS NOT NULL"
      );
      const now = new Date();
      for (const source of res.rows) {
        const lastRun = _lastRun.get(source.id) || source.last_collection_at;
        if (shouldRunCron(source.schedule_cron, lastRun, now)) {
          _lastRun.set(source.id, now);
          executeCollection(source.id, source.tenant_id).catch(err => {
            console.error(`[DataUnifier] Scheduled collection failed for ${source.name}:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error("[DataUnifier] Scheduler error:", err.message);
    }
  }, 60000); // Check every minute
}

function shouldRunCron(cron, lastRun, now) {
  // Simple cron support: "every Xm", "every Xh", "daily HH:MM"
  if (!cron) return false;
  const elapsed = lastRun ? (now - new Date(lastRun)) : Infinity;

  const everyM = cron.match(/^every\s+(\d+)\s*m$/i);
  if (everyM) return elapsed >= parseInt(everyM[1]) * 60000;

  const everyH = cron.match(/^every\s+(\d+)\s*h$/i);
  if (everyH) return elapsed >= parseInt(everyH[1]) * 3600000;

  const daily = cron.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (daily) {
    const targetH = parseInt(daily[1]), targetM = parseInt(daily[2]);
    if (now.getHours() === targetH && now.getMinutes() === targetM && elapsed >= 60000) return true;
  }

  return false;
}

// ==================== CORE COLLECTION LOGIC ====================

async function executeCollection(sourceId, tenantId) {
  db.setActiveTenant(tenantId);

  const srcRes = await db.query("SELECT * FROM core.data_sources WHERE id = $1 AND tenant_id = $2", [sourceId, tenantId]);
  if (srcRes.rows.length === 0) throw new Error("Source not found");
  const source = srcRes.rows[0];

  // Create collection run
  const runRes = await db.query(
    "INSERT INTO core.collection_runs (tenant_id, source_id) VALUES ($1, $2) RETURNING *",
    [tenantId, sourceId]
  );
  const run = runRes.rows[0];

  try {
    // Step 1: Collect raw data
    let rawRecords = [];
    switch (source.source_type) {
      case "api": rawRecords = await collectFromAPI(source); break;
      case "csv": rawRecords = collectFromCSV(source); break;
      case "json": rawRecords = collectFromJSON(source); break;
      case "playbook": rawRecords = await collectFromPlaybook(source); break;
      case "directory": rawRecords = await collectFromDirectory(source); break;
      case "xlsx": rawRecords = collectFromXLSX(source.config.filePath, source.config); break;
      case "pdf": rawRecords = await collectFromPDF(source.config.filePath, source.config); break;
      default: throw new Error(`Unknown source_type: ${source.source_type}`);
    }

    const rules = source.normalization_rules || {};
    const dedupKeys = rules.dedupKeys || [];
    let normalizedCount = 0;
    let dedupCount = 0;

    // Step 2: Normalize and deduplicate
    for (const raw of rawRecords) {
      const normalized = normalizeRecord(raw, rules);
      const hash = computeDedupHash(normalized, dedupKeys);

      // Check dedup
      if (hash) {
        const existing = await db.query(
          "SELECT id FROM core.collected_data WHERE source_id = $1 AND dedup_hash = $2 AND tenant_id = $3 LIMIT 1",
          [sourceId, hash, tenantId]
        );
        if (existing.rows.length > 0) {
          dedupCount++;
          continue;
        }
      }

      await db.query(
        `INSERT INTO core.collected_data (tenant_id, source_id, run_id, data_type, raw_data, normalized_data, dedup_hash, status, normalized_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [tenantId, sourceId, run.id, source.system_type, raw, normalized, hash, "normalized"]
      );
      normalizedCount++;
    }

    // Step 3: Update run and source stats
    await db.query(
      `UPDATE core.collection_runs SET finished_at = NOW(), status = 'success',
       records_collected = $1, records_normalized = $2, records_deduplicated = $3
       WHERE id = $4`,
      [rawRecords.length, normalizedCount, dedupCount, run.id]
    );

    await db.query(
      `UPDATE core.data_sources SET last_collection_at = NOW(), last_status = 'success', last_error = NULL,
       total_collections = total_collections + 1, total_records = total_records + $1, updated_at = NOW()
       WHERE id = $2`,
      [normalizedCount, sourceId]
    );

    return { success: true, collected: rawRecords.length, normalized: normalizedCount, deduplicated: dedupCount, runId: run.id };

  } catch (err) {
    await db.query(
      "UPDATE core.collection_runs SET finished_at = NOW(), status = 'error', error = $1 WHERE id = $2",
      [err.message, run.id]
    );
    await db.query(
      "UPDATE core.data_sources SET last_status = 'error', last_error = $1, updated_at = NOW() WHERE id = $2",
      [err.message, sourceId]
    );
    throw err;
  }
}

// ==================== ROUTE REGISTRATION ====================

function registerDataUnifierRoutes(router) {

  // Ensure schema on first load
  ensureSchema().catch(err => console.error("[DataUnifier] Schema init error:", err.message));

  // GET /api/unifier/sources — list all data sources
  router.get("/api/unifier/sources", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `SELECT id, name, system_type, source_type, description, schedule_cron, playbook_id,
              last_collection_at, last_status, last_error, total_collections, total_records, enabled, created_at
       FROM core.data_sources WHERE tenant_id = $1 ORDER BY updated_at DESC`,
      [tid]
    );
    return res.rows;
  });

  // POST /api/unifier/sources — create data source
  router.post("/api/unifier/sources", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.name) throw { status: 400, message: "name required" };
    if (!body.sourceType) throw { status: 400, message: "sourceType required (api, csv, json, playbook)" };

    const res = await db.query(
      `INSERT INTO core.data_sources (tenant_id, name, system_type, source_type, description, config, normalization_rules, playbook_id, schedule_cron, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        tid,
        body.name,
        body.systemType || "custom",
        body.sourceType,
        body.description || null,
        body.config || {},
        body.normalizationRules || {},
        body.playbookId || null,
        body.scheduleCron || null,
        body.enabled !== false,
      ]
    );
    return res.rows[0];
  });

  // GET /api/unifier/sources/:id — get source details
  router.get("/api/unifier/sources/:id", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      "SELECT * FROM core.data_sources WHERE id = $1 AND tenant_id = $2",
      [req.params.id, tid]
    );
    if (res.rows.length === 0) throw { status: 404, message: "Source not found" };

    // Get recent runs
    const runs = await db.query(
      `SELECT id, started_at, finished_at, status, records_collected, records_normalized, records_deduplicated, error
       FROM core.collection_runs WHERE source_id = $1 AND tenant_id = $2 ORDER BY started_at DESC LIMIT 10`,
      [req.params.id, tid]
    );

    return { ...res.rows[0], recentRuns: runs.rows };
  });

  // PATCH /api/unifier/sources/:id — update data source
  router.patch("/api/unifier/sources/:id", async (req, body) => {
    const tid = await getTenantId(req);
    const fields = [];
    const vals = [req.params.id, tid];
    let idx = 3;

    for (const [key, col] of [
      ["name", "name"], ["description", "description"], ["systemType", "system_type"],
      ["sourceType", "source_type"], ["config", "config"], ["normalizationRules", "normalization_rules"],
      ["playbookId", "playbook_id"], ["scheduleCron", "schedule_cron"], ["enabled", "enabled"],
    ]) {
      if (body[key] !== undefined) {
        fields.push(`${col} = $${idx}`);
        vals.push(key === "config" || key === "normalizationRules" ? body[key] : body[key]);
        idx++;
      }
    }

    if (fields.length === 0) throw { status: 400, message: "No fields to update" };
    fields.push("updated_at = NOW()");

    const res = await db.query(
      `UPDATE core.data_sources SET ${fields.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      vals
    );
    if (res.rows.length === 0) throw { status: 404, message: "Source not found" };
    return res.rows[0];
  });

  // DELETE /api/unifier/sources/:id — delete data source and all its data
  router.delete("/api/unifier/sources/:id", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      "DELETE FROM core.data_sources WHERE id = $1 AND tenant_id = $2 RETURNING id, name",
      [req.params.id, tid]
    );
    if (res.rows.length === 0) throw { status: 404, message: "Source not found" };
    return { ok: true, deleted: res.rows[0] };
  });

  // POST /api/unifier/sources/:id/collect — trigger collection now
  router.post("/api/unifier/sources/:id/collect", async (req) => {
    const tid = await getTenantId(req);
    const result = await executeCollection(req.params.id, tid);
    return result;
  });

  // GET /api/unifier/sources/:id/data — get collected data for a source
  router.get("/api/unifier/sources/:id/data", async (req) => {
    const tid = await getTenantId(req);
    const q = req.query || {};
    const limit = Math.min(parseInt(q.limit || "100"), 500);
    const offset = parseInt(q.offset || "0");
    const view = q.view || "normalized"; // "raw" or "normalized"

    const res = await db.query(
      `SELECT id, data_type, ${view === "raw" ? "raw_data" : "normalized_data"} as data, status, collected_at
       FROM core.collected_data WHERE source_id = $1 AND tenant_id = $2
       ORDER BY collected_at DESC LIMIT $3 OFFSET $4`,
      [req.params.id, tid, limit, offset]
    );

    const countRes = await db.query(
      "SELECT count(*) as total FROM core.collected_data WHERE source_id = $1 AND tenant_id = $2",
      [req.params.id, tid]
    );

    return { data: res.rows, total: parseInt(countRes.rows[0].total), limit, offset };
  });

  // GET /api/unifier/sources/:id/runs — get collection history
  router.get("/api/unifier/sources/:id/runs", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `SELECT * FROM core.collection_runs WHERE source_id = $1 AND tenant_id = $2 ORDER BY started_at DESC LIMIT 50`,
      [req.params.id, tid]
    );
    return res.rows;
  });

  // POST /api/unifier/sources/:id/upload — manual data upload (CSV/JSON inline)
  router.post("/api/unifier/sources/:id/upload", async (req, body) => {
    const tid = await getTenantId(req);
    const srcRes = await db.query("SELECT * FROM core.data_sources WHERE id = $1 AND tenant_id = $2", [req.params.id, tid]);
    if (srcRes.rows.length === 0) throw { status: 404, message: "Source not found" };
    const source = srcRes.rows[0];

    let records = [];
    if (body.records && Array.isArray(body.records)) {
      records = body.records;
    } else if (body.csv) {
      // Parse inline CSV
      const lines = body.csv.split("\n").filter(l => l.trim());
      if (lines.length < 2) throw { status: 400, message: "CSV must have header + data" };
      const sep = body.separator || (body.csv.includes(";") ? ";" : ",");
      const headers = lines[0].split(sep).map(h => h.trim().replace(/^["']|["']$/g, ""));
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(sep).map(v => v.trim().replace(/^["']|["']$/g, ""));
        const rec = {};
        headers.forEach((h, j) => { rec[h] = vals[j] || ""; });
        records.push(rec);
      }
    } else {
      throw { status: 400, message: "records[] or csv required" };
    }

    // Create run
    const runRes = await db.query(
      "INSERT INTO core.collection_runs (tenant_id, source_id, metadata) VALUES ($1, $2, $3) RETURNING *",
      [tid, req.params.id, { method: "manual_upload", recordCount: records.length }]
    );
    const run = runRes.rows[0];

    const rules = source.normalization_rules || {};
    const dedupKeys = rules.dedupKeys || [];
    let normalizedCount = 0, dedupCount = 0;

    for (const raw of records) {
      const normalized = normalizeRecord(raw, rules);
      const hash = computeDedupHash(normalized, dedupKeys);

      if (hash) {
        const existing = await db.query(
          "SELECT id FROM core.collected_data WHERE source_id = $1 AND dedup_hash = $2 AND tenant_id = $3 LIMIT 1",
          [req.params.id, hash, tid]
        );
        if (existing.rows.length > 0) { dedupCount++; continue; }
      }

      await db.query(
        `INSERT INTO core.collected_data (tenant_id, source_id, run_id, data_type, raw_data, normalized_data, dedup_hash, status, normalized_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'normalized', NOW())`,
        [tid, req.params.id, run.id, source.system_type, raw, normalized, hash]
      );
      normalizedCount++;
    }

    await db.query(
      `UPDATE core.collection_runs SET finished_at = NOW(), status = 'success',
       records_collected = $1, records_normalized = $2, records_deduplicated = $3 WHERE id = $4`,
      [records.length, normalizedCount, dedupCount, run.id]
    );

    await db.query(
      `UPDATE core.data_sources SET last_collection_at = NOW(), last_status = 'success', last_error = NULL,
       total_collections = total_collections + 1, total_records = total_records + $1, updated_at = NOW() WHERE id = $2`,
      [normalizedCount, req.params.id]
    );

    return { ok: true, uploaded: records.length, normalized: normalizedCount, deduplicated: dedupCount };
  });

  // GET /api/unifier/dashboard — overview stats
  router.get("/api/unifier/dashboard", async (req) => {
    const tid = await getTenantId(req);

    const sources = await db.query(
      "SELECT count(*) as total, count(*) FILTER (WHERE enabled) as active, count(*) FILTER (WHERE last_status = 'error') as errors FROM core.data_sources WHERE tenant_id = $1",
      [tid]
    );

    const data = await db.query(
      "SELECT count(*) as total_records FROM core.collected_data WHERE tenant_id = $1",
      [tid]
    );

    const runs = await db.query(
      `SELECT count(*) as total_runs,
              count(*) FILTER (WHERE status = 'success') as successful,
              count(*) FILTER (WHERE status = 'error') as failed,
              max(finished_at) as last_run
       FROM core.collection_runs WHERE tenant_id = $1`,
      [tid]
    );

    const recentRuns = await db.query(
      `SELECT cr.*, ds.name as source_name
       FROM core.collection_runs cr
       JOIN core.data_sources ds ON cr.source_id = ds.id
       WHERE cr.tenant_id = $1
       ORDER BY cr.started_at DESC LIMIT 10`,
      [tid]
    );

    const bySystem = await db.query(
      `SELECT system_type, count(*) as sources, sum(total_records) as records
       FROM core.data_sources WHERE tenant_id = $1 GROUP BY system_type ORDER BY records DESC`,
      [tid]
    );

    return {
      sources: sources.rows[0],
      data: data.rows[0],
      runs: runs.rows[0],
      recentRuns: recentRuns.rows,
      bySystem: bySystem.rows,
    };
  });

  // GET /api/unifier/search — search across all collected data
  router.get("/api/unifier/search", async (req) => {
    const tid = await getTenantId(req);
    const q = req.query || {};
    if (!q.q) throw { status: 400, message: "q (search query) required" };

    const limit = Math.min(parseInt(q.limit || "50"), 200);
    const res = await db.query(
      `SELECT cd.id, cd.source_id, cd.data_type, cd.normalized_data as data, cd.collected_at, ds.name as source_name
       FROM core.collected_data cd
       JOIN core.data_sources ds ON cd.source_id = ds.id
       WHERE cd.tenant_id = $1 AND cd.normalized_data::text ILIKE $2
       ORDER BY cd.collected_at DESC LIMIT $3`,
      [tid, `%${q.q}%`, limit]
    );
    return { results: res.rows, query: q.q, count: res.rows.length };
  });

  // GET /api/unifier/templates — predefined source templates
  router.get("/api/unifier/templates", async () => {
    return [
      {
        id: "erp-csv",
        name: "ERP — Exportacao CSV",
        systemType: "erp",
        sourceType: "csv",
        description: "Importa dados de ERP via arquivo CSV exportado",
        config: { filePath: "", separator: ";" },
        normalizationRules: {
          dateColumns: ["data", "date", "dt_emissao", "dt_vencimento"],
          currencyColumns: ["valor", "amount", "total", "saldo"],
          textColumns: ["descricao", "historico", "obs"],
          docColumns: ["cpf", "cnpj", "documento"],
        },
      },
      {
        id: "bank-api",
        name: "Banco — API Open Banking",
        systemType: "bank",
        sourceType: "api",
        description: "Coleta extrato via API bancaria (Open Banking)",
        config: { url: "", authToken: "", dataPath: "data.transactions", method: "GET" },
        normalizationRules: {
          dateColumns: ["date", "data"],
          currencyColumns: ["amount", "valor"],
          columnMapping: { "transactionDate": "data", "transactionAmount": "valor", "transactionDescription": "descricao" },
        },
      },
      {
        id: "ecommerce-api",
        name: "E-commerce — API Pedidos",
        systemType: "ecommerce",
        sourceType: "api",
        description: "Coleta pedidos de plataforma e-commerce",
        config: { url: "", apiKey: "", dataPath: "orders", method: "GET" },
        normalizationRules: {
          dateColumns: ["created_at", "updated_at"],
          currencyColumns: ["total", "subtotal", "shipping"],
          dedupKeys: ["order_id"],
        },
      },
      {
        id: "crm-playbook",
        name: "CRM Web — Playbook Scraper",
        systemType: "crm",
        sourceType: "playbook",
        description: "Coleta dados de CRM web via playbook de automacao",
        config: { playbookId: "" },
        normalizationRules: {
          phoneColumns: ["telefone", "phone"],
          docColumns: ["cpf", "cnpj"],
          textColumns: ["nome", "empresa", "email"],
          dedupKeys: ["email"],
        },
      },
      {
        id: "spreadsheet-csv",
        name: "Planilha — CSV/Excel",
        systemType: "spreadsheet",
        sourceType: "csv",
        description: "Importa dados de planilhas exportadas em CSV",
        config: { filePath: "", separator: "," },
        normalizationRules: {
          dateColumns: [],
          currencyColumns: [],
          textColumns: [],
        },
      },
      {
        id: "nfe-json",
        name: "NF-e — JSON Import",
        systemType: "fiscal",
        sourceType: "json",
        description: "Importa notas fiscais em formato JSON",
        config: {},
        normalizationRules: {
          dateColumns: ["dhEmi", "dhSaiEnt"],
          currencyColumns: ["vNF", "vProd", "vDesc", "vFrete", "vICMS"],
          docColumns: ["CNPJ", "CPF"],
          dedupKeys: ["chNFe"],
        },
      },
      {
        id: "windows-share-dir",
        name: "Pasta Compartilhada Windows — Scanner",
        systemType: "cadastro",
        sourceType: "directory",
        description: "Varre pasta de rede Windows (SMB montada) e importa todos CSV, XLSX e PDFs automaticamente",
        config: { directoryPath: "/mnt/windows-share", recursive: true, extensions: [".csv", ".xlsx", ".xls", ".pdf"] },
        normalizationRules: {
          dateColumns: ["data", "date", "dt_cadastro", "dt_emissao", "dt_nascimento", "data_nascimento"],
          currencyColumns: ["valor", "amount", "total", "saldo", "salario"],
          textColumns: ["nome", "razao_social", "fantasia", "endereco", "descricao"],
          phoneColumns: ["telefone", "celular", "fone", "tel"],
          docColumns: ["cpf", "cnpj", "rg", "documento", "inscricao"],
        },
      },
      {
        id: "windows-financeiro",
        name: "Windows — Financeiro (CSV/XLSX)",
        systemType: "financeiro",
        sourceType: "directory",
        description: "Importa planilhas financeiras da pasta compartilhada do Windows Server",
        config: { directoryPath: "/mnt/windows-share/Financeiro", recursive: true, extensions: [".csv", ".xlsx", ".xls"] },
        normalizationRules: {
          dateColumns: ["data", "dt_emissao", "dt_vencimento", "dt_pagamento", "competencia"],
          currencyColumns: ["valor", "total", "debito", "credito", "saldo", "desconto", "juros", "multa"],
          docColumns: ["cnpj", "cpf"],
          dedupKeys: ["nf", "documento", "numero"],
        },
      },
      {
        id: "windows-cadastro-pdf",
        name: "Windows — Cadastros (PDF)",
        systemType: "cadastro",
        sourceType: "directory",
        description: "Extrai dados de cadastro de PDFs na pasta compartilhada (fichas, contratos, comprovantes)",
        config: { directoryPath: "/mnt/windows-share/Cadastros", recursive: true, extensions: [".pdf"] },
        normalizationRules: {
          dateColumns: ["data", "data_nascimento", "dt_cadastro"],
          phoneColumns: ["telefone", "celular"],
          docColumns: ["cpf", "cnpj", "rg"],
          textColumns: ["nome", "endereco", "email"],
        },
      },
    ];
  });

  // ==================== DIRECTORY SCAN ENDPOINT ====================

  // POST /api/unifier/scan — scan a directory and preview files
  router.post("/api/unifier/scan", async (req, body) => {
    await getTenantId(req);
    if (!body.path) throw { status: 400, message: "path required" };
    if (!fs.existsSync(body.path)) throw { status: 400, message: `Diretorio nao encontrado: ${body.path}. Verifique se o mount SMB esta ativo.` };

    const files = scanDirectory(body.path, {
      extensions: body.extensions || [".csv", ".xlsx", ".xls", ".pdf", ".json"],
      recursive: body.recursive !== false,
    });

    // Group by extension
    const byExt = {};
    for (const f of files) {
      byExt[f.ext] = (byExt[f.ext] || 0) + 1;
    }

    // Group by directory
    const byDir = {};
    for (const f of files) {
      byDir[f.dir] = (byDir[f.dir] || 0) + 1;
    }

    return {
      path: body.path,
      totalFiles: files.length,
      byExtension: byExt,
      byDirectory: byDir,
      files: files.slice(0, 100), // Limit preview to 100 files
      truncated: files.length > 100,
    };
  });

  // POST /api/unifier/preview-file — preview a single file's content
  router.post("/api/unifier/preview-file", async (req, body) => {
    await getTenantId(req);
    if (!body.filePath) throw { status: 400, message: "filePath required" };
    if (!fs.existsSync(body.filePath)) throw { status: 404, message: "File not found" };

    const ext = path.extname(body.filePath).toLowerCase();
    let records = [];
    let meta = { file: path.basename(body.filePath), ext, size: fs.statSync(body.filePath).size };

    try {
      switch (ext) {
        case ".csv":
          records = collectFromCSV({ config: { filePath: body.filePath, separator: body.separator } });
          meta.type = "tabular";
          break;
        case ".xlsx":
        case ".xls":
          records = collectFromXLSX(body.filePath, body);
          meta.type = "tabular";
          // List sheets
          const XLSX = require("xlsx");
          const wb = XLSX.readFile(body.filePath, { type: "file" });
          meta.sheets = wb.SheetNames;
          break;
        case ".pdf":
          records = await collectFromPDF(body.filePath, body);
          meta.type = records[0]?._raw_text ? "text" : "tabular";
          break;
        case ".json":
          records = collectFromJSON({ config: { filePath: body.filePath } });
          meta.type = "json";
          break;
        default:
          throw { status: 400, message: `Extensao nao suportada: ${ext}` };
      }
    } catch (err) {
      return { meta, error: err.message, records: [] };
    }

    const columns = records.length > 0 ? Object.keys(records[0]) : [];
    return {
      meta,
      columns,
      totalRecords: records.length,
      preview: records.slice(0, 20), // First 20 rows
    };
  });

  // GET /api/unifier/mount-guide — instructions for mounting Windows share
  router.get("/api/unifier/mount-guide", async () => {
    return {
      title: "Como montar pasta compartilhada Windows no Ubuntu",
      steps: [
        {
          step: 1,
          title: "Instalar cifs-utils",
          command: "sudo apt-get install -y cifs-utils",
          note: "Necessario apenas uma vez",
        },
        {
          step: 2,
          title: "Criar ponto de montagem",
          command: "sudo mkdir -p /mnt/windows-share",
        },
        {
          step: 3,
          title: "Criar arquivo de credenciais (seguro)",
          command: "sudo nano /etc/samba-creds",
          content: "username=SEU_USUARIO\npassword=SUA_SENHA\ndomain=WORKGROUP",
          note: "Depois: sudo chmod 600 /etc/samba-creds",
        },
        {
          step: 4,
          title: "Montar pasta",
          command: "sudo mount -t cifs //IP_WINDOWS_SERVER/NomeDaPasta /mnt/windows-share -o credentials=/etc/samba-creds,vers=3.0,uid=$(id -u),gid=$(id -g),file_mode=0644,dir_mode=0755",
          note: "Substitua IP_WINDOWS_SERVER e NomeDaPasta pelos valores reais",
        },
        {
          step: 5,
          title: "Montar automaticamente no boot (fstab)",
          command: "echo '//IP_WINDOWS_SERVER/NomeDaPasta /mnt/windows-share cifs credentials=/etc/samba-creds,vers=3.0,uid=1000,gid=1000,file_mode=0644,dir_mode=0755 0 0' | sudo tee -a /etc/fstab",
          note: "Assim a pasta e montada toda vez que o Ubuntu iniciar",
        },
        {
          step: 6,
          title: "Verificar montagem",
          command: "ls /mnt/windows-share",
          note: "Deve listar os arquivos do Windows Server",
        },
      ],
      troubleshooting: [
        { problem: "mount: bad option", solution: "Instale cifs-utils: sudo apt install cifs-utils" },
        { problem: "mount error(13): Permission denied", solution: "Verifique usuario/senha no /etc/samba-creds e as permissoes de compartilhamento no Windows" },
        { problem: "mount error(112): Host is down", solution: "Verifique se o Windows Server esta ligado e acessivel (ping IP_WINDOWS_SERVER)" },
        { problem: "Pasta vazia apos montar", solution: "Verifique se o nome do compartilhamento esta correto (no Windows: click direito na pasta > Propriedades > Compartilhamento)" },
        { problem: "Nao monta no boot", solution: "Adicione _netdev nas opcoes do fstab: ...cifs credentials=...,_netdev 0 0" },
      ],
    };
  });

  // Start scheduler
  startUnifierScheduler();
}

module.exports = { registerDataUnifierRoutes };
