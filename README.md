# 🎙️ Curador de noticias para podcast de humor (Chile)

Sistema **automático** que cada día busca noticias chilenas virales y graciosas,
las acumula, y arma una **pauta** con los mejores temas para un podcast de humor y
conversación. Tú revisas la pauta en un panel web y marcas **Va / No va**; el
sistema **aprende** de esas decisiones para afinar el filtro con el tiempo.

Todo corre **gratis y sin tu PC encendido**: la búsqueda vive en GitHub Actions y
el panel en GitHub Pages.

- ❌ **Nunca política** (figuras, elecciones, gobierno, partidista).
- 🇨🇱 Foco en Chile, idealmente noticias de nicho/locales.
- 😄 Humor absurdo/WTF + irónico/observacional.

## Cómo funciona

```
GitHub Actions (cron 2x/día)  ──>  scripts/buscar.py  ──>  API de Claude (web search)
        │                                                          │
        │                                                          ▼
        │                                    data/bandeja.json (acumulado)
        │                                    data/pauta-YYYY-MM-DD.json (del día)
        ▼
   commit automático al repo
        │
        ▼
GitHub Pages (panel web)  <──  lee la pauta del día
        │
        ▼
   marcas "Va" / "No va"  ──>  actualiza data/preferencias.json (memoria)
```

El **aprendizaje** no reentrena el modelo: cada decisión se guarda en
`data/preferencias.json`, y ese archivo se inyecta en el prompt de cada corrida.
Mientras más decisiones, más afinado el filtro.

## Estructura

```
data/
  bandeja.json          # histórico acumulado de candidatas
  preferencias.json     # memoria de aprendizaje (aprobados/descartados/reglas)
  pauta-YYYY-MM-DD.json  # la pauta de cada día (se genera sola)
scripts/
  buscar.py             # busca con la API de Claude y escribe los JSON
web/                    # panel estático (GitHub Pages)
.github/workflows/
  diario.yml            # cron 2x/día + commit automático
  pages.yml             # publica web/ en GitHub Pages
```

## Setup (una sola vez)

### 1. Subir el proyecto a GitHub
Ver la sección **"Subir a GitHub"** más abajo.

### 2. Cargar la API key como secret
La clave de Anthropic **nunca va en el código**. Se carga como *secret*:

- Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
- **Name:** `ANTHROPIC_API_KEY`
- **Secret:** tu clave (`sk-ant-...`)
- **Add secret**

### 3. Activar GitHub Pages
- Repo → **Settings** → **Pages**
- En **Build and deployment → Source**, elegí **GitHub Actions** (no "Deploy from a branch").

El panel quedará en `https://<tu-usuario>.github.io/<tu-repo>/`.

### 4. Crear un token para el panel
El panel necesita un token para **guardar tus decisiones** (Va/No va):

- [GitHub → Settings → Developer settings → Fine-grained tokens](https://github.com/settings/tokens?type=beta)
- **Generate new token**, dale acceso **solo a este repositorio**.
- En **Repository permissions** → **Contents** → **Read and write**.
- Generá el token y pegalo en el panel (sección ⚙️ "Conexión con GitHub").
- Se guarda solo en tu navegador; nunca se sube al repo.

### 5. Primera corrida
- Repo → pestaña **Actions** → workflow **"Buscar noticias (pauta diaria)"** → **Run workflow**.
- En 1-2 minutos aparece `data/pauta-<hoy>.json` y el panel ya la muestra.

## Subir a GitHub

Con **GitHub CLI** (ya lo tenés instalado), desde la carpeta del proyecto:

```bash
gh auth login                       # solo la primera vez
git init
git add .
git commit -m "Sistema curador de pauta para podcast"
gh repo create pauta-podcast-finder --public --source=. --push
```

Eso crea el repo en GitHub y sube todo. Después seguí con los pasos 2-5 de arriba.

> Si preferís hacerlo a mano: creá el repo en github.com, y luego
> `git remote add origin <url>` + `git branch -M main` + `git push -u origin main`.

## Configuración (opcional)

Variables de entorno que lee `scripts/buscar.py`:

| Variable          | Default            | Qué hace                                |
| ----------------- | ------------------ | --------------------------------------- |
| `ANTHROPIC_API_KEY` | (requerida)      | Clave de la API de Anthropic.           |
| `MODELO_CLAUDE`   | `claude-opus-4-8`  | Modelo a usar.                          |
| `N_PAUTA`         | `6`                | Cuántos temas en la pauta del día.      |
| `ZONA_HORARIA`    | `America/Santiago` | Zona para fechar la pauta.              |

Los horarios del cron están en `.github/workflows/diario.yml` (en UTC).

## Probar en local (opcional)

```bash
pip install -r requirements.txt
# PowerShell:
$env:ANTHROPIC_API_KEY = "sk-ant-..."
python scripts/buscar.py
```

## Seguridad

- La API key vive **solo** como GitHub Secret. Nunca en el código ni en commits.
- El token del panel vive **solo** en el navegador (localStorage), nunca se sube.
- El panel no llama a la API de Anthropic: solo lee/escribe JSON del repo.
