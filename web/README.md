# FinTech Cron Monitor — Dashboard

React + TypeScript + Vite + Tailwind v4, shadcn/ui project structure.

- **Components** live under `src/components/ui` (the shadcn convention). Keeping this
  path exact matters: the `components.json` aliases, any future `npx shadcn add`, and
  copy-pasted community components all resolve `@/components/ui/*` — put primitives
  elsewhere and every one of those breaks.
- **`@/*`** is aliased to `src/*` (Vite + tsconfig).
- Data comes from the API via **TanStack Query** with a 10s poll, so the dashboard is a
  live view. Requests go through Vite's `/api` proxy → `http://localhost:3000` (no CORS).
- Charts use **Recharts**; the palette is the validated dataviz reference palette, dark steps.
  Status colours (`--color-up/degraded/down/unknown`) are reserved and always paired with an
  icon + label.

## Run

```bash
npm install
cp .env.example .env        # optional
npm run dev                  # http://localhost:5173
```

The API (`../`) and its scheduler must be running:

```bash
cd ..            # the backend
docker compose up -d
npm run migrate up
npm run dev              # API on :3000
npm run dev:scheduler   # cron engine + alert delivery
```

## Pages

| Route | What |
| --- | --- |
| `/` | Landing — the WebGL black-hole hero (`components/ui/blackhole-hero-section.tsx`) |
| `/app` | Overview — stat tiles, latency chart, open incidents, money-moving targets |
| `/app/targets` | Target board — status, latency, uptime, enable/disable, ad-hoc **Test** |
| `/app/incidents` | Incident list + detail drawer — acknowledge / resolve |
| `/app/scheduler` | Scheduler heartbeat, recent job runs, missed runs |
| `/app/alerts` | Alert delivery log (sent / pending / failed / suppressed) |

## The black-hole hero

`src/components/ui/blackhole-hero-section.tsx` is self-contained — pure React + WebGL,
**no external dependencies**, no image assets. It degrades gracefully (hides its canvas
and shows the black background + copy) on software renderers or when the GL context is lost.
`src/pages/landing.tsx` is the integration: the hole is pushed off-centre with `focus` and
one edge is veiled with `scrim` so the copy stays readable; on a phone the layout rotates 90°.
