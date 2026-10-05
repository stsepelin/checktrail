// Original helpers compiled against the selected SDK. Project assemblies are read as metadata.
export const dotnetBuildNativeSource = String.raw`
using System;
using System.IO;
using System.Linq;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Microsoft.Build.Framework;

public sealed class ChecktrailBuildLogger : ILogger {
 public LoggerVerbosity Verbosity {get;set;}=LoggerVerbosity.Diagnostic;
 public string Parameters {get;set;}="";
 readonly object gate=new();long bytes;readonly HashSet<string> compilerContexts=new();
 static string Key(BuildEventArgs e)=>e.BuildEventContext==null?"":$"{e.BuildEventContext.NodeId}/{e.BuildEventContext.ProjectContextId}/{e.BuildEventContext.TargetId}/{e.BuildEventContext.TaskId}";
 void Emit(object value){lock(gate){var text=JsonSerializer.Serialize(value)+"\n";bytes+=Encoding.UTF8.GetByteCount(text);if(bytes>2*1024*1024)throw new InvalidOperationException("Native event bound");File.AppendAllText(Parameters,text,new UTF8Encoding(false,true));}}
 static object Context(BuildEventArgs e)=>new{node=e.BuildEventContext?.NodeId,project=e.BuildEventContext?.ProjectContextId,target=e.BuildEventContext?.TargetId,task=e.BuildEventContext?.TaskId};
 static readonly HashSet<string> PropertyNames=new("TargetFramework TargetFrameworks AssemblyName OutputType OutputPath IntermediateOutputPath ProjectAssetsFile RestorePackagesPath IsTestProject RunAnalyzers RunAnalyzersDuringBuild EnableNETAnalyzers EmitCompilerGeneratedFiles CompilerGeneratedFilesOutputPath NoWarn TreatWarningsAsErrors WarningsNotAsErrors NETCoreSdkVersion MSBuildToolsPath MSBuildSDKsPath Configuration Platform UseSharedCompilation BuildInParallel GenerateAssemblyInfo GenerateTargetFrameworkAttribute".Split(' '));
 static Dictionary<string,string> Properties(IEnumerable values){var result=new Dictionary<string,string>();if(values==null)return result;foreach(var item in values){string key,value;if(item is DictionaryEntry entry){key=entry.Key.ToString();value=entry.Value?.ToString()??"";}else{var type=item.GetType();key=(type.GetProperty("Key")??type.GetProperty("Name"))?.GetValue(item)?.ToString();value=(type.GetProperty("Value")??type.GetProperty("EvaluatedValue"))?.GetValue(item)?.ToString()??"";if(key==null)throw new InvalidOperationException("Unknown property shape");}if(PropertyNames.Contains(key)){if(value.Length>65536)throw new InvalidOperationException("Property bound");result.Add(key,value);}}return result;}
 static readonly HashSet<string> Compilers=new(new[]{"Csc","Fsc","Vbc"});
 public void Initialize(IEventSource source){((IEventSource3)source).IncludeTaskInputs();((IEventSource4)source).IncludeEvaluationPropertiesAndItems();Emit(new{type="init",processId=Environment.ProcessId,framework=typeof(ILogger).Assembly.Location,runtime=Environment.Version.ToString()});source.AnyEventRaised+=(sender,e)=>{
  if(e is ProjectEvaluationFinishedEventArgs evaluation)Emit(new{type="evaluation",file=evaluation.ProjectFile,properties=Properties(evaluation.Properties),context=Context(e)});
  else if(e is ProjectStartedEventArgs started)Emit(new{type="projectStarted",file=started.ProjectFile,targets=started.TargetNames,properties=Properties(started.Properties),context=Context(e)});
  else if(e is ProjectFinishedEventArgs finished)Emit(new{type="projectFinished",file=finished.ProjectFile,success=finished.Succeeded,context=Context(e)});
  else if(e is TaskStartedEventArgs task&&Compilers.Contains(task.TaskName)){compilerContexts.Add(Key(e));Emit(new{type="compilerStarted",file=task.ProjectFile,name=task.TaskName,assembly=task.TaskAssemblyLocation,context=Context(e)});}
  else if(e is TaskFinishedEventArgs end&&Compilers.Contains(end.TaskName))Emit(new{type="compilerFinished",file=end.ProjectFile,name=end.TaskName,success=end.Succeeded,context=Context(e)});
  else if(e is TaskCommandLineEventArgs command&&Compilers.Contains(command.TaskName))Emit(new{type="compilerCommand",name=command.TaskName,line=command.CommandLine,context=Context(e)});
  else if(e is TaskParameterEventArgs parameter&&parameter.Kind==TaskParameterMessageKind.TaskInput&&compilerContexts.Contains(Key(e))){var values=new List<string>();foreach(var item in parameter.Items??new object[0]){var value=item is ITaskItem taskItem?taskItem.ItemSpec:item?.ToString()??"";if(value.Length>65536||values.Count>=4096)throw new InvalidOperationException("Native parameter bound");values.Add(value);}Emit(new{type="parameter",name=parameter.ParameterName,values,context=Context(e)});}
  else if(e is BuildErrorEventArgs error)Emit(new{type="diagnostic",severity="error",code=error.Code,file=error.File,line=error.LineNumber,column=error.ColumnNumber,message=error.Message,project=error.ProjectFile,context=Context(e)});
  else if(e is BuildWarningEventArgs warning)Emit(new{type="diagnostic",severity="warning",code=warning.Code,file=warning.File,line=warning.LineNumber,column=warning.ColumnNumber,message=warning.Message,project=warning.ProjectFile,context=Context(e)});
  else if(e is BuildFinishedEventArgs ended)Emit(new{type="finished",success=ended.Succeeded});
 };}
 public void Shutdown(){Emit(new{type="close"});}
}
public static class ChecktrailBuildMetadata {
 static void Main(string[] args){if(args.Length!=2)throw new InvalidOperationException("Metadata invocation");var assembly=args[0];var pdb=args[1];if(new FileInfo(assembly).Length>32*1024*1024||new FileInfo(pdb).Length>8*1024*1024)throw new InvalidOperationException("Metadata bound");using var stream=File.OpenRead(assembly);using var pe=new PEReader(stream);if(!pe.HasMetadata)throw new InvalidOperationException("Managed output required");var metadata=pe.GetMetadataReader();using var symbols=File.OpenRead(pdb);using var provider=MetadataReaderProvider.FromPortablePdbStream(symbols);var debug=provider.GetMetadataReader();var documents=new List<object>();var paths=new Dictionary<DocumentHandle,string>();if(debug.Documents.Count>4096||metadata.TypeDefinitions.Count>4096||metadata.MethodDefinitions.Count>20000)throw new InvalidOperationException("Metadata row bound");foreach(var handle in debug.Documents){var document=debug.GetDocument(handle);var name=debug.GetString(document.Name);if(name.Length>8192)throw new InvalidOperationException("Document path bound");paths.Add(handle,name);documents.Add(new{file=name,algorithm=debug.GetGuid(document.HashAlgorithm).ToString(),hash=Convert.ToHexString(debug.GetBlobBytes(document.Hash)).ToLowerInvariant()});}var types=new List<object>();foreach(var handle in metadata.TypeDefinitions){var type=metadata.GetTypeDefinition(handle);var name=metadata.GetString(type.Name);if(name=="<Module>")continue;var ns=metadata.GetString(type.Namespace);var className=(ns.Length==0?"":ns+".")+name;var methods=new List<object>();foreach(var methodHandle in type.GetMethods()){var method=metadata.GetMethodDefinition(methodHandle);var information=debug.GetMethodDebugInformation(methodHandle.ToDebugInformationHandle());var files=new HashSet<string>();if(!information.Document.IsNil)files.Add(paths[information.Document]);foreach(var point in information.GetSequencePoints())if(!point.Document.IsNil)files.Add(paths[point.Document]);methods.Add(new{name=metadata.GetString(method.Name),files=files.OrderBy(value=>value).ToArray()});}types.Add(new{className,methods});}Console.Write(JsonSerializer.Serialize(new{assemblyName=metadata.GetString(metadata.GetAssemblyDefinition().Name),documents,types}));}
}
`;
