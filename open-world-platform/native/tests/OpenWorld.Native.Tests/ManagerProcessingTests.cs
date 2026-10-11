
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using OpenWorld.TileServer;



public static class ManagerProcessingTests
{
    public static async Task Run(byte[] archive)
    {
        var root = Path.Combine(Path.GetTempPath(), "open-world-processing-tests", Guid.NewGuid().ToString("N"));
        var state = Path.Combine(root, "state");
        var tile = Path.Combine(root, "tiles", "TEST_A");
        Directory.CreateDirectory(tile);
        await File.WriteAllBytesAsync(Path.Combine(tile, "tiles.pmtiles"), archive);
        var settings = new ProcessingSettingsStore(state);
        Check(!settings.Snapshot().DemandEnabled && !settings.Snapshot().SavesEnabled && !settings.Snapshot().StationNamingEnabled, "Default choices must all be off.");
        settings.Set(new(true, true, true));
        Check(new ProcessingSettingsStore(state).Snapshot() == new ProcessingSettings(true,true,true), "Choices did not survive restart.");
        settings.Set(new());
        using var reservation = new TcpListener(IPAddress.Loopback, 0);
        reservation.Start(); var port = ((IPEndPoint)reservation.LocalEndpoint).Port; reservation.Stop();
        var start = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "open-world-tile-server.exe"))
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var value in new[] { "serve", "--root", Path.Combine(root, "tiles"), "--port", port.ToString(), "--state-root", state, "--log-root", Path.Combine(root,"logs") })
            start.ArgumentList.Add(value);
        using var server = Process.Start(start)!;
        server.OutputDataReceived += (_, _) => { }; server.ErrorDataReceived += (_, _) => { };
        server.BeginOutputReadLine(); server.BeginErrorReadLine();
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}"), Timeout = TimeSpan.FromSeconds(15) };
        try
        {
            string? token = null;
            for (var tries=0; tries<100 && token is null; tries++)
            {
                if(server.HasExited) throw new InvalidOperationException("Test server exited before health check.");
                try { using var health=await client.GetAsync("/_health"); if(health.IsSuccessStatusCode) token=health.Headers.GetValues("X-PMTiles-Server-Instance").Single(); }
                catch(HttpRequestException) { }
                if(token is null) await Task.Delay(100);
            }
            Check(token is not null,"Server did not start.");
            async Task<HttpResponseMessage> Post(string path,string body,string? origin=null,bool control=false)
            {
                using var request=new HttpRequestMessage(HttpMethod.Post,path);
                if(origin is not null)request.Headers.Add("Origin",origin);
                if(control)request.Headers.Add("X-PMTiles-Control-Token",token);
                request.Content=new StringContent(body,Encoding.UTF8,"application/json");
                return await client.SendAsync(request);
            }
            var flags="""{"demandEnabled":true,"savesEnabled":true,"stationNamingEnabled":true}""";
            using(var rejected=await Post("/_control/processing",flags,"null"))Check(rejected.StatusCode==HttpStatusCode.Forbidden,"Game could change manager choices.");
            using(var enabled=await Post("/_control/processing",flags,control:true))Check(enabled.IsSuccessStatusCode,await enabled.Content.ReadAsStringAsync());
            using(var discovered=JsonDocument.Parse(await client.GetStringAsync("/_processing/settings")))
                Check(discovered.RootElement.GetProperty("demandAvailable").GetBoolean(),"Packaged helper was missing.");
            var requestBody="""{"version":"manager-processing-v1","kind":"native-demand","cacheMode":"assignments","input":{"tileId":"TEST_A","worldId":"test","includeAssignments":true,"networkProfile":{"tileId":"TEST_A","stations":[],"routes":[],"trains":[]},"farePolicy":{"fare":2}}}""";
            using(var rejected=await Post("/_processing/demand/begin",requestBody,"https://example.com"))Check(rejected.StatusCode==HttpStatusCode.Forbidden,"Untrusted origin could run work.");
            string id;
            using(var begun=await Post("/_processing/demand/begin",requestBody))
            { Check(begun.IsSuccessStatusCode,await begun.Content.ReadAsStringAsync()); using var json=JsonDocument.Parse(await begun.Content.ReadAsStringAsync());id=json.RootElement.GetProperty("id").GetString()!; }
            using(var bad=await Post($"/_processing/demand/{id}/chunk/1","{}","null"))Check(bad.StatusCode==HttpStatusCode.BadRequest,"Out-of-order upload was accepted.");
            using(var begun=await Post("/_processing/demand/begin",requestBody,"null"))
            {using var json=JsonDocument.Parse(await begun.Content.ReadAsStringAsync());id=json.RootElement.GetProperty("id").GetString()!;}
            const string demand="""{"points":[{"id":"h","location":[0,0]},{"id":"w","location":[0.1,0]}],"pops":[{"id":"p","size":100,"residenceId":"h","jobId":"w","drivingSeconds":3600,"drivingDistance":25000}]}""";
            using(var upload=await Post($"/_processing/demand/{id}/chunk/0",demand,"null"))Check(upload.IsSuccessStatusCode,"Upload failed.");
            using(var run=await Post($"/_processing/demand/{id}/run","{}","null"))
            {
                var output=await run.Content.ReadAsStringAsync();
                Check(run.IsSuccessStatusCode && output.Contains("\"type\":\"complete\""),output);
                using var first=JsonDocument.Parse(output.Split('\n')[0]);
                var pid=first.RootElement.GetProperty("pid").GetInt32();
                Check(pid!=server.Id && pid!=Environment.ProcessId,"Routing ran in the server or client heap.");
                Check(output.Contains("\"assignments\":[{"),"Assignments were not streamed.");
            }
            Check(Directory.GetDirectories(Path.Combine(state,"processing-jobs")).All(path=>Path.GetFileName(path)=="cache"),"Completed job files survived.");
            using(var begun=await Post("/_processing/demand/begin",requestBody,"null"))
            {using var json=JsonDocument.Parse(await begun.Content.ReadAsStringAsync());id=json.RootElement.GetProperty("id").GetString()!;}
            using(var aborted=await Post($"/_processing/demand/{id}/abort","{}","null"))Check(aborted.IsSuccessStatusCode,"Cancellation failed.");
            Check(!Directory.Exists(Path.Combine(state,"processing-jobs",id)),"Cancelled upload survived.");
            using(var disabled=await Post("/_control/processing","""{"demandEnabled":false,"savesEnabled":false,"stationNamingEnabled":false}""",control:true))Check(disabled.IsSuccessStatusCode,"Could not switch processing off.");
            using(var rejected=await Post("/_processing/demand/begin",requestBody,"null"))Check(rejected.StatusCode==HttpStatusCode.BadRequest,"Disabled service accepted a job.");
        }
        finally
        {
            if(!server.HasExited){server.Kill(entireProcessTree:true);await server.WaitForExitAsync();}
            if (!Path.GetFullPath(root).StartsWith(Path.Combine(Path.GetTempPath(),"open-world-processing-tests")+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Unsafe test cleanup.");
            Directory.Delete(root,true);
        }
    }
    private static void Check(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
}
