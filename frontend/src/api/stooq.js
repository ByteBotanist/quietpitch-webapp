// src/api/stooq.js

export async function fetchStooqChart(symbol) {
  const base = import.meta.env?.VITE_API_BASE ?? "/api";
  const url = `${base}/stooq-chart/${symbol}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Stooq fetch failed for ${symbol}`);
  }

  const j = await res.json();
  return Array.isArray(j?.historical) ? j.historical : [];
}
