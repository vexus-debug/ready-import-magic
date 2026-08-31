export type Instrument = {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  status: string;
  symbolType?: string;
};

export type Ticker = {
  symbol: string;
  bid1Price: string;
  ask1Price: string;
  lastPrice: string;
  price24hPcnt: string;
  turnover24h: string;
};

type MarketResponse = { fetchedAt: string; instruments: Instrument[]; tickers: Ticker[] };
export type Leg = { symbol: string; from: string; to: string; side: "Sell" | "Buy" | "Convert"; price: number; stock: boolean };
export type Opportunity = { id: string; assets: string[]; legs: Leg[]; gross: number; net: number; volume: number; stock: boolean; stocks: number; converts: number };

const REFRESH_MS = 10_000;
const DEFAULT_FEE = 0.001;
const DEFAULT_CONVERT_SPREAD = 0.002;
/** Safety ceiling on DFS expansions per start asset; only trips on pathological fan-out. */
const WORK_BUDGET = 4_000_000;
/** Spot legs kept in the convert-bridge pool (turnover-filtered, ranked by USD-normalised gain). */
const CONVERT_POOL = 90;
/** Fiat currencies quoted on Bybit spot — excluded so the scanner only ever touches crypto. */
const FIAT = new Set([
  "USD", "EUR", "GBP", "JPY", "KRW", "AUD", "CAD", "CHF", "NZD", "BRL", "TRY", "PLN", "CZK", "DKK", "HUF", "NOK", "SEK", "RON",
  "ARS", "MXN", "UAH", "RUB", "NGN", "KES", "ZAR", "AED", "SAR", "ILS", "HKD", "SGD", "TWD", "IDR", "INR", "PHP", "VND", "THB",
  "MYR", "KZT", "GEL", "MNT", "BDT", "PKR", "LKR", "EGP", "MAD", "DZD", "TND", "QAR", "KWD", "BHD", "OMR", "JOD", "COP", "CLP",
  "PEN", "UYU", "PYG", "BOB", "GTQ", "DOP", "CRC", "PAB", "NIO", "HNL", "SVC", "GYD", "BBD", "XCD", "JMD", "TTD", "BSD", "BZD",
  "BWP", "MZN", "ZMW", "TZS", "UGX", "GHS", "XOF", "XAF", "CDF", "RWF", "BIF", "DJF", "ETB", "MGA", "MUR", "SCR", "KMF", "SLL",
  "LRD", "GMD", "GNF", "HTG", "CUP", "VES", "NPR", "AFN", "MMK", "KHR", "LAK", "MOP", "BND", "FJD", "PGK", "WST", "TOP", "SBD",
  "VUV", "ISK", "GIP", "FKP", "SHP", "GGP", "JEP", "IMP", "BAM", "MKD", "RSD", "MDL", "ALL", "BYN", "TMT", "TJS", "KGS", "UZS",
  "AZN", "AMD", "IQD", "LBP", "SYP", "YER", "LYD", "SDG", "SSP", "ERN", "SOS", "MRU", "STN", "CVE", "AOA", "NAD", "LSL", "SZL",
]);
/** Crypto-only universe: drops tokenized stock (xStocks) and fiat-quoted instruments. */
const isCryptoInstrument = (instrument: Instrument) =>
  instrument.symbolType !== "xstocks" && !FIAT.has(instrument.baseCoin) && !FIAT.has(instrument.quoteCoin);
/** Crypto + fiat universe: keeps crypto and fiat-quoted pairs, drops tokenized stocks. */
const isCryptoFiatInstrument = (instrument: Instrument) =>
  instrument.symbolType !== "xstocks";
/** Crypto + stocks universe: keeps crypto and xStock pairs, drops fiat-quoted instruments. */
const isCryptoStockInstrument = (instrument: Instrument) =>
  !FIAT.has(instrument.baseCoin) && !FIAT.has(instrument.quoteCoin);
/** Stocks + fiat universe: keeps tokenized stocks and fiat-quoted pairs, drops pure crypto-crypto instruments. */
const isStocksFiatInstrument = (instrument: Instrument) =>
  instrument.symbolType === "xstocks" || FIAT.has(instrument.baseCoin) || FIAT.has(instrument.quoteCoin);
/** xStocks universe: tokenized stocks quoted in USDT — the only crypto allowed on these routes. */
const isXstockInstrument = (instrument: Instrument) =>
  instrument.symbolType === "xstocks" && instrument.quoteCoin === "USDT" && !FIAT.has(instrument.baseCoin);
export type Universe = "crypto" | "crypto-fiat" | "crypto-stocks" | "stocks-fiat" | "xstocks" | "cross";
/** Per-universe filter. */
export const universeFilter: Record<Universe, (instrument: Instrument) => boolean> = {
  crypto: isCryptoInstrument,
  "crypto-fiat": isCryptoFiatInstrument,
  "crypto-stocks": isCryptoStockInstrument,
  "stocks-fiat": isStocksFiatInstrument,
  xstocks: isXstockInstrument,
  cross: () => true,
};
export const UNIVERSE_COPY: Record<Universe, { tag: string; hero: string; pairLabel: string; spotLabel: string; assetLabel: string; excludedLabel: string; convertLegs: string }> = {
  crypto: {
    tag: "CRYPTO",
    hero: "Triangular routes across every crypto coin quoted on Bybit spot — no fiat, no tokenized stocks.",
    pairLabel: "Crypto pairs",
    spotLabel: "Crypto spot",
    assetLabel: "Crypto coins",
    excludedLabel: "Fiat & stocks",
    convertLegs: "Coin → coin hops off spot",
  },
  "crypto-fiat": {
    tag: "₿↔$",
    hero: "Routes bridging crypto and fiat-quoted pairs on Bybit spot — no tokenized stocks.",
    pairLabel: "Crypto + fiat pairs",
    spotLabel: "Crypto + fiat spot",
    assetLabel: "Crypto & fiat",
    excludedLabel: "Tokenized stocks",
    convertLegs: "Crypto ↔ fiat hops off spot",
  },
  "crypto-stocks": {
    tag: "₿↔xS",
    hero: "Routes bridging crypto and tokenized stocks on Bybit spot — no fiat currencies.",
    pairLabel: "Crypto + stock pairs",
    spotLabel: "Crypto + stock spot",
    assetLabel: "Crypto & xStocks",
    excludedLabel: "Fiat currencies",
    convertLegs: "Crypto ↔ xStock hops off spot",
  },
  "stocks-fiat": {
    tag: "xS↔$",
    hero: "Routes bridging tokenized stocks and fiat-quoted pairs on Bybit spot — pure crypto-crypto pairs excluded.",
    pairLabel: "Stocks + fiat pairs",
    spotLabel: "Stocks + fiat spot",
    assetLabel: "xStocks & fiat",
    excludedLabel: "Pure crypto",
    convertLegs: "Stock ↔ fiat hops off spot",
  },
  xstocks: {
    tag: "xS↔₮",
    hero: "xStock-to-xStock routes on Bybit spot, routed through USDT — the only crypto allowed on these cycles.",
    pairLabel: "xStock pairs",
    spotLabel: "xStock spot",
    assetLabel: "xStocks",
    excludedLabel: "Fiat & other crypto",
    convertLegs: "xStock ↔ USDT hops off spot",
  },
  cross: {
    tag: "ALL",
    hero: "Cross-asset routes spanning crypto, tokenized stocks, and fiat-quoted pairs on Bybit spot.",
    pairLabel: "All pairs",
    spotLabel: "Full spot book",
    assetLabel: "Base assets",
    excludedLabel: "Nothing",
    convertLegs: "Any asset hops off spot",
  },
};

function parseNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;

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
export function createScanPass(
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

export type ScannerSettings = {
  fee: number;
  maxLegs: number;
  useConvert: boolean;
  convertSpread: number;
  universe: Universe;
  excludedSymbols: Set<string>;
};

export function scanMarket(instruments: Instrument[], tickers: Ticker[], settings: ScannerSettings) {
  const pass = createScanPass(
    instruments,
    tickers,
    settings.fee,
    settings.maxLegs,
    settings.useConvert,
    settings.convertSpread,
    settings.universe,
    settings.excludedSymbols,
  );
  const best = new Map<string, Opportunity>();
  for (const step of pass.steps) {
    for (const candidate of step()) {
      const key = candidate.legs.map((leg) => leg.symbol).sort().join('/');
      const current = best.get(key);
      if (!current || current.net < candidate.net) best.set(key, candidate);
    }
  }
  return {
    opportunities: [...best.values()].sort((a, b) => b.net - a.net),
    assetCount: pass.assetCount,
    passCount: pass.steps.length,
  };
}

