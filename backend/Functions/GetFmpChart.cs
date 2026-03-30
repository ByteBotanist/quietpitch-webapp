using System.Net;
using System.Text.Json;
using System.Collections.Concurrent;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace SummitView.Functions
{
    public class GetFmpChart
    {
        private static readonly HttpClient Http = new HttpClient();

        // Cache now stores ONLY normalized [[ts,value], ...]
        private static readonly ConcurrentDictionary<string, (DateTimeOffset, string)> Cache = new();

        private const int CACHE_MINUTES = 60;

        [Function("GetFmpChart")]
        public async Task<HttpResponseData> Run(
            [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "fmp-chart/{symbol}")]
            HttpRequestData req,
            string symbol)
        {
            var response = req.CreateResponse();
            response.Headers.Add("Content-Type", "application/json");

            // 🔑 Versioned cache key to avoid old bad payloads
            var cacheKey = $"v2:{symbol.ToUpperInvariant()}";

            if (Cache.TryGetValue(cacheKey, out var entry) &&
                entry.Item1 > DateTimeOffset.UtcNow)
            {
                response.StatusCode = HttpStatusCode.OK;
                await response.WriteStringAsync(entry.Item2);
                return response;
            }

            try
            {
                var apiKey = Environment.GetEnvironmentVariable("FMP_API_KEY");
                if (string.IsNullOrWhiteSpace(apiKey))
                    throw new Exception("Missing FMP_API_KEY");

                var url =
                    $"https://financialmodelingprep.com/stable/historical-price-eod/full" +
                    $"?symbol={symbol}&from=2021-01-01&apikey={apiKey}";

                var rawJson = await Http.GetStringAsync(url);

                using var doc = JsonDocument.Parse(rawJson);

                // 🚨 If FMP returns something unexpected, fail soft
                if (!doc.RootElement.TryGetProperty("historical", out var historical) ||
                    historical.ValueKind != JsonValueKind.Array)
                {
                    var empty = "[]";
                    Cache[cacheKey] = (DateTimeOffset.UtcNow.AddMinutes(CACHE_MINUTES), empty);
                    response.StatusCode = HttpStatusCode.OK;
                    await response.WriteStringAsync(empty);
                    return response;
                }

                // ✅ Normalize to [[timestamp, close], ...]
                var rows = new List<object[]>(historical.GetArrayLength());

                foreach (var p in historical.EnumerateArray())
                {
                    if (!p.TryGetProperty("date", out var dProp)) continue;
                    if (!p.TryGetProperty("close", out var cProp)) continue;

                    if (!DateTime.TryParse(dProp.GetString(), out var date)) continue;

                    var ts = new DateTimeOffset(
                        DateTime.SpecifyKind(date, DateTimeKind.Utc)
                    ).ToUnixTimeMilliseconds();

                    double close;

                    if (cProp.ValueKind == JsonValueKind.Number)
                    {
                        close = cProp.GetDouble();
                    }
                    else if (cProp.ValueKind == JsonValueKind.String &&
                            double.TryParse(cProp.GetString(), out var parsed))
                    {
                        close = parsed;
                    }
                    else
                    {
                        continue;
                    }

                    rows.Add(new object[] { ts, close });
                }

                // FMP returns newest → oldest; charts expect oldest → newest
                rows.Reverse();

                var outJson = JsonSerializer.Serialize(rows);

                Cache[cacheKey] = (DateTimeOffset.UtcNow.AddMinutes(CACHE_MINUTES), outJson);

                response.StatusCode = HttpStatusCode.OK;
                await response.WriteStringAsync(outJson);
                return response;
            }
            catch (Exception ex)
            {
                response.StatusCode = HttpStatusCode.InternalServerError;
                await response.WriteStringAsync($"GetFmpChart error: {ex.Message}");
                return response;
            }
        }
    }
}
