/* =========================================================================
   MAIN.JS — Orquestador de CENTRIX
   Conecta engine.js (matemática) · scene3d.js (visor) · charts.js (gráficas)
   · ui.js (DOM) para los tres equipos: decanter, bowl, pump.
   ========================================================================= */

(function () {

  const ACCENT = { heavy: "#E8A33D", light: "#4FC3D9", green: "#3DCB7A", solids: "#9C6B3E" };
  const SCALE_R_DECANTER = 7.0; // m (real) -> unidades de escena
  const SCALE_R_BOWL = 1.13 / 0.18; // radio de pared real (0.18 m) -> radio de escena (1.13) del bowl en scene3d.js

  // -----------------------------------------------------------------------
  // Estado de parámetros por equipo (valores actuales, editables por UI)
  // -----------------------------------------------------------------------
  const state = {
    decanter: { rpm: 3000, rA: 0.12, rB: 0.05, rhoA: 1050, rhoB: 850 },
    bowl: { rpm: 6000, r: 0.12, Dp: 20, rhoP: 2200, rho: 1000, mu: 0.001, tProceso: 120 },
    pump: {
      n: 1750, q1: 40, H1: 30, P1: 7.5,
      rho: 1000, r1imp: 0.04, r2imp: 0.15,
      Pvapor: 2340, zs: 1, npshReq: 3
    }
  };
  const PUMP_N_REF = 1750; // rpm — punto de diseño de referencia (fijo)
  const BOWL_R0 = 0.02;    // m — radio de entrada de la alimentación (punto de partida del trazador)
  const BOWL_R2 = 0.18;    // m — radio interior de la pared del tazón (== BOWL_WALL_R más abajo)
  const BOWL_N_SWARM = 70; // debe coincidir con N_PARTICLES en scene3d.js (buildBowl)

  // -----------------------------------------------------------------------
  // MOTOR DE TIEMPO — cronómetro de simulación compartido por los 3 equipos.
  // Cada equipo mantiene su propio "reloj de proceso" (simTime) para que
  // cambiar de equipo no mezcle escalas de tiempo distintas; Play/Pausa/
  // Velocidad son globales a la sesión pero el tiempo acumulado es propio
  // de cada pestaña de equipo.
  // -----------------------------------------------------------------------
  const sim = {
    playing: false,
    speed: 2,
    t: { decanter: 0, bowl: 0, pump: 0 },
    // Estado físico que se integra cuadro a cuadro (no solo se recalcula
    // instantáneamente): posición del trazador del bowl, ciclos completados
    // (para la torta acumulada), y omega animada de cada equipo.
    bowlTracer: { r: BOWL_R0, ciclos: 0, cakeFraction: 0, ultimaLlegada: false, swarm: [] },
  };

  // Crea el enjambre de partículas del purificador de tazón: cada una con
  // un D_p ligeramente distinto (±40% del valor del slider) para que se
  // note la física real — las partículas más grandes sedimentan más
  // rápido que las pequeñas, tal como predice u_t ∝ D_p². Todas parten
  // del radio de alimentación r0 y se integran con Engine.drdt igual que
  // el trazador principal, así que solo avanzan mientras hay Play.
  function initBowlSwarm() {
    const swarm = [];
    for (let i = 0; i < BOWL_N_SWARM; i++) {
      const dpFactor = 0.6 + Math.random() * 0.8; // 0.6x .. 1.4x del D_p nominal
      swarm.push({ r: BOWL_R0, dpFactor });
    }
    sim.bowlTracer.swarm = swarm;
  }

  // -----------------------------------------------------------------------
  // Definición de grupos de sliders por equipo
  // -----------------------------------------------------------------------
  function paramGroups(equip) {
    const s = state[equip];
    if (equip === "decanter") {
      return [
        { title: "Accionamiento", params: [
          { key: "rpm", label: "Velocidad de rotación (n)", min: 500, max: 6000, step: 50, decimals: 0, unit: "rpm", accent: ACCENT.heavy, value: s.rpm }
        ]},
        { title: "Geometría de compuertas", params: [
          { key: "rA", label: "Radio compuerta pesada (r_A)", min: 0.08, max: 0.15, step: 0.005, decimals: 3, unit: "m", accent: ACCENT.heavy, value: s.rA },
          { key: "rB", label: "Radio compuerta ligera (r_B)", min: 0.02, max: 0.07, step: 0.005, decimals: 3, unit: "m", accent: ACCENT.light, value: s.rB }
        ]},
        { title: "Propiedades de fluidos", params: [
          { key: "rhoA", label: "Densidad fase pesada (ρ_A)", min: 950, max: 1200, step: 5, decimals: 0, unit: "kg/m³", accent: ACCENT.heavy, value: s.rhoA },
          { key: "rhoB", label: "Densidad fase ligera (ρ_B)", min: 700, max: 950, step: 5, decimals: 0, unit: "kg/m³", accent: ACCENT.light, value: s.rhoB }
        ]}
      ];
    }
    if (equip === "bowl") {
      return [
        { title: "Accionamiento", params: [
          { key: "rpm", label: "Velocidad de rotación (n)", min: 1000, max: 12000, step: 100, decimals: 0, unit: "rpm", accent: ACCENT.heavy, value: s.rpm }
        ]},
        { title: "Sedimentación", params: [
          { key: "r", label: "Radio de evaluación (r)", min: 0.05, max: 0.18, step: 0.005, decimals: 3, unit: "m", accent: ACCENT.light, value: s.r },
          { key: "Dp", label: "Diámetro de partícula (D_p)", min: 1, max: 100, step: 1, decimals: 0, unit: "µm", accent: ACCENT.solids, value: s.Dp },
          { key: "rhoP", label: "Densidad de partícula (ρ_p)", min: 1200, max: 3000, step: 25, decimals: 0, unit: "kg/m³", accent: ACCENT.solids, value: s.rhoP }
        ]},
        { title: "Fluido continuo", params: [
          { key: "rho", label: "Densidad del líquido (ρ)", min: 950, max: 1100, step: 5, decimals: 0, unit: "kg/m³", accent: ACCENT.light, value: s.rho },
          { key: "mu", label: "Viscosidad (μ)", min: 0.0005, max: 0.01, step: 0.0005, decimals: 4, unit: "Pa·s", accent: ACCENT.light, value: s.mu }
        ]},
        { title: "Operación por lote", params: [
          { key: "tProceso", label: "Tiempo de proceso disponible", min: 10, max: 400, step: 5, decimals: 0, unit: "s", accent: ACCENT.green, value: s.tProceso }
        ]}
      ];
    }
    // pump
    return [
      { title: "Velocidad de operación", params: [
        { key: "n", label: `Velocidad actual (n) · ref. ${PUMP_N_REF} rpm`, min: 300, max: 3600, step: 25, decimals: 0, unit: "rpm", accent: ACCENT.heavy, value: s.n }
      ]},
      { title: "Punto de referencia (n_ref)", params: [
        { key: "q1", label: "Capacidad de diseño (q₁)", min: 5, max: 100, step: 1, decimals: 0, unit: "m³/h", accent: ACCENT.light, value: s.q1 },
        { key: "H1", label: "Carga de diseño (ΔH₁)", min: 5, max: 80, step: 1, decimals: 0, unit: "m", accent: ACCENT.light, value: s.H1 },
        { key: "P1", label: "Potencia de diseño (P₁)", min: 0.5, max: 50, step: 0.5, decimals: 1, unit: "kW", accent: ACCENT.heavy, value: s.P1 }
      ]},
      { title: "Impulsor y fluido", params: [
        { key: "r1imp", label: "Radio del ojo (r₁)", min: 0.02, max: 0.08, step: 0.005, decimals: 3, unit: "m", accent: ACCENT.green, value: s.r1imp },
        { key: "r2imp", label: "Radio exterior (r₂)", min: 0.08, max: 0.25, step: 0.005, decimals: 3, unit: "m", accent: ACCENT.heavy, value: s.r2imp },
        { key: "rho", label: "Densidad del fluido (ρ)", min: 700, max: 1200, step: 10, decimals: 0, unit: "kg/m³", accent: ACCENT.light, value: s.rho }
      ]},
      { title: "Succión / NPSH", params: [
        { key: "Pvapor", label: "Presión de vapor (P_v)", min: 500, max: 50000, step: 100, decimals: 0, unit: "Pa", accent: ACCENT.light, value: s.Pvapor },
        { key: "zs", label: "Altura de succión (z_s)", min: -5, max: 5, step: 0.1, decimals: 1, unit: "m", accent: ACCENT.green, value: s.zs },
        { key: "npshReq", label: "NPSH requerido (fabricante)", min: 1, max: 8, step: 0.1, decimals: 1, unit: "m", accent: ACCENT.heavy, value: s.npshReq }
      ]}
    ];
  }

  // -----------------------------------------------------------------------
  // §1. CÁLCULO Y RENDER — DECANTADOR L-L
  //
  // Modelo dinámico: r_i (equilibrio hidrostático) se recalcula al
  // instante con cada cambio de parámetro — es la posición de EQUILIBRIO
  // objetivo. Pero la interfase física NO salta ahí de inmediato: migra
  // suavemente (Engine.relajarZonaNeutra, en Scene3D.stepDecanter, llamado
  // desde stepSimulation() en cada frame mientras el cronómetro corre).
  // Las gráficas 1 (r_i vs t) y 2 (P en pared vs t) son streaming y se
  // alimentan también desde stepSimulation(); aquí solo se fija el
  // objetivo y se refresca todo lo instantáneo (readouts, alerta, chart 3).
  // -----------------------------------------------------------------------
  function computeDecanter() {
    const s = state.decanter;
    const omega = Engine.rpmToOmega(s.rpm);
    const zn = Engine.zonaNeutra({ rhoA: s.rhoA, rhoB: s.rhoB, rA: s.rA, rB: s.rB });
    const totalDP = Engine.presionAnular({ rho: s.rhoA, omega, r1: s.rB, r2: s.rA });

    // Fija el nuevo objetivo de equilibrio; la transición geométrica suave
    // ocurre cuadro a cuadro en Scene3D.stepDecanter() vía stepSimulation()
    Scene3D.updateDecanter(zn, SCALE_R_DECANTER);

    // Chart 3 — sensibilidad de la interfase a la diferencia de densidad
    // (curva de referencia estática: no depende del tiempo, depende de Δρ)
    const sweep = [];
    const rhoBMin = 700, rhoBMax = s.rhoA * 0.999;
    for (let i = 0; i <= 40; i++) {
      const rhoB = rhoBMin + (i / 40) * (rhoBMax - rhoBMin);
      const znS = Engine.zonaNeutra({ rhoA: s.rhoA, rhoB, rA: s.rA, rB: s.rB });
      sweep.push({ diff: znS.diffPorcentual, ri: znS.ri });
    }
    let nearestIdx = 0, nearestDist = Infinity;
    sweep.forEach((p, i) => { const d = Math.abs(p.diff - zn.diffPorcentual); if (d < nearestDist) { nearestDist = d; nearestIdx = i; } });
    const markerData = sweep.map((p, i) => (i === nearestIdx ? p.ri : null));
    Charts.renderThirdChart({
      labels: sweep.map(p => p.diff.toFixed(1)), xLabel: "Δρ (%)", yLabel: "r_i (m)",
      datasets: [
        { label: "r_i(Δρ)", data: sweep.map(p => p.ri), color: Charts.PALETTE.light },
        { label: "Estado actual", data: markerData, color: zn.inestable ? "#E5484D" : Charts.PALETTE.green, point: true }
      ]
    });

    UI.setChartMeta(1, "Migración de la Interfase", "r_i(t) → equilibrio");
    UI.setChartMeta(2, "Presión en Pared vs. Tiempo", "P(r_A, t)");
    UI.setChartMeta(3, "Estabilidad de la Interfase (referencia)", "r_i(Δρ)");

    UI.renderReadouts([
      { label: "Velocidad angular", value: UI.fmt(omega, 1), unit: "rad/s", status: "good" },
      { label: "Radio de interfase r_i (equilibrio)", value: UI.fmt(zn.ri, 4), unit: "m", status: "good" },
      { label: "Diferencia de densidad Δρ", value: UI.fmt(zn.diffPorcentual, 2), unit: "%", status: zn.inestable ? "bad" : "good" },
      { label: "ΔP anular total", value: UI.fmt(totalDP.deltaP / 1000, 2), unit: "kPa", status: "good" }
    ]);

    if (zn.inestable) {
      UI.setAlert("bad", "Operación inestable", "La diferencia de densidades entre fases es menor al 3%: la interfase pierde nitidez y la separación deja de ser efectiva.");
      UI.setStatusLed("bad", "INESTABLE");
    } else {
      UI.setAlert("good", "Operación estable", "La diferencia de densidades es suficiente para una separación efectiva.");
      UI.setStatusLed("good", "ESTABLE");
    }

    UI.setFootEq("Ecuación gobernante — Zona neutra", "r_i² = (ρ_A r_A² + ρ_B r_B²) / (ρ_A + ρ_B)");
    UI.setViewerTitle("Decantador Líquido-Líquido");
    UI.setViewerHud([
      { label: "n", value: `${s.rpm.toFixed(0)} rpm` },
      { label: "r_i → objetivo", value: `${UI.fmt(zn.ri, 3)} m` },
      { label: "Δρ", value: `${UI.fmt(zn.diffPorcentual, 1)} %` }
    ]);
  }

  // -----------------------------------------------------------------------
  // §2. CÁLCULO Y RENDER — PURIFICADOR DE TAZÓN (BOWL)
  // -----------------------------------------------------------------------
  const BOWL_WALL_R = 0.18; // m — radio interior de pared (fijo, referencia visual)

  // Modelo dinámico: la partícula trazadora se integra en tiempo real
  // (Engine.pasoSedimentacion, avanzada desde stepSimulation) desde
  // BOWL_R0 hasta BOWL_R2. Aquí se hace un pre-cálculo INSTANTÁNEO de la
  // trayectoria completa (Engine.trayectoriaSedimentacion) solo para
  // conocer t_residencia_teórico y poder emitir la alerta de "separación
  // incompleta" comparándolo contra el tiempo de proceso disponible — esa
  // integración auxiliar no dibuja nada, es un cálculo de verificación.
  function computeBowl() {
    const s = state.bowl;
    const omega = Engine.rpmToOmega(s.rpm);
    const DpM = s.Dp * 1e-6;
    const ut = Engine.velocidadTerminalStokes({ Dp: DpM, rhoP: s.rhoP, rho: s.rho, omega, r: s.r, mu: s.mu });

    // Tiempo de residencia teórico para SEPARACIÓN COMPLETA de la
    // partícula de diseño (D_p actual) — integración auxiliar, no streaming
    const trayTeorica = Engine.trayectoriaSedimentacion({
      r0: BOWL_R0, Dp: DpM, rhoP: s.rhoP, rho: s.rho, omega, mu: s.mu, r2: BOWL_R2
    });
    sim.bowlTracer.tResidenciaTeorico = trayTeorica.tResidenciaTeorico;
    sim.bowlTracer.convergeTeorico = trayTeorica.convergio;

    // Chart 3 — curva estática de referencia u_t vs D_p (útil junto a la
    // gráfica evolutiva de concentración; permite ubicar visualmente si el
    // D_p actual sedimenta rápido o lento respecto al resto de tamaños)
    const curvaUt = Engine.curvaUtVsDp({ rhoP: s.rhoP, rho: s.rho, omega, r: s.r, mu: s.mu, DpMin: 1e-6, DpMax: 100e-6, nPuntos: 40 });
    const markerData = curvaUt.map(p => (Math.abs(p.Dp - DpM) < (100e-6 / 40) ? p.ut * 1000 : null));

    UI.setChartMeta(1, "Posición Radial de Partícula", "r(t), trazador");
    UI.setChartMeta(2, "Velocidad Radial vs. Tiempo", "dr/dt (t)");
    UI.setChartMeta(3, "Concentración Acumulada en Pared", "torta(t)");

    const regimen = ut.regimenValido;
    const tDisp = s.tProceso;
    const tReq = trayTeorica.tResidenciaTeorico;
    const separacionIncompleta = trayTeorica.convergio && tReq > tDisp;

    UI.renderReadouts([
      { label: "Velocidad angular", value: UI.fmt(omega, 1), unit: "rad/s", status: "good" },
      { label: "Velocidad terminal u_t (inicial)", value: UI.fmt(ut.ut * 1000, 3), unit: "mm/s", status: "good" },
      { label: "Reynolds de partícula", value: UI.fmt(ut.Rep, 4), unit: "", status: regimen ? "good" : "warn" },
      { label: "t. residencia requerido", value: trayTeorica.convergio ? UI.fmt(tReq, 1) : "—", unit: "s", status: separacionIncompleta ? "bad" : "good" }
    ]);

    if (!regimen) {
      UI.setAlert("warn", "Régimen fuera de Stokes", "Re_p ≥ 1: la ley de Stokes ya no describe con precisión la sedimentación de esta partícula; reduzca D_p o la velocidad, o use un modelo intermedio/Newton.");
      UI.setStatusLed("warn", "FUERA DE STOKES");
    } else if (separacionIncompleta) {
      UI.setAlert("bad", "Separación incompleta: partículas presentes en el efluente", `El tiempo de residencia requerido (${UI.fmt(tReq, 1)} s) supera el tiempo de proceso disponible (${tDisp.toFixed(0)} s): la partícula no alcanza la pared antes de salir del equipo.`);
      UI.setStatusLed("bad", "SEPARACIÓN INCOMPLETA");
    } else if (!trayTeorica.convergio) {
      UI.setAlert("warn", "Sedimentación despreciable", "La velocidad de asentamiento es prácticamente nula con estos parámetros (ρ_p ≈ ρ o D_p muy pequeño): la partícula no converge a la pared en un tiempo razonable.");
      UI.setStatusLed("warn", "SIN SEDIMENTACIÓN");
    } else {
      UI.setAlert("good", "Sedimentación en régimen de Stokes", `El número de Reynolds de partícula es menor a 1 y la partícula alcanza la pared en ${UI.fmt(tReq, 1)} s, dentro del tiempo de proceso disponible.`);
      UI.setStatusLed("good", "ESTABLE");
    }

    UI.setFootEq("Ecuación gobernante — Sedimentación centrífuga (ODE)", "dr/dt = ω² r D_p²(ρ_p−ρ) / 18μ");
    UI.setViewerTitle("Purificador de Tazón");
    UI.setViewerHud([
      { label: "n", value: `${s.rpm.toFixed(0)} rpm` },
      { label: "u_t (inicial)", value: `${UI.fmt(ut.ut * 1000, 2)} mm/s` },
      { label: "Re_p", value: UI.fmt(ut.Rep, 3) }
    ]);
  }

  // -----------------------------------------------------------------------
  // §3. CÁLCULO Y RENDER — BOMBA CENTRÍFUGA
  // -----------------------------------------------------------------------
  // Modelo dinámico: al fijar/ajustar n, se define un nuevo objetivo de ω;
  // el arranque real (ω animada aproximándose a ese objetivo) lo resuelve
  // Scene3D.stepPump() en cada frame. Charts 1 y 2 (ω(t) y P(pared,t))
  // se alimentan desde stepSimulation con la ω ANIMADA (real, de arranque),
  // no la de régimen permanente — así se ve crecer la presión junto con
  // la velocidad, tal como pide el enunciado.
  function computePump() {
    const s = state.pump;
    const omega = Engine.rpmToOmega(s.n);

    // Objetivo de arranque — Scene3D.stepPump() relajará omegaAnimada hacia esto
    Scene3D.updatePumpTarget(omega);

    const afin = Engine.leyesAfinidad({ q1: s.q1, H1: s.H1, P1: s.P1, n1: PUMP_N_REF, n2: s.n });
    const npshDisp = Engine.npshDisponible({ Pvapor: s.Pvapor, rho: s.rho, zs: s.zs, hf: 0 });
    const cav = Engine.evaluarCavitacion({ npshDisp, npshReq: s.npshReq });

    UI.setChartMeta(1, "Velocidad Angular — Arranque", "ω(t) → ω_reg");
    UI.setChartMeta(2, "Presión en Pared vs. Tiempo", "P(r₂, t)");
    UI.setChartMeta(3, "Curva Característica", `H(q) @ n animado`);

    UI.renderReadouts([
      { label: "Velocidad angular objetivo", value: UI.fmt(omega, 1), unit: "rad/s", status: "good" },
      { label: "Capacidad q₂ (régimen)", value: UI.fmt(afin.q2, 1), unit: "m³/h", status: "good" },
      { label: "Carga ΔH₂ (régimen)", value: UI.fmt(afin.H2, 2), unit: "m", status: "good" },
      { label: "Potencia P₂ (régimen)", value: UI.fmt(afin.P2, 2), unit: "kW", status: "good" },
      { label: "NPSH disponible", value: UI.fmt(npshDisp, 2), unit: "m", status: cav.estado === "segura" ? "good" : cav.estado === "riesgo" ? "warn" : "bad" },
      { label: "Margen de cavitación", value: UI.fmt(cav.margen, 2), unit: "m", status: cav.estado === "segura" ? "good" : cav.estado === "riesgo" ? "warn" : "bad" }
    ]);

    if (cav.estado === "cavitacion") {
      UI.setAlert("bad", "Riesgo de cavitación: NPSH insuficiente", "El NPSH disponible es menor al requerido: la presión de succión cae por debajo de la presión de vapor y se forman burbujas de vapor que dañan el impulsor.");
      UI.setStatusLed("bad", "CAVITACIÓN");
    } else if (cav.estado === "riesgo") {
      UI.setAlert("warn", "Riesgo de cavitación: NPSH insuficiente", "El margen de NPSH es menor al margen de seguridad recomendado (0.5 m). Considere reducir z_s negativo, aumentar presión de succión o reducir n.");
      UI.setStatusLed("warn", "RIESGO NPSH");
    } else {
      UI.setAlert("good", "Succión segura", "El NPSH disponible supera con margen suficiente al NPSH requerido por el fabricante.");
      UI.setStatusLed("good", "ESTABLE");
    }

    UI.setFootEq("Ecuación gobernante — Leyes de afinidad", "q₂/q₁=n₂/n₁ · ΔH₂/ΔH₁=(n₂/n₁)² · P₂/P₁=(n₂/n₁)³");
    UI.setViewerTitle("Bomba Centrífuga (Corte Transversal)");
    UI.setViewerHud([
      { label: "n → objetivo", value: `${s.n.toFixed(0)} rpm` },
      { label: "ΔH (régimen)", value: `${UI.fmt(afin.H2, 1)} m` },
      { label: "NPSH", value: `${UI.fmt(npshDisp, 1)} m` }
    ]);
  }

  const COMPUTE = { decanter: computeDecanter, bowl: computeBowl, pump: computePump };

  function recompute() {
    COMPUTE[currentEquip]();
  }

  // =========================================================================
  // MOTOR DE SIMULACIÓN — avanza cuadro a cuadro solo el equipo activo,
  // solo mientras sim.playing es true, con dt escalado por sim.speed.
  // Se registra como frameCallback de Scene3D (llamado desde su propio
  // requestAnimationFrame, con el dt real ya acotado a 0.1 s máx).
  // =========================================================================
  function stepSimulation(dtReal) {
    if (!sim.playing) return;
    const dtSim = dtReal * sim.speed;
    sim.t[currentEquip] += dtSim;
    UI.setSimTime(sim.t[currentEquip]);

    if (currentEquip === "decanter") stepDecanterSim(dtSim);
    else if (currentEquip === "bowl") stepBowlSim(dtSim);
    else if (currentEquip === "pump") stepPumpSim(dtSim);
  }

  function stepDecanterSim(dtSim) {
    const s = state.decanter;
    const omega = Engine.rpmToOmega(s.rpm);

    Scene3D.stepDecanter(dtSim);
    const d = Scene3D.dynamic.decanter;
    if (!d || Number.isNaN(d.riAnimado)) return;
    const riReal = d.riAnimado / SCALE_R_DECANTER;

    // Chart 1 — r_i(t): migración de la interfase hacia el equilibrio
    Charts.pushStreamPoint(Charts.chart1, sim.t.decanter,
      [{ label: "r_i(t)", color: Charts.PALETTE.light, value: riReal }], "t (s)", "r_i (m)");

    // Chart 2 — P(r_A, t): la presión en la pared cambia mientras r_i migra
    const dp = Engine.presionAnular({ rho: s.rhoA, omega, r1: riReal, r2: s.rA });
    Charts.pushStreamPoint(Charts.chart2, sim.t.decanter,
      [{ label: "P(r_A)", color: Charts.PALETTE.heavy, value: dp.deltaP / 1000 }], "t (s)", "P (kPa)");

    const zn = Engine.zonaNeutra({ rhoA: s.rhoA, rhoB: s.rhoB, rA: s.rA, rB: s.rB });
    const errorRel = zn.valido ? Math.abs(riReal - zn.ri) / (zn.ri || 1) : 0;
    const fraccion = Math.min(Math.max(1 - errorRel / 0.02, 0), 1); // ≈ converge cuando el error es < 2%
    UI.setSimProgress(fraccion, fraccion >= 0.98 ? "Interfase en equilibrio" : `Migrando hacia el equilibrio · r_i = ${riReal.toFixed(4)} m`);
    UI.setViewerHud([
      { label: "n", value: `${s.rpm.toFixed(0)} rpm` },
      { label: "r_i(t)", value: `${riReal.toFixed(3)} m` },
      { label: "Δρ", value: `${UI.fmt(zn.diffPorcentual, 1)} %` }
    ]);
  }

  function stepBowlSim(dtSim) {
    const s = state.bowl;
    const omega = Engine.rpmToOmega(s.rpm);
    const DpM = s.Dp * 1e-6;
    const bt = sim.bowlTracer;

    const paso = Engine.pasoSedimentacion({ r: bt.r, Dp: DpM, rhoP: s.rhoP, rho: s.rho, omega, mu: s.mu, dt: dtSim, r2: BOWL_R2 });
    bt.r = paso.r;

    if (paso.llegoAPared) {
      bt.ciclos += 1;
      // Modelo de acumulación asintótica de torta: cada ciclo completado
      // (una "carga" de sólidos que alcanza la pared) aporta una fracción
      // decreciente de espacio libre restante — satura suavemente hacia 1,
      // representando que la capacidad de acumulación de la pared es finita.
      bt.cakeFraction = 1 - Math.exp(-bt.ciclos / 6);
      bt.r = BOWL_R0; // recicla el trazador: nueva partícula entra por el centro
    }

    const rScene = bt.r * SCALE_R_BOWL;
    Scene3D.setBowlTracerRadius(rScene, dtSim);
    Scene3D.setBowlCake(bt.cakeFraction);

    // Enjambre de sedimentación — misma física (Engine.drdt), un radio
    // propio por partícula, D_p escalado por su dpFactor individual.
    // Solo avanza aquí, dentro de stepBowlSim, que main.js únicamente
    // invoca mientras sim.playing está activo: así el asentamiento visual
    // queda atado al cronómetro real (Play/Pausa/Velocidad).
    const radiiScene = bt.swarm.map((p) => {
      const v = Engine.drdt({ r: p.r, Dp: DpM * p.dpFactor, rhoP: s.rhoP, rho: s.rho, omega, mu: s.mu });
      p.r = Math.min(p.r + v * dtSim, BOWL_R2);
      if (p.r >= BOWL_R2 - 1e-9) p.r = BOWL_R0; // recicla: nueva partícula entra por el centro
      return p.r * SCALE_R_BOWL;
    });
    Scene3D.setBowlSwarm(radiiScene);

    // Chart 1 — r(t) del trazador
    Charts.pushStreamPoint(Charts.chart1, sim.t.bowl,
      [{ label: "r(t)", color: Charts.PALETTE.light, value: bt.r }], "t (s)", "r (m)");

    // Chart 2 — velocidad radial instantánea dr/dt (mm/s) — se acelera con r
    const v = Engine.drdt({ r: bt.r, Dp: DpM, rhoP: s.rhoP, rho: s.rho, omega, mu: s.mu });
    Charts.pushStreamPoint(Charts.chart2, sim.t.bowl,
      [{ label: "dr/dt", color: Charts.PALETTE.heavy, value: v * 1000 }], "t (s)", "dr/dt (mm/s)");

    // Chart 3 — concentración acumulada en pared (fracción de torta)
    Charts.pushStreamPoint(Charts.chart3, sim.t.bowl,
      [{ label: "Torta acumulada", color: Charts.PALETTE.green, value: bt.cakeFraction }], "t (s)", "fracción");

    const fraccion = bt.r / BOWL_R2;
    UI.setSimProgress(fraccion, `${(fraccion * 100).toFixed(0)}% hacia la pared · ${bt.ciclos} ciclo(s) completado(s)`);
    UI.setViewerHud([
      { label: "n", value: `${s.rpm.toFixed(0)} rpm` },
      { label: "r(t)", value: `${(bt.r * 1000).toFixed(1)} mm` },
      { label: "dr/dt", value: `${UI.fmt(v * 1000, 2)} mm/s` }
    ]);
  }

  function stepPumpSim(dtSim) {
    const s = state.pump;
    const omegaAnimada = Scene3D.stepPump(dtSim);
    if (omegaAnimada === null || Number.isNaN(omegaAnimada)) return;
    const nAnimada = Engine.omegaToRpm(omegaAnimada);

    // Chart 1 — ω(t) durante el arranque
    Charts.pushStreamPoint(Charts.chart1, sim.t.pump,
      [{ label: "ω(t)", color: Charts.PALETTE.heavy, value: omegaAnimada }], "t (s)", "ω (rad/s)");

    // Chart 2 — P(pared del impulsor) vs t, mientras ω se estabiliza
    const dpImp = Engine.presionAnular({ rho: s.rho, omega: omegaAnimada, r1: s.r1imp, r2: s.r2imp });
    Charts.pushStreamPoint(Charts.chart2, sim.t.pump,
      [{ label: "P(r₂)", color: Charts.PALETTE.light, value: dpImp.deltaP / 1000 }], "t (s)", "P (kPa)");

    // Chart 3 — curva característica H(q), recalculada en vivo con n animada
    // (se ve crecer/encoger conforme la bomba arranca hacia su régimen)
    const H0 = s.H1 * 1.25, qMax = s.q1 * 2.0;
    const curva = Engine.curvaCaracteristicaReescalada({ H0, qMax, n1: PUMP_N_REF, n2: nAnimada, nPuntos: 40 });
    Charts.renderThirdChart({
      labels: curva.puntos.map(p => p.q.toFixed(1)), xLabel: "q (m³/h)", yLabel: "H (m)",
      datasets: [{ label: `H(q) @ ${nAnimada.toFixed(0)} rpm`, data: curva.puntos.map(p => p.H), color: Charts.PALETTE.light }]
    });

    const afinAnimada = Engine.leyesAfinidad({ q1: s.q1, H1: s.H1, P1: s.P1, n1: PUMP_N_REF, n2: nAnimada });
    const fraccion = s.n > 0 ? Math.min(nAnimada / s.n, 1) : 1;
    UI.setSimProgress(fraccion, fraccion >= 0.98 ? "Régimen permanente alcanzado" : `Arrancando · ${nAnimada.toFixed(0)} / ${s.n.toFixed(0)} rpm`);
    UI.setViewerHud([
      { label: "n(t)", value: `${nAnimada.toFixed(0)} rpm` },
      { label: "ΔH(t)", value: `${UI.fmt(afinAnimada.H2, 1)} m` },
      { label: "P(r₂,t)", value: `${UI.fmt(dpImp.deltaP / 1000, 1)} kPa` }
    ]);
  }

  // Reinicia el cronómetro y el estado físico integrado del equipo activo
  // (no afecta a los otros equipos, cada uno lleva su propio reloj/estado)
  function resetSimulation() {
    sim.t[currentEquip] = 0;
    UI.setSimTime(0);
    Charts.resetAllStreams();

    if (currentEquip === "bowl") {
      sim.bowlTracer.r = BOWL_R0;
      sim.bowlTracer.ciclos = 0;
      sim.bowlTracer.cakeFraction = 0;
      initBowlSwarm();
      Scene3D.resetBowlTracer();
      Scene3D.resetBowlSwarm();
      UI.setSimProgress(0, "0% hacia la pared");
    } else if (currentEquip === "pump") {
      const d = Scene3D.dynamic.pump;
      if (d) d.omegaAnimada = 0; // el motor arranca desde reposo en el próximo Play
      UI.setSimProgress(0, "Detenida · 0 rpm");
    } else if (currentEquip === "decanter") {
      UI.setSimProgress(0, "—");
    }
    recompute();
  }

  // -----------------------------------------------------------------------
  // Cambio de equipo activo
  // -----------------------------------------------------------------------
  let currentEquip = "decanter";

  function switchEquip(name) {
    currentEquip = name;
    document.querySelectorAll(".equip-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.equip === name);
    });
    Scene3D.setEquip(name);
    UI.renderParams(paramGroups(name), (key, value) => {
      state[name][key] = value;
      recompute();
    });
    Charts.resetAllStreams();
    UI.setSimTime(sim.t[name]);
    UI.setSimProgress(0, "—");
    recompute();
  }

  // -----------------------------------------------------------------------
  // Arranque de la aplicación
  // -----------------------------------------------------------------------
  function init() {
    Charts.init();
    Scene3D.init(document.getElementById("viewer3d"));

    // Conecta el cronómetro de simulación al loop de render de Scene3D:
    // cada frame (dt real ya acotado a 0.1s) invoca stepSimulation(), que
    // solo avanza la física del equipo activo mientras sim.playing es true.
    Scene3D.setFrameCallback(stepSimulation);

    document.getElementById("equipSelect").addEventListener("click", (e) => {
      const btn = e.target.closest(".equip-tab");
      if (!btn) return;
      switchEquip(btn.dataset.equip);
    });

    document.getElementById("btnReset").addEventListener("click", () => Scene3D.resetCamera());

    const btnSpin = document.getElementById("btnSpin");
    btnSpin.classList.add("active");
    btnSpin.addEventListener("click", () => {
      const active = btnSpin.classList.toggle("active");
      Scene3D.setSpinning(active);
    });

    // Selector de vista — Industrial (carcasa cerrada, aspecto real de
    // planta) vs. Interior (carcasa traslúcida, ve el proceso por dentro)
    document.getElementById("viewModeGroup").addEventListener("click", (e) => {
      const btn = e.target.closest(".view-mode-btn");
      if (!btn) return;
      const mode = btn.dataset.mode;
      Scene3D.setViewMode(mode);
      document.querySelectorAll(".view-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    });
    Scene3D.setViewMode("interior");

    window.addEventListener("resize", () => Scene3D.resize());

    // Transporte del cronómetro — Play / Pausa / Reiniciar
    document.getElementById("simPlay").addEventListener("click", () => {
      sim.playing = true;
      UI.setPlayingState(true);
    });
    document.getElementById("simPause").addEventListener("click", () => {
      sim.playing = false;
      UI.setPlayingState(false);
    });
    document.getElementById("simReset").addEventListener("click", () => {
      resetSimulation();
    });

    // Selector de velocidad (1x / 2x / 5x / 20x)
    document.getElementById("simSpeedGroup").addEventListener("click", (e) => {
      const btn = e.target.closest(".speed-btn");
      if (!btn) return;
      sim.speed = parseFloat(btn.dataset.speed);
      UI.setSpeedActive(sim.speed);
    });

    // Estado inicial del transporte: en pausa, 2x (coincide con el HTML)
    UI.setPlayingState(sim.playing);
    UI.setSpeedActive(sim.speed);

    initBowlSwarm();
    switchEquip("decanter");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
