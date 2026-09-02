/* Panel de la pauta — lee y escribe en el repo vía la API de GitHub.
 *
 * Lee las bandejas completas (data/bandeja.json y data/bandeja_temas.json) y
 * organiza el contenido en tres pestañas según el estado de cada ítem:
 *   - Pauta:        pendiente / en_pauta   (lo que falta decidir)
 *   - Aprobadas:    aprobada               (los "Va")
 *   - Descartadas:  descartada             (los "No va")
 *
 * Desde Aprobadas/Descartadas se puede devolver un ítem a la pauta.
 *
 * Lectura: funciona sin token en repos públicos.
 * Escritura: requiere un token personal con "Contents: Read and write",
 * guardado solo en localStorage del navegador.
 */

"use strict";

const API = "https://api.github.com";
const CLAVE_TOKEN = "pauta_github_token";
const PENDIENTES = new Set(["pendiente", "en_pauta"]);

const estado = {
  owner: null,
  repo: null,
  branch: "main",
  noticias: [],           // bandeja.json completa
  temas: [],              // bandeja_temas.json completa
  itemsPorId: new Map(),  // id -> { tipo: "noticia" | "tema", item }
  decisiones: new Map(),  // id -> "va" | "nova" | "volver"
  motivos: new Map(),     // id -> motivo (texto) para los "No va"
  vista: "aprobadas",     // pauta | aprobadas | descartadas (arranca en "Van")
  editando: null,         // id de la noticia en edición (o null)
  semana: null,           // "YYYY-MM-DD" del miércoles de cierre seleccionado
  ejemplos: [],           // noticias-ejemplo que el conductor le enseña a la IA
};

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// --- Semanas (cierran cada miércoles) ----------------------------------------

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function semanaDe(fechaIso) {
  // Próximo miércoles (>= fecha). En JS getDay(): domingo=0 ... miércoles=3.
  const [y, m, d] = fechaIso.split("-").map(Number);
  const fecha = new Date(y, m - 1, d);
  const dias = (3 - fecha.getDay() + 7) % 7;
  fecha.setDate(fecha.getDate() + dias);
  return ymd(fecha);
}

function semanaActual() {
  return semanaDe(ymd(new Date()));
}

function getSemana(item) {
  return item.semana || semanaDe(item.fecha_encontrada || ymd(new Date()));
}

function etiquetaSemana(iso) {
  const [, m, d] = iso.split("-").map(Number);
  return `Semana al mié ${d} ${MESES[m - 1]}`;
}

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
    let r = await fetch(`${API}/repos/${estado.owner}/${estado.repo}`, {
      headers: cabeceras(true),
    });
    if (r.status === 401 && getToken()) {
      avisarTokenVencido();
      r = await fetch(`${API}/repos/${estado.owner}/${estado.repo}`, {
        headers: cabeceras(false),
      });
    }
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
  // cache: "no-store" es clave: la API de GitHub responde con max-age=60 y el
  // navegador cachea; sin esto, los reintentos tras un 409 releen el sha viejo
  // y vuelven a fallar.
  let r = await fetch(url, { headers: cabeceras(true), cache: "no-store" });
  // 401: el token guardado expiró o fue revocado. Para LEER un repo público no
  // hace falta token: reintentar sin él y avisar al usuario.
  if (r.status === 401 && getToken()) {
    avisarTokenVencido();
    r = await fetch(url, { headers: cabeceras(false), cache: "no-store" });
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} al leer ${path}`);
  const data = await r.json();
  return { contenido: deBase64(data.content), sha: data.sha };
}

let tokenVencidoAvisado = false;
function avisarTokenVencido() {
  if (tokenVencidoAvisado) return;
  tokenVencidoAvisado = true;
  const span = document.getElementById("estado-token");
  if (span) span.textContent = "⛔ token vencido — generá uno nuevo";
  mostrarToast("Tu token de GitHub expiró. Generá uno nuevo para poder guardar decisiones.");
  const det = document.getElementById("config-details");
  if (det) det.open = true;
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

// --- Carga del contenido -----------------------------------------------------

async function cargarContenido() {
  const subtitulo = document.getElementById("subtitulo");
  const contenedor = document.getElementById("contenedor-tarjetas");

  let archBandeja, archTemas;
  try {
    archBandeja = await obtenerArchivo("data/bandeja.json");
    archTemas = await obtenerArchivo("data/bandeja_temas.json");
  } catch (e) {
    contenedor.innerHTML = `<p class="mensaje">No pude leer el repositorio.<br>${e.message}</p>`;
    return;
  }

  estado.noticias = archBandeja ? JSON.parse(archBandeja.contenido) : [];
  estado.temas = archTemas ? JSON.parse(archTemas.contenido) : [];

  // Cargar lo que el conductor le enseñó a la IA (notas + ejemplos).
  try {
    const archPref = await obtenerArchivo("data/preferencias.json");
    const pref = archPref ? JSON.parse(archPref.contenido) : {};
    document.getElementById("notas").value = pref.notas_conductor || "";
    estado.ejemplos = pref.ejemplos_conductor || [];
    renderEjemplos();
  } catch (_) {
    /* si falla, la sección queda vacía */
  }

  estado.itemsPorId.clear();
  estado.noticias.forEach((it) => estado.itemsPorId.set(it.id, { tipo: "noticia", item: it }));
  estado.temas.forEach((it) => estado.itemsPorId.set(it.id, { tipo: "tema", item: it }));

  if (estado.noticias.length === 0 && estado.temas.length === 0) {
    subtitulo.textContent = "Todavía no hay contenido generado.";
    contenedor.innerHTML =
      `<p class="mensaje">Aún no hay nada. El sistema lo genera automáticamente cada día.</p>`;
    return;
  }

  poblarSemanas();
  renderizar();
}

function poblarSemanas() {
  // Semanas presentes en los datos + la semana actual, ordenadas (más reciente arriba).
  const semanas = new Set([semanaActual()]);
  estado.noticias.forEach((x) => semanas.add(getSemana(x)));
  estado.temas.forEach((x) => semanas.add(getSemana(x)));
  const ordenadas = [...semanas].sort().reverse();

  // Si la semana elegida ya no existe, volver a la actual (o la más reciente).
  if (!estado.semana || !semanas.has(estado.semana)) {
    estado.semana = semanas.has(semanaActual()) ? semanaActual() : ordenadas[0];
  }

  const sel = document.getElementById("semana");
  sel.innerHTML = "";
  const hoySemana = semanaActual();
  ordenadas.forEach((s) => {
    const op = document.createElement("option");
    op.value = s;
    op.textContent = etiquetaSemana(s) + (s === hoySemana ? " (esta semana)" : "");
    if (s === estado.semana) op.selected = true;
    sel.appendChild(op);
  });
}

// --- Filtros por estado ------------------------------------------------------

function estaEn(item, vista) {
  const e = item.estado || "pendiente";
  if (vista === "pauta") return PENDIENTES.has(e);
  if (vista === "aprobadas") return e === "aprobada";
  if (vista === "descartadas") return e === "descartada";
  return false;
}

function visible(item, vista) {
  return getSemana(item) === estado.semana && estaEn(item, vista);
}

// Orden manual: los ítems con campo "orden" van primero, según ese número.
function ordenar(items) {
  return items.slice().sort((a, b) => (a.orden ?? 1e9) - (b.orden ?? 1e9));
}

function contar(que) {
  const vista = que === "pendientes" ? "pauta" : que;
  const n = estado.noticias.filter((x) => visible(x, vista)).length;
  const t = estado.temas.filter((x) => visible(x, vista)).length;
  return n + t;
}

// --- Render ------------------------------------------------------------------

function renderizar() {
  if (estado.semana) {
    document.getElementById("subtitulo").textContent =
      `${etiquetaSemana(estado.semana)} · ${contar("aprobadas")} van · ${contar("pauta")} por aprobar`;
  }

  // Conteos en las pestañas.
  document.getElementById("conteo-pauta").textContent = contar("pauta");
  document.getElementById("conteo-aprobadas").textContent = contar("aprobadas");
  document.getElementById("conteo-descartadas").textContent = contar("descartadas");

  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("activo", b.dataset.vista === estado.vista);
  });

  const contenedor = document.getElementById("contenedor-tarjetas");
  contenedor.innerHTML = "";

  const noticias = ordenar(estado.noticias.filter((x) => visible(x, estado.vista)));
  const temas = ordenar(estado.temas.filter((x) => visible(x, estado.vista)));

  if (noticias.length === 0 && temas.length === 0) {
    const vacios = {
      pauta: "No quedan noticias por aprobar. 🎉",
      aprobadas: "Todavía no marcaste ninguna como “Va”. Tocá “⏳ Por aprobar” para elegir.",
      descartadas: "No hay nada descartado.",
    };
    contenedor.innerHTML = `<p class="mensaje">${vacios[estado.vista]}</p>`;
    actualizarBarra();
    return;
  }

  if (estado.vista !== "descartadas") {
    const mundo = noticias.filter((n) => n.region === "mundo");
    const chile = noticias.filter((n) => n.region !== "mundo");
    agregarSeccion(contenedor, "🇨🇱 Noticias de Chile", chile, tarjetaNoticia);
    agregarSeccion(contenedor, "🌎 Noticias del mundo", mundo, tarjetaNoticia);
    agregarSeccion(contenedor, "💬 Temas para conversar", temas, tarjetaTema);
  } else {
    agregarSeccion(contenedor, "📰 Noticias", noticias, tarjetaNoticia);
    agregarSeccion(contenedor, "💬 Temas para conversar", temas, tarjetaTema);
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

  // El motivo se guarda al escribir, sin re-renderizar (para no perder el foco).
  contenedor.querySelectorAll(".motivo-input").forEach((inp) => {
    inp.addEventListener("input", () => {
      estado.motivos.set(inp.dataset.id, inp.value);
    });
  });

  contenedor.querySelectorAll(".btn-mover").forEach((b) => {
    b.addEventListener("click", () => moverASemanaActual(b.dataset.id));
  });

  contenedor.querySelectorAll(".btn-orden").forEach((b) => {
    b.addEventListener("click", () => moverOrden(b.dataset.id, b.dataset.dir));
  });

  contenedor.querySelectorAll(".btn-editar").forEach((b) => {
    b.addEventListener("click", () => {
      estado.editando = b.dataset.id;
      renderizar();
    });
  });

  contenedor.querySelectorAll(".ed-cancelar").forEach((b) => {
    b.addEventListener("click", () => {
      estado.editando = null;
      renderizar();
    });
  });

  contenedor.querySelectorAll(".ed-otro-link").forEach((b) => {
    b.addEventListener("click", () => {
      const cont = b.closest(".tarjeta-edicion").querySelector(".ed-links");
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "ed-url";
      inp.placeholder = "Otro link";
      cont.appendChild(inp);
      inp.focus();
    });
  });

  contenedor.querySelectorAll(".ed-guardar").forEach((b) => {
    b.addEventListener("click", () => guardarEdicion(b.closest(".tarjeta-edicion")));
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
  if (estado.vista === "pauta") {
    const motivo = d === "nova"
      ? `<input class="motivo-input" data-id="${escaparAttr(id)}" type="text"
             placeholder="¿Por qué no va? (opcional: ej. 'noticia floja', no el tema)"
             value="${escaparAttr(estado.motivos.get(id) || "")}" />`
      : "";
    return `
      <div class="acciones">
        <button class="btn-va ${d === "va" ? "activo" : ""}" data-id="${escaparAttr(id)}" data-d="va">✅ Va</button>
        <button class="btn-nova ${d === "nova" ? "activo" : ""}" data-id="${escaparAttr(id)}" data-d="nova">❌ No va</button>
      </div>
      ${motivo}`;
  }
  // Aprobadas / Descartadas: opción de devolver a la pauta.
  return `
    <div class="acciones">
      <button class="btn-volver ${d === "volver" ? "activo" : ""}" data-id="${escaparAttr(id)}" data-d="volver">↩️ Volver a la pauta</button>
    </div>`;
}

function botonesOrden(id) {
  // Reordenar solo tiene sentido en la pauta final (✅ Van).
  if (estado.vista !== "aprobadas") return "";
  return `
    <div class="orden-botones">
      <button class="btn-orden" data-id="${escaparAttr(id)}" data-dir="up" title="Subir">▲</button>
      <button class="btn-orden" data-id="${escaparAttr(id)}" data-dir="down" title="Bajar">▼</button>
    </div>`;
}

function moverOrden(id, dir) {
  const entrada = estado.itemsPorId.get(id);
  if (!entrada) return;

  // Lista visible de la MISMA sección (Chile / Mundo / Temas), ya ordenada.
  let seccion;
  if (entrada.tipo === "noticia") {
    const esMundo = entrada.item.region === "mundo";
    seccion = ordenar(estado.noticias.filter(
      (x) => visible(x, "aprobadas") && (x.region === "mundo") === esMundo
    ));
  } else {
    seccion = ordenar(estado.temas.filter((x) => visible(x, "aprobadas")));
  }

  const i = seccion.findIndex((x) => x.id === id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= seccion.length) return;

  [seccion[i], seccion[j]] = [seccion[j], seccion[i]];
  seccion.forEach((x, k) => { x.orden = k + 1; });

  estado.ordenCambiado = true;
  document.getElementById("barra-orden").classList.remove("oculto");
  renderizar();
}

async function guardarOrden() {
  if (!getToken()) {
    mostrarToast("Primero configurá tu token de GitHub (arriba).");
    document.getElementById("config-details").open = true;
    return;
  }
  const btn = document.getElementById("btn-guardar-orden");
  btn.disabled = true;
  btn.textContent = "Guardando…";

  // Mapa id -> orden desde el estado en memoria.
  const ordenes = new Map();
  [...estado.noticias, ...estado.temas].forEach((x) => {
    if (x.orden != null) ordenes.set(x.id, x.orden);
  });

  const archivos = [
    ["data/bandeja.json", "Orden de noticias (panel)"],
    ["data/bandeja_temas.json", "Orden de temas (panel)"],
  ];

  try {
    for (let intento = 1; intento <= 3; intento++) {
      try {
        for (const [path, msg] of archivos) {
          const arch = await obtenerArchivo(path);
          if (!arch) continue;
          const arr = JSON.parse(arch.contenido);
          let cambios = 0;
          for (const x of arr) {
            if (ordenes.has(x.id) && x.orden !== ordenes.get(x.id)) {
              x.orden = ordenes.get(x.id);
              cambios++;
            }
          }
          if (cambios > 0) await guardarArchivo(path, arr, arch.sha, msg);
        }
        break;
      } catch (e) {
        if (String(e.message).includes("409") && intento < 3) continue;
        throw e;
      }
    }
    estado.ordenCambiado = false;
    document.getElementById("barra-orden").classList.add("oculto");
    mostrarToast("✅ Orden guardado.");
  } catch (e) {
    mostrarToast("Error al guardar el orden: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 Guardar orden";
  }
}

function botonMover(id) {
  // Solo cuando estás viendo una semana que NO es la actual.
  if (estado.semana === semanaActual()) return "";
  return `<button class="btn-mover" data-id="${escaparAttr(id)}">🗓️ Pasar a la semana actual</button>`;
}

function claseDecidida(id) {
  const d = estado.decisiones.get(id);
  if (d === "va") return "decidida-va";
  if (d === "nova") return "decidida-nova";
  if (d === "volver") return "decidida-volver";
  return "";
}

function tarjetaNoticiaEdicion(item) {
  const card = document.createElement("article");
  card.className = "tarjeta tarjeta-edicion";
  card.dataset.id = item.id;
  const links = [item.url || "", ...(item.urls_extra || [])];
  const opcion = (v, sel, txt) => `<option value="${v}" ${v === sel ? "selected" : ""}>${txt}</option>`;
  card.innerHTML = `
    <span class="categoria">✏️ Editando noticia</span>
    <div class="form-ejemplo">
      <label class="etiqueta-campo">Titular</label>
      <input type="text" class="ed-titular" value="${escaparAttr(item.titular || "")}" />
      <label class="etiqueta-campo">Bajada / descripción</label>
      <input type="text" class="ed-resumen" value="${escaparAttr(item.resumen || "")}" />
      <label class="etiqueta-campo">Por qué da para humor</label>
      <input type="text" class="ed-porque" value="${escaparAttr(item.por_que_humor || "")}" />
      <label class="etiqueta-campo">Fuente</label>
      <input type="text" class="ed-fuente" value="${escaparAttr(item.fuente || "")}" />
      <label class="etiqueta-campo">Links</label>
      <div class="ed-links">
        ${links.map((u) => `<input type="text" class="ed-url" value="${escaparAttr(u)}" placeholder="Link" />`).join("")}
      </div>
      <button type="button" class="btn-otro-link ed-otro-link">🔗 Agregar otro link</button>
      <div class="fila-selects">
        <select class="ed-region">
          ${opcion("chile", item.region || "chile", "🇨🇱 Chile")}
          ${opcion("mundo", item.region || "chile", "🌎 Mundo")}
        </select>
        <select class="ed-categoria">
          ${opcion("absurdo", item.categoria, "Absurdo")}
          ${opcion("observacional", item.categoria, "Observacional")}
          ${opcion("curioso", item.categoria, "Curioso")}
          ${opcion("otro", item.categoria, "Otro")}
        </select>
      </div>
      <div class="acciones">
        <button class="btn-va ed-guardar activo">💾 Guardar cambios</button>
        <button class="btn-nova ed-cancelar">✖ Cancelar</button>
      </div>
    </div>`;
  return card;
}

function botonEditar(id) {
  return `<button class="btn-editar" data-id="${escaparAttr(id)}">✏️ Editar noticia</button>`;
}

function tarjetaNoticia(item) {
  if (item.id === estado.editando) return tarjetaNoticiaEdicion(item);
  const card = document.createElement("article");
  card.className = `tarjeta ${claseDecidida(item.id)}`;
  card.innerHTML = `
    ${botonesOrden(item.id)}
    <span class="categoria">${escapar(item.categoria || "otro")}${item.region === "mundo" ? " · mundo" : ""}</span>
    <h2>${escapar(item.titular || "")}</h2>
    <p class="resumen">${escapar(item.resumen || "")}</p>
    <p class="por-que">😄 ${escapar(item.por_que_humor || "")}</p>
    <p class="fuente">
      ${escapar(item.fuente || "")}
      ${item.url ? `· <a href="${escaparAttr(item.url)}" target="_blank" rel="noopener">ver noticia</a>` : ""}
      ${(item.urls_extra || []).map((u, i) =>
        `· <a href="${escaparAttr(u)}" target="_blank" rel="noopener">link ${i + 2}</a>`
      ).join(" ")}
    </p>
    ${botonesDecision(item.id)}
    ${botonEditar(item.id)}
    ${botonMover(item.id)}
  `;
  return card;
}

function tarjetaTema(item) {
  const card = document.createElement("article");
  card.className = `tarjeta tarjeta-tema ${claseDecidida(item.id)}`;
  card.innerHTML = `
    ${botonesOrden(item.id)}
    <span class="categoria">${escapar(item.categoria || "observacional")}</span>
    <h2>${escapar(item.titulo || "")}</h2>
    ${item.gancho ? `<p class="resumen">${escapar(item.gancho)}</p>` : ""}
    <p class="por-que">💬 ${escapar(item.por_que_conversar || "")}</p>
    ${item.basado_en ? `<p class="fuente">Inspirado en: ${escapar(item.basado_en)}</p>` : ""}
    ${botonesDecision(item.id)}
    ${botonMover(item.id)}
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
  let va = 0, nova = 0, volver = 0;
  estado.decisiones.forEach((d) => {
    if (d === "va") va++;
    else if (d === "nova") nova++;
    else volver++;
  });
  const partes = [];
  if (va) partes.push(`${va} van`);
  if (nova) partes.push(`${nova} no van`);
  if (volver) partes.push(`${volver} vuelven`);
  resumen.textContent = partes.join(" · ");
  barra.classList.remove("oculto");
}

// --- Guardar decisiones ------------------------------------------------------

function quitarPor(arr, campo, valor) {
  return arr.filter((x) => x[campo] !== valor);
}

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

  // Si el repo cambia entre leer y guardar (409: corrida automática, otro
  // guardado), reintentamos con datos frescos. La aplicación de decisiones es
  // idempotente, así que re-ejecutar todo es seguro.
  const MAX_INTENTOS = 3;
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
  try {
    // Traer versiones frescas para evitar conflictos de sha.
    const archPref = await obtenerArchivo("data/preferencias.json");
    const pref = archPref ? JSON.parse(archPref.contenido) : {};
    pref.aprobados = pref.aprobados || [];
    pref.descartados = pref.descartados || [];
    pref.temas_aprobados = pref.temas_aprobados || [];
    pref.temas_descartados = pref.temas_descartados || [];

    const archBand = await obtenerArchivo("data/bandeja.json");
    const bandeja = archBand ? JSON.parse(archBand.contenido) : [];
    const archTemas = await obtenerArchivo("data/bandeja_temas.json");
    const bandejaTemas = archTemas ? JSON.parse(archTemas.contenido) : [];

    const noticiaPorId = new Map(bandeja.map((x) => [x.id, x]));
    const temaPorId = new Map(bandejaTemas.map((x) => [x.id, x]));

    estado.decisiones.forEach((d, id) => {
      const entrada = estado.itemsPorId.get(id);
      if (!entrada) return;

      if (entrada.tipo === "noticia") {
        const it = noticiaPorId.get(id);
        if (!it) return;
        const t = it.titular;
        // Limpiar registros previos en preferencias para este ítem.
        pref.aprobados = quitarPor(pref.aprobados, "titular", t);
        pref.descartados = quitarPor(pref.descartados, "titular", t);
        if (d === "va") {
          it.estado = "aprobada";
          pref.aprobados.push({ titular: t, categoria: it.categoria || "otro", region: it.region || "chile", razon: it.por_que_humor || "" });
        } else if (d === "nova") {
          it.estado = "descartada";
          const razon = (estado.motivos.get(id) || "").trim() || it.por_que_humor || "";
          pref.descartados.push({ titular: t, categoria: it.categoria || "otro", region: it.region || "chile", razon });
        } else {
          it.estado = "en_pauta"; // volver
        }
      } else {
        const it = temaPorId.get(id);
        if (!it) return;
        const t = it.titulo;
        pref.temas_aprobados = quitarPor(pref.temas_aprobados, "titulo", t);
        pref.temas_descartados = quitarPor(pref.temas_descartados, "titulo", t);
        if (d === "va") {
          it.estado = "aprobada";
          pref.temas_aprobados.push({ titulo: t, categoria: it.categoria || "observacional", razon: it.por_que_conversar || "" });
        } else if (d === "nova") {
          it.estado = "descartada";
          const razon = (estado.motivos.get(id) || "").trim() || it.por_que_conversar || "";
          pref.temas_descartados.push({ titulo: t, categoria: it.categoria || "observacional", razon });
        } else {
          it.estado = "en_pauta"; // volver
        }
      }
    });

    await guardarArchivo("data/preferencias.json", pref, archPref ? archPref.sha : null, "Decisiones del conductor (panel web)");
    await guardarArchivo("data/bandeja.json", bandeja, archBand ? archBand.sha : null, "Actualizar estados de noticias (panel)");
    if (bandejaTemas.length) {
      await guardarArchivo("data/bandeja_temas.json", bandejaTemas, archTemas ? archTemas.sha : null, "Actualizar estados de temas (panel)");
    }

    mostrarToast("✅ Decisiones guardadas. ¡El sistema aprende!");
    estado.decisiones.clear();
    estado.motivos.clear();
    await cargarContenido();
    break; // guardado OK
  } catch (e) {
    const esConflicto = String(e.message).includes("409");
    if (esConflicto && intento < MAX_INTENTOS) {
      btn.textContent = `El repo cambió; reintentando (${intento + 1}/${MAX_INTENTOS})…`;
      continue; // reintentar con datos frescos
    }
    mostrarToast("Error al guardar: " + e.message);
    break;
  }
  }
  btn.disabled = false;
  btn.textContent = "💾 Guardar decisiones";
}

// --- Enseñar a la IA ---------------------------------------------------------

function renderEjemplos() {
  const ul = document.getElementById("lista-ejemplos");
  ul.innerHTML = "";
  estado.ejemplos.forEach((ej, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="ej-texto">
        <strong>${escapar(ej.titular || "")}</strong>
        ${ej.por_que ? `<br><span class="ej-porque">${escapar(ej.por_que)}</span>` : ""}
        ${ej.url ? `<br><a href="${escaparAttr(ej.url)}" target="_blank" rel="noopener">${escapar(ej.url)}</a>` : ""}
      </span>
      <span class="ej-acciones">
        <button class="ej-a-pauta" data-i="${i}" title="Pasar a la pauta de esta semana">➕ A la pauta</button>
        <button class="ej-borrar" data-i="${i}" title="Quitar ejemplo">✕</button>
      </span>
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll(".ej-borrar").forEach((b) => {
    b.addEventListener("click", () => {
      estado.ejemplos.splice(Number(b.dataset.i), 1);
      renderEjemplos();
    });
  });
  ul.querySelectorAll(".ej-a-pauta").forEach((b) => {
    b.addEventListener("click", () => pasarEjemploAPauta(Number(b.dataset.i)));
  });
}

function dominio(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

async function pasarEjemploAPauta(i) {
  if (!getToken()) {
    mostrarToast("Primero configurá tu token de GitHub (arriba).");
    document.getElementById("config-details").open = true;
    return;
  }
  const ej = estado.ejemplos[i];
  if (!ej) return;

  try {
    const arch = await obtenerArchivo("data/bandeja.json");
    const bandeja = arch ? JSON.parse(arch.contenido) : [];

    // Evitar duplicar si ya está por URL o por título.
    const nurl = (ej.url || "").trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
    const ntit = (ej.titular || "").trim().toLowerCase();
    const yaEsta = bandeja.some((x) => {
      const xu = (x.url || "").trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
      return (nurl && xu === nurl) || (x.titular || "").trim().toLowerCase() === ntit;
    });
    if (yaEsta) {
      mostrarToast("Esa noticia ya está en la pauta.");
      return;
    }

    bandeja.push({
      id: crypto.randomUUID(),
      fecha_encontrada: ymd(new Date()),
      titular: ej.titular || "",
      resumen: "",
      fuente: dominio(ej.url || ""),
      url: ej.url || "",
      por_que_humor: ej.por_que || "",
      categoria: "otro",
      region: "chile",
      semana: semanaActual(),
      estado: "aprobada",
      origen: "ejemplo_conductor",
    });

    await guardarArchivo("data/bandeja.json", bandeja, arch ? arch.sha : null, "Pasar noticia-ejemplo a la pauta (panel)");
    mostrarToast("✅ Agregada a “✅ Van” de esta semana.");
    await cargarContenido();
  } catch (e) {
    mostrarToast("Error al pasar a la pauta: " + e.message);
  }
}

function agregarEjemplo() {
  const titular = document.getElementById("ej-titular").value.trim();
  const url = document.getElementById("ej-url").value.trim();
  const porque = document.getElementById("ej-porque").value.trim();
  if (!titular) {
    mostrarToast("Poné al menos el titular del ejemplo.");
    return;
  }
  estado.ejemplos.push({ titular, url, por_que: porque });
  document.getElementById("ej-titular").value = "";
  document.getElementById("ej-url").value = "";
  document.getElementById("ej-porque").value = "";
  renderEjemplos();
}

async function guardarEnsenar() {
  if (!getToken()) {
    mostrarToast("Primero configurá tu token de GitHub (arriba).");
    document.getElementById("config-details").open = true;
    return;
  }
  const btn = document.getElementById("btn-guardar-ensenar");
  btn.disabled = true;
  btn.textContent = "Guardando…";
  try {
    // Traer fresco para no pisar aprobados/descartados.
    const archPref = await obtenerArchivo("data/preferencias.json");
    const pref = archPref ? JSON.parse(archPref.contenido) : {};
    pref.notas_conductor = document.getElementById("notas").value.trim();
    pref.ejemplos_conductor = estado.ejemplos;
    await guardarArchivo(
      "data/preferencias.json",
      pref,
      archPref ? archPref.sha : null,
      "Enseñar a la IA: notas y ejemplos del conductor"
    );
    mostrarToast("✅ Guardado. La IA lo usará en la próxima búsqueda.");
  } catch (e) {
    mostrarToast("Error al guardar: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 Guardar lo que le enseñé";
  }
}

async function moverASemanaActual(id) {
  if (!getToken()) {
    mostrarToast("Primero configurá tu token de GitHub (arriba).");
    document.getElementById("config-details").open = true;
    return;
  }
  const entrada = estado.itemsPorId.get(id);
  if (!entrada) return;
  const path = entrada.tipo === "noticia" ? "data/bandeja.json" : "data/bandeja_temas.json";
  try {
    const arch = await obtenerArchivo(path);
    const arr = arch ? JSON.parse(arch.contenido) : [];
    const it = arr.find((x) => x.id === id);
    if (!it) {
      mostrarToast("No la encontré en el repositorio.");
      return;
    }
    it.semana = semanaActual();
    await guardarArchivo(path, arr, arch.sha, "Pasar noticia a la semana actual (panel)");
    mostrarToast("✅ Movida a la semana actual.");
    estado.semana = semanaActual(); // saltar a la semana actual para verla
    await cargarContenido();
  } catch (e) {
    mostrarToast("Error al mover: " + e.message);
  }
}

// --- Editar noticia ------------------------------------------------------------

async function guardarEdicion(card) {
  if (!getToken()) {
    mostrarToast("Primero configurá tu token de GitHub (arriba).");
    document.getElementById("config-details").open = true;
    return;
  }
  const id = card.dataset.id;
  const titular = card.querySelector(".ed-titular").value.trim();
  if (!titular) {
    mostrarToast("El titular no puede quedar vacío.");
    return;
  }
  const resumen = card.querySelector(".ed-resumen").value.trim();
  const porque = card.querySelector(".ed-porque").value.trim();
  const fuente = card.querySelector(".ed-fuente").value.trim();
  const region = card.querySelector(".ed-region").value;
  const categoria = card.querySelector(".ed-categoria").value;
  const links = [...card.querySelectorAll(".ed-url")]
    .map((i) => i.value.trim())
    .filter(Boolean);

  const btn = card.querySelector(".ed-guardar");
  btn.disabled = true;
  btn.textContent = "Guardando…";

  try {
    for (let intento = 1; intento <= 3; intento++) {
      try {
        const arch = await obtenerArchivo("data/bandeja.json");
        const arr = arch ? JSON.parse(arch.contenido) : [];
        const it = arr.find((x) => x.id === id);
        if (!it) {
          mostrarToast("No encontré la noticia en el repositorio.");
          return;
        }
        it.titular = titular;
        it.resumen = resumen;
        it.por_que_humor = porque;
        it.fuente = fuente;
        it.region = region;
        it.categoria = categoria;
        it.url = links[0] || "";
        it.urls_extra = links.slice(1);
        await guardarArchivo("data/bandeja.json", arr, arch.sha, "Editar noticia (panel)");
        break;
      } catch (e) {
        if (String(e.message).includes("409") && intento < 3) continue;
        throw e;
      }
    }
    estado.editando = null;
    mostrarToast("✅ Noticia actualizada.");
    await cargarContenido();
  } catch (e) {
    mostrarToast("Error al editar: " + e.message);
    btn.disabled = false;
    btn.textContent = "💾 Guardar cambios";
  }
}

// --- Agregar noticia a mano ----------------------------------------------------

async function agregarNoticiaManual() {
  if (!getToken()) {
    mostrarToast("Primero configurá tu token de GitHub (arriba).");
    document.getElementById("config-details").open = true;
    return;
  }
  const titular = document.getElementById("man-titular").value.trim();
  const links = [...document.querySelectorAll("#man-links .man-url")]
    .map((i) => i.value.trim())
    .filter(Boolean);
  const url = links[0] || "";
  const urlsExtra = links.slice(1);
  const resumen = document.getElementById("man-resumen").value.trim();
  const porque = document.getElementById("man-porque").value.trim();
  const region = document.getElementById("man-region").value;
  const categoria = document.getElementById("man-categoria").value;

  if (!titular) {
    mostrarToast("Poné al menos el titular.");
    return;
  }

  const btn = document.getElementById("btn-agregar-mano");
  btn.disabled = true;
  btn.textContent = "Agregando…";

  try {
    const arch = await obtenerArchivo("data/bandeja.json");
    const bandeja = arch ? JSON.parse(arch.contenido) : [];

    // Evitar duplicados por URL o por título.
    const nurl = url.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
    const ntit = titular.toLowerCase();
    const yaEsta = bandeja.some((x) => {
      const xu = (x.url || "").trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
      return (nurl && xu === nurl) || (x.titular || "").trim().toLowerCase() === ntit;
    });
    if (yaEsta) {
      mostrarToast("Esa noticia ya está en la bandeja (quizás en otra semana).");
      return;
    }

    bandeja.push({
      id: crypto.randomUUID(),
      fecha_encontrada: ymd(new Date()),
      titular,
      resumen,
      fuente: dominio(url),
      url,
      urls_extra: urlsExtra,
      por_que_humor: porque,
      categoria,
      region,
      semana: semanaActual(),
      estado: "aprobada",
      origen: "manual",
    });

    await guardarArchivo("data/bandeja.json", bandeja, arch ? arch.sha : null, "Agregar noticia a mano (panel)");

    // Limpiar el formulario (y dejar un solo campo de link).
    ["man-titular", "man-resumen", "man-porque"].forEach((i) => {
      document.getElementById(i).value = "";
    });
    document.getElementById("man-links").innerHTML =
      '<input type="text" class="man-url" placeholder="Link (opcional)" />';

    mostrarToast("✅ Agregada a “✅ Van” de esta semana.");
    estado.semana = semanaActual();
    await cargarContenido();
  } catch (e) {
    mostrarToast("Error al agregar: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "➕ Agregar a la pauta de esta semana";
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

  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => {
      estado.vista = b.dataset.vista;
      renderizar();
    });
  });

  document.getElementById("semana").addEventListener("change", (e) => {
    estado.semana = e.target.value;
    renderizar();
  });

  document.getElementById("btn-agregar-ejemplo").addEventListener("click", agregarEjemplo);
  document.getElementById("btn-guardar-ensenar").addEventListener("click", guardarEnsenar);
  document.getElementById("btn-agregar-mano").addEventListener("click", agregarNoticiaManual);
  document.getElementById("btn-guardar-orden").addEventListener("click", guardarOrden);
  document.getElementById("btn-otro-link").addEventListener("click", () => {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "man-url";
    inp.placeholder = "Otro link (opcional)";
    document.getElementById("man-links").appendChild(inp);
    inp.focus();
  });

  await detectarBranch();
  await cargarContenido();
}

iniciar();
