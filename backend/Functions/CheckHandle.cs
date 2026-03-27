using System;
using System.Net;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Azure.Cosmos;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

public class CheckHandle
{
    [Function("CheckHandle")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "checkhandle")]
        HttpRequestData req)
    {
        var conn = Environment.GetEnvironmentVariable("CosmosDbConnection");

        if (string.IsNullOrWhiteSpace(conn))
            throw new Exception("CosmosDbConnection missing");

        var client = new CosmosClient(conn);
        var container = client.GetContainer("summitview", "advisors");

        var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        var handle = query["handle"]?.Trim().ToLower();

        if (string.IsNullOrWhiteSpace(handle))
        {
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteStringAsync("{\"available\":false}");
            return bad;
        }

        var id = $"adv-{handle}";

        try
        {
            await container.ReadItemAsync<dynamic>(id, new PartitionKey(handle));

            var taken = req.CreateResponse(HttpStatusCode.OK);
            await taken.WriteStringAsync("{\"available\":false}");
            return taken;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            var available = req.CreateResponse(HttpStatusCode.OK);
            await available.WriteStringAsync("{\"available\":true}");
            return available;
        }
    }
}