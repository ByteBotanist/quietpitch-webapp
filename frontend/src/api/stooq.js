// src/api/stooq.js

export async function fetchStooqChart(symbol) {
  const normalized = symbol.toLowerCase().includes(".")
    ? symbol.toLowerCase()
    : `${symbol.toLowerCase()}.us`;

  const url = `https://stooq.com/q/d/l/?s=${normalized}&i=d`;

  const res = await fetch(url);
  const text = await res.text();

  if (!text || text.startsWith("Date") === false) {
    return [];
  }

  const lines = text.trim().split("\n");

  const rows = lines.slice(1).map(line => {
    const [date, open, high, low, close] = line.split(",");
    return [
      new Date(date).getTime(),
      parseFloat(close)
    ];
  }).filter(([t, v]) => !isNaN(t) && !isNaN(v));

  return rows;
}