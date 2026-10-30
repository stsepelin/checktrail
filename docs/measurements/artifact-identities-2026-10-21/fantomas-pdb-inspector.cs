using System.IO.Compression;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

if (args.Length != 2) throw new ArgumentException("Expected input and output directories");
var input = args[0];
var output = args[1];
var embeddedKind = new Guid("0E8A571B-6926-466E-B4AD-8AB04611F5FE");
var sourceLinkKind = new Guid("CC110556-A091-4D38-9FEC-25AB9A351A6A");
var optionsKind = new Guid("B5FEEC05-8CD0-4A83-96DA-466284BB4BD8");
var sha1Kind = new Guid("FF1816EC-AA5E-4D10-87F7-6F4963833460");
var sha256Kind = new Guid("8829D00F-11B8-4213-878B-770E8597AC16");
var reports = new List<object>();
var payloads = new Dictionary<string, byte[]>();
long totalEmbedded = 0;
static string Hex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();
foreach (var name in new[] { "FSharp.Core.dll", "Fantomas.Core.dll", "Fantomas.FCS.dll" })
{
    var dll = Path.Combine(input, name);
    using var pe = new PEReader(File.OpenRead(dll));
    var metadata = pe.GetMetadataReader();
    var references = metadata.AssemblyReferences.Select(handle =>
    {
        var value = metadata.GetAssemblyReference(handle);
        return new { name = metadata.GetString(value.Name), version = value.Version.ToString(), publicKeyOrToken = Hex(metadata.GetBlobBytes(value.PublicKeyOrToken)) };
    }).ToArray();
    using var stream = File.OpenRead(dll + ".pdb");
    if (stream.Length > 64 * 1024 * 1024) throw new InvalidDataException("PDB bound");
    using var provider = MetadataReaderProvider.FromPortablePdbStream(stream);
    var reader = provider.GetMetadataReader();
    if (reader.Documents.Count > 4096 || reader.CustomDebugInformation.Count > 100000) throw new InvalidDataException("Metadata row bound");
    var docs = new List<object>();
    foreach (var handle in reader.Documents)
    {
        var document = reader.GetDocument(handle);
        var documentName = reader.GetString(document.Name);
        var algorithm = reader.GetGuid(document.HashAlgorithm);
        var declaredHash = reader.GetBlobBytes(document.Hash);
        byte[]? embedded = null;
        foreach (var customHandle in reader.GetCustomDebugInformation(handle))
        {
            var custom = reader.GetCustomDebugInformation(customHandle);
            if (reader.GetGuid(custom.Kind) != embeddedKind) continue;
            if (embedded != null) throw new InvalidDataException("Duplicate embedded source");
            var blob = reader.GetBlobBytes(custom.Value);
            if (blob.Length < 4) throw new InvalidDataException("Short embedded source");
            var length = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(blob);
            if (length < 0 || length > 8 * 1024 * 1024) throw new InvalidDataException("Embedded source bound");
            if (length == 0) embedded = blob[4..];
            else
            {
                using var compressed = new MemoryStream(blob, 4, blob.Length - 4);
                using var deflate = new DeflateStream(compressed, CompressionMode.Decompress);
                using var decoded = new MemoryStream();
                var buffer = new byte[8192];
                for (int count; (count = deflate.Read(buffer, 0, buffer.Length)) != 0;)
                {
                    if (decoded.Length + count > length) throw new InvalidDataException("Embedded source exceeds declared length");
                    decoded.Write(buffer, 0, count);
                }
                if (decoded.Length != length) throw new InvalidDataException("Embedded source length mismatch");
                embedded = decoded.ToArray();
            }
            if (embedded.Length > 8 * 1024 * 1024) throw new InvalidDataException("Uncompressed source bound");
        }
        string? embeddedSha = null;
        bool? checksumMatches = null;
        if (embedded != null)
        {
            totalEmbedded += embedded.Length;
            if (totalEmbedded > 64 * 1024 * 1024) throw new InvalidDataException("Total embedded source bound");
            embeddedSha = Hex(SHA256.HashData(embedded));
            byte[]? computed = algorithm == sha1Kind ? SHA1.HashData(embedded) : algorithm == sha256Kind ? SHA256.HashData(embedded) : null;
            checksumMatches = computed == null ? null : computed.AsSpan().SequenceEqual(declaredHash);
            if (checksumMatches == false) throw new InvalidDataException("Native PDB document checksum mismatch");
            if (payloads.TryGetValue(embeddedSha, out var prior) && !prior.AsSpan().SequenceEqual(embedded)) throw new InvalidDataException("Content address collision");
            payloads[embeddedSha] = embedded;
        }
        docs.Add(new { row = MetadataTokens.GetRowNumber(handle), name = documentName, hashAlgorithm = algorithm.ToString(), declaredHash = Hex(declaredHash), embeddedBytes = embedded?.Length, embeddedSha256 = embeddedSha, embeddedDocumentChecksumMatches = checksumMatches });
    }
    var links = new List<string>();
    var options = new List<string>();
    foreach (var handle in reader.CustomDebugInformation)
    {
        var custom = reader.GetCustomDebugInformation(handle);
        var kind = reader.GetGuid(custom.Kind);
        if (kind != sourceLinkKind && kind != optionsKind) continue;
        var value = reader.GetBlobBytes(custom.Value);
        if (value.Length > 1024 * 1024) throw new InvalidDataException("Custom metadata bound");
        var text = new UTF8Encoding(false, true).GetString(value);
        if (kind == sourceLinkKind) links.Add(text); else options.Add(text);
    }
    reports.Add(new { assembly = name, mvid = metadata.GetGuid(metadata.GetModuleDefinition().Mvid).ToString(), references, documents = docs, sourceLinkJson = links, compilationOptionsRaw = options, targetAssemblyLoaded = false, targetAssemblyExecuted = false });
}
Directory.CreateDirectory(output);
Directory.CreateDirectory(Path.Combine(output, "sources"));
foreach (var pair in payloads)
{
    var file = Path.Combine(output, "sources", pair.Key + ".source");
    if (File.Exists(file)) throw new IOException("Output already exists");
}
var result = new { schemaVersion = 1, scope = "Standard metadata-reader inspection only; target assemblies are never loaded or executed.", artifacts = reports, totalEmbeddedBytes = totalEmbedded, distinctEmbeddedSourcePayloads = payloads.Count, sourceBuildVerified = false, gateAComplete = false };
var json = JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true });
if (File.Exists(Path.Combine(output, "metadata.json"))) throw new IOException("Metadata output already exists");
foreach (var pair in payloads) File.WriteAllBytes(Path.Combine(output, "sources", pair.Key + ".source"), pair.Value);
File.WriteAllText(Path.Combine(output, "metadata.json"), json + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { assemblies = reports.Count, embeddedSourcePayloads = payloads.Count, totalEmbeddedBytes = totalEmbedded, targetAssemblyExecuted = false }));
