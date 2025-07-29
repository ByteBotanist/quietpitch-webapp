using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Azure.Cosmos;
using System.Net.Http;

var host = new HostBuilder()
    .ConfigureFunctionsWorkerDefaults() // no custom options needed here
    .ConfigureServices((context, services) =>
    {
        // Register Cosmos DB Client
        var cosmosConnectionString = context.Configuration["CosmosDbConnection"];
        services.AddSingleton(s => new CosmosClient(cosmosConnectionString));

        // Register HttpClientFactory
        services.AddHttpClient();

        // You can register additional services here as needed
    })
    .Build();

host.Run();
