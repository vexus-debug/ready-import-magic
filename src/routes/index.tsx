import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronDown, CircleHelp, Clock3, ExternalLink, Gauge, GitBranch, Info, LayoutGrid, RefreshCw, Search, Settings2, SlidersHorizontal, Star, WalletCards, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { scanMarket, universeFilter, UNIVERSE_COPY, type Instrument, type Leg, type Opportunity, type Ticker, type Universe } from "@/lib/scanner-engine";

type MarketResponse = { fetchedAt: string; instruments: Instrument[]; tickers: Ticker[] };
type ScannerState = { market_fetched_at: string | null; instruments: Instrument[]; tickers: Ticker[]; opportunities: Opportunity[]; status: string; error_message: string | null; last_completed_at: string | null };
const DEFAULT_FEE = 0.001;
const DEFAULT_CONVERT_SPREAD = 0.002;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Loopline — Bybit Arbitrage Scanner" },
      { name: "description", content: "Live triangular arbitrage scanner for Bybit crypto spot markets." },
      { property: "og:title", content: "Loopline — Bybit Arbitrage Scanner" },
      { property: "og:description", content: "Live triangular arbitrage scanner for Bybit crypto spot markets." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Scanner,
});

function parseNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPrice(value: number) {
  if (!value) return "—";
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return value.toLocaleString(undefined, { maximumSignificantDigits: 5 });
}

function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(3)}%`;
}

type Edge = { to: string; symbol: string; side: "Sell" | "Buy" | "Convert"; rate: number; price: number; stock: boolean; volume: number };

function buildGraph(instruments: Instrument[], tickers: Ticker[]) {
  const quoteMap = new Map(tickers.map((item) => [item.symbol, item]));
  const graph = new Map<string, Edge[]>();
  const push = (from: string, edge: Edge) => {
    const list = graph.get(from);
    if (list) list.push(edge);
    else graph.set(from, [edge]);
  };

  for (const instrument of instruments) {
    if (instrument.status !== "Trading") continue;
    const ticker = quoteMap.get(instrument.symbol);
    if (!ticker) continue;
    const bid = parseNumber(ticker.bid1Price);
    const ask = parseNumber(ticker.ask1Price);
    if (bid <= 0 || ask <= 0) continue;
    const stock = instrument.symbolType === "xstocks";
    const volume = parseNumber(ticker.turnover24h);
    // sell base into quote at the bid
    push(instrument.baseCoin, { to: instrument.quoteCoin, symbol: instrument.symbol, side: "Sell", rate: bid, price: bid, stock, volume });
    // buy base with quote at the ask
    push(instrument.quoteCoin, { to: instrument.baseCoin, symbol: instrument.symbol, side: "Buy", rate: 1 / ask, price: ask, stock, volume });
  }
  return graph;
}

/** USD reference value per asset, derived from USDT/USDC spot mid prices. */
function buildUsdIndex(instruments: Instrument[], tickers: Ticker[]) {
  const quoteMap = new Map(tickers.map((item) => [item.symbol, item]));
  const usd = new Map<string, number>([["USDT", 1], ["USDC", 1]]);
  const turnover = new Map<string, number>();
  const stocks = new Set<string>();
  /**
   * Assets Bybit can actually convert: a Convert quote only exists for coins that hold a live
   * stablecoin (USDT/USDC) book on the venue. Anything without one is priced by inference only,
   * so it must never be bridged by a synthetic Convert leg.
   */
  const convertible = new Set<string>(["USDT", "USDC"]);

  for (const instrument of instruments) {
    if (instrument.status !== "Trading") continue;
    const ticker = quoteMap.get(instrument.symbol);
    if (!ticker) continue;
    const bid = parseNumber(ticker.bid1Price);
    const ask = parseNumber(ticker.ask1Price);
    if (bid <= 0 || ask <= 0) continue;
    const mid = (bid + ask) / 2;
    const volume = parseNumber(ticker.turnover24h);
    if (instrument.symbolType === "xstocks") stocks.add(instrument.baseCoin);
    if (instrument.quoteCoin === "USDT" || instrument.quoteCoin === "USDC") {
      if (!usd.has(instrument.baseCoin)) usd.set(instrument.baseCoin, mid);
      turnover.set(instrument.baseCoin, Math.max(turnover.get(instrument.baseCoin) ?? 0, volume));
      convertible.add(instrument.baseCoin);
    }
    if (instrument.baseCoin === "USDT" || instrument.baseCoin === "USDC") {
      convertible.add(instrument.quoteCoin);
    }
  }
  return { usd, turnover, stocks, convertible };
}


/**
 * A scan pass over the whole platform. Two complementary searches, both exhaustive:
 *
 * 1. Spot DFS from EVERY asset (all coins, quote currencies and xStocks), with no branching
 *    caps — pure spot cycles up to `maxLegs` legs.
 * 2. Convert-bridged routes. Convert prices every pair off the same USD reference minus a fixed
 *    spread, so a convert leg A -> B always contributes usd(A)/usd(B) * (1 - spread). That makes
 *    convert path shape irrelevant: two chained converts are strictly worse than one, and any set
 *    of spot legs can be stitched into a cycle by converts. So instead of an impossible
 *    600^3 convert DFS, every spot leg is scored in USD-normalised terms and combinations of
 *    1..maxLegs-1 spot legs are enumerated with converts filling the gaps. This covers every
 *    reachable currency / crypto / xStock mix without losing a single profitable combination.
 */
function createScanPass(
  instruments: Instrument[],
  tickers: Ticker[],
  fee: number,
  maxLegs: number,
  useConvert: boolean,
  convertSpread: number,
  universe: Universe,
  excludedSymbols: Set<string>,
) {
  // Universe filter: crypto drops xStocks/fiat; xstocks keeps only USDT-quoted xStocks; cross keeps all.
  instruments = instruments.filter((instrument) => universeFilter[universe](instrument) && !excludedSymbols.has(instrument.symbol));
  const graph = buildGraph(instruments, tickers);
  for (const edges of graph.values()) edges.sort((a, b) => b.volume - a.volume);
  const index = buildUsdIndex(instruments, tickers);
  const stockAssets = index.stocks;
  const isStockAsset = (asset: string) => stockAssets.has(asset);
  const usd = index.usd;
  /** Convert legs are only legal between assets that hold a live Bybit stablecoin book. */
  const canConvert = (asset: string) => index.convertible.has(asset);

  // xStocks mode: USDT is the hub and only crypto, so it is the only start asset.
  const startSet = new Set<string>(universe === "xstocks" ? ["USDT"] : [...graph.keys(), ...usd.keys()]);
  const priority = new Map(["USDT", "USDC", "BTC", "ETH"].map((asset, rank) => [asset, rank]));
  const spotStarts = [...startSet].sort((a, b) => {
    const pa = priority.get(a) ?? Infinity;
    const pb = priority.get(b) ?? Infinity;
    if (pa !== pb) return pa - pb;
    return (index.turnover.get(b) ?? 0) - (index.turnover.get(a) ?? 0);
  });

  const makeOpportunity = (start: string, legs: Leg[], product: number, volume: number): Opportunity => {
    const spotLegs = legs.filter((leg) => leg.side !== "Convert").length;
    const converts = legs.length - spotLegs;
    const gross = product - 1;
    const net = product * Math.pow(1 - fee, spotLegs) * Math.pow(1 - convertSpread, converts) - 1;
    const assets = [start, ...legs.map((leg) => leg.to)];
    const stocks = new Set(assets.filter(isStockAsset)).size;
    return {
      id: `${start}-${legs.map((leg) => leg.symbol).join("-")}`,
      assets,
      legs,
      gross,
      net,
      volume,
      stock: stocks > 0,
      stocks,
      converts,
    };
  };

  /** Exhaustive spot-only DFS from one start asset. */
  const scanSpotFrom = (start: string) => {
    const candidates: Opportunity[] = [];
    let work = 0;
    const path: Leg[] = [];
    const visited = new Set<string>([start]);
    const usedSymbols = new Set<string>();

    const walk = (asset: string, amount: number, minVolume: number) => {
      if (work > WORK_BUDGET) return;
      const edges = graph.get(asset) ?? [];
      for (const edge of edges) {
        if (work++ > WORK_BUDGET) return;
        if (usedSymbols.has(edge.symbol)) continue;
        const next = amount * edge.rate;
        const volume = Math.min(minVolume, edge.volume);
        const leg: Leg = { symbol: edge.symbol, from: asset, to: edge.to, side: edge.side, price: edge.price, stock: edge.stock };

        if (edge.to === start) {
          if (path.length + 1 >= 3 && volume >= 1000) candidates.push(makeOpportunity(start, [...path, leg], next, volume));
          continue;
        }
        if (path.length + 1 >= maxLegs) continue;
        if (visited.has(edge.to)) continue;

        visited.add(edge.to);
        usedSymbols.add(edge.symbol);
        path.push(leg);
        walk(edge.to, next, volume);
        path.pop();
        usedSymbols.delete(edge.symbol);
        visited.delete(edge.to);
      }
    };

    walk(start, 1, Infinity);
    return candidates;
  };

  type Scored = { edge: Edge; from: string; norm: number };
  /** Every spot leg with a USD reference on both sides, scored in USD-normalised terms. */
  const scored: Scored[] = [];
  if (useConvert) {
    for (const [from, edges] of graph) {
      const fromUsd = usd.get(from) ?? 0;
      if (fromUsd <= 0) continue;
      for (const edge of edges) {
        const toUsd = usd.get(edge.to) ?? 0;
        if (toUsd <= 0 || edge.volume < 1000) continue;
        scored.push({ edge, from, norm: (edge.rate * toUsd) / fromUsd });
      }
    }
    scored.sort((a, b) => b.norm - a.norm);
  }
  /** Every scored leg gets its own pass, so no leg is excluded as a route root. */
  const convertRoots = scored;
  /** Bounded pool used for the 2nd/3rd legs so per-root work stays sub-second. */
  const convertPool = scored.slice(0, CONVERT_POOL);

  const convertEdge = (from: string, to: string): Leg | null => {
    const fromUsd = usd.get(from) ?? 0;
    const toUsd = usd.get(to) ?? 0;
    if (from === to || fromUsd <= 0 || toUsd <= 0) return null;
    // Only bridge assets Bybit can actually convert between.
    if (!canConvert(from) || !canConvert(to)) return null;
    return { symbol: `CONVERT:${from}->${to}`, from, to, side: "Convert", price: fromUsd / toUsd, stock: isStockAsset(from) || isStockAsset(to) };
  };

  /** Build the cycle for one ordered selection of spot legs, bridging gaps with Convert. */
  const stitch = (selection: Scored[]): Opportunity | null => {
    const start = selection[0]!.from;
    const legs: Leg[] = [];
    let product = 1;
    let volume = Infinity;
    let cursor = start;
    const seen = new Set<string>();

    for (const item of selection) {
      if (seen.has(item.edge.symbol)) return null;
      seen.add(item.edge.symbol);
      if (cursor !== item.from) {
        const bridge = convertEdge(cursor, item.from);
        if (!bridge) return null;
        legs.push(bridge);
        product *= bridge.price === 0 ? 0 : (usd.get(cursor)! / usd.get(item.from)!);
        cursor = item.from;
      }
      legs.push({ symbol: item.edge.symbol, from: item.from, to: item.edge.to, side: item.edge.side, price: item.edge.price, stock: item.edge.stock });
      product *= item.edge.rate;
      volume = Math.min(volume, item.edge.volume);
      cursor = item.edge.to;
    }

    if (cursor !== start) {
      const bridge = convertEdge(cursor, start);
      if (!bridge) return null;
      legs.push(bridge);
      product *= usd.get(cursor)! / usd.get(start)!;
    }

    if (legs.length < 3 || volume < 1000) return null;
    return makeOpportunity(start, legs, product, volume);
  };

  /** Convert-bridged combinations rooted at one spot leg (called per progress chunk). */
  const scanConvertFrom = (rootIndex: number) => {
    const root = convertRoots[rootIndex];
    if (!root) return [];
    const found: Opportunity[] = [];
    const push = (selection: Scored[]) => {
      const built = stitch(selection);
      if (built) found.push(built);
    };

    push([root]);
    if (maxLegs >= 3) {
      for (const second of convertPool) {
        if (second === root) continue;
        push([root, second]);
        if (maxLegs >= 5) {
          for (const third of convertPool) {
            if (third === root || third === second) continue;
            push([root, second, third]);
          }
        }
      }
    }
    return found;
  };

  const steps: Array<() => Opportunity[]> = [
    ...spotStarts.map((start) => () => scanSpotFrom(start)),
    ...convertRoots.map((_, position) => () => scanConvertFrom(position)),
  ];

  return { steps, assetCount: spotStarts.length, convertCombos: convertRoots.length };
}

function Asset({ name }: { name: string }) {
  return <span className="asset-badge" title={name}>{name.replace("USDT", "₮").replace("USDC", "$ ").slice(0, 4)}</span>;
}

function Scanner() {
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [minProfit, setMinProfit] = useState("0.10");
  const [fee, setFee] = useState(DEFAULT_FEE);
  
  const [maxLegs, setMaxLegs] = useState(4);
  const [useConvert, setUseConvert] = useState(true);
  const [convertSpread, setConvertSpread] = useState(DEFAULT_CONVERT_SPREAD);
  const [universe, setUniverse] = useState<Universe>("crypto");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"opportunities" | "markets">("opportunities");
  const [selected, setSelected] = useState<Opportunity | null>(null);
  const [excludedSymbols, setExcludedSymbols] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("loopline_excluded_symbols");
      return saved ? new Set(JSON.parse(saved)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const [excludeInput, setExcludeInput] = useState("");

  const scanningRef = useRef(false);

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/public/bybit-market");
      const data = await response.json() as MarketResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Market data unavailable");
      setMarket(data);
      setError(null);
      return data as MarketResponse;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Market data unavailable");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void scan(); }, [scan]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => { if (!scanningRef.current) void scan(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, scan]);
  useEffect(() => {
    try {
      localStorage.setItem("loopline_excluded_symbols", JSON.stringify([...excludedSymbols]));
    } catch {
      // ignore storage errors
    }
  }, [excludedSymbols]);

  // Scanning is manual: a request snapshot is only created when the user hits "Scan now".
  // Work is time-sliced so the tab stays responsive while a full-universe pass runs.
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0, assets: 0 });
  type ScanRequest = { market: MarketResponse; fee: number; maxLegs: number; useConvert: boolean; convertSpread: number; universe: Universe; excludedSymbols: Set<string>; id: number };
  const [scanRequest, setScanRequest] = useState<ScanRequest | null>(null);

  const settings = { fee, maxLegs, useConvert, convertSpread, universe, excludedSymbols };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const marketRef = useRef(market);
  marketRef.current = market;

  const runScan = useCallback(async () => {
    const data = await scan();
    const source = data ?? marketRef.current;
    if (!source) return;
    setScanRequest({ market: source, ...settingsRef.current, id: Date.now() });
  }, [scan]);

  useEffect(() => {
    if (!scanRequest) return;
    const pass = createScanPass(scanRequest.market.instruments, scanRequest.market.tickers, scanRequest.fee, scanRequest.maxLegs, scanRequest.useConvert, scanRequest.convertSpread, scanRequest.universe, scanRequest.excludedSymbols);
    const total = pass.steps.length;
    const best = new Map<string, Opportunity>();
    let cursor = 0;
    let cancelled = false;
    let frame = 0;
    setProgress({ done: 0, total, assets: pass.assetCount });

    const step = () => {
      if (cancelled) return;
      const deadline = performance.now() + 40;
      let processed = 0;
      while (cursor < total && (processed < 1 || performance.now() < deadline)) {
        for (const candidate of pass.steps[cursor]!()) {
          const key = candidate.legs.map((leg) => leg.symbol).sort().join("/");
          const current = best.get(key);
          if (!current || current.net < candidate.net) best.set(key, candidate);
        }
        cursor += 1;
        processed += 1;
      }
      setProgress({ done: cursor, total, assets: pass.assetCount });
      setOpportunities([...best.values()].sort((a, b) => b.net - a.net));
      if (cursor < total) frame = window.requestAnimationFrame(step);
    };

    frame = window.requestAnimationFrame(step);
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [scanRequest]);


  const scanning = progress.total > 0 && progress.done < progress.total;
  scanningRef.current = scanning;
  const scanPercent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const threshold = parseNumber(minProfit) / 100;
  const filtered = opportunities.filter((item) => item.net >= threshold && (!query || item.assets.join(" ").toLowerCase().includes(query.toLowerCase())));
  const cryptoInstruments = market?.instruments.filter((item) => item.status === "Trading" && universeFilter[universe](item)) ?? [];
  const copy = UNIVERSE_COPY[universe];
  const best = opportunities[0];
  const lastUpdated = market ? new Date(market.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

  return (
    <main className="app-shell relative overflow-hidden">
      <div className="app-grid absolute inset-0" />
      <header className="topbar sticky top-0 z-20">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="brand-mark flex h-9 w-9 items-center justify-center rounded-md"><GitBranch className="h-5 w-5" /></div>
            <div><div className="font-mono text-[15px] font-bold tracking-[0.02em] text-foreground">LOOPLINE</div><div className="hidden text-[10px] uppercase tracking-[0.16em] text-muted-foreground sm:block">arbitrage intelligence</div></div>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="hidden items-center gap-2 md:flex"><span className={`status-dot ${loading ? "pulse-dot" : ""}`} />{loading ? "Syncing" : "Live"}<span className="text-border">·</span> Bybit public API</div>
            <Button variant="outline" size="sm" onClick={() => void scan()} disabled={loading}><RefreshCw className={loading ? "animate-spin" : ""} /> <span className="hidden sm:inline">Refresh</span></Button>
          </div>
        </div>
      </header>

      <div className="relative mx-auto max-w-[1440px] px-5 pb-12 pt-8 lg:px-8 lg:pt-12">
        <section className="mb-9 flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div><div className="eyebrow mb-3 flex items-center gap-2"><span className="h-px w-6 bg-primary" /> Market scanner / spot</div><h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">Find the gap<br /><span className="text-primary">before it closes.</span></h1><p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">{copy.hero}</p></div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-4 w-4 text-primary" /> Updated {lastUpdated}<span className="text-border">·</span>10s cadence</div>
        </section>

        <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Live instruments" value={cryptoInstruments.length ? cryptoInstruments.length.toLocaleString() : "—"} detail={`Bybit ${copy.spotLabel.toLowerCase()}`} icon={<LayoutGrid />} />
          <Metric label={copy.pairLabel} value={cryptoInstruments.length ? cryptoInstruments.length.toLocaleString() : "—"} detail="Scanned universe" icon={<WalletCards />} tone="positive" />
          <Metric label="Routes above floor" value={filtered.length.toString()} detail={`${minProfit}% net threshold`} icon={<Zap />} tone="positive" />
          <Metric label="Best net edge" value={best ? formatPercent(best.net) : "—"} detail={best ? best.assets.slice(0, 3).join(" → ") : "Waiting for quotes"} icon={<Gauge />} tone="coral" />
        </section>

        <section className="mb-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="panel min-w-0 rounded-lg">
            <div className="flex flex-col gap-4 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="flex items-center gap-3"><h2 className="text-lg font-semibold text-foreground">Opportunity feed</h2><span className="rounded-full bg-accent px-2 py-1 font-mono text-[10px] text-primary">{filtered.length} FOUND</span></div><p className="mt-1 text-xs text-muted-foreground">Executable cycles after estimated fees</p>
                <div className="mt-3 w-full max-w-xs">
                  <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    <span>{scanning ? `Scanning ${progress.done}/${progress.total} passes` : progress.total > 0 ? `Scanned all ${progress.assets} assets` : "Idle — press Scan now"}</span>
                    <span>{scanPercent}%</span>
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-accent">
                    <div className={`h-full rounded-full bg-primary transition-[width] duration-200 ${scanning ? "opacity-100" : "opacity-60"}`} style={{ width: `${scanPercent}%` }} />
                  </div>
                </div></div>
              <div className="flex gap-1 rounded-md bg-surface-subtle p-1"><button className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${tab === "opportunities" ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setTab("opportunities")}>Routes</button><button className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${tab === "markets" ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setTab("markets")}>Markets</button></div>
            </div>
            {tab === "opportunities" ? <OpportunityTable opportunities={filtered} loading={loading} onSelect={setSelected} /> : <MarketTable instruments={cryptoInstruments} tickers={market?.tickers ?? []} query={query} />}
          </div>

          <aside className="panel rounded-lg p-5">
            <div className="mb-6 flex items-center justify-between"><div><div className="eyebrow">Scanner controls</div><h2 className="mt-1 text-lg font-semibold text-foreground">Tune the signal</h2></div><SlidersHorizontal className="h-5 w-5 text-muted-foreground" /></div>
            <div className="space-y-5">
              <label className="block"><span className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">Route universe <span className="font-mono text-muted-foreground">{copy.tag}</span></span><select className="select-control h-10 w-full rounded-md px-3 text-sm" value={universe} onChange={(event) => setUniverse(event.target.value as Universe)}><option value="crypto">Crypto only</option><option value="crypto-fiat">Crypto + fiat</option><option value="crypto-stocks">Crypto + stocks</option><option value="stocks-fiat">Stocks + fiat</option><option value="xstocks">xStocks only (USDT hub)</option><option value="cross">Cross-asset (crypto + stocks + fiat)</option></select></label>
              <div className="block">
                <span className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">Excluded instruments <span className="font-mono text-muted-foreground">{excludedSymbols.size}</span></span>
                <div className="flex gap-2">
                  <input
                    className="input-control mono h-10 flex-1 rounded-md px-3 text-sm"
                    placeholder="e.g. BTCUSDT"
                    value={excludeInput}
                    onChange={(event) => setExcludeInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        const symbol = excludeInput.trim().toUpperCase();
                        if (symbol) {
                          setExcludedSymbols((prev) => new Set([...prev, symbol]));
                          setExcludeInput("");
                        }
                      }
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const symbol = excludeInput.trim().toUpperCase();
                      if (symbol) {
                        setExcludedSymbols((prev) => new Set([...prev, symbol]));
                        setExcludeInput("");
                      }
                    }}
                    disabled={!excludeInput.trim()}
                  >
                    Add
                  </Button>
                </div>
                {excludedSymbols.size > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[...excludedSymbols].map((symbol) => (
                      <span key={symbol} className="inline-flex items-center gap-1 rounded-md bg-surface-subtle px-2 py-1 font-mono text-xs text-foreground">
                        {symbol}
                        <button
                          aria-label={`Remove ${symbol}`}
                          className="ml-1 text-muted-foreground hover:text-coral"
                          onClick={() => setExcludedSymbols((prev) => {
                            const next = new Set(prev);
                            next.delete(symbol);
                            return next;
                          })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <label className="block"><span className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">Minimum net profit <CircleHelp className="h-3.5 w-3.5 text-muted-foreground" /></span><div className="relative"><input className="input-control mono h-10 w-full rounded-md px-3 pr-10 text-sm" type="number" min="0" step="0.05" value={minProfit} onChange={(event) => setMinProfit(event.target.value)} /><span className="absolute right-3 top-2.5 font-mono text-xs text-muted-foreground">%</span></div></label>
              <label className="block"><span className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">Fee per leg <span className="font-mono text-muted-foreground">{(fee * 100).toFixed(2)}%</span></span><input className="w-full accent-primary" type="range" min="0" max="0.003" step="0.0001" value={fee} onChange={(event) => setFee(Number(event.target.value))} /></label>
              <label className="block"><span className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">Max legs per cycle <span className="font-mono text-muted-foreground">{maxLegs}</span></span><select className="select-control h-10 w-full rounded-md px-3 text-sm" value={maxLegs} onChange={(event) => setMaxLegs(Number(event.target.value))}><option value={3}>3 legs</option><option value={4}>4 legs</option><option value={5}>5 legs (slow)</option></select></label>
              <div className="flex items-center justify-between border-t border-border pt-5"><div><div className="text-sm font-medium text-foreground">Bybit Convert legs</div><div className="mt-1 text-xs text-muted-foreground">{copy.convertLegs}</div></div><button aria-label="Toggle Bybit Convert legs" className="switch-track flex h-5 w-9 cursor-pointer items-center rounded-full p-0.5 transition-colors" data-on={useConvert} onClick={() => setUseConvert((value) => !value)}><span className="switch-thumb h-4 w-4 rounded-full transition-transform" /></button></div>
              <label className={`block transition-opacity ${useConvert ? "" : "pointer-events-none opacity-40"}`}><span className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">Convert spread <span className="font-mono text-muted-foreground">{(convertSpread * 100).toFixed(2)}%</span></span><input className="w-full accent-primary" type="range" min="0" max="0.01" step="0.0005" value={convertSpread} disabled={!useConvert} onChange={(event) => setConvertSpread(Number(event.target.value))} /></label>
              <div className="flex items-center justify-between border-t border-border pt-5"><div><div className="text-sm font-medium text-foreground">Auto refresh</div><div className="mt-1 text-xs text-muted-foreground">Every 10 seconds</div></div><button aria-label="Toggle auto refresh" className="switch-track flex h-5 w-9 cursor-pointer items-center rounded-full p-0.5 transition-colors" data-on={autoRefresh} onClick={() => setAutoRefresh((value) => !value)}><span className="switch-thumb h-4 w-4 rounded-full transition-transform" /></button></div>
              <Button className="scan-button w-full" onClick={() => void runScan()} disabled={loading || scanning}><RefreshCw className={loading || scanning ? "animate-spin" : ""} /> {scanning ? "Scanning…" : "Scan now"}</Button>
            </div>
            <div className="mt-6 flex gap-2 rounded-md border border-warning/25 bg-warning/10 p-3 text-[11px] leading-4 text-warning"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{useConvert ? <>Convert legs bridge coins that share no spot pair. Convert quotes are not public: legs are modelled at the USD reference mid minus the {(convertSpread * 100).toFixed(2)}% spread above, with no exchange fee. Real quotes may be wider, so verify each Convert leg before executing.</> : <>Convert legs are off, so routes are limited to coins connected by spot pairs. Enable Convert to search cycles that bridge unconnected coins.</>}</span></div>
          </aside>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="panel rounded-lg p-5"><div className="mb-5 flex items-start justify-between"><div><div className="eyebrow">Coverage map</div><h2 className="mt-1 text-lg font-semibold text-foreground">What Bybit is exposing</h2></div><ExternalLink className="h-4 w-4 text-muted-foreground" /></div><div className="grid gap-3 sm:grid-cols-2"><Coverage label={copy.spotLabel} value={cryptoInstruments.length} caption="Tradable instruments" tone="positive" /><Coverage label={copy.assetLabel} value={new Set(cryptoInstruments.map((item) => item.baseCoin)).size || "—"} caption="Unique base assets" tone="neutral" /><Coverage label={copy.excludedLabel} value={0} caption="Excluded from scanning" tone="coral" /><Coverage label="Quote coins" value={new Set(cryptoInstruments.map((item) => item.quoteCoin)).size || "—"} caption="Available for routing" tone="neutral" /></div></div>
          <div className="panel rounded-lg p-5"><div className="mb-5 flex items-start justify-between"><div><div className="eyebrow">Market pulse</div><h2 className="mt-1 text-lg font-semibold text-foreground">Signal health</h2></div><Search className="h-4 w-4 text-muted-foreground" /></div><div className="mb-5 flex items-end justify-between"><div><div className="font-mono text-3xl font-semibold text-primary">{market ? "NOMINAL" : "—"}</div><div className="mt-1 text-xs text-muted-foreground">Public feed connection</div></div><div className="text-right"><div className="font-mono text-sm text-foreground">{market?.tickers.length ?? "—"}</div><div className="text-xs text-muted-foreground">quotes parsed</div></div></div><div className="h-16 overflow-hidden"><svg viewBox="0 0 520 64" preserveAspectRatio="none" className="h-full w-full"><path className="sparkline" d="M0 48 C22 46 24 35 44 39 S70 27 91 34 S120 52 142 40 S166 44 182 26 S208 35 226 32 S248 46 266 31 S288 21 308 30 S337 46 354 26 S376 31 396 17 S423 35 438 27 S466 36 482 17 S501 18 520 7" /></svg></div></div>
        </section>
        {error && <div className="mt-6 rounded-md border border-coral/30 bg-coral/10 p-3 text-sm text-coral">{error}. Try refreshing to reconnect.</div>}
        <footer className="mt-8 flex flex-col justify-between gap-2 border-t border-border pt-5 text-[11px] text-muted-foreground sm:flex-row"><span>LOOPLINE / public market data only</span><span>Execution is not included · Verify liquidity, fees, and slippage before trading</span></footer>
      </div>
      <RouteDetail
        opportunity={selected}
        fee={scanRequest?.fee ?? fee}
        convertSpread={scanRequest?.convertSpread ?? convertSpread}
        fetchedAt={scanRequest?.market.fetchedAt ?? market?.fetchedAt}
        onClose={() => setSelected(null)}
      />
    </main>
  );
}

function Metric({ label, value, detail, icon, tone = "default" }: { label: string; value: string; detail: string; icon: React.ReactNode; tone?: string }) {
  return <div className="panel rounded-lg p-4"><div className="mb-4 flex items-center justify-between"><span className="text-xs text-muted-foreground">{label}</span><span className={`text-${tone === "default" ? "muted-foreground" : tone} [&_svg]:h-4 [&_svg]:w-4`}>{icon}</span></div><div className="font-mono text-2xl font-semibold text-foreground">{value}</div><div className="mt-1 truncate text-[11px] text-muted-foreground">{detail}</div></div>;
}

function OpportunityTable({ opportunities, loading, onSelect }: { opportunities: Opportunity[]; loading: boolean; onSelect: (item: Opportunity) => void }) {
  if (loading && opportunities.length === 0) return <div className="flex min-h-[300px] items-center justify-center gap-3 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin text-primary" />Reading live order books…</div>;
  if (opportunities.length === 0) return <div className="flex min-h-[300px] flex-col items-center justify-center px-6 text-center"><div className="mb-3 rounded-full bg-accent p-3 text-primary"><Search className="h-5 w-5" /></div><h3 className="font-medium text-foreground">No routes above threshold</h3><p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">The scanner found no net-positive cycle at the current fee and profit settings. Lower the floor to inspect the live market.</p></div>;
  return <div className="table-scroll"><div className="min-w-[690px]"><div className="grid grid-cols-[1.6fr_.7fr_.7fr_.7fr_30px] gap-4 px-5 py-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"><span>Route</span><span>Net edge</span><span>Gross</span><span>Liquidity</span><span /></div>{opportunities.slice(0, 8).map((item, index) => { const start = item.assets[0]; if (!start || item.legs.length === 0) return null; return <div role="button" tabIndex={0} onClick={() => onSelect(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(item); } }} className="data-row grid cursor-pointer grid-cols-[1.6fr_.7fr_.7fr_.7fr_30px] items-center gap-4 px-5 py-4 outline-none focus-visible:bg-accent/40" key={item.id}><div className="flex flex-wrap items-center gap-2"><span className="w-4 font-mono text-[10px] text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><div className="flex flex-wrap items-center gap-1.5"><Asset name={start} />{item.legs.map((leg, legIndex) => <span className="flex items-center gap-1.5" key={`${item.id}-${legIndex}-${leg.symbol}`}><span className={`route-arrow ${leg.side === "Convert" ? "text-primary" : ""}`} title={leg.side === "Convert" ? `Bybit Convert ${leg.from} → ${leg.to}` : `${leg.side} ${leg.symbol} @ ${formatPrice(leg.price)}`}>{leg.side === "Convert" ? "⇢" : "→"}</span><Asset name={leg.to} /></span>)}</div>{item.stocks > 0 && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] font-medium text-warning">{item.stocks > 1 ? `${item.stocks}× xS` : "xS"}</span>}{item.converts > 0 && <span className="rounded bg-accent px-1.5 py-0.5 text-[9px] font-medium text-primary">{item.converts > 1 ? `${item.converts}× CONVERT` : "CONVERT"}</span>}</div><span className="font-mono text-sm font-semibold text-primary">{formatPercent(item.net)}</span><span className="font-mono text-xs text-muted-foreground">{formatPercent(item.gross)}</span><span className="font-mono text-xs text-muted-foreground">${(item.volume / 1000000).toFixed(1)}m</span><Button variant="ghost" size="icon" aria-label={`Inspect ${item.id}`} onClick={(event) => { event.stopPropagation(); onSelect(item); }}><ChevronDown className="h-4 w-4 -rotate-90" /></Button></div>; })}</div></div>;
}

function formatUnits(value: number) {
  if (!Number.isFinite(value) || value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

function formatUsd(value: number) {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
}

/** Detailed per-leg walkthrough of one route, simulated with a $1 notional. */
function RouteDetail({ opportunity, fee, convertSpread, fetchedAt, onClose }: { opportunity: Opportunity | null; fee: number; convertSpread: number; fetchedAt?: string | undefined; onClose: () => void }) {
  if (!opportunity) return null;
  const start = opportunity.assets[0] ?? "";

  // Simulate in units of the start asset: $1 buys 1 notional unit, and because the cycle returns
  // to `start`, the closing balance is directly comparable to the $1 that went in.
  let balance = 1;
  const steps = opportunity.legs.map((leg) => {
    const rate = leg.side === "Buy" ? 1 / leg.price : leg.side === "Sell" ? leg.price : leg.price;
    const cost = leg.side === "Convert" ? convertSpread : fee;
    const before = balance;
    const gross = before * rate;
    const charged = gross * cost;
    balance = gross - charged;
    return { leg, rate, cost, before, gross, charged, after: balance };
  });

  const out = balance;
  const pnl = out - 1;
  const profitable = pnl >= 0;
  const spotLegs = opportunity.legs.filter((leg) => leg.side !== "Convert").length;
  const convertLegs = opportunity.legs.length - spotLegs;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/80 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={`Route detail ${opportunity.assets.join(" to ")}`} onClick={onClose}>
      <div className="panel max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-lg sm:rounded-lg" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <div className="eyebrow">Route report</div>
            <h2 className="mt-1 flex flex-wrap items-center gap-1.5 text-lg font-semibold text-foreground">
              <Asset name={start} />
              {opportunity.legs.map((leg, index) => (
                <span className="flex items-center gap-1.5" key={`detail-${index}-${leg.symbol}`}>
                  <span className={`route-arrow ${leg.side === "Convert" ? "text-primary" : ""}`}>{leg.side === "Convert" ? "⇢" : "→"}</span>
                  <Asset name={leg.to} />
                </span>
              ))}
            </h2>
            <p className="mt-2 text-xs text-muted-foreground">
              {opportunity.legs.length} legs · {spotLegs} spot @ {(fee * 100).toFixed(2)}% fee{convertLegs > 0 ? ` · ${convertLegs} Convert @ ${(convertSpread * 100).toFixed(2)}% spread` : ""}
              {fetchedAt ? ` · quotes ${new Date(fetchedAt).toLocaleTimeString()}` : ""}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>

        <div className="grid grid-cols-2 gap-3 border-b border-border p-5 sm:grid-cols-4">
          <div><div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Stake</div><div className="mt-1 font-mono text-lg text-foreground">$1.0000</div></div>
          <div><div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Returns</div><div className="mt-1 font-mono text-lg text-foreground">{formatUsd(out)}</div></div>
          <div><div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{profitable ? "Profit" : "Loss"}</div><div className={`mt-1 font-mono text-lg ${profitable ? "text-primary" : "text-coral"}`}>{formatUsd(pnl)}</div></div>
          <div><div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Net edge</div><div className={`mt-1 font-mono text-lg ${profitable ? "text-primary" : "text-coral"}`}>{formatPercent(pnl)}</div></div>
        </div>

        <div className="p-5">
          <div className="mb-3 text-xs font-medium text-foreground">Leg-by-leg conversion</div>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md bg-surface-subtle px-3 py-2 text-xs">
              <span className="text-muted-foreground">Start</span>
              <span className="font-mono text-foreground">$1.0000 → {formatUnits(1)} {start} notional</span>
            </div>
            {steps.map((step, index) => (
              <div className="rounded-md border border-border p-3" key={`step-${index}-${step.leg.symbol}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <span className="font-mono text-[10px] text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${step.leg.side === "Convert" ? "bg-accent text-primary" : "bg-surface-subtle text-muted-foreground"}`}>{step.leg.side === "Convert" ? "CONVERT" : step.leg.side.toUpperCase()}</span>
                    <span className="font-mono text-xs">{step.leg.side === "Convert" ? `${step.leg.from} → ${step.leg.to}` : step.leg.symbol}</span>
                    {step.leg.stock && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning">xS</span>}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {step.leg.side === "Convert" ? "USD-mid rate" : `${step.leg.side === "Buy" ? "ask" : "bid"} ${formatPrice(step.leg.price)}`}
                  </div>
                </div>
                <div className="mt-2 grid gap-1 font-mono text-[11px] text-muted-foreground sm:grid-cols-2">
                  <div>In: {formatUnits(step.before)} {step.leg.from}</div>
                  <div>Rate: 1 {step.leg.from} = {formatUnits(step.rate)} {step.leg.to}</div>
                  <div>{step.leg.side === "Convert" ? "Spread" : "Fee"} ({(step.cost * 100).toFixed(2)}%): −{formatUnits(step.charged)} {step.leg.to}</div>
                  <div className="text-foreground">Out: {formatUnits(step.after)} {step.leg.to}</div>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between rounded-md bg-surface-subtle px-3 py-2 text-xs">
              <span className="text-muted-foreground">Close</span>
              <span className={`font-mono ${profitable ? "text-primary" : "text-coral"}`}>{formatUnits(out)} {start} ≈ {formatUsd(out)} ({formatUsd(pnl)})</span>
            </div>
          </div>

          <div className="mt-4 flex gap-2 rounded-md border border-warning/25 bg-warning/10 p-3 text-[11px] leading-4 text-warning">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Modelled at top-of-book with no slippage. A $1 notional is below Bybit minimum order sizes — this is a ratio simulation, not an executable ticket. Route liquidity is capped by its thinnest leg (${(opportunity.volume / 1_000_000).toFixed(2)}m 24h turnover){convertLegs > 0 ? ", and Convert quotes are modelled from the USD reference mid rather than a live quote" : ""}.</span>
          </div>
        </div>
      </div>
    </div>
  );
}



function MarketTable({ instruments, tickers, query }: { instruments: Instrument[]; tickers: Ticker[]; query: string }) {
  const rows = instruments.filter((item) => !query || item.symbol.toLowerCase().includes(query.toLowerCase())).slice(0, 16);
  const quotes = new Map(tickers.map((item) => [item.symbol, item]));
  return <div className="table-scroll"><div className="min-w-[620px]"><div className="flex items-center gap-3 border-b border-border px-5 py-4"><Search className="h-4 w-4 text-muted-foreground" /><input className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" placeholder="Search symbol" value={query} readOnly /></div><div className="grid grid-cols-[1.2fr_.8fr_.8fr_.6fr] gap-4 px-5 py-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"><span>Symbol</span><span>Bid</span><span>Ask</span><span>24h</span></div>{rows.map((instrument) => { const quote = quotes.get(instrument.symbol); const change = parseNumber(quote?.price24hPcnt ?? "0"); return <div className="data-row grid grid-cols-[1.2fr_.8fr_.8fr_.6fr] items-center gap-4 px-5 py-3 text-sm" key={instrument.symbol}><span className="flex items-center gap-2 font-mono font-medium text-foreground"><Star className="h-3.5 w-3.5 text-muted-foreground" />{instrument.symbol}{instrument.symbolType === "xstocks" && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning">xS</span>}</span><span className="font-mono text-xs text-muted-foreground">{formatPrice(parseNumber(quote?.bid1Price ?? "0"))}</span><span className="font-mono text-xs text-muted-foreground">{formatPrice(parseNumber(quote?.ask1Price ?? "0"))}</span><span className={`flex items-center gap-1 font-mono text-xs ${change >= 0 ? "text-primary" : "text-coral"}`}>{change >= 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}{formatPercent(change)}</span></div>; })}</div></div>;
}

function Coverage({ label, value, caption, tone }: { label: string; value: number | string; caption: string; tone: string }) {
  return <div className="panel-subtle rounded-md p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs text-muted-foreground">{label}</span><span className={`h-2 w-2 rounded-full bg-${tone === "neutral" ? "muted-foreground" : tone}`} /></div><div className="font-mono text-2xl font-semibold text-foreground">{value}</div><div className="mt-1 text-[11px] text-muted-foreground">{caption}</div></div>;
}