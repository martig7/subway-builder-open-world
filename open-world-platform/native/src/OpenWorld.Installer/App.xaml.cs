using System.IO;
using System.Reflection;
using System.Security.Cryptography.X509Certificates;
using System.Windows;
using OpenWorld.Release;

namespace OpenWorld.Installer;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        try
        {
            var bundle = ReleaseBundle.Load(e.Args);
            var window = new MainWindow(bundle.Manifest, bundle.IsPreview);
            var snapshotPath = ArgumentValue(e.Args, "--snapshot");
            var progressSnapshot = e.Args.Any(value => value.Equals("--snapshot-progress", StringComparison.OrdinalIgnoreCase));
            if (snapshotPath is not null)
            {
                window.ContentRendered += async (_, _) =>
                {
                    if (progressSnapshot)
                    {
                        window.ShowProgressSnapshot();
                        await Task.Delay(120);
                        await window.Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.Render);
                    }
                    window.SaveSnapshot(snapshotPath);
                    window.Close();
                };
            }
            window.Show();
        }
        catch (Exception exception)
        {
            MessageBox.Show(exception.Message, "NEC Open World setup", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    private static string? ArgumentValue(string[] arguments, string name)
    {
        var index = Array.FindIndex(arguments, value => value.Equals(name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < arguments.Length ? arguments[index + 1] : null;
    }
}

internal sealed record ReleaseBundle(ReleaseManifest Manifest, bool IsPreview)
{
    public static ReleaseBundle Load(string[] arguments)
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var embeddedManifest = assembly.GetManifestResourceStream("release-manifest.json");
        byte[] manifestBytes;
        byte[] signature;
        byte[] certificateBytes;
        if (embeddedManifest is not null)
        {
            manifestBytes = ReadAll(embeddedManifest);
            using var signatureStream = assembly.GetManifestResourceStream("release-manifest.json.sig")
                ?? throw new InvalidDataException("The embedded release signature is missing.");
            signature = Convert.FromBase64String(System.Text.Encoding.ASCII.GetString(ReadAll(signatureStream)).Trim());
            using var certificateStream = assembly.GetManifestResourceStream("publisher.cer")
                ?? throw new InvalidDataException("The embedded publisher certificate is missing.");
            certificateBytes = ReadAll(certificateStream);
        }
        else if (Value(arguments, "--manifest") is { } manifestPath)
        {
            var signaturePath = Value(arguments, "--signature") ?? manifestPath + ".sig";
            var certificatePath = Value(arguments, "--certificate") ?? Path.Combine(Path.GetDirectoryName(manifestPath)!, "publisher.cer");
            if (!File.Exists(signaturePath)) throw new InvalidDataException($"Release signature is missing: {signaturePath}");
            if (!File.Exists(certificatePath)) throw new InvalidDataException($"Publisher certificate is missing: {certificatePath}");
            manifestBytes = File.ReadAllBytes(manifestPath);
            signature = Convert.FromBase64String(File.ReadAllText(signaturePath).Trim());
            certificateBytes = File.ReadAllBytes(certificatePath);
        }
        else
        {
            return new ReleaseBundle(DevelopmentManifest.Create(), true);
        }

#pragma warning disable SYSLIB0057
        using var certificate = new X509Certificate2(certificateBytes);
#pragma warning restore SYSLIB0057
        ReleaseSignature.Verify(manifestBytes, signature, certificate, certificate.Thumbprint);
        return new ReleaseBundle(ReleaseManifest.Parse(System.Text.Encoding.UTF8.GetString(manifestBytes)), false);
    }

    private static byte[] ReadAll(Stream stream)
    {
        using var output = new MemoryStream();
        stream.CopyTo(output);
        return output.ToArray();
    }

    private static string? Value(string[] arguments, string name)
    {
        var index = Array.FindIndex(arguments, value => value.Equals(name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < arguments.Length ? arguments[index + 1] : null;
    }
}
