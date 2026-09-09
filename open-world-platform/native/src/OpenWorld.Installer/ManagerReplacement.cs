using System.IO;
using System.Security.Cryptography;
using OpenWorld.Release;

namespace OpenWorld.Installer;

public static class ManagerReplacement
{
    public static string[] Targets(ReleaseCatalog catalog, IEnumerable<ReleaseManifest> selected,
        Func<ReleaseManifest, InstallLocations> resolve) =>
        selected.Select(world => resolve(world).ManagerPath)
            .Concat(catalog.Worlds.Select(world => resolve(world).ManagerPath).Where(File.Exists))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

    public static void ReplaceAndVerify(string source, string destination)
    {
        source = Path.GetFullPath(source);
        destination = Path.GetFullPath(destination);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        if (!source.Equals(destination, StringComparison.OrdinalIgnoreCase))
        {
            var stage = destination + ".installing-" + Guid.NewGuid().ToString("N");
            try
            {
                File.Copy(source, stage);
                Verify(source, stage);
                File.Move(stage, destination, overwrite: true);
            }
            finally { if (File.Exists(stage)) File.Delete(stage); }
        }
        Verify(source, destination);
    }

    public static void Verify(string source, string destination)
    {
        using var expected = File.OpenRead(source);
        using var installed = File.OpenRead(destination);
        if (!SHA256.HashData(expected).SequenceEqual(SHA256.HashData(installed)))
            throw new IOException("The installed manager does not match this setup. Run setup again to complete the update.");
    }
}
