# BioAgents — Estado Actual de la Plataforma

> **Documento de estado interno** (junio 2026) — qué pueden hacer los usuarios hoy, qué no, y qué viene.

## TL;DR

BioAgents es un **AI Scientist Framework** para bioprospecting. Los usuarios suben papers científicos, el sistema extrae datos estructurados (compuestos, actividades biológicas, claims), detecta contradicciones entre papers, deduplica findings repetidos, y deja al investigador navegar **hasta el párrafo, tabla o figura exactos** de donde viene cada claim. La plataforma **acumula conocimiento verificable** a lo largo de miles de papers, con cada claim linkeado a su evidencia concreta.

---

## Estado Actual — Qué Pueden Hacer los Usuarios HOY

### ✅ Funcional (en producción)

| Feature | Qué hace | Cómo se usa |
|---|---|---|
| **Ingesta de papers** | Subís un PDF o un paper de PubMed, el sistema lo procesa async con workers BullMQ | Drop zone en `/library`, o ingest URL |
| **Extracción bioprospecting** | LLM extrae: compuesto, especie, bioactividad, mecanismo, contexto geográfico | Auto en la ingesta, editables después |
| **Tablas estructuradas de PDFs** | Extrae tablas como markdown con headers jerárquicos preservados (multi-página) | Auto en la ingesta, navegables en provenance viewer |
| **Imagen/figura extraction** | Extrae imágenes de papers (Mistral raster + render-crop vector) | Click en un fact → lightbox con la imagen |
| **Detección de contradicciones** | Detecta cuando dos papers dicen cosas opuestas sobre el mismo compuesto/actividad | `/admin/contradictions` con filtro y bulk resolve |
| **Deduplicación semántica** | Detecta facts duplicados entre papers (mismo species\|compound\|bioactivity) | Auto-merge, pero reversible vía unmerge |
| **Compound authority table** | ~50 compuestos marinos curados + PubChem lookup automático, alias resolution | Backend, badge en fact detail |
| **Provenance viewer** | Click en un fact → abre la página exacta del PDF con bbox highlight | Ctrl+click abre en tab |
| **Re-evaluation button** | Botón "check for updates" en un discovery para detectar papers nuevos relevantes | `/discoveries/:id/reevaluate` |
| **Cost guard rails** | Hard/soft caps diarios/mensuales para Mistral OCR y PubChem | Env vars + admin drill-down `/admin/cost-totals` |
| **Discovery persistence** | Insights noveles se persisten con version history, soft-delete, FK a evidencia | Discovery agent, dual-write DB+JSONB |
| **Knowledge graph v1** | "Mostrame todo lo que sabemos del compound X" — search endpoint con stats | `/api/research-brain/graph/compounds/search` |
| **Admin review UI** | Panel `/admin` con 3 tabs: Contradictions, Dedup, Stats | Auth-gated, role: admin |

### ❌ Lo que NO está en producción (work in progress)

- **Re-evaluation automática** (cron): solo manual v1
- **Re-evaluation alerts** ("papers nuevos relevantes para algo que buscaste antes"): schema soporta, UI no
- **Read migration** (PR #2 de discovery persistence): consumers siguen leyendo del JSONB
- **Citation graph cross-paper**: no existe
- **Multi-language papers** (es, pt): no soportado
- **Entity mention graph** (KG PR #2): no implementado
- **LLM semantic linker** (KG PR #3): no implementado
- **RLHF en fact extraction**: no hay feedback loop
- **Compound authority v2** (más curadores, más compuestos): frozen en v1

---

## Casos de Uso End-to-End

### Caso 1: Investigador busca "curcumin + Alzheimer"

1. Usuario entra a `/library`, sube 3 papers de PubMed sobre curcumin y Alzheimer
2. Sistema ingesta en background (30-60s por paper)
3. Bioprospecting extractor corre LLM sobre cada paper → extrae ~10 facts/paper
4. Compound authority lookup: "curcumin" matchea con `PubChem CID 969516` (via ~50 seed curados o PubChem)
5. Tabla extraction detecta "Table 2: Bioactivity summary" → extrae como markdown
6. Usuario ve en `/research-brain` la lista de facts: "Curcumin inhibits Aβ aggregation (IC50 0.5μM)", "Curcumin reduces tau phosphorylation", etc.
7. Click en un fact → provenance viewer abre el PDF en la página exacta, con el chunk resaltado en amarillo
8. Si dos papers dicen cosas contradictorias (e.g., "Curcumin promotes Aβ clearance" vs "Curcumin has no effect on Aβ"), `/admin/contradictions` muestra la pair con un botón "Resolve"
9. Usuario busca "curcumin" en `/api/research-brain/graph/compounds/search` → ve stats: 3 papers, 8 facts, 2 claims contradicted, top bioactivities: "anti-inflammatory, neuroprotective"
10. Usuario pregunta al chat "¿qué se sabe de curcumin y Alzheimer?" → deep research corre planning → execute → hypothesis → reflection → **discovery** (insight novel, persistido en DB)

### Caso 2: Reviewer quiere validar un claim controversial

1. Admin entra a `/admin`, tab "Contradictions"
2. Ve: "5 contradicciones sin resolver, 2 en curcumin, 1 en DHA, 2 misceláneas"
3. Click en una → ve los 2 facts en conflicto con sus sources, bboxes en el PDF, claim chains
4. Decide: "el paper A es más reciente y tiene mejor metodología" → click "Resolve" + reason: "manual review: paper A supersedes"
5. Sistema actualiza: contradiction.status = 'resolved', escribe audit row
6. Si era un falso positivo del detector (no era realmente contradicción) → click "Dismiss" en su lugar
7. Bulk: si hay 10 contradicciones del mismo paper, marca los 10 checkboxes → "Resolve selected"

### Caso 3: Investigador vuelve a una conversación vieja

1. Usuario abre una conversación de hace 2 meses sobre "DHA + inflamación"
2. Sistema carga el contexto histórico, incluyendo **discoveries** persistidos
3. Usuario ve: "Discovery: DHA reduces IL-6 via NF-κB pathway (v2, confirmed by 2024 meta-analysis)"
4. Hace click en "check for updates" en el discovery
5. Sistema busca papers nuevos desde `last_checked_at`, hace LLM call: "¿algún paper nuevo contradice o extiende este claim?"
6. Resultado: "Clean" (no hay papers relevantes) o "Extended" (nueva evidencia) o "Contradicted" (nuevo paper desmiente)
7. Si hay cambio, sistema crea nueva versión (`v3`), marca `v2` como `superseded`, escribe audit row
8. En el futuro, un BullMQ worker correrá semanalmente para hacer este check automáticamente

---

## Arquitectura Interna (Resumen)

### Pipeline de Deep Research

```
User query
   ↓
Planning Agent (LLM) → plan de tareas (PlanTask en JSONB)
   ↓
Execute Tasks (workers BullMQ) → ejecutan extracción, búsqueda, análisis
   ↓
Hypothesis Agent (LLM) → genera claim tentativo basado en outputs
   ↓
Reflection Agent (LLM) → evalúa el claim, decide si es robusto
   ↓
Discovery Agent (LLM) → identifica insights noveles
   ↓
   ├─→ JSONB (conversation_states.values.discoveries)  ← consumers actuales
   └─→ research_discoveries (Postgres, v1+)              ← persistencia, future re-eval
   ↓
Reply to user
```

### Capa de Datos (Postgres + Supabase)

```
research_sources (papers)
  ├── research_evidence_chunks (text chunks con embeddings)
  ├── research_evidence_tables (tablas extraídas, bbox, multi-page chains)
  │     └── research_bioprospecting_facts ←──┐
  │           ├── evidence_table_id (FK)     │ composición canónica
  │           ├── compound_authority_status  │
  │           └── ...                        │
  ├── research_evidence_figures (figuras, bbox, extracted image)
  ├── research_claims (semantic claims, supported/contradicted/partial)
  │     ├── research_bioprospecting_contradictions (cross-paper contradictions)
  │     └── research_edges (generic edge table)
  └── research_discoveries (insights, version history, soft-delete) ← v1+
        └── research_discovery_evidence (FKs a evidence)
        └── research_discovery_reeval_audit (forward-compat, empty in v1)
research_taxa + research_taxon_aliases (species canonical)
research_compounds + research_compound_aliases (compound canonical, PubChem-backed)
research_graph_compound_aggregates (materialized view, KG v1)
```

### Workers BullMQ

- **document-ingestion**: PDF → chunks + tables + figures
- **bioprospecting**: chunks → facts (LLM extraction)
- **compound-authority**: scheduled cada 6h, PubChem lookup
- **deep-research**: orchestrates planning → execute → hypothesis → reflection → discovery

---

## Comparación con Alternativas

| Plataforma | Foco | Diferenciador de BioAgents |
|---|---|---|
| **OpenScholar** | Literature search + RAG | BioAgents extrae **datos estructurados** (compounds, bioactivities) con provenance, no solo texto |
| **Elicit** | Paper analysis con LLM | BioAgents **acumula** conocimiento cross-paper (dedup, contradictions, knowledge graph), Elicit es stateless |
| **Consensus** | Search across papers, "what do studies say" | BioAgents tiene **provenance visual** hasta párrafo/tabla/figura exactos, Consensus muestra snippets |
| **SciSpace** | Paper reading con explanations | BioAgents tiene **deduplicación semántica** (mismo finding en 2 papers = 1 row con FK), SciSpace no |
| **ChatGPT / Claude** | General chat | BioAgents es **domain-specific** (bioprospecting), con **taxonomy/compound authority tables** que un chatbot genérico no tiene |

**El diferenciador clave**: BioAgents no es un chatbot que resume papers — es un **sistema de acumulación de conocimiento verificable**. Cada claim está linkeado a su evidencia exacta, deduplicado cross-paper, y contrastado con claims contradictorios. Eso es lo que un AI scientist real hace, no un chatbot.

---

## Roadmap — Qué Viene

### 🔴 Alta prioridad (lo que falta para cerrar el círculo)

| # | Feature | Esfuerzo | Por qué importa |
|---|---|---|---|
| 1 | **Re-evaluation scheduled worker** (BullMQ cron) | M (1-2 días) | Habilita "papers nuevos relevantes para discoveries viejos" |
| 2 | **Read migration** (Discovery persistence PR #2) | M (1-2 días) | Los consumers dejan de leer JSONB, leen DB → un solo source of truth |
| 3 | **Entity mention graph** (KG PR #2) | M (1-2 días) | "Este compound trata enfermedad Y" — curates registries de targets/applications |
| 4 | **LLM semantic linker** (KG PR #3) | M (1-2 días) | Relaciones automáticas entre facts sin link manual |
| 5 | **Citation graph cross-paper** | L (3-5 días) | Papers conectados vía shared compounds, "este paper confirma A" |

### 🟡 Media prioridad

| # | Feature | Esfuerzo | Por qué importa |
|---|---|---|---|
| 6 | **Multi-language papers** (es, pt) | M (1-2 días) | Bioprospecting sudamericano es nuestro nicho |
| 7 | **Edit/annotation en provenance viewer** | M (1-2 días) | Investigador puede marcar cells de tabla con notas |
| 8 | **Compound authority v2** (more curators) | M (1-2 días) | +500 compuestos curados, más idiomas |
| 9 | **Per-source cap math** (cost-guard-rails follow-up) | S (1 día) | Per-source caps que actualmente no se disparan |
| 10 | **Auth resolver: role `researcher`** | S (1 día) | Relajar el "todo es admin" |

### 🟢 Baja prioridad / especulativo

| # | Feature | Esfuerzo | Por qué importa |
|---|---|---|---|
| 11 | **RLHF en fact extraction** | XL (1+ semana) | Quality mejora con el uso |
| 12 | **XObject extraction** (re-spike con pdfjs@6) | M | Recuperar figuras vector-only cuando salga |
| 13 | **Coverage report + CI gate** | S (1 día) | Higiene de tests |

### Principio detrás del orden

La prioridad #1 (re-eval worker) es la más valiosa porque **completa el ciclo de discovery persistence** que recién cerramos. Sin ella, el botón "check for updates" es manual y aislado. Con ella, el sistema empieza a "vivir" — corre solo, detecta cambios, alerta al usuario.

La #2 (read migration) es técnica pero habilita las #3 y #4 (KG extensions) sin doble-source-of-truth.

---

## Stats del Proyecto

| Métrica | Valor |
|---|---|
| Commits ahead de `origin/dev` (local) | 60 |
| OpenSpec changes archivados | 14 |
| OpenSpec capabilities en main specs | 13 |
| Tests passing | 594 |
| Tests failing | 1 (env-dependent, pre-existing) |
| Tests skipped | 7 |
| Total LOC (producción + tests) | ~50,000+ estimado |
| Lenguaje principal | TypeScript (Bun runtime) |
| Base de datos | Postgres via Supabase |
| Job queue | BullMQ (Redis) |
| Storage | S3 (PDFs, extracted images) |

### Changes archivados (14)

1. `bioprospecting-semantic-dedup` — identity_key + edge table + backfill
2. `bioprospecting-contradiction-detection` — rule-based + LLM pass + evidence pack warnings
3. `bioprospecting-pdf-provenance-viewer` — custom pdfjs-dist@5 detector + PDF.js viewer + lightbox
4. `bioprospecting-compound-authority` — ~50 seed + PubChem lookup + audit
5. `bioprospecting-multipage-table-merge` — 3 modes (hard/hard-confidence/manual) + admin override
6. `bioprospecting-image-extraction` — Mistral raster + render-crop vector
7. `cost-guard-rails` — daily/monthly caps + soft-fail + admin drill-down
8. `bioprospecting-knowledge-graph` v1 — compound-centric aggregates + search
9. `bioprospecting-review-ui` — admin page (Contras + Dedup + Stats)
10. `discovery-persistence` v1 — relational discoveries + dual-write
11-14. misc infra: test pollution fix, extractJsonArray fix, archive cleanups, CLAUDE.md updates

### Capabilities en main specs (13)

`bioprospecting-fact-dedup`, `pdf-provenance-viewer`, `pdf-table-extraction`, `research-bioprospecting`, `bioprospecting-contradiction-detection`, `bioprospecting-compound-authority`, `bioprospecting-semantic-dedup`, `api-cost-guard-rails`, `bioprospecting-knowledge-graph`, `bioprospecting-review-ui`, `bioprospecting-fact-dedup` (delta), `discovery-persistence`, `bioprospecting-contradiction-detection` (delta).

---

## Cómo Continuar

Las opciones concretas para el próximo cambio, en orden de valor:

1. **#1 Re-evaluation scheduled worker** (PR #3 de discovery persistence) — 1-2 días, completa el ciclo
2. **#3 Read migration** (PR #2 de discovery persistence) — 1-2 días, habilita KG extensions
3. **#4 Entity mention graph** (PR #2 de knowledge graph) — 1-2 días, extiende KG
4. **#5 Citation graph cross-paper** — 3-5 días, conecta papers via shared compounds

Si querés arrancar con uno, decime cuál. Si querés descansar, este documento es el snapshot del estado al 16 de junio de 2026.
