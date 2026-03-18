// api-rag.js — RAG endpoints for OpenClaw
// Real columns: knowledge_bases(name, description, embedding_model, embedding_dim, distance_metric)
// documents(knowledge_base_id, source_type, source_uri, title, mime_type, language_code, checksum_sha256, doc_metadata, ingestion_status)
// document_chunks(document_id, chunk_index, token_count, content, chunk_metadata)
// chunk_embeddings(chunk_id, tenant_id, knowledge_base_id, embedding_model, embedding vector(1536))
// rag_queries(user_id, knowledge_base_id, query_text, answer_text, model_name, latency_ms, token_usage)
const db = require("./db");
const fs = require("fs");
const path = require("path");
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

function chunkText(text, maxSize = 1000, overlap = 100) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = "";
  let charOffset = 0;
  for (const para of paragraphs) {
    if (current.length + para.length > maxSize && current.length > 0) {
      chunks.push({ text: current.trim(), charOffset });
      const overlapText = current.slice(-overlap);
      charOffset += current.length - overlap;
      current = overlapText + "\n\n" + para;
    } else {
      if (current) current += "\n\n";
      current += para;
    }
  }
  if (current.trim()) chunks.push({ text: current.trim(), charOffset });
  return chunks;
}

async function generateEmbedding(text) {
  try {
    const http = require("http");
    return new Promise((resolve) => {
      const data = JSON.stringify({ model: "nomic-embed-text", prompt: text });
      const req = http.request({
        hostname: "127.0.0.1", port: 11434, path: "/api/embeddings",
        method: "POST", headers: { "Content-Type": "application/json" }, timeout: 30000,
      }, (res) => {
        let body = "";
        res.on("data", (c) => body += c);
        res.on("end", () => { try { resolve(JSON.parse(body).embedding || null); } catch { resolve(null); } });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.write(data); req.end();
    });
  } catch { return null; }
}

function registerRagRoutes(router) {

  // ==================== KNOWLEDGE BASES ====================

  router.get("/api/rag/knowledge-bases", async (req) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      `SELECT kb.*,
              (SELECT count(*) FROM rag.documents d WHERE d.knowledge_base_id = kb.id AND d.deleted_at IS NULL) as doc_count,
              (SELECT count(*) FROM rag.document_chunks dc JOIN rag.documents d ON dc.document_id = d.id WHERE d.knowledge_base_id = kb.id AND dc.deleted_at IS NULL) as chunk_count
       FROM rag.knowledge_bases kb WHERE kb.tenant_id = $1 AND kb.deleted_at IS NULL ORDER BY kb.name`, [tid]
    );
    return res.rows;
  });

  router.post("/api/rag/knowledge-bases", async (req, body) => {
    const tid = await getTenantId(req);
    const res = await db.query(
      "INSERT INTO rag.knowledge_bases (tenant_id, name, description, embedding_model, embedding_dim, distance_metric) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [tid, body.name, body.description || null, body.embedding_model || "nomic-embed-text",
       body.embedding_dim || 768, body.distance_metric || "cosine"]
    );
    return res.rows[0];
  });

  // ==================== DOCUMENTS ====================

  router.get("/api/rag/documents", async (req) => {
    const tid = await getTenantId(req);
    const kbId = req.query.knowledge_base_id;
    let where = "d.tenant_id = $1 AND d.deleted_at IS NULL";
    const params = [tid];
    if (kbId) { params.push(kbId); where += ` AND d.knowledge_base_id = $${params.length}`; }
    const res = await db.query(
      `SELECT d.*,
              (SELECT count(*) FROM rag.document_chunks dc WHERE dc.document_id = d.id AND dc.deleted_at IS NULL) as chunk_count,
              kb.name as knowledge_base_name
       FROM rag.documents d LEFT JOIN rag.knowledge_bases kb ON d.knowledge_base_id = kb.id
       WHERE ${where} ORDER BY d.created_at DESC`, params
    );
    return res.rows;
  });

  // POST /api/rag/documents/ingest
  router.post("/api/rag/documents/ingest", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.knowledge_base_id) throw { status: 400, message: "knowledge_base_id required" };

    let content = "", title = body.title || "Untitled", sourceType = body.source_type || "manual", mimeType = "text/plain";
    if (body.content) { content = body.content; }
    else if (body.filePath) {
      const ext = path.extname(body.filePath).toLowerCase();
      const supported = [".md", ".txt", ".json", ".pdf", ".docx"];
      if (!supported.includes(ext)) throw { status: 400, message: "Formatos suportados: " + supported.join(", ") };
      if (!fs.existsSync(body.filePath)) throw { status: 400, message: "Arquivo nao encontrado: " + body.filePath };

      if (ext === ".pdf") {
        const pdfParse = require("pdf-parse");
        const buf = fs.readFileSync(body.filePath);
        const pdf = await pdfParse(buf);
        content = pdf.text;
        mimeType = "application/pdf";
      } else if (ext === ".docx") {
        const mammoth = require("mammoth");
        const result = await mammoth.extractRawText({ path: body.filePath });
        content = result.value;
        mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      } else {
        content = fs.readFileSync(body.filePath, "utf-8");
        mimeType = ext === ".md" ? "text/markdown" : ext === ".json" ? "application/json" : "text/plain";
      }
      title = body.title || path.basename(body.filePath);
      sourceType = "upload";
    } else throw { status: 400, message: "content or filePath required" };

    if (!content || content.trim().length === 0) throw { status: 400, message: "Documento vazio ou nao foi possivel extrair texto" };

    const contentHash = crypto.createHash("sha256").update(content).digest("hex");

    // Check duplicate
    const existing = await db.query("SELECT id FROM rag.documents WHERE tenant_id = $1 AND checksum_sha256 = $2 AND deleted_at IS NULL", [tid, contentHash]);
    if (existing.rows.length > 0) return { id: existing.rows[0].id, status: "duplicate" };

    const kbRes = await db.query("SELECT * FROM rag.knowledge_bases WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL", [body.knowledge_base_id, tid]);
    if (kbRes.rows.length === 0) throw { status: 404, message: "Knowledge base not found" };
    const kb = kbRes.rows[0];

    return db.transaction(async (client) => {
      const docRes = await client.query(
        `INSERT INTO rag.documents (tenant_id, knowledge_base_id, title, source_type, source_uri, mime_type, checksum_sha256, ingestion_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'processing') RETURNING *`,
        [tid, body.knowledge_base_id, title, sourceType, body.filePath || null, mimeType, contentHash]
      );
      const doc = docRes.rows[0];

      const chunks = chunkText(content, body.chunk_size || 1000, body.chunk_overlap || 100);
      let embeddedCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const tokenEst = Math.ceil(chunk.text.length / 4);

        const chunkRes = await client.query(
          `INSERT INTO rag.document_chunks (tenant_id, document_id, chunk_index, content, token_count, chunk_metadata)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [tid, doc.id, i, chunk.text, tokenEst, JSON.stringify({ charOffset: chunk.charOffset, charLength: chunk.text.length })]
        );

        const embedding = await generateEmbedding(chunk.text);
        if (embedding) {
          // Pad/trim to 1536 dimensions (pgvector is configured for 1536)
          let vec = embedding;
          if (vec.length < 1536) vec = vec.concat(new Array(1536 - vec.length).fill(0));
          else if (vec.length > 1536) vec = vec.slice(0, 1536);

          await client.query(
            "INSERT INTO rag.chunk_embeddings (chunk_id, tenant_id, knowledge_base_id, embedding_model, embedding) VALUES ($1,$2,$3,$4,$5)",
            [chunkRes.rows[0].id, tid, body.knowledge_base_id, kb.embedding_model || "nomic-embed-text", `[${vec.join(",")}]`]
          );
          embeddedCount++;
        }
      }

      const finalStatus = embeddedCount > 0 ? "indexed" : "indexed";
      await client.query("UPDATE rag.documents SET ingestion_status = $1, ingested_at = now() WHERE id = $2", [finalStatus, doc.id]);

      return {
        id: doc.id, title: doc.title, chunks: chunks.length, embedded: embeddedCount, status: finalStatus,
        message: embeddedCount === 0 ? "Chunks created but embeddings unavailable (Ollama not running?)" : "Document ingested and embedded",
      };
    });
  });

  // POST /api/rag/documents/ingest-upload — receive file as base64 (for PDF/DOCX from browser)
  router.post("/api/rag/documents/ingest-upload", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.knowledge_base_id) throw { status: 400, message: "knowledge_base_id required" };
    if (!body.fileBase64 || !body.fileName) throw { status: 400, message: "fileBase64 and fileName required" };

    const ext = path.extname(body.fileName).toLowerCase();
    const supported = [".md", ".txt", ".json", ".pdf", ".docx"];
    if (!supported.includes(ext)) throw { status: 400, message: "Formatos suportados: " + supported.join(", ") };

    const buf = Buffer.from(body.fileBase64, "base64");
    let content = "", mimeType = "text/plain";

    if (ext === ".pdf") {
      const pdfParse = require("pdf-parse");
      const pdf = await pdfParse(buf);
      content = pdf.text;
      mimeType = "application/pdf";
    } else if (ext === ".docx") {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer: buf });
      content = result.value;
      mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else {
      content = buf.toString("utf-8");
      mimeType = ext === ".md" ? "text/markdown" : ext === ".json" ? "application/json" : "text/plain";
    }

    if (!content || content.trim().length === 0) throw { status: 400, message: "Documento vazio ou nao foi possivel extrair texto" };

    const title = body.title || body.fileName.replace(/\.[^.]+$/, "");
    const contentHash = crypto.createHash("sha256").update(content).digest("hex");

    const existing = await db.query("SELECT id FROM rag.documents WHERE tenant_id = $1 AND checksum_sha256 = $2 AND deleted_at IS NULL", [tid, contentHash]);
    if (existing.rows.length > 0) return { id: existing.rows[0].id, status: "duplicate" };

    const kbRes = await db.query("SELECT * FROM rag.knowledge_bases WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL", [body.knowledge_base_id, tid]);
    if (kbRes.rows.length === 0) throw { status: 404, message: "Knowledge base not found" };
    const kb = kbRes.rows[0];

    return db.transaction(async (client) => {
      const docRes = await client.query(
        `INSERT INTO rag.documents (tenant_id, knowledge_base_id, title, source_type, mime_type, checksum_sha256, ingestion_status)
         VALUES ($1,$2,$3,'upload',$4,$5,'processing') RETURNING *`,
        [tid, body.knowledge_base_id, title, mimeType, contentHash]
      );
      const doc = docRes.rows[0];

      const chunks = chunkText(content, body.chunk_size || 1000, body.chunk_overlap || 100);
      let embeddedCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const tokenEst = Math.ceil(chunk.text.length / 4);
        const chunkRes = await client.query(
          `INSERT INTO rag.document_chunks (tenant_id, document_id, chunk_index, content, token_count, chunk_metadata)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [tid, doc.id, i, chunk.text, tokenEst, JSON.stringify({ charOffset: chunk.charOffset, charLength: chunk.text.length })]
        );

        const embedding = await generateEmbedding(chunk.text);
        if (embedding) {
          let vec = embedding;
          if (vec.length < 1536) vec = vec.concat(new Array(1536 - vec.length).fill(0));
          else if (vec.length > 1536) vec = vec.slice(0, 1536);
          await client.query(
            "INSERT INTO rag.chunk_embeddings (chunk_id, tenant_id, knowledge_base_id, embedding_model, embedding) VALUES ($1,$2,$3,$4,$5)",
            [chunkRes.rows[0].id, tid, body.knowledge_base_id, kb.embedding_model || "nomic-embed-text", `[${vec.join(",")}]`]
          );
          embeddedCount++;
        }
      }

      const finalStatus = "indexed";
      await client.query("UPDATE rag.documents SET ingestion_status = $1, ingested_at = now() WHERE id = $2", [finalStatus, doc.id]);

      return {
        id: doc.id, title: doc.title, chunks: chunks.length, embedded: embeddedCount, status: finalStatus,
        message: embeddedCount === 0 ? "Chunks created but embeddings unavailable (Ollama not running?)" : "Document ingested and embedded",
      };
    });
  });

  // ==================== SEARCH ====================

  router.post("/api/rag/search", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.query) throw { status: 400, message: "query required" };
    const kbId = body.knowledge_base_id || null;
    const topK = Math.min(body.top_k || 5, 20);
    const startMs = Date.now();

    const queryEmbedding = await generateEmbedding(body.query);
    let results, method = "fulltext";

    if (queryEmbedding) {
      method = "vector";
      let vec = queryEmbedding;
      if (vec.length < 1536) vec = vec.concat(new Array(1536 - vec.length).fill(0));
      else if (vec.length > 1536) vec = vec.slice(0, 1536);

      let where = "ce.tenant_id = $1";
      const params = [tid, `[${vec.join(",")}]`, topK];
      if (kbId) { params.push(kbId); where += ` AND ce.knowledge_base_id = $${params.length}`; }

      results = await db.query(
        `SELECT dc.content, dc.chunk_index, d.title as document_title, d.id as document_id,
                kb.name as knowledge_base_name,
                1 - (ce.embedding <=> $2::vector) as similarity
         FROM rag.chunk_embeddings ce
         JOIN rag.document_chunks dc ON ce.chunk_id = dc.id
         JOIN rag.documents d ON dc.document_id = d.id
         JOIN rag.knowledge_bases kb ON d.knowledge_base_id = kb.id
         WHERE ${where} AND d.deleted_at IS NULL
         ORDER BY ce.embedding <=> $2::vector LIMIT $3`, params
      );
    } else {
      let where = "dc.tenant_id = $1";
      const params = [tid, body.query, topK];
      if (kbId) { params.push(kbId); where += ` AND d.knowledge_base_id = $${params.length}`; }

      results = await db.query(
        `SELECT dc.content, dc.chunk_index, d.title as document_title, d.id as document_id,
                kb.name as knowledge_base_name,
                ts_rank(to_tsvector('portuguese', dc.content), plainto_tsquery('portuguese', $2)) as similarity
         FROM rag.document_chunks dc
         JOIN rag.documents d ON dc.document_id = d.id
         JOIN rag.knowledge_bases kb ON d.knowledge_base_id = kb.id
         WHERE ${where} AND d.deleted_at IS NULL AND to_tsvector('portuguese', dc.content) @@ plainto_tsquery('portuguese', $2)
         ORDER BY similarity DESC LIMIT $3`, params
      );
    }

    const latencyMs = Date.now() - startMs;
    await db.query(
      "INSERT INTO rag.rag_queries (tenant_id, knowledge_base_id, query_text, model_name, latency_ms) VALUES ($1,$2,$3,$4,$5)",
      [tid, kbId, body.query, method, latencyMs]
    ).catch(() => {});

    return {
      query: body.query, method, latencyMs,
      results: results.rows.map(r => ({
        content: r.content, document: r.document_title, documentId: r.document_id,
        knowledgeBase: r.knowledge_base_name, similarity: parseFloat(parseFloat(r.similarity).toFixed(4)),
        chunkIndex: r.chunk_index,
      })),
      count: results.rows.length,
    };
  });

  // ==================== RAG STATS ====================

  router.get("/api/rag/stats", async (req) => {
    const tid = await getTenantId(req);
    const [kbs, docs, chunks, embeddings, queries] = await Promise.all([
      db.query("SELECT count(*) FROM rag.knowledge_bases WHERE tenant_id = $1 AND deleted_at IS NULL", [tid]),
      db.query("SELECT count(*) FROM rag.documents WHERE tenant_id = $1 AND deleted_at IS NULL", [tid]),
      db.query("SELECT count(*), COALESCE(sum(token_count),0) as tokens FROM rag.document_chunks WHERE tenant_id = $1 AND deleted_at IS NULL", [tid]),
      db.query("SELECT count(*) FROM rag.chunk_embeddings WHERE tenant_id = $1", [tid]),
      db.query("SELECT count(*) FROM rag.rag_queries WHERE tenant_id = $1 AND deleted_at IS NULL", [tid]),
    ]);
    return {
      knowledgeBases: parseInt(kbs.rows[0].count),
      documents: parseInt(docs.rows[0].count),
      chunks: parseInt(chunks.rows[0].count),
      totalTokenEstimate: parseInt(chunks.rows[0].tokens || 0),
      embeddings: parseInt(embeddings.rows[0].count),
      queries: parseInt(queries.rows[0].count),
    };
  });

  // POST /api/rag/ingest-directory
  router.post("/api/rag/ingest-directory", async (req, body) => {
    const tid = await getTenantId(req);
    if (!body.knowledge_base_id || !body.directory) throw { status: 400, message: "knowledge_base_id and directory required" };
    if (!fs.existsSync(body.directory)) throw { status: 400, message: "Directory not found" };

    const files = fs.readdirSync(body.directory).filter(f => /\.(md|txt|json|pdf|docx)$/i.test(f));
    const results = [];

    for (const file of files) {
      const filePath = path.join(body.directory, file);
      try {
        const ext = path.extname(file).toLowerCase();
        let content, mimeType;
        if (ext === ".pdf") {
          const pdfParse = require("pdf-parse");
          content = (await pdfParse(fs.readFileSync(filePath))).text;
          mimeType = "application/pdf";
        } else if (ext === ".docx") {
          const mammoth = require("mammoth");
          content = (await mammoth.extractRawText({ path: filePath })).value;
          mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        } else {
          content = fs.readFileSync(filePath, "utf-8");
          mimeType = ext === ".md" ? "text/markdown" : ext === ".json" ? "application/json" : "text/plain";
        }
        if (!content || !content.trim()) { results.push({ file, status: "skipped", reason: "empty" }); continue; }

        const contentHash = crypto.createHash("sha256").update(content).digest("hex");
        const existing = await db.query("SELECT id FROM rag.documents WHERE tenant_id = $1 AND checksum_sha256 = $2 AND deleted_at IS NULL", [tid, contentHash]);
        if (existing.rows.length > 0) { results.push({ file, status: "skipped" }); continue; }

        const docRes = await db.query(
          `INSERT INTO rag.documents (tenant_id, knowledge_base_id, title, source_type, source_uri, mime_type, checksum_sha256, ingestion_status)
           VALUES ($1,$2,$3,'upload',$4,$5,$6,'processing') RETURNING id`, [tid, body.knowledge_base_id, file, filePath, mimeType, contentHash]
        );
        const docId = docRes.rows[0].id;
        const chunks = chunkText(content, body.chunk_size || 1000, body.chunk_overlap || 100);
        for (let i = 0; i < chunks.length; i++) {
          await db.query(
            "INSERT INTO rag.document_chunks (tenant_id, document_id, chunk_index, content, token_count) VALUES ($1,$2,$3,$4,$5)",
            [tid, docId, i, chunks[i].text, Math.ceil(chunks[i].text.length / 4)]
          );
        }
        await db.query("UPDATE rag.documents SET ingestion_status = 'indexed', ingested_at = now() WHERE id = $1", [docId]);
        results.push({ file, status: "ingested", chunks: chunks.length });
      } catch (err) {
        results.push({ file, status: "error", error: err.message });
      }
    }

    return { directory: body.directory, filesFound: files.length, results };
  });
}

module.exports = { registerRagRoutes };
