import { useEffect, useRef, useState } from "react";
import type { JellyController } from "./jelly-scene";
import { JellyDebugPanel } from "./jelly-debug-panel";

type Status = "loading" | "ready" | "fallback";

function hasWebGL() {
  // ?nowebgl previews the static fallback.
  if (new URLSearchParams(window.location.search).has("nowebgl")) return false;
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function JellyHero() {
  const heroRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<JellyController | null>(null);
  const visibleRef = useRef(true);
  const [status, setStatus] = useState<Status>("loading");
  const [touched, setTouched] = useState(false);
  const [debug, setDebug] = useState(false);
  const [controller, setController] = useState<JellyController | null>(null);
  const [safeTop, setSafeTop] = useState(0);

  useEffect(() => {
    let disposed = false;

    (async () => {
      if (!hasWebGL()) {
        setStatus("fallback");
        return;
      }
      try {
        const { createJellyScene } = await import("./jelly-scene");
        if (disposed || !stageRef.current) return;
        const ctrl = createJellyScene(stageRef.current, {
          mobile: window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768,
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          onReady: () => !disposed && setStatus("ready"),
          onContextLost: () => !disposed && setStatus("fallback"),
          onFirstInteraction: () => !disposed && setTouched(true),
        });
        ctrl.setVisible(visibleRef.current);
        controllerRef.current = ctrl;
        setController(ctrl);
      } catch {
        if (!disposed) setStatus("fallback");
      }
    })();

    // Only if the 3D scene is unusually slow to start do we show the static
    // image in the meantime. A scene that exists but is paused (background
    // tab, hero scrolled away) doesn't count, so it never causes a swap.
    const slowTimer = setTimeout(() => {
      if (disposed || controllerRef.current) return;
      setStatus((s) => (s === "loading" ? "fallback" : s));
    }, 5000);

    // Pause the simulation and rendering whenever the hero is scrolled away.
    const io = new IntersectionObserver(([entry]) => {
      visibleRef.current = entry.isIntersecting;
      controllerRef.current?.setVisible(entry.isIntersecting);
    });
    if (heroRef.current) io.observe(heroRef.current);

    return () => {
      disposed = true;
      clearTimeout(slowTimer);
      io.disconnect();
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, []);

  // Where the text block ends: on stacked (phone/portrait) layouts the ghost
  // is fitted into the space below it, so it never sits behind the buttons.
  useEffect(() => {
    const hero = heroRef.current;
    const text = textRef.current;
    if (!hero || !text) return;
    const measure = () => setSafeTop(text.getBoundingClientRect().bottom - hero.getBoundingClientRect().top);
    const ro = new ResizeObserver(measure);
    ro.observe(hero);
    ro.observe(text);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    controller?.setSafeTop(safeTop);
  }, [controller, safeTop]);

  // Hidden debug panel: add ?debug to the URL, or press Shift+D.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("debug")) queueMicrotask(() => setDebug(true));
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.shiftKey && e.key.toLowerCase() === "d") setDebug((d) => !d);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <section
      ref={heroRef}
      className="relative isolate min-h-[640px] h-svh overflow-hidden text-white"
      style={{
        background:
          "radial-gradient(120% 80% at 70% 35%, #3a2160 0%, #1d1336 45%, #0f0b1f 100%)",
      }}
    >
      {/* Static fallback: only when WebGL is unavailable (or the scene is very slow to start). */}
      <div
        aria-hidden={status !== "fallback"}
        style={{ "--safe-top": `${safeTop + 12}px` } as React.CSSProperties}
        className={`pointer-events-none absolute inset-x-0 bottom-16 top-(--safe-top) flex justify-center transition-opacity duration-700 wide:inset-y-[10%] wide:left-[50%] wide:right-[2%] ${
          status === "fallback" ? "opacity-100" : "opacity-0"
        }`}
      >
        <img
          src="/jelly-ghost.svg"
          alt="A glossy, translucent jelly ghost"
          width={400}
          height={460}
          className="h-full w-auto"
        />
      </div>

      <div
        ref={stageRef}
        role="img"
        aria-label="Interactive jelly ghost. Grab it, stretch it and let go."
        className={`absolute inset-0 transition-opacity duration-700 ${
          status === "ready" ? "opacity-100" : "opacity-0"
        }`}
      />

      <div className="pointer-events-none relative z-10 mx-auto flex h-full max-w-7xl flex-col px-5 pt-6 sm:px-8 md:px-12">
        <header className="pointer-events-auto flex items-center justify-between">
          <a href="https://tales-with-tails-homeridis-projects.vercel.app/" className="font-(family-name:--font-anton) text-lg tracking-wide">
            TALES WITH TAILS
          </a>
          <a href="https://tales-with-tails-homeridis-projects.vercel.app/map" className="text-sm font-semibold text-white/75 hover:text-white">
            Map
          </a>
        </header>

        <div ref={textRef} className="mt-8 max-w-xl wide:mt-0 wide:flex wide:flex-1 wide:flex-col wide:justify-center">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#7ff0dc]">
            Myths · Legends · Ghost stories
          </p>
          <h1 className="mt-3 font-(family-name:--font-anton) text-5xl leading-[0.95] sm:text-6xl md:text-7xl">
            Some stories
            <br />
            won&apos;t sit still.
          </h1>
          <p className="mt-4 max-w-md text-base text-white/75 md:text-lg">
            Georgian folklore, told the way it was passed down: strange, a little wobbly, and hard to put
            back where you found it.
          </p>
          <div className="pointer-events-auto mt-6 flex flex-wrap gap-3">
            <a
              href="https://tales-with-tails-homeridis-projects.vercel.app/#stories"
              className="inline-flex h-12 items-center justify-center rounded-full border border-transparent bg-white px-6 text-sm font-bold leading-none text-[#1d1336] hover:bg-[#d9fff4]"
            >
              Read the tales
            </a>
            <a
              href="https://tales-with-tails-homeridis-projects.vercel.app/submit"
              className="inline-flex h-12 items-center justify-center rounded-full border border-white/30 px-6 text-sm font-bold leading-none hover:border-white/70"
            >
              Share a story
            </a>
          </div>
        </div>
      </div>

      {status === "ready" && (
        <p
          className={`pointer-events-none absolute bottom-6 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-white/10 px-4 py-2 text-xs font-semibold text-white/80 backdrop-blur transition-opacity duration-700 wide:left-[74%] ${
            touched ? "opacity-0" : "opacity-100"
          }`}
        >
          Grab the ghost. Stretch it. Let go.
        </p>
      )}

      {debug && status === "ready" && controller && (
        <JellyDebugPanel controller={controller} onClose={() => setDebug(false)} />
      )}
    </section>
  );
}
