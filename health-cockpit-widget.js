// health-cockpit-widget.js — Web Component for OpenClaw Health Cockpit
// Shows unified system health: gateway, agents, sessions, enforcement, updates
//
// Usage: <health-cockpit-widget server="http://localhost:18790"></health-cockpit-widget>

class HealthCockpitWidget extends HTMLElement {
  static get observedAttributes() {
    return ["server", "collapsed"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null;
    this._metrics = null;
    this._loading = true;
    this._error = null;
    this._collapsed = false;
  }

  get server() {
    return this.getAttribute("server") || "http://localhost:18790";
  }

  connectedCallback() {
    this._render();
    this._fetchAll();
    this._pollTimer = setInterval(() => this._fetchAll(), 30000);
  }

  disconnectedCallback() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  async _fetchAll() {
    try {
      const [statusRes, metricsRes, retriesRes, enforcementRes, slosRes] = await Promise.all([
        fetch(`${this.server}/api/status`),
        fetch(`${this.server}/api/metrics`),
        fetch(`${this.server}/api/retries`),
        fetch(`${this.server}/api/enforcement`),
        fetch(`${this.server}/api/slos`),
      ]);

      this._data = await statusRes.json();
      this._metrics = await metricsRes.json();
      this._retries = await retriesRes.json();
      this._enforcement = await enforcementRes.json();
      this._slos = await slosRes.json();
      this._loading = false;
      this._error = null;
    } catch (err) {
      this._loading = false;
      this._error = err.message;
    }
    this._renderContent();
  }

  _statusColor(ok) {
    return ok ? "var(--green)" : "var(--red)";
  }

  _statusLabel(ok) {
    return ok ? "OK" : "OFFLINE";
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>${HealthCockpitWidget.styles}</style>
      <div class="cockpit" id="cockpit">
        <header id="header">
          <div class="header-left">
            <span class="title">Health Cockpit</span>
          </div>
          <div class="header-right">
            <span class="refresh-btn" id="refresh-btn" title="Atualizar">↻</span>
            <button class="btn-toggle" id="btn-toggle">▾</button>
          </div>
        </header>
        <div class="body" id="body">
          <div class="loading">Carregando status...</div>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById("refresh-btn").addEventListener("click", () => {
      this._loading = true;
      this._renderContent();
      this._fetchAll();
    });

    this.shadowRoot.getElementById("btn-toggle").addEventListener("click", () => {
      this._collapsed = !this._collapsed;
      const body = this.shadowRoot.getElementById("body");
      const btn = this.shadowRoot.getElementById("btn-toggle");
      body.style.display = this._collapsed ? "none" : "block";
      btn.textContent = this._collapsed ? "▸" : "▾";
    });
  }

  _renderContent() {
    const body = this.shadowRoot.getElementById("body");
    if (!body) return;

    if (this._loading) {
      body.innerHTML = '<div class="loading">Carregando status...</div>';
      return;
    }

    if (this._error) {
      body.innerHTML = `<div class="error-banner">⚠️ Erro: ${this._esc(this._error)}</div>`;
      return;
    }

    const d = this._data || {};
    const m = this._metrics || {};
    const r = this._retries || {};
    const e = this._enforcement || [];

    const gw = d.gateway || {};
    const upd = d.update || {};
    const agents = d.agents || {};

    // Compute enforcement summary
    const enfLast5 = e.slice(-5).reverse();
    const escalations = Object.values(r.tasks || {}).filter((t) => t.status === "escalated").length;
    const activeRetries = Object.values(r.tasks || {}).filter(
      (t) => t.status === "active" || t.status === "retrying"
    ).length;

    body.innerHTML = `
      <!-- Status Cards Row -->
      <div class="cards-row">
        <div class="card">
          <div class="card-label">Gateway</div>
          <div class="card-value" style="color: ${this._statusColor(gw.reachable)}">
            ${this._statusLabel(gw.reachable)}
          </div>
          <div class="card-sub">${gw.latencyMs ? gw.latencyMs + "ms" : "—"} latency</div>
        </div>

        <div class="card">
          <div class="card-label">Agentes</div>
          <div class="card-value">${agents.total || 0}</div>
          <div class="card-sub">${agents.heartbeatEnabled || 0} com heartbeat</div>
        </div>

        <div class="card">
          <div class="card-label">Sessões</div>
          <div class="card-value">${d.sessions?.count || 0}</div>
          <div class="card-sub">Default: ${agents.defaultAgent || "—"}</div>
        </div>

        <div class="card">
          <div class="card-label">Mensagens</div>
          <div class="card-value">${m.totalMessages || 0}</div>
          <div class="card-sub">${m.totalChats || 0} chats hoje</div>
        </div>
      </div>

      <!-- Version & Update -->
      <div class="section">
        <div class="section-header">Versão</div>
        <div class="version-row">
          <span>Atual: <b>${this._esc(upd.current || "?")}</b></span>
          ${upd.updateAvailable
            ? `<span class="badge badge-warn">Update: ${this._esc(upd.latest)}</span>`
            : '<span class="badge badge-ok">Atualizado</span>'}
        </div>
        <div class="detail-row">
          <span>Host: ${this._esc(gw.host || "?")}</span>
          <span>${this._esc(gw.platform || "")}</span>
        </div>
      </div>

      <!-- Enforcement Gate -->
      <div class="section">
        <div class="section-header">Enforcement Gate</div>
        <div class="cards-row compact">
          <div class="card mini">
            <div class="card-label">Eventos</div>
            <div class="card-value small">${m.enforcementEvents || 0}</div>
          </div>
          <div class="card mini">
            <div class="card-label">Retries Ativos</div>
            <div class="card-value small" style="color: ${activeRetries > 0 ? "var(--yellow)" : "var(--text2)"}">${activeRetries}</div>
          </div>
          <div class="card mini">
            <div class="card-label">Escalações</div>
            <div class="card-value small" style="color: ${escalations > 0 ? "var(--red)" : "var(--text2)"}">${escalations}</div>
          </div>
          <div class="card mini">
            <div class="card-label">WS Clients</div>
            <div class="card-value small">${m.wsClients || 0}</div>
          </div>
        </div>
      </div>

      <!-- SLOs -->
      ${this._slos ? `
      <div class="section">
        <div class="section-header">SLOs — Agent Chat Server</div>
        <div class="cards-row compact">
          <div class="card mini">
            <div class="card-label">p50 Latency</div>
            <div class="card-value small">${this._slos.latency?.p50 || "—"}</div>
          </div>
          <div class="card mini">
            <div class="card-label">p95 Latency</div>
            <div class="card-value small" style="color: ${this._slos.alerts?.highLatency ? "var(--red)" : "var(--green)"}">${this._slos.latency?.p95 || "—"}</div>
          </div>
          <div class="card mini">
            <div class="card-label">Error Rate</div>
            <div class="card-value small" style="color: ${this._slos.alerts?.highErrorRate ? "var(--red)" : "var(--green)"}">${this._slos.requests?.errorRate || "—"}</div>
          </div>
          <div class="card mini">
            <div class="card-label">Uptime</div>
            <div class="card-value small">${this._slos.uptime?.human || "—"}</div>
          </div>
        </div>
      </div>` : ""}

      <!-- Messages by Agent -->
      <div class="section">
        <div class="section-header">Mensagens por Agente</div>
        <div class="agent-bars">
          ${this._renderAgentBars(m.messagesByAgent || {})}
        </div>
      </div>

      <!-- Recent Enforcement -->
      ${enfLast5.length > 0 ? `
      <div class="section">
        <div class="section-header">Enforcement Recente</div>
        <div class="enforcement-list">
          ${enfLast5.map((ev) => `
            <div class="enf-item ${ev.decision || ""}">
              <span class="enf-decision">${this._esc((ev.decision || "?").toUpperCase())}</span>
              <span class="enf-agent">${this._esc(ev.agentId || ev.agent || "?")}</span>
              <span class="enf-reason">${this._esc(ev.reason_code || "")}</span>
            </div>
          `).join("")}
        </div>
      </div>` : ""}

      <div class="footer">
        Atualizado: ${new Date().toLocaleTimeString("pt-BR")} | Refresh: 30s
      </div>
    `;
  }

  _renderAgentBars(byAgent) {
    const entries = Object.entries(byAgent).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return '<div class="empty">Nenhuma mensagem</div>';
    const max = entries[0][1];

    return entries.map(([agent, count]) => {
      const pct = Math.round((count / max) * 100);
      return `
        <div class="agent-bar-row">
          <span class="agent-name">${this._esc(agent)}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width: ${pct}%"></div>
          </div>
          <span class="agent-count">${count}</span>
        </div>`;
    }).join("");
  }

  _esc(text) {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
  }

  static get styles() {
    return `
      :host {
        display: block;
        font-family: var(--font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
        font-size: 13px;
        --bg: #0d1117;
        --bg2: #161b22;
        --bg3: #21262d;
        --border: #30363d;
        --text: #e6edf3;
        --text2: #8b949e;
        --cyan: #58a6ff;
        --green: #3fb950;
        --yellow: #d29922;
        --red: #f85149;
        --orange: #d18616;
        --radius: 8px;
      }

      * { margin: 0; padding: 0; box-sizing: border-box; }

      .cockpit {
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        overflow: hidden;
      }

      header {
        background: var(--bg2);
        border-bottom: 1px solid var(--border);
        padding: 8px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .header-left, .header-right { display: flex; align-items: center; gap: 8px; }
      .title { font-weight: 600; color: var(--cyan); font-size: 13px; }

      .refresh-btn {
        cursor: pointer; color: var(--text2); font-size: 16px;
        padding: 2px 4px; border-radius: 4px;
      }
      .refresh-btn:hover { color: var(--text); background: var(--bg3); }

      .btn-toggle {
        background: none; border: none; color: var(--text2);
        font-size: 14px; cursor: pointer; padding: 2px 6px;
      }

      .body { padding: 12px; }

      .loading, .error-banner {
        text-align: center; padding: 20px; color: var(--text2);
      }
      .error-banner { color: var(--red); background: rgba(248,81,73,0.1); border-radius: 6px; }

      .cards-row {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-bottom: 12px;
      }
      .cards-row.compact { grid-template-columns: repeat(4, 1fr); }

      .card {
        background: var(--bg2);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 10px;
        text-align: center;
      }
      .card.mini { padding: 6px 8px; }

      .card-label { font-size: 10px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
      .card-value { font-size: 22px; font-weight: 700; color: var(--green); }
      .card-value.small { font-size: 16px; }
      .card-sub { font-size: 10px; color: var(--text2); margin-top: 2px; }

      .section {
        margin-bottom: 12px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--border);
      }
      .section:last-of-type { border-bottom: none; }

      .section-header {
        font-size: 11px;
        color: var(--text2);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
        font-weight: 600;
      }

      .version-row, .detail-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        color: var(--text);
        margin-bottom: 4px;
      }
      .detail-row { font-size: 11px; color: var(--text2); }

      .badge {
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 10px;
        font-weight: 600;
      }
      .badge-ok { background: #0d2818; color: var(--green); border: 1px solid #238636; }
      .badge-warn { background: #2d1b00; color: var(--yellow); border: 1px solid #9e6a03; }

      .agent-bars { display: flex; flex-direction: column; gap: 4px; }
      .agent-bar-row {
        display: grid;
        grid-template-columns: 80px 1fr 40px;
        align-items: center;
        gap: 8px;
        font-size: 11px;
      }
      .agent-name { color: var(--text); font-weight: 500; text-align: right; }
      .agent-count { color: var(--cyan); font-weight: 600; text-align: right; }
      .bar-track { height: 6px; background: var(--bg3); border-radius: 3px; overflow: hidden; }
      .bar-fill { height: 100%; background: var(--cyan); border-radius: 3px; transition: width 0.3s; }

      .enforcement-list { display: flex; flex-direction: column; gap: 4px; }
      .enf-item {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 4px;
        background: var(--bg2);
        border-left: 3px solid var(--border);
      }
      .enf-item.accept { border-left-color: var(--green); }
      .enf-item.retry { border-left-color: var(--yellow); }
      .enf-item.escalate { border-left-color: var(--red); }
      .enf-decision { font-weight: 700; min-width: 70px; }
      .enf-agent { color: var(--cyan); }
      .enf-reason { color: var(--text2); flex: 1; text-align: right; }

      .empty { color: var(--text2); font-size: 11px; text-align: center; padding: 8px; }

      .footer {
        text-align: center;
        font-size: 10px;
        color: var(--text2);
        padding: 8px 0 4px;
      }
    `;
  }
}

customElements.define("health-cockpit-widget", HealthCockpitWidget);
