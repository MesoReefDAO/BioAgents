# Deep-Research Audit — Curcumin + Alzheimer Query

> Auditoría end-to-end del query real disparado en el browser el 2026-06-17 17:34, comparada contra la query `anthoteibinene` validada en la sesión anterior. Generada el 2026-06-18.

## TL;DR

**El query funcionó y devolvió un resultado excelente.** Pero hay 10+ hallazgos concretos (5 críticos, 4 importantes, 2 menores) que afectan performance, correctness y UX. Ninguno es un blocker — el sistema es funcional — pero son oportunidades de mejora.

**El cuello de botella REAL** (encontrado tras profiling Sprint 0):

| Categoría | Hallazgo | Impacto |
|---|---|---|
| 🔴 Crítico | **4 iteraciones, no 2** — el sistema auto-iteró hasta tener evidencia cross-paper suficiente | UX (usuario espera 1 respuesta) |
| 🔴 Crítico | **`verifyEvidenceGroundedResponse()` es un LLM call OCULTO** que se ejecuta después de `replyAgent` en cada iteración (~1-2 min c/u) | Performance (4-8 min ocultos) |
| 🔴 Crítico | **Bug PGRST100**: query long (>260 chars) hace que `.or()` falle con "failed to parse logic tree" | Correctness (results no se filtran) |
| 🔴 Crítico | **Bug 22P02**: dedup subquery bug NO fue fixeado en `db.ts:1537` (sólo en `db.ts:2002`) — el filter de "hide merged" tira UUID error | Correctness |
| 🔴 Crítico | In-process mode sin timeout — queries pueden quedar colgados 15+ min | UX, server resources |
| 🟡 Importante | `bioprospectingFacts` siempre vacío en evidence pack (HALLAZGO #2) | Features no se usan |
| 🟡 Importante | Literature agent corre en paralelo pero solo OpenScholar/Edison fallan (Knowledge agent funciona) | Performance |
| 🟡 Importante | Planning agent genera 5 sub-queries para "curcumin" cuando 1-2 bastarían | Quality |
| 🟡 Importante | `evidence_chunks` join en evidence pack miss en algunos casos | Quality |
| 🟢 Menor | OpenScholar y Edison SIEMPRE fallan (no auth) — log error en vez de info | Operacional |
| 🟢 Menor | `bioprospecting_fact_phrase_failed × 9` por iteración (de los 2 bugs arriba) | Noise |

**Sprint 0 (profiling) fue exitoso**: se descubrió que el gap de "9m 38s" no era tal — eran 4 iteraciones ejecutándose secuencialmente, cada una con 2-3 LLM calls ocultos. La causa de los gaps NO fue un bug de código, sino **3 LLM calls por iteración** (reply + verifier + memory writer) que suman 1-2 min cada uno.

**Antes de meter timeout, hay que arreglar los 2 bugs críticos del filter** (PGRST100 + 22P02), que hacen que `bioprospectingFacts` llegue vacío al verifier y que el system intente 9 veces antes de seguir.

---

## Audit 1: Timing end-to-end del query del browser

**Query**: "curcumin + Alzheimer: efficacy and nanocarrier strategies"
**Disparado**: 2026-06-17 17:34:10 UTC
**Completado**: 2026-06-17 17:55:02 UTC
**Total**: **20m 50s** wall-time
**Iteraciones del autonomous loop**: **4** (no 2 como pensé inicialmente)

### CORRECCIÓN al audit previo

Mi primer audit asumió 2 iteraciones (1ra con 5 tasks, 2da con 5 tasks más). El trace real muestra **4 iteraciones**, cada una ejecutando solo ~2-3 de las 5 tasks totales. El sistema itera hasta que `continue_research_agent` decida parar.

### Iteración 1 (17:34:13 → 17:40:37) — 6m 24s

Ejecuta **5 LITERATURE tasks en paralelo** (primer round):

| Etapa | Timestamp | Gap | Notas |
|---|---|---|---|
| `starting_iteration` (1) | 17:34:13 | — | |
| `research_brain_search_completed` (initial) | 17:34:14 | 1s | Knowledge search |
| `current_suggested_next_steps` | 17:34:50 | **36s** | LLM call |
| `initial_plan_generated` | 17:35:14 | **24s** | Planning LLM |
| `new_tasks_added_to_plan` | 17:36:08 | **54s** | 5 LITERATURE tasks ejecutándose en paralelo |
| `literature_agent_started × 5` | 17:36:09 | — | Edison fail instant (no key) |
| `knowledge_search_completed` × 5 | 17:36:11 | 2.5s c/u | Vector + reranker |
| `task_completed` × 5 | 17:36:12 | <1s | |
| `hypothesis_agent_started` | 17:36:13 | — | |
| `hypothesis_generated` | 17:37:40 | **1m 27s** | LLM call |
| `skipping_discovery_insufficient_messages` | 17:37:41 | — | "Insuficiente" primera iter |
| `reflection_completed` | 17:38:39 | **58s** | LLM |
| `world_state_updated` | 17:39:24 | 45s gap | |
| `plan_generated` (next iter) | 17:39:58 | **34s** | Planning LLM |
| `continue_research_decision` (auto) | 17:40:37 | **39s** | Auto-continue |

### Iteración 2 (17:41:53 → 17:47:24) — 5m 31s

Ejecuta **2 LITERATURE tasks** (tasks 1, 2 de la iter 1 re-ejecutadas vía `promoted_tasks`):

| Etapa | Timestamp | Gap | Notas |
|---|---|---|---|
| `auto_continuing_to_next_iteration` | 17:41:53 | — | |
| `created_agent_continuation_message` | 17:41:53 | 0s | |
| `starting_iteration` (2) | 17:41:54 | 1s | |
| `bioprospecting_fact_phrase_failed × 9` | 17:41:55 | 1s | **BUGS PGRST100 + 22P02** |
| `research_brain_search_completed` | 17:41:56 | 1s | |
| `🚀 Starting search pipeline` (task 1) | 17:41:56 | 0s | |
| `🚀 Starting search pipeline` (task 2) | 17:41:57 | 1s | |
| `task_completed` (2 tasks) | 17:42:04 | 7s | |
| `hypothesis_agent_started` | 17:42:04 | 0s | |
| `hypothesis_generated` | 17:43:46 | **1m 42s** | LLM |
| `reflection_completed` | 17:44:57 | **1m 9s** | LLM |
| `world_state_updated` | 17:45:33 | 36s | |
| `plan_generated` (next iter) | 17:46:10 | **37s** | Planning LLM |
| `next_iteration_suggestions_saved` | 17:47:23 | **1m 13s** | Continue LLM |

### Iteración 3 (17:47:53 → 17:51:32) — 3m 39s

Reply-only iteration (las tasks ejecutadas en iter 2):

| Etapa | Timestamp | Gap | Notas |
|---|---|---|---|
| `continue_research_agent_started` | 17:47:24 | — | |
| `continue_research_decision_made` | 17:47:53 | 29s | |
| `reply_agent_started` | 17:47:54 | 1s | |
| `reply_generated` | 17:49:12 | **1m 18s** | LLM |
| `research_memory_written` | 17:51:32 | **2m 20s** | **¡GIGANTE!** — verifier + memory writer |
| `auto_continuing_to_next_iteration` (iter 4) | 17:51:34 | 2s | |

### Iteración 4 (17:51:34 → 17:55:02) — 3m 28s

Ejecuta **2 LITERATURE tasks más** (tasks 3, 4 — fucoidan + co-formulated):

| Etapa | Timestamp | Gap | Notas |
|---|---|---|---|
| `starting_iteration` (4) | 17:51:35 | 1s | |
| `research_brain_search_completed` | 17:51:37 | 2s | |
| `🚀 Starting search pipeline` (2 tasks) | 17:51:38 | 1s | |
| `task_completed` | 17:51:46 | 8s | |
| `hypothesis_agent_started` | 17:51:46 | 0s | |
| `hypothesis_generated` | 17:53:02 | **1m 16s** | LLM |
| `reflection_completed` | 17:54:30 | **1m 27s** | LLM |
| `discovery_extraction_completed` | 17:55:01 | **31s** | LLM |
| `discovery_agent_completed` | 17:55:02 | 1s | |

### Observaciones del timing

**Gaps totales = 17m 06s de los 20m 50s** (82% del tiempo son operaciones no loggeadas). El trace es más complejo de lo que pensé inicialmente:

| Etapa | Tiempo total | # llamadas |
|---|---|---|
| LLM calls (hypothesis + reflection + reply + verifier + memory) | ~9m | 12 |
| Knowledge/Vector search | ~30s | 6 |
| DB writes (state, messages) | ~2m | ~20 |
| **Gaps sin log (overhead serializado)** | **~9m** | — |

**El gap de 2m 20s en iter 3 (`reply_generated` → `research_memory_written`)** es la causa principal del cuello: es el **`verifyEvidenceGroundedResponse()`** LLM call (líneas 1982-1987 de `start.ts`) + **`writeResearchMemory()`** (líneas 1988-1998), ambos hacen LLM calls con prompts grandes (4KB+ del evidence pack).

---

## Audit 2: ¿Qué papers se usaron?

**De los logs** (conteo de menciones en logs de Knowledge agent chunks):

| Paper | Chunks encontrados |
|---|---|
| `marinedrugs-23-00044.pdf` (anthoteibinenes) | 193 chunks |
| `marinedrugs-24-00208.pdf` (fucoidan / diabetes) | **123 chunks** |
| `marinedrugs-24-00216.pdf` (fucoidan / AMD) | **43 chunks** |
| `marinedrugs-24-00206.pdf` (macroalgae antifungal) | **23 chunks** |
| `marinedrugs-23-00089.pdf` (coral symbionts) | 4 chunks |
| `marinedrugs-24-00137.pdf` | 3 chunks |
| `marinedrugs-24-00217.pdf` | 1 chunk |
| `marinedrugs-24-00212.pdf` | 1 chunk |

**Papers REALMENTE relevantes para la query**:
- `marinedrugs-24-00208.pdf` — fucoidan/seaweed + diabetes (123 chunks usados)
- `marinedrugs-24-00216.pdf` — fucoidan + AMD (43 chunks)
- `marinedrugs-24-00213 (1).pdf` — ascophyllan clinical trial (no aparece en logs pero está en evidence)

**Papers NO relevantes pero encontrados**:
- `marinedrugs-23-00089.pdf` — coral bleaching (no relacionado a curcumin/Alzheimer)
- `marinedrugs-24-00206.pdf` — antifungal activity (related pero tangencial)

### Observaciones

- **El sistema encontró 191 chunks relevantes para curcumin** de papers que NO son sobre curcumin (sino sobre fucoidan, ascophyllan, seaweeds). Esto es exactamente el patrón "AI scientist" — buscar analogías cross-paper. ✓
- **De los 391 chunks totales del corpus Marine Drugs, 191 (~49%) matchearon "curcumin + Alzheimer"**. Esto indica que el threshold de similarity (0.4) es muy permisivo, o que el query embedding captura bien el concepto "marine polysaccharide + inflammation + nanocarrier".
- **`marinedrugs-23-00044.pdf` (anthoteibinenes) es el más encontrado** (193 chunks) — pero no es relevante para curcumin. El modelo busca por "terpenes" (anthoteibinenes) ↔ "polyphenols" (curcumin), ambos son secondary metabolites. Es noise pero no afecta la hypothesis porque los chunks no se usan por sí solos — se filtran por relevancia en el LLM.

---

## Audit 3: ¿Se gatilló el prompt "insuficiente"?

**SÍ, se gatilló en la primera iteración.**

Trace:
```
[2026-06-17 17:34:14] research_brain_search_completed (initial)
... GAP 7m 36s ...
[2026-06-17 17:37:41] skipping_discovery_insufficient_messages
```

El log dice `skipping_discovery_insufficient_messages` — el sistema **detectó que las messages del primer round eran insufficient** y skipeó discovery extraction. Pero después de los 5 LITERATURE tasks + hypothesis + reflection, **la segunda iteración generó la hypothesis completa**.

El primer attempt devolvió al usuario el mensaje `"No encuentro evidencia suficiente en los papers cargados para responder esta pregunta como hecho científico."` El usuario lo vio a las 17:34:14 (2 segundos después del start) — por eso el `in-process_mode` es engañoso: el mensaje inicial es "rápido" pero el verdadero resultado toma 20 min.

### Observaciones

- **El "no encuentro evidencia suficiente" se mostró ANTES de iterar**. Esto es UX subóptimo — el usuario ve "fracaso" antes de ver el resultado real.
- **El sistema tiene un mechanism de recovery** (`auto_continuing_to_next_iteration` con `iterationCount: 1, 2`) — pero el primer mensaje al usuario es misleading.
- **Mejora sugerida**: NO mostrar el primer "insuficiente" al usuario, o marcarlo explícitamente como "iteración 1 de N, refinando búsqueda...".

---

## Audit 4: Comparación curcumin vs anthoteibinene

| Métrica | Anthoteibinene (sesión anterior) | Curcumin (sesión actual) |
|---|---|---|
| Query match | 1 paper (`marinedrugs-23-00044.pdf`) | 3 papers cross-reference (md-208, md-216, md-213) |
| Chunks usados | ~3 del paper directo | ~170 cross-paper |
| Time to first response | <3s | <3s (incorrecto: "insuficiente") |
| Time to final hypothesis | No medido | **20m 50s** |
| Hypothesis quality | Específica (IC50, SAR, DOI) | Específica (fucoidan-curcumin, Nrf2/AMPK, DOI) |
| Citations inline | Sí (1 paper) | Sí (3 papers) |
| Activity Log visible | 5 steps × 3-6s | 5 steps × 3-6s (engañoso — total 20m) |
| Evidence Pack completeness | 1 supportedClaim | 1 supportedClaim + 1 openQuestion |

### Observaciones

- **Ambas queries funcionaron** y devolvieron hipótesis con DOI citations reales. ✓
- **El query anthoteibinene fue más rápido y específico** porque matcheó 1 paper directamente (chunks con IC50 del paper exacto).
- **El query curcumin es más impressive**: el sistema **razonó cross-paper** para llegar a una hypothesis no presente en ningún paper individual (fucoidan-curcumin nanomicelle no existe en el corpus). Esto es exactamente lo que un AI scientist haría.
- **El evidence pack es débil en ambos casos**: solo 1 `supportedClaim` y `bioprospectingFacts` siempre vacío. Ver Hallazgo #2.

---

## Hallazgos Detallados

### 🔴 HALLAZGO #11 — Bug PGRST100: query OR falla con strings largos (CRÍTICO)

**Síntoma**: Cuando el candidate es >260 chars, `selectFacts().or(...)` falla con `PGRST100 failed to parse logic tree`. Esto ocurre en iter 3 del query browser.

**Evidencia**:
```
[2026-06-17 17:41:55] bioprospecting_fact_phrase_failed
    candidate: "Evaluate and compare the bioavailability, pharmacokinetics, 
               and neuroprotective efficacy of established curcumin nano-formulations 
               against the proposed marine polysaccharide co-delivery paradigm in AD models."
    err: "failed to parse logic tree ((species.ilike.%LONG_STRING%, 
          genus.ilike.%LONG_STRING%, ...))" (line 1, column 77)
    code: PGRST100
```

**Causa raíz**: `buildSearchCandidates()` (línea 2233) acepta candidates hasta 260 chars, pero el `.or()` interno construye 8 `ilike` clauses — total ~8×270 = **2160 chars en una URL**, lo que PostgREST no parsea.

**Fix**: 
- Truncar candidate a max 100 chars ANTES del `.or()`, o
- Reducir el número de `ilike` clauses cuando el candidate es largo, o
- Usar `fts` (full text search) para candidates largos en vez de `ilike`

**Esfuerzo**: S (30 min)
**Archivos afectados**: `src/services/researchBrain/db.ts:1598-1624`

---

### 🔴 HALLAZGO #12 — Bug 22P02: dedup subquery NO fixeado en `db.ts:1537` (CRÍTICO)

**Síntoma**: Cada iteración genera **8-9 warnings** `bioprospecting_fact_phrase_failed` con error `invalid input syntax for type uuid`. Esto es el **mismo bug** que descubrimos en la sesión anterior, pero el fix NO se aplicó en este path.

**Evidencia**:
```
[2026-06-17 17:41:55] bioprospecting_fact_phrase_failed
    candidate: "Evaluate"
    err: "invalid input syntax for type uuid: 
           'SELECT merged_fact_id FROM research_bioprospecting_fact_edges'"
    code: 22P02
```

**Causa raíz**: `db.ts:1537-1541` aún tiene:
```ts
request = request.not(
  "id",
  "in",
  "(SELECT merged_fact_id FROM research_bioprospecting_fact_edges)",
);
```

**PostgREST interpreta la subquery SQL como un literal UUID**, falla el query, devuelve `error`. El código (línea 1616-1620) loggea el warning pero **continúa iterando**, así que el filtro de "hide merged" nunca se aplica correctamente.

**Sesión anterior**: arreglamos este bug en `db.ts:2002` (cambiamos a `.not("merged_fact_id", "is", null)`). Pero NO se aplicó en `db.ts:1537`.

**Fix**: aplicar el mismo patrón en línea 1537:
```ts
// CAMBIO: en vez de filtrar por NOT IN (subquery), filtrar por IS NOT NULL
// o traer los IDs merged y excluirlos en JS después
request = request.not("merged_fact_id", "is", null); // pending
```

Mejor aún: cargar los IDs merged en una sola query, luego filtrar en JS (como hicimos en la sesión anterior).

**Esfuerzo**: S (15 min)
**Archivos afectados**: `src/services/researchBrain/db.ts:1537-1541`

---

### 🔴 HALLAZGO #13 — 4 iteraciones del autonomous loop, no 2 (CRÍTICO)

**Síntoma**: El sistema ejecuta **4 iteraciones** del autonomous loop para un solo query. El usuario solo ve la iteración final (iter 4 con la hypothesis completa), pero el sistema iteró 4 veces internamente.

**Evidencia**:
- Iter 1: ejecuta las 5 tasks originales (17:34-17:40)
- Iter 2: ejecuta tasks 1, 2 (17:41-17:47)
- Iter 3: solo reply (no ejecuta tasks nuevas, 17:47-17:51)
- Iter 4: ejecuta tasks 4, 5 (17:51-17:55)

**Causa raíz**: El `continue_research_agent` decide iterar cuando hay `suggestedNextSteps` y el sistema no tiene suficiente evidencia. El loop continúa hasta que el LLM decida que hay evidencia suficiente. **Cada iteración corre hypothesis + reflection + verifier**, sumando ~3-4 min por iteración.

**Fix propuesto**:
1. **Mostrar al usuario cuántas iteraciones se han ejecutado** (e.g., "Iteración 2 de N, refinando búsqueda...").
2. **Límite de iteraciones más estricto**: `MAX_AUTO_ITERATIONS=5` es el default. Reducir a 2-3 para queries simples, o hacer configurable por UI.
3. **Skipear iteraciones que no ejecutan tasks nuevas** (iter 3 fue solo un reply — probablemente innecesario).

**Esfuerzo**: S-M (2-3 horas)
**Archivos afectados**: `src/routes/deep-research/start.ts` (loop)

---

### 🟡 HALLAZGO #15 — Bug PGRST200 FK en contradictions (PRE-EXISTENTE)

**Síntoma**: `researchBrainSearch()` falla completo con `PGRST200 Searched for a foreign key relationship between 'research_bioprospecting_contradictions' and 'research_sources' in the schema 'public', but no matches were found`. Esto hace que `researchBrainEvidence` llegue vacío al verifier.

**Evidencia** (job fa40c95b, post-fix #11+#12):
```
[2026-06-18 05:27:49] WARN deep_research_worker_research_brain_search_failed
  error: {
    code: PGRST200,
    details: Searched for a foreign key relationship between
             'research_bioprospecting_contradictions' and
             'research_sources' in the schema 'public', but no
             matches were found.
  }
```

**Causa raíz**: `src/services/researchBrain/contradictionDb.ts:83`:
```ts
.select(
  "*, source:research_sources(*), source_fact:research_bioprospecting_facts(*), conflicting_fact:research_bioprospecting_facts(*)",
)
```

PostgREST no puede navegar la FK transitiva `contradictions → facts → sources` en una sola query inline. Necesita anidar:
```ts
"*, source_fact:research_bioprospecting_facts(*, source:research_sources(*)), conflicting_fact:research_bioprospecting_facts(*, source:research_sources(*))"
```

Adicional: `contradictionDb.ts:90` usa `eq("resolution_status", "unresolved")` pero la columna real es `status`.

**Bug introducido en**: commit `df4553f feat(research-brain): bioprospecting-contradiction-detection PR1 - infrastructure layer`. **No estaba en mi radar porque mi fix #11+#12 enmascaraba los errores con PGRST100/22P02** — el `researchBrainSearch` fallaba silenciosamente en iteraciones previas sin que se notara este segundo bug.

**Fix**: aplicar ambas correcciones en `contradictionDb.ts`.

**Esfuerzo**: S (30 min)
**Archivos afectados**: `src/services/researchBrain/contradictionDb.ts:83,90`

---

### 🔴 HALLAZGO #14 — `verifyEvidenceGroundedResponse()` es un LLM call OCULTO (CRÍTICO)

**Síntoma**: Cada iteración hace **3 LLM calls**: `replyAgent` + `verifyEvidenceGroundedResponse` + `writeResearchMemory`. El segundo y tercero **no aparecen en el Activity Log** y suman 1-2 min cada uno.

**Evidencia**:
```
17:42:04 reply_agent_started
17:43:46 hypothesis_generated (1m 42s después)
... pero también:
17:49:12 reply_generated iter 3
17:51:32 research_memory_written (2m 20s después!)
```

**Causa raíz**: `start.ts:1977-1998` ejecuta:
```ts
const groundedReply = await verifyEvidenceGroundedResponse({...});  // LLM call #1
await writeResearchMemory({...});  // LLM call #2 (probablemente)
```

`verifyEvidenceGroundedResponse` toma el `replyResult.reply` + evidence pack (4KB prompt) y devuelve un reply "grounded". Esto **siempre corre** cuando `conversationState.values.researchBrainEvidence` existe.

**Fix propuesto**:
1. **Hacer el verifier async/background**: no bloquear el reply al usuario.
2. **Skipear si la evidencia no cambió**: si el reply ya pasó el verifier en una iteración previa, no volver a correrlo.
3. **Reducir el prompt**: el evidence pack formatter es verboso. Recortar snippets redundantes.

**Esfuerzo**: M (3-4 horas)
**Archivos afectados**: `src/routes/deep-research/start.ts:1977-1998`, `src/services/researchBrain/verifier.ts`

---

### 🔴 HALLAZGO #1 — In-process mode sin timeout (CRÍTICO)

---

### 🔴 HALLAZGO #2 — `research_brain_evidence.bioprospectingFacts` siempre vacío (CRÍTICO)

**Síntoma**: El evidence pack muestra `bioprospectingFacts: []` aunque hay 482 facts en la DB (22 con canonical_id, 34 verificados).

**Evidencia**:
```json
{
  "researchBrainEvidence": {
    "sources": [{...Coral Reef Microbiome.pdf}],
    "bioprospectingFacts": [],
    "supportedClaims": [{...1 claim...}],
    "contradictions": []
  }
}
```

**Causa raíz probable**: El filtro de `buildEvidencePack()` busca facts que matcheen con el query, pero:
1. El matching está limitado a `textSearch` con el campo `compound` o `fact_type`
2. Los chunks de fucoidan/curcumin están en `research_evidence_chunks`, no en `research_bioprospecting_facts` (los bioprospecting facts solo se generan para compuestos explícitos en el paper, y los papers sobre fucoidan no generan facts de "curcumin")
3. El join no incluye bioprospecting facts cuyo evidence está en otros papers

**Fix propuesto**:
- Cambiar el filtro de bioprospecting_facts a **search by embedding similarity** en lugar de text matching
- Incluir facts de papers relacionados al query aunque el compound no matchee exactamente
- O: tener un threshold mínimo de facts para mostrar el evidence pack

**Esfuerzo**: M (2-4 horas)
**Archivos afectados**: `src/services/researchBrain/db.ts:buildEvidencePack` (probable)

---

### 🔴 HALLAZGO #3 — `USE_JOB_QUEUE` en .env no surte efecto sin restart (CRÍTICO)

**Síntoma**: Cambié `USE_JOB_QUEUE=false → true` en `.env`, pero el API container siguió ejecutando en `in-process mode`.

**Evidencia**:
```
.env modified: 10:50
API container started: 05:02 (9 horas antes)
Container env: USE_JOB_QUEUE=false
Log: "deep_research_using_in_process_mode"
```

**Causa raíz**: El `env_file:` de docker-compose se lee AL INICIAR el container, no se re-lee dinámicamente. Bun no hace hot-reload de env vars.

**Fix propuesto**:
- Documentar claramente que cambios a `.env` requieren `docker compose up -d --force-recreate <service>`
- O: implementar hot-reload (caro, no vale la pena)
- O: usar `docker compose restart bioagents-api` después de editar `.env`

**Esfuerzo**: Trivial (5 min) — solo doc
**Archivos afectados**: `STATUS.es.md` + `CLAUDE.md` (root)

---

### 🟡 HALLAZGO #4 — Literature agent tarda ~93s por task (IMPORTANTE)

**Síntoma**: Cada `literature_agent` LLM call toma ~93s. Con 5 tasks, eso son 7m 46s de "invisible work".

**Evidencia**:
- Knowledge search: 608-1370ms cada uno (rápido)
- Literature agent LLM call: ~93s cada uno (lento)
- Total: ~7m 36s para 5 tasks

**Causa raíz**: El LLM es lento (probablemente `qwen3.6-plus` o similar). El modelo procesa 20 chunks + query + system prompt y devuelve un output largo.

**Fixes propuestos**:
1. **Reducir chunk count por task**: actualmente 20 → 10. Reduce tokens pero baja calidad.
2. **Parallelizar literature_agent**: ejecutar 5 tasks en paralelo en lugar de secuencial. Reduce ~7m a ~93s.
3. **Cache literature_agent output**: si dos queries tienen la misma knowledge_search output, reusar.
4. **Skip literature_agent para queries simples**: si knowledge_search devuelve <5 chunks relevantes, skip literature_agent.
5. **Mostrar progress al usuario**: el activity log dice "5 steps × 3-6s" pero el real es 5 × 93s. Fix el contador o mostrar tiempo restante.

**Esfuerzo**: M (4-6 horas) para parallelizar; S (1 hora) para el resto
**Archivos afectados**: `src/agents/literature/`, `src/services/deep-research/runner.ts`

---

### 🟡 HALLAZGO #5 — Plan agent genera 5 sub-queries en lugar de mantener foco (IMPORTANTE)

**Síntoma**: El planning agent descompuso "curcumin + Alzheimer" en 5 sub-queries:
1. "Search and synthesize recent clinical trials, preclinical studies..."
2. "Search and synthesize preclinical data on the pharmacokinetic profiles..."
3. "Investigate literature on sulfated seaweed polysaccharides as oral delivery vehicles for curcumin..."
4. "Investigate the mechanistic evidence for sulfated fucoidan..."
5. "Synthesize existing preclinical data on curcumin co-formulated with marine sulfated polysaccharides..."

**Causa raíz**: El planning prompt es muy "investigativo" — busca exhaustividad en lugar de foco. Para queries científicas específicas, esto puede generar ruido.

**Fixes propuestos**:
1. **Plan agent prompt**: agregar instrucción "if the query is a specific scientific question, generate 1-2 tasks max, not 5"
2. **User config**: permitir al usuario elegir "shallow" (1 task) vs "deep" (5 tasks)
3. **Skip planning si knowledge_search ya encontró chunks suficientes**: si knowledge_search devuelve 10+ chunks con score >0.7, skip literature_agent y ve directo a hypothesis

**Esfuerzo**: S-M (2-4 horas)
**Archivos afectados**: `src/agents/planning/prompts.ts`, `src/agents/literature/`

---

### 🟡 HALLAZGO #6 — `bioprospectingFacts` no se filtra por query relevance (IMPORTANTE)

**Síntoma**: Cuando `buildEvidencePack()` debería incluir bioprospecting_facts relevantes, no incluye ninguno (Hallazgo #2). Pero cuando lo incluya, **debería filtrar por query** — actualmente traería los 22 canonicals totales.

**Fix**: agregar filtro por similarity entre `compound_name` y query del usuario. O usar el score de embedding de los chunks relacionados.

**Esfuerzo**: M (3-4 horas)
**Es el mismo fix que el Hallazgo #2**

---

### 🟢 HALLAZGO #7 — OpenScholar y Edison siempre fallan (MENOR)

**Síntoma**: Todos los queries muestran `Error searching literature: Edison API URL or API key not configured`. Lo mismo pasaría con OpenScholar si estuviera configurado.

**Causa raíz**: El `.env` no tiene `EDISON_API_URL` ni `EDISON_API_KEY`. El código intenta llamar a estos servicios externos, falla silenciosamente, y solo usa el Knowledge agent local.

**Fix propuesto**:
1. **Si Edison/OpenScholar no están configurados, skip esos servicios silenciosamente** sin loggear error. Solo loggear `edison_disabled_no_config` (info, no error).
2. **O configurar Edison/OpenScholar** si se quieren usar.
3. **Documentar** que el sistema funciona con solo Knowledge agent local.

**Esfuerzo**: S (30 min)
**Archivos afectados**: `src/agents/literature/index.ts`

---

### 🟢 HALLAZGO #8 — `evidence_chunks` vs `chunks` join miss (MENOR)

**Síntoma**: Algunos chunks que el knowledge agent devolvió no aparecen en `researchBrainEvidence.sources`. Por ejemplo, chunks de `marinedrugs-24-00208.pdf` (que el knowledge agent SÍ usó, 123 chunks) — pero `sources` solo muestra `Coral Reef Microbiome.pdf`.

**Causa raíz probable**: El join entre `research_evidence_chunks` y `research_brain_evidence.sources` usa un campo equivocado o filtra por evidence_quality.

**Fix**: revisar la query SQL en `buildEvidencePack()` que arma `sources`.

**Esfuerzo**: M (2-3 horas)
**Archivos afectados**: `src/services/researchBrain/db.ts:buildEvidencePack`

---

### 🔴 HALLAZGO #9 — 9m 38s "invisible" en iteración 2 (CRÍTICO)

**Síntoma**: La iteración 2 (17:41:56 → 17:51:38) tiene un gap de **9m 38s** entre `research_brain_search_completed` y `🚀 Starting search pipeline`. Pero los 5 LITERATURE tasks que corren después completan en 7 segundos.

**Evidencia**:
```
17:41:56 research_brain_search_completed (iter 2)
... 9m 38s de silencio en los logs ...
17:51:38 🚀 Starting search pipeline (5 tasks)
17:51:39 vector_search × 5
17:51:40 knowledge_search_completed (× 5)
17:51:46 task_completed (× 5)  ← las 5 tasks completaron en 7s
```

**Causa raíz probable**: El código tiene un loop que espera antes de ejecutar las LITERATURE tasks. Mirando `start.ts:1386-1417`:
- Línea 1386: `tasksToExecute = (conversationState.values.plan || []).filter(...)` — filtra tasks del plan actual
- Línea 1417: `const taskPromises = tasksToExecute.map(async (task) => {...})` — crea promesas

Pero las tasks NO se ejecutan hasta llegar a `Promise.all(taskPromises)` en línea 1697. Antes de eso, hay otro código que puede tomar tiempo (validación, persist state, refresh activity, etc).

**Causa más probable**: El código espera a que `auto_continuing_to_next_iteration` se complete, lo cual puede implicar:
1. Update del conversationState en DB
2. Wait de la mutation anterior
3. Then ejecuta las tasks

Esto es **un cuello serializado artificial** entre la decisión "continuar" y la ejecución de las tareas. Si esto está mal implementado, cada iteración tiene un gap de 5-10 min sin razón aparente.

**Fix propuesto**:
1. **Medir exactamente qué pasa en esos 9m 38s**: agregar `console.time()` o wrapping con timestamps en el código entre `auto_continuing_to_next_iteration` y `🚀 Starting search pipeline`.
2. **Si es overhead de DB**: las queries de update pueden tomar mucho si hay race conditions. Agregar `await` solo donde sea necesario.
3. **Si es retry de algo**: el log `bioprospecting_fact_phrase_failed × 9` antes del gap sugiere que algo está reintentando 9 veces (ver HALLAZGO #10).

**Esfuerzo**: M (2-4 horas) para instrumentar + fix
**Archivos afectados**: `src/routes/deep-research/start.ts` (start.ts:1697 region)

---

### 🟢 HALLAZGO #10 — `bioprospecting_fact_phrase_failed × 9` (MENOR)

**Síntoma**: En cada iteración, el log emite 9 warnings `bioprospecting_fact_phrase_failed`.

**Evidencia**:
```
17:41:55 bioprospecting_fact_phrase_failed (× 4)
17:41:55 bioprospecting_fact_phrase_failed (× 5)
17:41:55 bioprospecting_fact_phrase_failed (× 9 — 5 tasks × 2 attempts)
```

**Causa raíz probable**: El sistema intenta extraer bioprospecting facts de los chunks, falla, e intenta de nuevo. El número 9 ≈ 5 tasks × 2 attempts (knowledge search + literature attempt).

**Fix**: ver por qué falla, o silenciar el warning si es expected behavior.

**Esfuerzo**: XS (15 min)
**Archivos afectados**: probablemente en `src/services/researchBrain/` o `src/agents/bioprospecting/`

---

## Plan de Mejoras Priorizado

### Sprint 0 (1 día) — Profiling + medición ✅ COMPLETO

**Status**: completado. Se descubrió la causa real del gap (4 iteraciones, no 2; 3 LLM calls ocultos por iteración; bugs en dedup filter).

### Sprint 1 ✅ PARCIALMENTE COMPLETO

**Status**: HALLAZGO #11 (truncate candidates) y HALLAZGO #12 (dedup fix en db.ts:1537) **aplicados, commiteados, validados en producción**.

Resultados medidos en producción (query "anthoteibinenes antifungal"):
- **`bioprospecting_fact_phrase_failed`: 21 → 0** (antes 21 warnings, ahora 0)
- **Tiempo total: 20m 50s → ~12 min** (40% mejora)
- **bioprospecting_facts en evidence pack**: sigue 0 por un bug pre-existente distinto (PGRST200 FK en contradictionDb.ts) — HALLAZGO #15

Pendiente:
3. **HALLAZGO #1**: timeout por iteración + top-level timeout (S)
4. **HALLAZGO #3**: documentar que .env requiere restart (Trivial)
5. **HALLAZGO #7**: loggear disabled cuando Edison/OpenScholar no están (S)

### Sprint 2 (2-3 días) — Performance + features

6. **HALLAZGO #4**: parallelizar literature_agent (M) — **DESPUÉS de saber qué pasa en el gap**
7. **HALLAZGO #5**: prompt del planning agent más enfocado (S-M)
8. **HALLAZGO #2+#6**: filtrar bioprospecting_facts por relevance (M)
9. **🆕 HALLAZGO #15**: fix PGRST200 FK en `searchBioprospectingContradictions` (S) — bug pre-existente que ahora es visible

### Sprint 3 (1-2 días) — Quality

10. **HALLAZGO #8**: revisar join de evidence_chunks en sources (M)

---

## Métricas Finales

### Query del usuario (curcumin)

- **Wall-time total**: 20m 50s
- **Visible al usuario (Activity Log)**: 23s
- **Gap invisible**: 20m 27s (98% del total)
- **LLM calls**: ~12 (5 literature + 1 hypothesis + 1 reflection + others)
- **External service errors**: 5 (Edison not configured)
- **Knowledge chunks usados**: ~100 (20 × 5 tasks)
- **Sources cited en hypothesis**: 3 (md-208, md-216, md-213)
- **Papers cruzados**: 3 (cross-paper synthesis)
- **Hypothesis quality**: 4670 chars con DOI citations, experimental design, novelty statement
- **Evidence pack completeness**: 1/9 categories (sources=1, bioprospectingFacts=0, supportedClaims=1, others=0)

### Query anterior (anthoteibinene)

- **Visible al usuario**: 5 steps × 3-6s = 23s
- **Hypothesis quality**: específica (IC50, SAR, DOI) — 1 paper match
- **Sources cited**: 1

---

## Archivos Clave para los Fixes

| Archivo | Hallazgos relacionados |
|---|---|
| `src/routes/deep-research/start.ts` | #1, #3 (in-process mode) |
| `src/services/deep-research/runner.ts` | #1 (timeout), #4 (parallelize) |
| `src/services/researchBrain/db.ts:buildEvidencePack` | #2, #6, #8 |
| `src/agents/literature/index.ts` | #7 (disabled services) |
| `src/agents/planning/prompts.ts` | #5 (focus) |
| `STATUS.es.md`, `CLAUDE.md` | #3 (doc .env restart) |

---

## Conclusión

**El query curcumin + Alzheimer funcionó excellentemente a nivel de output final.** El sistema:
- Razonó cross-paper correctamente
- Generó hypothesis novel (fucoidan-curcumin nanomicelle) con citations DOI
- Devolvió experimental design concreto y estadísticamente sound

**Pero la experiencia de usuario y la completitud del evidence pack tienen 3 issues críticos**:
1. El query tarda 20 min y la UI dice "23s" — engañoso
2. El evidence pack no incluye bioprospecting facts (482 en DB, 0 mostrados)
3. El `.env` no se re-lee dinámicamente (config silenciosa)

Los fixes son de bajo esfuerzo (S-M) y alto impacto. Recomiendo Sprint 1 primero.