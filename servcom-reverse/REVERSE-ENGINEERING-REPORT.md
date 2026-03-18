# ServCom - Relatório de Engenharia Reversa
**Data:** 2026-03-17
**Versão Caché:** 2009.1.3 (Build 704) - Windows Server 2016
**IP Servidor:** 192.168.1.32

## 1. Visão Geral

O ServCom é um **sistema de cartório** (serventia extrajudicial) para Registro de Imóveis, Títulos e Documentos, e Pessoa Jurídica. Roda em InterSystems Caché com frontend web via CSP (Caché Server Pages) + Flash/JavaScript.

### Namespaces
| Namespace | Sigla | Função | Globals (dados) | Routines (código) |
|---|---|---|---|---|
| RTD | Registro de Títulos e Documentos | Principal | 2.7 GB | 144 MB |
| RPJ | Registro de Pessoa Jurídica | Secundário | 1.2 GB | 21 MB |
| RTDTESTE | Teste RTD | Homologação | - | - |

## 2. Arquitetura do Sistema

```
┌─ Browser (IE8+) ──────────────────────────────────┐
│  Flash SWF (comunicador)  ←→  JavaScript (MooTools)│
│  CSP Pages renderizadas pelo Caché                 │
└────────────────────┬───────────────────────────────┘
                     │ HTTP (porta 57772)
┌────────────────────▼───────────────────────────────┐
│  InterSystems Caché (porta 1972)                    │
│                                                     │
│  CSP Gateway → csp.flash (dispatcher)               │
│       ↓                                             │
│  csp.flash.Call() → carrega vars de ^WRKVAR         │
│       ↓                                             │
│  D @PROGRAMA → executa rotina ObjectScript          │
│       ↓                                             │
│  ^%XML → resposta XML pro browser                   │
│                                                     │
│  Páginas:                                           │
│  - csp.html      → página HTML genérica             │
│  - csp.formulario → impressão de formulários        │
│  - csp.editor    → editor de textos (TinyMCE)       │
│  - csp.tela      → telas XML dinâmicas              │
│  - csp.relatorio → relatórios                       │
│  - csp.imagem    → visualizador de imagens          │
│  - csp.pdf       → geração de PDFs                  │
└─────────────────────────────────────────────────────┘
```

### Fluxo de Requisição
1. Browser envia request para `csp.flash.cls?ROTINA=XXX&CAMPO=YYY`
2. `csp.flash.Call()` carrega variáveis de sessão de `^WRKVAR(%SID,...)`
3. Executa `D @PROGRAMA` onde PROGRAMA é construído a partir de ROTINA+CAMPO
4. Rotina ObjectScript popula `%XML(n)` com XML de resposta
5. CSP retorna XML para o browser
6. JavaScript (Flash bridge) processa a resposta e atualiza a UI

### Tecnologias Frontend
- **MooTools 1.21** — framework JavaScript principal
- **TinyMCE** — editor de texto rico (para atos/documentos)
- **Flash SWF** — comunicação bidirecional browser↔servidor (legado)
- **CSS custom** — formulário, editor, processando, context menu
- **QR Code** — geração client-side (qrcode.min.js)

## 3. Modelo de Dados (Classes Persistentes)

### 3.1 ArquivoPessoal (rgi.ArquivoPessoal)
**Cadastro de pessoas físicas e jurídicas**
- Global: `^rgi.ArquivoPessoalD` (storage padrão CacheStorage)
- Chave: Ficha (Integer)

| Campo | Tipo | Descrição |
|---|---|---|
| Ficha | Integer | Nº da ficha (PK) |
| Nome | String(300) | Nome / Razão Social |
| TipoPessoa | Char(1) | F=Física, J=Jurídica |
| Sexo | Char(1) | M/F |
| DataNascimento | Date | |
| Nacionalidade | String(15) | |
| Profissao | String(80) | |
| EstadoCivil | String(2) | |
| RegimeCasamento | Integer | |
| DataCasamento | Date | |
| Conjuge | String(100) | Nome ou nº ficha |
| Filiacao | String(100) | Pais |
| Endereco | String(100) | |
| Bairro | String(50) | |
| Cidade | String(50) | |
| UF | Char(2) | |
| CEP | String(8) | |

### 3.2 ArquivoReal (rgi.ArquivoReal)
**Cadastro de imóveis/bens registrados**
- Global: `^CTIMV` (storage SQL customizado)
- Chave: Codigo (String - formato variável por livro)

| Campo | Tipo | Piece | Descrição |
|---|---|---|---|
| Codigo | String(20) | Key | Matrícula ou Livro/Reg |
| TipoLogradouro | String(15) | 1 | FK → rgi.TipoLogradouro |
| CodigoLogradouro | Integer | 2 | FK → rgi.Logradouro |
| Numero | String(10) | 3 | Nº endereço |
| TipoUnidade | String(2) | 4 | FK → rgi.TipoUnidade |
| Unidade | String(6) | 5 | Nº unidade |
| Bloco | String(6) | 6 | |
| Vaga | String(15) | 7 | Garagem |
| Complemento | String(80) | 8 | |
| CodigoBairro | Integer | 9 | FK → rgi.Bairro |
| Quadra | String(10) | 10 | |
| Lote | String(30) | 11 | |
| Secao | String(30) | 12 | |
| InscricaoMunicipal | String(30) | 13 | IPTU |
| TipoCondominio | String(30) | 14 | |
| Condominio | String(100) | 15 | |
| Area | String(16) | 16 | Área total |
| UnidadeMedida | String(4) | 17 | m², ha, etc |
| FracaoIdeal | String(16) | 18 | |
| CodigoAuxiliar | String(10) | 19 | |
| IndiceAuxiliar | String(30) | 20 | Urbano |
| Municipio | String(30) | 21 | |
| NomeArea | String(60) | 22 | Fazenda/Sítio |
| IndiceRural | String(30) | 23 | |
| Usuario | Integer | 24 | Último editor |
| Localizacao | Char(1) | 25 | U=Urbano, R=Rural |

### 3.3 Tabelas Auxiliares
| Classe | Global | Descrição |
|---|---|---|
| rgi.Abreviatura | ^CTABREV | Abreviaturas de logradouros |
| rgi.Bairro | - | Cadastro de bairros |
| rgi.Logradouro | - | Cadastro de logradouros |
| rgi.TipoLogradouro | - | Tipos (Rua, Av, etc) |
| rgi.TipoUnidade | - | Tipos (Apt, Sala, etc) |
| rgi.TipoCondominio | - | Tipos de condomínio |
| rgi.UnidadeMedida | - | m², ha, alqueire |
| rgi.LogradouroDivisa | - | Divisas de logradouros |

### 3.4 Imagens e Documentos (img.*)
| Classe | Descrição |
|---|---|
| img.Matricula | Imagens de matrículas |
| img.Certidao | Imagens de certidões |
| img.Documento | Documentos digitalizados |
| img.Fichapessoal | Fichas de pessoa |
| img.Fichareal | Fichas de imóvel |
| img.Livrofolha | Livro/folha |
| img.Processo | Processos |
| img.Protocolo | Protocolos |
| img.Firma | Fichas de firma |
| img.Sinal | Sinais públicos |
| img.Carimbo | Carimbos |

### 3.5 Anexos (anx.*)
| Classe | Descrição |
|---|---|
| anx.Arquivo | Arquivos anexados |
| anx.Tipo | Tipos de anexo |
| anx.Auditoria | Log de auditoria de anexos |

## 4. Globals Importantes (Variáveis Globais)

| Global | Uso |
|---|---|
| ^%USU(%SES) | Dados da sessão do usuário |
| ^WRKVAR(%SID,...) | Variáveis de trabalho por sessão/janela |
| ^SVCFGFLASH | Configuração de paths (URL, temp, rede) |
| ^CTIMV | Arquivo Real (imóveis) |
| ^CTABREV | Abreviaturas |
| ^CTPARAM | Parâmetros do sistema |
| ^CTFONTE | Fontes cadastradas |
| ^%USPAPEL | Config de papel/impressão |
| ^NOTMENU | Menu de Notas |
| ^FRPDF | Variáveis de geração PDF |

## 5. Módulos e Integrações (1.492 classes RTD)

### 5.1 Core do Sistema
| Namespace | Classes | Função |
|---|---|---|
| csp.* | 19 | Frontend web (CSP pages) |
| rgi.* | 22 | Registro Geral de Imóveis |
| img.* | 31 | Gestão de imagens |
| anx.* | 5 | Anexos |
| svc.* | 21 | Serviços internos |

### 5.2 Web Services / Integrações
| Namespace | Classes | Integração |
|---|---|---|
| WSCRIMG.* | 446 | WS Central de Registro de Imagens |
| WSCRIMGv1/v2.* | 223 | Versões 1 e 2 |
| WSOficio.* | 323 | WS de Ofícios |
| DajeWSService.* | 67 | DAJE (taxas judiciárias RJ) |
| SeloWSService.* | 52 | Selo Eletrônico Digital |
| ParametrosWSService.* | 34 | WS de Parâmetros |
| ARIRJ.* | 22 | ARISP/ARIRJ (Central RJ) |
| CORIBR.* | 15 | CORI-BR (Central Nacional) |
| Service.* | 27 | Endpoints de autenticação |
| WSServcom.* | 9 | Interligação ServCom |
| SREI.* | - | Registro Eletrônico de Imóveis |
| ONR.* | - | Operador Nacional de Registro |
| Net.MQTT.* | 11 | Mensageria MQTT |

### 5.3 Bibliotecas Embarcadas
| Namespace | Função |
|---|---|
| Gma.QrCodeNet.* | Geração de QR Codes |
| HtmlAgilityPack.* | Parser HTML |
| itextsharp.* | Geração de PDF |
| BigIntegerLibrary.* | Matemática de precisão |
| ServImageLib.* | Conversão de imagens TIFF |

## 6. Frontend JavaScript

### Arquivos Principais (scripts-rtd/)
| Arquivo | Tamanho | Função |
|---|---|---|
| formulario.js | 88 KB | Classe de formulário paginável (impressão) |
| jscript_tools.js | 46 KB | MooTools + utilitários (minificado) |
| servcom_busca.js | 4 KB | Sistema de busca/pesquisa |
| teclas_navegacao.js | 7 KB | Navegação por teclado |
| atalhos.js | 6 KB | Atalhos de teclado (Ctrl+combinações) |
| mascaras.js | 2 KB | Máscaras de input (CPF, data, etc) |
| visualizador_imagens.js | 12 KB | Visualizador de imagens TIFF |
| editor_modelos.js | - | Modelos de documentos |
| carimbo.js | - | Gestão de carimbos em documentos |
| recorte_tool.js | - | Recorte de imagens |
| panorama.js | - | Visualização panorâmica |
| context_menu.js | - | Menu de contexto |
| processando.js | - | Tela de "processando..." |
| window_class.js | - | Classe de janelas popup |

### CSS
| Arquivo | Função |
|---|---|
| formulario.css | Layout do formulário de impressão |
| editor.css | Estilos do editor TinyMCE |
| processando.css | Animação de loading |
| context_menu.css | Menu de contexto |
| acesso_programador.css | Ferramentas de debug |
| visualizador_imagens.css | Viewer de imagens |

## 7. Selo Eletrônico
- 2.341 XMLs de selos eletrônicos em `/SELO_ELETRONICO/Baixados/`
- Classe `SeloEletronico.selo` para gestão
- Integração com `SeloWSService` para comunicação com central

## 8. Dados Legados (CTERM/Dados Legados/)
- CSVs de Títulos e Documentos desde 2020
- PDFs de relatórios desde 2023
- Backups GOF históricos

## 9. Arquivos de Rotina Compilados
| Arquivo | Namespace | Descrição |
|---|---|---|
| all-sv-us-obj.xml | Exports | Rotinas SV/US compiladas (OBJ) |
| pUSLOGIN.xml | Exports | Rotina de login |
| svmenu.xml | Exports | Menu do sistema |
| CACHE.DAT (RTN/) | RPJ/RTD | Databases de rotinas |
| CACHE.DAT (GBL/) | RPJ/RTD | Databases de globals |

## 10. Plano de Reconstrução

### Fase 2: Migração para IRIS Community (Docker)
1. Configurar container IRIS Community
2. Importar XMLs de classes (classes-namespace-RTD-export.xml)
3. Importar globals via GOF (BKP-RTD-GLOB.GOF = 1.5GB)
4. Configurar CSP application
5. Testar acesso web

### Fase 3: API REST Moderna
1. Mapear todas as globals → tabelas SQL via classes
2. Criar REST API (Node.js ou direto no IRIS)
3. Endpoints: ArquivoPessoal, ArquivoReal, Protocolos, Certidões
4. Autenticação moderna (JWT)

### Fase 4: Frontend Moderno
1. Substituir Flash por WebSocket/REST
2. Substituir MooTools por React/Vue
3. Manter TinyMCE (editor de atos)
4. UI responsiva (Bootstrap/Tailwind)
5. Dashboard integrado com Command Center

### Fase 5: Novas Funcionalidades
1. Busca full-text em todos os registros
2. OCR para documentos digitalizados
3. Assinatura digital moderna (ICP-Brasil)
4. Integração OpenClaw (agentes IA para consultas)
5. Dashboard analítico (métricas do cartório)
6. API pública para consultas externas
7. Mobile-friendly
