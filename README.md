# Crypto Orderflow Radar

Live orderflow analysis webapp for `BTCUSD`, `ETHUSD`, `SOLUSD`, and `XRPUSD`.

This project helps traders read real-time liquidity behavior and convert that context into structured `BUY` / `SELL` / `WAIT` decisions.

## What This Project Does

- Streams live market data and renders:
  - Real-time candles with interactive time/price axis
  - Footprint bubble heat overlay (buy/sell pressure)
  - Order book ladder with deeper rows and cumulative liquidity
  - Volume profile with `POC`, value area, delta, and live liquidity mapping
- Detects orderflow events:
  - Absorption
  - Liquidity sweeps
  - Stacked imbalance
  - Flow dislocation
  - Zone reactions (support/resistance)
  - Candlestick pattern breakouts
- Produces a **Final Signal** card:
  - Side: `BUY`, `SELL`, or `WAIT`
  - Confidence score
  - Buy/Sell score split
  - Top reasons behind the decision

## How Buy/Sell Signal Is Generated

The final signal engine combines multiple components, not a single indicator.

- Flow metrics: OFI/TFI momentum and quote-trade quality
- Order book: imbalance, near-depth pressure, spread, dispersion
- Volume profile: profile delta, POC relation, nearby resting liquidity
- Market structure: support/resistance proximity and reaction quality
- Pattern context: breakout confirmations
- Detector alerts: absorption/sweep/dislocation/stacked imbalance
- Signal confluence: recency-weighted bullish vs bearish evidence

Output format:

- `BUY`: bullish evidence is dominant and aligned
- `SELL`: bearish evidence is dominant and aligned
- `WAIT`: mixed/conflicting or weak evidence

## How Traders Can Use It

Use this workflow on any timeframe (`1m`, `5m`, `15m`, `1h`):

1. Choose symbol and timeframe.
2. Check **Final Signal**:
   - Prefer trades when confidence is strong and reasons are clear.
   - If it shows `WAIT`, do not force an entry.
3. Validate with market context:
   - Is price near support/resistance?
   - Is order book imbalance aligned with signal side?
   - Is volume profile delta/POC behavior aligned?
   - Are footprint bubbles showing active pressure in the same direction?
4. Entry logic:
   - `BUY`: enter only after bullish candle holds above trigger area/zone.
   - `SELL`: enter only after bearish candle holds below trigger area/zone.
5. Invalidation and risk:
   - Place stop where the setup is invalid (below support for longs, above resistance for shorts).
   - Risk a fixed fraction per trade (example: 0.5% to 1% account risk).
6. Exit logic:
   - Scale out near next opposing zone or liquidity pool.
   - Exit early if signal flips to `WAIT` with strong opposite reasons.

## Practical Rules (Recommended)

- Trade only when at least 3 components align with Final Signal reasons.
- Avoid entries during flat spread-widening or high-conflict conditions.
- Do not chase after extended candles far from structure.
- Prioritize setups around support/resistance and POC/value area transitions.

## Run Locally

```bash
npm install
npm start
```

Open: `http://localhost:3000`

## Deploy (GitHub + Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Deepak0kushwaha/Crypto-Orderflow-Analysis)

1. Push code to GitHub.
2. Create a Render Web Service from repo.
3. Render uses `render.yaml`.
4. Share your live URL.

## Useful Endpoints

- `GET /health` -> service health, symbol staleness, commit id
- `POST /api/visit` -> increments and returns site visit count
- `GET /api/visit` -> returns current visit count

## Project Structure

- `server.js` -> data ingestion, orderflow logic, signal engine, websocket snapshots
- `public/app.js` -> UI rendering, charting, overlays, live signal display
- `public/styles.css` -> visual styling
- `public/index.html` -> layout

## Disclaimer

This tool is for market analysis and education.
It is **not financial advice**. Always use your own risk management and validation.
