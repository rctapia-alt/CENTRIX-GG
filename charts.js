/* =========================================================================
   CHARTS.JS — Gráficas de proceso (Chart.js 4) con tema oscuro CENTRIX
   ========================================================================= */

const Charts = (() => {

  const PALETTE = {
    heavy: "#E8A33D",
    light: "#4FC3D9",
    green: "#3DCB7A",
    grid: "rgba(74,86,104,.22)",
    text: "#8A93A3"
  };

  let chart1, chart2, chart3;

  function baseOptions(xLabel, yLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 260 },
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: PALETTE.text,
            font: { family: "'JetBrains Mono', monospace", size: 9.5 },
            boxWidth: 10, boxHeight: 2, usePointStyle: false, padding: 10
          }
        },
        tooltip: {
          backgroundColor: "#12161D",
          borderColor: "#2A313C",
          borderWidth: 1,
          titleFont: { family: "'JetBrains Mono', monospace", size: 10 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 10 },
          padding: 8
        }
      },
      scales: {
        x: {
          title: { display: !!xLabel, text: xLabel || "", color: PALETTE.text, font: { size: 9.5, family: "'JetBrains Mono', monospace" } },
          ticks: { color: PALETTE.text, font: { size: 9, family: "'JetBrains Mono', monospace" }, maxTicksLimit: 6 },
          grid: { color: PALETTE.grid, drawTicks: false }
        },
        y: {
          title: { display: !!yLabel, text: yLabel || "", color: PALETTE.text, font: { size: 9.5, family: "'JetBrains Mono', monospace" } },
          ticks: { color: PALETTE.text, font: { size: 9, family: "'JetBrains Mono', monospace" }, maxTicksLimit: 5 },
          grid: { color: PALETTE.grid, drawTicks: false }
        }
      }
    };
  }

  function lineDataset(label, data, color, opts = {}) {
    return {
      label, data,
      borderColor: color,
      backgroundColor: color + "22",
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 3,
      fill: opts.fill || false,
      tension: opts.tension ?? 0.25,
      borderDash: opts.dash || undefined
    };
  }

  function pointDataset(label, data, color) {
    return {
      label, data,
      borderColor: color,
      backgroundColor: color,
      pointRadius: 5,
      pointHoverRadius: 6,
      showLine: false,
      type: "scatter"
    };
  }

  function init() {
    const ctx1 = document.getElementById("chart1").getContext("2d");
    const ctx2 = document.getElementById("chart2").getContext("2d");
    const ctx3 = document.getElementById("chart3").getContext("2d");

    chart1 = new Chart(ctx1, { type: "line", data: { labels: [], datasets: [] }, options: baseOptions("r", "P") });
    chart2 = new Chart(ctx2, { type: "line", data: { labels: [], datasets: [] }, options: baseOptions("n", "P") });
    chart3 = new Chart(ctx3, { type: "line", data: { labels: [], datasets: [] }, options: baseOptions("", "") });
  }

  // spec: { labels, datasets: [{label,data,color,point?}], xLabel, yLabel }
  function render(chart, spec) {
    chart.data.labels = spec.labels;
    chart.data.datasets = spec.datasets.map(d =>
      d.point ? pointDataset(d.label, d.data, d.color) : lineDataset(d.label, d.data, d.color, d)
    );
    chart.options.scales.x.title.text = spec.xLabel || "";
    chart.options.scales.x.title.display = !!spec.xLabel;
    chart.options.scales.y.title.text = spec.yLabel || "";
    chart.options.scales.y.title.display = !!spec.yLabel;
    chart.update("none");
  }

  function renderPressureChart(spec) { render(chart1, spec); }
  function renderPowerChart(spec) { render(chart2, spec); }
  function renderThirdChart(spec) { render(chart3, spec); }

  // -----------------------------------------------------------------------
  // MODO EVOLUTIVO (streaming) — gráficas cuyo eje X es el tiempo de
  // simulación t (s). Se usan mientras el cronómetro está en Play para
  // dibujar la curva en tiempo real conforme avanza la integración, sin
  // recrear el dataset completo en cada frame (solo se hace push/trim).
  // -----------------------------------------------------------------------
  const MAX_STREAM_POINTS = 400; // ventana deslizante para no degradar el FPS

  function ensureStreamDatasets(chart, series, xLabel, yLabel) {
    const need = chart.data.datasets.length !== series.length ||
      series.some((s, i) => chart.data.datasets[i]?.label !== s.label);
    if (need) {
      chart.data.labels = [];
      chart.data.datasets = series.map(s => lineDataset(s.label, [], s.color, { tension: 0.15 }));
      chart.options.scales.x.title.text = xLabel || "";
      chart.options.scales.x.title.display = !!xLabel;
      chart.options.scales.y.title.text = yLabel || "";
      chart.options.scales.y.title.display = !!yLabel;
    }
  }

  // t: tiempo actual (s) · series: [{label,color,value}]
  function pushStreamPoint(chart, t, series, xLabel, yLabel) {
    ensureStreamDatasets(chart, series, xLabel, yLabel);
    chart.data.labels.push(t.toFixed(1));
    series.forEach((s, i) => chart.data.datasets[i].data.push(s.value));
    if (chart.data.labels.length > MAX_STREAM_POINTS) {
      chart.data.labels.shift();
      chart.data.datasets.forEach(d => d.data.shift());
    }
    chart.update("none");
  }

  function resetStream(chart) {
    chart.data.labels = [];
    chart.data.datasets = [];
    chart.update("none");
  }

  function pushPressureStream(t, series) { pushStreamPoint(chart1, t, series, "t (s)", "P (Pa)"); }
  function pushRadialStream(t, series) { pushStreamPoint(chart1, t, series, "t (s)", "r (m)"); }
  function pushPowerStream(t, series) { pushStreamPoint(chart2, t, series, "t (s)", "valor"); }
  function pushThirdStream(t, series) { pushStreamPoint(chart3, t, series, "t (s)", "valor"); }
  function resetAllStreams() { [chart1, chart2, chart3].forEach(resetStream); }

  return {
    init, renderPressureChart, renderPowerChart, renderThirdChart, PALETTE,
    pushStreamPoint, pushPressureStream, pushRadialStream, pushPowerStream, pushThirdStream,
    resetAllStreams, resetStream,
    get chart1() { return chart1; }, get chart2() { return chart2; }, get chart3() { return chart3; }
  };
})();
