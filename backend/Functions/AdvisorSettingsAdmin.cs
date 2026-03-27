// Functions/AdvisorSettingsAdmin.cs
using System.Net;
using System.Text.Json;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Microsoft.Azure.Cosmos;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace SummitView.Functions
{
  public class AdvisorSettingsAdmin
  {
    private readonly Container _c;
    private readonly string _key;

    private static readonly JsonSerializerOptions _json = new()
    {
      PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
      WriteIndented = false
    };

    public AdvisorSettingsAdmin(CosmosClient client)
    {
      // DB: summitview, Container: advisorsettings, PK: /advisorSlug
      _c = client.GetContainer("summitview", "advisorsettings");
      _key = Environment.GetEnvironmentVariable("ADMIN_CONSOLE_KEY") ?? "";
    }

    private bool Ok(HttpRequestData r, string slug) =>
      r.Headers.TryGetValues("x-admin-key", out var v) &&
      v.FirstOrDefault() == slug;

    // ---------- GET (admin) ----------
    [Function("GetAdvisorSettingsAdmin")]
    public async Task<HttpResponseData> Get(
      [HttpTrigger(AuthorizationLevel.Anonymous, "get",
        Route = "private/advisors/{slug}/settings")] HttpRequestData req,
      string slug)
    {
      if (!Ok(req, slug)) return req.CreateResponse(HttpStatusCode.Unauthorized);

      var id = $"adv-{slug}";
      JObject doc;

      try
      {
        var resp = await _c.ReadItemAsync<JObject>(id, new PartitionKey(slug));
        doc = resp.Resource;
      }
      catch (CosmosException cex) when (cex.StatusCode == HttpStatusCode.NotFound)
      {
        doc = new JObject
        {
          ["id"] = id,
          ["advisorSlug"] = slug
        };
      }

      var res = req.CreateResponse(HttpStatusCode.OK);
      res.Headers.Add("Content-Type", "application/json");
      await res.WriteStringAsync(doc.ToString(Formatting.None));
      return res;
    }

    // ---------- PUT (admin) ----------
    [Function("PutAdvisorSettingsAdmin")]
    public async Task<HttpResponseData> Put(
      [HttpTrigger(AuthorizationLevel.Anonymous, "put",
        Route = "private/advisors/{slug}/settings")] HttpRequestData req,
      string slug)
    {
       var log = req.FunctionContext.GetLogger("PutAdvisorSettingsAdmin");

      if (!Ok(req, slug)) return req.CreateResponse(HttpStatusCode.Unauthorized);

      log.LogError("🔥 PutAdvisorSettingsAdmin HIT — version 2026-01-24");


      var body = await new StreamReader(req.Body).ReadToEndAsync();
      if (string.IsNullOrWhiteSpace(body))
      {
        var bad = req.CreateResponse(HttpStatusCode.BadRequest);
        await bad.WriteStringAsync("Empty body");
        return bad;
      }

      JObject incoming;
      try
      {
        incoming = JObject.Parse(body);
      }
      catch (Exception ex)
      {
        var bad = req.CreateResponse(HttpStatusCode.BadRequest);
        await bad.WriteStringAsync($"Invalid JSON: {ex.Message}");
        return bad;
      }

      var id = $"adv-{slug}";
      JObject current;
      try         
      {
        var resp = await _c.ReadItemAsync<JObject>(id, new PartitionKey(slug));
        current = resp.Resource;
      }
      catch (CosmosException cex) when (cex.StatusCode == HttpStatusCode.NotFound)
      {
        current = new JObject
        {
          ["id"] = id,
          ["advisorSlug"] = slug
        };
      }

      // Ensure identity fields
      current["id"] = id;
      current["advisorSlug"] = slug;

      // Shallow replace sections we support (keeps anything else, including existing unknown props)
      MergeSection(current, incoming, "branding");
      MergeSection(current, incoming, "contact");
      MergeSection(current, incoming, "disclosure");
      MergeSection(current, incoming, "positions");
      MergeValue  (current, incoming, "positionsVersion");
      MergeValue(current, incoming, "notes");
      MergeSection(current, incoming, "private");   // <-- NEW: persists your private block
      MergeValue(current, incoming, "currency"); // 🔒 FIX
      MergeValue(current, incoming, "fx");       // 🔒 FIX (optional but recommended)

      current["updatedUtc"] = DateTime.UtcNow.ToString("o");

      log.LogError($"[PUT DEBUG] Saving document: {current.ToString(Formatting.None)}");

      var saved = await _c.UpsertItemAsync(current, new PartitionKey(slug));

      var res = req.CreateResponse(HttpStatusCode.OK);
      res.Headers.Add("Content-Type", "application/json");
      await res.WriteStringAsync(current.ToString(Formatting.None));
      return res;
    }

    // ---- helpers ----
    private static void MergeSection(JObject target, JObject source, string key)
    {
      if (source.TryGetValue(key, out var token) && token is JObject obj)
        target[key] = obj; // replace whole section
    }
    private static void MergeValue(JObject target, JObject source, string key)
    {
      if (
        source.TryGetValue(key, out var token) &&
        token is not null &&
        token.Type != JTokenType.Null &&
        token.Type != JTokenType.Undefined
      )
      {
        target[key] = token;
      }
    }
  }
}
