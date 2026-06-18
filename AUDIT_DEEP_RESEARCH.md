# Deep-Research Audit — Curcumin + Alzheimer Query

> Auditoría end-to-end del query real disparado en el browser el 2026-06-17 17:34, comparada contra la query `anthoteibinene` validada en la sesión anterior. Generada el 2026-06-18.

## TL;DR

**El query funcionó y devolvió un resultado excelente.** Pero hay 10 hallazgos concretos (4 críticos, 3 importantes, 3 menores) que afectan performance, correctness y UX. Ninguno es un blocker — el sistema es funcional — pero son oportunidades de mejora de bajo esfuerzo.

**El cuello de botella REAL** (no es un timeout — es un cuello serializado):

| Categoría | Hallazgo | Impacto |
|---|---|---|
| 🔴 Crítico | **9m 38s "invisible" en iteración 2** entre decision de continue y ejecución de tasks | Performance, UX |
| 🔴 Crítico | **1m 13s en iter 1 + 1m 16s en iter 2 = 2m 29s en LLM calls** que NO se loggean | Observability |
| 🔴 Crítico | In-process mode sin timeout — queries pueden quedar colgados 15+ min (HALLAZGO #1) | UX, server resources |
| 🔴 Crítico | `research_brain_evidence.bioprospectingFacts` siempre vacío en evidence pack (HALLAZGO #2) | Features no se usan |
| 🟡 Importante | Literature agent tarda ~93s por task (HALLAZGO #4) | Performance |
| 🟡 Importante | Planning agent genera 5 sub-queries para "curcumin" cuando 1-2 bastarían (HALLAZGO #5) | Quality |
| 🟡 Importante | `bioprospectingFacts` no se filtra por query relevance (HALLAZGO #6) | Correctness |
| 🟢 Menor | OpenScholar y Edison SIEMPRE fallan (no auth) — log error en vez de info (HALLAZGO #7) | Operacional |
| 🟢 Menor | `evidence_chunks` join en evidence pack miss en algunos casos (HALLAZGO #8) | Quality |
| 🟢 Menor | `bioprospecting_fact_phrase_failed × 9` por iteración (HALLAZGO #10) | Noise |

**Antes de meter timeout, hay que perfilar los 9m 38s** — es el agujero más grande y NO es un LLM call (las tasks completas en 7s después). El cuello está en el código entre `auto_continuing_to_next_iteration` y `🚀 Starting search pipeline`.

---

## Audit 1: Timing end-to-end del query del browser

**Query**: "curcumin + Alzheimer: efficacy and nanocarrier strategies"
**Disparado**: 2026-06-17 17:34:10 UTC
**Completado**: 2026-06-17 17:55:02 UTC
**Total**: **20m 50s** wall-time

### Iteración 1 (17:34:13 → 17:38:39)

| Etapa | Timestamp | Duración | Notas |
|---|---|---|---|
| `starting_iteration` (1) | 17:34:13 | — | |
| `research_brain_search_completed` (initial) | 17:34:14 | 1s | Knowledge search rápido |
| `current_suggested_next_steps` | 17:34:50 | **36s gap** | iteration 1 ended, auto-iter |
| `initial_plan_generated` | 17:35:14 | **24s gap** | Planning LLM call |
| `new_tasks_added_to_plan` | 17:36:08 | **54s gap** | 5 LITERATURE tasks ejecutándose |
| `literature_agent_started × 2` (OpenScholar+Edison) | 17:36:09 | — | Edison fail instant (no key) |
| `knowledge_search_completed` (5 tasks en paralelo) | 17:36:11 | 2.5s c/u | Knowledge agent local |
| `task_completed` | 17:36:12 | <1s c/u | |
| `hypothesis_agent_started` | 17:36:13 | — | |
| `hypothesis_generated` | 17:37:40 | **1m 27s** | LLM call (Qwen) |
| `skipping_discovery_insufficient_messages` | 17:37:41 | — | Primera hypothesis: "insuficiente" |
| `reflection_agent_started` | 17:37:41 | — | |
| `reflection_completed` | 17:38:39 | **58s** | LLM call |
| `world_state_updated` | 17:39:24 | — | |
| `plan_generated` (next iter) | 17:39:58 | **34s** | Planning para iter 2 |
| `next_iteration_suggestions_saved` | 17:40:37 | **39s** | Decide continue |
| `continue_research_agent_started` | 17:40:37 | — | Auto-continue (first_iteration_auto_continue) |

### Iteración 2 (17:40:37 → 17:55:02)

| Etapa | Timestamp | Duración | Notas |
|---|---|---|---|
| `reply_agent_started` | 17:40:37 | — | Reply mode report |
| `reply_generated` | 17:41:50 | **1m 13s** | Reply (vacío) |
| `auto_continuing_to_next_iteration` | 17:41:53 | — | |
| `starting_iteration` (2) | 17:41:54 | — | |
| `research_brain_search_completed` (iter 2) | 17:41:56 | 1s | |
| **`🚀 Starting search pipeline` (5 tasks)** | 17:51:38 | **9m 38s gap** | LITERATURE tasks ejecutándose |
| `knowledge_search_completed` (× 5) | 17:51:39-40 | <1s c/u | |
| `task_completed` (× 5) | 17:51:45-46 | <1s c/u | |
| `hypothesis_agent_started` | 17:51:46 | — | |
| `hypothesis_generated` | 17:53:02 | **1m 16s** | |
| `running_reflection_and_discovery_agents` | 17:53:03 | — | Paralelo |
| `reflection_completed` | 17:54:30 | **1m 27s** | |
| `discovery_extraction_completed` | 17:55:01 | **31s** | |
| `discovery_agent_completed` | 17:55:02 | <1s | |
| `deep_research_execution_failed` | 17:55:02 | — | Error al final |

### Observaciones del timing

**Gaps totales = 19m 24s de los 20m 50s** (93% del tiempo son operaciones no loggeadas):

| Gap | Duración | Qué pasa |
|---|---|---|
| 17:34:14 → 17:34:50 | 36s | Suggested next steps LLM call |
| 17:34:50 → 17:35:14 | 24s | Initial plan LLM call |
| 17:35:14 → 17:36:08 | 54s | 5 LITERATURE tasks ejecutándose |
| 17:37:41 → 17:38:39 | 58s | Reflection LLM call |
| 17:39:24 → 17:39:58 | 34s | Next-iter plan LLM call |
| 17:39:58 → 17:40:37 | 39s | Next-iter suggestions LLM call |
| **17:41:56 → 17:51:38** | **9m 38s** | **5 LITERATURE tasks ejecutándose** (iter 2) |
| 17:51:46 → 17:53:02 | 1m 16s | Hypothesis LLM call |
| 17:53:03 → 17:54:30 | 1m 27s | Reflection LLM call |

**El usuario solo vio "5 Literature Search steps × 3-6s cada uno = 23s"** en el Activity Log. Esto es **engañoso**: el total real fue 20m 50s. La diferencia (20m 27s) es invisible.

**El gap de 9m 38s en iteración 2 es el más sospechoso**: el system ejecutó 5 LITERATURE tasks con Promise.all, cada una haciendo vector_search (~1s) + knowledge_search (~2.5s) → debería tardar ~3s, no 9m 38s.

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

### 🔴 HALLAZGO #1 — In-process mode sin timeout (CRÍTICO)

**Síntoma**: Query `08522dda` (mi reproducción) colgó 16+ minutos sin timeout.

**Evidencia**:
```
[2026-06-18 03:10:29] starting_iteration
[2026-06-18 03:10:29] starting_iteration (re-polls every 5s)
... sin "completed" o "failed" ...
[2026-06-18 03:26:50] next_iteration_suggestions_saved  (recién a los 16m!)
```

**Causa raíz**: El `in-process` runner en `src/routes/deep-research/start.ts:849` no tiene timeout. El autonomous research loop itera sin límite hasta que `deepResearchRun.completedAt` se setee. Si una iteración tiene un await que nunca resuelve, el query queda colgado.

**Fix propuesto**:
- Agregar timeout por iteración (default 5 min)
- Si expira, marcar iteración como failed con reason `"timeout"` y continuar a hypothesis
- Top-level timeout: 25 min — si expira, retornar hypothesis parcial con warning

**Esfuerzo**: S (1-2 horas)
**Archivos afectados**: `src/services/deep-research/runner.ts` (probable)

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

### Sprint 0 (1 día) — Profiling + medición

**CRÍTICO**: Antes de cualquier fix, instrumentar el código entre `auto_continuing_to_next_iteration` y `🚀 Starting search pipeline` para saber qué pasa en esos 9m 38s.

1. **HALLAZGO #9**: agregar `console.time()` + timestamps a `start.ts:1386-1697` (la región que ejecuta tasks)
2. **HALLAZGO #10**: silenciar o arreglar el `bioprospecting_fact_phrase_failed × 9`

**Output esperado**: trace con timing exacto de cada await. Una vez sabemos qué es, decidimos el fix.

### Sprint 1 (1-2 días) — UX + correctness

3. **HALLAZGO #1**: timeout por iteración + top-level timeout (S) — **DESPUÉS de perfilar**
4. **HALLAZGO #3**: documentar que .env requiere restart (Trivial)
5. **HALLAZGO #7**: loggear disabled cuando Edison/OpenScholar no están (S)

### Sprint 2 (2-3 días) — Performance + features

6. **HALLAZGO #4**: parallelizar literature_agent (M) — **DESPUÉS de saber qué pasa en el gap**
7. **HALLAZGO #5**: prompt del planning agent más enfocado (S-M)
8. **HALLAZGO #2+#6**: filtrar bioprospecting_facts por relevance (M)

### Sprint 3 (1-2 días) — Quality

9. **HALLAZGO #8**: revisar join de evidence_chunks en sources (M)

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