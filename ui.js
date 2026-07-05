/* =========================================================================
   UI.JS — Renderizado de controles, lecturas y alertas (agnóstico de equipo)
   Este módulo solo construye/actualiza DOM. La lógica de cálculo vive en
   engine.js y la orquestación en main.js.
   ========================================================================= */

const UI = (() => {

  const els = {
    paramsScroll: document.getElementById("paramsScroll"),
    footEq: document.getElementById("foot-eq-render"),
    footLabel: document.querySelector("#ecuacionActiva .foot-label"),
    viewerTitle: document.getElementById("viewerTitle"),
    viewerHud: document.getElementById("viewerHud"),
    readoutGrid: document.getElementById("readoutGrid"),
    alertBox: document.getElementById("alertBox"),
    alertTitle: document.getElementById("alertTitle"),
    alertBody: document.getElementById("alertBody"),
    statusLed: document.getElementById("statusLed"),
    statusLabel: document.getElementById("statusLabel"),
    chart1Title: document.getElementById("chart1Title"),
    chart1Eq: document.getElementById("chart1Eq"),
    chart2Title: document.getElementById("chart2Title"),
    chart2Eq: document.getElementById("chart2Eq"),
    chart3Title: document.getElementById("chart3Title"),
    chart3Eq: document.getElementById("chart3Eq"),
    simTime: document.getElementById("simTime"),
    simPlay: document.getElementById("simPlay"),
    simPause: document.getElementById("simPause"),
    simReset: document.getElementById("simReset"),
    simSpeedGroup: document.getElementById("simSpeedGroup"),
    simProgressFill: document.getElementById("simProgressFill"),
    simProgressLabel: document.getElementById("simProgressLabel")
  };

  // -----------------------------------------------------------------------
  // Formato numérico compacto para lecturas
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // Caché del último estado renderizado — usada por ar.js para poblar las
  // etiquetas flotantes (billboards) y el panel de teoría en modo AR sin
  // duplicar los cálculos que ya hace main.js en cada recompute(). Es una
  // simple fotografía de lo último que se pintó en el panel de datos.
  // -----------------------------------------------------------------------
  const lastState = {
    readouts: [], footEq: { label: "", eq: "" }, viewerTitle: "", viewerHud: [],
    alert: { level: "good", title: "", body: "" }
  };

  function fmt(value, decimals = 2) {
    if (value === null || value === undefined || Number.isNaN(value)) return "—";
    if (Math.abs(value) >= 1000) return value.toLocaleString("es", { maximumFractionDigits: 0 });
    return value.toFixed(decimals);
  }

  // -----------------------------------------------------------------------
  // §1. PANEL DE PARÁMETROS — sliders agrupados
  // groups: [{ title, params:[{key,label,min,max,step,decimals,unit,accent,value}] }]
  // onInput(key, numericValue) — callback disparado en cada movimiento
  // -----------------------------------------------------------------------
  function renderParams(groups, onInput) {
    els.paramsScroll.innerHTML = "";
    groups.forEach((group) => {
      const g = document.createElement("div");
      g.className = "param-group";

      const title = document.createElement("div");
      title.className = "param-group-title";
      title.textContent = group.title;
      g.appendChild(title);

      group.params.forEach((p) => {
        const row = document.createElement("div");
        row.className = "param-row";
        row.style.setProperty("--accent-c", p.accent || "#E8A33D");

        const head = document.createElement("div");
        head.className = "param-row-head";
        const label = document.createElement("label");
        label.setAttribute("for", `p-${p.key}`);
        label.textContent = p.label;
        const valueWrap = document.createElement("span");
        valueWrap.className = "param-value";
        valueWrap.id = `pv-${p.key}`;
        valueWrap.innerHTML = `${fmt(p.value, p.decimals)} <span class="unit">${p.unit || ""}</span>`;
        head.appendChild(label);
        head.appendChild(valueWrap);

        const input = document.createElement("input");
        input.type = "range";
        input.id = `p-${p.key}`;
        input.min = p.min;
        input.max = p.max;
        input.step = p.step;
        input.value = p.value;

        input.addEventListener("input", () => {
          const v = parseFloat(input.value);
          valueWrap.innerHTML = `${fmt(v, p.decimals)} <span class="unit">${p.unit || ""}</span>`;
          onInput(p.key, v);
        });

        row.appendChild(head);
        row.appendChild(input);
        g.appendChild(row);
      });

      els.paramsScroll.appendChild(g);
    });
  }

  function updateParamDisplay(key, value, decimals, unit) {
    const el = document.getElementById(`pv-${key}`);
    if (el) el.innerHTML = `${fmt(value, decimals)} <span class="unit">${unit || ""}</span>`;
    const input = document.getElementById(`p-${key}`);
    if (input && parseFloat(input.value) !== value) input.value = value;
  }

  // -----------------------------------------------------------------------
  // §2. ECUACIÓN GOBERNANTE (pie del panel de parámetros)
  // -----------------------------------------------------------------------
  function setFootEq(label, eq) {
    els.footLabel.textContent = label;
    els.footEq.textContent = eq;
    lastState.footEq = { label, eq };
  }

  // -----------------------------------------------------------------------
  // §3. TÍTULO Y HUD DEL VISOR 3D
  // -----------------------------------------------------------------------
  function setViewerTitle(text) {
    els.viewerTitle.textContent = text;
    lastState.viewerTitle = text;
  }

  function setViewerHud(rows) {
    els.viewerHud.innerHTML = rows.map(
      (r) => `<div class="hud-row"><span>${r.label}</span><b>${r.value}</b></div>`
    ).join("");
    lastState.viewerHud = rows;
  }

  // -----------------------------------------------------------------------
  // §4. GRID DE LECTURAS NUMÉRICAS
  // items: [{label, value, unit, status:'good'|'warn'|'bad'}]
  // -----------------------------------------------------------------------
  function renderReadouts(items) {
    els.readoutGrid.innerHTML = items.map((it) => `
      <div class="readout-item ${it.status || 'good'}">
        <div class="readout-label">${it.label}</div>
        <div class="readout-value">${it.value}<span class="unit">${it.unit || ""}</span></div>
      </div>
    `).join("");
    lastState.readouts = items;
  }

  // -----------------------------------------------------------------------
  // §5. ALERTA DE ESTADO + LED DE LA CINTA SUPERIOR
  // level: 'good' | 'warn' | 'bad'
  // -----------------------------------------------------------------------
  function setAlert(level, title, body) {
    els.alertBox.className = `alert-box ${level === "good" ? "" : level}`.trim();
    els.alertTitle.textContent = title;
    els.alertBody.textContent = body;
    lastState.alert = { level, title, body };
  }

  function setStatusLed(level, label) {
    els.statusLed.className = `status-led ${level === "good" ? "" : level}`.trim();
    els.statusLabel.textContent = label;
  }

  // -----------------------------------------------------------------------
  // §6. ETIQUETAS DE GRÁFICAS
  // -----------------------------------------------------------------------
  function setChartMeta(idx, title, eq) {
    const t = els[`chart${idx}Title`], e = els[`chart${idx}Eq`];
    if (t) t.textContent = title;
    if (e) e.textContent = eq;
  }

  // -----------------------------------------------------------------------
  // §7. CRONÓMETRO DE SIMULACIÓN — tiempo transcurrido, estado Play/Pausa,
  // selector de velocidad (1x/2x/5x) y barra de progreso hacia el tiempo
  // de residencia teórico (cuando aplica, p. ej. sedimentación completa).
  // -----------------------------------------------------------------------
  function fmtTime(t) {
    if (t < 60) return `${t.toFixed(1)} s`;
    const m = Math.floor(t / 60), s = (t % 60).toFixed(0).padStart(2, "0");
    return `${m}:${s} min`;
  }

  function setSimTime(t) {
    if (els.simTime) els.simTime.textContent = fmtTime(t);
  }

  function setPlayingState(playing) {
    if (els.simPlay) els.simPlay.classList.toggle("active", playing);
    if (els.simPause) els.simPause.classList.toggle("active", !playing);
  }

  function setSpeedActive(speed) {
    if (!els.simSpeedGroup) return;
    els.simSpeedGroup.querySelectorAll(".speed-btn").forEach((b) => {
      b.classList.toggle("active", parseFloat(b.dataset.speed) === speed);
    });
  }

  // progreso 0..1 hacia el evento objetivo (p.ej. partícula llega a la pared,
  // o interfase alcanza equilibrio). label es texto libre tipo "62% a la pared".
  function setSimProgress(fraction, label) {
    if (els.simProgressFill) els.simProgressFill.style.width = `${Math.min(Math.max(fraction, 0), 1) * 100}%`;
    if (els.simProgressLabel) els.simProgressLabel.textContent = label || "";
  }

  return {
    renderParams, updateParamDisplay,
    setFootEq, setViewerTitle, setViewerHud,
    renderReadouts, setAlert, setStatusLed, setChartMeta,
    setSimTime, setPlayingState, setSpeedActive, setSimProgress, fmtTime,
    fmt,
    // Lectura de solo lectura del último estado pintado — usada por ar.js
    getLastState: () => lastState
  };
})();
