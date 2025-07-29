using System.Net;
using System.Text.Json;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading.Tasks;


public class GetLivePrice
{
    private readonly HttpClient _httpClient;
    private readonly ILogger _logger;
    private static readonly SecretClient _secretClient = new SecretClient(
        new Uri("https://shadowmarketvault.vault.azure.net/"), 
        new DefaultAzureCredential()
    );

    public GetLivePrice(IHttpClientFactory httpClientFactory, ILoggerFactory loggerFactory)
    {
        _httpClient = httpClientFactory.CreateClient();
        _logger = loggerFactory.CreateLogger<GetLivePrice>();
    }

    [Function("GetLivePrice")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "price-live/{symbol}")] HttpRequestData req,
        string symbol)
    {
        var response = req.CreateResponse();

// ⚙️ MOCK toggle (should come from app config or env)
var useMockData = (Environment.GetEnvironmentVariable("UseMockData") ?? "false")
    .Equals("true", StringComparison.OrdinalIgnoreCase);

if (useMockData)
{
    var mockPrices = new Dictionary<string, (decimal price, string name)>
    {
        { "TSLA", (720.50m, "Tesla Inc") },
        { "AAPL", (150.23m, "Apple Inc") },
        { "MSFT", (305.65m, "Microsoft Corp") },
        { "TGT",  (95.94m, "Target Corp") },
        { "UBER", (88.26m, "Uber Technologies") },
        { "UAL",  (45.30m, "United Airlines") }
    };

    if (!mockPrices.ContainsKey(symbol.ToUpper()))
    {
        response.StatusCode = HttpStatusCode.NotFound;
        await response.WriteStringAsync("Symbol not found in mock data.");
        return response;
    }

    var mock = mockPrices[symbol.ToUpper()];
    var result = new
    {
        symbol = symbol.ToUpper(),
        companyName = mock.name,
        price = mock.price,
        high = mock.price * 1.05m,
        low = mock.price * 0.95m,
        volume = "1000000",
        changePercent = "0.00%",
        timestamp = DateTime.UtcNow
    };

    await response.WriteAsJsonAsync(result);
    return response;
}

        try
        {
            var apiKeys = await GetAlphaVantageApiKeysAsync(); // now returns List<string>

            string json = string.Empty;
            bool success = false;

            foreach (var apiKey in apiKeys)
            {
                var apiUrl = $"https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol={symbol.ToUpper()}&apikey={apiKey}";
                var apiResponse = await _httpClient.GetAsync(apiUrl);

                if (apiResponse.IsSuccessStatusCode)
                {
                    var tempJson = await apiResponse.Content.ReadAsStringAsync();

                    // If the response contains rate limit messages, skip this key
                    if (tempJson.Contains("\"Note\"") || tempJson.Contains("\"Information\""))
                    {
                        _logger.LogWarning("API key {Key} hit rate limit. Skipping.", apiKey);
                        continue;
                    }

                    json = tempJson;
                    success = true;
                    break;
                }

                else
                {
                    _logger.LogWarning("Alpha Vantage API call failed with key: {Key} - Status: {StatusCode}", apiKey, apiResponse.StatusCode);
                }
            }

            if (!success)
            {
                response.StatusCode = HttpStatusCode.BadGateway;
                await response.WriteStringAsync("Error fetching live price with available API keys.");
                return response;
            }

            string companyName = string.Empty;

            try
            {
                var searchUrl = $"https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords={symbol.ToUpper()}&apikey={apiKeys[0]}";
                var searchResponse = await _httpClient.GetAsync(searchUrl);
                if (searchResponse.IsSuccessStatusCode)
                {
                    var searchJson = await searchResponse.Content.ReadAsStringAsync();
                    using var searchDoc = JsonDocument.Parse(searchJson);
                    var matches = searchDoc.RootElement.GetProperty("bestMatches");

                    foreach (var match in matches.EnumerateArray())
                    {
                        if (match.GetProperty("1. symbol").GetString()?.ToUpper() == symbol.ToUpper())
                        {
                            companyName = match.GetProperty("2. name").GetString() ?? "";
                            break;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning("Failed to fetch company name for {Symbol}: {Message}", symbol, ex.Message);
            }

            _logger.LogInformation("Alpha Vantage raw response: {json}", json);

            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("Global Quote", out var quote) || quote.ValueKind != JsonValueKind.Object)
            {
                _logger.LogWarning("Global Quote not found for symbol: {Symbol}", symbol);
                response.StatusCode = HttpStatusCode.NotFound;
                await response.WriteStringAsync("Symbol not found or no data available.");
                return response;
            }

            var result = new
            {
                symbol = quote.GetProperty("01. symbol").GetString(),
                companyName = companyName,
                price = decimal.Parse(quote.GetProperty("05. price").GetString() ?? "0"),
                high = quote.GetProperty("03. high").GetString(),
                low = quote.GetProperty("04. low").GetString(),
                volume = quote.GetProperty("06. volume").GetString(),
                changePercent = quote.GetProperty("10. change percent").GetString(),
                timestamp = DateTime.UtcNow
            };

            response.StatusCode = HttpStatusCode.OK;
            await response.WriteAsJsonAsync(result);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Exception while fetching live price.");
            response.StatusCode = HttpStatusCode.InternalServerError;
            await response.WriteStringAsync($"Server error: {ex.Message}");
            return response;
        }
    }

    // 🔥 New method to rotate multiple keys
    private async Task<List<string>> GetAlphaVantageApiKeysAsync()
    {
        var keys = new List<string>();

        var secretNames = new[]
        {
            "AlphaVantageApiKey1",
            "AlphaVantageApiKey2",
            "AlphaVantageApiKey3", // Add more keys here as needed
            "AlphaVantageApiKey4",
            "AlphaVantageApiKey5",
            "AlphaVantageApiKey6",
            "AlphaVantageApiKey7",
            "AlphaVantageApiKey8",
            "AlphaVantageApiKey9",
            "AlphaVantageApiKey10",
            "AlphaVantageApiKey11",
            "AlphaVantageApiKey12",
            "AlphaVantageApiKey13",
            "AlphaVantageApiKey14",
            "AlphaVantageApiKey15"
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
                _logger.LogWarning("Failed to retrieve {KeyName}: {Message}", name, ex.Message);
            }
        }

        return keys;
    }

}

