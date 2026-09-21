export const dotnetCompilerSource = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

sealed class BoundedOutput : MemoryStream {
    const int Limit = 32 * 1024 * 1024;
    void Check(long length) { if (length > Limit) throw new IOException("Compiler output limit exceeded"); }
    public override void Write(byte[] buffer, int offset, int count) { Check(Position + count); base.Write(buffer, offset, count); }
    public override void Write(ReadOnlySpan<byte> buffer) { Check(Position + buffer.Length); base.Write(buffer); }
    public override void WriteByte(byte value) { Check(Position + 1); base.WriteByte(value); }
    public override void SetLength(long value) { Check(value); base.SetLength(value); }
}

class VerifierCompiler {
    static void Main(string[] args) {
        using var input = JsonDocument.Parse(File.ReadAllText(args[0], Encoding.UTF8));
        var root = input.RootElement;
        var config = root.GetProperty("config");
        var language = config.GetProperty("languageVersion").GetString() switch {
            "12" => LanguageVersion.CSharp12, "13" => LanguageVersion.CSharp13, "14" => LanguageVersion.CSharp14,
            _ => throw new InvalidOperationException("Unsupported language version")
        };
        var nullable = config.GetProperty("nullable").GetString() switch {
            "enable" => NullableContextOptions.Enable, "disable" => NullableContextOptions.Disable,
            "warnings" => NullableContextOptions.Warnings, "annotations" => NullableContextOptions.Annotations,
            _ => throw new InvalidOperationException("Unsupported nullable context")
        };
        var parseOptions = new CSharpParseOptions(language, DocumentationMode.Parse, SourceCodeKind.Regular,
            config.GetProperty("defines").EnumerateArray().Select(item => item.GetString()!));
        var trees = new List<SyntaxTree>();
        foreach (var file in root.GetProperty("sources").EnumerateArray()) {
            var name = file.GetString()!;
            var text = File.ReadAllText(name, new UTF8Encoding(false, true));
            trees.Add(CSharpSyntaxTree.ParseText(SourceText.From(text, Encoding.UTF8, SourceHashAlgorithm.Sha256), parseOptions, name));
        }
        var implicitUsings = config.GetProperty("implicitUsings").GetBoolean();
        if (implicitUsings) trees.Add(CSharpSyntaxTree.ParseText("global using System; global using System.Collections.Generic; global using System.IO; global using System.Linq; global using System.Net.Http; global using System.Threading; global using System.Threading.Tasks;", parseOptions, "repo-verifier://implicit-usings", Encoding.UTF8));
        var references = root.GetProperty("references").EnumerateArray().Select(item => {
            var file = item.GetString()!;
            using var stream = File.OpenRead(file);
            using var image = new PEReader(stream);
            if (!image.HasMetadata) throw new InvalidOperationException("Reference is not a managed assembly");
            var metadata = image.GetMetadataReader();
            if (!metadata.IsAssembly || metadata.AssemblyFiles.Count != 0)
                throw new InvalidOperationException("Multi-file assembly references are unsupported");
            return MetadataReference.CreateFromFile(file);
        }).ToArray();
        var options = new CSharpCompilationOptions(
            config.GetProperty("outputKind").GetString() == "console" ? OutputKind.ConsoleApplication : OutputKind.DynamicallyLinkedLibrary,
            optimizationLevel: OptimizationLevel.Release, checkOverflow: config.GetProperty("checkedArithmetic").GetBoolean(),
            allowUnsafe: config.GetProperty("allowUnsafe").GetBoolean(), warningLevel: 9999,
            generalDiagnosticOption: config.GetProperty("warningsAsErrors").GetBoolean() ? ReportDiagnostic.Error : ReportDiagnostic.Default,
            concurrentBuild: false, deterministic: true, nullableContextOptions: nullable, reportSuppressedDiagnostics: true);
        var compilation = CSharpCompilation.Create(config.GetProperty("assemblyName").GetString()!, trees, references, options);
        var sources = new List<object>();
        foreach (var tree in trees.Where(tree => tree.FilePath != "repo-verifier://implicit-usings")) {
            var syntax = tree.GetRoot();
            var model = compilation.GetSemanticModel(tree);
            var diagnostics = model.GetDiagnostics();
            if (diagnostics.Length > 2000) throw new InvalidOperationException("Diagnostic limit exceeded");
            sources.Add(new {file = tree.FilePath, syntaxLength = syntax.FullSpan.Length, textLength = tree.GetText().Length,
                semantic = model.SyntaxTree == tree, semanticDiagnosticCount = diagnostics.Length});
        }
        using var output = new BoundedOutput();
        var result = compilation.Emit(output);
        if (result.Diagnostics.Length > 2000) throw new InvalidOperationException("Diagnostic limit exceeded");
        var messages = result.Diagnostics.Select(item => {
            var line = item.Location.IsInSource ? item.Location.GetLineSpan() : default;
            return new {code = item.Id, severity = item.Severity.ToString(), message = item.GetMessage(System.Globalization.CultureInfo.InvariantCulture),
                suppressed = item.IsSuppressed, file = item.Location.IsInSource ? item.Location.SourceTree?.FilePath : null,
                line = item.Location.IsInSource ? line.StartLinePosition.Line + 1 : 0};
        }).ToArray();
        Console.Write(JsonSerializer.Serialize(new {version = 1, compiler = typeof(CSharpCompilation).Assembly.GetName().Version!.ToString(),
            runtime = Environment.Version.ToString(), success = result.Success, outputBytes = output.Length,
            ownedTreeCount = implicitUsings ? 1 : 0, referenceCount = references.Length, settings = config, sources, diagnostics = messages}));
    }
}
`;
