// Original observer compiled against the selected SDK. All proposed changes stay in memory.
export const dotnetFormatExtensionsNativeSource = String.raw`
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

class ChecktrailFormattingExtensions {
 static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
 static string TextHash(string value) => Hash(Encoding.UTF8.GetBytes(value));
 static void Marker(string file, object value) {
  var pending=file+".pending";
  File.WriteAllText(pending,JsonSerializer.Serialize(value),new UTF8Encoding(false));
  File.Move(pending,file);
 }
 static async Task Main(string[] args) {
  var sdk=args[0];var tools=Path.Combine(sdk,"DotnetTools/dotnet-format");
  AssemblyLoadContext.Default.Resolving+=(context,name)=>{
   foreach(var directory in new[]{tools,Path.Combine(tools,"BuildHost-netcore"),sdk}) {
    var file=Path.Combine(directory,name.Name+".dll");
    if(File.Exists(file))return context.LoadFromAssemblyPath(file);
   }
   return null;
  };
  await Inspect(args);
 }
 static async Task Inspect(string[] args) {
  var sdk=args[0];var request=JsonDocument.Parse(File.ReadAllText(args[1])).RootElement;
  var solutionFile=request.GetProperty("solution").GetString();
  var marker=args[2];var firstMarker=args[3];
  var selected=request.GetProperty("sources").EnumerateArray().Select(x=>x.GetString()).ToHashSet(StringComparer.Ordinal);
  var styles=request.GetProperty("styleDiagnostics").EnumerateArray().Select(x=>x.GetString()).ToImmutableHashSet(StringComparer.Ordinal);
  var analyzersSelected=request.GetProperty("analyzerDiagnostics").EnumerateArray().Select(x=>x.GetString()).ToImmutableHashSet(StringComparer.Ordinal);
  var severity=Enum.Parse<DiagnosticSeverity>(request.GetProperty("severity").GetString());
  var tools=Path.Combine(sdk,"DotnetTools/dotnet-format");
  var assembly=AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(tools,"dotnet-format.dll"));
  var optionsType=assembly.GetType("Microsoft.CodeAnalysis.Tools.FormatOptions",true);
  var categoryType=assembly.GetType("Microsoft.CodeAnalysis.Tools.FixCategory",true);
  var workspaceType=assembly.GetType("Microsoft.CodeAnalysis.Tools.WorkspaceType",true);
  var matcherType=assembly.GetType("Microsoft.CodeAnalysis.Tools.Utilities.SourceFileMatcher",true);
  var rowType=assembly.GetType("Microsoft.CodeAnalysis.Tools.FormattedFile",true);
  var formatterType=assembly.GetType("Microsoft.CodeAnalysis.Tools.CodeFormatter",true);
  var ctor=optionsType.GetConstructors(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance).Single(c=>c.GetParameters().Length==15);
  var names=new[]{"WorkspaceFilePath","WorkspaceType","NoRestore","LogLevel","FixCategory","CodeStyleSeverity","AnalyzerSeverity","Diagnostics","ExcludeDiagnostics","SaveFormattedFiles","ChangesAreErrors","FileMatcher","ReportPath","BinaryLogPath","IncludeGeneratedFiles"};
  if(!ctor.GetParameters().Select(p=>p.Name).SequenceEqual(names))throw new InvalidOperationException("Selected formatter constructor contract");
  var method=formatterType.GetMethod("RunCodeFormattersAsync",BindingFlags.NonPublic|BindingFlags.Static);
  if(method==null || method.ReturnType!=typeof(Task<Solution>) || method.GetParameters().Length!=7)throw new InvalidOperationException("Selected formatter method contract");
  MSBuildLocator.RegisterMSBuildPath(sdk);
  using var workspace=MSBuildWorkspace.Create(new Dictionary<string,string>{{"Configuration","Debug"},{"TargetFramework","net10.0"},{"RestorePackagesPath",request.GetProperty("repository").GetString()},{"BuildInParallel","false"},{"UseSharedCompilation","false"},{"EmitCompilerGeneratedFiles","true"},{"CompilerGeneratedFilesOutputPath","obj/Debug/net10.0/generated"}});
  Marker(marker,new{phase="sdk-formatting-observer-body",processId=Environment.ProcessId,runtime=Environment.Version.ToString()});
  await workspace.OpenSolutionAsync(solutionFile);
  var initial=workspace.CurrentSolution;
  var all=new List<Document>();var generatedIds=new HashSet<DocumentId>();
  foreach(var project in initial.Projects) {
   all.AddRange(project.Documents);
   foreach(var doc in await project.GetSourceGeneratedDocumentsAsync()) { all.Add(doc);generatedIds.Add(doc.Id); }
  }
  if(all.Count==0 || all.Count>4096)throw new InvalidOperationException("Native document count");
  var beforeTexts=new Dictionary<DocumentId,SourceText>();var sourceBytes=new Dictionary<DocumentId,byte[]>();
  foreach(var doc in all) {
   if(doc.FilePath==null || !File.Exists(doc.FilePath))throw new InvalidOperationException("Native physical document required");
   var bytes=File.ReadAllBytes(doc.FilePath);var before=await doc.GetTextAsync();
   if(bytes.Length>65536 || before.Length>65536)throw new InvalidOperationException("Native document size");
   sourceBytes.Add(doc.Id,bytes);beforeTexts.Add(doc.Id,before);
  }
  var ordinary=all.Where(d=>!generatedIds.Contains(d.Id)&&selected.Contains(d.FilePath)).ToArray();
  var ids=ordinary.Select(d=>d.Id).ToImmutableArray();
  var phases=new List<object>();var completedFirst=false;
  foreach(var mode in new[]{"Whitespace","CodeStyle","Analyzers"}) {
   var wanted=mode=="CodeStyle"?styles:mode=="Analyzers"?analyzersSelected:ImmutableHashSet<string>.Empty;
   var matcher=matcherType.GetMethod("CreateMatcher",BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new object[]{ordinary.Select(d=>d.FilePath).ToArray(),Array.Empty<string>()});
   var values=new object[]{solutionFile,Enum.Parse(workspaceType,"Solution"),true,LogLevel.Trace,Enum.Parse(categoryType,mode),severity,severity,wanted,ImmutableHashSet<string>.Empty,true,false,matcher,null,null,true};
   var options=ctor.Invoke(values);var reports=Activator.CreateInstance(typeof(List<>).MakeGenericType(rowType));
   var catalog=new List<object>();var diagnostics=new List<object>();var exceptions=new List<string>();
   if(mode!="Whitespace") {
    var providerType=assembly.GetType("Microsoft.CodeAnalysis.Tools.Analyzers."+(mode=="CodeStyle"?"CodeStyleInformationProvider":"AnalyzerReferenceInformationProvider"),true);
    var provider=Activator.CreateInstance(providerType,true);
    var inventory=(IEnumerable)providerType.GetMethod("GetAnalyzersAndFixers",BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance).Invoke(provider,new object[]{workspace,initial,options,NullLogger.Instance});
    foreach(var pair in inventory) {
     var type=pair.GetType();var key=(ProjectId)type.GetProperty("Key").GetValue(pair);var value=type.GetProperty("Value").GetValue(pair);
     var project=initial.GetProject(key);
     var analyzers=((IEnumerable)value.GetType().GetProperty("Analyzers").GetValue(value)).Cast<DiagnosticAnalyzer>().ToArray();
     var chosen=analyzers.Where(an=>an is DiagnosticSuppressor || an.SupportedDiagnostics.Any(d=>wanted.Contains(d.Id))).ToImmutableArray();
     catalog.Add(new{project=project.FilePath,projectId=project.Id.Id,language=project.Language,
      supported=analyzers.SelectMany(an=>an.SupportedDiagnostics).Select(d=>d.Id).Distinct().OrderBy(x=>x,StringComparer.Ordinal).ToArray(),
      selectedAnalyzers=chosen.Select(an=>new{name=an.GetType().FullName,assembly=an.GetType().Assembly.Location}).ToArray()});
     if(chosen.IsEmpty)continue;
     var analysisOptions=new CompilationWithAnalyzersOptions(project.AnalyzerOptions,(error,an,diagnostic)=>exceptions.Add(error.GetType().FullName+":"+error.Message),false,false,false);
     var compilation=await project.GetCompilationAsync();
     var analysis=DiagnosticAnalyzerExtensions.WithAnalyzers(compilation,chosen,analysisOptions);
     foreach(var diagnostic in (await analysis.GetAnalyzerDiagnosticsAsync()).Where(d=>wanted.Contains(d.Id)&&!d.IsSuppressed&&d.Severity>=severity)) {
      var tree=diagnostic.Location.SourceTree;
      var doc=tree==null?null:all.SingleOrDefault(d=>d.Project.Id==project.Id && d.FilePath==tree.FilePath);
      var physical=diagnostic.Location.GetLineSpan();var mapped=diagnostic.Location.GetMappedLineSpan();
      diagnostics.Add(new{id=diagnostic.Id,severity=diagnostic.Severity.ToString(),message=diagnostic.GetMessage(),project=project.FilePath,projectId=project.Id.Id,
       file=doc?.FilePath,documentId=doc?.Id.Id,locationKind=diagnostic.Location.Kind.ToString(),start=diagnostic.Location.SourceSpan.Start,length=diagnostic.Location.SourceSpan.Length,
       physical=new{file=physical.Path,startLine=physical.StartLinePosition.Line+1,startColumn=physical.StartLinePosition.Character+1,endLine=physical.EndLinePosition.Line+1,endColumn=physical.EndLinePosition.Character+1},
       mapped=new{file=mapped.Path,startLine=mapped.StartLinePosition.Line+1,startColumn=mapped.StartLinePosition.Character+1,endLine=mapped.EndLinePosition.Line+1,endColumn=mapped.EndLinePosition.Character+1},
       sourceTextSha256=doc==null?null:TextHash(beforeTexts[doc.Id].ToString())});
     }
    }
   }
   var formatted=await (Task<Solution>)method.Invoke(null,new object[]{workspace,initial,ids,options,NullLogger.Instance,reports,CancellationToken.None});
   var documents=new List<object>();
   foreach(var doc in all) {
    var before=beforeTexts[doc.Id];var bytes=sourceBytes[doc.Id];var generated=generatedIds.Contains(doc.Id);var picked=selected.Contains(doc.FilePath);
    Document result=generated ? doc : formatted.GetDocument(doc.Id);
    var route="sdk-pipeline";
    if(generated) {
     route=mode=="Whitespace"&&picked?"native-generated-whitespace":"native-generated-diagnostics";
     if(mode=="Whitespace"&&picked)result=await Formatter.FormatAsync(doc);
    }
    var tree=await doc.GetSyntaxTreeAsync();
    var lineMappings=tree.GetLineMappings().Select(mapping=>new{
     span=new{startLine=mapping.Span.Start.Line+1,startColumn=mapping.Span.Start.Character+1,endLine=mapping.Span.End.Line+1,endColumn=mapping.Span.End.Character+1},
     characterOffset=mapping.CharacterOffset,
     mapped=mapping.MappedSpan.IsValid?new{file=mapping.MappedSpan.Path,startLine=mapping.MappedSpan.StartLinePosition.Line+1,startColumn=mapping.MappedSpan.StartLinePosition.Character+1,endLine=mapping.MappedSpan.EndLinePosition.Line+1,endColumn=mapping.MappedSpan.EndLinePosition.Character+1}:null,
     mappedValid=mapping.MappedSpan.IsValid,hasMappedPath=mapping.MappedSpan.HasMappedPath,
     pdbFile=mapping.MappedSpan.HasMappedPath?Path.GetFullPath(mapping.MappedSpan.Path,Path.GetDirectoryName(doc.Project.FilePath)):null}).ToArray();
    if(lineMappings.Length>4096)throw new InvalidOperationException("Native line mapping bound");
    var after=await result.GetTextAsync();var changes=(await result.GetTextChangesAsync(doc)).ToArray();
    if(changes.Length>4096 || after.Length>131072)throw new InvalidOperationException("Native edit bounds");
    documents.Add(new{project=doc.Project.FilePath,projectId=doc.Project.Id.Id,language=doc.Project.Language,file=doc.FilePath,documentId=doc.Id.Id,
     selected=picked,sourceGenerated=generated,route,lineMappings,sourceBytes=bytes.Length,sourceSha256=Hash(bytes),utf8Bom=bytes.Length>=3&&bytes[0]==239&&bytes[1]==187&&bytes[2]==191,
     before=before.ToString(),after=after.ToString(),beforeSha256=TextHash(before.ToString()),afterSha256=TextHash(after.ToString()),changed=!before.ContentEquals(after),
     changes=changes.Select(change=>new{start=change.Span.Start,length=change.Span.Length,newText=change.NewText,line=before.Lines.GetLinePosition(change.Span.Start).Line+1,column=before.Lines.GetLinePosition(change.Span.Start).Character+1}).ToArray()});
    if(!completedFirst&&picked) {completedFirst=true;Marker(firstMarker,new{phase="sdk-formatting-first-document-completed",processId=Environment.ProcessId,mode,file=doc.FilePath,sourceSha256=Hash(bytes),beforeSha256=TextHash(before.ToString())});}
   }
   phases.Add(new{mode,nativeFormattingInvoked=true,nativeDiagnosticsInvoked=mode!="Whitespace",catalog,diagnostics,analyzerExceptions=exceptions,documents,
    sdkReport=JsonSerializer.SerializeToElement(reports,reports.GetType()),sdkReportScope="ordinary-selected-diagnostics-and-document-whitespace-summaries",generatedSemanticFixesSupported=false});
  }
  if(!completedFirst)throw new InvalidOperationException("No selected native document reached formatting");
  var loaded=AppDomain.CurrentDomain.GetAssemblies().Where(a=>!a.IsDynamic).Select(a=>new{name=a.GetName().Name,version=a.GetName().Version.ToString(),file=a.Location,sha256=Hash(File.ReadAllBytes(a.Location))}).ToArray();
  var observation=JsonSerializer.Serialize(new{processId=Environment.ProcessId,runtime=Environment.Version.ToString(),helperSha256=Hash(File.ReadAllBytes(typeof(ChecktrailFormattingExtensions).Assembly.Location)),
   formatterAssembly=assembly.Location,formatterSha256=Hash(File.ReadAllBytes(assembly.Location)),constructorParameters=names,workspaceFailures=workspace.Diagnostics.Select(d=>d.Kind+":"+d.Message).ToArray(),
   allDocuments=all.Count,loaded,phases,complete=true});
  var phaseCounts=JsonSerializer.SerializeToElement(phases).EnumerateArray().Select(p=>new{
   mode=p.GetProperty("mode").GetString(),documents=p.GetProperty("documents").GetArrayLength(),
   diagnostics=p.GetProperty("diagnostics").GetArrayLength(),reportRows=p.GetProperty("sdkReport").GetArrayLength(),
   changedDocuments=p.GetProperty("documents").EnumerateArray().Count(d=>d.GetProperty("changed").GetBoolean())}).ToArray();
  Marker(args[4],new{phase="sdk-formatting-observer-completed",processId=Environment.ProcessId,
   helperSha256=Hash(File.ReadAllBytes(typeof(ChecktrailFormattingExtensions).Assembly.Location)),
   observationSha256=TextHash(observation),allDocuments=all.Count,phases=phaseCounts});
  Console.Write(observation);
 }
}
`;
