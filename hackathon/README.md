# iShop

**The shopping agent in your iPhone.**

iShop turns an iMessage shopping brief into a constraint-aware, budget-correct bundle from live Shopify inventory. Refine the bundle by text, lock the items you like, and continue to merchant-hosted checkout when you are ready.

Built with [Spectrum](https://photon.codes/docs/spectrum-ts), Shopify UCP/MCP, OpenAI, and Hono.

## Environment

Before running, open `.env` and fill in the values:

From your project Settings on the [Photon dashboard](https://app.photon.codes):

- `PROJECT_ID`
- `PROJECT_SECRET`

## Run

```sh
bun install
bun start
```

## Development

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- The Spectrum message loop starts in `src/index.ts`.
- The live mission and checkout cards are served from `src/web/`.
- Unit tests live in `tests/` and run with `bun test`.
