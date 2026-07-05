/* =========================================================================
   AR.JS — Modo de Realidad Aumentada BASADO EN MARCADOR (AR.js / THREEx)
   ---------------------------------------------------------------------
   Migración desde WebXR (hit-test, sin marcador) a AR.js clásico con
   marcador impreso "Hiro". Motivo del cambio: WebXR "immersive-ar" solo
   existe en Chrome/Edge para Android con ARCore — deja fuera iPhone/iPad
   por completo y cualquier Android sin Google Play Services for AR. AR.js
   funciona con getUserMedia (cámara) puro, así que corre en Safari de
   iOS, Chrome/Firefox/Samsung Internet de Android, sin depender de
   ARCore ni ARKit.

   Librería usada: THREEx (AR.js three.js build, vendorizada en
   libs/arjs-threex.js) — expone el espacio de nombres global THREEx con
   THREEx.ArToolkitSource, THREEx.ArToolkitContext y THREEx.ArMarkerControls.

   Estrategia de integración (se conserva del módulo anterior, es la clave
   para no duplicar 2000 líneas de motor 3D): en vez de reconstruir los
   modelos, este módulo REPARENTA de forma temporal el grupo Three.js del
   equipo activo (Scene3D.groups[equip]) desde la escena principal (oculta
   durante la sesión AR) hacia una escena AR propia, como hijo del ancla
   del marcador. Como son las MISMAS mallas, todo lo que ya anima
   main.js/scene3d.js (rotor girando, interfase migrando, trazador
   sedimentando, arranque de la bomba) se sigue viendo en AR sin escribir
   una sola línea de física nueva. Al salir de AR, el grupo se devuelve
   intacto a la escena principal.

   Este módulo es independiente y opcional: si el navegador/dispositivo no
   tiene cámara o getUserMedia, el botón de AR se oculta y el resto del
   simulador sigue funcionando exactamente igual que antes.
   ========================================================================= */

const AR = (() => {

  // -----------------------------------------------------------------------
  // Estado interno
  // -----------------------------------------------------------------------
  let renderer, scene, camera;
  let arToolkitSource = null;
  let arToolkitContext = null;
  let markerRoot = null;    // THREE.Group controlado por THREEx.ArMarkerControls (sigue al marcador Hiro)
  let placedRoot = null;    // THREE.Group hijo de markerRoot — offset de usuario (rotar/escalar con gestos)
  let equipGroup = null;    // referencia al Scene3D.groups[equip] reparentado
  let equipOriginalTransform = null; // para restaurar posición/rotación al salir
  let equipParentOriginal = null;    // escena original a la que devolver el grupo
  let running = false;
  let rafId = null;

  let labelsOn = true;
  let theoryMode = false;

  // Debounce de aparición/desaparición del marcador — evita parpadeo si el
  // tracking pierde el marcador por un instante (mano delante, ángulo
  // extremo, motion blur). Se muestra de inmediato al detectarlo; se
  // oculta solo si estuvo perdido por más de MARKER_LOST_DELAY ms.
  const MARKER_LOST_DELAY = 350;
  let markerVisible = false;
  let markerLostTimer = null;

  // Gestos táctiles (rotar con 1 dedo, escalar con 2 dedos, tap para inspeccionar)
  const pointers = new Map();
  let gestureStartDist = null;
  let gestureStartScale = 1;
  let tapCandidate = null; // {x,y,moved}

  // -----------------------------------------------------------------------
  // Tamaño objetivo por equipo sobre el marcador — el marcador Hiro impreso
  // (ver marker.html) define la unidad de mundo real de AR.js: 1 unidad =
  // el ancho del marcador impreso. Los modelos de Scene3D están en
  // "unidades de escena" arbitrarias (no metros reales), así que aquí se
  // define un factor de escala aproximado para que cada equipo aparezca a
  // un tamaño de mesa razonable sobre el marcador, más el desplazamiento
  // vertical para que su base se asiente sobre el plano del marcador en
  // vez de atravesarlo. Son valores estéticos, ajustables con el gesto de
  // pellizco (pinch-to-scale) si el estudiante los quiere más grandes.
  // -----------------------------------------------------------------------
  const AR_MODEL_INFO = {
    decanter: { baseScale: 0.34, liftY: 1.20, label: "Decantador Líquido-Líquido" },
    bowl:     { baseScale: 0.40, liftY: 0.95, label: "Purificador de Tazón" },
    pump:     { baseScale: 0.46, liftY: 0.55, label: "Bomba Centrífuga" }
  };
  const SCALE_MIN = 0.4, SCALE_MAX = 2.5; // límites del gesto de pellizco (factor sobre baseScale)
  let userScale = 1;

  // -----------------------------------------------------------------------
  // §T. CONTENIDO TEÓRICO — "Mostrar teoría": al tocar un componente del
  // equipo aparece una ficha con su función, principio físico, ecuaciones,
  // variables/unidades, hipótesis del modelo y aplicaciones industriales.
  // Se indexa por equipo → clave del componente en Scene3D.dynamic[equip].
  // -----------------------------------------------------------------------
  const THEORY = {
    decanter: {
      shell: {
        nombre: "Carcasa (tazón rotatorio)",
        funcion: "Contiene ambas fases líquidas mientras giran solidariamente con el rotor.",
        principio: "Rotación de cuerpo rígido: todo el fluido gira a la misma ω, generando un campo de aceleración centrífuga ω²r que reemplaza a la gravedad como fuerza motriz de la separación.",
        ecuaciones: "P₂−P₁ = (ρω²/2)(r₂²−r₁²)",
        variables: "ρ: densidad [kg/m³] · ω: velocidad angular [rad/s] · r: radio [m]",
        hipotesis: "Flujo en rotación de cuerpo rígido, sin deslizamiento entre fluido y carcasa.",
        aplicaciones: "Separación líquido-líquido continua: aceite/agua, crudo/salmuera, extracción por solventes."
      },
      rotor: {
        nombre: "Rotor / tazón",
        funcion: "Estructura que gira y arrastra a las dos fases, generando el campo centrífugo.",
        principio: "La energía mecánica del accionamiento se transmite como aceleración centrífuga al fluido.",
        ecuaciones: "ω = 2πn/60",
        variables: "n: velocidad de rotación [rpm]",
        hipotesis: "Arranque instantáneo a ω constante en el modelo simplificado de equilibrio.",
        aplicaciones: "Común a todos los equipos centrífugos industriales."
      },
      heavyPhase: {
        nombre: "Fase pesada (ρ_A)",
        funcion: "Líquido de mayor densidad; migra hacia la pared exterior y descarga por la compuerta r_A.",
        principio: "La fuerza centrífuga es proporcional a ρ, así que la fase más densa siempre se ubica en el radio mayor en el equilibrio.",
        ecuaciones: "r_i² = (ρ_A r_A² + ρ_B r_B²)/(ρ_A + ρ_B)",
        variables: "ρ_A: densidad fase pesada [kg/m³] · r_A: radio compuerta pesada [m]",
        hipotesis: "Equilibrio hidrostático instantáneo en cada compuerta (P_atm en ambas).",
        aplicaciones: "Ej.: fase acuosa/salmuera en decantación de crudo."
      },
      lightPhase: {
        nombre: "Fase ligera (ρ_B)",
        funcion: "Líquido de menor densidad; migra hacia el eje y descarga por la compuerta r_B.",
        principio: "Análogo a la fase pesada, pero se ubica en el radio menor por tener menor ρ.",
        ecuaciones: "r_i² = (ρ_A r_A² + ρ_B r_B²)/(ρ_A + ρ_B)",
        variables: "ρ_B: densidad fase ligera [kg/m³] · r_B: radio compuerta ligera [m]",
        hipotesis: "Sin arrastre de gotas de una fase en la otra (separación ideal).",
        aplicaciones: "Ej.: fase oleosa en decantación de crudo."
      },
      iface: {
        nombre: "Interfase (r_i, zona neutra)",
        funcion: "Superficie cilíndrica que separa ambas fases; su radio de equilibrio fija el diseño de las compuertas.",
        principio: "Balance de presión: ambas columnas líquidas alcanzan P_atm en su respectiva compuerta, igualando presiones en r_i.",
        ecuaciones: "r_i² = (ρ_A r_A² + ρ_B r_B²)/(ρ_A + ρ_B)",
        variables: "r_i: radio de interfase [m]",
        hipotesis: "Válida solo si Δρ es suficiente (>3%); con Δρ menor la interfase pierde nitidez.",
        aplicaciones: "Criterio de diseño de compuertas (gate plates) en decantadores centrífugos reales."
      },
      weirA: {
        nombre: "Compuerta pesada (r_A)",
        funcion: "Anillo de rebose por donde descarga la fase pesada.",
        principio: "Su radio fija, junto con r_B, la posición de equilibrio de la interfase.",
        ecuaciones: "r_i² = (ρ_A r_A² + ρ_B r_B²)/(ρ_A + ρ_B)",
        variables: "r_A: radio de la compuerta pesada [m]",
        hipotesis: "Descarga a presión atmosférica.",
        aplicaciones: "Ajustable en equipos reales cambiando el anillo (gate ring) instalado."
      },
      weirB: {
        nombre: "Compuerta ligera (r_B)",
        funcion: "Anillo de rebose por donde descarga la fase ligera.",
        principio: "Análogo a la compuerta pesada, en el radio menor.",
        ecuaciones: "r_i² = (ρ_A r_A² + ρ_B r_B²)/(ρ_A + ρ_B)",
        variables: "r_B: radio de la compuerta ligera [m]",
        hipotesis: "Descarga a presión atmosférica.",
        aplicaciones: "Ajustable en equipos reales cambiando el anillo (gate ring) instalado."
      }
    },
    bowl: {
      shell: {
        nombre: "Carcasa del purificador",
        funcion: "Encierra el tazón rotatorio donde sedimentan los sólidos.",
        principio: "Igual que en el decantador: rotación de cuerpo rígido genera el campo centrífugo.",
        ecuaciones: "u_t = D_p²(ρ_p−ρ)ω²r / 18μ",
        variables: "ω: velocidad angular [rad/s]",
        hipotesis: "Rotación de cuerpo rígido, sin deslizamiento.",
        aplicaciones: "Clarificación de aceites, purificación de combustibles, separación de lodos."
      },
      liquidSurface: {
        nombre: "Superficie líquida cilíndrica",
        funcion: "Representa la superficie libre del líquido, que a alta ω deja de ser un plano horizontal y se vuelve un cilindro vertical.",
        principio: "A ω alta, la aceleración centrífuga (ω²r) domina completamente sobre la gravedad (g), por lo que la superficie de equilibrio sigue la geometría del campo centrífugo.",
        ecuaciones: "ω²r ≫ g",
        variables: "r: radio de la superficie libre [m]",
        hipotesis: "Régimen de alta velocidad (factor de separación Σ = ω²r/g ≫ 1).",
        aplicaciones: "Concepto base del diseño de purificadores de tazón (bowl centrifuges)."
      },
      cake: {
        nombre: "Torta de sólidos",
        funcion: "Capa de partículas acumuladas contra la pared conforme avanza el proceso por lotes.",
        principio: "Cada partícula que alcanza la pared queda retenida; con el tiempo, la torta reduce el volumen líquido disponible.",
        ecuaciones: "Modelo de acumulación asintótica: fracción = 1 − e^(−ciclos/6)",
        variables: "ciclos: número de partículas que han llegado a la pared",
        hipotesis: "Capacidad de acumulación finita en la pared (saturación suave, no del libro, es un artificio de visualización).",
        aplicaciones: "Determina la frecuencia de limpieza/descarga de sólidos del equipo real."
      },
      tracer: {
        nombre: "Partícula trazadora",
        funcion: "Representa la trayectoria radial r(t) de una partícula típica, integrada paso a paso.",
        principio: "Ley de Stokes centrífuga: la velocidad de sedimentación es proporcional a D_p², a Δρ y al campo centrífugo local ω²r.",
        ecuaciones: "dr/dt = ω² r D_p²(ρ_p−ρ) / 18μ",
        variables: "D_p: diámetro de partícula [m] · ρ_p: densidad del sólido [kg/m³] · μ: viscosidad [Pa·s]",
        hipotesis: "Régimen de Stokes válido (Re_p < 1); partícula esférica y aislada.",
        aplicaciones: "Cálculo del tiempo de residencia requerido para separación completa."
      }
    },
    pump: {
      impeller: {
        nombre: "Impulsor",
        funcion: "Componente rotatorio que transfiere energía mecánica al fluido, generando carga (ΔH) y capacidad (q).",
        principio: "Leyes de afinidad: para bombas geométricamente similares, capacidad, carga y potencia escalan con la velocidad de giro.",
        ecuaciones: "q₂/q₁ = n₂/n₁ · ΔH₂/ΔH₁ = (n₂/n₁)² · P₂/P₁ = (n₂/n₁)³",
        variables: "n: velocidad de rotación [rpm]",
        hipotesis: "Mismo diámetro de impulsor, punto de operación geométricamente semejante.",
        aplicaciones: "Base del control de bombas centrífugas mediante variadores de velocidad (VFD)."
      },
      volute: {
        nombre: "Voluta",
        funcion: "Carcasa espiral que colecta el fluido descargado por el impulsor y lo conduce hacia la tubería de descarga, convirtiendo velocidad en presión.",
        principio: "Difusión gradual del flujo: al aumentar el área de paso a lo largo de la espiral, la velocidad disminuye y la presión estática aumenta (Bernoulli).",
        ecuaciones: "P₂−P₁ = (ρω²/2)(r₂²−r₁²) — presión generada por el campo rotatorio",
        variables: "r₂: radio exterior del impulsor [m]",
        hipotesis: "Flujo incompresible, en régimen permanente.",
        aplicaciones: "Diseño estándar de bombas centrífugas de succión simple."
      },
      frontDisc: {
        nombre: "Carcasa frontal",
        funcion: "Cierra el cuerpo de la bomba; en vista industrial es opaca, en vista interior se oculta para observar el impulsor.",
        principio: "Elemento estructural/de contención, sin función hidráulica activa.",
        ecuaciones: "—",
        variables: "—",
        hipotesis: "—",
        aplicaciones: "Punto de acceso para mantenimiento del impulsor en equipos reales."
      }
    }
  };

  // -----------------------------------------------------------------------
  // §0. DETECCIÓN DE SOPORTE — se llama al cargar la página.
  //
  // AR.js necesita: (1) contexto seguro (HTTPS o localhost) porque
  // getUserMedia lo exige, y (2) la API MediaDevices.getUserMedia en sí.
  // A diferencia de WebXR, esto SÍ funciona en Safari de iOS y en
  // cualquier Android con cualquier navegador moderno — no depende de
  // ARCore/ARKit. Por eso los mensajes de error aquí son mucho más cortos
  // que en la versión WebXR: solo hay dos causas reales de fallo.
  // -----------------------------------------------------------------------
  function isSecureContext() {
    return typeof window.isSecureContext === "boolean" ? window.isSecureContext : location.protocol === "https:";
  }

  function checkSupport() {
    const btn = document.getElementById("btnAR");
    const unsupportedMsg = document.getElementById("arUnsupported");
    if (!btn) return;

    const showUnsupported = (msg) => {
      btn.style.display = "none";
      if (unsupportedMsg) {
        unsupportedMsg.textContent = msg;
        unsupportedMsg.title = msg;
        unsupportedMsg.style.display = "flex";
      }
    };

    if (!isSecureContext()) {
      showUnsupported("Realidad Aumentada requiere HTTPS · abre el simulador desde un link https:// (no http:// ni un archivo local)");
      return;
    }
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      showUnsupported("Este navegador no da acceso a la cámara · usa Chrome, Safari o Firefox actualizados");
      return;
    }

    btn.style.display = "flex";
    if (unsupportedMsg) unsupportedMsg.style.display = "none";
  }

  // -----------------------------------------------------------------------
  // §1. INICIALIZACIÓN DE LA ESCENA AR (renderer/escena/cámara propios,
  // independientes del visor 3D de escritorio) + fuente de vídeo AR.js
  // (arToolkitSource crea internamente un <video> con la cámara trasera).
  // -----------------------------------------------------------------------
  function initARScene() {
    const canvas = document.getElementById("arCanvas");
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);

    scene = new THREE.Scene();
    camera = new THREE.Camera(); // THREEx.ArToolkitContext sobreescribe su matriz de proyección

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.15));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(2, 4, 2);
    scene.add(dir);

    // Ancla del marcador — THREEx.ArMarkerControls escribe la matriz de
    // este grupo cada frame para que "siga" al marcador Hiro detectado.
    markerRoot = new THREE.Group();
    markerRoot.visible = false;
    scene.add(markerRoot);

    placedRoot = new THREE.Group(); // offset de usuario (rotación/escala vía gestos)
    markerRoot.add(placedRoot);
  }

  function initARToolkit(onReady) {
    arToolkitSource = new THREEx.ArToolkitSource({
      sourceType: "webcam",
      sourceWidth: window.innerWidth > window.innerHeight ? 640 : 480,
      sourceHeight: window.innerWidth > window.innerHeight ? 480 : 640
    });

    arToolkitSource.init(function onSourceReady() {
      // ArToolkitSource.init() inserta el <video> directamente en
      // document.body con estilos EN LÍNEA fijos (position:absolute;
      // top:0;left:0;z-index:-2). Como los estilos en línea tienen más
      // especificidad que cualquier regla de style.css, hay que
      // sobreescribirlos aquí a mano después de reparentar el elemento
      // dentro de #arVideoWrap, o el vídeo no quedará centrado/recortado
      // como especifica la hoja de estilos.
      const wrap = document.getElementById("arVideoWrap");
      const video = arToolkitSource.domElement;
      if (wrap && video) {
        wrap.innerHTML = "";
        wrap.appendChild(video);
        video.style.position = "absolute";
        video.style.top = "50%";
        video.style.left = "50%";
        video.style.transform = "translate(-50%, -50%)";
        video.style.zIndex = "0";
        video.style.width = "auto";
        video.style.height = "auto";
        video.style.minWidth = "100%";
        video.style.minHeight = "100%";
      }
      arToolkitSource.domElement.addEventListener("canplay", () => {
        setupContext(onReady);
      }, { once: true });
      // canplay puede ya haber ocurrido si la cámara respondió muy rápido
      setTimeout(onResizeAR, 400);
    }, function onSourceError(err) {
      onCameraError(err);
    });

    window.addEventListener("resize", onResizeAR);
  }

  function setupContext(onReady) {
    arToolkitContext = new THREEx.ArToolkitContext({
      cameraParametersUrl: "assets/ar/camera_para.dat",
      detectionMode: "mono",
      maxDetectionRate: 30,
      canvasWidth: 640,
      canvasHeight: 480
    });

    arToolkitContext.init(() => {
      camera.projectionMatrix.copy(arToolkitContext.getProjectionMatrix());
      window.arToolkitContext = arToolkitContext;

      const markerControls = new THREEx.ArMarkerControls(arToolkitContext, markerRoot, {
        type: "pattern",
        patternUrl: "assets/ar/patt.hiro",
        changeMatrixMode: "modelViewMatrix",
        smooth: true,
        smoothCount: 5,
        smoothTolerance: 0.01,
        smoothThreshold: 2
      });

      markerRoot.addEventListener("markerFound", onMarkerFound);
      markerRoot.addEventListener("markerLost", onMarkerLost);

      onResizeAR();
      if (onReady) onReady();
    });
  }

  function onResizeAR() {
    if (!arToolkitSource) return;
    arToolkitSource.onResizeElement();
    arToolkitSource.copyElementSizeTo(renderer.domElement);
    if (arToolkitContext && arToolkitContext.arController) {
      arToolkitSource.copyElementSizeTo(arToolkitContext.arController.canvas);
    }
  }

  function onCameraError(err) {
    let msg = "No se pudo acceder a la cámara. Verifica los permisos del sitio.";
    if (err && err.name === "NotAllowedError") {
      msg = "Permiso de cámara denegado · actívalo en los ajustes del sitio y vuelve a intentar";
    } else if (err && err.name === "NotFoundError") {
      msg = "No se detectó ninguna cámara en este dispositivo";
    } else if (err && err.name === "NotReadableError") {
      msg = "La cámara está siendo usada por otra aplicación";
    }
    showToast(msg);
    stop();
  }

  // -----------------------------------------------------------------------
  // §2. DETECCIÓN DEL MARCADOR — muestra/oculta el equipo con un pequeño
  // debounce (ver MARKER_LOST_DELAY) para que oclusiones breves no hagan
  // parpadear el modelo.
  // -----------------------------------------------------------------------
  function onMarkerFound() {
    clearTimeout(markerLostTimer);
    markerLostTimer = null;
    if (!markerVisible) {
      markerVisible = true;
      if (placedRoot) placedRoot.visible = true;
      const hint = document.getElementById("arHint");
      if (hint) hint.style.display = "none";
    }
  }

  function onMarkerLost() {
    if (markerLostTimer) return;
    markerLostTimer = setTimeout(() => {
      markerVisible = false;
      if (placedRoot) placedRoot.visible = false;
      const hint = document.getElementById("arHint");
      if (hint) hint.style.display = "block";
      markerLostTimer = null;
    }, MARKER_LOST_DELAY);
  }

  // -----------------------------------------------------------------------
  // §3. ARRANQUE / FIN DE SESIÓN
  // -----------------------------------------------------------------------
  function start() {
    if (running) return;
    const overlay = document.getElementById("arOverlay");
    const videoWrap = document.getElementById("arVideoWrap");

    document.getElementById("arCanvas").style.display = "block";
    if (videoWrap) videoWrap.style.display = "block";
    if (overlay) overlay.style.display = "flex";
    const hint = document.getElementById("arHint");
    if (hint) { hint.textContent = "Apunta la cámara hacia el marcador Hiro impreso · descárgalo en marker.html"; hint.style.display = "block"; }

    if (!renderer) initARScene();
    Scene3D.setRenderPaused(true); // deja de renderizar (no de calcular) el canvas principal oculto

    attachEquipGroup();
    setupGestures();
    updateOverlayEquipLabel();

    initARToolkit(() => {
      running = true;
      rafId = requestAnimationFrame(renderLoop);
    });
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    running = false;

    window.removeEventListener("resize", onResizeAR);
    clearTimeout(markerLostTimer);
    markerLostTimer = null;
    markerVisible = false;

    if (arToolkitSource && arToolkitSource.domElement) {
      const el = arToolkitSource.domElement;
      if (el.srcObject) {
        el.srcObject.getTracks().forEach((t) => t.stop());
      }
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    arToolkitSource = null;
    arToolkitContext = null;

    if (markerRoot) {
      markerRoot.removeEventListener("markerFound", onMarkerFound);
      markerRoot.removeEventListener("markerLost", onMarkerLost);
    }

    detachEquipGroup();
    teardownGestures();

    document.getElementById("arCanvas").style.display = "none";
    const videoWrap = document.getElementById("arVideoWrap");
    if (videoWrap) { videoWrap.style.display = "none"; videoWrap.innerHTML = ""; }
    const overlay = document.getElementById("arOverlay");
    if (overlay) overlay.style.display = "none";
    hideTheoryCard();
    const panel = document.getElementById("arReadoutPanel");
    if (panel) panel.style.display = "none";

    Scene3D.setRenderPaused(false); // el visor 3D de escritorio vuelve a renderizar normalmente

    // La escena AR (renderer/markerRoot) se conserva entre sesiones para
    // no reconstruir WebGL en cada entrada/salida; solo se resetea el
    // estado de colocación del usuario.
    userScale = 1;
    if (placedRoot) { placedRoot.visible = false; placedRoot.rotation.set(0, 0, 0); }
  }

  // -----------------------------------------------------------------------
  // §4. REPARENTADO DEL MODELO ACTIVO — mueve Scene3D.groups[equip] desde
  // la escena principal a la escena AR (y de vuelta al terminar). No se
  // clona geometría: son las mismas mallas que anima el motor de
  // simulación, por eso RPM/interfase/trazador/arranque de bomba se ven
  // sincronizados automáticamente sin código adicional.
  // -----------------------------------------------------------------------
  function attachEquipGroup(equipOverride) {
    const equip = equipOverride || Scene3D.currentEquip;
    equipGroup = Scene3D.groups[equip];
    equipParentOriginal = Scene3D.scene;
    equipOriginalTransform = {
      position: equipGroup.position.clone(),
      rotation: equipGroup.rotation.clone(),
      scale: equipGroup.scale.clone(),
      visible: equipGroup.visible
    };

    const info = AR_MODEL_INFO[equip];
    equipGroup.visible = true;
    equipGroup.position.set(0, info.liftY * info.baseScale * userScale, 0);
    equipGroup.rotation.set(0, 0, 0);
    equipGroup.scale.setScalar(info.baseScale * userScale);
    placedRoot.add(equipGroup); // reparenta: Three.js lo quita automáticamente de la escena principal
  }

  function detachEquipGroup() {
    if (!equipGroup) return;
    equipGroup.position.copy(equipOriginalTransform.position);
    equipGroup.rotation.copy(equipOriginalTransform.rotation);
    equipGroup.scale.copy(equipOriginalTransform.scale);
    equipGroup.visible = equipOriginalTransform.visible;
    equipParentOriginal.add(equipGroup); // lo devuelve a la escena principal
    equipGroup = null;
  }

  // Cambiar de equipo SIN salir de la sesión AR (menú "Seleccionar equipo").
  function switchEquip(name) {
    if (!running || !AR_MODEL_INFO[name]) return;
    detachEquipGroup();
    attachEquipGroup(name);
    Scene3D.setEquip(name); // mantiene sincronizado el resto del simulador (paneles, gráficas)
    updateOverlayEquipLabel();
  }

  // -----------------------------------------------------------------------
  // §5. GESTOS TÁCTILES — 1 dedo = rotar (yaw), 2 dedos = pellizco (escala),
  // toque simple = inspeccionar componente (si "Mostrar teoría" está activo).
  // -----------------------------------------------------------------------
  const TAP_MOVE_THRESHOLD = 12; // px — por debajo de esto, un toque cuenta como "tap" y no como arrastre
  const ROTATE_SPEED = 0.012;

  function setupGestures() {
    const canvas = document.getElementById("arCanvas");
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
  }
  function teardownGestures() {
    const canvas = document.getElementById("arCanvas");
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    pointers.clear();
  }

  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      tapCandidate = { x: e.clientX, y: e.clientY, moved: false };
    } else {
      tapCandidate = null; // dos dedos en pantalla: ya no puede ser un "tap" simple
    }
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      gestureStartDist = dist(pts[0], pts[1]);
      gestureStartScale = userScale;
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1 && placedRoot && placedRoot.visible) {
      const p = pointers.get(e.pointerId);
      if (tapCandidate) {
        const dx = p.x - tapCandidate.x, dy = p.y - tapCandidate.y;
        if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD) tapCandidate.moved = true;
        if (tapCandidate.moved) {
          placedRoot.rotation.y += dx * ROTATE_SPEED;
          tapCandidate.x = p.x; tapCandidate.y = p.y; // acumula solo el delta de este frame
        }
      }
    } else if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const d = dist(pts[0], pts[1]);
      if (gestureStartDist) {
        const scaleFactor = d / gestureStartDist;
        userScale = Math.min(Math.max(gestureStartScale * scaleFactor, SCALE_MIN), SCALE_MAX);
        applyUserScale();
      }
    }
  }

  function onPointerUp(e) {
    const wasTap = tapCandidate && !tapCandidate.moved && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) gestureStartDist = null;

    if (wasTap) handleTap(tapCandidate.x, tapCandidate.y);
    if (pointers.size === 0) tapCandidate = null;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function applyUserScale() {
    if (!equipGroup) return;
    const equip = Scene3D.currentEquip;
    const info = AR_MODEL_INFO[equip];
    const s = info.baseScale * userScale;
    equipGroup.scale.setScalar(s);
    equipGroup.position.y = info.liftY * s;
  }

  // -----------------------------------------------------------------------
  // §6. MANEJO DEL TOQUE — en modo teoría, dispara un raycast contra los
  // componentes del equipo activo para mostrar la ficha didáctica del que
  // fue tocado.
  // -----------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  function handleTap(clientX, clientY) {
    if (theoryMode && placedRoot && placedRoot.visible) {
      pickComponent(clientX, clientY);
    }
  }

  function pickComponent(clientX, clientY) {
    const canvas = document.getElementById("arCanvas");
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);

    const equip = Scene3D.currentEquip;
    const dyn = Scene3D.dynamic[equip] || {};
    const theoryForEquip = THEORY[equip] || {};
    const candidates = [];
    Object.keys(theoryForEquip).forEach((key) => {
      const obj = dyn[key];
      if (obj && obj.isObject3D) candidates.push({ key, obj });
    });

    const hits = raycaster.intersectObjects(candidates.map(c => c.obj), true);
    if (hits.length === 0) return;
    const hitObj = hits[0].object;

    // Varios candidatos pueden ser ancestro unos de otros (p. ej. "rotor"
    // contiene a "heavyPhase", "iface", etc.). Se elige el candidato MÁS
    // ESPECÍFICO: el que está a menor distancia (en niveles del árbol) del
    // objeto realmente golpeado por el rayo, no el primero en declararse.
    let best = null, bestDepth = Infinity;
    candidates.forEach((c) => {
      const d = depthTo(c.obj, hitObj);
      if (d < bestDepth) { bestDepth = d; best = c; }
    });
    if (best) showTheoryCard(theoryForEquip[best.key]);
  }

  // Distancia (en niveles) entre `node` y su ancestro `root`; 0 si son el
  // mismo objeto, Infinity si `root` no es ancestro de `node`.
  function depthTo(root, node) {
    let d = 0, p = node;
    while (p) { if (p === root) return d; p = p.parent; d++; }
    return Infinity;
  }

  // -----------------------------------------------------------------------
  // §7. LOOP DE RENDER — actualiza el contexto de tracking de AR.js cada
  // frame (arToolkitContext.update procesa el fotograma de vídeo actual y
  // dispara markerFound/markerLost internamente), proyecta las etiquetas
  // flotantes (billboards) y refresca el panel de lecturas en vivo.
  // -----------------------------------------------------------------------
  function renderLoop() {
    rafId = requestAnimationFrame(renderLoop);
    if (arToolkitSource && arToolkitSource.ready && arToolkitContext) {
      arToolkitContext.update(arToolkitSource.domElement);
    }
    updateBillboards();
    renderer.render(scene, camera);
  }

  // -----------------------------------------------------------------------
  // §8. ETIQUETAS FLOTANTES (billboards) — panel HTML de lecturas en vivo
  // anclado sobre el modelo colocado. Se recalcula su posición en pantalla
  // proyectando un punto 3D sobre el equipo con la cámara AR de cada
  // frame, así que sigue al modelo mientras el marcador se mueve.
  // -----------------------------------------------------------------------
  const projVec = new THREE.Vector3();
  function updateBillboards() {
    const panel = document.getElementById("arReadoutPanel");
    if (!panel) return;
    if (!labelsOn || !placedRoot || !placedRoot.visible || !markerRoot.visible) { panel.style.display = "none"; return; }

    const equip = Scene3D.currentEquip;
    const info = AR_MODEL_INFO[equip];
    const anchorHeight = info.liftY * info.baseScale * userScale * 2.1;
    const worldPoint = placedRoot.localToWorld(projVec.set(0, anchorHeight, 0));

    const p = worldPoint.clone().project(camera);
    if (p.z > 1) { panel.style.display = "none"; return; } // detrás de la cámara

    const canvas = document.getElementById("arCanvas");
    const x = (p.x * 0.5 + 0.5) * canvas.clientWidth;
    const y = (-p.y * 0.5 + 0.5) * canvas.clientHeight;

    panel.style.display = "block";
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;

    // Contenido — se toma directamente de la última lectura calculada por
    // main.js (cacheada en ui.js), así nunca se desincroniza del panel de
    // datos del visor de escritorio.
    const last = UI.getLastState();
    panel.innerHTML = `
      <div class="ar-panel-title">${info.label}</div>
      ${last.readouts.slice(0, 4).map(r => `
        <div class="ar-panel-row"><span>${r.label}</span><b>${r.value}${r.unit ? ` ${r.unit}` : ""}</b></div>
      `).join("")}
    `;
  }

  // -----------------------------------------------------------------------
  // §9. TARJETA DE TEORÍA (modo didáctico)
  // -----------------------------------------------------------------------
  function showTheoryCard(t) {
    const card = document.getElementById("arTheoryCard");
    if (!card || !t) return;
    card.innerHTML = `
      <button class="ar-theory-close" id="arTheoryClose" aria-label="Cerrar">✕</button>
      <div class="ar-theory-name">${t.nombre}</div>
      <div class="ar-theory-row"><b>Función</b><span>${t.funcion}</span></div>
      <div class="ar-theory-row"><b>Principio físico</b><span>${t.principio}</span></div>
      <div class="ar-theory-row"><b>Ecuación</b><span class="ar-theory-eq">${t.ecuaciones}</span></div>
      <div class="ar-theory-row"><b>Variables</b><span>${t.variables}</span></div>
      <div class="ar-theory-row"><b>Hipótesis</b><span>${t.hipotesis}</span></div>
      <div class="ar-theory-row"><b>Aplicaciones</b><span>${t.aplicaciones}</span></div>
    `;
    card.style.display = "block";
    document.getElementById("arTheoryClose").addEventListener("click", hideTheoryCard);
  }
  function hideTheoryCard() {
    const card = document.getElementById("arTheoryCard");
    if (card) card.style.display = "none";
  }

  // -----------------------------------------------------------------------
  // §10. CONTROLES DEL OVERLAY (salir, reiniciar posición, etiquetas, teoría)
  // -----------------------------------------------------------------------
  function resetPlacement() {
    userScale = 1;
    if (placedRoot) placedRoot.rotation.set(0, 0, 0);
    applyUserScale();
    hideTheoryCard();
  }

  function toggleLabels(v) {
    labelsOn = v;
    if (!v) {
      const panel = document.getElementById("arReadoutPanel");
      if (panel) panel.style.display = "none";
    }
  }

  function toggleTheory(v) {
    theoryMode = v;
    if (!v) hideTheoryCard();
  }

  function updateOverlayEquipLabel() {
    const el = document.getElementById("arEquipLabel");
    if (el) el.textContent = AR_MODEL_INFO[Scene3D.currentEquip].label;
  }

  function showToast(msg) {
    const t = document.getElementById("arToast");
    if (!t) { alert(msg); return; }
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(showToast._tid);
    showToast._tid = setTimeout(() => { t.style.display = "none"; }, 3500);
  }

  // -----------------------------------------------------------------------
  // §11. CABLEADO DE LA UI (botón de entrada + controles del overlay)
  // -----------------------------------------------------------------------
  function wireUI() {
    const btnAR = document.getElementById("btnAR");
    if (btnAR) btnAR.addEventListener("click", start);

    const btnExit = document.getElementById("arExit");
    if (btnExit) btnExit.addEventListener("click", stop);

    const btnResetPos = document.getElementById("arResetPlacement");
    if (btnResetPos) btnResetPos.addEventListener("click", resetPlacement);

    const chkLabels = document.getElementById("arToggleLabels");
    if (chkLabels) chkLabels.addEventListener("click", () => {
      const active = chkLabels.classList.toggle("active");
      toggleLabels(active);
    });

    const chkTheory = document.getElementById("arToggleTheory");
    if (chkTheory) chkTheory.addEventListener("click", () => {
      const active = chkTheory.classList.toggle("active");
      toggleTheory(active);
    });

    // Menú "Seleccionar equipo" dentro del overlay AR (opcional en el DOM;
    // si no existe simplemente no se cablea nada).
    document.querySelectorAll("[data-ar-equip]").forEach((btn) => {
      btn.addEventListener("click", () => switchEquip(btn.dataset.arEquip));
    });
  }

  function init() {
    wireUI();
    checkSupport();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { start, stop, switchEquip };
})();
