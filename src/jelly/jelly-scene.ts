import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createGhostGeometry } from "./ghost-geometry";
import { DEFAULT_PARAMS, SoftBody, type SoftBodyParams } from "./soft-body";

export type JellyStats = { fps: number; particles: number; springs: number; asleep: boolean; pixelRatio: number };

export type JellyController = {
  setParams(p: Partial<SoftBodyParams>): void;
  getParams(): SoftBodyParams;
  reset(): void;
  setVisible(visible: boolean): void;
  getStats(): JellyStats;
  dispose(): void;
};

type Options = {
  mobile: boolean;
  reducedMotion: boolean;
  onReady(): void;
  onContextLost(): void;
  onFirstInteraction(): void;
};

const FOV = 30;
const FLOOR_Y = -1.8;

export function createJellyScene(container: HTMLElement, opts: Options): JellyController {
  const { mobile, reducedMotion } = opts;

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  const maxPixelRatio = mobile ? 1.5 : 2;
  let pixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  // Let vertical page scrolls through; we cancel them only when a touch lands on the ghost.
  canvas.style.touchAction = "pan-y";
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envMap = pmrem.fromScene(room, 0.04).texture;
  room.dispose?.();
  pmrem.dispose();
  scene.environment = envMap;

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);

  // Lights: cool key, magenta rim from behind, teal fill.
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  const rim = new THREE.DirectionalLight(0xff4fb8, 2.4);
  rim.position.set(-4, 2, -5);
  const fill = new THREE.DirectionalLight(0x4fe3d0, 0.9);
  fill.position.set(-4, -1, 3);
  scene.add(key, rim, fill, new THREE.HemisphereLight(0xcfd8ff, 0x2a1840, 0.5));

  // --- Soft body -----------------------------------------------------------
  const geometry = createGhostGeometry(mobile ? 10 : 12);
  const posAttr = geometry.attributes.position as THREE.BufferAttribute;
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const body = new SoftBody(posAttr.array as Float32Array, geometry.index!.array, DEFAULT_PARAMS);

  // Entrance: start squashed so the ghost wobbles into shape as it fades in.
  if (!reducedMotion) {
    const p = body.pos;
    for (let i = 0; i < p.length; i += 3) {
      p[i] *= 1.12;
      p[i + 1] = p[i + 1] * 0.78 - 0.15;
      p[i + 2] *= 1.12;
    }
  }

  const ghost = new THREE.Group();
  scene.add(ghost);

  // One jelly surface. Translucency is faked in the shader instead of with
  // a transmission pass (too heavy for phones): the face-on centre glows pale
  // and milky, edges deepen to teal with a coloured rim, and the body stays
  // almost opaque so the dark background never muddies it into grey.
  const shellMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xbdf7e8,
    roughness: 0.14,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.1,
    transparent: true,
    opacity: 0.94,
  });
  shellMaterial.onBeforeCompile = (shader) => {
    // The tail fades out: drips get more see-through and glow teal toward the tips.
    shader.uniforms.uTailTop = { value: geometry.userData.tailTop };
    shader.uniforms.uTailBottom = { value: geometry.userData.tailBottom };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vLocalY;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLocalY = position.y;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vLocalY;\nuniform float uTailTop;\nuniform float uTailBottom;")
      .replace(
      "#include <opaque_fragment>",
      /* glsl */ `
        float facing = saturate(dot(normal, normalize(vViewPosition)));
        float fres = pow(1.0 - facing, 2.0);
        // Keep the lighting's highlights (specular, clearcoat) but replace its
        // diffuse part with our own jelly colour, which would otherwise blow out
        // to white under the environment light.
        vec3 diffusePart = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
        vec3 specPart = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
        vec3 extras = max(outgoingLight - diffusePart - specPart, 0.0);
        float shade = 0.6 + 0.4 * saturate(dot(diffusePart, vec3(0.299, 0.587, 0.114)));
        // Subsurface: milky where the jelly is thickest (face-on), deep teal at the edges.
        vec3 body = mix(vec3(0.01, 0.16, 0.22), vec3(0.34, 0.82, 0.68), smoothstep(0.0, 0.95, facing)); // linear space
        // Rim light: teal low, magenta toward the top, echoing the site accents.
        vec3 rimColor = mix(vec3(0.3, 1.0, 0.88), vec3(1.0, 0.45, 0.85), smoothstep(-0.1, 0.9, normal.y));
        float tail = smoothstep(uTailTop, uTailBottom, vLocalY);
        body = mix(body, vec3(0.05, 0.55, 0.52), tail * 0.45);
        outgoingLight = body * shade + specPart * 0.45 + extras * 0.5 + rimColor * fres * 1.2;
        outgoingLight += vec3(0.1, 0.75, 0.65) * pow(tail, 2.0) * 0.35;
        diffuseColor.a = mix(diffuseColor.a, 1.0, fres);
        diffuseColor.a *= 1.0 - 0.3 * pow(tail, 2.0);
        #include <opaque_fragment>
      `,
    );
  };
  const shell = new THREE.Mesh(geometry, shellMaterial);
  shell.frustumCulled = false;
  ghost.add(shell);

  // Soft ghostly aura: back faces of the same deforming mesh, drawn slightly
  // larger and additively, fading to nothing at the silhouette.
  const auraMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(0x5ff0d8) } },
    vertexShader: /* glsl */ `
      varying float vFacing;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vFacing = abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vFacing;
      void main() {
        float a = pow(vFacing, 2.0) * 0.7;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
  });
  const aura = new THREE.Mesh(geometry, auraMaterial);
  aura.scale.setScalar(1.18);
  aura.frustumCulled = false;
  aura.renderOrder = -1;
  ghost.add(aura);

  // Eyes ride on the surface: each follows a weighted patch of particles.
  const eyeMaterial = new THREE.MeshPhysicalMaterial({ color: 0x160f24, roughness: 0.15, clearcoat: 1 });
  const eyeGeometry = new THREE.SphereGeometry(0.1, 20, 14);
  const face = geometry.userData.face as { x: number; y: number };
  const eyes = [-0.3, 0.3].map((ex) => {
    const mesh = new THREE.Mesh(eyeGeometry, eyeMaterial);
    ghost.add(mesh);
    return { mesh, ...surfacePatch(body.rest, geometry.attributes.normal.array as Float32Array, face.x + ex, face.y) };
  });

  // --- Floor: soft light pool + contact shadow ------------------------------
  const floorGeo = new THREE.PlaneGeometry(1, 1);
  const glow = new THREE.Mesh(
    floorGeo,
    new THREE.MeshBasicMaterial({
      map: radialTexture("rgba(200,170,255,0.45)", "rgba(200,170,255,0)"),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = FLOOR_Y - 0.001;
  glow.scale.set(4.2, 2.4, 1);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: radialTexture("rgba(12,6,28,0.9)", "rgba(12,6,28,0)"),
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const shadow = new THREE.Mesh(floorGeo, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = FLOOR_Y;
  scene.add(glow, shadow);

  // --- Layout ----------------------------------------------------------------
  let width = 1;
  let height = 1;
  function layout() {
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    const aspect = width / height;
    const wide = aspect >= 1.05;
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    // Visible height at the ghost's depth, and where on screen its centre sits.
    const visibleH = wide ? 5.8 : Math.max(6, 3.6 / aspect);
    const dist = visibleH / 2 / tan;
    camera.aspect = aspect;
    camera.position.set(0, 0.45, dist);
    camera.lookAt(0, -0.1, 0);
    const offX = wide ? 0.24 * width : 0;
    const offY = wide ? 0 : 0.17 * height;
    camera.setViewOffset(width, height, -offX, -offY, width, height);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }
  const ro = new ResizeObserver(layout);
  ro.observe(container);
  layout();

  // --- Pointer interaction ---------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const dragPlanes = new Map<number, { plane: THREE.Plane; world: THREE.Vector3 }>();
  let interacted = false;

  function setRay(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
  }

  function hitTest(e: PointerEvent) {
    setRay(e);
    ghost.updateMatrixWorld();
    return raycaster.intersectObject(shell, false)[0];
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const hit = hitTest(e);
    if (!hit) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const normal = tmp.copy(raycaster.ray.direction).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
    dragPlanes.set(e.pointerId, { plane, world: hit.point.clone() });
    const local = ghost.worldToLocal(hit.point.clone());
    const push = raycaster.ray.direction.clone().transformDirection(new THREE.Matrix4().copy(ghost.matrixWorld).invert());
    body.grab(e.pointerId, [local.x, local.y, local.z], [push.x, push.y, push.z]);
    container.style.cursor = "grabbing";
    if (!interacted) {
      interacted = true;
      opts.onFirstInteraction();
    }
    wake();
  }

  let hoverQueued: PointerEvent | null = null;
  function onPointerMove(e: PointerEvent) {
    const drag = dragPlanes.get(e.pointerId);
    if (!drag) {
      if (e.pointerType === "mouse") hoverQueued = e;
      return;
    }
    setRay(e);
    if (raycaster.ray.intersectPlane(drag.plane, tmp2)) drag.world.copy(tmp2);
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragPlanes.has(e.pointerId)) return;
    dragPlanes.delete(e.pointerId);
    body.release(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    container.style.cursor = "grab";
  }

  // Pointer events fire before touch events, so by the time touchstart runs we
  // already know whether the finger landed on the ghost.
  function onTouch(e: TouchEvent) {
    if (dragPlanes.size > 0) e.preventDefault();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("lostpointercapture", onPointerUp);
  canvas.addEventListener("touchstart", onTouch, { passive: false });
  canvas.addEventListener("touchmove", onTouch, { passive: false });

  // --- Loop ------------------------------------------------------------------
  let raf = 0;
  let visible = true;
  let pageVisible = document.visibilityState === "visible";
  let last = 0;
  let time = 0;
  let nextBlink = 2.5;
  let fps = 60;
  let slowFrames = 0;
  let ready = false;
  const up = new THREE.Vector3(0, 0, 1);
  const n = new THREE.Vector3();

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
    last = now;
    time += dt;
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
    adaptQuality(dt);

    // Idle float. Applied to the group, not the particles, so physics can sleep.
    if (!reducedMotion) {
      ghost.position.y = Math.sin(time * 1.4) * 0.09;
      ghost.rotation.z = Math.sin(time * 0.9) * 0.035;
    }
    ghost.updateMatrixWorld();

    for (const [id, drag] of dragPlanes) {
      const local = ghost.worldToLocal(tmp.copy(drag.world));
      body.moveGrab(id, [local.x, local.y, local.z]);
    }

    if (hoverQueued) {
      container.style.cursor = hitTest(hoverQueued) ? "grab" : "";
      hoverQueued = null;
    }

    if (body.update(dt)) {
      posAttr.needsUpdate = true;
      geometry.computeVertexNormals();
    }

    updateEyes(dt);
    updateShadow();
    renderer.render(scene, camera);

    if (!ready) {
      ready = true;
      opts.onReady();
    }
  }

  function updateEyes(dt: number) {
    nextBlink -= dt;
    let blink = 1;
    if (!reducedMotion && nextBlink < 0) {
      const t = -nextBlink / 0.16;
      blink = t < 1 ? Math.abs(1 - 2 * t) * 0.9 + 0.1 : 1;
      if (t >= 1) nextBlink = 2.5 + Math.random() * 3.5;
    }
    const p = body.pos;
    const normals = geometry.attributes.normal.array as Float32Array;
    for (const eye of eyes) {
      tmp.set(0, 0, 0);
      n.set(0, 0, 0);
      eye.ids.forEach((id, k) => {
        const w = eye.weights[k];
        tmp.x += p[id * 3] * w;
        tmp.y += p[id * 3 + 1] * w;
        tmp.z += p[id * 3 + 2] * w;
        n.x += normals[id * 3] * w;
        n.y += normals[id * 3 + 1] * w;
        n.z += normals[id * 3 + 2] * w;
      });
      n.normalize();
      eye.mesh.position.copy(tmp).addScaledVector(n, 0.012);
      eye.mesh.quaternion.setFromUnitVectors(up, n);
      eye.mesh.scale.set(0.85, 1.2 * blink, 0.35);
    }
  }

  function updateShadow() {
    const p = body.pos;
    let minY = Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      sx += p[i];
      sz += p[i + 2];
    }
    const count = p.length / 3;
    const bottom = minY + ghost.position.y;
    const h = Math.max(0, bottom - FLOOR_Y);
    const spread = (maxX - minX) * (0.95 + h * 0.35);
    shadow.position.x = ghost.position.x + sx / count;
    shadow.position.z = sz / count;
    shadow.scale.set(spread, spread * 0.55, 1);
    shadowMaterial.opacity = THREE.MathUtils.clamp(0.95 - h * 0.9, 0.15, 0.95);
  }

  // Drop resolution if the device can't hold frame rate.
  function adaptQuality(dt: number) {
    if (pixelRatio <= 1) return;
    slowFrames = dt > 1 / 45 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
    if (slowFrames > 45) {
      slowFrames = 0;
      pixelRatio = Math.max(1, pixelRatio - 0.25);
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
    }
  }

  function wake() {
    body.wake();
    start();
  }

  function start() {
    if (raf || !visible || !pageVisible) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function onVisibility() {
    pageVisible = document.visibilityState === "visible";
    if (pageVisible) start();
    else {
      stop();
      for (const id of dragPlanes.keys()) body.release(id);
      dragPlanes.clear();
    }
  }
  document.addEventListener("visibilitychange", onVisibility);

  function onContextLost(e: Event) {
    e.preventDefault();
    stop();
    opts.onContextLost();
  }
  canvas.addEventListener("webglcontextlost", onContextLost);

  start();

  return {
    setParams(p) {
      body.setParams(p);
      start();
    },
    getParams: () => ({ ...body.params }),
    reset() {
      body.reset();
      dragPlanes.clear();
      start();
    },
    setVisible(v) {
      visible = v;
      if (v) start();
      else stop();
    },
    getStats: () => ({
      fps: raf ? Math.round(fps) : 0,
      particles: body.count,
      springs: body.edgeCount,
      asleep: body.asleep,
      pixelRatio,
    }),
    dispose() {
      stop();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("lostpointercapture", onPointerUp);
      canvas.removeEventListener("touchstart", onTouch);
      canvas.removeEventListener("touchmove", onTouch);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      geometry.dispose();
      eyeGeometry.dispose();
      floorGeo.dispose();
      for (const m of [shellMaterial, auraMaterial, eyeMaterial, shadowMaterial, glow.material]) {
        (m as THREE.MeshBasicMaterial).map?.dispose();
        m.dispose();
      }
      envMap.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}

/** Nearest front-facing particles to (x, y) on the rest pose, with smooth weights. */
function surfacePatch(rest: Float32Array, normals: Float32Array, x: number, y: number) {
  const scored: { id: number; d: number }[] = [];
  for (let i = 0; i < rest.length / 3; i++) {
    if (normals[i * 3 + 2] < 0.3) continue;
    scored.push({ id: i, d: Math.hypot(rest[i * 3] - x, rest[i * 3 + 1] - y) });
  }
  scored.sort((a, b) => a.d - b.d);
  const picked = scored.slice(0, 4);
  const raw = picked.map((s) => 1 / (s.d + 0.02));
  const total = raw.reduce((a, b) => a + b, 0);
  return { ids: picked.map((s) => s.id), weights: raw.map((w) => w / total) };
}

function radialTexture(inner: string, outer: string) {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
