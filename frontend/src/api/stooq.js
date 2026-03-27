// src/api/stooq.js

export async function fetchStooqChart(symbol) {
  const base = "https://quietpitch-funcapp-axfccbhygagpbkdw.eastus-01.azurewebsites.net/api";
  const url = `${base}/stooq-chart/${symbol}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Stooq fetch failed for ${symbol}`);
  }

  const j = await res.json();
  return Array.isArray(j?.historical) ? j.historical : [];
}
