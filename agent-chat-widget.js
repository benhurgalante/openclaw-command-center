// agent-chat-widget.js — Web Component for OpenClaw Agent Chat
// Standalone, zero-dependency widget for embedding in OpenClaw dashboard
// Connects to agent-chat-server (port 18790) via WebSocket + REST fallback
//
// Usage: <agent-chat-widget server="ws://localhost:18790"></agent-chat-widget>
// Or load as module: <script type="module" src="agent-chat-widget.js"></script>

class AgentChatWidget extends HTMLElement {
  static get observedAttributes() {
    return ["server", "collapsed", "theme"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._ws = null;
    this._messages = [];
    this._metrics = { activeAgents: 0, totalMessages: 0, enforcementEvents: 0, escalations: 0 };
    this._connected = false;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._collapsed = false;
    this._filter = { agent: "", search: "" };
    this._agents = new Set();
  }

  get server() {
    return this.getAttribute("server") || "ws://localhost:18790";
  }

  get restServer() {
    return this.server.replace(/^ws/, "http");
  }

  connectedCallback() {
    this._render();
    this._connect();
    this._pollMetrics();
  }

  disconnectedCallback() {
    if (this._ws) this._ws.close();
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._metricsTimer) clearInterval(this._metricsTimer);
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (name === "collapsed") {
      this._collapsed = newVal !== null;
      this._updateCollapsed();
    }
  }

  // ── WebSocket ──────────────────────────────────────────────
  _connect() {
    if (this._ws && this._ws.readyState < 2) return;

    try {
      this._ws = new WebSocket(this.server);
    } catch {
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      this._connected = true;
      this._reconnectDelay = 1000;
      this._updateStatus();
    };

    this._ws.onclose = () => {
      this._connected = false;
      this._updateStatus();
      this._scheduleReconnect();
    };

    this._ws.onerror = () => {
      this._connected = false;
      this._updateStatus();
    };

    this._ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        this._handleMessage(data);
      } catch { /* ignore */ }
    };
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    const jitter = Math.random() * 500;
    this._reconnectTimer = setTimeout(() => {
      this._connect();
    }, this._reconnectDelay + jitter);
    this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, this._maxReconnectDelay);
  }

  _handleMessage(data) {
    switch (data.type) {
      case "init":
        this._messages = [];
        if (data.chats) {
          for (const chat of data.chats) {
            for (const msg of chat.messages) {
              this._addMessage(msg, false);
            }
          }
        }
        this._renderMessages();
        break;

      case "chat_update":
        if (data.messages) {
          for (const msg of data.messages) {
            this._addMessage(msg, true);
          }
        }
        break;

      case "enforcement":
        this._addEnforcement(data);
        break;

      case "retries_update":
        this._updateRetries(data);
        break;
    }
  }

  _addMessage(msg, render = true) {
    // Deduplicate by id
    if (msg.id && this._messages.some((m) => m.id === msg.id)) return;

    this._messages.push({
      id: msg.id || `msg-${Date.now()}-${Math.random()}`,
      timestamp: msg.timestamp || new Date().toISOString(),
      agent: msg.agent || "unknown",
      body: (msg.body || msg.content || "").substring(0, 3000),
      chat: msg.chat || "",
      type: "chat",
    });

    if (msg.agent) this._agents.add(msg.agent);

    // Keep max 500 messages in memory
    if (this._messages.length > 500) {
      this._messages = this._messages.slice(-500);
    }

    if (render) this._renderMessages();
  }

  _addEnforcement(data) {
    this._messages.push({
      id: `enf-${Date.now()}-${Math.random()}`,
      timestamp: data.ts || new Date().toISOString(),
      agent: data.agentId || data.agent || "system",
      body: `🛡️ ${(data.decision || "").toUpperCase()} — ${data.reason_code || ""} (${data.agentId || ""})`,
      type: "enforcement",
      decision: data.decision,
    });
    this._metrics.enforcementEvents++;
    this._renderMessages();
    this._renderMetrics();
  }

  _updateRetries(data) {
    const tasks = data.tasks || {};
    this._metrics.escalations = Object.values(tasks).filter((t) => t.status === "escalated").length;
    this._renderMetrics();
  }

  // ── REST Fallback & Metrics ────────────────────────────────
  _pollMetrics() {
    const poll = () => {
      fetch(`${this.restServer}/api/metrics`)
        .then((r) => r.json())
        .then((data) => {
          this._metrics = { ...this._metrics, ...data };
          this._renderMetrics();
        })
        .catch(() => {});
    };
    poll();
    this._metricsTimer = setInterval(poll, 15000);
  }

  // ── Send Message ───────────────────────────────────────────
  _sendMessage() {
    const input = this.shadowRoot.getElementById("msg-input");
    const select = this.shadowRoot.getElementById("agent-select");
    const msg = input.value.trim();
    const agentId = select.value;
    if (!msg) return;

    input.value = "";
    input.focus();

    // ── Operator smart commands (natural language) ──
    if (agentId === "operator") {
      this._handleOperatorChat(msg);
      return;
    }

    // Add to local view immediately
    this._addMessage({
      agent: "ben",
      body: `→ ${agentId}: ${msg}`,
      timestamp: new Date().toISOString(),
      chat: `intervention-${agentId}`,
    });

    // Send via REST
    fetch(`${this.restServer}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, content: msg }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) {
          this._addMessage({
            agent: "system",
            body: `⚠️ Erro ao enviar: ${data.error || "falha desconhecida"}`,
            type: "enforcement",
          });
        }
      })
      .catch((err) => {
        this._addMessage({
          agent: "system",
          body: `⚠️ Erro de conexão: ${err.message}`,
          type: "enforcement",
        });
      });
  }

  // ── Operator Natural Language Handler ──────────────────────
  async _handleOperatorChat(msg) {
    const lower = msg.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const ts = new Date().toISOString();

    this._addMessage({ agent: "ben", body: `→ operator: ${msg}`, timestamp: ts, chat: "intervention-operator" });

    const reply = (text) => {
      this._addMessage({ agent: "operator", body: text, timestamp: new Date().toISOString(), chat: "intervention-operator" });
    };

    const operatorAPI = (endpoint, opts = {}) =>
      fetch(`${this.restServer}${endpoint}`, {
        method: opts.method || "GET",
        headers: opts.body ? { "Content-Type": "application/json" } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }).then(r => r.json());

    try {
      // ── GRAVAR / RECORD ──
      if (/gravar|record|grav|iniciar grav|comecar grav|capturar acoes/.test(lower)) {
        const urlMatch = msg.match(/https?:\/\/[^\s]+/);
        if (!urlMatch) {
          reply("🎬 Para iniciar a gravacao, informe a URL.\nExemplo: **gravar https://meu-sistema.com**");
          return;
        }
        reply(`🎬 Iniciando gravacao em ${urlMatch[0]}...\nInteraja com o site normalmente. Quando terminar, diga **parar gravacao**.`);
        const result = await operatorAPI("/api/operator/record/start", { method: "POST", body: { url: urlMatch[0] } });
        if (result.ok) {
          reply("✅ Gravador ativo! Barra vermelha **REC** apareceu no topo do browser.\n\n• Clique, digite, navegue normalmente\n• Diga **parar gravacao** quando terminar\n• Diga **status gravacao** para ver quantas acoes foram capturadas");
        } else {
          reply(`❌ Erro ao iniciar gravacao: ${result.error || "falha desconhecida"}`);
        }
        return;
      }

      // ── PARAR GRAVACAO ──
      if (/parar grav|stop rec|finalizar grav|encerrar grav|salvar grav/.test(lower)) {
        const nameMatch = msg.match(/(?:como|nome|salvar como)\s+["""]?([^"""]+)["""]?/i);
        const pbName = nameMatch ? nameMatch[1].trim() : `gravacao-${Date.now()}`;
        reply(`⏹ Parando gravacao e salvando como **${pbName}**...`);
        const result = await operatorAPI("/api/operator/record/stop", { method: "POST", body: { name: pbName } });
        if (result.ok) {
          reply(`✅ Gravacao salva!\n\n• **Nome:** ${pbName}\n• **Acoes capturadas:** ${result.stepsRecorded}\n• Para executar: diga **executar playbook ${result.playbook?.id || pbName}**\n• Para agendar: diga **agendar ${result.playbook?.id || pbName} seg 09:00**`);
        } else {
          reply(`❌ Erro: ${result.error || "Nenhuma gravacao ativa encontrada"}`);
        }
        return;
      }

      // ── STATUS GRAVACAO ──
      if (/status grav|quantas acoes|como.*grav/.test(lower)) {
        const result = await operatorAPI("/api/operator/record/status");
        if (result.recording) {
          reply(`🔴 Gravacao ativa — **${result.stepsCount} acoes** capturadas ate agora.`);
        } else if (result.browserRunning) {
          reply("ℹ️ Browser aberto mas sem gravacao ativa. Diga **gravar URL** para iniciar.");
        } else {
          reply("ℹ️ Nenhuma gravacao ativa. Browser nao esta rodando.");
        }
        return;
      }

      // ── LISTAR PLAYBOOKS ──
      if (/listar playbook|meus playbook|playbooks|quais playbook|ver playbook/.test(lower)) {
        const result = await operatorAPI("/api/operator/playbooks");
        if (!result.playbooks?.length) {
          reply("📋 Nenhum playbook salvo. Diga **gravar URL** para criar um novo.");
          return;
        }
        let text = `📋 **${result.playbooks.length} playbook(s) salvos:**\n\n`;
        for (const pb of result.playbooks) {
          const sched = pb.schedule ? ` ⏰ ${pb.schedule.cron || pb.schedule}` : "";
          const last = pb.lastRun ? ` (ultimo: ${new Date(pb.lastRun.at).toLocaleString("pt-BR")})` : "";
          text += `• **${pb.name}** (${pb.id}) — ${pb.stepsCount} acoes${sched}${last}\n`;
        }
        text += "\nDiga **executar playbook ID** para rodar.";
        reply(text);
        return;
      }

      // ── EXECUTAR PLAYBOOK ──
      if (/executar playbook|rodar playbook|run playbook|reproduzir|replay/.test(lower)) {
        const idMatch = msg.match(/(?:playbook|replay|reproduzir|executar|rodar)\s+([a-z0-9_-]+)/i);
        if (!idMatch) {
          reply("▶️ Informe o ID do playbook.\nExemplo: **executar playbook meu-fluxo**\nDiga **listar playbooks** para ver os disponiveis.");
          return;
        }
        const pbId = idMatch[1].toLowerCase();
        reply(`▶️ Executando playbook **${pbId}**...`);
        const result = await operatorAPI(`/api/operator/playbooks/${pbId}/run`, { method: "POST", body: {} });
        if (result.success) {
          reply(`✅ Playbook executado com sucesso!\n• **${result.completed}/${result.total} acoes** completadas`);
        } else {
          reply(`❌ Falha na acao ${result.completed + 1}/${result.total}: ${result.error}`);
        }
        return;
      }

      // ── AGENDAR PLAYBOOK ──
      if (/agendar|schedule|programar/.test(lower)) {
        const parts = msg.match(/(?:agendar|schedule|programar)\s+([a-z0-9_-]+)\s+(.+)/i);
        if (!parts) {
          reply("⏰ Formato: **agendar ID HORARIO**\nExemplos:\n• agendar meu-fluxo 09:00 (diario)\n• agendar meu-fluxo seg 08:30 (semanal)");
          return;
        }
        const [, pbId, cron] = parts;
        const result = await operatorAPI(`/api/operator/playbooks/${pbId}/schedule`, { method: "POST", body: { cron: cron.trim() } });
        if (result.ok) {
          reply(`✅ Playbook **${pbId}** agendado para **${cron.trim()}**`);
        } else {
          reply(`❌ Erro: ${result.error || "Playbook nao encontrado"}`);
        }
        return;
      }

      // ── DELETAR PLAYBOOK ──
      if (/deletar playbook|remover playbook|excluir playbook|apagar playbook/.test(lower)) {
        const idMatch = msg.match(/(?:deletar|remover|excluir|apagar)\s+playbook\s+([a-z0-9_-]+)/i);
        if (!idMatch) {
          reply("🗑 Informe o ID. Exemplo: **deletar playbook meu-fluxo**");
          return;
        }
        const result = await operatorAPI(`/api/operator/playbooks/${idMatch[1]}`, { method: "DELETE" });
        if (result.ok) {
          reply(`🗑 Playbook **${idMatch[1]}** deletado.`);
        } else {
          reply(`❌ ${result.error || "Playbook nao encontrado"}`);
        }
        return;
      }

      // ── ABRIR SITE ──
      if (/abrir|abra|acessar|navegar|acesse|entre em|va para|ir para|open/.test(lower)) {
        const urlMatch = msg.match(/https?:\/\/[^\s]+/);
        if (!urlMatch) {
          reply("🌐 Informe a URL. Exemplo: **abrir https://google.com**");
          return;
        }
        reply(`🌐 Abrindo ${urlMatch[0]}...`);
        const result = await operatorAPI("/api/operator/open", { method: "POST", body: { url: urlMatch[0] } });
        if (result.ok || result.title) {
          reply(`✅ Pagina aberta: **${result.title || urlMatch[0]}**`);
        } else {
          reply(`❌ Erro: ${result.error || "falha ao abrir"}`);
        }
        return;
      }

      // ── SCREENSHOT ──
      if (/screenshot|print|captura|capturar tela|foto da tela/.test(lower)) {
        const result = await operatorAPI("/api/operator/command", { method: "POST", body: { command: "screenshot", args: ["chat"] } });
        if (result.ok) {
          reply(`📸 Screenshot salvo: ${result.file}`);
        } else {
          reply(`❌ ${result.error || "Browser nao esta aberto"}`);
        }
        return;
      }

      // ── FECHAR BROWSER ──
      if (/fechar browser|fechar navegador|close browser|encerrar browser/.test(lower)) {
        const result = await operatorAPI("/api/operator/close", { method: "POST" });
        reply(result.ok ? "✅ Browser fechado." : `❌ ${result.error}`);
        return;
      }

      // ── STATUS ──
      if (/status.*operator|operator.*status|browser.*rodando|browser.*aberto/.test(lower)) {
        const result = await operatorAPI("/api/operator/status");
        const dResult = await operatorAPI("/api/operator/desktop/status");
        let text = result.running ? `✅ Browser rodando. Titulo: **${result.title || "N/A"}**` : "ℹ️ Browser nao esta rodando.";
        text += "\n" + (dResult.running ? `✅ Desktop server rodando.` : "ℹ️ Desktop server parado.");
        reply(text);
        return;
      }

      // ==================== DESKTOP COMMANDS ====================

      // ── ABRIR APP ──
      if (/abrir app|abrir programa|abrir aplicativo|executar programa|abrir o |abra o |open app|launch/.test(lower)) {
        const appMatch = msg.match(/(?:abrir|abra|executar|open|launch)\s+(?:o\s+|app\s+|programa\s+|aplicativo\s+)?(.+)/i);
        if (!appMatch) {
          reply("📦 Informe o nome do aplicativo.\nExemplo: **abrir app calculadora** ou **abrir app /usr/bin/gedit**");
          return;
        }
        const appName = appMatch[1].trim();
        reply(`📦 Abrindo **${appName}**...`);
        // Ensure desktop server is running
        await operatorAPI("/api/operator/desktop/start", { method: "POST" });
        const result = await operatorAPI("/api/operator/desktop/command", { method: "POST", body: { command: "open-app", args: [appName] } });
        if (result.ok) {
          reply(`✅ Aplicativo **${appName}** aberto.`);
        } else {
          reply(`❌ Erro: ${result.error || "nao foi possivel abrir"}`);
        }
        return;
      }

      // ── CLICAR DESKTOP (coordenadas) ──
      if (/clicar em (\d+)\s*[,x]\s*(\d+)|click (\d+)\s*[,x]\s*(\d+)/.test(lower)) {
        const m = lower.match(/(\d+)\s*[,x]\s*(\d+)/);
        if (m) {
          await operatorAPI("/api/operator/desktop/start", { method: "POST" });
          const result = await operatorAPI("/api/operator/desktop/command", { method: "POST", body: { command: "click", args: [m[1], m[2]] } });
          reply(result.ok ? `✅ Clicou em (${m[1]}, ${m[2]})` : `❌ ${result.error}`);
          return;
        }
      }

      // ── DIGITAR DESKTOP ──
      if (/digitar texto|type text|escrever texto/.test(lower)) {
        const textMatch = msg.match(/(?:digitar|type|escrever)\s+(?:texto\s+)?["""]?(.+?)["""]?\s*$/i);
        if (textMatch) {
          await operatorAPI("/api/operator/desktop/start", { method: "POST" });
          const result = await operatorAPI("/api/operator/desktop/command", { method: "POST", body: { command: "type-text", args: [textMatch[1]] } });
          reply(result.ok ? `✅ Texto digitado (${result.length || textMatch[1].length} chars)` : `❌ ${result.error}`);
          return;
        }
      }

      // ── TECLA / ATALHO ──
      if (/tecla |atalho |pressionar |key |hotkey /.test(lower)) {
        const keyMatch = msg.match(/(?:tecla|atalho|pressionar|key|hotkey)\s+(.+)/i);
        if (keyMatch) {
          await operatorAPI("/api/operator/desktop/start", { method: "POST" });
          const result = await operatorAPI("/api/operator/desktop/command", { method: "POST", body: { command: "key", args: [keyMatch[1].trim()] } });
          reply(result.ok ? `✅ Tecla **${keyMatch[1].trim()}** pressionada` : `❌ ${result.error}`);
          return;
        }
      }

      // ── LISTAR JANELAS ──
      if (/listar janelas|janelas abertas|window list|quais janelas/.test(lower)) {
        await operatorAPI("/api/operator/desktop/start", { method: "POST" });
        const result = await operatorAPI("/api/operator/desktop/command", { method: "POST", body: { command: "window-list", args: [] } });
        if (result.ok && result.windows?.length) {
          let text = `🪟 **${result.count} janela(s) aberta(s):**\n\n`;
          for (const w of result.windows) {
            const focus = w.focused ? " ⬅️" : "";
            text += `• **${w.title || "(sem titulo)"}** — ${w.wm_class || ""}${focus}\n`;
          }
          reply(text);
        } else {
          reply("ℹ️ Nenhuma janela encontrada ou GNOME Shell eval indisponivel.");
        }
        return;
      }

      // ── FOCAR JANELA ──
      if (/focar janela|focar no|focus window|mudar para janela|alternar para/.test(lower)) {
        const wMatch = msg.match(/(?:focar|focus|mudar para|alternar para)\s+(?:janela\s+|no\s+|na\s+)?(.+)/i);
        if (wMatch) {
          await operatorAPI("/api/operator/desktop/start", { method: "POST" });
          const result = await operatorAPI("/api/operator/desktop/command", { method: "POST", body: { command: "window-focus", args: [wMatch[1].trim()] } });
          reply(result.ok ? `✅ Janela **${wMatch[1].trim()}** focada.` : `❌ ${result.error}`);
          return;
        }
      }

      // ── SCREENSHOT DESKTOP ──
      if (/screenshot desktop|print desktop|captura desktop|foto da tela desktop|screenshot da tela/.test(lower)) {
        await operatorAPI("/api/operator/desktop/start", { method: "POST" });
        const result = await operatorAPI("/api/operator/desktop/command", { method: "POST", body: { command: "screenshot", args: ["desktop-chat"] } });
        reply(result.ok ? `📸 Screenshot desktop salvo: ${result.file}` : `❌ ${result.error}`);
        return;
      }

      // ── FECHAR DESKTOP SERVER ──
      if (/fechar desktop|parar desktop|close desktop/.test(lower)) {
        const result = await operatorAPI("/api/operator/desktop/close", { method: "POST" });
        reply(result.ok ? "✅ Desktop server encerrado." : `❌ ${result.error}`);
        return;
      }

      // ── HELP ──
      if (/ajuda|help|comandos|o que voce faz|como funciona/.test(lower)) {
        reply(`🖥 **Operator — Comandos disponiveis no chat:**

**🌐 Browser (sites e sistemas web):**
• **abrir URL** — Abre o browser numa pagina
• **gravar URL** — Inicia gravacao de acoes no site
• **parar gravacao** — Para e salva como playbook
• **status gravacao** — Quantas acoes capturadas
• **screenshot** — Capturar tela do browser

**📦 Desktop (aplicativos locais):**
• **abrir app NOME** — Abre aplicativo (ex: abrir app calculadora)
• **clicar em X,Y** — Clica em coordenadas na tela
• **digitar texto TEXTO** — Digita via teclado
• **tecla COMBO** — Atalho (ex: tecla ctrl+c, tecla alt+tab)
• **listar janelas** — Mostra janelas abertas
• **focar janela TITULO** — Traz janela para frente
• **screenshot desktop** — Captura tela inteira

**📋 Playbooks:**
• **listar playbooks** — Ver salvos
• **executar playbook ID** — Rodar
• **agendar ID HORARIO** — Programar (ex: seg 09:00)
• **deletar playbook ID** — Remover

• **status** — Status geral
• **fechar browser / desktop** — Encerrar`);
        return;
      }

      // ── Fallback ──
      reply(`🤔 Nao entendi. Diga **ajuda** para ver os comandos disponiveis.\n\nExemplos:\n• **gravar https://site.com** — gravar acoes no browser\n• **abrir app calculadora** — abrir programa do sistema\n• **listar playbooks** — ver playbooks salvos`);

    } catch (err) {
      reply(`❌ Erro de conexao: ${err.message}`);
    }
  }

  // ── Filtering ──────────────────────────────────────────────
  _getFilteredMessages() {
    return this._messages.filter((msg) => {
      if (this._filter.agent && msg.agent !== this._filter.agent) return false;
      if (this._filter.search) {
        const s = this._filter.search.toLowerCase();
        if (!msg.body.toLowerCase().includes(s) && !msg.agent.toLowerCase().includes(s)) return false;
      }
      return true;
    });
  }

  // ── Render ─────────────────────────────────────────────────
  _render() {
    this.shadowRoot.innerHTML = `
      <style>${AgentChatWidget.styles}</style>
      <div class="widget" id="widget">
        <header id="header">
          <div class="header-left">
            <span class="logo">🦞</span>
            <span class="title">Agent Chat</span>
            <span class="status-dot" id="status-dot"></span>
            <span class="status-text" id="status-text">Conectando...</span>
          </div>
          <div class="header-right">
            <span class="metric-badge" id="badge-agents">0 agentes</span>
            <span class="metric-badge" id="badge-msgs">0 msgs</span>
            <button class="btn-toggle" id="btn-toggle" title="Minimizar/Expandir">▾</button>
          </div>
        </header>

        <div class="body" id="body">
          <div class="filters" id="filters">
            <select id="filter-agent">
              <option value="">Todos os agentes</option>
            </select>
            <input type="text" id="filter-search" placeholder="Buscar..." />
          </div>

          <div class="messages" id="messages">
            <div class="empty-state" id="empty-state">
              <div class="empty-icon">🦞</div>
              <p>Aguardando mensagens entre agentes...</p>
            </div>
          </div>

          <div class="metrics-bar" id="metrics-bar">
            <span>Enforcement: <b id="m-enforcement">0</b></span>
            <span>Escalações: <b id="m-escalations">0</b></span>
            <span>WS: <b id="m-ws-clients">0</b></span>
          </div>

          <div class="input-bar">
            <select id="agent-select">
              <option value="maestro">maestro</option>
              <option value="sysdev">sysdev</option>
              <option value="coder">coder</option>
              <option value="clawdev">clawdev</option>
              <option value="designer">designer</option>
              <option value="sentinel">sentinel</option>
              <option value="scout">scout</option>
              <option value="finance">finance</option>
              <option value="analyst">analyst</option>
              <option value="flow">flow</option>
              <option value="ops">ops</option>
              <option value="terminal">terminal</option>
              <option value="operator">🖥 operator</option>
            </select>
            <input type="text" id="msg-input" placeholder="Enviar mensagem ao agente..." />
            <button id="btn-send">Enviar</button>
          </div>
        </div>
      </div>
    `;

    // Event listeners
    this.shadowRoot.getElementById("btn-toggle").addEventListener("click", () => {
      this._collapsed = !this._collapsed;
      this._updateCollapsed();
    });

    this.shadowRoot.getElementById("btn-send").addEventListener("click", () => this._sendMessage());
    this.shadowRoot.getElementById("msg-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._sendMessage();
    });

    this.shadowRoot.getElementById("filter-agent").addEventListener("change", (e) => {
      this._filter.agent = e.target.value;
      this._renderMessages();
    });

    this.shadowRoot.getElementById("filter-search").addEventListener("input", (e) => {
      this._filter.search = e.target.value;
      this._renderMessages();
    });

    this._updateStatus();
  }

  _updateStatus() {
    const dot = this.shadowRoot.getElementById("status-dot");
    const text = this.shadowRoot.getElementById("status-text");
    if (!dot || !text) return;

    if (this._connected) {
      dot.classList.add("online");
      dot.classList.remove("offline");
      text.textContent = "Conectado";
    } else {
      dot.classList.add("offline");
      dot.classList.remove("online");
      text.textContent = "Desconectado";
    }
  }

  _updateCollapsed() {
    const body = this.shadowRoot.getElementById("body");
    const btn = this.shadowRoot.getElementById("btn-toggle");
    if (!body) return;
    body.style.display = this._collapsed ? "none" : "flex";
    if (btn) btn.textContent = this._collapsed ? "▸" : "▾";
  }

  _renderMessages() {
    const container = this.shadowRoot.getElementById("messages");
    const emptyState = this.shadowRoot.getElementById("empty-state");
    if (!container) return;

    const filtered = this._getFilteredMessages();

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🦞</div>
          <p>${this._messages.length > 0 ? "Nenhuma mensagem com esse filtro" : "Aguardando mensagens..."}</p>
        </div>`;
      return;
    }

    // Render last 100 messages (virtualization simplified)
    const toRender = filtered.slice(-100);
    const html = toRender.map((msg) => {
      const isEnforcement = msg.type === "enforcement";
      const isBen = msg.agent === "ben";
      const cls = isEnforcement ? "msg enforcement" : isBen ? "msg sent" : "msg received";
      const badgeCls = msg.decision === "escalate" ? "badge-escalate" :
                       msg.decision === "retry" ? "badge-retry" :
                       msg.decision === "accept" ? "badge-accept" : "";

      const time = msg.timestamp ? msg.timestamp.split("T")[1]?.substring(0, 8) || "" : "";
      const bodyHtml = this._escapeHtml(msg.body).replace(/\n/g, "<br>");

      return `<div class="${cls} ${badgeCls}">
        <div class="msg-meta">
          <span class="msg-agent">${this._escapeHtml(msg.agent)}</span>
          <span class="msg-time">${time}</span>
        </div>
        <div class="msg-body">${bodyHtml}</div>
      </div>`;
    }).join("");

    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;

    // Update agent filter dropdown
    this._updateAgentFilter();

    // Update badges
    const ba = this.shadowRoot.getElementById("badge-agents");
    const bm = this.shadowRoot.getElementById("badge-msgs");
    if (ba) ba.textContent = `${this._agents.size} agentes`;
    if (bm) bm.textContent = `${this._messages.length} msgs`;
  }

  _renderMetrics() {
    const el = (id) => this.shadowRoot.getElementById(id);
    const e = el("m-enforcement");
    const s = el("m-escalations");
    const w = el("m-ws-clients");
    if (e) e.textContent = this._metrics.enforcementEvents || 0;
    if (s) s.textContent = this._metrics.escalations || 0;
    if (w) w.textContent = this._metrics.wsClients || 0;
  }

  _updateAgentFilter() {
    const select = this.shadowRoot.getElementById("filter-agent");
    if (!select) return;
    const current = select.value;
    const agents = [...this._agents].sort();
    const opts = ['<option value="">Todos os agentes</option>']
      .concat(agents.map((a) => `<option value="${a}" ${a === current ? "selected" : ""}>${a}</option>`));
    select.innerHTML = opts.join("");
  }

  _escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
  }

  // ── Styles ─────────────────────────────────────────────────
  static get styles() {
    return `
      :host {
        display: block;
        font-family: var(--font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
        font-size: 13px;
        --bg: var(--sl-color-neutral-900, #0d1117);
        --bg2: var(--sl-color-neutral-1000, #161b22);
        --bg3: #21262d;
        --border: #30363d;
        --text: #e6edf3;
        --text2: #8b949e;
        --cyan: #58a6ff;
        --green: #3fb950;
        --magenta: #bc8cff;
        --yellow: #d29922;
        --red: #f85149;
        --orange: #d18616;
        --radius: var(--radius-md, 8px);
      }

      * { margin: 0; padding: 0; box-sizing: border-box; }

      .widget {
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 200px;
      }

      header {
        background: var(--bg2);
        border-bottom: 1px solid var(--border);
        padding: 8px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        user-select: none;
      }

      .header-left, .header-right {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .logo { font-size: 16px; }
      .title { font-weight: 600; color: var(--cyan); font-size: 13px; }

      .status-dot {
        width: 8px; height: 8px; border-radius: 50%;
        display: inline-block;
      }
      .status-dot.online { background: var(--green); }
      .status-dot.offline { background: var(--red); }
      .status-text { color: var(--text2); font-size: 11px; }

      .metric-badge {
        font-size: 10px;
        color: var(--text2);
        background: var(--bg3);
        padding: 2px 8px;
        border-radius: 10px;
      }

      .btn-toggle {
        background: none; border: none; color: var(--text2);
        font-size: 14px; cursor: pointer; padding: 2px 6px;
      }
      .btn-toggle:hover { color: var(--text); }

      .body {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }

      .filters {
        display: flex;
        gap: 6px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
        background: var(--bg2);
      }

      .filters select, .filters input {
        background: var(--bg3);
        color: var(--text);
        border: 1px solid var(--border);
        padding: 4px 8px;
        border-radius: 4px;
        font-family: inherit;
        font-size: 11px;
        outline: none;
      }
      .filters input { flex: 1; }
      .filters input:focus, .filters select:focus { border-color: var(--cyan); }

      .messages {
        flex: 1;
        overflow-y: auto;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-height: 100px;
      }

      .msg {
        max-width: 90%;
        padding: 6px 10px;
        border-radius: 6px;
        line-height: 1.4;
        border-left: 3px solid var(--border);
        background: var(--bg3);
      }

      .msg.sent {
        align-self: flex-end;
        background: #0d419d;
        border-left-color: #1f6feb;
        border-right: 3px solid #1f6feb;
        border-left: none;
      }

      .msg.enforcement {
        border-left-color: var(--orange);
        background: rgba(209, 134, 22, 0.1);
      }

      .msg.badge-escalate { border-left-color: var(--red); background: rgba(248, 81, 73, 0.1); }
      .msg.badge-retry { border-left-color: var(--yellow); }
      .msg.badge-accept { border-left-color: var(--green); }

      .msg-meta {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 2px;
      }

      .msg-agent { font-weight: 600; color: var(--magenta); font-size: 11px; }
      .msg.sent .msg-agent { color: var(--green); }
      .msg.enforcement .msg-agent { color: var(--orange); }
      .msg-time { color: var(--text2); font-size: 10px; }

      .msg-body {
        color: var(--text);
        word-break: break-word;
        font-size: 12px;
      }

      .metrics-bar {
        display: flex;
        gap: 16px;
        padding: 4px 10px;
        font-size: 10px;
        color: var(--text2);
        background: var(--bg2);
        border-top: 1px solid var(--border);
      }
      .metrics-bar b { color: var(--cyan); }

      .input-bar {
        display: flex;
        gap: 6px;
        padding: 8px 10px;
        border-top: 1px solid var(--border);
        background: var(--bg2);
      }

      .input-bar select {
        background: var(--bg3);
        color: var(--text);
        border: 1px solid var(--border);
        padding: 6px 8px;
        border-radius: 4px;
        font-family: inherit;
        font-size: 11px;
      }

      .input-bar input {
        flex: 1;
        background: var(--bg3);
        color: var(--text);
        border: 1px solid var(--border);
        padding: 6px 8px;
        border-radius: 4px;
        font-family: inherit;
        font-size: 12px;
        outline: none;
      }
      .input-bar input:focus { border-color: var(--cyan); }

      .input-bar button {
        background: #238636;
        color: white;
        border: none;
        padding: 6px 14px;
        border-radius: 4px;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .input-bar button:hover { background: #2ea043; }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 24px;
        color: var(--text2);
        gap: 6px;
      }
      .empty-icon { font-size: 36px; opacity: 0.3; }
      .empty-state p { font-size: 12px; }

      .messages::-webkit-scrollbar { width: 4px; }
      .messages::-webkit-scrollbar-track { background: var(--bg); }
      .messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
    `;
  }
}

customElements.define("agent-chat-widget", AgentChatWidget);
