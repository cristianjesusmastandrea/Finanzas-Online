// index.js
import express from "express";
import axios from "axios";
import cheerio from "cheerio";
import fs from "fs-extra";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(process.cwd(), "state.json");

// estado en memoria (se persiste a disco)
let state = {
  dolar: { value: null, source: null, updatedAt: null, status: "initial" },
  billeteras: { value: null, source: null, updatedAt: null, status: "initial" },
  cauciones: { value: null, source: null, updatedAt: null, status: "initial" },
  plazosFijos: { value: null, source: null, updatedAt: null, status: "initial" }
};

// carga estado desde archivo si existe
async function loadState() {
  try {
    if (await fs.pathExists(STATE_FILE)) {
      const raw = await fs.readFile(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      state = { ...state, ...parsed };
      console.log("🔁 Estado cargado desde", STATE_FILE);
    } else {
      console.log("ℹ️ No existe state.json — se creará al primer guardado.");
      await saveState();
    }
  } catch (err) {
    console.error("❌ Error cargando state:", err);
  }
}

async function saveState() {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    //console.log("✅ state.json guardado");
  } catch (err) {
    console.error("❌ Error guardando state:", err);
  }
}

/* -------------------------
   FETCHERS / SCRAPERS
   Cada fetch intenta obtener datos y, si falla,
   no pisa el último valor guardado (fallback).
   ------------------------- */

/* 1) DÓLAR - intenta 1) API pública (dolarapi) 2) scrappear DolarHoy */
async function fetchDolar() {
  console.log("🔎 Actualizando dólar...");
  const now = new Date().toISOString();
  // Intento 1: API pública (configurable)
  try {
    // --- EJEMPLO: intentar una API que devuelva JSON (si existe) ---
    // Cambia la URL si tenés otra API preferida.
    const apiUrl = "https://dolarapi.com/v1/dolares/blue"; // si funciona, perfecto
    const resp = await axios.get(apiUrl, { timeout: 7000 });
    if (resp && resp.data) {
      // formato esperado: objeto con compra/venta o array; adaptá si tu API difiere
      state.dolar = {
        value: resp.data,
        source: apiUrl,
        updatedAt: now,
        status: "ok"
      };
      await saveState();
      console.log("✅ Dólar desde API:", apiUrl);
      return;
    }
  } catch (err) {
    console.log("⚠️ API dólar falló (o no existe) — intento scrapear DolarHoy...");
  }

  // Intento 2: scrapear DolarHoy (puede necesitar ajuste si cambia HTML)
  try {
    const url = "https://dolarhoy.com/";
    const resp = await axios.get(url, { timeout: 8000 });
    const $ = cheerio.load(resp.data);

    // Intento buscar "Blue" y sus valores en la página — estos selectores pueden variar
    // Buscamos por texto "Blue" y luego tomamos los valores de compra/venta cercanos.
    let blueCompra = null;
    let blueVenta = null;

    // Estrategia: buscar tarjetas con texto 'Blue' y parsear
    $("*").each((i, el) => {
      const text = $(el).text().trim();
      if (/blue/i.test(text) && (!blueCompra || !blueVenta)) {
        // buscamos en el elemento padre valores monetarios
        const parent = $(el).closest("div");
        const textParent = parent.text();
        const matches = textParent.match(/([\d]+[.,][\d]{2})/g);
        if (matches && matches.length >= 2) {
          blueCompra = matches[0];
          blueVenta = matches[1];
        }
      }
    });

    if (!blueCompra || !blueVenta) {
      // intento alternativo: buscar por clases comunes
      const posibleCompra = $('div:contains("Compra")').first().next().text().trim();
      const posibleVenta = $('div:contains("Venta")').first().next().text().trim();
      if (posibleCompra) blueCompra = posibleCompra;
      if (posibleVenta) blueVenta = posibleVenta;
    }

    if (blueCompra || blueVenta) {
      // limpiar formato
      const clean = s => (s ? s.replace(/[^\d,.-]/g, "").replace(",", ".") : null);
      state.dolar = {
        value: {
          blue: { compra: clean(blueCompra), venta: clean(blueVenta) }
        },
        source: url,
        updatedAt: now,
        status: "ok"
      };
      await saveState();
      console.log("✅ Dólar desde DolarHoy (scrape)");
      return;
    } else {
      throw new Error("No se encontraron valores en DolarHoy");
    }
  } catch (err) {
    console.log("⚠️ Scrape DolarHoy falló:", err.message || err);
    // fallback: no sobreescribir, sólo indicar fallback
    state.dolar.status = "fallback";
    // updatedAt no se cambia, mantenemos el timestamp previo
    await saveState();
  }
}

/* 2) BILLETERAS — intentamos scrapear páginas públicas (ejemplos: Mercado Pago, Ualá)
   Estas páginas suelen mostrar el rendimiento o TNA en una sección; los selectores varían.
   El código intenta patrones generales de porcentaje.
*/
async function fetchBilleteras() {
  console.log("🔎 Actualizando billeteras...");
  const now = new Date().toISOString();
  const providers = [
    { name: "Mercado Pago", url: "https://www.mercadopago.com.ar/ayuda/4269" },
    { name: "Ualá", url: "https://www.uala.com.ar/ahorro" },
    // agregá más si querés
  ];

  const results = [];

  for (const p of providers) {
    try {
      const resp = await axios.get(p.url, { timeout: 8000 });
      const html = resp.data;
      // buscar el primer porcentaje tipo "62,5%" o "62.5%"
      const percentMatch = html.match(/(\d{1,2}[.,]\d{1,2})\s*%/);
      let tna = percentMatch ? percentMatch[1].replace(",", ".") + "%" : null;

      // Si no aparece, intentamos buscar "TNA" cercano
      if (!tna) {
        const idx = html.search(/TNA|T.E.A|tna/i);
        if (idx >= 0) {
          const snippet = html.substring(Math.max(0, idx - 80), idx + 120);
          const m = snippet.match(/(\d{1,2}[.,]\d{1,2})\s*%/);
          if (m) tna = m[1].replace(",", ".") + "%";
        }
      }

      if (tna) {
        results.push({ provider: p.name, tna, url: p.url, status: "ok" });
      } else {
        results.push({ provider: p.name, tna: null, url: p.url, status: "not_found" });
      }
    } catch (err) {
      console.log(`⚠️ Error billetera ${p.name}:`, err.message || err);
      results.push({ provider: p.name, tna: null, url: p.url, status: "error" });
    }
  }

  // Si al menos una está OK, guardamos; si todas fallaron, fallback
  const anyOk = results.some(r => r.status === "ok");
  if (anyOk) {
    state.billeteras = {
      value: results,
      source: "varias",
      updatedAt: now,
      status: "ok"
    };
  } else {
    state.billeteras.status = "fallback";
  }
  await saveState();
}

/* 3) CAUCIONES (ej. IOL) — scrapear panel de cauciones de invertironline */
async function fetchCauciones() {
  console.log("🔎 Actualizando cauciones...");
  const now = new Date().toISOString();
  try {
    const url = "https://iol.invertironline.com/mercado/cauciones";
    const resp = await axios.get(url, { timeout: 9000 });
    const html = resp.data;
    // buscar percentiles en la página
    const matches = html.match(/(\d{1,2}[.,]\d{1,2})\s*%/g);
    let tasas = null;
    if (matches && matches.length >= 3) {
      // tomamos las primeras 6 coincidencias y devolvemos ejemplo 1d/7d/30d si aplica
      tasas = matches.slice(0, 6).map(s => s.replace(",", "."));
    } else {
      // intento alternativo: buscar tablas con 'Caución' - si no funciona, fallback
      const alt = html.match(/Caucion.*?(\d{1,2}[.,]\d{1,2})\s*%/i);
      if (alt) tasas = [alt[1].replace(",", ".") + "%"];
    }

    if (tasas) {
      state.cauciones = {
        value: { raw: tasas },
        source: url,
        updatedAt: now,
        status: "ok"
      };
    } else {
      throw new Error("No se detectaron tasas en cauciones");
    }
  } catch (err) {
    console.log("⚠️ Error cauciones:", err.message || err);
    state.cauciones.status = "fallback";
  }
  await saveState();
}

/* 4) PLAZOS FIJOS (ej. BCRA / bancos) — intento BCRA y fallback */
async function fetchPlazosFijos() {
  console.log("🔎 Actualizando plazos fijos...");
  const now = new Date().toISOString();
  try {
    const url = "https://www.bcra.gob.ar/BCRAyVos/Plazos_fijos.asp";
    const resp = await axios.get(url, { timeout: 9000 });
    const html = resp.data;
    // extraer porcentajes
    const matches = html.match(/(\d{1,2}[.,]\d{1,2})\s*%/g);
    let tasas = null;
    if (matches && matches.length >= 4) {
      tasas = matches.slice(0, 8).map(s => s.replace(",", "."));
    } else {
      // buscar en tablas por bancos específicos (sólo ejemplo)
      const alt = html.match(/Banco.*?(\d{1,2}[.,]\d{1,2})\s*%/i);
      if (alt) tasas = [alt[1].replace(",", ".") + "%"];
    }

    if (tasas) {
      state.plazosFijos = {
        value: { raw: tasas },
        source: url,
        updatedAt: now,
        status: "ok"
      };
    } else {
      throw new Error("No se detectaron tasas en plazos fijos");
    }
  } catch (err) {
    console.log("⚠️ Error plazos fijos:", err.message || err);
    state.plazosFijos.status = "fallback";
  }
  await saveState();
}

/* Función que actualiza todo */
async function actualizarTodo() {
  console.log("=== Inicio actualización completa ===");
  await fetchDolar();
  await fetchBilleteras();
  await fetchCauciones();
  await fetchPlazosFijos();
  console.log("=== Fin actualización completa ===");
}

/* -------------------------
   Rutas API
   ------------------------- */

app.get("/dolar", (req, res) => {
  res.json({
    meta: { route: "/dolar" },
    data: state.dolar
  });
});

app.get("/billeteras", (req, res) => {
  res.json({
    meta: { route: "/billeteras" },
    data: state.billeteras
  });
});

app.get("/cauciones", (req, res) => {
  res.json({
    meta: { route: "/cauciones" },
    data: state.cauciones
  });
});

app.get("/plazosfijos", (req, res) => {
  res.json({
    meta: { route: "/plazosfijos" },
    data: state.plazosFijos
  });
});

/* Resumen en / */
app.get("/", (req, res) => {
  res.json({
    meta: { route: "/" },
    data: {
      dolar: state.dolar,
      billeteras: state.billeteras,
      cauciones: state.cauciones,
      plazosFijos: state.plazosFijos
    }
  });
});

/* Endpoints administrativos simples */
app.get("/admin/force-update", async (req, res) => {
  try {
    await actualizarTodo();
    res.json({ ok: true, message: "Actualización forzada ejecutada" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

/* Iniciar servidor y scheduler */
async function start() {
  await loadState();

  // primera actualización asíncrona (no bloqueante)
  actualizarTodo().catch(e => console.log("initial update error", e));

  // Scheduler: actualizar cada 15 minutos (modificá si querés)
  const minutes = 15;
  setInterval(() => {
    actualizarTodo().catch(e => console.error("Scheduler error", e));
  }, minutes * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`🚀 API corriendo en puerto ${PORT}`);
  });
}

/* arranque */
start().catch(err => console.error("Error al arrancar:", err));
