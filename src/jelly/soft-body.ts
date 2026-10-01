// Mass-spring soft body. Particles are the surface vertices of a closed mesh.
// Forces per particle:
//   - edge springs (structural, along mesh edges) with axial damping
//   - bending: a Laplacian term that resists wrinkles by keeping each particle
//     where it sits relative to its neighbours in the rest pose
//   - shape memory: a weak spring pulling each particle toward its rest pose,
//     which is what makes the body wobble back after being released
//   - volume pressure: keeps the enclosed volume near its rest value, so
//     squashing one side bulges another (the "jelly" part)
//   - grab springs: pull a weighted patch of particles toward the pointer
// Integration is semi-implicit Euler at a fixed substep for stability.

export type SoftBodyParams = {
  stiffness: number;
  springDamping: number;
  bending: number;
  shapeMemory: number;
  damping: number;
  pressure: number;
  grabStrength: number;
  grabRadius: number;
};

export const DEFAULT_PARAMS: SoftBodyParams = {
  stiffness: 700,
  springDamping: 5,
  bending: 300,
  shapeMemory: 70,
  damping: 2,
  pressure: 25,
  grabStrength: 900,
  grabRadius: 0.5,
};

export const PARAM_RANGES: Record<keyof SoftBodyParams, [min: number, max: number, step: number]> = {
  stiffness: [50, 2500, 10],
  springDamping: [0, 20, 0.1],
  bending: [0, 1500, 10],
  shapeMemory: [5, 300, 1],
  damping: [0, 8, 0.05],
  pressure: [0, 120, 1],
  grabStrength: [100, 3000, 10],
  grabRadius: [0.15, 1, 0.01],
};

const SUBSTEP = 1 / 240;
const MAX_SUBSTEPS = 8;
const MAX_STRETCH = 1.5;
const MAX_SPEED = 40;

type Grab = {
  ids: Uint32Array;
  weights: Float32Array;
  offsets: Float32Array;
  anchor: [number, number, number];
  target: [number, number, number];
};

export class SoftBody {
  readonly count: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly rest: Float32Array;
  readonly edgeCount: number;
  params: SoftBodyParams;
  asleep = false;

  private readonly frc: Float32Array;
  private readonly index: Uint32Array;
  private readonly edgeA: Uint32Array;
  private readonly edgeB: Uint32Array;
  private readonly edgeRest: Float32Array;
  private readonly restVolume: number;
  private readonly invDegree: Float32Array;
  private readonly restLap: Float32Array;
  private readonly lap: Float32Array;
  private readonly pressureScale: number;
  private readonly grabs = new Map<number, Grab>();
  private accumulator = 0;
  private quietFrames = 0;

  /** `positions` is shared (mutated in place) so it can back a GPU buffer directly. */
  constructor(positions: Float32Array, index: ArrayLike<number>, params: SoftBodyParams = DEFAULT_PARAMS) {
    this.count = positions.length / 3;
    this.pos = positions;
    this.rest = positions.slice();
    this.vel = new Float32Array(positions.length);
    this.frc = new Float32Array(positions.length);
    this.index = Uint32Array.from(index);
    this.params = { ...params };

    const seen = new Set<number>();
    const a: number[] = [];
    const b: number[] = [];
    const n = this.count;
    for (let t = 0; t < this.index.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const i = this.index[t + k];
        const j = this.index[t + ((k + 1) % 3)];
        const key = i < j ? i * n + j : j * n + i;
        if (seen.has(key)) continue;
        seen.add(key);
        a.push(i);
        b.push(j);
      }
    }
    this.edgeCount = a.length;
    this.edgeA = Uint32Array.from(a);
    this.edgeB = Uint32Array.from(b);
    this.edgeRest = new Float32Array(a.length);
    const r = this.rest;
    for (let e = 0; e < a.length; e++) {
      const i = a[e] * 3;
      const j = b[e] * 3;
      this.edgeRest[e] = Math.hypot(r[j] - r[i], r[j + 1] - r[i + 1], r[j + 2] - r[i + 2]);
    }
    this.restVolume = this.volume(this.rest);

    const degree = new Float32Array(this.count);
    for (let e = 0; e < a.length; e++) {
      degree[a[e]]++;
      degree[b[e]]++;
    }
    this.invDegree = degree.map((d) => (d > 0 ? 1 / d : 0));
    this.lap = new Float32Array(positions.length);
    this.restLap = new Float32Array(positions.length);
    this.laplacian(this.rest, this.restLap);
    // Normalise so `pressure` is roughly force-per-particle per unit volume
    // loss, independent of mesh resolution.
    let area = 0;
    for (let t = 0; t < this.index.length; t += 3) {
      const i = this.index[t] * 3, j = this.index[t + 1] * 3, k = this.index[t + 2] * 3;
      const ux = r[j] - r[i], uy = r[j + 1] - r[i + 1], uz = r[j + 2] - r[i + 2];
      const wx = r[k] - r[i], wy = r[k + 1] - r[i + 1], wz = r[k + 2] - r[i + 2];
      area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    }
    this.pressureScale = (3 * this.count) / area;
  }

  setParams(p: Partial<SoftBodyParams>) {
    Object.assign(this.params, p);
    this.wake();
  }

  wake() {
    this.asleep = false;
    this.quietFrames = 0;
  }

  reset() {
    this.pos.set(this.rest);
    this.vel.fill(0);
    this.grabs.clear();
    this.wake();
  }

  get grabbing() {
    return this.grabs.size > 0;
  }

  /** Start dragging the patch around `hit` (local space). `push` is an optional poke velocity direction. */
  grab(id: number, hit: [number, number, number], push?: [number, number, number]) {
    const R = this.params.grabRadius;
    const p = this.pos;
    const ids: number[] = [];
    const ws: number[] = [];
    let nearest = -1;
    let nearestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const d = Math.hypot(p[i * 3] - hit[0], p[i * 3 + 1] - hit[1], p[i * 3 + 2] - hit[2]);
      if (d < nearestD) {
        nearestD = d;
        nearest = i;
      }
      if (d < R) {
        const x = 1 - d / R;
        ids.push(i);
        ws.push(x * x * (3 - 2 * x));
      }
    }
    if (ids.length === 0 && nearest >= 0) {
      ids.push(nearest);
      ws.push(1);
    }
    const offsets = new Float32Array(ids.length * 3);
    ids.forEach((i, k) => {
      offsets[k * 3] = p[i * 3] - hit[0];
      offsets[k * 3 + 1] = p[i * 3 + 1] - hit[1];
      offsets[k * 3 + 2] = p[i * 3 + 2] - hit[2];
      if (push) {
        const s = 1.4 * ws[k];
        this.vel[i * 3] += push[0] * s;
        this.vel[i * 3 + 1] += push[1] * s;
        this.vel[i * 3 + 2] += push[2] * s;
      }
    });
    this.grabs.set(id, {
      ids: Uint32Array.from(ids),
      weights: Float32Array.from(ws),
      offsets,
      anchor: [...hit],
      target: [...hit],
    });
    this.wake();
  }

  moveGrab(id: number, target: [number, number, number]) {
    const g = this.grabs.get(id);
    if (!g) return;
    let dx = target[0] - g.anchor[0];
    let dy = target[1] - g.anchor[1];
    let dz = target[2] - g.anchor[2];
    const len = Math.hypot(dx, dy, dz);
    if (len > MAX_STRETCH) {
      // Soft limit: keep pulling, but with diminishing returns past MAX_STRETCH.
      const soft = MAX_STRETCH + Math.log1p(len - MAX_STRETCH) * 0.35;
      const s = soft / len;
      dx *= s;
      dy *= s;
      dz *= s;
    }
    g.target[0] = g.anchor[0] + dx;
    g.target[1] = g.anchor[1] + dy;
    g.target[2] = g.anchor[2] + dz;
  }

  release(id: number) {
    this.grabs.delete(id);
  }

  releaseAll() {
    this.grabs.clear();
  }

  /** Advance by a variable frame delta using fixed substeps. */
  update(frameDt: number) {
    if (this.asleep) return false;
    this.accumulator = Math.min(this.accumulator + frameDt, SUBSTEP * MAX_SUBSTEPS);
    while (this.accumulator >= SUBSTEP) {
      this.substep(SUBSTEP);
      this.accumulator -= SUBSTEP;
    }
    this.checkSleep();
    return true;
  }

  private substep(dt: number) {
    const { stiffness, springDamping, bending, shapeMemory, damping, pressure, grabStrength } = this.params;
    const p = this.pos;
    const v = this.vel;
    const f = this.frc;
    const r = this.rest;
    const n3 = this.count * 3;

    for (let i = 0; i < n3; i++) f[i] = (r[i] - p[i]) * shapeMemory;

    if (bending > 0) {
      const lap = this.lap;
      const restLap = this.restLap;
      this.laplacian(p, lap);
      for (let i = 0; i < n3; i++) f[i] += (lap[i] - restLap[i]) * bending;
    }

    const ea = this.edgeA;
    const eb = this.edgeB;
    const er = this.edgeRest;
    for (let e = 0; e < this.edgeCount; e++) {
      const i = ea[e] * 3;
      const j = eb[e] * 3;
      const dx = p[j] - p[i];
      const dy = p[j + 1] - p[i + 1];
      const dz = p[j + 2] - p[i + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const nx = dx / len;
      const ny = dy / len;
      const nz = dz / len;
      const relV = (v[j] - v[i]) * nx + (v[j + 1] - v[i + 1]) * ny + (v[j + 2] - v[i + 2]) * nz;
      const s = stiffness * (len - er[e]) + springDamping * relV;
      f[i] += nx * s;
      f[i + 1] += ny * s;
      f[i + 2] += nz * s;
      f[j] -= nx * s;
      f[j + 1] -= ny * s;
      f[j + 2] -= nz * s;
    }

    if (pressure > 0) {
      // Pressure pushes each face outward along its area-weighted normal,
      // proportional to how far the volume is below rest (pulls in if above).
      const P = (pressure * this.pressureScale * (this.restVolume - this.volume(p))) / this.restVolume / 6;
      const idx = this.index;
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3;
        const b = idx[t + 1] * 3;
        const c = idx[t + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = p[c + 2] - p[a + 2];
        const cx = (uy * wz - uz * wy) * P;
        const cy = (uz * wx - ux * wz) * P;
        const cz = (ux * wy - uy * wx) * P;
        f[a] += cx; f[a + 1] += cy; f[a + 2] += cz;
        f[b] += cx; f[b + 1] += cy; f[b + 2] += cz;
        f[c] += cx; f[c + 1] += cy; f[c + 2] += cz;
      }
    }

    for (const g of this.grabs.values()) {
      const gd = 2 * Math.sqrt(grabStrength) * 0.25;
      for (let k = 0; k < g.ids.length; k++) {
        const i = g.ids[k] * 3;
        const w = g.weights[k];
        for (let c = 0; c < 3; c++) {
          const target = g.target[c] + g.offsets[k * 3 + c];
          f[i + c] += w * (grabStrength * (target - p[i + c]) - gd * v[i + c]);
        }
      }
    }

    const drag = Math.exp(-damping * dt);
    for (let i = 0; i < n3; i += 3) {
      let vx = (v[i] + f[i] * dt) * drag;
      let vy = (v[i + 1] + f[i + 1] * dt) * drag;
      let vz = (v[i + 2] + f[i + 2] * dt) * drag;
      const sp = vx * vx + vy * vy + vz * vz;
      if (sp > MAX_SPEED * MAX_SPEED) {
        const s = MAX_SPEED / Math.sqrt(sp);
        vx *= s; vy *= s; vz *= s;
      }
      v[i] = vx; v[i + 1] = vy; v[i + 2] = vz;
      p[i] += vx * dt;
      p[i + 1] += vy * dt;
      p[i + 2] += vz * dt;
    }
  }

  private checkSleep() {
    if (this.grabs.size > 0) {
      this.quietFrames = 0;
      return;
    }
    const p = this.pos;
    const v = this.vel;
    const r = this.rest;
    let maxV = 0;
    let maxD = 0;
    for (let i = 0; i < p.length; i++) {
      maxV = Math.max(maxV, Math.abs(v[i]));
      maxD = Math.max(maxD, Math.abs(p[i] - r[i]));
    }
    if (!Number.isFinite(maxV) || !Number.isFinite(maxD)) {
      this.reset();
      return;
    }
    if (maxV < 2e-3 && maxD < 2e-3) {
      if (++this.quietFrames > 30) {
        this.pos.set(r);
        this.vel.fill(0);
        this.asleep = true;
      }
    } else {
      this.quietFrames = 0;
    }
  }

  /** Umbrella Laplacian: mean of neighbours minus self. */
  private laplacian(p: Float32Array, out: Float32Array) {
    out.fill(0);
    const ea = this.edgeA;
    const eb = this.edgeB;
    for (let e = 0; e < this.edgeCount; e++) {
      const i = ea[e] * 3;
      const j = eb[e] * 3;
      out[i] += p[j]; out[i + 1] += p[j + 1]; out[i + 2] += p[j + 2];
      out[j] += p[i]; out[j + 1] += p[i + 1]; out[j + 2] += p[i + 2];
    }
    const inv = this.invDegree;
    for (let v = 0; v < this.count; v++) {
      const i = v * 3;
      out[i] = out[i] * inv[v] - p[i];
      out[i + 1] = out[i + 1] * inv[v] - p[i + 1];
      out[i + 2] = out[i + 2] * inv[v] - p[i + 2];
    }
  }

  private volume(p: Float32Array) {
    let vol = 0;
    const idx = this.index;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3;
      const b = idx[t + 1] * 3;
      const c = idx[t + 2] * 3;
      vol +=
        p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
        p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return vol / 6;
  }
}
