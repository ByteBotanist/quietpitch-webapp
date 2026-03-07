export async function fetchFmpSummary(symbols = []) {
  const base = "https://quietpitch-funcapp-axfccbhygagpbkdw.eastus-01.azurewebsites.net/api";
  const joined = symbols.join(",");
  const res = await fetch(`${base}/fmp-summary?symbols=${joined}`);
  if (!res.ok) throw new Error("Failed to load summary");
  return res.json();
}

export async function fetchFmpChart(symbol) {
  const base = "https://quietpitch-funcapp-axfccbhygagpbkdw.eastus-01.azurewebsites.net/api";
  const res = await fetch(`${base}/fmp-chart/${symbol}`);
  if (!res.ok) throw new Error("Failed to load chart");
  const j = await res.json();
  return j.historical || [];
}
