import { createFileRoute } from "@tanstack/react-router";

const BYBIT_API = "https://api.bybit.com/v5/market";

export const Route = createFileRoute("/api/public/bybit-market")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const [instrumentsResponse, tickersResponse] = await Promise.all([
            fetch(`${BYBIT_API}/instruments-info?category=spot`, { headers: { accept: "application/json" } }),
            fetch(`${BYBIT_API}/tickers?category=spot`, { headers: { accept: "application/json" } }),
          ]);

          if (!instrumentsResponse.ok || !tickersResponse.ok) {
            return Response.json({ error: "Bybit market data is temporarily unavailable." }, { status: 502 });
          }

          const [instruments, tickers] = await Promise.all([
            instrumentsResponse.json() as Promise<{ retCode: number; result: { list: unknown[] } }>,
            tickersResponse.json() as Promise<{ retCode: number; result: { list: unknown[] } }>,
          ]);

          if (instruments.retCode !== 0 || tickers.retCode !== 0) {
            return Response.json({ error: "Bybit returned an error for market data." }, { status: 502 });
          }

          return Response.json({
            fetchedAt: new Date().toISOString(),
            instruments: instruments.result.list,
            tickers: tickers.result.list,
          }, { headers: { "cache-control": "no-store" } });
        } catch {
          return Response.json({ error: "Could not connect to Bybit public API." }, { status: 502 });
        }
      },
    },
  },
});