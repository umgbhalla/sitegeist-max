# Sitegeist UI lab

Sidebar-width lab for the design system the sidepanel is rebuilt on:

- **Fluid Functionalism** (MIT, Micka Touillaud): https://www.fluidfunctionalism.com, github.com/mickadesign/fluid-functionalism

Tuned with **DialKit 2.1.0** (Josh Puckett).

```bash
cd lab
npm run setup   # install + pull the kit at its pinned commit into vendor/
npm run dev     # http://localhost:5177
```

## What it shows

- **Sitegeist composites**: Sitegeist screens built only from Fluid Functionalism components, fed Sitegeist data. Only features the extension runs: real tool names, workflow browser sub-agents, the steer queue, artifacts, the model picker.
- **Fluid Functionalism**: every preview its homepage renders (`app/components/bento-previews.tsx`).

The center frame stands in for the Chrome side panel. Drag its corner to resize; width and height land in the Frame dials.

## Dials

| Panel | Controls |
| --- | --- |
| View | composite variants |
| Frame | width, height, theme, zoom |
| Fluid Functionalism | `FluidProvider` shape, size, icon set; accent override; spring tiers fast / moderate / slow |

DialKit's own Save version and Copy parameters work per panel.

## Handing back a configuration

- **Save view state** writes `lab/state/<view>.json` (for example `sg__chat-run.json`) and restores it next time that view opens.
- **Save as final** writes `lab/state/final.json`.

Each file holds the resolved `state` sent to the frame and the raw DialKit `dials`. Applying it to the extension starts from these files.

## How the kit stays verbatim

- `scripts/sync.mjs` copies the repo at a pinned SHA into `vendor/` and records `vendor/PROVENANCE.json`. Nothing under `vendor/` is edited. `npm run sync -- --latest` moves to upstream HEAD.
- `vite.config.ts` resolves `@/` from files under `vendor/ff` to that repo's root.
- Shims, the only re-implementations: `next/link`, `next/image`.
