import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

// A little ghost: domed head, a body that flares slightly, and a tail of
// rounded drips of uneven length that lean to one side like it's drifting.
// Built by reshaping an icosphere so the vertex distribution stays even (good
// for the spring network).
const LENGTH = 1.25; // head equator down to the top of the drips
const DRIP = 0.68; // extra length of the longest drip
const DRIPS = 6;
const BEVEL = 0.16; // radius of the rounded edge where the hem turns under
const RIM = 0.55; // polar angle (from the bottom pole) where the wall turns under

/** Rounded downward drips with rounded gaps between them, each a slightly different length. */
function dripDepth(theta: number) {
  const lobe = Math.pow(0.5 + 0.5 * Math.cos(DRIPS * theta + 0.6), 0.5); // <1 broadens the tips
  const variation = 0.85 + 0.15 * Math.sin(2 * theta + 1.1);
  return DRIP * lobe * variation;
}

export function createGhostGeometry(detail: number) {
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute("normal");
  ico.deleteAttribute("uv");
  const geo = mergeVertices(ico);
  ico.dispose();

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const HALF_PI = Math.PI / 2;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (y >= 0) {
      pos.setXYZ(i, x, y * 1.08, z);
      continue;
    }

    const r = Math.hypot(x, z);
    const dx = r > 1e-6 ? x / r : 0;
    const dz = r > 1e-6 ? z / r : 0;
    const theta = Math.atan2(z, x);
    const alpha = Math.acos(Math.min(1, -y)); // 0 at the bottom pole, pi/2 at the equator
    const drip = dripDepth(theta);
    const rimY = -(LENGTH + drip);
    const rimR = 1.1 - 0.16 * (1 - drip / DRIP); // gaps between drips tuck in a little

    let R: number;
    let Y: number;
    let depth: number; // 0 at the equator, 1 at the drip tips
    if (alpha > RIM) {
      // Wall: flares gently, and the drips only start forming near the hem.
      // It stops one bevel-radius above the tip so the edge can round under.
      const s = (HALF_PI - alpha) / (HALF_PI - RIM);
      const hem = s * s * s;
      R = 1 + (rimR - 1) * s * s;
      Y = -s * (LENGTH - BEVEL) - drip * hem;
      depth = s;
    } else {
      const u = 1 - alpha / RIM; // 0 at the rim, 1 at the bottom pole
      const U0 = 0.3;
      if (u < U0) {
        // Quarter-circle bevel: the wall curls under instead of meeting the
        // underside at a hard edge.
        const phi = (u / U0) * HALF_PI;
        R = rimR - BEVEL + BEVEL * Math.cos(phi);
        Y = rimY + BEVEL - BEVEL * Math.sin(phi);
      } else {
        // Underside: runs inward and rises into a shallow hollow (like a sheet
        // draped over nothing), flat at both ends so there are no creases.
        const v = (u - U0) / (1 - U0);
        const lift = Math.sin(v * HALF_PI);
        R = (rimR - BEVEL) * (1 - v);
        Y = rimY + 0.45 * lift * lift;
      }
      depth = 1;
    }
    const sway = 0.2 * depth * depth;
    pos.setXYZ(i, dx * R + sway, Y, dz * R);
  }

  smooth(pos, geo.index!, 6);

  geo.computeBoundingBox();
  const center = new THREE.Vector3();
  geo.boundingBox!.getCenter(center);
  geo.translate(-center.x, -center.y, -center.z);
  geo.computeVertexNormals();
  // Particles move outside the rest bounds; skip culling/raycast early-outs.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);
  // Where the face goes and where the tail starts, in the centred space.
  geo.userData.face = { x: -center.x, y: 0.22 - center.y };
  geo.userData.tailTop = -0.35 - center.y;
  geo.userData.tailBottom = -(LENGTH + DRIP) - center.y;
  return geo;
}

/** Taubin smoothing (shrink-free): rounds off creases where the reshaping pinches triangles. */
function smooth(pos: THREE.BufferAttribute, index: THREE.BufferAttribute, iterations: number) {
  const n = pos.count;
  const neighbours: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    neighbours[a].add(b).add(c);
    neighbours[b].add(a).add(c);
    neighbours[c].add(a).add(b);
  }
  const p = pos.array as Float32Array;
  const next = new Float32Array(p.length);
  const pass = (factor: number) => {
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sz = 0;
      for (const j of neighbours[i]) {
        sx += p[j * 3]; sy += p[j * 3 + 1]; sz += p[j * 3 + 2];
      }
      const k = neighbours[i].size;
      next[i * 3] = p[i * 3] + factor * (sx / k - p[i * 3]);
      next[i * 3 + 1] = p[i * 3 + 1] + factor * (sy / k - p[i * 3 + 1]);
      next[i * 3 + 2] = p[i * 3 + 2] + factor * (sz / k - p[i * 3 + 2]);
    }
    p.set(next);
  };
  for (let it = 0; it < iterations; it++) {
    pass(0.5);
    pass(-0.53);
  }
}
