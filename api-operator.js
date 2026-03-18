// api-operator.js — REST endpoints for the Operator (browser automation) agent
const path = require("path");
const fs = require("fs");
const operatorDir = path.join(require("os").homedir(), ".openclaw/workspace-operator");
const { sendCommand, ensureBrowser, closeBrowser, isRunning } = require(path.join(operatorDir, "operator-client"));
const { listPlaybooks, getPlaybook, savePlaybook, deletePlaybook, compilePlaybook, startScheduler } = require(path.join(operatorDir, "playbook-engine"));
const desktop = require(path.join(operatorDir, "desktop-client"));

function registerOperatorRoutes(router) {

  // GET /api/operator/status — check if browser is running
  router.get("/api/operator/status", async () => {
    const running = isRunning();
    if (!running) return { running: false, message: "Browser nao esta rodando. Use POST /api/operator/open para iniciar." };
    const result = await sendCommand("screenshot", ["status"]);
    return { running: true, ...result };
  });

  // POST /api/operator/open — open browser and navigate to URL
  router.post("/api/operator/open", async (req, body) => {
    if (!body.url) throw { status: 400, message: "url required" };
    const result = await ensureBrowser(body.url);
    return result;
  });

  // POST /api/operator/command — execute any browser command
  router.post("/api/operator/command", async (req, body) => {
    if (!body.command) throw { status: 400, message: "command required" };
    if (!isRunning()) {
      // Auto-start browser if command is navigate/goto
      if (body.command === "goto" || body.command === "navigate") {
        await ensureBrowser(body.args?.[0] || "about:blank");
        return sendCommand("screenshot", ["auto-open"]);
      }
      throw { status: 400, message: "Browser nao esta rodando. Use POST /api/operator/open primeiro." };
    }
    return sendCommand(body.command, body.args || []);
  });

  // POST /api/operator/close — close browser
  router.post("/api/operator/close", async () => {
    return closeBrowser();
  });

  // POST /api/operator/run — run a multi-step automation script
  // Accepts an array of steps: [{command, args, wait?}]
  router.post("/api/operator/run", async (req, body) => {
    if (!body.steps || !Array.isArray(body.steps)) throw { status: 400, message: "steps[] required" };

    // Ensure browser is running
    if (!isRunning()) {
      const firstStep = body.steps[0];
      if (firstStep?.command === "goto" || firstStep?.command === "navigate") {
        await ensureBrowser(firstStep.args?.[0] || "about:blank");
        body.steps = body.steps.slice(1);
      } else if (body.url) {
        await ensureBrowser(body.url);
      } else {
        throw { status: 400, message: "Browser nao esta rodando. Inclua url no body ou comece com step goto." };
      }
    }

    const results = [];
    for (let i = 0; i < body.steps.length; i++) {
      const step = body.steps[i];
      try {
        if (step.wait) {
          await new Promise(r => setTimeout(r, step.wait));
        }
        const result = await sendCommand(step.command, step.args || []);
        results.push({ step: i, command: step.command, ...result });
        if (result.error && !step.optional) {
          return { completed: i, total: body.steps.length, error: result.error, results };
        }
      } catch (err) {
        results.push({ step: i, command: step.command, error: err.message });
        if (!step.optional) {
          return { completed: i, total: body.steps.length, error: err.message, results };
        }
      }
    }

    return { completed: results.length, total: body.steps.length, success: true, results };
  });

  // GET /api/operator/screenshots — list recent screenshots
  router.get("/api/operator/screenshots", async () => {
    const dir = path.join(operatorDir, "screenshots");
    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith(".png"))
        .sort().reverse()
        .slice(0, 20)
        .map(f => ({
          name: f,
          path: path.join(dir, f),
          size: fs.statSync(path.join(dir, f)).size,
          created: fs.statSync(path.join(dir, f)).mtime.toISOString(),
        }));
      return { count: files.length, files };
    } catch { return { count: 0, files: [] }; }
  });

  // GET /api/operator/downloads — list downloaded files
  router.get("/api/operator/downloads", async () => {
    const dir = path.join(operatorDir, "downloads");
    try {
      const files = fs.readdirSync(dir)
        .sort().reverse()
        .slice(0, 20)
        .map(f => ({
          name: f,
          path: path.join(dir, f),
          size: fs.statSync(path.join(dir, f)).size,
          created: fs.statSync(path.join(dir, f)).mtime.toISOString(),
        }));
      return { count: files.length, files };
    } catch { return { count: 0, files: [] }; }
  });

  // ==================== PLAYBOOK ENDPOINTS ====================

  // GET /api/operator/playbooks — list all playbooks
  router.get("/api/operator/playbooks", async () => {
    return { playbooks: listPlaybooks() };
  });

  // GET /api/operator/playbooks/:id — get specific playbook
  router.get("/api/operator/playbooks/:id", async (req) => {
    const pb = getPlaybook(req.params.id);
    if (!pb) throw { status: 404, message: "Playbook not found" };
    return pb;
  });

  // POST /api/operator/playbooks — create/update playbook
  router.post("/api/operator/playbooks", async (req, body) => {
    if (!body.id) body.id = body.name ? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "") : `pb-${Date.now()}`;
    const pb = savePlaybook(body.id, body);
    return { ok: true, playbook: pb };
  });

  // DELETE /api/operator/playbooks/:id — delete playbook
  router.delete("/api/operator/playbooks/:id", async (req) => {
    const ok = deletePlaybook(req.params.id);
    if (!ok) throw { status: 404, message: "Playbook not found" };
    return { ok: true, deleted: req.params.id };
  });

  // POST /api/operator/playbooks/:id/run — compile and execute a playbook
  router.post("/api/operator/playbooks/:id/run", async (req, body) => {
    const pb = getPlaybook(req.params.id);
    if (!pb) throw { status: 404, message: "Playbook not found" };

    const vars = body.vars || {};
    const steps = compilePlaybook(pb, vars);

    if (steps.length === 0) return { ok: false, error: "Playbook has no steps" };

    // Ensure browser is running
    if (!isRunning()) {
      const firstStep = steps[0];
      if (firstStep.command === "goto") {
        await ensureBrowser(firstStep.args[0]);
        steps.shift();
      } else if (pb.system) {
        await ensureBrowser(pb.system);
      } else {
        throw { status: 400, message: "Browser nao esta rodando e playbook nao tem system URL." };
      }
    }

    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      try {
        if (step.wait) await new Promise(r => setTimeout(r, step.wait));
        const result = await sendCommand(step.command, step.args || []);
        results.push({ step: i, label: step.label, command: step.command, ...result });
        if (result.error && !step.optional) {
          // Update lastRun
          savePlaybook(req.params.id, { lastRun: { at: new Date().toISOString(), success: false, stepsCompleted: i, error: result.error } });
          return { completed: i, total: steps.length, error: result.error, results };
        }
      } catch (err) {
        results.push({ step: i, label: step.label, command: step.command, error: err.message });
        if (!step.optional) {
          savePlaybook(req.params.id, { lastRun: { at: new Date().toISOString(), success: false, stepsCompleted: i, error: err.message } });
          return { completed: i, total: steps.length, error: err.message, results };
        }
      }
    }

    savePlaybook(req.params.id, { lastRun: { at: new Date().toISOString(), success: true, stepsCompleted: steps.length } });
    return { completed: results.length, total: steps.length, success: true, results };
  });

  // POST /api/operator/record/start — open browser at URL and inject recorder
  router.post("/api/operator/record/start", async (req, body) => {
    const url = body.url;
    if (!url) throw { status: 400, message: "url required" };

    if (!isRunning()) {
      await ensureBrowser(url);
    } else {
      await sendCommand("goto", [url]);
    }

    // Wait a moment for page to load, then inject recorder
    await new Promise(r => setTimeout(r, 1000));
    const result = await sendCommand("start-record", []);
    return { ok: true, action: "record-started", url, ...result };
  });

  // POST /api/operator/record/stop — stop recording and optionally save as playbook
  router.post("/api/operator/record/stop", async (req, body) => {
    if (!isRunning()) throw { status: 400, message: "Browser nao esta rodando" };

    const recording = await sendCommand("stop-record", []);
    if (recording.error) return recording;

    // Optionally save as playbook
    if (body.saveAs || body.name) {
      const id = body.saveAs || body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
      const pb = savePlaybook(id, {
        name: body.name || id,
        description: body.description || `Gravado em ${new Date().toISOString()}`,
        system: recording.startUrl ? new URL(recording.startUrl).origin : "",
        steps: recording.steps || [],
        recordedAt: new Date().toISOString(),
        source: "recorder",
      });
      return { ok: true, action: "record-stopped-and-saved", playbook: pb, stepsRecorded: (recording.steps || []).length };
    }

    return { ok: true, action: "record-stopped", steps: recording.steps, stepsRecorded: (recording.steps || []).length, startUrl: recording.startUrl };
  });

  // GET /api/operator/record/status — check if recording is active
  router.get("/api/operator/record/status", async () => {
    if (!isRunning()) return { recording: false, browserRunning: false };
    const result = await sendCommand("get-recording", []);
    if (result.error) return { recording: false, browserRunning: true };
    return { recording: result.recording, browserRunning: true, stepsCount: (result.steps || []).length };
  });

  // POST /api/operator/playbooks/:id/schedule — set/update schedule for a playbook
  router.post("/api/operator/playbooks/:id/schedule", async (req, body) => {
    const pb = getPlaybook(req.params.id);
    if (!pb) throw { status: 404, message: "Playbook not found" };
    const schedule = body.cron ? { cron: body.cron, vars: body.vars || {} } : null;
    savePlaybook(req.params.id, { schedule });
    return { ok: true, id: req.params.id, schedule };
  });

  // Start playbook scheduler
  startScheduler(async (id, vars) => {
    const pb = getPlaybook(id);
    if (!pb) return;
    const steps = compilePlaybook(pb, vars);
    if (!isRunning() && pb.system) {
      await ensureBrowser(pb.system);
    }
    for (const step of steps) {
      if (step.wait) await new Promise(r => setTimeout(r, step.wait));
      await sendCommand(step.command, step.args || []);
    }
    savePlaybook(id, { lastRun: { at: new Date().toISOString(), success: true, stepsCompleted: steps.length, source: "scheduler" } });
  });

  // ==================== DESKTOP ENDPOINTS ====================

  // GET /api/operator/desktop/status — check if desktop server is running
  router.get("/api/operator/desktop/status", async () => {
    if (!desktop.isRunning()) return { running: false, message: "Desktop server nao esta rodando." };
    return desktop.sendCommand("status", []);
  });

  // POST /api/operator/desktop/start — start desktop automation server
  router.post("/api/operator/desktop/start", async () => {
    return desktop.ensureDesktop();
  });

  // POST /api/operator/desktop/command — execute desktop command
  router.post("/api/operator/desktop/command", async (req, body) => {
    if (!body.command) throw { status: 400, message: "command required" };
    if (!desktop.isRunning()) {
      // Auto-start for open-app
      if (body.command === "open-app") {
        await desktop.ensureDesktop();
      } else {
        throw { status: 400, message: "Desktop server nao esta rodando. Use POST /api/operator/desktop/start primeiro." };
      }
    }
    return desktop.sendCommand(body.command, body.args || []);
  });

  // POST /api/operator/desktop/run — run multi-step desktop automation
  router.post("/api/operator/desktop/run", async (req, body) => {
    if (!body.steps || !Array.isArray(body.steps)) throw { status: 400, message: "steps[] required" };

    if (!desktop.isRunning()) {
      await desktop.ensureDesktop();
    }

    const results = [];
    for (let i = 0; i < body.steps.length; i++) {
      const step = body.steps[i];
      try {
        if (step.wait) await new Promise(r => setTimeout(r, typeof step.wait === "number" ? step.wait : 1000));
        const result = await desktop.sendCommand(step.command, step.args || []);
        results.push({ step: i, label: step.label || step.command, ...result });
        if (result.error && !step.optional) {
          return { completed: i, total: body.steps.length, error: result.error, results };
        }
      } catch (err) {
        results.push({ step: i, command: step.command, error: err.message });
        if (!step.optional) {
          return { completed: i, total: body.steps.length, error: err.message, results };
        }
      }
    }
    return { completed: results.length, total: body.steps.length, success: true, results };
  });

  // POST /api/operator/desktop/close — stop desktop server
  router.post("/api/operator/desktop/close", async () => {
    return desktop.closeDesktop();
  });

  // GET /api/operator/help — list available commands
  router.get("/api/operator/help", async () => {
    return {
      description: "Operator — Agente de automacao de browser via Playwright",
      commands: [
        { cmd: "goto / navigate", args: ["url"], desc: "Navegar para URL" },
        { cmd: "screenshot", args: ["prefix?"], desc: "Capturar tela" },
        { cmd: "click", args: ["css-selector"], desc: "Clicar em elemento por seletor CSS" },
        { cmd: "click-text", args: ["texto"], desc: "Clicar em elemento que contem o texto" },
        { cmd: "click-xy", args: ["x", "y"], desc: "Clicar em coordenadas" },
        { cmd: "type", args: ["selector", "texto"], desc: "Digitar em campo de input" },
        { cmd: "fill-form", args: ["{selector: valor, ...}"], desc: "Preencher multiplos campos" },
        { cmd: "select", args: ["selector", "valor"], desc: "Selecionar opcao em dropdown" },
        { cmd: "scroll", args: ["down|up|bottom|top", "pixels?"], desc: "Rolar pagina" },
        { cmd: "wait", args: ["selector", "timeout?"], desc: "Esperar elemento aparecer" },
        { cmd: "extract", args: ["selector"], desc: "Extrair texto de elementos" },
        { cmd: "extract-table", args: ["selector?"], desc: "Extrair tabela como JSON" },
        { cmd: "extract-links", args: [], desc: "Extrair todos os links da pagina" },
        { cmd: "pdf", args: ["filename?"], desc: "Salvar pagina como PDF" },
        { cmd: "download-click", args: ["selector"], desc: "Clicar e aguardar download" },
        { cmd: "eval", args: ["js-code"], desc: "Executar JavaScript na pagina" },
        { cmd: "title", args: [], desc: "Obter titulo da pagina" },
        { cmd: "url", args: [], desc: "Obter URL atual" },
        { cmd: "html", args: ["selector"], desc: "Obter HTML de elemento" },
        { cmd: "back / forward / reload", args: [], desc: "Navegacao" },
        { cmd: "tabs", args: [], desc: "Listar abas abertas" },
        { cmd: "tab", args: ["index"], desc: "Trocar para aba" },
        { cmd: "new-tab", args: ["url?"], desc: "Abrir nova aba" },
        { cmd: "close-tab", args: [], desc: "Fechar aba atual" },
        { cmd: "close", args: [], desc: "Fechar browser" },
      ],
      endpoints: [
        "POST /api/operator/open        { url }",
        "POST /api/operator/command      { command, args[] }",
        "POST /api/operator/run          { steps: [{command, args[], wait?, optional?}] }",
        "POST /api/operator/close",
        "GET  /api/operator/status",
        "GET  /api/operator/screenshots",
        "GET  /api/operator/downloads",
        "GET  /api/operator/help",
        "",
        "--- Playbooks ---",
        "GET  /api/operator/playbooks              Lista todos",
        "GET  /api/operator/playbooks/:id           Detalhe",
        "POST /api/operator/playbooks               Criar/atualizar { id?, name, steps[], login?, system? }",
        "DELETE /api/operator/playbooks/:id          Deletar",
        "POST /api/operator/playbooks/:id/run        Executar { vars? }",
        "POST /api/operator/playbooks/:id/schedule   Agendar { cron, vars? }",
        "",
        "--- Record ---",
        "POST /api/operator/record/start    { url }",
        "POST /api/operator/record/stop     { saveAs?, name?, description? }",
        "GET  /api/operator/record/status",
        "",
        "--- Desktop (apps locais) ---",
        "GET  /api/operator/desktop/status",
        "POST /api/operator/desktop/start",
        "POST /api/operator/desktop/command  { command, args[] }",
        "POST /api/operator/desktop/run      { steps: [{command, args[], wait?, label?}] }",
        "POST /api/operator/desktop/close",
      ],
      desktopCommands: [
        { cmd: "open-app", args: ["nome-ou-caminho"], desc: "Abrir aplicativo" },
        { cmd: "screenshot", args: ["prefix?"], desc: "Capturar tela inteira" },
        { cmd: "click", args: ["x", "y"], desc: "Clicar em coordenadas" },
        { cmd: "double-click", args: ["x", "y"], desc: "Duplo clique" },
        { cmd: "right-click", args: ["x", "y"], desc: "Clique direito" },
        { cmd: "move", args: ["x", "y"], desc: "Mover mouse" },
        { cmd: "type-text", args: ["texto"], desc: "Digitar texto via teclado" },
        { cmd: "key", args: ["combo"], desc: "Atalho de teclado (ctrl+c, alt+tab, enter)" },
        { cmd: "scroll", args: ["direction", "amount?"], desc: "Scroll" },
        { cmd: "drag", args: ["x1", "y1", "x2", "y2"], desc: "Arrastar" },
        { cmd: "mouse-position", args: [], desc: "Posicao atual do mouse" },
        { cmd: "window-list", args: [], desc: "Listar janelas abertas" },
        { cmd: "window-focus", args: ["titulo"], desc: "Focar janela por titulo" },
        { cmd: "window-close", args: [], desc: "Fechar janela ativa" },
        { cmd: "window-minimize", args: [], desc: "Minimizar janela ativa" },
        { cmd: "window-maximize", args: [], desc: "Maximizar janela ativa" },
        { cmd: "wait", args: ["segundos"], desc: "Esperar N segundos" },
      ],
    };
  });
}

module.exports = { registerOperatorRoutes };
