/* =========================================================================
   MOBILE-TABS.JS — Navegación por pestañas en pantallas móviles
   ---------------------------------------------------------------------
   En escritorio (>980px) este script no cambia nada visualmente: la
   barra que construye permanece oculta por CSS (.mobile-tabbar{display:
   none}) y los 3 paneles siguen mostrándose lado a lado como siempre.

   En pantallas angostas, el CSS responsive (style.css) oculta los 3
   paneles del workspace y solo muestra el que tenga la clase
   ".mobile-active". Este script:
     1. Construye la barra de pestañas inferior (Parámetros · Visor 3D ·
        Datos · Gráficas) y la agrega al final de .app.
     2. Al tocar una pestaña, muestra su panel a pantalla completa.
     3. El panel "Datos" y el panel "Gráficas" comparten el mismo <aside>
        (panel-data); dentro se alterna qué .data-section es visible.
     4. Como el visor 3D y las gráficas quedan con ancho/alto en 0 mientras
        su panel está en display:none, se fuerza un recálculo de tamaño
        (Scene3D.resize() / chart.resize()) justo después de mostrarlos,
        para que no aparezcan cortados o distorsionados al cambiar de
        pestaña.
   ========================================================================= */
(function () {

  const TABS = [
    {
      key: "params", label: "Parámetros", panel: ".panel-params",
      icon: '<path d="M3 6h9M15.5 6h1.5M3 14h5.5M11.5 14H17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="6" r="2.3" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="14" r="2.3" stroke="currentColor" stroke-width="1.6"/>'
    },
    {
      key: "viewer", label: "Visor 3D", panel: ".panel-viewer",
      icon: '<path d="M10 2.5 17 6.5v7L10 17.5 3 13.5v-7L10 2.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 6.5 10 10.5 17 6.5M10 10.5v7" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
    },
    {
      key: "data", label: "Datos", panel: ".panel-data", section: "#dataSectionMain",
      icon: '<rect x="3" y="3" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="11" y="3" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="11" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="11" y="11" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/>'
    },
    {
      key: "charts", label: "Gráficas", panel: ".panel-data", section: "#dataSectionCharts",
      icon: '<path d="M3.5 16.5v-6M9 16.5V4.5M14.5 16.5v-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    }
  ];

  let currentTab = "viewer";
  let tabbarEl = null;

  function panelKeysSharing(panelSelector) {
    return TABS.filter((t) => t.panel === panelSelector).map((t) => t.key);
  }

  function activate(key) {
    currentTab = key;
    const activeTab = TABS.find((t) => t.key === key);
    if (!activeTab) return;

    // Muestra/oculta los <section>/<aside> de nivel superior. Un mismo
    // panel (panel-data) puede pertenecer a más de una pestaña.
    const seenPanels = new Set();
    TABS.forEach((t) => {
      if (seenPanels.has(t.panel)) return;
      seenPanels.add(t.panel);
      const panelEl = document.querySelector(t.panel);
      if (!panelEl) return;
      const keysForThisPanel = panelKeysSharing(t.panel);
      panelEl.classList.toggle("mobile-active", keysForThisPanel.includes(key));
    });

    // Alterna la sub-sección visible dentro de panel-data (Datos vs Gráficas)
    document.querySelectorAll(".data-section").forEach((sec) => sec.classList.remove("mobile-section-active"));
    if (activeTab.section) {
      const sec = document.querySelector(activeTab.section);
      if (sec) sec.classList.add("mobile-section-active");
    }

    // Estado visual de los botones de la barra
    if (tabbarEl) {
      tabbarEl.querySelectorAll(".mtab-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.tab === key);
      });
    }

    // El canvas 3D y los <canvas> de Chart.js quedan con dimensiones 0
    // mientras su contenedor estuvo en display:none; se recalculan justo
    // después de que el navegador aplique el nuevo layout.
    requestAnimationFrame(() => {
      // Scene3D y Charts se declaran con "const" en scene3d.js/charts.js,
      // por lo que existen como identificadores globales del documento
      // pero NO como propiedades de window; se referencian directamente.
      if (key === "viewer" && typeof Scene3D !== "undefined" && typeof Scene3D.resize === "function") {
        Scene3D.resize();
      }
      if (key === "charts" && typeof Charts !== "undefined") {
        ["chart1", "chart2", "chart3"].forEach((id) => {
          const c = Charts[id];
          if (c && typeof c.resize === "function") c.resize();
        });
      }
    });
  }

  function buildTabbar() {
    const bar = document.createElement("nav");
    bar.className = "mobile-tabbar";
    bar.id = "mobileTabbar";
    bar.setAttribute("aria-label", "Navegación del simulador");
    bar.innerHTML = TABS.map((t) => `
      <button class="mtab-btn" type="button" data-tab="${t.key}" title="${t.label}">
        <svg viewBox="0 0 20 20" fill="none">${t.icon}</svg>
        <span class="mtab-label">${t.label}</span>
      </button>
    `).join("");

    document.querySelector(".app").appendChild(bar);

    bar.addEventListener("click", (e) => {
      const btn = e.target.closest(".mtab-btn");
      if (!btn) return;
      activate(btn.dataset.tab);
    });

    tabbarEl = bar;
  }

  function init() {
    buildTabbar();
    activate(currentTab);

    // Al rotar el dispositivo (o cruzar el umbral de escritorio/móvil),
    // se reafirma la pestaña activa para que Scene3D y Chart.js
    // recalculen sus dimensiones contra el nuevo tamaño de pantalla.
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => activate(currentTab), 120);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
