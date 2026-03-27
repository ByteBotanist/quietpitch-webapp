using System.Net;
using System.Globalization;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace SummitView_Functions.backend.Functions
{
    public class GetStooqChart
    {
        private static readonly HttpClient http = new HttpClient();

        [Function("GetStooqChart")]
        public async Task<HttpResponseData> Run(
            [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "stooq-chart/{symbol}")]
            HttpRequestData req,
            string symbol)
        {
            if (string.IsNullOrWhiteSpace(symbol))
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteStringAsync("Missing symbol");
                return bad;
            }

            var stooqSymbol = $"{symbol.ToLowerInvariant()}.us";
            var url = $"https://stooq.com/q/d/l/?s={stooqSymbol}&i=d";

            string csv;
            try
            {
                csv = await http.GetStringAsync(url);
            }
            catch
            {
                var err = req.CreateResponse(HttpStatusCode.BadGateway);
                await err.WriteStringAsync("Failed to fetch Stooq");
                return err;
            }

            var lines = csv.Split('\n', StringSplitOptions.RemoveEmptyEntries);
            var rows = new List<object>();

            for (int i = 1; i < lines.Length; i++)
            {
                var cols = lines[i].Split(',');
                if (cols.Length < 5) continue;

                if (!DateTime.TryParse(cols[0], out var d)) continue;
                if (!decimal.TryParse(cols[4], NumberStyles.Any, CultureInfo.InvariantCulture, out var close))
                    continue;

                var ts = new DateTimeOffset(
                    d.Year, d.Month, d.Day, 12, 0, 0, TimeSpan.Zero
                ).ToUnixTimeMilliseconds();

                rows.Add(new object[] { ts, close });
            }

            var res = req.CreateResponse(HttpStatusCode.OK);
            await res.WriteAsJsonAsync(new
            {
                symbol = symbol.ToUpperInvariant(),
                historical = rows
            });

            return res;
        }
    }
}
