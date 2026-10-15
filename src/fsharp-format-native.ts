// Original source-string formatter observer; never loads or evaluates a project.
export const fsharpFormatNativeSource = String.raw`
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Text.Json;
using System.Security.Cryptography;
using System.Collections.Generic;
using Fantomas.Core;
using Microsoft.FSharp.Control;
class ChecktrailFsharpFormatter {
 static string Hash(byte[] bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
 static string TextHash(string text)=>Hash(new UTF8Encoding(false,true).GetBytes(text));
 static object Diagnostic(Fantomas.FCS.Parse.FSharpParserDiagnostic d)=>new{severity=d.Severity.ToString(),subcategory=d.SubCategory,code=d.ErrorNumber==null?(int?)null:d.ErrorNumber.Value,message=d.Message,range=d.Range==null?null:new{file=d.Range.Value.FileName,startLine=d.Range.Value.StartLine,startColumn=d.Range.Value.StartColumn,endLine=d.Range.Value.EndLine,endColumn=d.Range.Value.EndColumn}};
 static void Main(string[] args) {
  var request=JsonDocument.Parse(File.ReadAllBytes(args[0])).RootElement;
  var documents=request.GetProperty("documents").EnumerateArray().ToArray();
  if(documents.Length<1||documents.Length>128)throw new InvalidOperationException("Document count bound");
  var ids=new HashSet<string>();var rows=new List<object>();
  var started=new{processId=Environment.ProcessId,phase="formatter-observer-body",runtime=Environment.Version.ToString(),fantomas=typeof(CodeFormatter).Assembly.GetName().Version.ToString()};
  File.WriteAllText(args[1]+".pending",JsonSerializer.Serialize(started));
  File.Move(args[1]+".pending",args[1]);
  foreach(var document in documents) {
   var file=document.GetProperty("file").GetString();
   if(!ids.Add(file))throw new InvalidOperationException("Duplicate document");
   var bytes=File.ReadAllBytes(file);
   if(bytes.Length>65536)throw new InvalidOperationException("Document byte bound");
   var bom=bytes.Length>=3&&bytes[0]==239&&bytes[1]==187&&bytes[2]==191;
   var before=new UTF8Encoding(false,true).GetString(bytes,bom?3:0,bytes.Length-(bom?3:0));
   var signature=document.GetProperty("signature").GetBoolean();
   var validation=FSharpAsync.RunSynchronously(CodeFormatter.ValidateFSharpCodeAsync(signature,before),null,null);
   var diagnostics=validation.Diagnostics.Select(Diagnostic).ToArray();
   if(diagnostics.Length>1024)throw new InvalidOperationException("Diagnostic count bound");
   string after=null;object error=null;
   // Validation exposes intolerant diagnostics from only the first failing define combination.
   // Always attempt native formatting as well, retaining its complete exception and combination list.
   try {after=FSharpAsync.RunSynchronously(CodeFormatter.FormatDocumentAsync(signature,before),null,null).Code;}
   catch(ParseException e){error=new{kind="parse",type=e.GetType().FullName,message=e.Message,combinations=Array.Empty<string>(),diagnostics=e.Diagnostics.Select(Diagnostic).ToArray()};}
   catch(DefineParseException e){error=new{kind="define-parse",type=e.GetType().FullName,message=e.Message,combinations=e.Combinations.ToArray(),diagnostics=Array.Empty<object>()};}
   catch(Fantomas.Core.FormatException e){error=new{kind="format",type=e.GetType().FullName,message=e.Message,combinations=Array.Empty<string>(),diagnostics=Array.Empty<object>()};}
   if(after!=null&&after.Length>131072)throw new InvalidOperationException("Formatted text bound");
   rows.Add(new{file,signature,sourceBytes=bytes.Length,sourceSha256=Hash(bytes),utf8Bom=bom,text=before,textSha256=TextHash(before),validationInvoked=true,isValid=validation.IsValid,validationDiagnosticScope="intolerant-first-failing-combination",diagnostics,formattingInvoked=true,error,after,afterSha256=after==null?null:TextHash(after),changed=after!=null&&before!=after});
   if(rows.Count==1){var completed=new{processId=Environment.ProcessId,phase="formatter-first-document-completed",file,sourceSha256=Hash(bytes),formatterReturned=error==null};File.WriteAllText(args[1]+".first-document.json.pending",JsonSerializer.Serialize(completed));File.Move(args[1]+".first-document.json.pending",args[1]+".first-document.json");}
  }
  var loaded=AppDomain.CurrentDomain.GetAssemblies().Where(a=>!a.IsDynamic).Select(a=>new{name=a.GetName().Name,version=a.GetName().Version.ToString(),file=a.Location}).OrderBy(a=>a.name,StringComparer.Ordinal).ToArray();
  Console.Write(JsonSerializer.Serialize(new{processId=Environment.ProcessId,runtime=Environment.Version.ToString(),fantomas=typeof(CodeFormatter).Assembly.GetName().Version.ToString(),helperSha256=Hash(File.ReadAllBytes(typeof(ChecktrailFsharpFormatter).Assembly.Location)),loaded,documents=rows,complete=true}));
 }
}
`;
