# Jelly Ghost

An interactive 3D soft-body ghost hero built with Three.js. Grab it, stretch it, let go, and it wobbles back.

Live on Tales with Tails: https://tales-with-tails-homeridis-projects.vercel.app/jelly

## Run it

```bash
npm install
npm run dev
```

## How it works

- **Mass-spring soft body** (`src/jelly/soft-body.ts`): every surface vertex is a particle, joined by edge springs, a Laplacian bending term (no wrinkles), a "shape memory" spring back to the rest pose, and volume pressure, so squashing one side bulges another. Fixed 240 Hz substeps keep it stable.
- **Ghost shape** (`src/jelly/ghost-geometry.ts`): a reshaped icosphere with a domed head, six rounded drips with a beveled hem, and a slight drift lean.
- **Look** (`src/jelly/jelly-scene.ts`): a glossy clearcoat material with faked subsurface (milky centre, teal edges), a teal/magenta rim, a tail that glows and fades, a soft additive aura, and a contact shadow. No transmission pass, so it stays cheap on phones.
- **Interaction**: mouse and multi-touch grabbing. Page scroll still works unless your finger lands on the ghost.

## Performance

- Phones get a lighter mesh (1,212 particles vs 1,692) and a pixel ratio capped at 1.5.
- Resolution drops automatically if frames run slow.
- The simulation pauses when the hero is off-screen or the tab is hidden, and sleeps once the ghost is at rest.

## Fallback

If WebGL isn't available, a static SVG of the ghost is shown instead. Preview it with `?nowebgl`.

## Debug panel

Add `?debug` to the URL or press **Shift+D** to tune stiffness, damping, bending, shape memory, pressure and grab settings live. **Copy** exports the values for `DEFAULT_PARAMS` in `soft-body.ts`.
