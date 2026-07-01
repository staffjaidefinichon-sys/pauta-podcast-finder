#!/usr/bin/env python3
"""
Curador de noticias para podcast de humor (Chile + mundo).

Busca con la API de Claude (web search) y escribe:
  - data/bandeja.json            (histórico de noticias candidatas)
  - data/pauta-YYYY-MM-DD.json   (noticias del día; cada una con region chile/mundo)
  - data/bandeja_temas.json      (histórico de temas para conversar)
  - data/temas-YYYY-MM-DD.json   (temas para conversar del día)

El "aprendizaje" es por contexto: inyecta data/preferencias.json en el prompt
para que el filtrado refleje las decisiones reales del conductor, tanto para
noticias como para temas de conversación.

Uso:
    python scripts/buscar.py

Variables de entorno:
    ANTHROPIC_API_KEY   (requerida) — clave de la API de Anthropic.
    MODELO_CLAUDE       (opcional)  — id del modelo. Default: claude-opus-4-8.
    N_NOTICIAS          (opcional)  — tope de noticias por región. Default: 6.
    ZONA_HORARIA        (opcional)  — default: America/Santiago.
"""

from __future__ import annotations

import json
import os
import re
import sys
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import anthropic

# --- Rutas -------------------------------------------------------------------

RAIZ = Path(__file__).resolve().parent.parent
DIR_DATOS = RAIZ / "data"
ARCHIVO_BANDEJA = DIR_DATOS / "bandeja.json"
ARCHIVO_BANDEJA_TEMAS = DIR_DATOS / "bandeja_temas.json"
ARCHIVO_PREFERENCIAS = DIR_DATOS / "preferencias.json"

# --- Configuración -----------------------------------------------------------

MODELO = os.environ.get("MODELO_CLAUDE", "claude-opus-4-8")
N_NOTICIAS = int(os.environ.get("N_NOTICIAS", "6"))
ZONA = ZoneInfo(os.environ.get("ZONA_HORARIA", "America/Santiago"))

CATEGORIAS_VALIDAS = {"absurdo", "observacional", "curioso", "otro"}
REGIONES_VALIDAS = {"chile", "mundo"}


# --- Utilidades de archivos --------------------------------------------------

def leer_json(ruta: Path, por_defecto):
    """Lee un JSON; si no existe o está corrupto, devuelve `por_defecto`."""
    try:
        with ruta.open(encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return por_defecto


def escribir_json(ruta: Path, datos) -> None:
    """Escribe JSON con indentación, en UTF-8."""
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with ruta.open("w", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False, indent=2, sort_keys=False)
        f.write("\n")


# --- Construcción del prompt --------------------------------------------------

def construir_prompt(preferencias: dict, fecha: str) -> str:
    """Arma el prompt inyectando las preferencias aprendidas."""

    def formatear(items: list, campo_titulo: str) -> str:
        if not items:
            return "  (todavía no hay decisiones registradas)"
        lineas = []
        for it in items[-30:]:
            titulo = it.get(campo_titulo) or it.get("titular") or it.get("titulo") or ""
            cat = it.get("categoria", "")
            razon = it.get("razon", "")
            lineas.append(f"  - [{cat}] {titulo} — {razon}")
        return "\n".join(lineas)

    def formatear_ejemplos(items: list) -> str:
        if not items:
            return "  (sin ejemplos aún)"
        lineas = []
        for it in items[-20:]:
            t = it.get("titular", "")
            u = it.get("url", "")
            p = it.get("por_que", "")
            linea = f"  - {t}"
            if u:
                linea += f" ({u})"
            if p:
                linea += f" — {p}"
            lineas.append(linea)
        return "\n".join(lineas)

    notas = (preferencias.get("notas_conductor") or "").strip()
    ejemplos = preferencias.get("ejemplos_conductor", [])

    reglas = preferencias.get("reglas_aprendidas", [])
    reglas_temas = preferencias.get("reglas_temas", [])
    reglas_txt = "\n".join(f"  - {r}" for r in reglas) if reglas else "  (sin reglas aún)"
    reglas_temas_txt = (
        "\n".join(f"  - {r}" for r in reglas_temas) if reglas_temas else "  (sin reglas aún)"
    )

    return f"""Eres el curador de contenido de un podcast chileno de humor y conversación.

Hoy es {fecha}. Buscarás en la web y propondrás dos cosas:
  (A) NOTICIAS reales y recientes (últimos 2-3 días) que den para humor.
  (B) TEMAS para conversar (no noticias puntuales, sino disparadores de conversación).

## Tipo de podcast
- Humor y conversación, chileno.
- Tono: mezcla de absurdo/WTF (para reír fuerte) e irónico/observacional (para
  segmentos de conversación más largos).

## REGLA INVIOLABLE: nada de política
EXCLUIR SIEMPRE cualquier cosa con ángulo político: figuras políticas, elecciones,
gobierno, ministerios, conflictos partidistas, parlamentarios. Si algo es gracioso
pero tiene arista política, se DESCARTA. Sin excepción.

## (A) NOTICIAS — dos bloques: Chile y Mundo
- Bloque CHILE: noticias chilenas virales, curiosas o absurdas. Idealmente de nicho
  o de regiones (no solo Santiago).
- Bloque MUNDO: noticias absurdas, extrañas o insólitas de cualquier parte del mundo.
- Cada noticia debe llevar su campo "region" con valor "chile" o "mundo".

## (B) TEMAS para conversar
Disparadores de CONVERSACIÓN, no una noticia específica. Pueden inspirarse en lo que
está siendo tendencia (busca "qué es tendencia / lo más comentado en redes / Twitter
hoy en Chile") o en fenómenos cotidianos. Ejemplos del estilo buscado:
  - "La obsesión chilena con ponerle palta a todo: ¿identidad nacional o exageración?"
  - "Por qué todos odiamos/amamos los grupos de WhatsApp familiares"
Cada tema es un ÁNGULO para charlar con humor observacional, no un hecho noticioso.

## Indicaciones directas del conductor (PRIORIDAD MÁXIMA — respétalas por sobre todo)
{notas if notas else "  (sin indicaciones por ahora)"}

## Noticias que el conductor entregó como referencia ("así las quiero")
Usa estas como norte del estilo y tipo de noticia que busca. Encontrá noticias del
mismo espíritu (no las repitas si ya pasaron):
{formatear_ejemplos(ejemplos)}

## Lo que el conductor APROBÓ antes (noticias)
{formatear(preferencias.get("aprobados", []), "titular")}

## Lo que el conductor DESCARTÓ antes (noticias)
{formatear(preferencias.get("descartados", []), "titular")}

## Reglas aprendidas (noticias)
{reglas_txt}

## Temas de conversación que APROBÓ antes
{formatear(preferencias.get("temas_aprobados", []), "titulo")}

## Temas de conversación que DESCARTÓ antes
{formatear(preferencias.get("temas_descartados", []), "titulo")}

## Reglas aprendidas (temas)
{reglas_temas_txt}

## Qué hacer
1. Haz entre 4 y 6 búsquedas con ángulos distintos (no más), por ejemplo:
   virales/insólito Chile y regiones, noticias raras del mundo, animales o fails,
   tendencias en redes/Twitter. Aprovechá cada búsqueda para varias candidatas.
2. Muchos resultados serán PÁGINAS DE SECCIÓN o LISTADO (ej. .../temas/virales/,
   .../lista/categorias/curiosidades, .../noticias/viral). ESAS NO son noticias.
   Cuando encuentres una sección así, ÁBRELA con web_fetch y extrae de adentro las
   NOTAS ESPECÍFICAS, usando la URL directa de cada nota individual.
3. Filtra excluyendo política y lo que choque con las reglas aprendidas.
4. Sé GENEROSO con las noticias (es un buzón; el conductor filtra después).

## REGLA DE URLs (crítica)
El campo "url" de cada noticia DEBE apuntar a la NOTA ESPECÍFICA (la página del
artículo individual), NUNCA a una sección, categoría, tag, portada, listado o
búsqueda. Si solo tenés el link de una sección, entra con web_fetch y saca el link
del artículo puntual. Si no lográs la URL directa de una nota, NO la incluyas.

## Formato de salida (OBLIGATORIO)
Después de buscar, responde ÚNICAMENTE con un bloque ```json ... ``` que contenga UN
OBJETO con exactamente estas dos claves:

{{
  "noticias": [
    {{
      "titular": "string",
      "resumen": "1-2 frases en español neutro",
      "fuente": "nombre del medio",
      "url": "enlace real a la noticia",
      "por_que_humor": "razón breve de por qué da para reírse",
      "categoria": "absurdo | observacional | curioso | otro",
      "region": "chile | mundo"
    }}
  ],
  "temas": [
    {{
      "titulo": "el tema de conversación, fraseado como disparador",
      "gancho": "1 frase que enganche",
      "por_que_conversar": "por qué da para una buena conversación con humor",
      "categoria": "absurdo | observacional | curioso | otro",
      "basado_en": "qué tendencia o fenómeno lo inspiró (breve)"
    }}
  ]
}}

Apunta a entre 8 y 12 noticias en total (mezcla de chile y mundo) y entre 3 y 4 temas.
No inventes noticias: solo las que encontraste realmente, con su URL real. No incluyas
texto fuera del bloque JSON."""


# --- Llamada a la API --------------------------------------------------------

def buscar(cliente: anthropic.Anthropic, prompt: str) -> dict:
    """Llama a Claude con web search y devuelve {'noticias': [...], 'temas': [...]}.

    Web search corre como bucle del lado servidor: si llega al límite, devuelve
    stop_reason="pause_turn" y hay que reenviar para que continúe.
    """
    tools = [
        {"type": "web_search_20260209", "name": "web_search", "max_uses": 6},
        # web_fetch permite abrir páginas de sección/listado y sacar las notas
        # específicas de adentro (con su URL directa).
        {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 5},
    ]
    mensajes = [{"role": "user", "content": prompt}]

    respuesta = None
    for _ in range(3):
        respuesta = cliente.messages.create(
            model=MODELO,
            max_tokens=16000,
            tools=tools,
            messages=mensajes,
        )
        if respuesta.stop_reason != "pause_turn":
            break
        mensajes.append({"role": "assistant", "content": respuesta.content})

    print(f"  stop_reason del modelo: {respuesta.stop_reason}")

    texto = "".join(b.text for b in respuesta.content if b.type == "text")
    datos = extraer_objeto_json(texto)

    if not datos:
        cola = texto[-600:].replace("\n", " ") if texto else "(sin texto)"
        print(f"  [diag] no se extrajo JSON. Final del texto: {cola}")
        return {"noticias": [], "temas": []}

    return {
        "noticias": datos.get("noticias", []) or [],
        "temas": datos.get("temas", []) or [],
    }


def extraer_objeto_json(texto: str) -> dict | None:
    """Extrae el objeto JSON del texto del modelo, tolerante a ```json ... ```."""
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", texto, re.DOTALL)
    crudo = m.group(1) if m else None

    if crudo is None:
        inicio = texto.find("{")
        fin = texto.rfind("}")
        if inicio != -1 and fin != -1 and fin > inicio:
            crudo = texto[inicio : fin + 1]

    if crudo is None:
        return None

    try:
        datos = json.loads(crudo)
    except json.JSONDecodeError:
        return None

    return datos if isinstance(datos, dict) else None


# --- Normalización y dedupe --------------------------------------------------

def normalizar_url(url: str) -> str:
    url = (url or "").strip().lower()
    url = re.sub(r"[?#].*$", "", url)
    url = re.sub(r"/+$", "", url)
    return url


def normalizar_titulo(t: str) -> str:
    """Clave de dedupe para temas (sin URL): título en minúsculas y compacto."""
    return re.sub(r"\s+", " ", (t or "").strip().lower())


# Marcadores de que una URL es una SECCIÓN/LISTADO (no una nota específica).
_SECCION_CONTIENE = (
    "/lista/", "/listas/", "/temas/", "/tema/", "/tag/", "/tags/",
    "/categoria/", "/categorias/", "/etiqueta/", "/etiquetas/",
    "/seccion/", "/secciones/", "/buscar", "/search",
)
_SECCION_TERMINA = (
    "viral", "virales", "curiosidades", "tendencias",
    "insolito", "insolitos", "insolitas", "ranking", "noticias",
)


def es_url_de_seccion(url: str) -> bool:
    """True si la URL apunta a una sección/listado y no a una noticia puntual."""
    u = normalizar_url(url)                       # sin query ni barra final
    path = re.sub(r"^https?://[^/]+", "", u)      # solo el path
    if any(m in path for m in _SECCION_CONTIENE):
        return True
    ultimo = path.rsplit("/", 1)[-1]
    return ultimo in _SECCION_TERMINA


def semana_de(fecha_iso: str) -> str:
    """Miércoles de cierre (el próximo miércoles >= fecha) al que pertenece el ítem.

    Cada 'semana de pauta' cierra un miércoles. Lo encontrado de jueves a martes
    cae en el miércoles siguiente; lo del miércoles cae en ese mismo día. Así las
    semanas no se mezclan. (En datetime, lunes=0 ... miércoles=2.)
    """
    d = date.fromisoformat(fecha_iso)
    dias = (2 - d.weekday()) % 7
    return (d + timedelta(days=dias)).isoformat()


def normalizar_noticia(crudo: dict, fecha: str) -> dict | None:
    titular = (crudo.get("titular") or "").strip()
    url = (crudo.get("url") or "").strip()
    if not titular or not url:
        return None

    categoria = (crudo.get("categoria") or "otro").strip().lower()
    if categoria not in CATEGORIAS_VALIDAS:
        categoria = "otro"

    region = (crudo.get("region") or "chile").strip().lower()
    if region not in REGIONES_VALIDAS:
        region = "chile"

    return {
        "id": str(uuid.uuid4()),
        "fecha_encontrada": fecha,
        "titular": titular,
        "resumen": (crudo.get("resumen") or "").strip(),
        "fuente": (crudo.get("fuente") or "").strip(),
        "url": url,
        "por_que_humor": (crudo.get("por_que_humor") or "").strip(),
        "categoria": categoria,
        "region": region,
        "semana": semana_de(fecha),
        "estado": "pendiente",
    }


def normalizar_tema(crudo: dict, fecha: str) -> dict | None:
    titulo = (crudo.get("titulo") or "").strip()
    if not titulo:
        return None

    categoria = (crudo.get("categoria") or "observacional").strip().lower()
    if categoria not in CATEGORIAS_VALIDAS:
        categoria = "observacional"

    return {
        "id": str(uuid.uuid4()),
        "fecha_encontrada": fecha,
        "titulo": titulo,
        "gancho": (crudo.get("gancho") or "").strip(),
        "por_que_conversar": (crudo.get("por_que_conversar") or "").strip(),
        "categoria": categoria,
        "basado_en": (crudo.get("basado_en") or "").strip(),
        "semana": semana_de(fecha),
        "estado": "pendiente",
    }


# --- Flujo principal ---------------------------------------------------------

def main() -> int:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: falta la variable de entorno ANTHROPIC_API_KEY.", file=sys.stderr)
        return 1

    ahora = datetime.now(ZONA)
    fecha = ahora.strftime("%Y-%m-%d")
    print(f"[{ahora.isoformat()}] Buscando contenido para el {fecha}...")

    preferencias = leer_json(ARCHIVO_PREFERENCIAS, {})
    bandeja = leer_json(ARCHIVO_BANDEJA, [])
    bandeja_temas = leer_json(ARCHIVO_BANDEJA_TEMAS, [])

    cliente = anthropic.Anthropic(api_key=api_key)
    prompt = construir_prompt(preferencias, fecha)

    try:
        resultado = buscar(cliente, prompt)
        # Red de seguridad: si vuelve vacía (generación floja), reintentar una vez.
        if not resultado["noticias"] and not resultado["temas"]:
            print("  Volvió vacía; reintentando una vez...")
            resultado = buscar(cliente, prompt)
    except anthropic.APIError as e:
        print(f"ERROR llamando a la API de Claude: {e}", file=sys.stderr)
        return 2

    crudas_noticias = resultado["noticias"]
    crudas_temas = resultado["temas"]
    print(f"  El modelo devolvió {len(crudas_noticias)} noticias y {len(crudas_temas)} temas.")

    # --- Noticias: dedupe por URL ---
    urls_conocidas = {normalizar_url(it.get("url", "")) for it in bandeja}
    nuevas_noticias = []
    descartadas_seccion = 0
    for crudo in crudas_noticias:
        item = normalizar_noticia(crudo, fecha)
        if item is None:
            continue
        if es_url_de_seccion(item["url"]):
            descartadas_seccion += 1
            continue
        clave = normalizar_url(item["url"])
        if clave in urls_conocidas:
            continue
        urls_conocidas.add(clave)
        nuevas_noticias.append(item)

    if descartadas_seccion:
        print(f"  Descartadas {descartadas_seccion} por ser URL de sección/listado.")

    # --- Temas: dedupe por título ---
    titulos_conocidos = {normalizar_titulo(it.get("titulo", "")) for it in bandeja_temas}
    nuevos_temas = []
    for crudo in crudas_temas:
        tema = normalizar_tema(crudo, fecha)
        if tema is None:
            continue
        clave = normalizar_titulo(tema["titulo"])
        if clave in titulos_conocidos:
            continue
        titulos_conocidos.add(clave)
        nuevos_temas.append(tema)

    print(f"  {len(nuevas_noticias)} noticias nuevas, {len(nuevos_temas)} temas nuevos.")

    # --- Acumular en las bandejas ---
    bandeja.extend(nuevas_noticias)
    bandeja_temas.extend(nuevos_temas)

    # --- Pauta y temas del día: TODO lo que sigue pendiente de decisión ---
    # No solo lo nuevo de esta corrida: se muestran también las candidatas de
    # corridas anteriores que el conductor todavía no marcó Va/No va. Al decidir
    # una (aprobada/descartada) sale de esta vista automáticamente.
    PENDIENTES = {"pendiente", "en_pauta"}

    # Más recientes primero (la bandeja se acumula en orden cronológico).
    pauta = [it for it in reversed(bandeja) if it.get("estado") in PENDIENTES]
    temas_dia = [it for it in reversed(bandeja_temas) if it.get("estado") in PENDIENTES]

    # Marcar como en_pauta todo lo que está a la vista.
    for it in pauta:
        it["estado"] = "en_pauta"
    for it in temas_dia:
        it["estado"] = "en_pauta"

    chile = [it for it in pauta if it.get("region") == "chile"]
    mundo = [it for it in pauta if it.get("region") == "mundo"]

    # --- Escribir todo ---
    escribir_json(ARCHIVO_BANDEJA, bandeja)
    escribir_json(ARCHIVO_BANDEJA_TEMAS, bandeja_temas)
    escribir_json(DIR_DATOS / f"pauta-{fecha}.json", pauta)
    escribir_json(DIR_DATOS / f"temas-{fecha}.json", temas_dia)

    print(f"  Bandeja: {len(bandeja)} noticias · {len(bandeja_temas)} temas (histórico).")
    print(f"  Pauta del día: {len(pauta)} noticias ({len(chile)} Chile, {len(mundo)} mundo).")
    print(f"  Temas del día: {len(temas_dia)}.")
    print("Listo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
