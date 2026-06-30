/* Panel de la pauta — lee y escribe en el repo vía la API de GitHub.
 *
 * Muestra tres secciones: Noticias Chile, Noticias Mundo, y Temas para conversar.
 * Cada ítem tiene botones Va/No va que alimentan el aprendizaje.
 *
 * Lectura: funciona sin token en repos públicos.
 * Escritura: requiere un token personal con "Contents: Read and write",
 * guardado solo en localStorage del navegador.
 */

"use strict";

const API = "https://api.github.com";
const CLAVE_TOKEN = "pauta_github_token";

const estado = {
  owner: null,
  repo: null,
  branch: "main",
  noticias: [],           // ítems de pauta-FECHA.json
  temas: [],              // ítems de temas-FECHA.json
  itemsPorId: new Map(),  // id -> { tipo: "noticia" | "tema", item }
  decisiones: new Map(),  // id -> "va" | "nova"
};

// --- Detección de repo desde la URL de GitHub Pages --------------------------

function detectarRepo() {
  const host = location.hostname;
  const partes = location.pathname.split("/").filter(Boolean);
  const owner = host.split(".")[0];
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

// --- Carga del contenido del día ---------------------------------------------

function ultimoArchivo(nombres, prefijo) {
  const filtrados = nombres
    .filter((n) => new RegExp(`^${prefijo}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(n))
    .sort();
  return filtrados.length ? filtrados[filtrados.length - 1] : null;
}

async function cargarContenido() {
  const subtitulo = document.getElementById("subtitulo");
  const contenedor = document.getElementById("contenedor-tarjetas");

  let archivos;
  try {
    archivos = await listarData();
  } catch (e) {
    contenedor.innerHTML = `<p class="mensaje">No pude leer el repositorio.<br>${e.message}</p>`;
    return;
  }
  const nombres = archivos.map((a) => a.name);

  const pautaNombre = ultimoArchivo(nombres, "pauta");
  const temasNombre = ultimoArchivo(nombres, "temas");

  if (!pautaNombre && !temasNombre) {
    subtitulo.textContent = "Todavía no hay contenido generado.";
    contenedor.innerHTML =
      `<p class="mensaje">Aún no hay nada. El sistema lo genera automáticamente cada día.</p>`;
    return;
  }

  if (pautaNombre) {
    const a = await obtenerArchivo(`data/${pautaNombre}`);
    estado.noticias = JSON.parse(a.contenido);
  }
  if (temasNombre) {
    const a = await obtenerArchivo(`data/${temasNombre}`);
    estado.temas = JSON.parse(a.contenido);
  }

  // Índice id -> {tipo, item}
  estado.itemsPorId.clear();
  estado.noticias.forEach((it) => estado.itemsPorId.set(it.id, { tipo: "noticia", item: it }));
  estado.temas.forEach((it) => estado.itemsPorId.set(it.id, { tipo: "tema", item: it }));

  const fecha = (pautaNombre || temasNombre)
    .replace(/^(pauta|temas)-/, "")
    .replace(".json", "");
  const nMundo = estado.noticias.filter((n) => n.region === "mundo").length;
  const nChile = estado.noticias.length - nMundo;
  subtitulo.textContent = `${fecha} · ${nChile} Chile · ${nMundo} mundo · ${estado.temas.length} temas`;

  renderizar();
}

// --- Render ------------------------------------------------------------------

function renderizar() {
  const contenedor = document.getElementById("contenedor-tarjetas");
  contenedor.innerHTML = "";

  // "mundo" explícito va al bloque mundo; todo lo demás (incluye ítems viejos
  // sin región) cae en Chile, así nada queda invisible.
  const mundo = estado.noticias.filter((n) => n.region === "mundo");
  const chile = estado.noticias.filter((n) => n.region !== "mundo");

  agregarSeccion(contenedor, "🇨🇱 Noticias de Chile", chile, tarjetaNoticia);
  agregarSeccion(contenedor, "🌎 Noticias del mundo", mundo, tarjetaNoticia);
  agregarSeccion(contenedor, "💬 Temas para conversar", estado.temas, tarjetaTema);

  if (!chile.length && !mundo.length && !estado.temas.length) {
    contenedor.innerHTML = `<p class="mensaje">El contenido de hoy está vacío.</p>`;
  }

  contenedor.querySelectorAll(".acciones button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const d = btn.dataset.d;
      if (estado.decisiones.get(id) === d) estado.decisiones.delete(id);
      else estado.decisiones.set(id, d);
      renderizar();
    });
  });

  actualizarBarra();
}

function agregarSeccion(contenedor, titulo, items, fabricaTarjeta) {
  if (!items.length) return;
  const h = document.createElement("h3");
  h.className = "seccion-titulo";
  h.textContent = `${titulo} (${items.length})`;
  contenedor.appendChild(h);
  items.forEach((item) => contenedor.appendChild(fabricaTarjeta(item)));
}

function botonesDecision(id) {
  const d = estado.decisiones.get(id);
  return `
    <div class="acciones">
      <button class="btn-va ${d === "va" ? "activo" : ""}" data-id="${escaparAttr(id)}" data-d="va">✅ Va</button>
      <button class="btn-nova ${d === "nova" ? "activo" : ""}" data-id="${escaparAttr(id)}" data-d="nova">❌ No va</button>
    </div>`;
}

function claseDecidida(id) {
  const d = estado.decisiones.get(id);
  if (d === "va") return "decidida-va";
  if (d === "nova") return "decidida-nova";
  return "";
}

function tarjetaNoticia(item) {
  const card = document.createElement("article");
  card.className = `tarjeta ${claseDecidida(item.id)}`;
  card.innerHTML = `
    <span class="categoria">${escapar(item.categoria || "otro")}</span>
    <h2>${escapar(item.titular || "")}</h2>
    <p class="resumen">${escapar(item.resumen || "")}</p>
    <p class="por-que">😄 ${escapar(item.por_que_humor || "")}</p>
    <p class="fuente">
      ${escapar(item.fuente || "")}
      ${item.url ? `· <a href="${escaparAttr(item.url)}" target="_blank" rel="noopener">ver noticia</a>` : ""}
    </p>
    ${botonesDecision(item.id)}
  `;
  return card;
}

function tarjetaTema(item) {
  const card = document.createElement("article");
  card.className = `tarjeta tarjeta-tema ${claseDecidida(item.id)}`;
  card.innerHTML = `
    <span class="categoria">${escapar(item.categoria || "observacional")}</span>
    <h2>${escapar(item.titulo || "")}</h2>
    ${item.gancho ? `<p class="resumen">${escapar(item.gancho)}</p>` : ""}
    <p class="por-que">💬 ${escapar(item.por_que_conversar || "")}</p>
    ${item.basado_en ? `<p class="fuente">Inspirado en: ${escapar(item.basado_en)}</p>` : ""}
    ${botonesDecision(item.id)}
  `;
  return card;
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
  resumen.textContent = `${va} van · ${nova} no van · ${n} decididos`;
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
    // 1) Preferencias (noticias y temas en el mismo archivo).
    const archPref = await obtenerArchivo("data/preferencias.json");
    const pref = archPref
      ? JSON.parse(archPref.contenido)
      : {};
    pref.aprobados = pref.aprobados || [];
    pref.descartados = pref.descartados || [];
    pref.temas_aprobados = pref.temas_aprobados || [];
    pref.temas_descartados = pref.temas_descartados || [];

    const tieneNoticia = (arr, t) => arr.some((x) => x.titular === t);
    const tieneTema = (arr, t) => arr.some((x) => x.titulo === t);

    estado.decisiones.forEach((d, id) => {
      const entrada = estado.itemsPorId.get(id);
      if (!entrada) return;
      const { tipo, item } = entrada;

      if (tipo === "noticia") {
        const reg = {
          titular: item.titular,
          categoria: item.categoria || "otro",
          region: item.region || "chile",
          razon: item.por_que_humor || "",
        };
        if (d === "va" && !tieneNoticia(pref.aprobados, item.titular)) pref.aprobados.push(reg);
        if (d === "nova" && !tieneNoticia(pref.descartados, item.titular)) pref.descartados.push(reg);
      } else {
        const reg = {
          titulo: item.titulo,
          categoria: item.categoria || "observacional",
          razon: item.por_que_conversar || "",
        };
        if (d === "va" && !tieneTema(pref.temas_aprobados, item.titulo)) pref.temas_aprobados.push(reg);
        if (d === "nova" && !tieneTema(pref.temas_descartados, item.titulo)) pref.temas_descartados.push(reg);
      }
    });

    await guardarArchivo(
      "data/preferencias.json",
      pref,
      archPref ? archPref.sha : null,
      "Decisiones del conductor (panel web)"
    );

    // 2) Actualizar estados en las bandejas.
    await actualizarEstadosBandeja("data/bandeja.json", "noticia");
    await actualizarEstadosBandeja("data/bandeja_temas.json", "tema");

    mostrarToast("✅ Decisiones guardadas. ¡El sistema aprende!");
    estado.decisiones.clear();
    renderizar();
  } catch (e) {
    mostrarToast("Error al guardar: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 Guardar decisiones";
  }
}

async function actualizarEstadosBandeja(path, tipo) {
  const arch = await obtenerArchivo(path);
  if (!arch) return;
  const bandeja = JSON.parse(arch.contenido);
  let cambios = 0;
  for (const it of bandeja) {
    const d = estado.decisiones.get(it.id);
    const entrada = estado.itemsPorId.get(it.id);
    if (d && entrada && entrada.tipo === tipo) {
      it.estado = d === "va" ? "aprobada" : "descartada";
      cambios++;
    }
  }
  if (cambios > 0) {
    await guardarArchivo(path, bandeja, arch.sha, `Actualizar estados (${tipo}) desde el panel`);
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
  await cargarContenido();
}

iniciar();
