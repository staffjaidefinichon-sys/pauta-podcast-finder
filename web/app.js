/* Panel de la pauta — lee y escribe en el repo vía la API de GitHub.
 *
 * Lectura: funciona sin token en repos públicos.
 * Escritura (guardar decisiones): requiere un token personal con permiso
 * "Contents: Read and write", guardado solo en localStorage del navegador.
 */

"use strict";

const API = "https://api.github.com";
const CLAVE_TOKEN = "pauta_github_token";

// Estado en memoria.
const estado = {
  owner: null,
  repo: null,
  branch: "main",
  pautaPath: null,      // p.ej. "data/pauta-2026-06-30.json"
  pauta: [],            // ítems de la pauta del día
  decisiones: new Map(),// id -> "va" | "nova"
};

// --- Detección de repo desde la URL de GitHub Pages --------------------------

function detectarRepo() {
  const host = location.hostname;           // owner.github.io
  const partes = location.pathname.split("/").filter(Boolean);
  const owner = host.split(".")[0];
  // Project page: owner.github.io/repo/...  -> repo = primer segmento.
  // User page:    owner.github.io/          -> repo = owner.github.io
  const repo = partes.length > 0 ? partes[0] : `${owner}.github.io`;
  return { owner, repo };
}

// --- Token -------------------------------------------------------------------

function getToken() {
  return localStorage.getItem(CLAVE_TOKEN) || "";
}

function setToken(t) {
  if (t) localStorage.setItem(CLAVE_TOKEN, t);
  else localStorage.removeItem(CLAVE_TOKEN);
  refrescarEstadoToken();
}

function refrescarEstadoToken() {
  const span = document.getElementById("estado-token");
  span.textContent = getToken() ? "✅ conectado" : "⚠️ sin token";
}

// --- Base64 con soporte UTF-8 ------------------------------------------------

function aBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function deBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// --- Llamadas a la API de GitHub ---------------------------------------------

function cabeceras(conToken) {
  const h = { Accept: "application/vnd.github+json" };
  const t = getToken();
  if (conToken && t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function detectarBranch() {
  try {
    const r = await fetch(`${API}/repos/${estado.owner}/${estado.repo}`, {
      headers: cabeceras(true),
    });
    if (r.ok) {
      const data = await r.json();
      if (data.default_branch) estado.branch = data.default_branch;
    }
  } catch (_) {
    /* nos quedamos con "main" */
  }
}

async function obtenerArchivo(path) {
  // Devuelve { contenido (string), sha } o null si no existe.
  const url = `${API}/repos/${estado.owner}/${estado.repo}/contents/${path}?ref=${estado.branch}`;
  const r = await fetch(url, { headers: cabeceras(true) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} al leer ${path}`);
  const data = await r.json();
  return { contenido: deBase64(data.content), sha: data.sha };
}

async function listarData() {
  const url = `${API}/repos/${estado.owner}/${estado.repo}/contents/data?ref=${estado.branch}`;
  const r = await fetch(url, { headers: cabeceras(true) });
  if (!r.ok) throw new Error(`GitHub ${r.status} al listar data/`);
  return r.json();
}

async function guardarArchivo(path, objeto, sha, mensaje) {
  const cuerpo = {
    message: mensaje,
    content: aBase64(JSON.stringify(objeto, null, 2) + "\n"),
    branch: estado.branch,
  };
  if (sha) cuerpo.sha = sha;
  const r = await fetch(
    `${API}/repos/${estado.owner}/${estado.repo}/contents/${path}`,
    { method: "PUT", headers: cabeceras(true), body: JSON.stringify(cuerpo) }
  );
  if (!r.ok) {
    const detalle = await r.text();
    throw new Error(`GitHub ${r.status} al guardar ${path}: ${detalle}`);
  }
  return r.json();
}

// --- Carga de la pauta del día -----------------------------------------------

async function cargarPauta() {
  const subtitulo = document.getElementById("subtitulo");
  const contenedor = document.getElementById("contenedor-tarjetas");

  let archivos;
  try {
    archivos = await listarData();
  } catch (e) {
    contenedor.innerHTML = `<p class="mensaje">No pude leer el repositorio.<br>${e.message}</p>`;
    return;
  }

  const pautas = archivos
    .filter((a) => /^pauta-\d{4}-\d{2}-\d{2}\.json$/.test(a.name))
    .map((a) => a.name)
    .sort();

  if (pautas.length === 0) {
    subtitulo.textContent = "Todavía no hay pautas generadas.";
    contenedor.innerHTML =
      `<p class="mensaje">Aún no hay ninguna pauta. El sistema la genera automáticamente cada día.</p>`;
    return;
  }

  const ultima = pautas[pautas.length - 1];
  estado.pautaPath = `data/${ultima}`;

  const archivo = await obtenerArchivo(estado.pautaPath);
  estado.pauta = JSON.parse(archivo.contenido);

  const fecha = ultima.replace("pauta-", "").replace(".json", "");
  subtitulo.textContent = `${fecha} · ${estado.pauta.length} temas`;

  renderizarTarjetas();
}

// --- Render ------------------------------------------------------------------

function renderizarTarjetas() {
  const contenedor = document.getElementById("contenedor-tarjetas");
  contenedor.innerHTML = "";

  if (estado.pauta.length === 0) {
    contenedor.innerHTML = `<p class="mensaje">La pauta de hoy está vacía.</p>`;
    return;
  }

  for (const item of estado.pauta) {
    const decision = estado.decisiones.get(item.id);
    const card = document.createElement("article");
    card.className = "tarjeta";
    if (decision === "va") card.classList.add("decidida-va");
    if (decision === "nova") card.classList.add("decidida-nova");

    card.innerHTML = `
      <span class="categoria">${escapar(item.categoria || "otro")}</span>
      <h2>${escapar(item.titular || "")}</h2>
      <p class="resumen">${escapar(item.resumen || "")}</p>
      <p class="por-que">😄 ${escapar(item.por_que_humor || "")}</p>
      <p class="fuente">
        ${escapar(item.fuente || "")}
        ${item.url ? `· <a href="${escaparAttr(item.url)}" target="_blank" rel="noopener">ver noticia</a>` : ""}
      </p>
      <div class="acciones">
        <button class="btn-va ${decision === "va" ? "activo" : ""}" data-id="${escaparAttr(item.id)}" data-d="va">✅ Va</button>
        <button class="btn-nova ${decision === "nova" ? "activo" : ""}" data-id="${escaparAttr(item.id)}" data-d="nova">❌ No va</button>
      </div>
    `;
    contenedor.appendChild(card);
  }

  contenedor.querySelectorAll(".acciones button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const d = btn.dataset.d;
      // Toggle: si ya estaba esa decisión, la quito.
      if (estado.decisiones.get(id) === d) estado.decisiones.delete(id);
      else estado.decisiones.set(id, d);
      renderizarTarjetas();
      actualizarBarra();
    });
  });

  actualizarBarra();
}

function actualizarBarra() {
  const barra = document.getElementById("barra-guardar");
  const resumen = document.getElementById("resumen-decisiones");
  const n = estado.decisiones.size;
  if (n === 0) {
    barra.classList.add("oculto");
    return;
  }
  let va = 0, nova = 0;
  estado.decisiones.forEach((d) => (d === "va" ? va++ : nova++));
  resumen.textContent = `${va} van · ${nova} no van · ${n}/${estado.pauta.length} decididos`;
  barra.classList.remove("oculto");
}

// --- Guardar decisiones ------------------------------------------------------

async function guardarDecisiones() {
  if (!getToken()) {
    mostrarToast("Primero configurá tu token de GitHub (arriba).");
    document.getElementById("config-details").open = true;
    return;
  }
  if (estado.decisiones.size === 0) return;

  const btn = document.getElementById("btn-guardar-decisiones");
  btn.disabled = true;
  btn.textContent = "Guardando…";

  try {
    // 1) Preferencias: agregar a aprobados/descartados.
    const archPref = await obtenerArchivo("data/preferencias.json");
    const pref = archPref
      ? JSON.parse(archPref.contenido)
      : { aprobados: [], descartados: [], reglas_aprendidas: [] };
    pref.aprobados = pref.aprobados || [];
    pref.descartados = pref.descartados || [];

    const titularesAprob = new Set(pref.aprobados.map((x) => x.titular));
    const titularesDesc = new Set(pref.descartados.map((x) => x.titular));

    const porId = new Map(estado.pauta.map((it) => [it.id, it]));

    estado.decisiones.forEach((d, id) => {
      const it = porId.get(id);
      if (!it) return;
      const registro = {
        titular: it.titular,
        categoria: it.categoria || "otro",
        razon: it.por_que_humor || "",
      };
      if (d === "va" && !titularesAprob.has(it.titular)) {
        pref.aprobados.push(registro);
        titularesAprob.add(it.titular);
      } else if (d === "nova" && !titularesDesc.has(it.titular)) {
        pref.descartados.push(registro);
        titularesDesc.add(it.titular);
      }
    });

    await guardarArchivo(
      "data/preferencias.json",
      pref,
      archPref ? archPref.sha : null,
      "Decisiones del conductor (panel web)"
    );

    // 2) Bandeja: actualizar estado de los ítems decididos.
    const archBand = await obtenerArchivo("data/bandeja.json");
    if (archBand) {
      const bandeja = JSON.parse(archBand.contenido);
      let cambios = 0;
      for (const it of bandeja) {
        const d = estado.decisiones.get(it.id);
        if (d) {
          it.estado = d === "va" ? "aprobada" : "descartada";
          cambios++;
        }
      }
      if (cambios > 0) {
        await guardarArchivo(
          "data/bandeja.json",
          bandeja,
          archBand.sha,
          "Actualizar estados de la bandeja (panel web)"
        );
      }
    }

    mostrarToast("✅ Decisiones guardadas. ¡El sistema aprende!");
    estado.decisiones.clear();
    renderizarTarjetas();
  } catch (e) {
    mostrarToast("Error al guardar: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 Guardar decisiones";
  }
}

// --- Utilidades de UI --------------------------------------------------------

function escapar(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function escaparAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

let toastTimer = null;
function mostrarToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("oculto");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("oculto"), 4000);
}

// --- Arranque ----------------------------------------------------------------

async function iniciar() {
  const { owner, repo } = detectarRepo();
  estado.owner = owner;
  estado.repo = repo;

  document.getElementById("info-repo").textContent =
    `Repositorio detectado: ${owner}/${repo}`;

  refrescarEstadoToken();

  // Eventos del token.
  document.getElementById("btn-guardar-token").addEventListener("click", () => {
    const v = document.getElementById("input-token").value.trim();
    setToken(v);
    document.getElementById("input-token").value = "";
    mostrarToast(v ? "Token guardado en este navegador." : "Token vacío.");
  });
  document.getElementById("btn-borrar-token").addEventListener("click", () => {
    setToken("");
    mostrarToast("Token borrado.");
  });
  document
    .getElementById("btn-guardar-decisiones")
    .addEventListener("click", guardarDecisiones);

  await detectarBranch();
  await cargarPauta();
}

iniciar();
