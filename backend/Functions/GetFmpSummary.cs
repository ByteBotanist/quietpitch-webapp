using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace SummitView.Functions
{
    public class GetFmpSummary
    {
        private static readonly HttpClient Http = new HttpClient();
        private static readonly ConcurrentDictionary<string, (DateTimeOffset, string)> Cache = new();
        private const int CACHE_MINUTES = 30;

        [Function("GetFmpSummary")]
        public async Task<HttpResponseData> Run(
            [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "fmp-summary")] HttpRequestData req,
            FunctionContext context)
        {
            var logger = context.GetLogger("GetFmpSummary");
            var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var symbolsRaw = query["symbols"];

            if (string.IsNullOrWhiteSpace(symbolsRaw))
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteStringAsync("symbols query param is required.");
                return bad;
            }

            var cacheKey = $"v2:{symbolsRaw.ToUpperInvariant()}";
            if (Cache.TryGetValue(cacheKey, out var entry) && entry.Item1 > DateTimeOffset.UtcNow)
            {
                var cached = req.CreateResponse(HttpStatusCode.OK);
                await cached.WriteStringAsync(entry.Item2);
                return cached;
            }

            try
            {
                var apiKey = Environment.GetEnvironmentVariable("FMP_API_KEY");
                var symbols = string.Join(",", symbolsRaw.Split(',').Select(s => s.Trim().ToUpperInvariant()));

                var quoteUrl = $"https://financialmodelingprep.com/stable/quote?symbol={symbols}&apikey={apiKey}";
                var profileUrl = $"https://financialmodelingprep.com/stable/profile?symbol={symbols}&apikey={apiKey}";

                var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

                var quoteJson = await Http.GetStringAsync(quoteUrl);
                var profileJson = await Http.GetStringAsync(profileUrl);

                var quotes = JsonSerializer.Deserialize<List<FmpQuote>>(quoteJson, options) ?? new();
                var profiles = JsonSerializer.Deserialize<List<FmpProfile>>(profileJson, options) ?? new();

                var profileBySymbol = profiles
                    .Where(p => !string.IsNullOrEmpty(p.Symbol))
                    .ToDictionary(p => p.Symbol!, p => p, StringComparer.OrdinalIgnoreCase);

                foreach (var q in quotes)
{
    profileBySymbol.TryGetValue(q.Symbol ?? "", out var p);

    // ✅ Use quote P/E directly if available
    if (q.Pe == null || q.Pe == 0)
        q.Pe = p?.Pe ?? p?.Beta; // fallback to profile or beta

    // ✅ Calculate Dividend Yield from lastDiv if available
    if ((q.DividendYield == null || q.DividendYield == 0) && q.Price > 0 && q.LastDiv > 0)
    {
        q.DividendYield = Math.Round((q.LastDiv.Value * 4 / q.Price.Value) * 100.0, 2);
        logger.LogInformation($"[MVP] Calculated dividend yield for {q.Symbol}: {q.DividendYield}%");
    }

    // ✅ Fallback for missing % Change
    if (q.ChangesPercentage == null && q.Price != null && q.DayLow != null && q.DayHigh != null)
    {
        var avg = (q.DayHigh.Value + q.DayLow.Value) / 2.0;
        if (avg > 0)
            q.ChangesPercentage = Math.Round((q.Price.Value - avg) / avg * 100.0, 2);
    }
}


                var rows = quotes.Select(q =>
                {
                    profileBySymbol.TryGetValue(q.Symbol ?? "", out var p);
                    return new
                    {
                        symbol = q.Symbol,
                        company = p?.CompanyName ?? q.Name,
                        price = q.Price,
                        high = q.DayHigh,
                        low = q.DayLow,
                        change = q.ChangesPercentage,
                        volume = q.Volume,
                        marketCap = q.MarketCap,
                        peRatio = q.Pe,
                        dividendYield = q.DividendYield,
                        sector = p?.Sector,
                        week52High = q.YearHigh,
                        week52Low = q.YearLow,
                        beta = p?.Beta
                    };
                });

                var json = JsonSerializer.Serialize(rows);
                Cache[cacheKey] = (DateTimeOffset.UtcNow.AddMinutes(CACHE_MINUTES), json);

                var ok = req.CreateResponse(HttpStatusCode.OK);
                await ok.WriteStringAsync(json);
                return ok;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "FMP Summary failed");
                var err = req.CreateResponse(HttpStatusCode.InternalServerError);
                await err.WriteStringAsync("Error fetching data");
                return err;
            }
        }
    }

    // 📦 Models
    public class FmpQuote
    {
        public string? Symbol { get; set; }
        public string? Name { get; set; }
        public double? Price { get; set; }
        public double? DayHigh { get; set; }
        public double? DayLow { get; set; }
        public double? ChangesPercentage { get; set; }
        public double? Volume { get; set; }
        public double? MarketCap { get; set; }
        public double? Pe { get; set; }
        public double? DividendYield { get; set; }
        public double? YearHigh { get; set; }
        public double? YearLow { get; set; }
        public double? LastDiv { get; set; }
    }

    public class FmpProfile
    {
        public string? Symbol { get; set; }
        public string? CompanyName { get; set; }
        public string? Sector { get; set; }
        public double? Beta { get; set; }
        public double? DividendYield { get; set; }
        public double? Pe { get; set; }
    }
}
