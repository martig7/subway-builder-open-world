using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace OpenWorld.Release;

public static class ReleaseSignature
{
    public static void Verify(byte[] manifestBytes, byte[] signature, X509Certificate2 certificate, string expectedThumbprint)
    {
        var normalizedExpected = NormalizeThumbprint(expectedThumbprint);
        var actual = NormalizeThumbprint(certificate.Thumbprint);
        if (!actual.Equals(normalizedExpected, StringComparison.Ordinal))
            throw new CryptographicException($"Release certificate thumbprint {actual} does not match the embedded publisher thumbprint.");

        using var rsa = certificate.GetRSAPublicKey() ?? throw new CryptographicException("Release certificate does not contain an RSA public key.");
        if (!rsa.VerifyData(manifestBytes, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
            throw new CryptographicException("Release manifest signature is invalid.");
    }

    private static string NormalizeThumbprint(string? value) =>
        string.Concat((value ?? string.Empty).Where(Uri.IsHexDigit)).ToUpperInvariant();
}
