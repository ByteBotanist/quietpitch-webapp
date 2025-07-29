using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

public class GetAdvisorConfig
{
    private readonly ILogger _logger;

    public GetAdvisorConfig(ILoggerFactory loggerFactory)
    {
        _logger = loggerFactory.CreateLogger<GetAdvisorConfig>();
    }

    [Function("GetAdvisorConfig")]
    public async Task<HttpResponseData> Run([HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "config")] HttpRequestData req)
    {
        var response = req.CreateResponse();
        try
        {
            var filePath = Path.Combine(Directory.GetCurrentDirectory(), "advisorConfig.json");
            if (!File.Exists(filePath))
            {
                response.StatusCode = System.Net.HttpStatusCode.NotFound;
                await response.WriteStringAsync("Config file not found.");
                return response;
            }

            var json = await File.ReadAllTextAsync(filePath);
            response.StatusCode = System.Net.HttpStatusCode.OK;
            response.Headers.Add("Content-Type", "application/json");
            await response.WriteStringAsync(json);
        }
        catch (System.Exception ex)
        {
            _logger.LogError(ex, "Error reading advisorConfig.json");
            response.StatusCode = System.Net.HttpStatusCode.InternalServerError;
            await response.WriteStringAsync($"Error: {ex.Message}");
        }

        return response;
    }
}
