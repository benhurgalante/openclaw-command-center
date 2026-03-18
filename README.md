# OpenClaw Command Center

Dashboard web e APIs do ecossistema OpenClaw — gestao de agentes IA, CRM, financeiro, automacao e integracao com sistema de cartorio (ServCom).

## Arquitetura

```
Browser (localhost:18790)
    |
    +-- dashboard-demo.html (SPA)
    |
    +-- agent-chat-server (Node.js, porta 18790)
         |
         +-- api-core.js        (health, config, logs)
         +-- api-crm.js         (empresas, contatos, deals)
         +-- api-fin.js         (transacoes, conciliacao)
         +-- api-data-unifier.js (ETL: CSV, XLSX, PDF, APIs)
         +-- api-reconciliation.js (conciliacao bancaria)
         +-- api-rag.js         (knowledge base, embeddings)
         +-- api-operator.js    (browser + desktop automation)
         +-- api-growth.js      (metricas, funil)
         +-- db.js              (PostgreSQL connection)
         +-- crypto-utils.js    (criptografia)
         +-- mini-router.js     (roteador HTTP leve)
```

## Quick Start

```bash
# Instalar dependencias
npm install

# Configurar banco (PostgreSQL)
export DATABASE_URL=postgres://user:pass@localhost:5432/openclaw

# Iniciar
node agent-chat-server
# Dashboard em http://localhost:18790
```

## Modulos

| Modulo | Descricao |
|---|---|
| **Dashboard** | SPA com 15+ abas: agentes, CRM, financeiro, RAG, automacao |
| **Data Unifier** | ETL unificado: CSV, XLSX, PDF, APIs, directories |
| **Conciliacao** | Match automatico de transacoes bancarias (OFX/CSV) |
| **Operator** | Automacao de browser (Playwright) e desktop (xdotool) |
| **CRM** | Gestao de empresas, contatos e deals |
| **RAG** | Knowledge base com busca semantica |

## ServCom (Cartorio)

Integracao com sistema de cartorio InterSystems Cache/IRIS:

- `servcom-reverse/` — relatorio de engenharia reversa (1.492 classes mapeadas)
- `servcom-docker/` — Docker Compose com IRIS Community Edition

```bash
cd servcom-docker
docker compose up -d
```

## Requisitos

- Node.js 20+
- PostgreSQL 15+
- Docker (para ServCom)
