#!/usr/bin/env python3
"""
Curador de noticias para podcast de humor (Chile).

Busca noticias chilenas virales/graciosas usando la API de Claude con web search,
filtra excluyendo política, y escribe:
  - data/bandeja.json            (acumulado histórico, con dedupe)
  - data/pauta-YYYY-MM-DD.json   (los mejores temas del día)

El "aprendizaje" es por contexto: inyecta data/preferencias.json en el prompt
para que el filtrado refleje las decisiones reales del conductor.

Uso:
    python scripts/buscar.py

Variables de entorno:
    ANTHROPIC_API_KEY   (requerida) — clave de la API de Anthropic.
    MODELO_CLAUDE       (opcional)  — id del modelo. Default: claude-opus-4-8.
    N_PAUTA             (opcional)  — cuántos temas en la pauta del día. Default: 6.
    ZONA_HORARIA        (opcional)  — default: America/Santiago.
"""

from __future__ import annotations

import json
import os
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import anthropic

# --- Rutas -------------------------------------------------------------------

RAIZ = Path(__file__).resolve().parent.parent
DIR_DATOS = RAIZ / "data"
ARCHIVO_BANDEJA = DIR_DATOS / "bandeja.json"
ARCHIVO_PREFERENCIAS = DIR_DATOS / "preferencias.json"

# --- Configuración -----------------------------------------------------------

MODELO = os.environ.get("MODELO_CLAUDE", "claude-opus-4-8")
N_PAUTA = int(os.environ.get("N_PAUTA", "6"))
ZONA = ZoneInfo(os.environ.get("ZONA_HORARIA", "America/Santiago"))

CATEGORIAS_VALIDAS = {"absurdo", "observacional", "curioso", "otro"}


# --- Utilidades de archivos --------------------------------------------------

def leer_json(ruta: Path, por_defecto):
    """Lee un JSON; si no existe o está corrupto, devuelve `por_defecto`."""
    try:
        with ruta.open(encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return por_defecto


def escribir_json(ruta: Path, datos) -> None:
    """Escribe JSON con indentación, en UTF-8 y con orden de claves estable."""
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with ruta.open("w", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False, indent=2, sort_keys=False)
        f.write("\n")


# --- Construcción del prompt --------------------------------------------------

def construir_prompt(preferencias: dict, fecha: str) -> str:
    """Arma el prompt inyectando las preferencias aprendidas."""
    aprobados = preferencias.get("aprobados", [])
    descartados = preferencias.get("descartados", [])
    reglas = preferencias.get("reglas_aprendidas", [])

    def formatear_decisiones(items: list) -> str:
        if not items:
            return "  (todavía no hay decisiones registradas)"
        lineas = []
        for it in items[-30:]:  # solo las más recientes, para mantener el contexto compacto
            titular = it.get("titular", "")
            cat = it.get("categoria", "")
            razon = it.get("razon", "")
            lineas.append(f"  - [{cat}] {titular} — {razon}")
        return "\n".join(lineas)

    reglas_txt = "\n".join(f"  - {r}" for r in reglas) if reglas else "  (sin reglas aún)"

    return f"""Eres el curador de noticias de un podcast chileno de humor y conversación.

Hoy es {fecha}. Tu tarea: buscar en la web noticias REALES y RECIENTES (de los últimos
2-3 días) de Chile que den para humor en el podcast, y proponer las mejores.

## Tipo de podcast
- Humor y conversación, Chile.
- Tono: mezcla de absurdo/WTF (para reír fuerte) e irónico/observacional (para
  segmentos de conversación más largos).

## REGLA INVIOLABLE: nada de política
EXCLUIR SIEMPRE cualquier noticia con ángulo político: figuras políticas, elecciones,
gobierno, ministerios, conflictos partidistas, parlamentarios, alcaldes en función
política. Si una noticia es graciosa pero tiene arista política, se DESCARTA. Sin excepción.

## Preferencia geográfica
- Priorizar noticias chilenas, idealmente de nicho o locales (regiones, no solo Santiago)
  que "den para humor".
- Internacionales raras sirven solo como complemento; el foco es Chile.

## Lo que el conductor ya APROBÓ antes (temas que funcionaron)
{formatear_decisiones(aprobados)}

## Lo que el conductor ya DESCARTÓ antes (temas que NO funcionaron)
{formatear_decisiones(descartados)}

## Reglas aprendidas (respétalas)
{reglas_txt}

## Qué hacer
1. Usa la búsqueda web de forma EXHAUSTIVA: haz AL MENOS 6 búsquedas con ángulos
   distintos, por ejemplo:
   - "noticias virales Chile" / "noticia insólita Chile"
   - "noticia curiosa región" (Valparaíso, Biobío, Antofagasta, Magallanes, etc.)
   - "noticia rara Chile que pasó hoy / esta semana"
   - hechos curiosos de animales, festivales locales, costumbres, fails virales
   - tendencias chilenas en redes sociales
2. Filtra excluyendo política y todo lo que choque con las reglas aprendidas.
3. Sé GENEROSO: esto es un buzón de candidatas, el conductor filtra después. Si una
   noticia tiene aunque sea un ángulo gracioso, inclúyela. Apunta a 8-12 candidatas;
   no devuelvas menos de 6 salvo que realmente no encuentres más.

## Formato de salida (OBLIGATORIO)
Después de buscar, responde ÚNICAMENTE con un bloque de código JSON (```json ... ```)
que contenga un ARRAY de objetos. Cada objeto con EXACTAMENTE estas claves:

  "titular"      : string, el titular en español neutro.
  "resumen"      : string, 1-2 frases en español neutro.
  "fuente"       : string, nombre del medio.
  "url"          : string, enlace a la noticia.
  "por_que_humor": string, razón breve de por qué da para reírse.
  "categoria"    : uno de: "absurdo", "observacional", "curioso", "otro".

No incluyas texto fuera del bloque JSON. No inventes noticias: solo las que
encontraste realmente en la búsqueda web, con su URL real."""


# --- Llamada a la API --------------------------------------------------------

def buscar_noticias(cliente: anthropic.Anthropic, prompt: str) -> list[dict]:
    """Llama a Claude con web search y devuelve la lista de candidatas.

    Web search corre como bucle de herramienta del lado servidor: si llega al
    límite de iteraciones, la API devuelve stop_reason="pause_turn" y hay que
    reenviar la conversación para que continúe hasta producir el JSON final.
    """
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 12}]
    mensajes = [{"role": "user", "content": prompt}]

    respuesta = None
    for intento in range(6):  # tope de continuaciones para no quedar en bucle
        respuesta = cliente.messages.create(
            model=MODELO,
            max_tokens=16000,
            tools=tools,
            messages=mensajes,
        )
        if respuesta.stop_reason != "pause_turn":
            break
        # El servidor pausó tras varias búsquedas: reenviar para que siga.
        mensajes.append({"role": "assistant", "content": respuesta.content})

    print(f"  stop_reason del modelo: {respuesta.stop_reason}")

    texto = "".join(
        bloque.text for bloque in respuesta.content if bloque.type == "text"
    )
    candidatas = extraer_json(texto)

    if not candidatas:
        # Diagnóstico: mostrar el final del texto para entender qué devolvió.
        cola = texto[-600:].replace("\n", " ") if texto else "(sin texto)"
        print(f"  [diag] no se extrajo JSON. Final del texto: {cola}")

    return candidatas


def extraer_json(texto: str) -> list[dict]:
    """Extrae el array JSON del texto del modelo, tolerante a ```json ... ```."""
    # Preferir un bloque de código json explícito.
    m = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", texto, re.DOTALL)
    crudo = m.group(1) if m else None

    if crudo is None:
        # Como respaldo, tomar desde el primer '[' hasta el último ']'.
        inicio = texto.find("[")
        fin = texto.rfind("]")
        if inicio != -1 and fin != -1 and fin > inicio:
            crudo = texto[inicio : fin + 1]

    if crudo is None:
        return []

    try:
        datos = json.loads(crudo)
    except json.JSONDecodeError:
        return []

    return datos if isinstance(datos, list) else []


# --- Normalización y dedupe --------------------------------------------------

def normalizar_url(url: str) -> str:
    """Clave de deduplicación a partir de la URL (sin query ni fragmentos)."""
    url = (url or "").strip().lower()
    url = re.sub(r"[?#].*$", "", url)
    url = re.sub(r"/+$", "", url)
    return url


def normalizar_item(crudo: dict, fecha: str) -> dict | None:
    """Valida y normaliza un ítem crudo del modelo al esquema de bandeja."""
    titular = (crudo.get("titular") or "").strip()
    url = (crudo.get("url") or "").strip()
    if not titular or not url:
        return None

    categoria = (crudo.get("categoria") or "otro").strip().lower()
    if categoria not in CATEGORIAS_VALIDAS:
        categoria = "otro"

    return {
        "id": str(uuid.uuid4()),
        "fecha_encontrada": fecha,
        "titular": titular,
        "resumen": (crudo.get("resumen") or "").strip(),
        "fuente": (crudo.get("fuente") or "").strip(),
        "url": url,
        "por_que_humor": (crudo.get("por_que_humor") or "").strip(),
        "categoria": categoria,
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
    print(f"[{ahora.isoformat()}] Buscando noticias para la pauta del {fecha}...")

    preferencias = leer_json(ARCHIVO_PREFERENCIAS, {})
    bandeja = leer_json(ARCHIVO_BANDEJA, [])

    cliente = anthropic.Anthropic(api_key=api_key)
    prompt = construir_prompt(preferencias, fecha)

    try:
        candidatas_crudas = buscar_noticias(cliente, prompt)
    except anthropic.APIError as e:
        print(f"ERROR llamando a la API de Claude: {e}", file=sys.stderr)
        return 2

    print(f"  El modelo devolvió {len(candidatas_crudas)} candidatas.")

    # URLs ya conocidas en la bandeja, para no duplicar.
    urls_conocidas = {normalizar_url(it.get("url", "")) for it in bandeja}

    nuevas = []
    for crudo in candidatas_crudas:
        item = normalizar_item(crudo, fecha)
        if item is None:
            continue
        clave = normalizar_url(item["url"])
        if clave in urls_conocidas:
            continue
        urls_conocidas.add(clave)
        nuevas.append(item)

    print(f"  {len(nuevas)} noticias nuevas (tras descartar duplicadas).")

    # Acumular en la bandeja.
    bandeja.extend(nuevas)
    escribir_json(ARCHIVO_BANDEJA, bandeja)
    print(f"  Bandeja actualizada: {len(bandeja)} ítems en total.")

    # Armar la pauta del día: los mejores temas nuevos (los primeros N que propuso
    # el modelo, que vienen ordenados por relevancia). Si hubo pocas nuevas, se
    # completa con pendientes recientes de la bandeja.
    pauta = nuevas[:N_PAUTA]
    if len(pauta) < N_PAUTA:
        ya_en_pauta = {it["id"] for it in pauta}
        pendientes = [
            it for it in reversed(bandeja)
            if it.get("estado") == "pendiente" and it["id"] not in ya_en_pauta
        ]
        pauta.extend(pendientes[: N_PAUTA - len(pauta)])

    # Marcar los temas de la pauta como "en_pauta" en la bandeja.
    ids_pauta = {it["id"] for it in pauta}
    for it in bandeja:
        if it["id"] in ids_pauta:
            it["estado"] = "en_pauta"
    escribir_json(ARCHIVO_BANDEJA, bandeja)

    archivo_pauta = DIR_DATOS / f"pauta-{fecha}.json"
    escribir_json(archivo_pauta, pauta)
    print(f"  Pauta del día escrita: {archivo_pauta.name} ({len(pauta)} temas).")

    print("Listo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
