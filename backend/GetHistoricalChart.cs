using System.Net;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using System.Text.Json;
using System.Net.Http;
using System;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Linq;

public class GetHistoricalChart
{
    private readonly HttpClient _httpClient;
    private readonly ILogger _logger;
    private static readonly SecretClient _secretClient = new SecretClient(
        new Uri("https://shadowmarketvault.vault.azure.net/"),
        new DefaultAzureCredential()
    );

    public GetHistoricalChart(IHttpClientFactory httpClientFactory, ILoggerFactory loggerFactory)
    {
        _httpClient = httpClientFactory.CreateClient();
        _logger = loggerFactory.CreateLogger<GetHistoricalChart>();
    }

    [Function("GetHistoricalChart")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "historical-chart/{symbol}")] HttpRequestData req,
        string symbol)
    {
        var response = req.CreateResponse();

        try
        {
            // ---- MOCK MODE CHECK ---- (modified for Summit View)
            string useMock = Environment.GetEnvironmentVariable("UseMockData") ?? "false";
            if (useMock.Equals("true", StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogInformation("Using mock data for historical chart.");
                var mockData = GetMockHistoricalData(symbol);
                response.StatusCode = HttpStatusCode.OK;
                await response.WriteAsJsonAsync(mockData);
                return response;
            }
            // ------------------------

            var apiKeys = await GetAlphaVantageApiKeysAsync();

            string[] symbolsArray = symbol.Split(',', StringSplitOptions.RemoveEmptyEntries);
            var combinedData = new List<object>();

            foreach (var sym in symbolsArray)
            {
                string jsonResponse = string.Empty;
                bool success = false;

                foreach (var apiKey in apiKeys)
                {
                    var apiUrl = $"https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol={sym}&apikey={apiKey}";
                    var apiResponse = await _httpClient.GetAsync(apiUrl);

                    if (!apiResponse.IsSuccessStatusCode)
                    {
                        _logger.LogWarning("API call failed for key {Key}: {Status}", apiKey, apiResponse.StatusCode);
                        continue;
                    }

                    var tempJson = await apiResponse.Content.ReadAsStringAsync();

                    if (tempJson.Contains("\"Note\"") || tempJson.Contains("\"Information\"") || tempJson.Contains("\"Error Message\""))
                    {
                        _logger.LogWarning("API key {Key} hit rate limit or error. Skipping.", apiKey);
                        continue;
                    }

                    using var doc = JsonDocument.Parse(tempJson);
                    var root = doc.RootElement;

                    if (!root.TryGetProperty("Time Series (Daily)", out var timeSeries))
                    {
                        _logger.LogWarning("Time Series not found for symbol: {Sym}", sym);
                        continue;
                    }

                    foreach (var day in timeSeries.EnumerateObject())
                    {
                        var date = day.Name;
                        var close = day.Value.GetProperty("4. close").GetString();

                        if (decimal.TryParse(close, out var closeValue))
                        {
                            combinedData.Add(new
                            {
                                date,
                                close = closeValue,
                                symbol = sym.ToUpper()
                            });
                        }
                    }

                    success = true;
                    break;
                }

                if (!success)
                {
                    _logger.LogWarning("Failed to retrieve data for symbol: {Sym}", sym);
                }
            }

            if (combinedData.Count == 0)
            {
                response.StatusCode = HttpStatusCode.NotFound;
                await response.WriteStringAsync("No valid data found.");
                return response;
            }

            var json = JsonSerializer.Serialize(combinedData.OrderBy(d => ((dynamic)d).date));
            response.Headers.Add("Content-Type", "application/json");
            await response.WriteStringAsync(json);
            response.StatusCode = HttpStatusCode.OK;
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Exception while fetching historical prices.");
            response.StatusCode = HttpStatusCode.InternalServerError;
            await response.WriteStringAsync($"Server error: {ex.Message}");
            return response;
        }
    }

    private async Task<List<string>> GetAlphaVantageApiKeysAsync()
    {
        var keys = new List<string>();
        var secretNames = new[]
        {
            "AlphaVantageApiKey1","AlphaVantageApiKey2","AlphaVantageApiKey3","AlphaVantageApiKey4",
            "AlphaVantageApiKey5","AlphaVantageApiKey6","AlphaVantageApiKey7","AlphaVantageApiKey8",
            "AlphaVantageApiKey9","AlphaVantageApiKey10","AlphaVantageApiKey11","AlphaVantageApiKey12",
            "AlphaVantageApiKey13","AlphaVantageApiKey14","AlphaVantageApiKey15"
        };

        foreach (var name in secretNames)
        {
            try
            {
                var secret = await _secretClient.GetSecretAsync(name);
                if (!string.IsNullOrWhiteSpace(secret.Value.Value))
                {
                    keys.Add(secret.Value.Value);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning("Failed to fetch secret {SecretName}: {Message}", name, ex.Message);
            }
        }

        return keys;
    }

    // ---- MOCK DATA ---- (modified for Summit View)
    private object GetMockHistoricalData(string symbol)
    {
        return new
        {
            Symbol = symbol,
            Data = new List<object>
            {
                new { Date = DateTime.UtcNow.AddDays(-5).ToString("yyyy-MM-dd"), Close = 100.5m },
                new { Date = DateTime.UtcNow.AddDays(-4).ToString("yyyy-MM-dd"), Close = 102.3m },
                new { Date = DateTime.UtcNow.AddDays(-3).ToString("yyyy-MM-dd"), Close = 105.8m },
                new { Date = DateTime.UtcNow.AddDays(-2).ToString("yyyy-MM-dd"), Close = 104.1m },
                new { Date = DateTime.UtcNow.AddDays(-1).ToString("yyyy-MM-dd"), Close = 108.9m }
            }
        };
    }
}

