# Proyecto: Curador de noticias para podcast de humor (Chile)

> Archivo de contexto para Claude Code. Léelo completo antes de empezar a generar código.

## 1. Objetivo

Construir un sistema **automático** que todos los días busque noticias chilenas
virales y graciosas, las acumule, y arme una **pauta** con los mejores temas para
un podcast de humor y conversación. El conductor (dueño del repo) revisa la pauta
y marca qué temas van y cuáles no. El sistema **aprende** de esas decisiones para
afinar el filtro con el tiempo.

El sistema debe correr **sin depender de un PC encendido**: toda la automatización
vive en GitHub Actions.

## 2. Sobre el podcast

- **Tipo:** humor y conversación, Chile.
- **Tono de humor:** mezcla de todo — absurdo/WTF para reír fuerte, e irónico/
  observacional para los segmentos más largos de conversación.
- **EXCLUIR SIEMPRE:** política. Nada de figuras políticas, elecciones, gobierno,
  conflictos partidistas. Si una noticia es graciosa pero tiene ángulo político,
  se descarta.
- **Preferencia geográfica:** priorizar noticias chilenas, idealmente de nicho /
  locales que "den para humor". Internacionales raras también sirven como
  complemento, pero el foco es Chile.

## 3. Arquitectura (todo gratis, sin servidor propio)

```
GitHub Actions (cron)  ──>  script Python  ──>  API de Claude (con web search)
        │                                              │
        │                                              ▼
        │                                   genera/actualiza archivos:
        │                                   - data/bandeja.json   (acumulado)
        │                                   - data/pauta-YYYY-MM-DD.json (del día)
        ▼
   hace commit de los archivos al repo
        │
        ▼
GitHub Pages (panel web)  <── lee pauta del día (JSON)
        │
        ▼
   usuario marca "Va" / "No va" por tema
        │
        ▼
   se actualiza data/preferencias.json  (memoria de aprendizaje)
```

### Componentes
1. **GitHub Actions + cron:** dispara el script 1–2 veces al día (sugerido 09:00 y
   18:00 hora de Chile, `America/Santiago`). Recuerda que el cron de GitHub usa UTC.
2. **Script Python:** llama a la API de Claude con la herramienta de **web search**
   activada. Construye el prompt incluyendo el contenido de `preferencias.json` como
   contexto, para que el filtrado refleje los criterios reales del podcast.
3. **GitHub Pages:** panel web estático que muestra la pauta del día como tarjetas
   con botones "Va" / "No va".
4. **Repositorio:** guarda todo versionado (historial completo de pautas y
   decisiones).

## 4. Archivos de datos

### `data/bandeja.json` (acumulado)
Lista histórica de todas las noticias candidatas encontradas. Cada ítem:
```json
{
  "id": "uuid",
  "fecha_encontrada": "2026-06-26",
  "titular": "string",
  "resumen": "1-2 frases en español neutro",
  "fuente": "string",
  "url": "string",
  "por_que_humor": "razón breve de por qué da para reírse",
  "categoria": "absurdo | observacional | curioso | otro",
  "estado": "pendiente | en_pauta | aprobada | descartada"
}
```

### `data/pauta-YYYY-MM-DD.json` (del día)
Recorte fino: solo los mejores temas del día (sugerido 5–8), listos para revisión.
Misma estructura que los ítems de la bandeja.

### `data/preferencias.json` (memoria / aprendizaje)
El corazón del aprendizaje. Acumula las decisiones del conductor:
```json
{
  "aprobados": [
    { "titular": "...", "categoria": "...", "razon": "por qué funcionó" }
  ],
  "descartados": [
    { "titular": "...", "categoria": "...", "razon": "por qué no funcionó" }
  ],
  "reglas_aprendidas": [
    "Ej: priorizar noticias de regiones, no solo Santiago",
    "Ej: evitar humor que dependa de famosos internacionales desconocidos en Chile"
  ]
}
```

## 5. Cómo funciona el "aprendizaje"

El modelo **no se reentrena**. El aprendizaje es por **contexto acumulado**:
1. Cada decisión "Va / No va" se guarda en `preferencias.json`.
2. En cada corrida, el script inyecta ese archivo en el prompt antes de buscar.
3. Claude filtra teniendo a la vista los criterios reales del podcast.
4. Mientras más decisiones, más afinado el filtro.

Opcional/futuro: el script puede, cada cierto tiempo, pedirle a Claude que
**resuma** las decisiones en nuevas `reglas_aprendidas` para mantener el contexto
compacto.

## 6. Seguridad

- La **API key** de Anthropic va como **GitHub Secret** (`ANTHROPIC_API_KEY`).
  Nunca en el código, nunca en commits.
- El panel web no debe exponer la API key (el panel solo lee/escribe JSON del repo,
  no llama a la API directamente).

## 7. Entregables esperados de Claude Code

1. Estructura de repo con carpetas `data/`, `scripts/`, `.github/workflows/`, `web/`.
2. Script Python (`scripts/buscar.py`) que llama a la API con web search, filtra
   excluyendo política, y escribe `bandeja.json` + `pauta-del-día.json`.
3. Workflow `.github/workflows/diario.yml` con cron 2x/día y commit automático.
4. Panel web estático en `web/` (HTML/JS) para GitHub Pages, con tarjetas y
   botones Va / No va que actualizan `preferencias.json`.
5. `README.md` con instrucciones de setup (crear secret, activar Pages, etc.).

## 8. Notas de estilo

- Todo el contenido orientado al usuario en **español neutro**.
- Mensajes de la pauta concisos: titular + por qué da para humor.
- Preferir simplicidad y bajo costo sobre soluciones sofisticadas.

## 9. Decisiones ya tomadas

- Plataforma de automatización: **GitHub Actions** (gratis, agendado, con historial).
- Panel: **GitHub Pages** (estático, gratis).
- Lenguaje del script: **Python**.
- Frecuencia: **1–2 veces al día**.
- Modelo a usar en la API: el más reciente disponible para esta tarea (confirmar en
  la documentación de Anthropic al implementar).
