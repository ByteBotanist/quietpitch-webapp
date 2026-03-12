import { useState, useEffect, useRef } from 'react';
import SummitChart from './SummitChart';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import html2canvas from 'html2canvas';
import { useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { useMemo } from 'react';
import "react-datepicker/dist/react-datepicker.css";
import DOMPurify from 'dompurify';
import { fetchFmpSummary } from "../api/fmp";
import { fetchStooqChart } from "../api/stooq";


// Pick readable text color (black/white) for any hex
const pickOn = (hex) => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  // relative luminance (rough)
  const L = (0.2126*(r/255) + 0.7152*(g/255) + 0.0722*(b/255));
  return L > 0.56 ? '#000000' : '#ffffff';
};

// Theme toggle helpers
const THEME_KEY = (slug) => (slug ? `sv:${slug}:pref:theme` : 'sv:theme');
const getTheme = (slug) => localStorage.getItem(THEME_KEY(slug)) || 'light';
const setTheme = (slug, mode) => {
  document.documentElement.setAttribute('data-theme', mode);
  try { localStorage.setItem(THEME_KEY(slug), mode); } catch {}
};

const HISTORY_DATES_KEY = (slug) =>
  slug ? `sv:${slug}:history:dates` : null;

function sanitizeNoteHtml(html) {
  let clean = DOMPurify.sanitize(html || '', {
    ALLOWED_TAGS: [
      'a','p','br','ul','ol','li',
      'strong','b','em','i','u','s',
      'blockquote','code','pre','span',
      'h1','h2','h3','h4','h5','h6'
    ],
    ALLOWED_ATTR: ['href','title','target','rel'],
  });

  // Fix links safely without re-serializing everything
  clean = clean.replaceAll(
    /<a\s+([^>]*href=["'](?!https?:\/\/)[^"']*["'][^>]*)>/gi,
    '<a>'
  );
  clean = clean.replaceAll(
    /<a\s+([^>]*)>/gi,
    '<a $1 target="_blank" rel="noopener noreferrer">'
  );

  return clean;
}

// ===== FX (tiered) =====
const CURRENCIES = ["USD","EUR","JPY","GBP","AUD","CAD","CHF","NZD"];
const CURRENCY_SIGNS = {
  USD: "$", EUR: "€", JPY: "¥", GBP: "£", AUD: "A$", CAD: "C$", CHF: "CHF", NZD: "NZ$"
};

// Cache key granularity by plan (you can tweak later if your paid provider supports true realtime)
const fxBucketForPlan = (plan) => {
  if (plan === 'advanced') return 'min';   // minute bucket
  if (plan === 'pro')      return 'hour';  // hour bucket
  return 'day';                             // basic = daily
};

const fxKey = (slug, base, plan) => {
  const now = new Date();
  const b = fxBucketForPlan(plan);
  const parts = {
    day:  now.toISOString().slice(0,10),                                   // YYYY-MM-DD
    hour: now.toISOString().slice(0,13),                                   // YYYY-MM-DDTHH
    min:  now.toISOString().slice(0,16).replace(':','-'),                  // YYYY-MM-DDTHH-MM
  };
  const bucket = parts[b] || parts.day;
  return slug ? `sv:${slug}:fx:${base}:${plan}:${bucket}` : null;
};

const chartCache = new Map();
// key example: "STOOQ:AAPL:1Y"

function cacheKey(provider, symbol, timeframe) {
  return `${provider}:${symbol}:${timeframe}`;
}

function getCached(key, ttlMs = 5 * 60 * 1000) {
  const v = chartCache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > ttlMs) {
    chartCache.delete(key);
    return null;
  }
  return v.data;
}

function setCached(key, data) {
  chartCache.set(key, { t: Date.now(), data });
}

function getContactCtaLabel(regulatoryStatus) {
  const s = (regulatoryStatus || "").toLowerCase();

  if (!s) return "Contact";
  if (s.includes("not registered") || s.includes("educational")) {
    return "Contact Publisher";
  }
  // RIA / BD / Dual
  return "Contact Advisor";
}

function isRegistered(regulatoryStatus) {
  const s = (regulatoryStatus || "").toLowerCase();
  return (
    s.includes("ria") ||
    s.includes("broker") ||
    s.includes("dual")
  );
}

// ---- Free (Basic) provider: Frankfurter (ECB daily) ----
async function fetchFreeDailyUsd() {
  const res = await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR,JPY,GBP,AUD,CAD,CHF,NZD");
  if (!res.ok) throw new Error("FX free/daily fetch failed");
  const j = await res.json(); // { base:'USD', date:'YYYY-MM-DD', rates:{...} }
  return {
    base: 'USD',
    rates: { USD: 1, ...(j?.rates || {}) },
    asOf: j?.date || new Date().toISOString().slice(0,10),
    source: 'daily',
  };
}

function formatChangeForExport(value) {
  if (value == null || value === '') return '';

  const num = Number(value);
  if (!Number.isFinite(num)) return '';

  // Always export as human-readable percent
  return `${num.toFixed(2)}%`;
}

// ---- Paid provider (Pro/Advanced) placeholder ----
// Configure via env: VITE_PAID_FX_URL (e.g., https://api.yourfx.com/latest?base=USD&symbols=EUR,JPY,...)
// and VITE_PAID_FX_KEY for an Authorization header if needed.
// Shape expected: { base:'USD', timestamp: <epoch or ISO>, rates:{ EUR:..., ... } }
async function fetchPaidUsd() {
  const url = import.meta.env?.VITE_PAID_FX_URL;
  if (!url) throw new Error("Paid FX URL not configured");
  const headers = {};
  if (import.meta.env?.VITE_PAID_FX_KEY) {
    headers['Authorization'] = `Bearer ${import.meta.env.VITE_PAID_FX_KEY}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Paid FX fetch failed (${res.status})`);
  const j = await res.json();
  const asOf =
    j?.timestamp
      ? (typeof j.timestamp === 'number'
          ? new Date(j.timestamp * 1000).toISOString()
          : new Date(j.timestamp).toISOString())
      : new Date().toISOString();
  const raw = j?.rates || {};
  // Keep only the majors we support
  const pick = {};
  ["USD","EUR","JPY","GBP","AUD","CAD","CHF","NZD"].forEach(k => {
    const v = k === 'USD' ? 1 : raw[k];
    if (Number.isFinite(v)) pick[k] = v;
  });
  if (!pick.USD) pick.USD = 1;
  return { base:'USD', rates: pick, asOf, source: 'paid' };
}

// ---- Main entry: get FX based on plan (with fallback to daily) ----
async function getFxUsdForPlan(slug, plan) {
  const key = fxKey(slug, 'USD', plan);
  if (key) {
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (cached && cached.rates) return cached;
    } catch {}
  }

  // Try paid first for pro/advanced, else free daily
  let out = null;
  try {
    if (plan === 'pro' || plan === 'advanced') {
      out = await fetchPaidUsd();
    } else {
      out = await fetchFreeDailyUsd();
    }
  } catch {
    // fallback to daily free if paid not set or failed
    out = await fetchFreeDailyUsd();
  }

    // 🔴 Normalize FX to USD base BEFORE caching and returning
  out = normalizeFxToUsd(out);

  if (key) {
    try { localStorage.setItem(key, JSON.stringify(out)); } catch {}
  }
  return out;
}


// Safe parse helper
const safeParse = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

// Column sets
const ALL_COLUMN_KEYS = [
  'symbol','company','price','high','low','change',
  'volume','marketCap','peRatio',
  'sector','week52High','week52Low','beta'
];

const COLUMN_META = {
  symbol:        { type: 'static',  single: true },
  company:       { type: 'static',  single: false },

  price:         { type: 'price',   single: true, singleLabel: 'Close Price' },
  high:          { type: 'price',   single: false },
  low:           { type: 'price',   single: false },
  volume:        { type: 'price',   single: false },
  change:        { type: 'derived', single: true },

  week52High:    { type: 'derived', single: true },
  week52Low:     { type: 'derived', single: true },

  marketCap:     { type: 'fundamental', single: false },
  peRatio:       { type: 'fundamental', single: false },
  beta:          { type: 'fundamental', single: false },
  sector:        { type: 'fundamental', single: false },
};

const DEFAULT_COLUMNS_BY_MODE = {
  live:   ['symbol','company','price','high','low','change','volume'],
  single: ['symbol','price','change','week52High', 'week52Low'],
  range: ['symbol'],
};

const REQUIRED_COLUMNS = ['symbol'];

//ONE label for PRICE resolver helper
const getColumnLabel = (key, dateMode) => {
  const meta = COLUMN_META[key];
  if (!meta) return key;

  // Single-date override
  if (dateMode === 'single' && meta.singleLabel) {
    return meta.singleLabel;
  }

  // Default labels
  const DEFAULT_LABELS = {
    symbol: 'Symbol',
    company: 'Company',
    price: 'Price',
    high: 'High',
    low: 'Low',
    change: 'Change',
    volume: 'Volume',
    marketCap: 'Market Cap',
    peRatio: 'P/E Ratio',
    sector: 'Sector',
    week52High: '52W High',
    week52Low: '52W Low',
    beta: 'Beta',
  };

  return DEFAULT_LABELS[key] || key;
};

// ---- Date safety helpers ----
const safeDate   = (s) => (isValidYMD(s) ? new Date(s) : null);
const isValidYMD = (s) => {
  if (!s || typeof s !== "string") return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
};


// === Firm defaults (mock-first) ===
const DEFAULT_FIRM = {
  firmName: '',
  contactEmail: '',
  leadEmail: '',
  contactPhone: '',
  disclosure: {
    regulatoryStatus: '',
    dataSourceDisclosure: '',
    customDisclaimer: '',
  },
  logoUrl: null,
  logoDataUrl: null,
  logoPlacement: 'header',
  logoSizeHeader: 48,
  logoSizeFooter: 20,
  address: '',
  address2: '',
  city: '',
  state: '',
  zip: '',
  website: '',
  websiteLabel: '',
  linkedin: '',
  twitter: '',
  facebook: '',
  plan: 'basic',       // 'basic' | 'pro' | 'advanced'
  currency: 'USD',     // default currency for the page
  timeZone: 'UTC'
};

// chart time series
const DAYS_BY = {
  "1D": 7,
  "1W": 14,
  "1M": 31,
  "3M": 93,
  "6M": 186,
  "1Y": 366,
  "5Y": 1826,
};

//"MAX": 365*200, keep in sync with backend clamp - removed from the above until api expands as needed

function clampToWindow(data, days, endUtc) {
  const start = endUtc - (days - 1) * 86400000;
  return data.filter(([t]) => t >= start && t <= endUtc);
}


//draw lines for US2Y, US10Y, and US30Y
const UST_KEYS = { US2Y: "twoYear", US10Y: "tenYear", US30Y: "thirtyYear" };

// Pretty names for known instruments (extend freely)
const COMPANY_NAME_MAP = {
  // UST
  US2Y: "U.S. 2-Year Treasury",
  US10Y:"U.S. 10-Year Treasury",
  US30Y:"U.S. 30-Year Treasury",

  // Common equities (examples; expand as needed)
  AAPL:"Apple Inc.",
  MSFT:"Microsoft Corporation",
  SPY: "SPDR S&P 500 ETF",
};



const getCompanyName = (sym) => COMPANY_NAME_MAP[sym] || "";

function parseFredDateUTC(dstr) {
  const [y,m,d] = dstr.split("-").map(Number);
  return Date.UTC(y, (m ?? 1)-1, d ?? 1, 12); // noon UTC
}

async function fetchAllYields(days) {
  const base = import.meta.env?.VITE_API_BASE ?? "/api";
  const j = await fetch(`${base}/yields/us?days=${days}`).then(r => r.json());

  const rows = j.history ?? [];
  const endUtc = rows.reduce((max, p) => {
    const has = p.twoYear != null || p.tenYear != null || p.thirtyYear != null;
    if (!has) return max;
    const t = parseFredDateUTC(p.d);
    return t > max ? t : max;
  }, 0);

  const mk = (key) => clampToWindow(
  (j.history ?? []).map(p => [parseFredDateUTC(p.d), p[key]]).filter(([,v]) => v != null),
  days, endUtc
);  

console.log("🌊 fetchAllYields called with days:", days);


  return { US2Y: mk("twoYear"), US10Y: mk("tenYear"), US30Y: mk("thirtyYear"), asOf: j.asOf };
}

//field requirments for contact advisor
const COUNTRIES = [
  "United States","Canada","United Kingdom","Australia","South Africa","India",
  "Germany","France","Netherlands","Spain","Italy","Ireland","New Zealand",
  "Mexico","Brazil","Japan","Singapore","Hong Kong","United Arab Emirates",
  "Switzerland","Sweden","Norway","Denmark","Belgium","Other"
];
const US_STATES = [
  { abbr:"AL", name:"Alabama" }, { abbr:"AK", name:"Alaska" }, { abbr:"AZ", name:"Arizona" }, { abbr:"AR", name:"Arkansas" },
  { abbr:"CA", name:"California" }, { abbr:"CO", name:"Colorado" }, { abbr:"CT", name:"Connecticut" }, { abbr:"DE", name:"Delaware" },
  { abbr:"FL", name:"Florida" }, { abbr:"GA", name:"Georgia" }, { abbr:"HI", name:"Hawaii" }, { abbr:"ID", name:"Idaho" },
  { abbr:"IL", name:"Illinois" }, { abbr:"IN", name:"Indiana" }, { abbr:"IA", name:"Iowa" }, { abbr:"KS", name:"Kansas" },
  { abbr:"KY", name:"Kentucky" }, { abbr:"LA", name:"Louisiana" }, { abbr:"ME", name:"Maine" }, { abbr:"MD", name:"Maryland" },
  { abbr:"MA", name:"Massachusetts" }, { abbr:"MI", name:"Michigan" }, { abbr:"MN", name:"Minnesota" }, { abbr:"MS", name:"Mississippi" },
  { abbr:"MO", name:"Missouri" }, { abbr:"MT", name:"Montana" }, { abbr:"NE", name:"Nebraska" }, { abbr:"NV", name:"Nevada" },
  { abbr:"NH", name:"New Hampshire" }, { abbr:"NJ", name:"New Jersey" }, { abbr:"NM", name:"New Mexico" }, { abbr:"NY", name:"New York" },
  { abbr:"NC", name:"North Carolina" }, { abbr:"ND", name:"North Dakota" }, { abbr:"OH", name:"Ohio" }, { abbr:"OK", name:"Oklahoma" },
  { abbr:"OR", name:"Oregon" }, { abbr:"PA", name:"Pennsylvania" }, { abbr:"RI", name:"Rhode Island" }, { abbr:"SC", name:"South Carolina" },
  { abbr:"SD", name:"South Dakota" }, { abbr:"TN", name:"Tennessee" }, { abbr:"TX", name:"Texas" }, { abbr:"UT", name:"Utah" },
  { abbr:"VT", name:"Vermont" }, { abbr:"VA", name:"Virginia" }, { abbr:"WA", name:"Washington" }, { abbr:"WV", name:"West Virginia" },
  { abbr:"WI", name:"Wisconsin" }, { abbr:"WY", name:"Wyoming" }, { abbr:"DC", name:"District of Columbia" },
];

const emailOk = e => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const phoneOk = p => !p || p.replace(/\D/g, "").length >= 7;

const isLeadValid = l =>
  l.name.trim() &&
  l.country &&
  (l.country === "United States" ? !!l.state
   : l.country === "Other" ? !!l.countryOther.trim()
   : true) &&
  (l.email.trim() || l.phone.trim()) &&
  emailOk(l.email) &&
  phoneOk(l.phone);


const buildSummaryExportRows = (rows, selectedColumns) =>
  rows.map(r => {
    const o = {};

    selectedColumns.forEach(k => {
      if (k === 'change') {
  const val = Number(r[k]);

  if (!Number.isFinite(val)) {
    o[k] = '';
  } else if (r.symbol?.startsWith('US')) {
    o[k] = `${val >= 0 ? '+' : ''}${val.toFixed(2)} pp`;
  } else {
    o[k] = `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
  }

  return;
}


      // ✅ Add % for treasury price
      if (k === 'price' && r.symbol?.startsWith('US')) {
        const val = Number(r[k]);

        if (!Number.isFinite(val)) {
          o[k] = '';
        } else {
          o[k] = `${val.toFixed(2)}%`;
        }

        return;
      }

      o[k] = r[k];
    });

    return o;
  });

const buildHistoryExportRows = (rows, symbol) =>
  (rows || []).map(r => {
    const isUST = symbol?.startsWith('US');
    const isPM  = symbol?.startsWith('PM:');

    let formattedChange = '';

    if (r.change != null && r.change !== '') {
      const val = Number(r.change);

      if (Number.isFinite(val)) {
        if (isUST) {
          // Treasury → percentage points
          formattedChange = `${val >= 0 ? '+' : ''}${val.toFixed(2)} pp`;
        } else {
          // PM + Equities → percent
          formattedChange = `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
        }
      }
    }

    return {
      ...r,
      change: formattedChange,
    };
  });

// CSV export (generic)
const exportCSV = (rows, filename, columns) => {
  if (!rows?.length || !columns?.length) return;

  const exportRows = rows;

  const csv = [columns.join(',')].concat(
    exportRows.map(r =>
      columns
        .map(k => `"${String(r[k] ?? '').replaceAll('"','""')}"`)
        .join(',')
    )
  ).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

// Excel export
const exportXLSX = (rows, filename, columns) => {
  if (!rows?.length || !columns?.length) return;

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
};

// PDF export
const exportPDF = (rows, title, filename, columns) => {
  if (!rows?.length || !columns?.length) return;

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const data = rows.map(r =>
    columns.map(k => String(r[k] ?? ''))
  );

  doc.setFontSize(14);
  doc.text(title, 40, 40);

  autoTable(doc, {
    head: [columns],
    body: data,
    startY: 60,
    styles: { fontSize: 10 }
  });

  doc.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
};

// --- FX helpers for display ---
const PLAN_SHOWS_FX_ASOF = new Set(['basic']); // only show for paid tiers

// helper: same calendar day in a timezone
const sameDay = (a, b, tz='UTC') => {
  const fmt = (d) => d.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  return fmt(a) === fmt(b);
};

// Use UTC and avoid implying intraday by shifting off "today" for daily sources
const formatFxAsOf = (asOf, tz = 'UTC', source = 'daily') => {
  try {
    let d = new Date(asOf);
    const now = new Date();

    // If your provider is daily (e.g., ECB/Frankfurter) and the date prints as "today",
    // show the previous day instead so users don’t think it’s realtime.
    if (source === 'daily' && sameDay(d, now, tz)) {
      // subtract 1 day in UTC
      d = new Date(d.getTime() - 24 * 60 * 60 * 1000);
    }

    return d.toLocaleString('en-US', {
      timeZone: tz, year: 'numeric', month: 'short', day: 'numeric'
    });
  } catch {
    return asOf;
  }
};

// 🔁 Convert USD price series → selected currency
function convertSeriesMap(seriesMap, fxRate, seriesUnits = {}) {
  if (!fxRate || fxRate === 1) return seriesMap;

  const out = {};
  for (const symbol in seriesMap) {
    const unit = seriesUnits[symbol] || 'price';

    // ❗ Do NOT convert percent series (yields, rates)
    if (unit !== 'price') {
      out[symbol] = seriesMap[symbol];
      continue;
    }

    out[symbol] = seriesMap[symbol].map(([t, v]) => [
      t,
      v == null ? v : v * fxRate
    ]);
  }
  return out;
}

// --- FX normalization helper (REQUIRED) ---
function normalizeFxToUsd(fx) {
  if (!fx || !fx.rates) return fx;

  // Already USD-based
  if (fx.base === 'USD' || fx.rates.USD === 1) {
    return {
      ...fx,
      base: 'USD',
      rates: { ...fx.rates, USD: 1 }
    };
  }

  // Need USD pivot to normalize
  const usdPerBase = fx.rates.USD;
  if (!usdPerBase) return fx; // cannot normalize safely

  const normalizedRates = { USD: 1 };
  for (const [ccy, value] of Object.entries(fx.rates)) {
    if (ccy === 'USD') continue;
    normalizedRates[ccy] = value / usdPerBase;
  }

  return {
    ...fx,
    base: 'USD',
    rates: normalizedRates
  };
}

// --- Currency conversion + format helpers ---
function convertUsdTo(usdValue, targetCurrency, rates = {}) {
  if (!usdValue || !targetCurrency || !rates) return usdValue;
  const rate = rates[targetCurrency] || 1;
  return usdValue * rate;
}

function fmtMoney(value, currency = 'USD') {
  const sign = CURRENCY_SIGNS[currency] || '';
  const num = Number(value);
  if (Number.isNaN(num)) return '—';
  return `${sign}${num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const dbg = (...args) => console.log(...args);

const dbgEquity = (label, sym, obj) => {
  console.groupCollapsed(`🧪 [EQUITY DEBUG] ${label} :: ${sym}`);
  try {
    Object.entries(obj).forEach(([k, v]) => dbg(k, v));
  } finally {
    console.groupEnd();
  }
};

// Base URL for API calls.
// In dev, "/api" will be proxied to http://localhost:7071 by Vite.
const API_BASE =
  import.meta.env?.VITE_API_BASE   // optional override in prod
  ?? "/api";

export default function ClientDashboard() {
  const { slug } = useParams();                 // 1) get slug first
  // ===== Persistence & UI prefs (drop-in block) =====
const PREF_KEY = (slug, k) => `sv:${slug}:pref:${k}`;
const getSaved = (k, fallback = null) => {
  try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? fallback; }
  catch { return fallback; }
};

// Per-slug storage keys for the history panel
const HISTORY_KEY = (k) => (slug ? PREF_KEY(slug, `history:${k}`) : `history:${k}`);

const [loading, setLoading] = useState(false);

const [historyLoading, setHistoryLoading] = useState(false);

const equityFullRef = useRef({});

// read private cache
const [pmCacheVersion, setPmCacheVersion] = useState(() => {
  const v = slug ? Number(localStorage.getItem(PREF_KEY(slug, 'pmVersion')) || 0) : 0;
  return Number.isFinite(v) ? v : 0;
});

// read private cache (NOW refreshes when pmCacheVersion changes)
const pmItems = useMemo(
  () => safeParse(localStorage.getItem(PREF_KEY(slug, 'pmItems')), []),
  [slug, pmCacheVersion]
);
const pmSeries = useMemo(
  () => safeParse(localStorage.getItem(PREF_KEY(slug, 'pmSeries')), {}),
  [slug, pmCacheVersion]
);

// Helper to detect private market symbols
const isPM = (symbol) => symbol?.startsWith("PM:") || symbol?.includes("_FO");

useEffect(() => {
  console.log("PM CACHE SNAPSHOT", {
    pmSeriesKeys: Object.keys(pmSeries || {}),
    sample: Object.entries(pmSeries || {}).slice(0, 1),
  });
}, [pmSeries]);

const pmIndex = useMemo(
  () => Object.fromEntries((pmItems || []).map(it => [it.id, it])),
  [pmItems]
);

const patchCompanyForExport = (rows) =>
  (rows || []).map(r => {
    if (!r?.symbol?.startsWith("PM:")) return r;

    const pm = pmIndex?.[r.symbol];
    const pmName = pm?.name || pm?.title || pm?.label || "";

    return {
      ...r,
      company: pmName || r.company || "",
    };
  });

const patchTreasuryForExport = (rows) =>
  (rows || []).map(r => {
    if (!r?.symbol?.startsWith("US")) return r;

    const id = r.symbol;
    const rowsSeries = seriesMap[id] || [];

    const { latest, delta } = ustValueForMode(
      rowsSeries,
      effectiveDateMode,
      singleDate,
      startDate,
      endDate
    );

    return {
      ...r,
      price: latest != null ? latest : "",
      change: delta != null ? delta : "",
    };
  });

// --- Active tab (per-slug) ---
const [activeTab, setActiveTab] = useState(
  () => (slug && localStorage.getItem(PREF_KEY(slug, 'activeTab'))) || 'chart'
);
useEffect(() => {
  if (!slug) return;
  localStorage.setItem(PREF_KEY(slug, 'activeTab'), activeTab);
}, [slug, activeTab]);

// --- Chart type (per-slug) ---
const [chartType, setChartType] = useState(
  () => (slug && localStorage.getItem(PREF_KEY(slug, 'chartType'))) || 'line'
);
useEffect(() => {
  if (!slug) return;
  localStorage.setItem(PREF_KEY(slug, 'chartType'), chartType);
}, [slug, chartType]);

// --- Symbols (per-slug) ---
const DEFAULT_CHART   = []; // or []
const DEFAULT_SUMMARY = [];                       // or ["AAPL","MSFT","SPY"]

const [chartSymbols, setChartSymbols] = useState(() =>
  getSaved(PREF_KEY(slug, 'chartSymbols'), DEFAULT_CHART)
);

const [adminDefaults, setAdminDefaults] = useState({ chart: [], summary: [] });

// right where you define summarySymbols
const [summarySymbols, setSummarySymbols] = useState(() => {
  const saved = slug ? safeParse(localStorage.getItem(PREF_KEY(slug,'summarySymbols')), null) : null;
  if (Array.isArray(saved) && saved.length) return saved;

  // fall back to admin defaults (written earlier to localStorage)
  const adminLocal = safeParse(localStorage.getItem('adminSummaryDefaults'), null);
  if (Array.isArray(adminLocal) && adminLocal.length) return adminLocal;

  return Array.isArray(adminDefaults.summary) ? adminDefaults.summary : [];
});

//Sybmol list fallback
useEffect(() => {
  if (!slug) return;
  const saved = getSaved(PREF_KEY(slug,'chartSymbols'));
  if (!saved || saved.length === 0) {
    const seed = ["US2Y","US10Y","US30Y"];
    setChartSymbols(seed);
    localStorage.setItem(PREF_KEY(slug,'chartSymbols'), JSON.stringify(seed));
  }
}, [slug]);

// write-through on change
useEffect(() => {
  if (!slug) return;
  localStorage.setItem(PREF_KEY(slug, 'chartSymbols'), JSON.stringify(chartSymbols));
}, [slug, chartSymbols]);

useEffect(() => {
  if (!slug) return;
  localStorage.setItem(PREF_KEY(slug, 'summarySymbols'), JSON.stringify(summarySymbols));
}, [slug, summarySymbols]);

// one-time init per slug
const didInitSymbols = useRef(false);
useEffect(() => {
  if (!slug || didInitSymbols.current) return;
  didInitSymbols.current = true;

  // 1) user cache (per-slug)
  const savedChart   = getSaved(PREF_KEY(slug, 'chartSymbols'));
  const savedSummary = getSaved(PREF_KEY(slug, 'summarySymbols'));

  // 2) advisor defaults from firm blob (if present)
  const rawFirm = localStorage.getItem(`sv:${slug}:firm`);
  let adminChart = null, adminSummary = null, adminV = 0;
  if (rawFirm) {
    try {
      const s = JSON.parse(rawFirm);
      adminChart   = Array.isArray(s.positions?.chart)   ? s.positions.chart   : null;
      adminSummary = Array.isArray(s.positions?.summary) ? s.positions.summary : null;
      adminV = Number(s.positionsVersion || 0);
    } catch {}
  }

  const localV = Number(getSaved(PREF_KEY(slug, 'positionsVersion'), 0));

  // 3) choose sources (user cache → admin defaults → hard defaults)
  let initialChart   = savedChart   ?? adminChart   ?? DEFAULT_CHART;
  let initialSummary = savedSummary ?? adminSummary ?? DEFAULT_SUMMARY;

  // 4) if admin bumped, always replace local lists (so a refresh picks up admin changes)
if (adminV > localV) {
  if (adminChart)   initialChart   = adminChart;
  if (adminSummary) initialSummary = adminSummary;
  localStorage.setItem(PREF_KEY(slug,'positionsVersion'), String(adminV));
}


  setChartSymbols(initialChart);
  setSummarySymbols(initialSummary);

  // ensure per-slug cache exists so refresh won’t clear
  localStorage.setItem(PREF_KEY(slug, 'chartSymbols'),   JSON.stringify(initialChart));
  localStorage.setItem(PREF_KEY(slug, 'summarySymbols'), JSON.stringify(initialSummary));
}, [slug]);

// Exposed helper used by your "Reset" button in Summary
function resetSummarySymbols() {
  const next = adminDefaults.summary || [];
  setSummarySymbols(next);

  if (slug) {
    localStorage.setItem(
      PREF_KEY(slug, 'summarySymbols'),
      JSON.stringify(next)
    );
  }
}

useEffect(() => {
  // migrate away from legacy globals (safe no-ops if they don't exist)
  localStorage.removeItem('chartSymbols');
  localStorage.removeItem('summarySymbols');
  localStorage.removeItem('positionsVersion');
  localStorage.removeItem('whatIfAmount');
  localStorage.removeItem('isWhatIfMode');
}, []);

  const DEFAULT_TICKERS = ["AAPL","MSFT","SPY","TEST"]; // or your old defaults

  //Initialize symbols from admin defaults
  const getAdminChartDefaults   = () => safeParse(localStorage.getItem('adminChartDefaults'),   adminDefaults.chart);
  const getAdminSummaryDefaults = () => safeParse(localStorage.getItem('adminSummaryDefaults'), adminDefaults.summary);
  
  const [firm, setFirm] = useState(() => {
    try {
      const cached = localStorage.getItem(`sv:${slug}:firm`);
      return cached ? { ...DEFAULT_FIRM, ...JSON.parse(cached) } : DEFAULT_FIRM;
    } catch {
      return DEFAULT_FIRM;
    }
  });
  
  // 🔴 FX loader (THIS WAS MISSING)
useEffect(() => {
  if (!slug || !firm?.plan) return;

  let cancelled = false;

  (async () => {
    try {
      const out = await getFxUsdForPlan(slug, firm.plan);

      if (!cancelled && out?.rates) {
        console.log("FX LOADED", out);
        setFx(out);
      }
    } catch (e) {
      console.error("FX load failed", e);
    }
  })();

  return () => { cancelled = true; };
}, [slug, firm.plan]);
  const EMPTY_LEAD = { name:"", email:"", phone:"", country:"", state:"", countryOther:"" }; 

  //Contact advisor Lead generation tool
  const [showLead, setShowLead] = useState(false);
  const [lead, setLead] = useState(EMPTY_LEAD);
  const [leadErr, setLeadErr] = useState("");
  const leadTo = firm.leadEmail || firm.contactEmail;   // prefer leadEmail, fallback to existing email


  //move socials when no logo
  const hasFooterLogo =
    (firm.logoPlacement === 'footer' || firm.logoPlacement === 'both') &&
    (firm.logoDataUrl || firm.logoUrl);

  const headerH = Math.min(Number(firm.logoSizeHeader ?? 48), 100);
  const footerH = Math.min(Number(firm.logoSizeFooter ?? 20), 120);
  
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });

  // near your other state
const [appliedWhatIf, setAppliedWhatIf] = useState({ enabled: false, amount: 0 });
const [pendingWhatIf, setPendingWhatIf] = useState('');

//local version state
const [positionsVersion, setPositionsVersion] = useState(
  () => Number(localStorage.getItem('positionsVersion') || 0)
);

  // sort handler
  const handleSort = (key) => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'asc' };
    });
  };

  //Normalize PM series once
  const normalizePmSeries = (series) =>
  (Array.isArray(series) ? series : [])
    .map(([d, v]) => [
      typeof d === 'number' ? d : Date.parse(d),
      Number(v),
    ])
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);

 // dateMode FIRST
const [dateMode, setDateMode] = useState(() => localStorage.getItem('dateMode') || 'live');
const [singleDate, setSingleDate] = useState(() => {
  if (!slug) return '';
    return localStorage.getItem(PREF_KEY(slug, 'singleDate')) || '';
  });

useEffect(() => {
  if (!slug) return;
  localStorage.setItem(PREF_KEY(slug, 'singleDate'), singleDate || '');
}, [slug, singleDate]);

const [startDate, setStartDate] = useState(() => {
  if (!slug) return '';
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_DATES_KEY(slug)));
    return saved?.startDate || '';
  } catch {
    return '';
  }
});

const [endDate, setEndDate] = useState(() => {
  if (!slug) return '';
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_DATES_KEY(slug)));
    return saved?.endDate || '';
  } catch {
    return '';
  }
});

useEffect(() => {
  if (!slug) return;
  localStorage.setItem(
    HISTORY_DATES_KEY(slug),
    JSON.stringify({ startDate, endDate })
  );
}, [slug, startDate, endDate]);

const allowedColumns = useMemo(() => {
  return ALL_COLUMN_KEYS.filter((col) => {
    const meta = COLUMN_META[col];
    if (!meta) return false;
    if (dateMode === "single") return meta.single;
    return true; // live
  });
}, [dateMode]);

const isColumnAllowed = (key) =>
  dateMode !== 'single' || COLUMN_META[key]?.single;

const getPmAnchorTs = (sym) => {
  const series = pmSeries[sym] || [];
  if (!series.length) return null;

  // Single date explicitly chosen → use it
  if (dateMode === 'single' && singleDate) {
    return Date.parse(singleDate);
  }

  // Otherwise (live OR single-date-without-date)
  // → use most recent PM datapoint
  return series[series.length - 1][0];
};

const effectiveDateMode =
  dateMode === 'single' && !singleDate ? 'live' : dateMode;


//compute the anchor
const ymd = (d) => new Date(d).toISOString().slice(0,10);

const addDaysYmd = (ymdStr, days) => {
  const d = new Date(ymdStr);
  d.setDate(d.getDate() + days);
  return ymd(d);
};

const getAnchorEndYmd = () => {
  if (effectiveDateMode === 'single') return singleDate;
  if (effectiveDateMode === 'range' && endDate) return endDate;
  return new Date().toISOString().slice(0,10);
};

//history table 5yr anchor
const todayYmd = () => new Date().toISOString().slice(0, 10);

const fiveYearsAgoYmd = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
};

const clampToFiveYears = (s) => {
  if (!s) return s;
  const min = fiveYearsAgoYmd();
  const max = todayYmd();
  if (s < min) return min;
  if (s > max) return max;
  return s;
};

// persist
useEffect(() => {
  localStorage.setItem('dateMode', dateMode);
}, [dateMode]);


// selectedColumns — initialize from localStorage if present, otherwise default for current mode
const [selectedColumns, setSelectedColumns] = useState(() => {
  const saved = safeParse(localStorage.getItem('selectedColumns'), null);
  return saved || DEFAULT_COLUMNS_BY_MODE.live;
});

// 🔒 Enforce column eligibility by date mode (single vs live)
useEffect(() => {
  setSelectedColumns(prev => {
    const next = prev.filter(col => allowedColumns.includes(col));
    return next.length ? next : ['symbol']; // 👈 NEVER allow empty
  });
}, [allowedColumns]);


  const didInitCols = useRef(false);
  const [showColumnSelector, setShowColumnSelector] = useState(false);
  const columnSelectorRef = useRef(null);
  const selectAllRef = useRef(null);
  const isAllSelected =
    allowedColumns.length > 0 &&
    allowedColumns.every((col) => selectedColumns.includes(col));
  const isCustomizeColumnsDisabled = dateMode === "range";
  const chartContainerRef = useRef(null);

  const seriesUnitsMemo = useMemo(() => {
    const pmUnits = Object.fromEntries((pmItems || []).map(it => [it.id, it.unit]));
    const ids = Array.from(new Set([...chartSymbols, ...summarySymbols]));
    return Object.fromEntries(
      ids.map(s => [
        s,
        s.startsWith('US') ? 'percent'
        : s.startsWith('PM:') ? (pmUnits[s] || 'price')
        : 'price',
      ])
    );
  }, [chartSymbols, summarySymbols, pmItems]);

useEffect(() => {
  // If any PM in the Summary uses unit === 'percent', ensure 'change' is selected
  const pmPercentPresent = (summarySymbols || []).some(
    id => id.startsWith('PM:') && (seriesUnitsMemo[id] === 'percent')
  );

  if (pmPercentPresent && !selectedColumns.includes('change')) {
    setSelectedColumns(prev => [...prev, 'change']);
  }
}, [summarySymbols, seriesUnitsMemo, selectedColumns]);


const [advisorNotes, setAdvisorNotes] = useState([]);

// Open the first tab by default
const [openNoteIds, setOpenNoteIds] = useState(new Set());
  
//apply changes to public dashboard
useEffect(() => {
  setLoading(true);

  if (!slug) {
    setLoading(false);
    return;
  }

  const applySettings = (s) => {
    console.log("PUBLIC SETTINGS PAYLOAD", s);

    const adminChart = Array.isArray(s.positions?.chart) ? s.positions.chart : [];
    const adminSummary = Array.isArray(s.positions?.summary) ? s.positions.summary : [];
   
    setChartSymbols(adminChart);
    setSummarySymbols(adminSummary);

      setAdminDefaults({
        chart: adminChart,
        summary: adminSummary
      });

    localStorage.setItem(
      PREF_KEY(slug,'chartSymbols'),
      JSON.stringify(adminChart)
    );

    localStorage.setItem(
      PREF_KEY(slug,'summarySymbols'),
      JSON.stringify(adminSummary)
    );

    setFirm(prev => ({
      ...prev,
      firmName:s.branding?.firmName ?? s.firmName ?? s.contact?.firmName ?? prev.firmName,
      contactEmail: s.contact?.email ?? prev.contactEmail,
      leadEmail: s.contact?.leadEmail ?? prev.leadEmail,
      contactPhone: s.contact?.phone ?? prev.contactPhone,

      disclosure: {
        regulatoryStatus: s.disclosure?.regulatoryStatus ?? '',
        dataSourceDisclosure: s.disclosure?.dataSourceDisclosure ?? '',
        customDisclaimer: s.disclosure?.customDisclaimer ?? '',
      },

      logoUrl: s.branding?.logoUrl ?? prev.logoUrl,
      logoDataUrl: s.branding?.logoDataUrl ?? prev.logoDataUrl,
      logoPlacement: s.branding?.logoPlacement ?? prev.logoPlacement,
      logoSizeHeader: s.branding?.logoSizeHeader ?? prev.logoSizeHeader,
      logoSizeFooter: s.branding?.logoSizeFooter ?? prev.logoSizeFooter,

      plan: s.plan ?? prev.plan,
      currency: typeof s.currency === 'string' ? s.currency : prev.currency,
      timeZone: s.timeZone ?? prev.timeZone,

      address: s.contact?.address ?? prev.address,
      address1: s.contact?.address1 ?? prev.address1,
      address2: s.contact?.address2 ?? prev.address2,
      city: s.contact?.city ?? prev.city,
      state: s.contact?.state ?? prev.state,
      zip: s.contact?.zip ?? prev.zip,
      website: s.contact?.website ?? prev.website,
      websiteLabel: s.contact?.websiteLabel ?? prev.websiteLabel,
      twitter: s.contact?.twitter ?? prev.twitter,
      linkedin: s.contact?.linkedin ?? prev.linkedin,
      facebook: s.contact?.facebook ?? prev.facebook,
    }));

    if (s.branding) {
      document.documentElement.style.setProperty("--brand-primary", s.branding.primary || "#2563eb");
      document.documentElement.style.setProperty("--brand-secondary", s.branding.secondary || "#16a34a");
    }

    const p = s.branding?.primary || "#2563eb";
    const q = s.branding?.secondary || "#16a34a";

    document.documentElement.style.setProperty("--brand-on-primary", pickOn(p));
    document.documentElement.style.setProperty("--brand-on-secondary", pickOn(q));

    document.documentElement.setAttribute(
      "data-theme",
      s.branding?.theme === "dark" ? "dark" : "light"
    );

    if (Array.isArray(s.notes)) setAdvisorNotes(Array.isArray(s.notes) ? s.notes : []);
  };

  const load = async () => {
    try {
      const res = await fetch(
        `https://quietpitch-funcapp-axfccbhygagpbkdw.eastus-01.azurewebsites.net/api/public/advisors/${slug}/settings`
      );

      if (res.ok) {
        const s = await res.json();
        localStorage.setItem(`sv:${slug}:firm`, JSON.stringify(s));
        applySettings(s);
        setLoading(false);
        return;
      }
    } catch {}

    const raw = localStorage.getItem(`sv:${slug}:firm`);
    if (raw) {
      try {
        const s = JSON.parse(raw);
        applySettings(s);
      } catch {}
    }

    setLoading(false);
  };

  load();
}, [slug]);

  // If admin defaults arrive later AND user has no saved lists yet, seed them once.
useEffect(() => {
  if (!slug) return;
  const hasUserChart   = !!getSaved(PREF_KEY(slug,'chartSymbols'));
  const hasUserSummary = !!getSaved(PREF_KEY(slug,'summarySymbols'));

  if (!hasUserChart && adminDefaults.chart?.length) {
    setChartSymbols(adminDefaults.chart);
    localStorage.setItem(PREF_KEY(slug,'chartSymbols'), JSON.stringify(adminDefaults.chart));
  }
  if (!hasUserSummary && adminDefaults.summary?.length) {
    setSummarySymbols(adminDefaults.summary);
    localStorage.setItem(PREF_KEY(slug,'summarySymbols'), JSON.stringify(adminDefaults.summary));
  }
}, [slug, adminDefaults]);


   
  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (columnSelectorRef.current && !columnSelectorRef.current.contains(e.target)) {
        setShowColumnSelector(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keep "Select all" checkbox indeterminate when some (not all) are selected
  useEffect(() => {
    if (!selectAllRef.current) return;
    const moreThanRequired = selectedColumns.length > REQUIRED_COLUMNS.length;
    selectAllRef.current.indeterminate = !isAllSelected && moreThanRequired;
  }, [selectedColumns, isAllSelected]); 

  // Export dropdown (Summary)
  const [showExportMenu, setShowExportMenu] = useState(false);
const exportMenuRef = useRef(null);
useEffect(() => {
  const onDown = (e) => {
    if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
      setShowExportMenu(false);
    }
  };
  document.addEventListener('mousedown', onDown);
  return () => document.removeEventListener('mousedown', onDown);
}, []);

  const [legendSelected, setLegendSelected] = useState(() => {
    const stored = localStorage.getItem('legendSelected');
    return stored ? JSON.parse(stored) : {};
  });

  const [newSymbol, setNewSymbol] = useState('');
  const [timeframe, setTimeframe] = useState(() => {
  const key = slug ? PREF_KEY(slug, 'timeframe') : null;
  const saved = key ? localStorage.getItem(key) : null;
  return saved || '1M';
});
  const [whatIfAmount, setWhatIfAmount] = useState(() =>
  (slug && localStorage.getItem(PREF_KEY(slug,'whatIfAmount'))) || ''
  );
  const [isWhatIfMode, setIsWhatIfMode] = useState(() =>
  slug ? !!safeParse(localStorage.getItem(PREF_KEY(slug,'isWhatIfMode')), false) : false
  );

  useEffect(() => { setPendingWhatIf(whatIfAmount); }, [whatIfAmount]);

  // after: const { slug } = useParams();
useEffect(() => {
  if (!slug) return;
  const saved = localStorage.getItem(PREF_KEY(slug, 'timeframe'));
  if (saved) setTimeframe(saved);          // assumes you already have setTimeframe
}, [slug]);

// Plan is controlled by YOU (not the advisor). For now we read it from localStorage.
// Set manually for testing: localStorage.setItem(`sv:${slug}:plan`, 'basic'|'pro'|'advanced')


  useEffect(() => {
  if (!slug) return;
  localStorage.setItem(PREF_KEY(slug, 'timeframe'), timeframe);
}, [slug, timeframe]);


const toggleNoteOpen = (id) => {
  setOpenNoteIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
};

const ustFullRef = useRef({ US2Y: [], US10Y: [], US30Y: [] });

// custom tab title name for webapp
useEffect(() => {
  document.title = firm?.firmName
    ? `${firm.firmName} | Quiet Pitch`
    : "Quiet Pitch";
}, [firm?.firmName]);

// custom tab title for webapp
useEffect(() => {
  const favicon = document.querySelector("link[rel='icon']");

  const logo =
    firm?.logoDataUrl ||
    firm?.logoUrl ||
    "/QuietPitch-AltLogo.png";

  if (favicon) {
    favicon.href = logo;
  }
}, [firm?.logoDataUrl, firm?.logoUrl]);

// --- Load Equity Price History ---
useEffect(() => {
  if (!summarySymbols?.length && !chartSymbols?.length) return;

  const equitySymbols = Array.from(
    new Set([...summarySymbols, ...chartSymbols])
  ).filter(sym =>
    !sym.startsWith('US') &&     // not UST
    !sym.startsWith('PM:')       // not private markets
  );

  if (!equitySymbols.length) return;

  console.log('[EQUITY EFFECT RUN]', equitySymbols);

  (async () => {
    for (const sym of equitySymbols) {
      try {
        // 1️⃣ FULL history (24h cached)
        const fullKey = cacheKey('STOOQ_FULL', sym, 'MAX');
        let full = getCached(fullKey, 24 * 60 * 60 * 1000);

        if (!full) {
          console.log('[STOOQ_FULL] fetching', sym);
          full = await fetchStooqChart(sym, { full: true });
          setCached(fullKey, full);
        }

        equityFullRef.current[sym] = full;

        console.log('[STOOQ_FULL] ready', {
          sym,
          points: full?.length,
          first: full?.[0],
          last: full?.[full?.length - 1],
        });

        // 2️⃣ Chart window
        const days = DAYS_BY[timeframe] ?? 31;
        const end = full[full.length - 1]?.[0];
        const windowed = clampToWindow(full, days, end);

        setSeriesMap(prev => ({
          ...prev,
          [sym]: windowed,
        }));
      } catch (e) {
        console.error('[EQUITY LOAD FAILED]', sym, e);
      }
    }
  })();
}, [summarySymbols, chartSymbols, timeframe]);

// helper to get diff in days (safe)
const daysBetween = (a, b) => {
  if (!a || !b) return 0;
  const A = new Date(a); A.setHours(0,0,0,0);
  const B = new Date(b); B.setHours(0,0,0,0);
  return Math.max(0, Math.round((B - A) / 86400000));
};

// Re-fetch UST history for Summary date controls
useEffect(() => {
  let cancelled = false;

  // decide how much history we need for the summary view
  let daysNeeded = 31; // default
  if (dateMode === 'single' && singleDate) {
    daysNeeded = Math.max(10, daysBetween(singleDate, new Date()) + 5);
  } else if (dateMode === 'range' && startDate && endDate) {
    daysNeeded = Math.max(10, daysBetween(startDate, endDate) + 5);
  } else {
    // live mode: same as chart timeframe
    daysNeeded = DAYS_BY[timeframe] ?? 366;
  }

  (async () => {
    try {
      const all = await fetchAllYields(daysNeeded);
      if (cancelled) return;
      // prefer master copy in ustFullRef when available
      const keepLonger = (k, arr) => {
        const full = ustFullRef.current[k] || [];
        return full.length > arr.length ? full : arr;
      };

      setSeriesMap(prev => ({
        ...prev,
        US2Y: keepLonger('US2Y', all.US2Y),
        US10Y: keepLonger('US10Y', all.US10Y),
        US30Y: keepLonger('US30Y', all.US30Y),
      }));
    } catch {/* ignore */}
  })();

  return () => { cancelled = true; };
}, [dateMode, singleDate, startDate, endDate, timeframe]);

  // Persist key values
useEffect(() => {
  if (!slug) return;
  localStorage.setItem(PREF_KEY(slug, 'whatIfAmount'), whatIfAmount);
}, [slug, whatIfAmount]);

useEffect(() => {
  if (!slug) return;
  localStorage.setItem(PREF_KEY(slug, 'isWhatIfMode'), JSON.stringify(isWhatIfMode));
}, [slug, isWhatIfMode]);


  useEffect(() => {
    localStorage.setItem('legendSelected', JSON.stringify(legendSelected));
  }, [legendSelected]);

  useEffect(() => {
    localStorage.setItem('selectedColumns', JSON.stringify(selectedColumns));
  }, [selectedColumns]);  

  //restore whatif tool
  useEffect(() => {
  if (!slug) return;
  const amtStr = localStorage.getItem(PREF_KEY(slug, 'whatIfAmount')) || '';
  const mode   = safeParse(localStorage.getItem(PREF_KEY(slug, 'isWhatIfMode')), false);
  setWhatIfAmount(amtStr);
  setIsWhatIfMode(!!mode);
  const amt = Number(amtStr) || 0;
  setAppliedWhatIf({ enabled: !!mode && amt > 0, amount: amt });
}, [slug]);


  // Format numbers with commas
  const formatNumber = (value) => {
    if (!value && value !== 0) return '';
    const [whole, decimal] = value.toString().split('.');
    const formattedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return decimal !== undefined ? `${formattedWhole}.${decimal}` : formattedWhole;
  };

  const parseNumber = (value) => value.replace(/,/g, '');

// ⚠️ seriesMap MUST ALWAYS BE USD-BASED
// Currency conversion happens ONLY in serieForChart
const [seriesMap, setSeriesMap] = useState({});

const [chartLoading, setChartLoading] = useState(false);

const plan = useMemo(() => (slug ? (localStorage.getItem(`sv:${slug}:plan`) || 'basic') : 'basic'), [slug]);

const [fx, setFx] = useState({ rates: { USD: 1 }, asOf: null, source: 'daily' });
const serieForChart = useMemo(() => {
  const out = {};
  console.log('[CLIENT FX INPUT]', {
    firmCurrency: firm?.currency,
    fxBase: fx?.base,
    fxRates: fx?.rates,
  });

  const rate = fx?.rates?.[firm?.currency] ?? 1;

  console.log('[CLIENT FX RATE]', {
    appliedCurrency: firm?.currency,
    rate,
  });

  console.log(
    "[SERIE FOR CHART]",
    "currency:", firm.currency,
    "rate:", rate,
    "sample in", seriesMap?.[Object.keys(seriesMap)[0]]?.[0],

  );
  for (const [id, arr] of Object.entries(seriesMap)) {
    const unit = seriesUnitsMemo[id];        // 'price' | 'percent'
    out[id] = Array.isArray(arr)
      ? (unit === 'price' ? arr.map(([t, v]) => [t, v * rate]) : arr)
      : [];
  }
  return out;
}, [seriesMap, fx, firm?.currency, seriesUnitsMemo]);

useEffect(() => {
  let off = false;
  (async () => {
    try {
      const next = await getFxUsdForPlan(slug, plan);
      if (!off && next?.rates) setFx(next);
    } catch (err) {
      console.error("FX fetch failed:", err);
      if (!off) setFx({ base: 'USD', rates: { USD: 1 }, asOf: null, source: 'fallback' });
    }
  })();
  return () => { off = true; };
}, [slug, plan]);

useEffect(() => {
  let cancelled = false;
  const days = DAYS_BY[timeframe] ?? 366;

  setChartLoading(true);
  (async () => {
    try {
      const all = await fetchAllYields(days);
      if (cancelled) return;

      // NEW: union of symbols needed by chart AND summary
      const need = Array.from(new Set([...chartSymbols, ...summarySymbols]))
        .filter(s => UST_KEYS[s]);

      const entries = need
        .map(s => [s, all[s]])
        .filter(([, v]) => Array.isArray(v));

      console.log("STOOQ ENTRIES", entries);
      setSeriesMap(prev => ({
        ...prev,
        ...Object.fromEntries(entries),
      }));

    } catch (e) {
    console.warn("UST fetch failed", e);
    } finally {
      if (!cancelled) setChartLoading(false);
    }
  })();

  return () => { cancelled = true; };
}, [chartSymbols, summarySymbols, timeframe]);

useEffect(() => {
  const firstKey = Object.keys(seriesMap)[0];
console.log("DEBUG seriesMap snapshot", {
  keys: Object.keys(seriesMap),
  firstKey,
  firstSample: seriesMap[firstKey]?.[0],
});
}, [seriesMap]);

// Is the set composed ONLY of UST symbols?
const onlyUST = useMemo(
  () => chartSymbols.length > 0 && chartSymbols.every(s => UST_KEYS[s]),
  [chartSymbols]
);

const hasPercentOnChart = useMemo(
  () => chartSymbols.some(s => seriesUnitsMemo[s] === 'percent'),
  [chartSymbols, seriesUnitsMemo]
);

useEffect(() => {
  const days = DAYS_BY[timeframe] ?? 366;
  const windowEnd = Date.now();

  const ids = Array.from(new Set([...chartSymbols, ...summarySymbols]))
    .filter(id => id.startsWith('PM:'));
  if (!ids.length) return;

  const pmIndex = Object.fromEntries((pmItems || []).map(it => [it.id, it]));

  const entries = ids.map(id => {
    const raw = (pmSeries[id] || [])
      .map(([d, v]) => [typeof d === 'number' ? d : Date.parse(String(d)), Number(v)])
      .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
      .sort((a, b) => a[0] - b[0]);

    // respect admin start/end limits
    const bounded = clampToAdminBounds(raw, pmIndex[id]);
    if (!bounded.length) return [id, []];

    // For the chart, always respect the selected timeframe window
    const seriesForMode = clampToWindow(bounded, days, windowEnd);


    return [id, seriesForMode];
  });

  if (entries.length) {
  setSeriesMap(prev => {
    const next = { ...prev };
    for (const [sym, rows] of entries) {
      next[sym] = rows;
    }
    return next;
  });
}
}, [chartSymbols, summarySymbols, pmSeries, pmItems, timeframe, dateMode, singleDate]);

// STOOQ price series for normal tickers (AAPL, MSFT, SPY, etc.)
useEffect(() => {
  console.log("chartSymbols entering STOOQ effect", chartSymbols);
  let cancelled = false;

  const ids = Array.from(new Set(chartSymbols))
    .filter(sym => !sym.startsWith("US") && !sym.startsWith("PM:"));
    console.log("ids after filter", ids);
  if (!ids.length) return;

  setChartLoading(true);

  (async () => {
    try {
      const entries = await Promise.all(
        ids.map(async (sym) => {
          try {
            const key = cacheKey("STOOQ_FULL", sym, "MAX");
            let raw0 = getCached(key, 24 * 60 * 60 * 1000); // 24h cache

            console.log('[STOOQ_FULL] before fetch', {
              sym,
              cached: !!raw0,
            });

            if (!raw0) {
              raw0 = await fetchStooqChart(sym, { full: true });
              console.log('[STOOQ_FULL] fetched', {
                sym,
                points: raw0?.length,
                first: raw0?.[0],
                last: raw0?.[raw0.length - 1],
              });
              setCached(key, raw0);
            }

            equityFullRef.current[sym] = raw0;

            console.log('[STOOQ_FULL] stored in ref', {
              sym,
              refPoints: equityFullRef.current[sym]?.length,
            });

            if (!raw0) {
              raw0 = await fetchStooqChart(sym);
              setCached(key, raw0);
            }

// sanitize + sort
const raw = (raw0 || [])
  .map(([t, v]) => [Number(t), Number(v)])
  .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
  .sort((a, b) => a[0] - b[0]);

// IMPORTANT: anchor window to last datapoint, not "now"
const end = raw.length ? raw[raw.length - 1][0] : Date.now();
const days = DAYS_BY[timeframe] ?? 366;

let rows = clampToWindow(raw, days, end);
console.log("STOOQ", sym, {
  raw: raw.length,
  clamped: rows.length,
  end: new Date(end).toISOString(),
});

// fallback: if clamp wipes everything but we *do* have data,
// take the last N points so the chart always has something
if (!rows.length && raw.length) {
  const approxPoints = Math.min(raw.length, days);
  rows = raw.slice(-approxPoints);
}
console.log("rows returned", sym, rows.length);
return [sym, rows];

          } catch (err) {
            console.warn("Stooq failed for", sym, err);
            return [sym, []];
          }
        })
      );

      if (!cancelled) {
        setSeriesMap(prev => ({
          ...prev,
          ...Object.fromEntries(entries),
        }));
      }
    } finally {
      if (!cancelled) setChartLoading(false);
    }
  })();

  return () => { cancelled = true; };
}, [chartSymbols, timeframe]);

// If timeframe was restored as 1D while only UST are present, bump to 1W
useEffect(() => {
  if (onlyUST && timeframe === '1D') setTimeframe('1W');
}, [onlyUST, timeframe, setTimeframe]);

  // Add & remove for Summary
  const addSummarySymbol = () => {
    if (newSymbol && !summarySymbols.includes(newSymbol.toUpperCase())) {
      setSummarySymbols((prev) => [...prev, newSymbol.toUpperCase()]);
      setNewSymbol('');
    }
  };
  const removeSummarySymbol = (sym) => {
    setSummarySymbols((prev) => prev.filter((s) => s !== sym));
  };

  const emptySummaryRow = (sym) => ({
    symbol: sym,
    company: getCompanyName(sym),
    price: "",
    high: "",
    low: "",
    change: "",
  });


  const [rawData, setRawData] = useState([]);

// Whenever the Summary symbol list changes, load real data for each
useEffect(() => {
  console.log("SUMMARY EFFECT RUN", {
    summarySymbols,
    dateMode,
    singleDate,
  });

  if (!summarySymbols || summarySymbols.length === 0) {
    setRawData([]);
    return;
  }

  let cancelled = false;

  (async () => {
    try {
      const rows = await Promise.all(
        summarySymbols.map(async (sym) => {
          // UST (US10Y etc.) and PM: keep them special; don't call Tiingo
          if (sym.startsWith("PM:")) {
            console.log("PM SUMMARY ENTRY", sym, pmSeries[sym]);
  const raw = pmSeries[sym];
  const normalized = normalizePmSeries(raw);
  console.log("PM NORMALIZED", sym, {
  count: normalized.length,
  first: normalized[0],
  last: normalized[normalized.length - 1],
});


  console.log("PM NORMALIZED", sym, {
  count: normalized.length,
  first: normalized[0],
  last: normalized[normalized.length - 1],
});

  if (!normalized.length) {
    console.warn("PM empty after normalize", sym, raw);
    console.log("PM SUMMARY FINAL", sym, {
  value: last?.[1],
});
    return {
      symbol: sym,
      company: getCompanyName(sym),
      price: "",
      high: "",
      low: "",
      change: "",
    };
  }

  let anchorTs;
  console.log("PM ANCHOR", sym, {
  dateMode,
  singleDate,
  anchorTs,
  anchorDate: anchorTs ? new Date(anchorTs).toISOString() : null,
});
  if (dateMode === "single" && singleDate) {
    anchorTs = Date.parse(singleDate + "T23:59:59Z");
  } else {
    anchorTs = normalized[normalized.length - 1][0];
  }

const { value, base } = valueAndBaseForMode(
  normalized,
  dateMode,
  singleDate,
  startDate,
  endDate
);

let change = "";

if (value != null && base != null && base !== 0) {
  change = ((value / base) - 1) * 100;
}

return {
  symbol: sym,
  company: getCompanyName(sym),
  price: value ?? "",
  high: "",
  low: "",
  volume: "",
  change,
};
}

  const compute52wHiLo = (series, anchorTs) => {
  if (!Array.isArray(series) || !series.length || !anchorTs) {
    return { hi: null, lo: null };
  }

  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const startTs = anchorTs - ONE_YEAR_MS;

  let hi = -Infinity;
  let lo = Infinity;

  for (const [ts, v] of series) {
    if (ts < startTs || ts > anchorTs) continue;
    if (!Number.isFinite(v)) continue;

    if (v > hi) hi = v;
    if (v < lo) lo = v;
  }

  return {
    hi: hi === -Infinity ? null : hi,
    lo: lo === Infinity ? null : lo,
  };
};

// --- NORMAL EQUITIES (AAPL, MSFT, etc.) ---
if (dateMode === "single" && singleDate) {
  const rows = equityFullRef.current[sym] || [];

  if (!rows.length) {
    return emptySummaryRow(sym);
  }

  const anchorTs = Date.parse(singleDate + "T23:59:59Z");

  const { value, base } = valueAndBaseForMode(
    rows,
    "single",
    singleDate
  );

  const { hi: week52High, lo: week52Low } =
    compute52wHiLo(rows, anchorTs);

  return {
    symbol: sym,
    company: getCompanyName(sym),
    price: value ?? "",
    high: "",          // FREE tier → live only
    low: "",           // FREE tier → live only
    volume: "",        // FREE tier → live only
    change:
      value != null && base != null && base !== 0
        ? ((value - base) / base) * 100
        : "",
    week52High,
    week52Low,
  };
}

        // --- LIVE MODE (ONLY place FMP is allowed) ---
        const data = await fetchFmpSummary([sym]);
        return data?.[0] ?? emptySummaryRow(sym);


        })
      );

      if (!cancelled) {
        setRawData(rows);
      }
    } catch (err) {
      console.error("Summary Tiingo load failed:", err);
      if (!cancelled) {
        setRawData(summarySymbols.map(emptySummaryRow));
      }
    }
  })();

  return () => {
    cancelled = true;
  };
}, [summarySymbols, effectiveDateMode, singleDate, pmSeries, startDate, endDate, seriesMap]);

  const summaryData = [...rawData].sort((a, b) => {
    if (!sortConfig.key) return 0;

    const numericKeys = ['price', 'high', 'low', 'change', 'volume', 'marketCap', 'peRatio', 'week52High', 'week52Low', 'beta'];

    let aVal = a[sortConfig.key];
    let bVal = b[sortConfig.key];

    if (numericKeys.includes(sortConfig.key)) {
      aVal = parseFloat(aVal);
      bVal = parseFloat(bVal);
      return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
    } else {
      return sortConfig.direction === 'asc'
        ? String(aVal).localeCompare(String(bVal))
        : String(bVal).localeCompare(String(aVal));
    }
  });

  // ---- Range Detail (modal/panel) state ----
const [historySymbol, setHistorySymbol] = useState(null);
const lastHistorySymbolRef = useRef(null);

const historyTypeOf = (sym) =>
  sym?.startsWith("US")
    ? "ust"
    : sym?.startsWith("PM:")
    ? "pm"
    : "equity";

const [historyStart, setHistoryStart] = useState('');
const [historyEnd, setHistoryEnd] = useState('');
useEffect(() => {
  console.log("🟦 HISTORY STATE AFTER MOUNT", {
    historyStart,
    historyEnd,
    fromLS: (() => {
      try {
        return JSON.parse(localStorage.getItem(HISTORY_DATES_KEY(slug)));
      } catch {
        return null;
      }
    })()
  });
}, []);
const [historyRows, setHistoryRows] = useState([]);

useEffect(() => {
  console.log("🟥 HISTORY DATES CHANGED", {
    historyStart,
    historyEnd,
    stack: new Error().stack
  });
}, [historyStart, historyEnd]);

useEffect(() => {
  if (!slug) return;
  localStorage.setItem(HISTORY_KEY('symbol'), historySymbol || '');
  localStorage.setItem(HISTORY_KEY('start'), historyStart || '');
  localStorage.setItem(HISTORY_KEY('end'), historyEnd || '');
}, [slug, historySymbol, historyStart, historyEnd]);

// History (range) export dropdown – independent of Summary
const [showHistoryExport, setShowHistoryExport] = useState(false);
const historyExportRef = useRef(null);
useEffect(() => {
  const onDown = (e) => {
    if (historyExportRef.current && !historyExportRef.current.contains(e.target)) {
      setShowHistoryExport(false);
    }
  };
  document.addEventListener('mousedown', onDown);
  return () => document.removeEventListener('mousedown', onDown);
}, []);

//Helpers used by history ensureUstDays, buildUstRangeRows, clampDateStr, clampToAdminBounds
const ensureUstDays = async (neededDays = 365 * 200) => {
  const all = await fetchAllYields(neededDays);
  // master copy (never trimmed)
  ustFullRef.current = { US2Y: all.US2Y, US10Y: all.US10Y, US30Y: all.US30Y };
  // keep what the chart uses too (so live view still works)
  setSeriesMap(prev => ({ ...prev, US2Y: all.US2Y, US10Y: all.US10Y, US30Y: all.US30Y }));
};

const buildUstRangeRows = (sym, startStr, endStr) => {
  const src = ustFullRef.current[sym] || [];

  const startTs = new Date(startStr + "T00:00:00Z").getTime();
  const endTs   = new Date(endStr   + "T23:59:59Z").getTime();

  // 1️⃣ Filter visible rows
  const filtered = src
    .filter(([t]) => t >= startTs && t <= endTs)
    .sort((a, b) => a[0] - b[0]);

  // 2️⃣ Find the last value BEFORE the selected range
  let prev = null;
  for (let i = src.length - 1; i >= 0; i--) {
    const [t, v] = src[i];
    if (t < startTs) {
      prev = v;
      break;
    }
  }

  // 3️⃣ Build rows
  return filtered.map(([t, v]) => {
    const d = new Date(t).toISOString().slice(0, 10);

    let change = null;
    if (prev != null) {
      change = +(v - prev).toFixed(2);
    }

    // move previous pointer forward
    prev = v;

    return {
      date: d,
      yield: v,
      change
    };
  });
};

const clampDateStr = (s, min, max) => {
  if (!s) return s;
  if (min && s < min) return min;
  if (max && s > max) return max;
  return s;
};

const clampToAdminBounds = (rows, item) => {
  if (!item) return rows;
  const start = item.startDate ? Date.parse(item.startDate) : null;
  const end   = item.endDate   ? Date.parse(item.endDate)   : null;
  if (!start && !end) return rows;
  return rows.filter(([t]) => (start ? t >= start : true) && (end ? t <= end : true));
};

// time range bounds for UST
const ustBounds = useMemo(() => {
  const all = [
    ...(ustFullRef.current.US2Y || []),
    ...(ustFullRef.current.US10Y || []),
    ...(ustFullRef.current.US30Y || [])
  ].sort((a,b)=>a[0]-b[0]);
  if (!all.length) return { min: null, max: null };
  const toYMD = ts => new Date(ts).toISOString().slice(0,10);
  return { min: toYMD(all[0][0]), max: toYMD(all[all.length-1][0]) };
}, [seriesMap]); // dependency just to recompute after first fill

// time range bounds for PM
const pmBounds = useMemo(() => {
  const all = (pmItems || []).map(it => {
    const s = it.startDate ? Date.parse(it.startDate) : null;
    const e = it.endDate ? Date.parse(it.endDate) : null;
    return [s, e];
  });
  const valid = all.filter(([s,e]) => s && e);
  if (!valid.length) return { min: null, max: null };
  return {
    min: new Date(Math.min(...valid.map(([s]) => s))).toISOString().slice(0,10),
    max: new Date(Math.max(...valid.map(([_,e]) => e))).toISOString().slice(0,10),
  };
}, [pmItems]);

const currHistoryBounds = useMemo(() => {
  if (!historySymbol) return { min: null, max: null };

  // 1) UST: we already have good bounds
  if (historySymbol.startsWith("US")) {
    return ustBounds;
  }

  // 2) PM: try item → then actual series → then global PM bounds
  if (historySymbol.startsWith("PM:")) {
    const it = (pmItems || []).find((i) => i.id === historySymbol) || null;

    // start with what the item says
    let min = it?.startDate || null;
    let max = it?.endDate || null;

    // if item didn't specify, fall back to the actual uploaded series
    if ((!min || !max) && Array.isArray(pmSeries?.[historySymbol])) {
      const sorted = pmSeries[historySymbol]
        .map(([d]) =>
          typeof d === "number" ? d : Date.parse(String(d))
        )
        .filter((ts) => Number.isFinite(ts))
        .sort((a, b) => a - b);

      if (sorted.length) {
        if (!min) {
          min = new Date(sorted[0]).toISOString().slice(0, 10);
        }
        if (!max) {
          max = new Date(sorted[sorted.length - 1])
            .toISOString()
            .slice(0, 10);
        }
      }
    }

    // last resort: global pmBounds
    if (!min) min = pmBounds.min || null;
    if (!max) max = pmBounds.max || null;

    return { min, max };
  }

  // 3) Equities: bound by available full history
const series = equityFullRef.current?.[historySymbol];

if (!Array.isArray(series) || !series.length) {
  return { min: null, max: null };
}

// Ensure chronological order
const ordered = series.slice().sort((a, b) => a[0] - b[0]);

const toYMD = (ts) => new Date(ts).toISOString().slice(0, 10);

return {
  min: toYMD(ordered[0][0]),
  max: toYMD(ordered[ordered.length - 1][0]),
};
}, [historySymbol, ustBounds, pmItems, pmSeries, pmBounds]);

 const isValidYmd = (s) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const [pendingHistorySymbol, setPendingHistorySymbol] = useState(null);

const openHistory = async (sym) => {
  console.log("🟨 OPEN HISTORY CALLED", {
  sym,
  historyStart,
  historyEnd,
  ls: (() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_DATES_KEY(slug)));
    } catch {
      return null;
    }
  })()
});
  setHistoryLoading(true);
  // 🔒 Compute effective history dates ONCE (do NOT read from state)
const isEquity = !sym.startsWith("US") && !sym.startsWith("PM:");


// 🔄 Reset range when history TYPE changes
const prevType =
  historySymbol?.startsWith("US")
    ? "ust"
    : historySymbol?.startsWith("PM:")
    ? "pm"
    : historySymbol
    ? "equity"
    : null;

const nextType =
  sym.startsWith("US")
    ? "ust"
    : sym.startsWith("PM:")
    ? "pm"
    : "equity";

let forceRange = null;

if (prevType !== nextType) {

  if (nextType === "equity" || nextType === "ust") {
    const end = todayYmd();
    forceRange = {
      start: addDaysYmd(end, -30),
      end,
    };
  }

  if (nextType === "pm") {
    const series = pmSeries[sym] || [];
    if (series.length) {
      const ordered = series.slice().sort((a, b) => a[0] - b[0]);
      const lastTs = ordered[ordered.length - 1][0];
      const lastYmd = new Date(lastTs).toISOString().slice(0, 10);

      forceRange = {
        start: addDaysYmd(lastYmd, -30),
        end: lastYmd,
      };
    }
  }
}

setHistorySymbol(sym);
setHistoryRows(null); // null = loading, [] = empty
setHistoryLoading(true);

  if (
  !sym.startsWith('US') &&
  !sym.startsWith('PM:') &&
  !Array.isArray(equityFullRef.current?.[sym])
) {
  console.log("⏳ Equity not ready, deferring history open:", sym);
  setPendingHistorySymbol(sym);
  setHistoryLoading(true);
  return;
}

  // 🔒 declare FIRST
  let effectiveStart;
  let effectiveEnd;

  if (forceRange) {
  effectiveStart = forceRange.start;
  effectiveEnd   = forceRange.end;
} else if (isValidYmd(historyStart) && isValidYmd(historyEnd)) {
  effectiveStart = historyStart;
  effectiveEnd   = historyEnd;
} else {
  if (nextType === "pm") {
    const series = pmSeries[sym] || [];
    if (series.length) {
      const ordered = series.slice().sort((a, b) => a[0] - b[0]);
      const lastTs = ordered[ordered.length - 1][0];
      const lastYmd = new Date(lastTs).toISOString().slice(0, 10);

      effectiveEnd = lastYmd;
      effectiveStart = addDaysYmd(lastYmd, -30);
    } else {
      const end = todayYmd();
      effectiveEnd = end;
      effectiveStart = addDaysYmd(end, -30);
    }
  } else {
    const end = todayYmd();
    effectiveEnd = end;
    effectiveStart = addDaysYmd(end, -30);
  }
}

  console.log("HISTORY RANGE USED", effectiveStart, effectiveEnd);
  dbgEquity("after effective range", sym, {
    historyStart,
    historyEnd,
    effectiveStart,
    effectiveEnd,
    isEquity: (!sym.startsWith("US") && !sym.startsWith("PM:")),
    ls: (() => {
      try { return JSON.parse(localStorage.getItem(HISTORY_DATES_KEY(slug))); }
      catch { return null; }
    })()
  });
  try {
    if (sym.startsWith('US') && !(ustFullRef.current.US2Y?.length)) {
      await ensureUstDays(365 * 200);
    }

    const defStart = effectiveStart;
    const defEnd = effectiveEnd;
    const pmItem = (pmItems || []).find(i => i.id === sym) || null;

const pmSeriesBounds = (sym) => {
  const s = pmSeries?.[sym] || [];
  if (!s.length) return { min: null, max: null };

  const ts = s
    .map(([d]) => {
      if (typeof d === "number") return d;                 // assume ms epoch
      const t = Date.parse(String(d));                     // handles "1/22/2026", "2026-01-22", etc.
      return Number.isFinite(t) ? t : null;
    })
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (!ts.length) return { min: null, max: null };

  const toYmd = (t) => new Date(t).toISOString().slice(0, 10);

  return {
    min: toYmd(ts[0]),
    max: toYmd(ts[ts.length - 1]),
  };
};

    const rawBounds =
  sym.startsWith('US')
    ? ustBounds
    : sym.startsWith('PM:')
    ? pmSeriesBounds(sym)   // 🔥 ALWAYS use real series bounds
    : { min: null, max: null };


const bounds = {
  min: rawBounds?.min || null,
  max: rawBounds?.max || null,
};


let s = defStart;
let e = defEnd;

// Only clamp if bounds exist
if (bounds.min && bounds.max) {
  if (s < bounds.min) s = bounds.min;
  if (e > bounds.max) e = bounds.max;
}

// safety: if collapse happened, expand forward from max
if (s > e) {
  s = bounds.min;
  e = bounds.max;
}


dbgEquity("after clampDateStr/clampToFiveYears", sym, {
  defStart,
  defEnd,
  s,
  e,
  bounds
});

if (!sym.startsWith('US') && !sym.startsWith('PM:')) {
  const seriesNow = equityFullRef.current?.[sym];

  dbgEquity("series presence before eq clamp", sym, {
    hasSeries: Array.isArray(seriesNow),
    len: Array.isArray(seriesNow) ? seriesNow.length : null,
    first: Array.isArray(seriesNow) ? seriesNow[0] : null,
    last: Array.isArray(seriesNow) ? seriesNow[seriesNow.length - 1] : null,
  });

  if (Array.isArray(seriesNow) && seriesNow.length) {
    const ordered = seriesNow.slice().sort((a, b) => a[0] - b[0]);
    const eqMin = new Date(ordered[0][0]).toISOString().slice(0, 10);
    const eqMax = new Date(ordered[ordered.length - 1][0]).toISOString().slice(0, 10);

    const before = { s, e };
    if (s < eqMin) s = eqMin;
    if (e > eqMax) e = eqMax;

    dbgEquity("eq clamp result", sym, {
      eqMin,
      eqMax,
      before,
      after: { s, e }
    });
  }
}
console.log("EQUITY CLAMP", { sym, s, e });

// 🔐 commit final resolved range to state ONCE
if (s !== historyStart || e !== historyEnd) {
  console.log("📌 COMMITTING CLAMPED RANGE TO STATE", { from: { historyStart, historyEnd }, to: { s, e } });
  setHistoryStart(s);
  setHistoryEnd(e);

  if (slug && !sym.startsWith("PM:")) {
    localStorage.setItem(
      HISTORY_DATES_KEY(slug),
      JSON.stringify({ startDate: s, endDate: e })
    );
  }
}

    setHistorySymbol(sym);
    
    let rowsOut = [];
    if (sym.startsWith('US')) {
      rowsOut = buildUstRangeRows(sym, s, e);
    } else if (sym.startsWith('PM:')) {
      // raw, untampered series for this PM
      const raw = (pmSeries[sym] || [])
        .map(([d, v]) => [typeof d === 'number' ? d : Date.parse(String(d)), Number(v)])
        .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
        .sort((a, b) => a[0] - b[0]);
      const bounded = clampToAdminBounds(raw, pmItem);
      const sTs = new Date(s).getTime(), eTs = new Date(e).getTime();
      const rows = bounded.filter(([t]) => t >= sTs && t <= eTs);
// Add change column (vs prior row). If unit is 'price' => percent change; if 'percent' => pp change.
const pmUnit = pmItem?.unit === 'percent' ? 'percent' : 'price';
  // find the most recent value strictly BEFORE the selected start date
const prevBefore = (() => {
  const sTsNum = new Date(s).getTime?.() ?? sTs; // handle both openHistory and refreshHistory
  let base = null;
  for (let i = bounded.length - 1; i >= 0; i--) {
    const [t, v] = bounded[i];
    if (t < sTsNum) { base = Number(v); break; }
  }
  return base;
})();

let prev = prevBefore;

const out = rows.map(([t, v]) => {
  const d = new Date(t).toISOString().slice(0,10);
  let change = null;
  if (prev != null) {
    change = pmUnit === 'price'
      ? (prev !== 0 ? ((v / prev) - 1) * 100 : null)
      : (v - prev);
  }
  prev = v;
  return { date: d, value: v, change };
});

setHistoryRows(out);
return;

    } else {
  // 📈 EQUITIES — use FULL series (never chart-windowed)
  const series = equityFullRef.current[sym];

  if (!Array.isArray(series) || !series.length) {
    setHistoryRows([]);
    return;
  }

  // ✅ default range for equities: last 30 days (NOT 5 years)
  // only when user hasn't already chosen a range for this history panel
  let startStr = s;
  let endStr   = e;

  const sTs = startStr ? new Date(startStr + "T00:00:00.000Z").getTime() : -Infinity;
  const eTs = endStr   ? new Date(endStr   + "T23:59:59.999Z").getTime() : Infinity;

  dbgEquity("equity filter window", sym, {
    startStr,
    endStr,
    sTs,
    eTs
  });


  if (!Number.isFinite(sTs) || !Number.isFinite(eTs)) {
    console.warn("Invalid equity history range", { startStr, endStr });
    setHistoryRows([]);
    setHistoryLoading(false);
    return;
  }

  const ordered = series
  .slice()
  .sort((a, b) => a[0] - b[0]);

  dbgEquity("equity ordered bounds", sym, {
    orderedLen: ordered.length,
    orderedFirst: ordered[0],
    orderedLast: ordered[ordered.length - 1],
    orderedMinYmd: new Date(ordered[0][0]).toISOString().slice(0,10),
    orderedMaxYmd: new Date(ordered[ordered.length - 1][0]).toISOString().slice(0,10),
  });


// find the last close BEFORE the start date
let prev = null;
for (let i = ordered.length - 1; i >= 0; i--) {
  const [t, v] = ordered[i];
  if (t < sTs) {
    prev = v;
    break;
  }
}

const rows = ordered
  .filter(([ts]) => ts >= sTs && ts <= eTs)
  .map(([ts, close]) => {
    const d = new Date(ts).toISOString().slice(0, 10);

    let change = null;
    if (prev != null && prev !== 0) {
      change = ((close / prev) - 1) * 100;
    }

    prev = close;

    return {
      date: d,
      close,
      change,
    };
  });

setHistoryRows(rows);
return;
}

    setHistoryRows(rowsOut || []);   // never set undefined
    } catch (err) {
    // why: keep UI stable on unexpected errors
    console.error('openHistory failed:', err);
    setHistoryRows([]);   // avoid rendering with undefined
  } finally {
    setHistoryLoading(false);
  }
};

const refreshHistory = async () => {
  const s = clampToFiveYears(historyStart);
  const e = clampToFiveYears(historyEnd);

  setHistoryStart(s);
  setHistoryEnd(e);

  if (!historySymbol) return;
  setHistoryLoading(true);

  try {
    if (historySymbol.startsWith('US')) {
      // 🇺🇸 USTs
      await ensureUstDays(365 * 200);
      setHistoryRows(buildUstRangeRows(historySymbol, s, e));
      return;

    } else if (historySymbol.startsWith('PM:')) {
      // 🏗 Private Markets
      const pmItem = (pmItems || []).find(it => it.id === historySymbol) || null;

      const raw = (pmSeries[historySymbol] || [])
        .map(([d, v]) => [typeof d === 'number' ? d : Date.parse(String(d)), Number(v)])
        .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
        .sort((a, b) => a[0] - b[0]);

      const bounded = clampToAdminBounds(raw, pmItem);
      const sTs = new Date(s).getTime();
      const eTs = new Date(e).getTime();

      const rows = bounded.filter(([t]) => t >= sTs && t <= eTs);
      const pmUnit = pmItem?.unit === 'percent' ? 'percent' : 'price';

      // previous value before range (for change)
      const prevBefore = (() => {
        let base = null;
        for (let i = bounded.length - 1; i >= 0; i--) {
          const [t, v] = bounded[i];
          if (t < sTs) { base = Number(v); break; }
        }
        return base;
      })();

      let prev = prevBefore;

      const out = rows.map(([t, v]) => {
        const d = new Date(t).toISOString().slice(0, 10);
        let change = null;
        if (prev != null) {
          change = pmUnit === 'price'
            ? (prev !== 0 ? ((v / prev) - 1) * 100 : null)
            : (v - prev);
        }
        prev = v;
        return { date: d, value: v, change };
      });

      setHistoryRows(out);
      return;

    } else {
  // 📈 EQUITIES — close + % change (PM-style)
  const series = equityFullRef.current[historySymbol];

  if (!Array.isArray(series) || !series.length) {
    setHistoryRows([]);
    return;
  }

  const sTs = s ? new Date(s + "T00:00:00.000Z").getTime() : -Infinity;
  const eTs = e ? new Date(e + "T23:59:59.999Z").getTime() : Infinity;

  const ordered = series.slice().sort((a, b) => a[0] - b[0]);

  // previous close before range (for first change)
  let prev = null;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const [t, v] = ordered[i];
    if (t < sTs) {
      prev = v;
      break;
    }
  }

  const rows = ordered
    .filter(([ts]) => ts >= sTs && ts <= eTs)
    .map(([ts, close]) => {
      const d = new Date(ts).toISOString().slice(0, 10);

      let change = null;
      if (prev != null && prev !== 0) {
        change = ((close / prev) - 1) * 100;
      }

      prev = close;

      return {
        date: d,
        close,
        change,
      };
    });

  setHistoryRows(rows);
  return;
    }
  } finally {
    setHistoryLoading(false);
  }
};

const [isExportMode, setIsExportMode] = useState(false);

const chartRef = useRef(null);

//click handler to export the chart as PDF
const downloadChartPDF = async () => {
  if (!chartRef.current) return;

console.log("chartRef:", chartRef.current);

  const chart = chartRef.current.getEchartsInstance();
  if (!chart) return;

  // Save original option
  const originalOption = chart.getOption();

  // Apply export styling
  chart.setOption({
    backgroundColor: '#ffffff',

    legend: {
      textStyle: { color: '#111111' }
    },

    xAxis: {
      axisLabel: { color: '#111111' },
      axisLine: { lineStyle: { color: '#dddddd' } },
      splitLine: { show: false } // remove vertical grid
    },

    yAxis: [
  {
    axisLabel: { color: '#111111' },
    axisLine: { lineStyle: { color: '#dddddd' } },
    splitLine: { show: false }
  },
  {
    axisLabel: { color: '#111111' }, // 🔥 RIGHT SIDE FIX
    axisLine: { lineStyle: { color: '#dddddd' } },
    splitLine: { show: false }
  }
]
  });

  await new Promise(r => setTimeout(r, 80));

  const canvas = await html2canvas(chartContainerRef.current, {
    scale: 2,
    useCORS: true
  });

  // Restore original chart
  chart.setOption(originalOption, true);

  const imgData = canvas.toDataURL('image/png');

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  const ratio = Math.min(pageW / canvas.width, pageH / canvas.height);
  const renderW = canvas.width * ratio;
  const renderH = canvas.height * ratio;

  pdf.addImage(
    imgData,
    'PNG',
    (pageW - renderW) / 2,
    (pageH - renderH) / 2,
    renderW,
    renderH
  );

  pdf.save(`chart_${timeframe}.pdf`);
};

  // ---- helpers (place right above `return (`) ----
const renderAddress = () => {
  const { address, address2, city, state, zip } = firm || {};
  const line1 = (address || "").trim();
  const line2 = (address2 || "").trim();
  const cityStateZip = [city, state && (zip ? `${state} ${zip}` : state)]
    .filter(Boolean)
    .join(", ");

  if (!line1 && !line2 && !cityStateZip) return null;

  return (
    <div className="mt-2 leading-6">
      {line1 && <div>{line1}</div>}
      {line2 && <div>{line2}</div>}
      {cityStateZip && <div>{cityStateZip}</div>}
    </div>
  );
};

//compute latest value and change
const getLatest = (rows) => {
  if (!rows || rows.length === 0) return null;
  const [, v] = rows[rows.length - 1];
  return Number.isFinite(v) ? v : null;
};

// optional: change vs previous point
const getDelta = (rows) => {
  if (!rows || rows.length < 2) return null;
  const v = rows[rows.length - 1][1];
  const p = rows[rows.length - 2][1];
  if (!Number.isFinite(v) || !Number.isFinite(p)) return null;
  return v - p;
};

// Only *show* Symbol in Range mode, but don't change the user's saved selection
const visibleColumns = useMemo(
  () => (dateMode === 'range' ? ['symbol'] : selectedColumns),
  [dateMode, selectedColumns]
);

useEffect(() => {
  console.log("📌 render debug", {
    dateMode,
    selectedColumns,
    visibleColumns,
    visibleColumnsType: typeof visibleColumns,
    visibleColumnsIsArray: Array.isArray(visibleColumns),
  });
}, [dateMode, selectedColumns, visibleColumns]);

// Build Summary rows from live UST data in seriesMap
const summaryRows = useMemo(() => {
  return (summarySymbols || [])
    .filter(id => id.startsWith('US')) // UST only for now
    .map(id => {
      const rows = isPM
        ? normalizePmSeries(pmSeries[id] || [])
        : (seriesMap[id] || []);

      return {
        id,
        latest: getLatest(rows),
        delta: getDelta(rows),
        hasData: rows.length > 0,
      };
    });
}, [summarySymbols, seriesMap]);

//Pick the correct “latest” and “delta” for each mode
const toUTCnoon = (s) => {
  if (!s) return null;
  const d = new Date(s); // YYYY-MM-DD from <input type="date">
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
};

const findAtOrBefore = (rows, ts) => {
  if (!rows?.length || !Number.isFinite(ts)) return null;
  // rows are [t, v] sorted asc
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= ts) { best = rows[mid]; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return best ? best[1] : null;
};

const findStrictlyBefore = (rows, ts) => {
  if (!rows?.length || !Number.isFinite(ts)) return null;
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] < ts) { best = rows[mid]; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return best ? best[1] : null;
};

const toUtcEndOfDay = (ymd) => {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999);
};

const findPairAtOrBefore = (rows, ts) => {
  if (!rows?.length || !Number.isFinite(ts)) return null;
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= ts) { best = rows[mid]; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return best;
};

const findPairStrictlyBefore = (rows, ts) => {
  if (!rows?.length || !Number.isFinite(ts)) return null;
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] < ts) { best = rows[mid]; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return best;
};


// Generic: returns { value, base } for current dateMode
// - live: value = last, base = previous point
// - single: value = value at/before date, base = strictly before
// - range: value = end,  base = start
const valueAndBaseForMode = (rows, mode, single, start, end) => {
  if (!rows?.length) return { value: null, base: null };

  if (mode === 'single') {
    const ts = toUtcEndOfDay(single); // use end of day

    const valuePair = findPairAtOrBefore(rows, ts);
    if (!valuePair) return { value: null, base: null };

    const basePair = findPairStrictlyBefore(rows, valuePair[0]);

    return {
      value: valuePair[1],
      base: basePair ? basePair[1] : null,
    };
  }

  if (mode === 'range') {
    const tsEnd = toUTCnoon(end);
    const tsStart = toUTCnoon(start);
    const value = findAtOrBefore(rows, tsEnd);
    const base  = findAtOrBefore(rows, tsStart);
    return { value, base };
  }

  // live
  const last = rows[rows.length - 1]?.[1];
  const prev = rows.length > 1 ? rows[rows.length - 2]?.[1] : null;
  return {
    value: Number.isFinite(last) ? last : null,
    base:  Number.isFinite(prev) ? prev : null
  };
};


// Return { latest, delta } for current dateMode
const ustValueForMode = (rows, mode, single, start, end) => {
  if (!rows?.length) return { latest: null, delta: null };

  if (mode === 'single') {
    const ts = toUTCnoon(single);
    const v  = findAtOrBefore(rows, ts);
    const p  = findStrictlyBefore(rows, ts);
    return { latest: v, delta: (v != null && p != null) ? (v - p) : null };
  }

  if (mode === 'range') {
    const tsEnd = toUTCnoon(end);
    const tsStart = toUTCnoon(start);
    const vEnd = findAtOrBefore(rows, tsEnd);
    const vStart = findAtOrBefore(rows, tsStart);
    return { latest: vEnd, delta: (vEnd != null && vStart != null) ? (vEnd - vStart) : null };
  }

  // live: use last point; delta vs previous point
  const last = rows[rows.length - 1]?.[1];
  const prev = rows.length > 1 ? rows[rows.length - 2]?.[1] : null;
  return { latest: Number.isFinite(last) ? last : null,
           delta: (Number.isFinite(last) && Number.isFinite(prev)) ? (last - prev) : null };
};

// Strict HTML sanitizer for Market Commentary (allows safe <a> links)
function sanitizeNoteHtml(html) {
  // allow only common formatting + links
  const clean = DOMPurify.sanitize(html || '', {
    USE_PROFILES: { html: true },      // bold/italic/lists/etc.
    ALLOWED_TAGS: [
      'a','b','strong','i','em','u','s','p','br','ul','ol','li','blockquote',
      'h1','h2','h3','h4','h5','h6','span','code','pre'
    ],
    ALLOWED_ATTR: ['href','title','target','rel'],
  });

  // If links don’t have target/rel, add them safely.
  // (TipTap’s Link can add these, but this guarantees it on render.)
  const tmp = document.createElement('div');
  tmp.innerHTML = clean;
  tmp.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    // only allow http/https
    if (!/^https?:\/\//i.test(href)) {
      a.removeAttribute('href');
      return;
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return tmp.innerHTML;
}

  //top of the page starts here
return (
   <div className="page-bg min-h-screen font-sans pb-10">
    {/* full-bleed bg to eliminate white gutters from host shell */}
    <div className="fixed inset-0 -z-10 page-bg" />

    {/* Accent bar */}
    <div className="h-1 w-full brand-bg" />

{/* Header (clean, brand-colored elements) */}
<header className="max-w-5xl mx-auto mb-6 rounded">
  <div className="flex items-center justify-between py-4">
    {/* Left: Logo + firm name */}
    <div className="flex items-center gap-3">
      {(firm.logoPlacement === "header" || firm.logoPlacement === "both") &&
        (firm.logoDataUrl || firm.logoUrl) && (
          <img
            src={firm.logoDataUrl || firm.logoUrl}
            alt={firm.firmName}
            style={{ height: headerH }}
            className="rounded-md"
          />
        )}
      <div>
        <h1 className="text-2xl font-semibold brand-text">{firm.firmName}</h1>
        <div className="text-sm subtle">Market Insights</div>
      </div>
    </div>
  </div>

  {/* Tabs */}
  <div className="mt-2 flex gap-2">
    <button
      className={`btn ${
        activeTab === "chart"
          ? "btn-secondary"
          : "tab-ghost brand-border"
      }`}
      onClick={() => setActiveTab("chart")}
    >
      Chart
    </button>
    <button
      className={`btn ${
        activeTab === "summary"
          ? "btn-secondary"
          : "tab-ghost brand-border"
      }`}
      onClick={() => setActiveTab("summary")}
    >
      Summary
    </button>
  </div>
</header>

    {/* Main Content */}
    <main className="mt-6">
      <div className="max-w-5xl mx-auto">
        {loading && (
          <div className="max-w-5xl mx-auto p-4 text-gray-600">
            Loading advisor page…
          </div>
        )}

        {/* Chart Tab */}
        {activeTab === "chart" && (
          <div>
            <div className="mb-4">
              <div className="text-sm subtle">Chart Type:</div>
              <select
  className="tab-ghost rounded px-3 py-2"
  value={chartType}
  onChange={e => setChartType(e.target.value)}
>
  <option value="line">Line</option>
  <option value="bar">Bar</option>
  <option value="scatter">Scatter</option>
</select>
            </div>

            {appliedWhatIf.enabled && appliedWhatIf.amount > 0 && (
              <div className="mb-2 text-sm text-gray-600 italic">
                Showing portfolio value if you invested {
                  (CURRENCY_SIGNS[firm.currency] || '')
                }{formatNumber(Number(appliedWhatIf.amount).toFixed(2))} at the start of
                the selected period.{hasPercentOnChart ? " All % series remain unchanged." : ""}
              </div>
            )}

            <div ref={chartContainerRef}>
              <SummitChart
                ref={chartRef}
                chartType={chartType}
                symbols={chartSymbols}
                timeframe={timeframe}
                isWhatIfMode={appliedWhatIf.enabled}
                whatIfAmount={appliedWhatIf.amount}
                legendSelected={legendSelected}
                setLegendSelected={setLegendSelected}
                seriesMap={serieForChart}
                isLoading={chartLoading}
                isNormalized={false}
                seriesUnits={seriesUnitsMemo}
                currency={firm.currency}
                pricePrefix={CURRENCY_SIGNS[firm.currency] || ''}
                isExportMode={isExportMode}
              />
            </div>

            {/* Currency / FX line under chart (basic tier only) */}
            {PLAN_SHOWS_FX_ASOF.has((firm.plan || 'basic').toLowerCase()) && (
              <div className="mt-2 text-sm text-gray-600">
                Currency: <strong>{firm.currency || 'USD'}</strong>
                {fx?.asOf && (
                  <span className="text-gray-500">
                    {' '}· FX rates as of {formatFxAsOf(fx.asOf, firm.timeZone || 'UTC', fx.source)} EOD
                  </span>
                )}
              </div>
            )}

            <div className="mt-4 flex gap-4">
              <select
                className="select-theme rounded px-3 py-2"
                value={timeframe}
                onChange={(e) => {
                  const next = e.target.value;
                  if (onlyUST && next === "1D") return;
                  setTimeframe(next);
                }}
              >

                <option value="1D" disabled={onlyUST}>
                  1D
                </option>
                <option value="1W">1W</option>
                <option value="1M">1M</option>
                <option value="3M">3M</option>
                <option value="6M">6M</option>
                <option value="1Y">1Y</option>
                <option value="5Y">5Y</option>
              </select>

              {onlyUST && (
                <div className="text-xs subtle mt-1">
                  Intraday (1D) isn’t available for U.S. Treasury yields. Add a
                  different symbol to enable 1D.
                </div>
              )}

              <input
                type="text"
                placeholder="What if I invested $X"
                className="tab-ghost p-2 rounded"
                value={pendingWhatIf}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^0-9.]/g, "");
                  if (/^\d*\.?\d*$/.test(raw)) setPendingWhatIf(raw);
                }}
              />
              <button
                onClick={() => {
                  if (!pendingWhatIf) return;
                  setIsWhatIfMode(true);
                  setWhatIfAmount(pendingWhatIf);
                  setAppliedWhatIf({
                    enabled: true,
                    amount: Number(pendingWhatIf),
                  });
                }}
                className="btn btn-secondary"
                disabled={!pendingWhatIf}
              >
                Apply
              </button>

              <button
                onClick={() => {
                  setIsWhatIfMode(false);
                  setWhatIfAmount("");
                  setAppliedWhatIf({ enabled: false, amount: 0 });
                }}
                className="bg-gray-500 text-white px-4 py-2 rounded"
              >
                Reset
              </button>
            </div>

            {/* Symbol Lookup */}
            <div className="mb-4 flex gap-2 mt-4">
              <input
                type="text"
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
                placeholder="Enter symbol (e.g., AAPL)"
                className="tab-ghost p-2 rounded flex-1"
              />
              <button
                onClick={async () => {
                  const sym = newSymbol.toUpperCase();

                  try {
                    const test = await fetchStooqChart(sym);

                  if (!test || !test.length) {
                    toast.error("Symbol not supported on chart");
                    return;
                  }

                  if (
                    sym &&
                    !chartSymbols.includes(sym) &&
                    chartSymbols.length < 12
                  ) {
                    const next = [...chartSymbols, sym];
                    setChartSymbols(next);

                    if (slug) {
                      localStorage.setItem(
                        PREF_KEY(slug, "chartSymbols"),
                        JSON.stringify(next)
                      );
                    }

                    setNewSymbol("");
                  }
                } catch {
                  toast.error("Symbol not supported on chart");
                }
              }}
                className="btn btn-secondary"
              >
                Lookup
              </button>
              <button
                onClick={() => {
                  const next = getAdminChartDefaults();
                  setChartSymbols(next);
                  if (slug)
                    localStorage.setItem(
                      PREF_KEY(slug, "chartSymbols"),
                      JSON.stringify(next)
                    );
                }}
                className="bg-gray-500 text-white px-4 py-2 rounded"
              >
                Clear
              </button>
              <button
                onClick={downloadChartPDF}
                className="bg-gray-500 text-white px-4 py-2 rounded"
              >
                Export
              </button>

              {Array.isArray(pmItems) && pmItems.length > 0 && (
                <select
                  className="ml-2 select-theme rounded px-3 py-2"
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (!id) return;
                    if (!chartSymbols.includes(id)) {
                      const next = [...chartSymbols, id];
                      setChartSymbols(next);
                      if (slug)
                        localStorage.setItem(
                          PREF_KEY(slug, "chartSymbols"),
                          JSON.stringify(next)
                        );
                    }
                    e.target.value = "";
                  }}
                >
                  <option value="">+ Private…</option>
                  {pmItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name} ({it.id})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        )}

        {/* Summary Tab */}
        {activeTab === "summary" && (
          <div>
            {/* Date Mode Selector */}
            <div className="mb-4 flex gap-4">
              <select
                className="select-theme rounded px-3 py-2"
                value={dateMode}
                onChange={(e) => setDateMode(e.target.value)}
              >

                <option value="live">Live</option>
                <option value="single">Single Date</option>
                <option value="range">Date Range</option>
              </select>

              {dateMode === "single" && (() => {
                const todayYmd = new Date().toISOString().slice(0, 10);

                const minDateObj = new Date();
                minDateObj.setFullYear(minDateObj.getFullYear() - 5);
                const minYmd = minDateObj.toISOString().slice(0, 10);

                const clampYmd = (v) => {
                  if (!v) return v;
                  if (v > todayYmd) return todayYmd;
                  if (v < minYmd) return minYmd;
                  return v;
                };

                return (
                  <input
                    type="date"
                    className="tab-ghost p-2 rounded"
                    min={minYmd}
                    max={todayYmd}
                    value={singleDate}
                    onChange={(e) => setSingleDate(clampYmd(e.target.value))}
                  />
                );
            })()}
          </div>

            {/* Column Selector Dropdown */}
            <div className="relative mb-4" ref={columnSelectorRef}>
              <button
                onClick={() => {
                  if (isCustomizeColumnsDisabled) return;
                    setShowColumnSelector((s) => !s);
                }}
                className={`btn btn-secondary ${
                  isCustomizeColumnsDisabled ? "opacity-50 cursor-not-allowed" : ""
                }`}
                disabled={isCustomizeColumnsDisabled}
              >
                Customize Columns
              </button>
              <button
                className={`ml-2 bg-gray-500 text-white px-3 py-2 rounded ${
                  dateMode === "range" ? "opacity-50 cursor-not-allowed" : ""
                }`}
                disabled={dateMode === "range"}
                onClick={() => {
                  if (dateMode === "range") return;

                  localStorage.removeItem("selectedColumns");
                 setSelectedColumns(DEFAULT_COLUMNS_BY_MODE[dateMode]);
                }}
              >
                Reset Columns
              </button>
              {dateMode !== "range" && (
                <div className="relative inline-block" ref={exportMenuRef}>
                  <button
                    className="ml-2 tab-ghost px-3 py-2 rounded"
                    onClick={() => setShowExportMenu((s) => !s)}
                  >
                    Export
                  </button>

                  {showExportMenu && (
                    <div className="absolute z-10 mt-2 w-40 card rounded shadow">
                      <button
                        className="block w-full text-left px-3 py-1 text-gray-900 dark:text-gray-100 opacity-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                        onClick={() => {
                          setShowExportMenu(false);

                          const colsForExport =
                            dateMode === 'live'
                              ? (selectedColumns.includes('company')
                                  ? selectedColumns
                                  : ['company', ...selectedColumns])
                              : selectedColumns.filter(col => col !== 'company');
                          
                          const baseFileName =
                            dateMode === 'single' && singleDate
                            ? `summary_single_${singleDate}`
                            : `summary_${dateMode}`;

                          const patched =
                            patchTreasuryForExport(
                              patchCompanyForExport(summaryData)
                            );

                          const formatted =
                            buildSummaryExportRows(patched, colsForExport);

                          exportCSV(formatted, `${baseFileName}.csv`, colsForExport);
                        }}
                      >
                        CSV
                      </button>
                      <button
                        className="block w-full text-left px-3 py-1 text-gray-900 dark:text-gray-100 opacity-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                        onClick={() => {
                          setShowExportMenu(false);

                          const colsForExport =
                            dateMode === 'live'
                              ? (selectedColumns.includes('company')
                                  ? selectedColumns
                                  : ['company', ...selectedColumns])
                              : selectedColumns.filter(col => col !== 'company');
                            
                          const baseFileName =
                            dateMode === 'single' && singleDate
                            ? `summary_single_${singleDate}`
                            : `summary_${dateMode}`;

                          const patched =
                            patchTreasuryForExport(
                              patchCompanyForExport(summaryData)
                            );

                          const formatted =
                            buildSummaryExportRows(patched, colsForExport);

                          exportXLSX(formatted, `${baseFileName}.xlsx`, colsForExport);
                        }}
                      >
                        Excel (.xlsx)
                      </button>
                      <button
                        className="block w-full text-left px-3 py-1 text-gray-900 dark:text-gray-100 opacity-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                        onClick={() => {
                          setShowExportMenu(false);

                          const colsForExport =
                            dateMode === 'live'
                              ? (selectedColumns.includes('company')
                                  ? selectedColumns
                                  : ['company', ...selectedColumns])
                              : selectedColumns.filter(col => col !== 'company');

                          const baseFileName =
                            dateMode === 'single' && singleDate
                            ? `summary_single_${singleDate}`
                            : `summary_${dateMode}`;
                          
                            const title =
                              dateMode === 'single' && singleDate
                              ? `Summary (Single Date: ${singleDate})`
                              : `Summary (${dateMode})`;

                          const patched =
                            patchTreasuryForExport(
                              patchCompanyForExport(summaryData)
                            );

                          const formatted =
                            buildSummaryExportRows(patched, colsForExport);
                          exportPDF(
                            formatted,
                            title,
                            `${baseFileName}.pdf`,
                            colsForExport
                          );
                        }}
                      >
                        PDF
                      </button>
                    </div>
                  )}
                </div>
              )}

              {showColumnSelector && (
                <div className="absolute z-10 mt-2 card rounded shadow-lg p-4 space-y-2 max-h-96 overflow-auto w-72">
                  <label className="flex items-center justify-between pb-2 border-b mb-2">
                    <span className="font-semibold text-sm">Columns</span>
                    <span className="flex items-center space-x-2">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={isAllSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedColumns(allowedColumns);
                          } else {
                            setSelectedColumns(REQUIRED_COLUMNS);
                          }
                        }}
                      />
                      <span className="text-sm">Select all</span>
                    </span>
                  </label>

                  {/* Symbol (required) */}
                  <label className="flex items-center space-x-2">
                    <input type="checkbox" checked readOnly disabled />
                    <span>Symbol (required)</span>
                  </label>

                  {[
                    {key: "company", label: "Company" },
                    { key: "price", label: "Current Price" },
                    { key: "high", label: "Day High" },
                    { key: "low", label: "Day Low" },
                    { key: "change", label: "% Change" },
                    { key: "volume", label: "Volume" },
                    { key: "marketCap", label: "Market Cap" },
                    { key: "peRatio", label: "P/E Ratio" },
                    { key: "sector", label: "Sector" },
                    { key: "week52High", label: "52w High" },
                    { key: "week52Low", label: "52w Low" },
                    { key: "beta", label: "Beta" },
                  ].map(({ key, label }) => {
                    const allowed = isColumnAllowed(key);

                    return (
                      <label
                        key={key}
                        className={`flex items-center space-x-2 ${
                          !allowed ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                      >

                      <input
                        type="checkbox"
                        checked={selectedColumns.includes(key)}
                        onChange={() => {
                          if (!allowed) return; // 🔒 STOP FMP-only columns in single
                          console.group(`🧩 toggle column: ${key}`);
                          console.log("before selectedColumns:", selectedColumns);
                          console.log("dateMode:", dateMode);

                          setSelectedColumns((prev) => {
                            console.log("prev in updater:", prev);

                            let next;

                            // toggling OFF
                            if (Array.isArray(prev) && prev.includes(key)) {
                              if (key === 'change') {
                                const pmPercentPresent = (summarySymbols || []).some(
                                  (id) => id.startsWith('PM:') && seriesUnitsMemo[id] === 'percent'
                                );
                                next = pmPercentPresent ? prev : prev.filter((k) => k !== 'change');
                              } else {
                                next = prev.filter((k) => k !== key);
                              }
                            } 
                            // toggling ON
                            else {
                              next = [...(Array.isArray(prev) ? prev : []), key];
                            }

                            // 🔒 HARD GUARD
                            if (!Array.isArray(next)) {
                              console.error("🚨 selectedColumns became invalid!", { prev, next, key });
                              next = ['symbol'];
                            }

                            console.log("next selectedColumns:", next);
                            console.groupEnd();
                            return next;
                          });
                        }}
                        disabled={
                          !allowed ||
                          (key === "change" &&
                            (summarySymbols || []).some(
                              (id) =>
                                id.startsWith("PM:") &&
                                seriesUnitsMemo[id] === "percent"
                            ))
                        }
                      />

                      <span>{label}</span>
                      {!allowed && (
                        <span className="text-xs text-gray-500 ml-2">
                          Live only
                        </span>
                      )}
                    </label>
                    );
                  })}
                </div>
              )}
            </div>

           {/* Add & Reset */}
            <div className="mb-4 flex gap-2">
              <input
                type="text"
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
                placeholder="Enter symbol"
                className="tab-ghost p-2 rounded flex-1"
              />
              <button
                onClick={() => {
                  if (
                    newSymbol &&
                    !summarySymbols.includes(newSymbol.toUpperCase()) &&
                    summarySymbols.length < 500
                  ) {
                    const next = [...summarySymbols, newSymbol.toUpperCase()];
                    setSummarySymbols(next);
                    if (slug)
                      localStorage.setItem(
                        PREF_KEY(slug, "summarySymbols"),
                        JSON.stringify(next)
                      );
                    setNewSymbol("");
                  }
                }}
                className="btn btn-secondary"
              >
                Add
              </button>
              <button
                onClick={resetSummarySymbols}
                className="bg-gray-500 text-white px-4 py-2 rounded"
              >
                Reset
              </button>

              {Array.isArray(pmItems) && pmItems.length > 0 && (
                <select
                  className="ml-2 select-theme rounded px-3 py-2"
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (!id) return;
                    if (!summarySymbols.includes(id)) {
                      const next = [...summarySymbols, id];
                      setSummarySymbols(next);
                      if (slug)
                        localStorage.setItem(
                          PREF_KEY(slug, "summarySymbols"),
                          JSON.stringify(next)
                        );
                    }
                    e.target.value = "";
                  }}
                >
                  <option value="">+ Private…</option>
                  {pmItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name} ({it.id})
                    </option>
                  ))}
                </select>
              )}
            </div>

              {/* Currency banner / FX as-of (plan-dependent) */}
              <div className="mb-3 text-sm text-gray-600 flex items-center gap-2">
                <span>
                  Currency:&nbsp;
                  <strong>{firm.currency || 'USD'}</strong>
                </span>
                {PLAN_SHOWS_FX_ASOF.has((firm.plan || 'basic').toLowerCase()) && fx?.asOf && (
                <span className="text-gray-500">
                  · FX rates as of {formatFxAsOf(fx.asOf, 'UTC', fx.source)} EOD
                </span>
                )}
              </div>

            {/* Summary Table */}
            <table className="min-w-full border-collapse theme-table">
              <thead>
                <tr className="table-head">
                  {visibleColumns.includes("symbol") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("symbol")}
                    >
                      Symbol{" "}
                      {sortConfig.key === "symbol" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("company") && (
                  <th
                    className="border p-2 cursor-pointer"
                    onClick={() => handleSort("company")}
                  >
                    Company{" "}
                    {sortConfig.key === "company" &&
                      (sortConfig.direction === "asc" ? "▲" : "▼")}
                  </th>
                  )}
                  {visibleColumns.includes("price") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("price")}
                    >
                      {dateMode === "single" ? "Close Price" : "Current Price"}{" "}
                      {sortConfig.key === "price" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("high") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("high")}
                    >
                      Day High{" "}
                      {sortConfig.key === "high" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("low") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("low")}
                    >
                      Day Low{" "}
                      {sortConfig.key === "low" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("change") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("change")}
                    >
                      % Change{" "}
                      {sortConfig.key === "change" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("volume") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("volume")}
                    >
                      Volume{" "}
                      {sortConfig.key === "volume" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("marketCap") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("marketCap")}
                    >
                      Market Cap{" "}
                      {sortConfig.key === "marketCap" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("peRatio") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("peRatio")}
                    >
                      P/E Ratio{" "}
                      {sortConfig.key === "peRatio" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("sector") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("sector")}
                    >
                      Sector{" "}
                      {sortConfig.key === "sector" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("week52High") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("week52High")}
                    >
                      52w High{" "}
                      {sortConfig.key === "week52High" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("week52Low") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("week52Low")}
                    >
                      52w Low{" "}
                      {sortConfig.key === "week52Low" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {visibleColumns.includes("beta") && (
                    <th
                      className="border p-2 cursor-pointer"
                      onClick={() => handleSort("beta")}
                    >
                      Beta{" "}
                      {sortConfig.key === "beta" &&
                        (sortConfig.direction === "asc" ? "▲" : "▼")}
                    </th>
                  )}
                  {dateMode === "range" && (
                    <th className="border p-2">Actions</th>
                  )}
                  <th className="border p-2">Remove</th>
                </tr>
              </thead>
              <tbody>
                {summaryData.map((row) => {
                  const id = row.symbol;
                  const isUST = id.startsWith("US");
                  const isPM = id.startsWith("PM:");

                  const rows = isPM
                    ? normalizePmSeries(pmSeries[id] || [])
                    : (seriesMap[id] || []);

                  const unit =
                    seriesUnitsMemo[id] || (isUST ? "percent" : "price");

                  const { latest: ustLatest, delta: ustDelta } = isUST
                    ? ustValueForMode(
                        rows,
                        effectiveDateMode,
                        singleDate,
                        startDate,
                        endDate
                      )
                    : { latest: null, delta: null };

                  let pmValue = null,
                    pmBase = null,
                    pmPct = null;
                  if (isPM) {
                    const vb = valueAndBaseForMode(
                      rows,
                      effectiveDateMode,
                      singleDate,
                      startDate,
                      endDate
                    );
                    pmValue = vb.value;
                    pmBase = vb.base;
                    if (
                      unit === "price" &&
                      pmValue != null &&
                      pmBase != null &&
                      pmBase !== 0
                    ) {
                      pmPct = ((pmValue / pmBase) - 1) * 100;
                    }
                  }

                  return (
                    <tr key={row.symbol}>
                      {visibleColumns.includes("symbol") && (
                        <td className="border p-2" >{row.symbol}</td>
                      )}
                      {visibleColumns.includes("company") && (
                        <td className="border p-2">
                          {(() => {
                            const id = row.symbol;
                            const isUST = id.startsWith("US");
                            const isPM = id.startsWith("PM:");

                            if (isUST) {
                              return getCompanyName(id);
                            }

                            if (isPM) {
                              const pmItem = pmItems?.find(p => p.id === id);
                              return pmItem?.name || id.replace("PM:", "");
                            }

                            return row.company || getCompanyName(id) || "";
                          })()}
                        </td>
                      )}
                      {visibleColumns.includes('price') && (
                        <td className="border p-2">
                          {isUST
                            ? (ustLatest != null ? `${ustLatest.toFixed(2)}%` : '—')
                            : isPM
                            ? (unit === 'price'
                              ? (pmValue != null
                                ? fmtMoney(convertUsdTo(pmValue, firm.currency, fx.rates), firm.currency)
                                : '—')
                            : '—' // unit === 'percent' -> no price shown
                          )
                          : fmtMoney( convertUsdTo(parseFloat(row.price), firm.currency, fx.rates), firm.currency )
                        }
                      </td>
                    )}
                      {visibleColumns.includes('high') && (
                        <td className="border p-2">
                          {isUST ? '-' : (isPM ? '-' : fmtMoney(convertUsdTo(parseFloat(row.high), firm.currency, fx.rates), firm.currency))}
                        </td>
                      )}
                      {visibleColumns.includes('low') && (
                        <td className="border p-2">
                          {isUST ? '-' : (isPM ? '-' : fmtMoney(convertUsdTo(parseFloat(row.low), firm.currency, fx.rates), firm.currency))}
                        </td>
                      )}
                      {visibleColumns.includes("change") && (
                        <td
                          className={`border p-2 ${
                            (() => {
                              if (isUST)
                                return (ustDelta ?? 0) >= 0
                                  ? "text-green-600"
                                  : "text-red-600";
                              if (isPM) {
                                const val = unit === "price" ? pmPct : pmValue;
                                return (val ?? 0) >= 0
                                  ? "text-green-600"
                                  : "text-red-600";
                              }
                              return parseFloat(row.change) >= 0
                                ? "text-green-600"
                                : "text-red-600";
                            })()
                          }`}
                        >
                          {isUST
                            ? ustDelta == null
                              ? "—"
                              : `${ustDelta >= 0 ? "+" : ""}${ustDelta.toFixed(
                                  2
                                )} pp`
                            : isPM
                            ? seriesUnitsMemo[row.symbol] === "price"
                              ? pmPct == null
                                ? "—"
                                : `${pmPct >= 0 ? "+" : ""}${pmPct.toFixed(2)}%`
                              : pmValue == null
                              ? "—"
                              : `${pmValue.toFixed(2)}%`
                            : `${row.change >= 0 ? "+" : ""}${Number(row.change).toFixed(2)}%`}
                        </td>
                      )}
                      {visibleColumns.includes("volume") && (
                        <td className="border p-2">
                          {isUST ? "—" : (isPM ? '-' : row.volume)}
                        </td>
                      )}
                      {visibleColumns.includes('marketCap') && (
                        <td className="border p-2">
                          {isUST ? '—' : (isPM ? '-' : fmtMoney(convertUsdTo(Number(row.marketCap), firm.currency, fx.rates), firm.currency))}
                        </td>
                      )}
                      {visibleColumns.includes("peRatio") && (
                        <td className="border p-2">
                          {isUST ? "—" : (isPM ? '-' : row.peRatio)}
                        </td>
                      )}
                      {visibleColumns.includes("sector") && (
                        <td className="border p-2">
                          {isUST
                            ? "—"
                            : isPM
                              ? (pmIndex[id]?.sector || "")   // <-- PM sector from admin (blank if missing)
                              : row.sector                    // regular equities keep their mock/real sector
                          }
                        </td>
                      )}
                      {visibleColumns.includes('week52High') && (
                        <td className="border p-2">
                          {isUST ? '—' : (isPM ? '-' : fmtMoney(convertUsdTo(parseFloat(row.week52High), firm.currency, fx.rates), firm.currency))}
                        </td>
                      )}
                      {visibleColumns.includes('week52Low') && (
                        <td className="border p-2">
                          {isUST ? '—' : (isPM ? '-' : fmtMoney(convertUsdTo(parseFloat(row.week52Low), firm.currency, fx.rates), firm.currency))}
                        </td>
                      )}
                      {visibleColumns.includes("beta") && (
                        <td className="border p-2">
                          {isUST ? "—" : (isPM ? '-' : row.beta)}
                        </td>
                      )}

                      {dateMode === "range" && (
                        <td className="border p-2">
                          <button
                            type="button"
                            className="px-3 py-1 rounded bg-blue-600 text-white"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openHistory(row.symbol);
                            }}
                          >
                            View History
                          </button>
                        </td>
                      )}

                      <td className="border p-2 text-center">
                        <button
                          onClick={() => removeSummarySymbol(row.symbol)}
                          className="text-red-500 font-bold"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* History panel */}
            {historySymbol && (
              <div className="mt-4 border rounded-lg card">
                <div className="flex items-center justify-between px-3 py-2 border-b">
                  <div className="font-medium text-sm">
                    History for {historySymbol}
                    {dateMode === "range" && historyStart && historyEnd
                      ? ` · ${historyStart} → ${historyEnd}`
                      : dateMode === "single" && historyStart
                      ? ` · ${historyStart}`
                      : null}
                  </div>
                  <button
                    onClick={() => {
                      setHistorySymbol(null);
                      setHistoryRows([]);
                      localStorage.removeItem(HISTORY_KEY("symbol"));
                    }}
                    className="text-xs px-2 py-1 rounded tab-ghost"
                  >
                    Close
                  </button>
                </div>

                <div className="p-3 space-y-3 relative">
                  {historyLoading && (
                    <div className="absolute inset-0 card/70 flex flex-col items-center justify-center text-sm rounded-b-lg">
                      <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full mb-2" />
                      Loading…
                    </div>
                  )}

                  <div className="flex flex-wrap items-end gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">
                        From
                      </label>
                      <input
                        type="date"
                        className="tab-ghost rounded px-2 py-1 text-sm"
                        value={historyStart || ""}
                        min={currHistoryBounds.min || undefined}
                        max={currHistoryBounds.max || undefined}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (!raw) return;

                          // first clamp to symbol bounds
                          const symbolClamped = clampDateStr(
                            raw,
                            currHistoryBounds.min,
                            currHistoryBounds.max
                          );

                          
                          setHistoryStart(symbolClamped);
                        }}
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-gray-600 mb-1">
                        To
                      </label>
                      <input
                        type="date"
                        className="tab-ghost rounded px-2 py-1 text-sm"
                        value={historyEnd || ""}
                        min={currHistoryBounds.min || undefined}
                        max={currHistoryBounds.max || undefined}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (!raw) return;

                          const symbolClamped = clampDateStr(
                            raw,
                            currHistoryBounds.min,
                            currHistoryBounds.max
                          );

                          setHistoryEnd(symbolClamped);
                        }}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={refreshHistory}
                      className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm"
                      disabled={historyLoading}
                    >
                      Refresh
                    </button>

                    <div className="relative" ref={historyExportRef}>
                      <button
                        type="button"
                        onClick={() =>
                          setShowHistoryExport((v) => !v)
                        }
                        className="px-3 py-1.5 rounded text-sm
                                    border border-gray-300 text-gray-900
                                  dark:border-gray-600 dark:text-gray-100"
                        disabled={historyLoading || !historyRows?.length}
                      >
                        Export
                      </button>
                      {showHistoryExport && (
                        <div className="absolute z-20 card rounded shadow mt-1 w-36 text-sm
                                      bg-white text-gray-900
                                      dark:bg-gray-800 dark:text-gray-100">
                          <button
                            className="block w-full text-left px-3 py-1 text-gray-900 dark:text-gray-100 opacity-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                            onClick={() => {
                              setShowHistoryExport(false);
                              const exportRows = buildHistoryExportRows(historyRows,historySymbol);
                              const columns = Object.keys(exportRows[0] || {});
                              exportCSV(exportRows, `${historySymbol}_history.csv`, columns);
                            }}
                          >
                            CSV
                          </button>
                          <button
                            className="block w-full text-left px-3 py-1 text-gray-900 dark:text-gray-100 opacity-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                            onClick={() => {
                              setShowHistoryExport(false);
                              const exportRows = buildHistoryExportRows(historyRows, historySymbol);
                              const columns = Object.keys(exportRows[0] || {});
                              exportXLSX(exportRows, `${historySymbol}_history.xlsx`, columns);
                            }}
                          >
                            Excel
                          </button>
                          <button
                            className="block w-full text-left px-3 py-1 text-gray-900 dark:text-gray-100 opacity-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                            onClick={() => {
                              setShowHistoryExport(false);
                              const exportRows = buildHistoryExportRows(historyRows, historySymbol);
                              const columns = Object.keys(exportRows[0] || {});

                              exportPDF(
                                exportRows,
                                `${historySymbol} History`,
                                `${historySymbol}_history.pdf`,
                                columns
                              );
                            }}
                          >
                            PDF
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="text-xs subtle">
                      {currHistoryBounds.min && currHistoryBounds.max
                        ? `Available ${currHistoryBounds.min} → ${currHistoryBounds.max}`
                        : null}
                    </div>
                  </div>

                  <div className="max-h-[45vh] overflow-auto border rounded">
                    {historyRows && historyRows.length > 0 ? (
                      <table className="min-w-full text-xs theme-table">
                        <thead>
                          <tr className="table-head sticky top-0">
                            {Object.keys(historyRows[0]).map((key) => (
                              <th
                                key={key}
                                className="px-2 py-1 text-left font-semibold"
                              >
                                {key}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {historyRows.map((r, i) => (
                            <tr key={i}>
                              {Object.keys(historyRows[0]).map((key) => (
          <td key={key} className="px-2 py-1 whitespace-nowrap">
            {(() => {
              const isUST = historySymbol?.startsWith('US');
              const isPM  = historySymbol?.startsWith('PM:');

              // PM unit (defaults to price)
              const pmIndex = Object.fromEntries((pmItems || []).map(it => [it.id, it]));
              const pmUnit = isPM && pmIndex[historySymbol]?.unit === 'percent' ? 'percent' : 'price';

              const val = r[key];
              if (val == null) return '—';

              // Pretty sign helper
              const withSign = (n, digits = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;

              // Format per column
              if (key === 'value') {
                if (isPM) {
                  return pmUnit === 'percent'
                    ? `${Number(val).toFixed(2)}%`
                    : fmtMoney(convertUsdTo(Number(val), firm.currency, fx.rates), firm.currency);
                }
                if (!isUST) {
                  // Stock value-like columns don’t exist; keep raw for non-PM unless you change schema
                  return val;
                }
              }

              if (key === 'change') {
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';

  const positive = num >= 0;
  const cls = positive ? 'text-green-600' : 'text-red-600';

  // PM formatting
  if (isPM) {
    return (
      <span className={cls}>
        {pmUnit === 'percent'
          ? `${withSign(num, 2)} pp`
          : `${withSign(num, 2)}%`}
      </span>
    );
  }

  // Equity formatting (close → % change)
  if (!isUST) {
    return (
      <span className={cls}>
        {withSign(num, 2)}%
      </span>
    );
  }

  // UST → percentage points
  return (
    <span className={cls}>
      {withSign(num, 2)} pp
    </span>
  );
}


              // For stock OHLC, show currency in chosen unit
              if (['open','high','low','close'].includes(key)) {
                return fmtMoney(convertUsdTo(Number(val), firm.currency, fx.rates), firm.currency);
              }

              // Volume stays numeric, everything else as-is
              return val;
            })()}
          </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : historyRows === null ? (
                      <div className="p-4 text-gray-500">
                        Loading market data…
                      </div>
                    ) : (
                      <div className="p-4 text-gray-500">
                        No history for this selection.
                      </div>
                    )
                  }
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Market Commentary */}
<div className="mt-6 card p-4 rounded-lg">
  <div className="flex items-center justify-between mb-2">
    <h3 className="text-lg font-semibold">Market Commentary</h3>
    {isRegistered(firm?.disclosure?.regulatoryStatus) && (
    <span className="text-xs subtle">Provided by advisor</span>
    )}
  </div>

  {advisorNotes.length === 0 ? (
    <p className="text-sm subtle">No notes available.</p>
  ) : (
    <div className="divide-y border rounded-lg" style={{ borderColor: 'var(--border)' }}>
      {advisorNotes.map((note) => {
        const isOpen = openNoteIds.has(note.id);
        return (
          <div key={note.id}>
            <button
              className="note-header w-full flex items-center justify-between px-3 py-2 text-left rounded-none"
              onClick={() => toggleNoteOpen(note.id)}
              aria-expanded={isOpen}
            >
              <span className="note-title">{note.title}</span>
              <span className="ml-3 subtle">{isOpen ? "▾" : "▸"}</span>
            </button>

            {isOpen && (
              <div
                className="advisor-note-body"
                dangerouslySetInnerHTML={{ __html: sanitizeNoteHtml(note.content) }}
              />
            )}
          </div>
        );
      })}
    </div>
  )}
</div>
      </div>

      {/* Contact strip (outside the inner container, still inside <main>) */}
      <div className="your-existing-cta-classes cta-bg rounded-2xl px-6 py-4 flex items-center justify-between gap-4 md:flex-nowrap flex-wrap my-6 md:my-8">
  <div className="cta-ink leading-snug">
    <p className="m-0 font-semibold text-lg md:text-xl">
      Interested in working with {firm.firmName}?
    </p>
    <p className="m-0 opacity-90">
      We’ll pass your info directly to the{" "}
      {getContactCtaLabel(firm?.disclosure?.regulatoryStatus)
        .replace("Contact ", "")
        .toLowerCase()}.
    </p>
  </div>

  <button
    className="btn btn-secondary shrink-0"
    onClick={() => {
      setLead(EMPTY_LEAD);
      setLeadErr("");
      setShowLead(true);
    }}
    disabled={!leadTo}
    title={!leadTo ? "Advisor hasn’t set a lead email yet." : undefined}
  >
    {getContactCtaLabel(firm?.disclosure?.regulatoryStatus)}
  </button>
</div>

    </main>

    {/* prospect fillout form for "Contact Advisor" button*/}
    {showLead && (
      <div className="fixed inset-0 z-50 lead-modal">
        <div className="absolute inset-0 backdrop" onClick={() => setShowLead(false)} />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto w-[min(720px,92vw)] max-h-[85vh] rounded-2xl panel p-4 shadow-xl flex flex-col space-y-3">

          <h3 className="text-xl font-semibold text-[color:var(--text)]">Tell us how to reach you</h3>
          {leadErr && <div className="text-red-600 text-sm">{leadErr}</div>}

          <input
            className="w-full rounded border p-2 text-[color:var(--text)] placeholder-[color:var(--subtle)]"
            placeholder="Name (required)"
            value={lead.name}
            onChange={(e) => setLead((v) => ({ ...v, name: e.target.value }))}
          />

          <input
            className="w-full rounded border p-2 text-[color:var(--text)] placeholder-[color:var(--subtle)]"
            placeholder="Email (optional)"
            value={lead.email}
            onChange={(e) => setLead((v) => ({ ...v, email: e.target.value }))}
          />

          <input
            className="w-full rounded border p-2 text-[color:var(--text)] placeholder-[color:var(--subtle)]"
            placeholder="Phone (optional)"
            inputMode="tel"
            value={lead.phone}
            onChange={(e) => setLead((v) => ({ ...v, phone: e.target.value }))}
          />

          {/* Country (required) */}
          <select
            className="w-full rounded border p-2 text-[color:var(--text)] placeholder-[color:var(--subtle)]"
            value={lead.country}
            onChange={(e) =>
              setLead((v) => ({
                ...v,
                country: e.target.value,
                state: "",
                countryOther: "",
              }))
            }
          >
            <option value="">Select country</option>
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          {/* State (required when US) */}
          {lead.country === "United States" && (
            <select
              className="w-full rounded border p-2 text-[color:var(--text)] placeholder-[color:var(--subtle)]"
              value={lead.state}
              onChange={(e) =>
                setLead((v) => ({ ...v, state: e.target.value }))
              }
            >
              <option value="">Select state</option>
              {US_STATES.map((s) => (
                <option key={s.abbr} value={s.abbr}>
                  {s.name} ({s.abbr})
                </option>
              ))}
            </select>
          )}

          {lead.country === "Other" && (
            <input
              className="w-full rounded border p-2 text-[color:var(--text)] placeholder-[color:var(--subtle)]"
              placeholder="Enter country (required)"
              value={lead.countryOther}
              onChange={(e) =>
                setLead((v) => ({ ...v, countryOther: e.target.value }))
              }
            />
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              className="px-3 py-2 rounded btn-cancel"
              onClick={() => {
                setShowLead(false);
                setLead(EMPTY_LEAD);
                setLeadErr("");
              }}
            >
              Cancel
            </button>
            <button
              className="px-3 py-2 rounded bg-blue-600 text-white disabled:opacity-50"
              onClick={async () => {
                if (!isLeadValid(lead)) {
                  setLeadErr(
                    "Name + Country/State + (Email or Phone) required"
                  );
                  return;
                }
                setLeadErr("");

                const base = import.meta.env?.VITE_API_BASE ?? "/api";
                const advisor = encodeURIComponent(slug || "demo");

                const country =
                  lead.country === "Other"
                    ? (lead.countryOther || "").trim()
                    : lead.country;

                const state =
                  lead.country === "United States" ? lead.state : undefined;

                const res = await fetch(`${base}/advisors/${advisor}/leads`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name: lead.name,
                    email: lead.email,
                    phone: lead.phone,
                    country,
                    state,
                  }),
                });
                if (res.ok) {
                  setShowLead(false);
                  setLead(EMPTY_LEAD);
                  toast.success(
                    isRegistered(firm?.disclosure?.regulatoryStatus)
                      ? `Thanks! We’ve sent your info to ${firm.firmName}. They’ll contact you shortly.`
                      : `Thanks! We’ve sent your info to ${firm.firmName}.`
                  );
                } else {
                  const err = await res.text().catch(() => "");
                  setLeadErr(err || `Send failed (HTTP ${res.status})`);
                  toast.error(err || `Send failed (HTTP ${res.status})`);
                }
              }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
    )}

    {/* Footer */}
    <footer className="mt-8">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Contact + Social */}
        <div className="card rounded p-4">
          <div
            className={`grid gap-4 ${
              hasFooterLogo ? "sm:grid-cols-4" : "sm:grid-cols-3"
            }`}
          >
            {/* Contact block */}
            <div>
              <ul className="space-y-1 text-sm text-[color:var(--text)]">
                {firm.contactEmail && (
                  <li>
                    <span className="subtle font-medium font-serif">
                      Email:
                    </span>{" "}
                    <a className="font-semibold underline brand-text hover:opacity-90" href={`mailto:${firm.contactEmail}`}>
                      {firm.contactEmail}
                    </a>
                  </li>
                )}
                {firm.contactPhone && (
                  <li>
                    <span className="subtle font-medium font-serif">
                      Phone:
                    </span>{" "}
                    <span className="font-semibold text-[color:var(--text)]">
                      {firm.contactPhone}
                    </span>
                  </li>
                )}
                <li className="whitespace-pre-wrap font-semibold text-[color:var(--text)]">
                  {renderAddress()}
                </li>
                {firm.website && (
                  <li>
                    <a
                      className="font-semibold underline brand-text hover:opacity-90" 
                      href={firm.website}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {firm.websiteLabel || firm.website}
                    </a>
                  </li>
                )}
              </ul>
            </div>

            {/* spacer */}
            <div className="hidden sm:block" />

            {/* Socials */}
            <div>
              <div className="flex items-center gap-4">
                {firm.linkedin && (
                  <a
                    href={firm.linkedin}
                    target="_blank"
                    rel="noreferrer"
                    title="LinkedIn"
                    className="shrink-0"
                  >
                    <svg
                      width="32"
                      height="32"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="text-[color:var(--subtle)] hover:text-[color:var(--text)]"
                    >
                      <path d="M4.98 3.5C4.98 4.88 3.88 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8h4V24h-4V8zM8 8h3.8v2.2h.05c.53-1 1.84-2.2 3.79-2.2 4.05 0 4.8 2.67 4.8 6.15V24h-4v-7.1c0-1.7-.03-3.9-2.38-3.9-2.38 0-2.75 1.86-2.75 3.78V24h-4V8z" />
                    </svg>
                  </a>
                )}
                {firm.facebook && (
                  <a
                    href={firm.facebook}
                    target="_blank"
                    rel="noreferrer"
                    title="Facebook"
                    className="shrink-0"
                  >
                    <svg
                      width="32"
                      height="32"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="text-[color:var(--subtle)] hover:text-[color:var(--text)]"
                    >
                      <path d="M22.675 0H1.325C.593 0 0 .593 0 1.326v21.348C0 23.407.593 24 1.325 24H12.82v-9.294H9.692V11.07h3.128V8.414c0-3.1 1.893-4.788 4.659-4.788 1.325 0 2.463.099 2.795.143v3.24h-1.918c-1.505 0-1.796.716-1.796 1.767V11.07h3.59l-.467 3.636h-3.123V24h6.128C23.407 24 24 23.407 24 22.674V1.326C24 .593 23.407 0 22.675 0z" />
                    </svg>
                  </a>
                )}
                {firm.twitter && (
                  <a
                    href={firm.twitter}
                    target="_blank"
                    rel="noreferrer"
                    title="Twitter/X"
                    className="shrink-0"
                  >
                    <svg
                      width="32"
                      height="32"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="text-[color:var(--subtle)] hover:text-[color:var(--text)]"
                    >
                      <path d="M18.244 2H21l-6.56 7.49L22.5 22h-6.873l-5.38-6.85L3.5 22H1l7.21-8.24L1.5 2h6.873l4.987 6.354L18.244 2zm-2.41 18h1.494L8.21 4H6.718l9.116 16z" />
                    </svg>
                  </a>
                )}
              </div>
            </div>

            {/* Logo column */}
            {hasFooterLogo && (
              <div className="flex items-start justify-end">
                <img
                  src={firm.logoDataUrl || firm.logoUrl}
                  alt={`${firm.firmName} logo`}
                  className="w-auto opacity-90"
                  style={{ height: `${footerH}px` }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Disclosure Section */}
<section className="mt-10 border-t pt-4 text-sm text-[color:var(--text)] space-y-1">
  <h3 className="font-semibold">Disclosure:</h3>

  {firm?.disclosure?.regulatoryStatus && (
    <p>Regulatory Status: {firm.disclosure.regulatoryStatus}</p>
  )}

  {(firm?.disclosure?.dataSourceDisclosure ||
    (pmItems?.length > 0
      ? "Private market data provided by advisor; not independently verified."
      : null)) && (
    <p>
      Data Source:{" "}
      {firm.disclosure?.dataSourceDisclosure ||
        "Private market data provided by advisor; not independently verified."}
    </p>
  )}

  <p>
    Content is provided for informational purposes only and does not constitute
    personalized investment advice. Nothing on this page should be construed as
    a recommendation to buy or sell any security.
  </p>

  <p>
    Investing involves risk, including possible loss of principal. Past performance
    is not indicative of future results. Market views expressed are subject to change
    and may not reflect actual future outcomes.
  </p>

  {firm?.disclosure?.customDisclaimer && (
    <p>{firm.disclosure.customDisclaimer}</p>
  )}
</section>
</div>
    </footer>
  </div>
)};
