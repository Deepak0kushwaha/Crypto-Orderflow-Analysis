# Crypto Orderflow Webapp

Live orderflow analysis dashboard for `BTCUSD`, `ETHUSD`, `SOLUSD`, and `XRPUSD`, powered by Binance public market data (`USDT` pairs).

## Features

- TradingView-style chart interaction powered by official `lightweight-charts`:
  - Live candlestick formation (sub-second snapshot updates)
  - Interactive price/time axes with drag/zoom
  - Crosshair with synchronized time/price readout
  - Buy/Sell signal markers on candles
  - Support/Resistance reference lines
  - CVD pane under price
- Timeframes: `1m`, `5m`, `15m`, `1h`
- Live order book panel:
  - Top-of-book ladder (`bids`/`asks`) with cumulative depth
  - Spread, book imbalance, and depth update speed
- Volume profile panel:
  - Price-distribution histogram from executed volume
  - `POC` + Value Area (`VAH`/`VAL`) + profile delta
- Orderflow confluence signals (improved accuracy focus):
  - CVD divergence
  - Absorption
  - Liquidity sweep / stop-run reclaim
  - Aggressive continuation and no-follow-through failure checks
  - Zone proximity weighting for confirmation
- Live alert feed (CVD divergence, absorption, sweeps)
- Historical backfill at startup from Binance klines so chart is immediately populated

## Data source

Public Binance endpoints (no API key):

- WebSocket trades + depth:
  - `btcusdt@aggTrade`, `ethusdt@aggTrade`, `solusdt@aggTrade`, `xrpusdt@aggTrade`
  - `btcusdt@depth20@100ms`, `ethusdt@depth20@100ms`, `solusdt@depth20@100ms`, `xrpusdt@depth20@100ms`
- REST klines for startup backfill:
  - `GET /api/v3/klines`

`BTCUSD` etc. are shown as `USD` in UI but mapped to Binance `USDT` symbols.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deploy publicly (GitHub + Render)

`GitHub Pages` is static hosting and will not run this live websocket backend.  
Use `Render` (or Railway/Fly) for a public URL.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Deepak0kushwaha/Crypto-Orderflow-Analysis)

1. Push this project to a GitHub repository.
2. In Render, create a new `Web Service` from that repo.
3. Render will auto-detect `render.yaml` in this repo.
4. After first deploy, share the Render URL (`https://...onrender.com`).

### Minimal push commands

```bash
git init
git add .
git commit -m "Orderflow webapp with TradingView-style chart, order book, and volume profile"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

## Notes

- Signal logic and thresholds are in `server.js` and can be tuned per symbol (`MARKETS` config).
- This is analytics tooling, not financial advice.
