import { useEffect, useState } from "react";
import type { JellyController, JellyStats } from "./jelly-scene";
import { DEFAULT_PARAMS, PARAM_RANGES, type SoftBodyParams } from "./soft-body";

const LABELS: Record<keyof SoftBodyParams, string> = {
  stiffness: "Stiffness",
  springDamping: "Spring damping",
  bending: "Bending (smoothness)",
  shapeMemory: "Shape memory",
  damping: "Damping",
  pressure: "Volume pressure",
  grabStrength: "Grab strength",
  grabRadius: "Grab radius",
};

export function JellyDebugPanel({ controller, onClose }: { controller: JellyController; onClose(): void }) {
  const [params, setParams] = useState<SoftBodyParams>(() => controller.getParams());
  const [stats, setStats] = useState<JellyStats>(() => controller.getStats());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setStats(controller.getStats()), 400);
    return () => clearInterval(id);
  }, [controller]);

  function update(key: keyof SoftBodyParams, value: number) {
    const next = { ...params, [key]: value };
    setParams(next);
    controller.setParams({ [key]: value });
  }

  function restoreDefaults() {
    setParams({ ...DEFAULT_PARAMS });
    controller.setParams(DEFAULT_PARAMS);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(params, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  }

  return (
    <div className="absolute right-3 top-14 z-20 w-64 rounded-xl border border-white/15 bg-[#0f0b1f]/85 p-3 font-mono text-[11px] text-white/85 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-bold uppercase tracking-wider text-[#7ff0dc]">Jelly debug</span>
        <button onClick={onClose} className="px-1 text-white/60 hover:text-white" aria-label="Close debug panel">
          ✕
        </button>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-x-2 text-white/60">
        <span>fps {stats.fps}</span>
        <span>dpr {stats.pixelRatio}</span>
        <span>particles {stats.particles}</span>
        <span>springs {stats.springs}</span>
        <span className="col-span-2">{stats.asleep ? "physics asleep" : "physics running"}</span>
      </div>
      {(Object.keys(PARAM_RANGES) as (keyof SoftBodyParams)[]).map((key) => {
        const [min, max, step] = PARAM_RANGES[key];
        return (
          <label key={key} className="mb-2 block">
            <span className="flex justify-between">
              <span>{LABELS[key]}</span>
              <span className="text-white/60">{params[key]}</span>
            </span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={params[key]}
              onChange={(e) => update(key, Number(e.target.value))}
              className="w-full accent-[#7ff0dc]"
            />
          </label>
        );
      })}
      <div className="mt-2 flex gap-2">
        <button onClick={() => controller.reset()} className="flex-1 rounded border border-white/20 py-1 hover:bg-white/10">
          Reset pose
        </button>
        <button onClick={restoreDefaults} className="flex-1 rounded border border-white/20 py-1 hover:bg-white/10">
          Defaults
        </button>
        <button onClick={copy} className="flex-1 rounded border border-white/20 py-1 hover:bg-white/10">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
