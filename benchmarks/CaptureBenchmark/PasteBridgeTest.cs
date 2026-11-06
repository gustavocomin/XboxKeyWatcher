using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using XboxKeyWatcher.App;

internal static class PasteBridgeTest
{
    internal static void ServeFixture()
    {
        const string key = "T7Q4M-V9K2X-G6W3F-J8D5Y-N4P7R", second = "W3H9K-PQ7XB-M2CRT-6YFDV-B8JGH";
        bool measuring = false;
        using var bridge = new PasteBridge(value => value == key || value == second, (_, elapsed, _) =>
        {
            if (Volatile.Read(ref measuring)) Console.WriteLine(FormattableString.Invariant($"latency {elapsed:F3}"));
        }, native: true);
        Console.WriteLine(bridge.Token);
        while (Console.ReadLine() is string command)
        {
            if (command == "offer") bridge.Offer(key);
            else if (command == "offer2") bridge.Offer(second);
            else if (command == "clear") bridge.Clear();
            else if (command == "measure")
            {
                Volatile.Write(ref measuring, true);
                bridge.Offer(key);
            }
        }
    }

    // HTTP only (no pipe) and honours XKW_BRIDGE_PORT, so it can run beside the installed app.
    internal static void ServeCascade()
    {
        string[] keys = ["T7Q4M-V9K2X-G6W3F-J8D5Y-N4P7R", "W3H9K-PQ7XB-M2CRT-6YFDV-B8JGH"];
        using var bridge = new PasteBridge(value => keys.Contains(value), null, native: false, http: true);
        Console.WriteLine(bridge.Token);
        while (Console.ReadLine() is string command)
        {
            if (command == "offer") bridge.Offer(keys[0]);
            else if (command == "offer2") bridge.Offer(keys[1]);
            else if (command == "clear") bridge.Clear();
        }
    }

    internal static async Task Run()
    {
        const string fixture = "T7Q4M-V9K2X-G6W3F-J8D5Y-N4P7R";
        string clipboard = fixture;
        using var bridge = new PasteBridge(value => value == Volatile.Read(ref clipboard));
        using var client = new HttpClient { BaseAddress = new Uri(PasteBridge.Address), Timeout = TimeSpan.FromSeconds(5) };
        async Task RequireStatus(string path, HttpStatusCode expected, HttpMethod? method = null)
        {
            using var request = new HttpRequestMessage(method ?? HttpMethod.Get, path);
            using var response = await client.SendAsync(request);
            if (response.StatusCode != expected) throw new InvalidOperationException($"{path}: {response.StatusCode}, esperado {expected}.");
        }
        await RequireStatus("pending", HttpStatusCode.Unauthorized);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", bridge.Token);
        await RequireStatus("pending", HttpStatusCode.NoContent);
        bridge.Offer(fixture);
        Volatile.Write(ref clipboard, "changed");
        await RequireStatus("pending", HttpStatusCode.NoContent);
        Volatile.Write(ref clipboard, fixture);
        using var payload = JsonDocument.Parse(await client.GetStringAsync("pending"));
        if (payload.RootElement.GetProperty("Key").GetString() != fixture) throw new InvalidOperationException("Key divergente.");
        string id = payload.RootElement.GetProperty("Id").GetString()!;
        bridge.Offer(fixture);
        using var repeated = JsonDocument.Parse(await client.GetStringAsync("pending"));
        if (repeated.RootElement.GetProperty("Id").GetString() != id)
            throw new InvalidOperationException("Oferta pendente mudou após releitura da mesma key.");
        await RequireStatus($"ack/{id}", HttpStatusCode.NoContent, HttpMethod.Post);
        await RequireStatus("pending", HttpStatusCode.NoContent);
        if (!bridge.Offer(fixture))
            throw new InvalidOperationException("Mesma key não foi ofertada novamente após confirmação.");
        using var next = JsonDocument.Parse(await client.GetStringAsync("pending"));
        if (next.RootElement.GetProperty("Id").GetString() == id)
            throw new InvalidOperationException("Nova entrega reutilizou o ID confirmado.");
        bridge.ClearIfAbsent([fixture]);
        await RequireStatus("pending", HttpStatusCode.OK);
        bridge.ClearIfAbsent([]);
        await RequireStatus("pending", HttpStatusCode.NoContent);
        Console.WriteLine("Bridge: autenticação, clipboard alterado, key exata, confirmação e limpeza passaram.");
    }
}
