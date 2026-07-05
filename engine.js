/* =========================================================================
   ENGINE.JS — Motor Matemático de Operaciones Unitarias de Centrifugación
   Basado en McCabe, Smith & Harriott — Unit Operations of Chemical Engineering
   Capítulo: Centrifugal Separations / Mechanical Separations
   =========================================================================
   Todas las funciones son puras (sin efectos secundarios) y devuelven
   objetos con unidades explícitas en las claves para trazabilidad durante
   la sustentación oral.
   ========================================================================= */

const Engine = (() => {

  // -----------------------------------------------------------------------
  // Utilidades de conversión
  // -----------------------------------------------------------------------
  const rpmToOmega = (rpm) => (2 * Math.PI * rpm) / 60;      // rad/s
  const omegaToRpm = (omega) => (omega * 60) / (2 * Math.PI); // rpm

  // -----------------------------------------------------------------------
  // §1. DISTRIBUCIÓN DE PRESIÓN EN ESPACIO ANULAR ROTATORIO
  //     P2 - P1 = (ρ ω² / 2)(r2² - r1²)          [McCabe & Smith, Ec. 24.2]
  //
  //     Se deriva de un balance de fuerzas centrífugas sobre un elemento
  //     de fluido en rotación de cuerpo rígido, análogo a la presión
  //     hidrostática pero sustituyendo "g" por la aceleración centrípeta
  //     local ω²r. Como ω²r no es constante con r, se integra:
  //         dP/dr = ρ ω² r   →   ∫dP = ρω² ∫r dr  de r1 a r2
  // -----------------------------------------------------------------------
  function presionAnular({ rho, omega, r1, r2, P1 = 0 }) {
    const deltaP = (rho * omega * omega * (r2 * r2 - r1 * r1)) / 2;
    const P2 = P1 + deltaP;
    return { deltaP, P2, P1 };
  }

  // Perfil continuo P(r) para graficar la parábola de presión radial
  function perfilPresionRadial({ rho, omega, r1, r2, P1 = 0, nPuntos = 60 }) {
    const puntos = [];
    for (let i = 0; i <= nPuntos; i++) {
      const r = r1 + (i / nPuntos) * (r2 - r1);
      const P = P1 + (rho * omega * omega * (r * r - r1 * r1)) / 2;
      puntos.push({ r, P });
    }
    return puntos;
  }

  // -----------------------------------------------------------------------
  // §2. RADIO DE LA ZONA NEUTRA (INTERFASE) EN DECANTADOR CENTRÍFUGO L-L
  //     McCabe, Smith & Harriott — Unit Operations of Chemical Engineering,
  //     Cap. 24 "Centrifugal Separations" (Ec. 24.7):
  //
  //       r_i² = ( ρ_A r_A² + ρ_B r_B² ) / ( ρ_A + ρ_B )
  //
  //     donde:
  //       A = líquido PESADO (mayor densidad), descarga por su compuerta
  //           de rebose en radio r_A (radio MAYOR, cercano a la pared)
  //       B = líquido LIGERO (menor densidad), descarga por su compuerta
  //           de rebose en radio r_B (radio MENOR, cercano al eje)
  //       r_i = radio de la interfase (zona neutra), rB < r_i < rA
  //
  //     DERIVACIÓN (balance de presión, ambas compuertas a P_atm):
  //       P_atm = P_i + (ρ_A ω²/2)(r_A² − r_i²)   [columna pesada, r_i→r_A]
  //       P_atm = P_i + (ρ_B ω²/2)(r_i² − r_B²)   [columna ligera, r_B→r_i]
  //     Igualando ambas expresiones y despejando r_i² se obtiene la forma
  //     con SUMA en numerador y denominador mostrada arriba.
  //
  //     NOTA TÉCNICA PARA SUSTENTACIÓN: esta forma (con suma) es la
  //     algebraicamente estable: en el límite ρ_A→ρ_B (mezcla de igual
  //     densidad, precisamente el caso "operación inestable" que se
  //     alerta con <3% de diferencia) el resultado permanece finito y
  //     tiende al promedio ponderado de r_A y r_B, tal como exige la
  //     física. Una forma equivalente con RESTA en el denominador
  //     (1 − ρ_B/ρ_A) —variante algebraica que circula en apuntes
  //     derivados— posee una singularidad exactamente en ρ_A=ρ_B y por
  //     tanto no es utilizable cerca de la zona de operación crítica que
  //     este simulador debe representar; se usa aquí la forma con suma
  //     por ser la numéricamente robusta en todo el dominio físico.
  // -----------------------------------------------------------------------
  function zonaNeutra({ rhoA, rhoB, rA, rB }) {
    const numerador = rhoA * rA * rA + rhoB * rB * rB;
    const denominador = rhoA + rhoB;
    const ri2 = numerador / denominador;

    const valido = ri2 > 0 && rA > rB; // exige geometría física: rA (pesada) > rB (ligera)
    const ri = valido ? Math.sqrt(ri2) : NaN;

    // Diferencia porcentual de densidades — criterio de estabilidad operativa
    const diffPorcentual = (Math.abs(rhoA - rhoB) / rhoA) * 100;
    const inestable = diffPorcentual < 3;

    // Posición relativa de la interfase dentro del anillo [rB, rA]
    // 0 = pegada al eje (lado ligero, rB), 1 = pegada a la pared (lado pesado, rA)
    const posicionRelativa = valido ? (ri - rB) / (rA - rB) : NaN;

    return {
      ri, ri2, diffPorcentual, inestable, valido,
      posicionRelativa,
      rA, rB, rhoA, rhoB
    };
  }

  // -----------------------------------------------------------------------
  // §3. VELOCIDAD TERMINAL CENTRÍFUGA — RÉGIMEN DE STOKES
  //     McCabe & Smith, Ec. 24.14:
  //
  //       u_t = D_p² (ρ_p − ρ) ω² r / (18 μ)
  //
  //     Análoga a la ley de Stokes gravitacional, sustituyendo "g" por la
  //     aceleración centrífuga local ω²r. Válida para Re_p < 1
  //     (flujo reptante alrededor de la partícula).
  // -----------------------------------------------------------------------
  function velocidadTerminalStokes({ Dp, rhoP, rho, omega, r, mu }) {
    const ut = (Dp * Dp * (rhoP - rho) * omega * omega * r) / (18 * mu);

    // Número de Reynolds de partícula para verificar régimen de Stokes
    const Rep = (rho * Math.abs(ut) * Dp) / mu;
    const regimenValido = Rep < 1;

    // Factor de separación centrífugo (Σ conceptual simplificado): ω²r/g
    const factorSeparacion = (omega * omega * r) / 9.81;

    return { ut, Rep, regimenValido, factorSeparacion };
  }

  // Curva ut vs Dp (barrido de diámetro de partícula) — útil para mostrar
  // sensibilidad de separación a tamaño de partícula
  function curvaUtVsDp({ rhoP, rho, omega, r, mu, DpMin, DpMax, nPuntos = 40 }) {
    const puntos = [];
    for (let i = 0; i <= nPuntos; i++) {
      const Dp = DpMin + (i / nPuntos) * (DpMax - DpMin);
      const { ut } = velocidadTerminalStokes({ Dp, rhoP, rho, omega, r, mu });
      puntos.push({ Dp, ut });
    }
    return puntos;
  }

  // -----------------------------------------------------------------------
  // §4. LEYES DE AFINIDAD PARA BOMBAS CENTRÍFUGAS
  //     McCabe & Smith, Ec. 8.36a-c (bombas geométricamente similares,
  //     mismo diámetro de impulsor, variando solo n):
  //
  //       q2/q1  = n2/n1            (capacidad ∝ n)
  //       ΔH2/ΔH1 = (n2/n1)²        (carga ∝ n²)
  //       P2/P1  = (n2/n1)³         (potencia ∝ n³)
  // -----------------------------------------------------------------------
  function leyesAfinidad({ q1, H1, P1, n1, n2 }) {
    const ratio = n2 / n1;
    const q2 = q1 * ratio;
    const H2 = H1 * Math.pow(ratio, 2);
    const P2 = P1 * Math.pow(ratio, 3);
    return { q2, H2, P2, ratio };
  }

  // Curva de potencia P(n) normalizada respecto a un punto de referencia,
  // para graficar P ∝ n³
  function curvaPotenciaVsN({ n1, P1, nMin, nMax, nPuntos = 50 }) {
    const puntos = [];
    for (let i = 0; i <= nPuntos; i++) {
      const n = nMin + (i / nPuntos) * (nMax - nMin);
      const P = P1 * Math.pow(n / n1, 3);
      puntos.push({ n, P });
    }
    return puntos;
  }

  // -----------------------------------------------------------------------
  // §5. CURVA CARACTERÍSTICA DE LA BOMBA H(q)
  //     Modelo de curva de sistema tipo:  H = H0 − K·q²
  //     (forma estándar usada junto a las leyes de afinidad de McCabe &
  //     Smith para representar la curva característica H vs. q a n fijo,
  //     donde H0 es la carga a flujo cero (shut-off head) y K un
  //     coeficiente de forma del impulsor).
  // -----------------------------------------------------------------------
  function curvaCaracteristicaBomba({ H0, qMax, nPuntos = 50 }) {
    const K = H0 / (qMax * qMax); // fuerza H(qMax) ≈ 0
    const puntos = [];
    for (let i = 0; i <= nPuntos; i++) {
      const q = (i / nPuntos) * qMax;
      const H = Math.max(0, H0 - K * q * q);
      puntos.push({ q, H });
    }
    return { puntos, K };
  }

  // Punto de operación reescalado por leyes de afinidad (para superponer
  // la curva a nueva velocidad n2, usando la ley de semejanza de parábolas
  // de sistema: los puntos homólogos siguen H∝n², q∝n)
  function curvaCaracteristicaReescalada({ H0, qMax, n1, n2, nPuntos = 50 }) {
    const ratio = n2 / n1;
    return curvaCaracteristicaBomba({ H0: H0 * ratio * ratio, qMax: qMax * ratio, nPuntos });
  }

  // -----------------------------------------------------------------------
  // §6. NPSH DISPONIBLE Y RIESGO DE CAVITACIÓN
  //     NPSH_disp = (P_succión − P_vapor) / (ρ g) + z_succión − h_f,succión
  //     Forma simplificada usada aquí (succión inundada, sin pérdidas
  //     friccionales explícitas — se deja hf como término aparte opcional):
  //
  //       NPSH_disp = (P_atm − P_vapor)/(ρg) + z_s − hf
  //
  //     Riesgo de cavitación si NPSH_disp se aproxima o cae por debajo del
  //     NPSH_requerido (dato de fabricante, aquí parametrizable).
  // -----------------------------------------------------------------------
  function npshDisponible({ Patm = 101325, Pvapor, rho, zs = 0, hf = 0 }) {
    const g = 9.81;
    const npsh = (Patm - Pvapor) / (rho * g) + zs - hf;
    return npsh;
  }

  function evaluarCavitacion({ npshDisp, npshReq, margenSeguro = 0.5 }) {
    const margen = npshDisp - npshReq;
    let estado = "segura";
    if (margen < 0) estado = "cavitacion";
    else if (margen < margenSeguro) estado = "riesgo";
    return { margen, estado };
  }

  // -----------------------------------------------------------------------
  // §7. INTEGRACIÓN TEMPORAL — SEDIMENTACIÓN EN EL PURIFICADOR DE TAZÓN
  //     dr/dt = ω² r D_p² (ρ_p − ρ) / (18 μ)         [McCabe & Smith, Ec. 24.14
  //     reescrita como ODE radial]
  //
  //     Esta es la misma ley de Stokes centrífuga de §3, pero en vez de
  //     evaluarla en un único radio r, se integra paso a paso (Euler
  //     explícito, dt pequeño) para obtener la trayectoria r(t) completa
  //     de una partícula que parte de r0 y avanza hasta la pared r2.
  //     Esto es lo que el libro describe como "tiempo de residencia
  //     requerido para la sedimentación completa" (t_r).
  // -----------------------------------------------------------------------
  function drdt({ r, Dp, rhoP, rho, omega, mu }) {
    return (omega * omega * r * Dp * Dp * (rhoP - rho)) / (18 * mu);
  }

  // Avanza un paso de Euler explícito. Devuelve el nuevo radio (clamp a r2).
  function pasoSedimentacion({ r, Dp, rhoP, rho, omega, mu, dt, r2 }) {
    const v = drdt({ r, Dp, rhoP, rho, omega, mu });
    const rNew = Math.min(r + v * dt, r2);
    return { r: rNew, v, llegoAPared: rNew >= r2 - 1e-9 };
  }

  // Integra la trayectoria completa r(t) de r0 a r2 (para precalcular
  // tiempo de residencia teórico y para dibujar la curva r vs t completa).
  // Se integra en tiempo real de proceso (segundos), no en tiempo de escena.
  function trayectoriaSedimentacion({ r0, Dp, rhoP, rho, omega, mu, r2, dtIntegracion = 0.01, tMax = 600 }) {
    const puntos = [{ t: 0, r: r0 }];
    let r = r0, t = 0;
    let llego = false;
    while (t < tMax) {
      const v = drdt({ r, Dp, rhoP, rho, omega, mu });
      if (v <= 1e-12) break; // partícula estancada (rhoP <= rho, o r=0): no habrá convergencia
      r = Math.min(r + v * dtIntegracion, r2);
      t += dtIntegracion;
      puntos.push({ t, r });
      if (r >= r2 - 1e-9) { llego = true; break; }
    }
    return { puntos, tResidenciaTeorico: llego ? t : NaN, convergio: llego };
  }

  // -----------------------------------------------------------------------
  // §8. RELAJACIÓN TEMPORAL DE LA ZONA NEUTRA (DECANTADOR)
  //     El libro modela r_i como un equilibrio hidrostático instantáneo;
  //     aquí se añade una dinámica de primer orden (sistema sobreamortiguado
  //     tipo tanque-nivel) para visualizar la transición física real cuando
  //     el operador cambia rA, rB o las densidades: la interfase no salta,
  //     migra suavemente hacia el nuevo equilibrio.
  //         dr_i/dt = (r_i,objetivo − r_i,actual) / τ
  //     τ (constante de tiempo) se fija con base en la inercia del volumen
  //     anular de líquido a reacomodar; no es un dato del libro, es un
  //     artificio de suavizado numéricamente estable y físicamente
  //     razonable para fines de visualización.
  // -----------------------------------------------------------------------
  function relajarZonaNeutra({ riActual, riObjetivo, dt, tau = 0.6 }) {
    if (Number.isNaN(riActual)) return riObjetivo;
    const riNuevo = riActual + (riObjetivo - riActual) * Math.min(dt / tau, 1);
    return riNuevo;
  }

  // -----------------------------------------------------------------------
  // §9. ARRANQUE DE LA BOMBA — ESTABILIZACIÓN DE ω Y P(pared) EN EL TIEMPO
  //     Modelo de arranque de primer orden para el motor/impulsor
  //     (análogo a la respuesta típica de un accionamiento con controlador
  //     de velocidad): ω(t) se aproxima exponencialmente a ω_objetivo.
  //         dω/dt = (ω_objetivo − ω_actual) / τ_arranque
  //     Con ω(t) real se recalcula P(pared) en cada instante usando la
  //     ecuación de presión anular de §1, mostrando cómo la presión de
  //     descarga crece junto con la velocidad hasta el régimen permanente.
  // -----------------------------------------------------------------------
  function relajarOmega({ omegaActual, omegaObjetivo, dt, tauArranque = 1.2 }) {
    if (Number.isNaN(omegaActual)) return omegaObjetivo;
    return omegaActual + (omegaObjetivo - omegaActual) * Math.min(dt / tauArranque, 1);
  }

  // -----------------------------------------------------------------------
  // Exponer API pública del motor
  // -----------------------------------------------------------------------
  return {
    rpmToOmega, omegaToRpm,
    presionAnular, perfilPresionRadial,
    zonaNeutra,
    velocidadTerminalStokes, curvaUtVsDp,
    leyesAfinidad, curvaPotenciaVsN,
    curvaCaracteristicaBomba, curvaCaracteristicaReescalada,
    npshDisponible, evaluarCavitacion,
    drdt, pasoSedimentacion, trayectoriaSedimentacion,
    relajarZonaNeutra, relajarOmega
  };

})();

