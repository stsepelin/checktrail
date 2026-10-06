// Original observer compiled against the selected SDK; does not apply project edits.
export const dotnetFormatNativeSource = String.raw`
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Runtime.Loader;
using System.Threading.Tasks;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Formatting;
class ChecktrailFormatObserver {
 static string Hash(string value)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
 static async Task Main(string[] args) {
  var tools=Path.Combine(args[0],"DotnetTools/dotnet-format");
  AssemblyLoadContext.Default.Resolving+=(context,name)=>{var file=Path.Combine(tools,name.Name+".dll");if(!File.Exists(file))file=Path.Combine(tools,"BuildHost-netcore",name.Name+".dll");return File.Exists(file)?context.LoadFromAssemblyPath(file):null;};
  await Inspect(args);
 }
 static async Task Inspect(string[] args) {
  var request=JsonDocument.Parse(File.ReadAllText(args[2])).RootElement;
  MSBuildLocator.RegisterMSBuildPath(args[0]);
  using var workspace=MSBuildWorkspace.Create(new Dictionary<string,string>{{"Configuration","Debug"},{"TargetFramework","net10.0"},{"RestorePackagesPath",args[1]},{"BuildInParallel","false"},{"UseSharedCompilation","false"}});
  
  var requested=request.GetProperty("projects").EnumerateArray().Select(p=>p.GetString()).ToArray();
  foreach(var file in requested)if(!workspace.CurrentSolution.Projects.Any(p=>p.FilePath==file))await workspace.OpenProjectAsync(file);
  var selected=new HashSet<string>(request.GetProperty("sources").EnumerateArray().Select(p=>p.GetString()));
  var projects=new List<object>();var count=0;
  foreach(var project in workspace.CurrentSolution.Projects) {
   var rows=new List<object>();
   foreach(var doc in project.Documents) {
    if(++count>4096)throw new InvalidOperationException("Document count bound");
    var sourceBytes=File.ReadAllBytes(doc.FilePath);var before=await doc.GetTextAsync();if(before.Length>65536)throw new InvalidOperationException("Document text bound");
    var formatted=await Formatter.FormatAsync(doc);var after=await formatted.GetTextAsync();var changes=(await formatted.GetTextChangesAsync(doc)).ToArray();if(changes.Length>4096)throw new InvalidOperationException("Edit count bound");
    var options=await doc.GetOptionsAsync();
    rows.Add(new{file=doc.FilePath,documentId=doc.Id.Id,sourceBytes=sourceBytes.Length,sourceSha256=Convert.ToHexString(SHA256.HashData(sourceBytes)).ToLowerInvariant(),utf8Bom=sourceBytes.Length>=3&&sourceBytes[0]==239&&sourceBytes[1]==187&&sourceBytes[2]==191,selected=selected.Contains(doc.FilePath),text=selected.Contains(doc.FilePath)?before.ToString():null,
     formatting=new{tabSize=options.GetOption(FormattingOptions.TabSize,project.Language),indentationSize=options.GetOption(FormattingOptions.IndentationSize,project.Language),useTabs=options.GetOption(FormattingOptions.UseTabs,project.Language),newLine=options.GetOption(FormattingOptions.NewLine,project.Language)},
     changes=changes.Select(c=>new{start=c.Span.Start,length=c.Span.Length,newText=c.NewText,line=before.Lines.GetLinePosition(c.Span.Start).Line+1,column=before.Lines.GetLinePosition(c.Span.Start).Character+1}).ToArray(),
     beforeSha256=Hash(before.ToString()),afterSha256=Hash(after.ToString()),changed=!before.ContentEquals(after)});
   }
   projects.Add(new{file=project.FilePath,projectId=project.Id.Id,language=project.Language,documents=rows});
  }
  Console.Write(JsonSerializer.Serialize(new{processId=Environment.ProcessId,runtime=Environment.Version.ToString(),helperSha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(ChecktrailFormatObserver).Assembly.Location))).ToLowerInvariant(),workspaceAssembly=typeof(MSBuildWorkspace).Assembly.Location,formatterAssembly=typeof(Formatter).Assembly.Location,failures=workspace.Diagnostics.Select(d=>d.Kind+":"+d.Message).ToArray(),projects,complete=true}));
 }
}
`;
