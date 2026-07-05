/* =========================================================================
   SCENE3D.JS — Visor 3D interactivo (Three.js r128)
   Modelos: Decantador L-L · Purificador de tazón · Bomba centrífuga
   ========================================================================= */

const Scene3D = (() => {

  let renderer, scene, camera, clock;
  let currentEquip = "decanter";
  let spinning = true;
  let crossSection = true;
  let viewMode = "interior"; // 'industrial' (carcasa cerrada, opaca) | 'interior' (corte, ve el proceso)
  let animId = null;
  let frameCallback = null; // registrado por main.js: recibe el dt real (s) de cada frame
  let renderPaused = false; // ar.js lo activa mientras la sesión WebXR está presentando,
                             // para no gastar GPU renderizando el canvas principal oculto
                             // (la física sigue avanzando: frameCallback se sigue llamando)

  function setFrameCallback(fn) { frameCallback = fn; }
  function setRenderPaused(v) { renderPaused = v; }

  // Grupos raíz por equipo — se muestran/ocultan según selección
  const groups = { decanter: null, bowl: null, pump: null };

  // Referencias a partes dinámicas que se re-generan al cambiar parámetros
  const dynamic = {
    decanter: {},
    bowl: {},
    pump: {}
  };

  const COLORS = {
    heavy: 0xE8A33D,   // ámbar de proceso — líquido pesado
    light: 0x4FC3D9,   // cian de fluido — líquido ligero
    interface: 0xF4F1EA,
    shell: 0x8B929C,   // acero inoxidable pulido (base neutra, el brillo lo da el envMap)
    shellWire: 0x4A5568,
    shaft: 0xAEB4BC,   // acero de eje, más claro/pulido
    solids: 0x9C6B3E,
    impeller: 0xC7CCD3,
    volute: 0x8B929C,
    accent: 0x3DCB7A
  };

  // Textura de ambiente (env map) procedural: un pequeño cubemap generado
  // por código que simula una nave industrial — un plano de luz cenital
  // frío arriba, un piso oscuro abajo y una franja ámbar de "iluminación
  // de proceso" al costado. No es una foto HDRI real, pero al usarse como
  // envMap en materiales metalness:1 produce reflejos direccionales
  // creíbles de acero pulido sin depender de assets externos.
  let envMap = null;

  function buildProceduralEnvMap() {
    const size = 128;
    const cubeRT = new THREE.WebGLCubeRenderTarget(size, {
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter
    });
    const envScene = new THREE.Scene();

    // Fondo degradado frío→oscuro (simulado con esfera invertida + shader simple)
    const skyGeo = new THREE.SphereGeometry(50, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(0x3a4250) },
        bottom: { value: new THREE.Color(0x05070a) },
        band: { value: new THREE.Color(0xE8A33D) }
      },
      vertexShader: `
        varying vec3 vPos;
        void main(){ vPos = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
      `,
      fragmentShader: `
        varying vec3 vPos;
        uniform vec3 top; uniform vec3 bottom; uniform vec3 band;
        void main(){
          float h = clamp(vPos.y*0.5+0.5, 0.0, 1.0);
          vec3 col = mix(bottom, top, pow(h, 0.6));
          float bandMask = smoothstep(0.02,0.0,abs(vPos.y+0.15)) * smoothstep(1.0,0.3,abs(vPos.x));
          col = mix(col, band, bandMask*0.5);
          gl_FragColor = vec4(col,1.0);
        }
      `
    });
    envScene.add(new THREE.Mesh(skyGeo, skyMat));

    // Un par de "paneles de luz" rectangulares (simulan lámparas de nave
    // industrial) para dar highlights especulares suaves al acero — brillo
    // moderado (no blanco puro) para evitar reflejos tipo espejo
    [[3, 4, 3, 0xb8bcc2], [-4, 2, -2, 0x3d8fa0], [0, -1, 5, 0xa87730]].forEach(([x, y, z, col]) => {
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(3.4, 2.2),
        new THREE.MeshBasicMaterial({ color: col })
      );
      panel.position.set(x, y, z);
      panel.lookAt(0, 0, 0);
      envScene.add(panel);
    });

    const cubeCam = new THREE.CubeCamera(0.1, 50, cubeRT);
    cubeCam.update(renderer, envScene);
    envMap = cubeRT.texture;
    return envMap;
  }

  // Material de acero inoxidable de proceso — metalness y brillo moderados
  // (el acero industrial real, ya con uso y maquinado, dispersa la luz de
  // forma mucho más difusa que un metal pulido de laboratorio; valores
  // altos de metalness/envMapIntensity producen el efecto "espejo" que
  // no corresponde a un equipo de planta real).
  function steelMaterial({ color = COLORS.shell, roughness = 0.52, metalness = 0.78, opacity = 1, transparent = false, clearcoat = 0 } = {}) {
    return new THREE.MeshPhysicalMaterial({
      color, roughness, metalness, envMap, envMapIntensity: 0.5,
      transparent, opacity, clearcoat, clearcoatRoughness: 0.4,
      side: THREE.FrontSide
    });
  }

  // Variante translúcida (carcasas de observación) — mismo acabado pero
  // con transparencia para ver el proceso interior, típico de las
  // ventanillas de inspección en equipos reales.
  function steelGlassMaterial({ color = COLORS.shell, opacity = 0.16 } = {}) {
    return new THREE.MeshPhysicalMaterial({
      color, roughness: 0.22, metalness: 0.08, envMap, envMapIntensity: 0.35,
      transparent: true, opacity, side: THREE.DoubleSide,
      transmission: 0.55, thickness: 0.4
    });
  }

  // Variante OPACA de la carcasa — usada en "Vista industrial": acero de
  // proceso sólido y realista, sin transmisión, para representar el
  // equipo tal como se vería cerrado en planta.
  function steelShellOpaqueMaterial({ color = COLORS.shell } = {}) {
    return new THREE.MeshPhysicalMaterial({
      color, roughness: 0.48, metalness: 0.7, envMap, envMapIntensity: 0.45,
      transparent: false, opacity: 1, side: THREE.FrontSide
    });
  }

  // -----------------------------------------------------------------------
  // Inicialización
  // -----------------------------------------------------------------------
  function init(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.physicallyCorrectLights = true;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    scene = new THREE.Scene();
    clock = new THREE.Clock();

    camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    camera.position.set(3.2, 2.1, 3.6);

    // Iluminación técnica — clave + relleno + contorno para lectura de forma
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(4, 6, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x4FC3D9, 0.4);
    fill.position.set(-4, 2, -3);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xE8A33D, 0.45);
    rim.position.set(0, -3, -5);
    scene.add(rim);
    scene.add(new THREE.AmbientLight(0x1a2028, 1.1));

    // Rejilla de piso sutil para anclaje espacial
    const grid = new THREE.GridHelper(8, 16, 0x2A313C, 0x1A2028);
    grid.position.y = -1.35;
    scene.add(grid);

    buildProceduralEnvMap();
    scene.environment = envMap;

    groups.decanter = buildDecanter();
    groups.bowl = buildBowl();
    groups.pump = buildPump();
    scene.add(groups.decanter, groups.bowl, groups.pump);
    setEquip("decanter");
    setViewMode(viewMode);

    initOrbitControls(canvas);
    resize();
    animate();
  }

  // -----------------------------------------------------------------------
  // Controles de órbita ligeros (sin dependencia externa OrbitControls)
  // -----------------------------------------------------------------------
  let orbit = { theta: 0.7, phi: 1.05, radius: 5.0, target: new THREE.Vector3(0, 0, 0) };
  let dragging = false, panning = false, lastX = 0, lastY = 0;

  function initOrbitControls(canvas) {
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 2) panning = true; else dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointerup", () => { dragging = false; panning = false; });
    canvas.addEventListener("pointerleave", () => { dragging = false; panning = false; });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointermove", (e) => {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (dragging) {
        orbit.theta -= dx * 0.008;
        orbit.phi = Math.min(Math.max(orbit.phi - dy * 0.008, 0.15), Math.PI - 0.15);
      } else if (panning) {
        const panSpeed = orbit.radius * 0.0012;
        const right = new THREE.Vector3(); camera.getWorldDirection(right);
        const camRight = new THREE.Vector3().crossVectors(camera.up, right).normalize();
        orbit.target.addScaledVector(camRight, dx * panSpeed);
        orbit.target.y += dy * panSpeed;
      }
      updateCameraFromOrbit();
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      orbit.radius = Math.min(Math.max(orbit.radius + e.deltaY * 0.0028, 1.2), 12);
      updateCameraFromOrbit();
    }, { passive: false });
  }

  function updateCameraFromOrbit() {
    const { theta, phi, radius, target } = orbit;
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(target);
  }

  function resetCamera() {
    orbit = { theta: 0.7, phi: 1.05, radius: 5.0, target: new THREE.Vector3(0, 0, 0) };
    updateCameraFromOrbit();
  }

  // -----------------------------------------------------------------------
  // MODELO 1 — DECANTADOR LÍQUIDO-LÍQUIDO
  // Cilindro rotatorio con interfase vertical cilíndrica (r_i) visible,
  // dos coronas de líquido (pesado exterior / ligero interior) y las
  // compuertas de rebose a rA y rB.
  // -----------------------------------------------------------------------
  function buildDecanter() {
    const g = new THREE.Group();
    const H = 1.7;

    // Carcasa exterior — acero inoxidable de proceso. Se guardan DOS
    // materiales (opaco "industrial" y traslúcido "interior") y se
    // intercambian en setViewMode() sin reconstruir geometría.
    const shellGeo = new THREE.CylinderGeometry(1.3, 1.3, H, 48, 1, true);
    const shellGlassMat = steelGlassMaterial({ color: COLORS.shell, opacity: 0.13 });
    const shellOpaqueMat = steelShellOpaqueMaterial({ color: COLORS.shell });
    const shell = new THREE.Mesh(shellGeo, shellGlassMat);
    g.add(shell);
    // Anillos de refuerzo (bridas) — acero pulido sólido, típicos de carcasas reales
    const braceRings = [];
    [-H * 0.42, 0, H * 0.42].forEach((y) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.028, 10, 48), steelMaterial({ roughness: 0.45 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = y;
      g.add(ring);
      braceRings.push(ring);
      // Pernos de brida — pequeños cilindros distribuidos en el anillo,
      // detalle industrial típico de uniones atornilladas reales
      const boltMat = steelMaterial({ color: 0x6b7280, roughness: 0.55, metalness: 0.6 });
      const nBolts = 8;
      for (let i = 0; i < nBolts; i++) {
        const ang = (i / nBolts) * Math.PI * 2;
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 8), boltMat);
        bolt.position.set(Math.cos(ang) * 1.3, y, Math.sin(ang) * 1.3);
        bolt.lookAt(0, y, 0);
        bolt.rotateX(Math.PI / 2);
        g.add(bolt);
      }
    });
    const shellEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(1.3, 1.3, H, 32, 1)),
      new THREE.LineBasicMaterial({ color: COLORS.shellWire, transparent: true, opacity: 0.4 })
    );
    g.add(shellEdges);

    // Base / skid — estructura de soporte metálica típica de equipo de
    // planta anclado al piso, da presencia industrial inmediata
    const skidMat = steelMaterial({ color: 0x3a4250, roughness: 0.6, metalness: 0.55 });
    const skidBase = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.12, 1.7), skidMat);
    skidBase.position.y = -H * 0.5 - 0.42;
    g.add(skidBase);
    [-1.15, 1.15].forEach((x) => {
      [-0.65, 0.65].forEach((z) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.14), skidMat);
        leg.position.set(x, -H * 0.5 - 0.21, z);
        g.add(leg);
      });
    });

    // Cabezal motriz superior — carcasa del motorreductor + acople,
    // representa el accionamiento real que hace girar el eje
    const motorMat = steelMaterial({ color: 0x2c3542, roughness: 0.55, metalness: 0.5 });
    const motorHousing = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.5, 24), motorMat);
    motorHousing.position.y = H * 0.5 + 0.5;
    g.add(motorHousing);
    const coupling = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.2, 16), steelMaterial({ roughness: 0.4 }));
    coupling.position.y = H * 0.5 + 0.2;
    g.add(coupling);

    // Tubería de alimentación — entra axialmente por arriba, al centro
    const feedPipe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.55, 16),
      steelMaterial({ color: 0x6b7280, roughness: 0.4 })
    );
    feedPipe.position.set(0.85, H * 0.5 + 0.15, 0);
    g.add(feedPipe);
    g.add(makeFlowArrow(new THREE.Vector3(0.85, H * 0.5 + 0.42, 0), new THREE.Vector3(0, -1, 0), COLORS.solids));

    // Eje central — acero de precisión pulido
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, H + 0.5, 20),
      steelMaterial({ color: COLORS.shaft, roughness: 0.3, metalness: 0.82 })
    );
    g.add(shaft);

    // Rotor (grupo que gira) — contiene las dos fases líquidas
    const rotor = new THREE.Group();
    g.add(rotor);

    // Fase ligera (interior, radio menor) — cian translúcido
    const lightGeo = new THREE.CylinderGeometry(0.55, 0.55, H * 0.86, 40, 1, true);
    const lightMat = new THREE.MeshPhysicalMaterial({
      color: COLORS.light, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, roughness: 0.15, metalness: 0, transmission: 0.25
    });
    const lightPhase = new THREE.Mesh(lightGeo, lightMat);
    rotor.add(lightPhase);

    // Fase pesada (exterior, anillo entre interfase y pared) — ámbar translúcido
    const heavyGeo = new THREE.CylinderGeometry(1.05, 1.05, H * 0.86, 40, 1, true);
    const heavyMat = new THREE.MeshPhysicalMaterial({
      color: COLORS.heavy, transparent: true, opacity: 0.4,
      side: THREE.DoubleSide, roughness: 0.2, metalness: 0
    });
    const heavyPhase = new THREE.Mesh(heavyGeo, heavyMat);
    rotor.add(heavyPhase);

    // Superficie de interfase (r_i) — anillo destacado brillante
    const ifaceGeo = new THREE.CylinderGeometry(0.75, 0.75, H * 0.87, 48, 1, true);
    const ifaceMat = new THREE.MeshPhysicalMaterial({
      color: COLORS.interface, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, roughness: 0.05, metalness: 0,
      emissive: COLORS.interface, emissiveIntensity: 0.15
    });
    const iface = new THREE.Mesh(ifaceGeo, ifaceMat);
    rotor.add(iface);
    const ifaceRingTop = new THREE.Mesh(
      new THREE.TorusGeometry(0.75, 0.012, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    ifaceRingTop.rotation.x = Math.PI / 2;
    ifaceRingTop.position.y = H * 0.435;
    rotor.add(ifaceRingTop);
    const ifaceRingBot = ifaceRingTop.clone();
    ifaceRingBot.position.y = -H * 0.435;
    rotor.add(ifaceRingBot);

    // Compuertas de salida (weirs) rA (pesada, exterior) y rB (ligera, interior)
    // — acero con leve emisión de color de proceso para mantener la lectura
    // funcional (qué compuerta es cuál) sin perder el acabado metálico
    const weirA = new THREE.Mesh(
      new THREE.TorusGeometry(1.05, 0.022, 10, 40),
      steelMaterial({ color: COLORS.heavy, roughness: 0.4 })
    );
    weirA.material.emissive = new THREE.Color(COLORS.heavy);
    weirA.material.emissiveIntensity = 0.22;
    weirA.rotation.x = Math.PI / 2; weirA.position.y = H * 0.5 + 0.02;
    rotor.add(weirA);
    const weirB = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.022, 10, 40),
      steelMaterial({ color: COLORS.light, roughness: 0.4 })
    );
    weirB.material.emissive = new THREE.Color(COLORS.light);
    weirB.material.emissiveIntensity = 0.22;
    weirB.rotation.x = Math.PI / 2; weirB.position.y = H * 0.5 + 0.02;
    rotor.add(weirB);

    // Tuberías de descarga — salen radialmente de cada compuerta hacia la
    // carcasa exterior, con flecha de flujo del color de la fase (las
    // etiquetas r_A/r_B ya identifican cuál es cuál, sin duplicar texto)
    const dischargeA = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 0.5, 14),
      steelMaterial({ color: 0x6b7280, roughness: 0.4 })
    );
    dischargeA.position.set(1.5, H * 0.5 + 0.02, 0);
    dischargeA.rotation.z = Math.PI / 2;
    g.add(dischargeA);
    g.add(makeFlowArrow(new THREE.Vector3(1.32, H * 0.5 + 0.02, 0), new THREE.Vector3(1, 0, 0), COLORS.heavy));

    const dischargeB = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.4, 14),
      steelMaterial({ color: 0x6b7280, roughness: 0.4 })
    );
    dischargeB.position.set(0, H * 0.5 + 0.02, -0.75);
    dischargeB.rotation.x = Math.PI / 2;
    g.add(dischargeB);
    g.add(makeFlowArrow(new THREE.Vector3(0, H * 0.5 + 0.02, -0.58), new THREE.Vector3(0, 0, -1), COLORS.light));

    // Etiquetas de radio (líneas guía) generadas como sprites simples via canvas
    g.add(makeLabelSprite("r_A", COLORS.heavy, new THREE.Vector3(1.05, H * 0.55, 0)));
    g.add(makeLabelSprite("r_B", COLORS.light, new THREE.Vector3(0.55, H * 0.55, 0)));
    g.add(makeLabelSprite("r_i", 0xffffff, new THREE.Vector3(0.75, -H * 0.55, 0)));

    // Partículas de fase — pequeñas gotas suspendidas en cada fase líquida,
    // giran solidarias al rotor (dan sensación de fluido poblado/turbulento
    // en vez de un volumen vacío). Puramente decorativas, no son trazadores
    // físicamente integrados (esos existen en el purificador de tazón).
    const heavyParticles = [];
    const heavyDropGeo = new THREE.SphereGeometry(0.016, 6, 6);
    const heavyDropMat = new THREE.MeshStandardMaterial({ color: 0xF4C97A, emissive: COLORS.heavy, emissiveIntensity: 0.25, roughness: 0.5 });
    for (let i = 0; i < 28; i++) {
      const drop = new THREE.Mesh(heavyDropGeo, heavyDropMat);
      const ang = Math.random() * Math.PI * 2;
      const r = 0.78 + Math.random() * 0.24;
      const y = (Math.random() - 0.5) * H * 0.78;
      drop.position.set(Math.cos(ang) * r, y, Math.sin(ang) * r);
      rotor.add(drop);
      heavyParticles.push(drop);
    }
    const lightParticles = [];
    const lightDropGeo = new THREE.SphereGeometry(0.014, 6, 6);
    const lightDropMat = new THREE.MeshStandardMaterial({ color: 0xBDEEF7, emissive: COLORS.light, emissiveIntensity: 0.25, roughness: 0.5 });
    for (let i = 0; i < 24; i++) {
      const drop = new THREE.Mesh(lightDropGeo, lightDropMat);
      const ang = Math.random() * Math.PI * 2;
      const r = 0.08 + Math.random() * 0.44;
      const y = (Math.random() - 0.5) * H * 0.78;
      drop.position.set(Math.cos(ang) * r, y, Math.sin(ang) * r);
      rotor.add(drop);
      lightParticles.push(drop);
    }

    dynamic.decanter = {
      rotor, lightPhase, heavyPhase, iface, ifaceRingTop, ifaceRingBot, weirA, weirB, H,
      shell, shellGlassMat, shellOpaqueMat, braceRings,
      heavyParticles, lightParticles,
      riObjetivo: NaN, riAnimado: NaN // radio de interfase (unidades de escena): objetivo de equilibrio vs. posición animada actual
    };
    g.rotation.x = 0.05;
    return g;
  }

  // Fija el nuevo objetivo de equilibrio (rA, rB, ri de equilibrio ya
  // calculados por Engine.zonaNeutra). NO mueve la geometría de inmediato:
  // eso lo hace stepDecanter() en cada frame relajando riAnimado → riObjetivo,
  // para que el usuario vea la interfase migrar suavemente al ajustar sliders.
  function updateDecanter(zn, scaleR) {
    const d = dynamic.decanter;
    if (!d.rotor || !zn.valido) return;
    const H = d.H;
    const rA = zn.rA * scaleR, rB = zn.rB * scaleR;

    d.heavyPhase.geometry.dispose();
    d.heavyPhase.geometry = new THREE.CylinderGeometry(rA, rA, H * 0.86, 40, 1, true);
    d.lightPhase.geometry.dispose();
    d.lightPhase.geometry = new THREE.CylinderGeometry(rB, rB, H * 0.86, 40, 1, true);
    d.weirA.geometry.dispose();
    d.weirA.geometry = new THREE.TorusGeometry(rA, 0.022, 10, 40);
    d.weirB.geometry.dispose();
    d.weirB.geometry = new THREE.TorusGeometry(rB, 0.022, 10, 40);

    d.riObjetivo = zn.ri * scaleR;
    if (Number.isNaN(d.riAnimado)) d.riAnimado = d.riObjetivo; // primer render: sin transición
    d.unstable = zn.inestable;
  }

  // Avanza un paso de la relajación temporal de la interfase y aplica la
  // geometría resultante. Se llama desde el loop de animación con el dt
  // real de simulación (afectado por Play/Pausa/Velocidad).
  function stepDecanter(dtSim) {
    const d = dynamic.decanter;
    if (!d.rotor || Number.isNaN(d.riObjetivo)) return;
    d.riAnimado = Engine.relajarZonaNeutra({ riActual: d.riAnimado, riObjetivo: d.riObjetivo, dt: dtSim });
    const H = d.H, ri = d.riAnimado;
    d.iface.geometry.dispose();
    d.iface.geometry = new THREE.CylinderGeometry(ri, ri, H * 0.87, 48, 1, true);
    d.ifaceRingTop.geometry.dispose();
    d.ifaceRingTop.geometry = new THREE.TorusGeometry(ri, 0.012, 8, 48);
    d.ifaceRingBot.geometry.dispose();
    d.ifaceRingBot.geometry = new THREE.TorusGeometry(ri, 0.012, 8, 48);
  }

  // -----------------------------------------------------------------------
  // MODELO 2 — PURIFICADOR DE TAZÓN (bowl centrifuge)
  // Superficie líquida virtualmente cilíndrica + partículas sedimentando
  // radialmente hacia la pared según Stokes centrífugo.
  // -----------------------------------------------------------------------
  function buildBowl() {
    const g = new THREE.Group();
    const H = 1.5;

    // Carcasa — acero de proceso con ventanilla de inspección. Se guardan
    // ambos materiales (opaco/traslúcido) para alternar en setViewMode().
    const shellGlassMat = steelGlassMaterial({ color: COLORS.shell, opacity: 0.12 });
    const shellOpaqueMat = steelShellOpaqueMaterial({ color: COLORS.shell });
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.15, H, 48, 1, true),
      shellGlassMat
    );
    g.add(shell);
    [-H * 0.4, H * 0.4].forEach((y) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.026, 10, 48), steelMaterial({ roughness: 0.28 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = y;
      g.add(ring);
    });
    g.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(1.15, 1.15, H, 32, 1)),
      new THREE.LineBasicMaterial({ color: COLORS.shellWire, transparent: true, opacity: 0.4 })
    ));

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, H + 0.5, 20),
      steelMaterial({ color: COLORS.shaft, roughness: 0.18, metalness: 0.95 })
    );
    g.add(shaft);

    const rotor = new THREE.Group();
    g.add(rotor);

    // Superficie líquida virtualmente cilíndrica (concepto clave McCabe & Smith:
    // a alta ω la gravedad es despreciable frente a la fuerza centrífuga, por
    // lo que la superficie libre del líquido es un cilindro vertical, no un
    // plano horizontal como en reposo)
    const liquidGeo = new THREE.CylinderGeometry(0.95, 0.95, H * 0.82, 48, 1, true);
    const liquidMat = new THREE.MeshPhysicalMaterial({
      color: COLORS.light, transparent: true, opacity: 0.32,
      side: THREE.DoubleSide, roughness: 0.08, transmission: 0.35,
      envMap, envMapIntensity: 0.6
    });
    const liquidSurface = new THREE.Mesh(liquidGeo, liquidMat);
    rotor.add(liquidSurface);

    const surfRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.01, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 })
    );
    surfRing.rotation.x = Math.PI / 2; surfRing.position.y = H * 0.41;
    rotor.add(surfRing);

    // Torta de sólidos depositada en la pared — crece con el tiempo según
    // la concentración acumulada (ver stepBowl)
    const cakeGeo = new THREE.CylinderGeometry(1.13, 1.13, H * 0.02, 40, 1, true);
    const cakeMat = new THREE.MeshStandardMaterial({ color: COLORS.solids, transparent: true, opacity: 0.85, side: THREE.DoubleSide, roughness: 0.9 });
    const cake = new THREE.Mesh(cakeGeo, cakeMat);
    cake.visible = false;
    rotor.add(cake);

    // ENJAMBRE DE SEDIMENTACIÓN — cada esfera es una partícula real que
    // avanza radialmente según la física de Stokes centrífugo (calculada
    // en main.js/stepBowlSim con Engine.drdt, igual que el trazador). Solo
    // avanzan mientras el cronómetro de simulación está en Play; por eso
    // "sedimentan" de verdad con el tiempo de proceso y no con animación
    // decorativa. Ángulo y altura son fijos por partícula (solo r cambia),
    // lo que deja leer con claridad el barrido radial hacia la pared.
    const particles = [];
    const particleGeo = new THREE.SphereGeometry(0.016, 8, 8);
    const particleMat = new THREE.MeshStandardMaterial({ color: COLORS.solids, emissive: COLORS.solids, emissiveIntensity: 0.22, roughness: 0.6 });
    const N_PARTICLES = 70;
    for (let i = 0; i < N_PARTICLES; i++) {
      const p = new THREE.Mesh(particleGeo, particleMat);
      const ang = Math.random() * Math.PI * 2;
      const y = (Math.random() - 0.5) * H * 0.7;
      p.userData = { ang, y };
      p.position.set(0.08, y, 0);
      rotor.add(p);
      particles.push(p);
    }

    // Partícula TRAZADORA — su posición radial es exactamente r(t) de
    // Engine.trayectoriaSedimentacion / pasoSedimentacion, la que se lee
    // en Gráfica 1. Más grande, con emisión fuerte y una estela (trail)
    // de puntos que marca el camino recorrido, para lectura pedagógica clara.
    const tracerGeo = new THREE.SphereGeometry(0.038, 16, 16);
    const tracerMat = new THREE.MeshStandardMaterial({ color: 0xF4F1EA, emissive: 0xF4F1EA, emissiveIntensity: 0.55, roughness: 0.3 });
    const tracer = new THREE.Mesh(tracerGeo, tracerMat);
    tracer.userData = { ang: 0.4, y: 0 };
    rotor.add(tracer);

    const trailCount = 24;
    const trailGeo = new THREE.SphereGeometry(0.013, 6, 6);
    const trail = [];
    for (let i = 0; i < trailCount; i++) {
      const m = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ color: 0xF4F1EA, transparent: true, opacity: 0 }));
      rotor.add(m);
      trail.push({ mesh: m, r: 0, active: false });
    }

    dynamic.bowl = {
      rotor, liquidSurface, surfRing, cake, particles, tracer, trail, trailCount, H,
      shell, shellGlassMat, shellOpaqueMat,
      wallR: 1.13, // radio de escena de la pared (== r2 escalado)
      tracerRScene: NaN, // radio actual del trazador en unidades de escena
      trailTimer: 0, trailIdx: 0,
      cakeThickness: 0 // crece con la concentración acumulada en pared
    };
    g.rotation.x = 0.05;
    return g;
  }

  // Coloca cada partícula del enjambre en su radio de escena actual
  // (radiiScene[i], en el mismo orden que dynamic.bowl.particles).
  // Llamado desde main.js/stepBowlSim con el resultado real de la
  // integración física — así el enjambre sedimenta al ritmo del
  // cronómetro de simulación (Play/Pausa/Velocidad), no de forma libre.
  function setBowlSwarm(radiiScene) {
    const d = dynamic.bowl;
    if (!d.rotor) return;
    d.particles.forEach((p, i) => {
      const r = radiiScene[i];
      if (r === undefined) return;
      const ud = p.userData;
      p.position.set(Math.cos(ud.ang) * r, ud.y, Math.sin(ud.ang) * r);
    });
  }

  function resetBowlSwarm() {
    const d = dynamic.bowl;
    if (!d.rotor) return;
    d.particles.forEach((p) => { p.position.set(0.08, p.userData.y, 0); });
  }

  // Coloca al trazador en un radio de escena específico (llamado desde
  // main.js con el r(t) real que produce el motor de integración) y
  // actualiza su estela dejando un punto cada cierto intervalo.
  function setBowlTracerRadius(rScene, dtSim) {
    const d = dynamic.bowl;
    if (!d.rotor) return;
    d.tracerRScene = rScene;
    const ang = d.tracer.userData.ang;
    d.tracer.position.set(Math.cos(ang) * rScene, d.tracer.userData.y, Math.sin(ang) * rScene);

    d.trailTimer += dtSim;
    if (d.trailTimer > 0.35) {
      d.trailTimer = 0;
      const slot = d.trail[d.trailIdx % d.trailCount];
      slot.r = rScene;
      slot.active = true;
      slot.mesh.position.copy(d.tracer.position);
      slot.mesh.material.opacity = 0.55;
      d.trailIdx++;
    }
  }

  // Hace crecer visualmente la torta de sólidos según la concentración
  // acumulada en la pared (0..1, viene de main.js integrando llegadas).
  function setBowlCake(fraction) {
    const d = dynamic.bowl;
    if (!d.rotor || !d.cake) return;
    const thickness = Math.max(0.001, fraction) * (d.H * 0.5);
    if (Math.abs(thickness - d.cakeThickness) < 0.003) return;
    d.cakeThickness = thickness;
    d.cake.visible = fraction > 0.01;
    d.cake.geometry.dispose();
    d.cake.geometry = new THREE.CylinderGeometry(1.13, 1.13, thickness, 40, 1, true);
  }

  function resetBowlTracer() {
    const d = dynamic.bowl;
    if (!d.rotor) return;
    d.tracerRScene = NaN;
    d.trailTimer = 0; d.trailIdx = 0;
    d.trail.forEach((slot) => { slot.active = false; slot.mesh.material.opacity = 0; });
    setBowlCake(0);
  }

  // -----------------------------------------------------------------------
  // MODELO 3 — BOMBA CENTRÍFUGA (corte transversal)
  // Impulsor con álabes, voluta en espiral, succión axial y descarga
  // tangencial.
  // -----------------------------------------------------------------------
  function buildPump() {
    const g = new THREE.Group();

    // Voluta (carcasa espiral) — generada como tubo extruido siguiendo
    // una espiral de Arquímedes creciente, la forma clásica de voluta
    const spiralPts = [];
    const turns = 1.0, steps = 90, rStart = 0.55, rGrowth = 0.62;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ang = t * turns * Math.PI * 2 - Math.PI * 0.15;
      const r = rStart + rGrowth * t;
      spiralPts.push(new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r));
    }
    const spiralCurve = new THREE.CatmullRomCurve3(spiralPts);
    const voluteGeo = new THREE.TubeGeometry(spiralCurve, 120, 0.11, 12, false);
    const volute = new THREE.Mesh(voluteGeo, steelMaterial({ color: COLORS.volute, roughness: 0.3, metalness: 0.85 }));
    g.add(volute);

    // Corte: mitad frontal de la voluta oculta para ver el interior
    volute.userData.baseGeo = voluteGeo;

    // Carcasa frontal (disco de acero con ventanilla, se oculta en modo "corte")
    const frontDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1.25, 48),
      steelGlassMaterial({ color: COLORS.shell, opacity: 0.14 })
    );
    frontDisc.rotation.x = Math.PI / 2;
    frontDisc.position.y = 0.16;
    g.add(frontDisc);

    // Impulsor con álabes curvos — acero pulido de precisión
    const impeller = new THREE.Group();
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.14, 20),
      steelMaterial({ color: COLORS.shaft, roughness: 0.22 })
    );
    impeller.add(hub);

    const shroud = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 0.02, 40),
      steelMaterial({ color: COLORS.impeller, roughness: 0.3, opacity: 0.92, transparent: true })
    );
    shroud.position.y = 0.06;
    impeller.add(shroud);

    const nBlades = 7;
    const blades = [];
    for (let i = 0; i < nBlades; i++) {
      const ang0 = (i / nBlades) * Math.PI * 2;
      const bladeShape = new THREE.Shape();
      bladeShape.moveTo(0.12, -0.03);
      bladeShape.quadraticCurveTo(0.32, -0.1, 0.48, -0.02);
      bladeShape.lineTo(0.48, 0.02);
      bladeShape.quadraticCurveTo(0.32, -0.05, 0.12, 0.03);
      bladeShape.lineTo(0.12, -0.03);
      const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, { depth: 0.11, bevelEnabled: false });
      bladeGeo.rotateX(Math.PI / 2);
      bladeGeo.translate(0, -0.055, 0);
      const blade = new THREE.Mesh(bladeGeo, steelMaterial({ color: COLORS.impeller, roughness: 0.26 }));
      blade.rotation.y = ang0;
      impeller.add(blade);
      blades.push(blade);
    }
    g.add(impeller);

    // Eje de accionamiento — acero pulido
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1.1, 20),
      steelMaterial({ color: COLORS.shaft, roughness: 0.2, metalness: 0.95 })
    );
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = 0.6;
    g.add(shaft);

    // Tubería de succión (axial, entra por el centro)
    const suction = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.9, 24, 1, true),
      new THREE.MeshPhysicalMaterial({ color: COLORS.light, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    suction.rotation.x = Math.PI / 2;
    suction.position.z = -0.75;
    g.add(suction);
    // Flecha de flujo de succión
    g.add(makeFlowArrow(new THREE.Vector3(0, 0, -1.15), new THREE.Vector3(0, 0, 1), COLORS.light));

    // Tubería de descarga (tangencial, sale por la voluta)
    const dischargeAngle = 1.0 * Math.PI * 2 - Math.PI * 0.15;
    const dischargeR = rStart + rGrowth * 1.0;
    const dischargeDir = new THREE.Vector3(Math.cos(dischargeAngle), 0, Math.sin(dischargeAngle)).normalize();
    const discharge = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 0.7, 20, 1, true),
      new THREE.MeshPhysicalMaterial({ color: COLORS.heavy, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    discharge.position.copy(dischargeDir.clone().multiplyScalar(dischargeR + 0.35));
    discharge.lookAt(dischargeDir.clone().multiplyScalar(dischargeR + 2));
    discharge.rotateX(Math.PI / 2);
    g.add(discharge);
    g.add(makeFlowArrow(
      dischargeDir.clone().multiplyScalar(dischargeR + 0.75),
      dischargeDir,
      COLORS.heavy
    ));

    // Líneas de flujo espiral dentro de la voluta (partículas de fluido)
    const flowDots = [];
    const flowDotGeo = new THREE.SphereGeometry(0.018, 6, 6);
    const flowDotMat = new THREE.MeshBasicMaterial({ color: COLORS.light, transparent: true, opacity: 0.9 });
    for (let i = 0; i < 28; i++) {
      const dot = new THREE.Mesh(flowDotGeo, flowDotMat);
      dot.userData = { t: i / 28 };
      g.add(dot);
      flowDots.push(dot);
    }

    dynamic.pump = {
      impeller, blades, volute, frontDisc, flowDots, spiralCurve, rStart, rGrowth, turns,
      omegaObjetivo: NaN, omegaAnimada: NaN, // rad/s — objetivo instantáneo vs. arranque suavizado (relajarOmega)
      flowSpeedFactor: 1 // proporcional a (omegaAnimada/omegaObjetivo)³ aprox — el flujo tarda en establecerse igual que la presión
    };
    g.rotation.x = 0.35;
    g.rotation.y = 0.3;
    return g;
  }

  // Fija el nuevo objetivo de velocidad angular (rad/s, ya calculado por
  // Engine.rpmToOmega en main.js). El arranque real —cómo omegaAnimada se
  // aproxima a este objetivo— lo resuelve stepPump() cuadro a cuadro.
  function updatePumpTarget(omegaObjetivo) {
    const d = dynamic.pump;
    if (!d) return;
    d.omegaObjetivo = omegaObjetivo;
    if (Number.isNaN(d.omegaAnimada)) d.omegaAnimada = omegaObjetivo;
  }

  function stepPump(dtSim) {
    const d = dynamic.pump;
    if (!d || Number.isNaN(d.omegaObjetivo)) return null;
    d.omegaAnimada = Engine.relajarOmega({ omegaActual: d.omegaAnimada, omegaObjetivo: d.omegaObjetivo, dt: dtSim });
    const ratio = d.omegaObjetivo > 0 ? d.omegaAnimada / d.omegaObjetivo : 1;
    d.flowSpeedFactor = Math.max(0.05, ratio);
    return d.omegaAnimada;
  }

  function makeFlowArrow(pos, dir, color) {
    const arrow = new THREE.ArrowHelper(dir.normalize(), pos, 0.4, color, 0.14, 0.08);
    return arrow;
  }

  // Etiqueta de texto simple como sprite (canvas 2D → textura)
  function makeLabelSprite(text, color, position) {
    const cnv = document.createElement("canvas");
    cnv.width = 128; cnv.height = 64;
    const ctx = cnv.getContext("2d");
    ctx.font = "600 30px 'JetBrains Mono', monospace";
    const hex = "#" + color.toString(16).padStart(6, "0");
    ctx.fillStyle = hex;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, 64, 32);
    const tex = new THREE.CanvasTexture(cnv);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.4, 0.2, 1);
    sprite.position.copy(position);
    sprite.renderOrder = 999;
    return sprite;
  }

  // -----------------------------------------------------------------------
  // Selección de equipo activo
  // -----------------------------------------------------------------------
  function setEquip(name) {
    currentEquip = name;
    for (const key in groups) {
      groups[key].visible = (key === name);
    }
    resetCamera();
  }

  function setSpinning(v) { spinning = v; }

  // Alterna entre "Vista industrial" (carcasa cerrada y opaca, aspecto de
  // equipo real en planta) y "Vista interior" (carcasa traslúcida tipo
  // corte, para observar fases, partículas y trazadores en movimiento).
  // No se regenera geometría: solo se intercambian los materiales/opacidad
  // de la carcasa de cada equipo, así el cambio es instantáneo y barato.
  function setViewMode(mode) {
    viewMode = mode;
    crossSection = mode === "interior";

    const dDec = dynamic.decanter;
    if (dDec.shell) {
      dDec.shell.material = crossSection ? dDec.shellGlassMat : dDec.shellOpaqueMat;
    }
    const dBowl = dynamic.bowl;
    if (dBowl.shell) {
      dBowl.shell.material = crossSection ? dBowl.shellGlassMat : dBowl.shellOpaqueMat;
    }
    if (dynamic.pump.frontDisc) dynamic.pump.frontDisc.visible = !crossSection;
  }

  // Alias retrocompatible (algún llamador antiguo podría usar el nombre previo)
  function setCrossSection(v) { setViewMode(v ? "interior" : "industrial"); }

  // -----------------------------------------------------------------------
  // Loop de animación
  // -----------------------------------------------------------------------
  function animate() {
    animId = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1); // clamp: evita saltos grandes si la pestaña estuvo en background
    const t = clock.getElapsedTime();

    if (frameCallback) frameCallback(dt);

    // Desvanecimiento gradual de la estela del trazador (independiente de spinning)
    if (currentEquip === "bowl" && dynamic.bowl.trail) {
      dynamic.bowl.trail.forEach((slot) => {
        if (slot.active && slot.mesh.material.opacity > 0) {
          slot.mesh.material.opacity = Math.max(0, slot.mesh.material.opacity - dt * 0.18);
        }
      });
    }

    if (spinning) {
      if (currentEquip === "decanter" && dynamic.decanter.rotor) {
        dynamic.decanter.rotor.rotation.y += dt * 1.4;
        // Parpadeo de alerta en interfase si inestable
        if (dynamic.decanter.unstable) {
          const pulse = (Math.sin(t * 6) + 1) / 2;
          dynamic.decanter.iface.material.emissive.setRGB(1, pulse * 0.2, pulse * 0.2);
          dynamic.decanter.iface.material.emissiveIntensity = 0.3 + pulse * 0.4;
          dynamic.decanter.iface.material.color.setHex(0xE5484D);
        } else {
          dynamic.decanter.iface.material.emissiveIntensity = 0.15;
          dynamic.decanter.iface.material.color.setHex(COLORS.interface);
        }
      }
      if (currentEquip === "bowl" && dynamic.bowl.rotor) {
        dynamic.bowl.rotor.rotation.y += dt * 1.6;
      }
      if (currentEquip === "pump" && dynamic.pump.impeller) {
        // La velocidad visual de giro y de las partículas de flujo sigue el
        // arranque real (flowSpeedFactor = ω_animada/ω_objetivo), no un
        // valor fijo: durante el arranque ambos se ven acelerar gradualmente.
        const fsf = dynamic.pump.flowSpeedFactor || 1;
        dynamic.pump.impeller.rotation.y += dt * 5.2 * fsf;
        dynamic.pump.flowDots.forEach((dot) => {
          dot.userData.t = (dot.userData.t + dt * 0.18 * fsf) % 1;
          const ang = dot.userData.t * dynamic.pump.turns * Math.PI * 2 - Math.PI * 0.15;
          const r = dynamic.pump.rStart + dynamic.pump.rGrowth * dot.userData.t;
          dot.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r);
        });
      }
    }

    if (!renderPaused) renderer.render(scene, camera);
  }

  // -----------------------------------------------------------------------
  // Resize responsivo
  // -----------------------------------------------------------------------
  function resize() {
    const canvas = renderer.domElement;
    const parent = canvas.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return {
    init, resize, setEquip, setSpinning, setCrossSection, setViewMode, resetCamera,
    updateDecanter,
    setFrameCallback, setRenderPaused,
    stepDecanter,
    setBowlTracerRadius, setBowlCake, resetBowlTracer,
    setBowlSwarm, resetBowlSwarm,
    updatePumpTarget, stepPump,
    get dynamic() { return dynamic; },
    get currentEquip() { return currentEquip; },
    // Expuesto para ar.js: necesita reparentar temporalmente el grupo del
    // equipo activo desde la escena principal hacia la escena AR (y de
    // vuelta al salir), reutilizando las MISMAS mallas — así toda la
    // física/animación que ya corre en el motor de simulación (rotor
    // girando, interfase migrando, trazador sedimentando, arranque de la
    // bomba) se refleja automáticamente en AR sin duplicar lógica.
    get groups() { return groups; },
    get scene() { return scene; },
    get COLORS() { return COLORS; }
  };
})();
