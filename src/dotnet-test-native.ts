// Original VSTest logger compiled against the selected SDK; verified discovery and execution hooks.
export const dotnetTestNativeSource = String.raw`
using System;using System.IO;using System.Linq;using System.Collections.Generic;using System.Text;using System.Text.Json;using Microsoft.VisualStudio.TestPlatform.ObjectModel;using Microsoft.VisualStudio.TestPlatform.ObjectModel.Client;
[ExtensionUri("logger://example.invalid/checktrail/local-test/v1")][FriendlyName("checktrail-local")]
public sealed class ChecktrailTestLogger : ITestLoggerWithParameters {
 string file="";long bytes;readonly object gate=new();
 void Emit(object value){lock(gate){var text=JsonSerializer.Serialize(value)+"\n";bytes+=Encoding.UTF8.GetByteCount(text);if(bytes>2*1024*1024)throw new InvalidOperationException("Native test event bound");File.AppendAllText(file,text,new UTF8Encoding(false,true));}}
 static object Case(TestCase test)=>new{id=test.Id.ToString(),name=test.FullyQualifiedName,displayName=test.DisplayName,executor=test.ExecutorUri.ToString(),source=test.Source,codeFile=test.CodeFilePath??"",line=test.LineNumber};
 public void Initialize(TestLoggerEvents events,string directory){throw new InvalidOperationException("Explicit output required");}
 public void Initialize(TestLoggerEvents events,Dictionary<string,string> parameters){file=parameters["LogFilePath"];using(var stream=new FileStream(file,FileMode.CreateNew)){}Emit(new{type="init",processId=Environment.ProcessId,objectModel=typeof(TestCase).Assembly.Location,runtime=Environment.Version.ToString(),observerSha256=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(typeof(ChecktrailTestLogger).Assembly.Location))).ToLowerInvariant()});
 events.DiscoveryStart+=(s,e)=>Emit(new{type="discoveryStarted"});
 events.DiscoveredTests+=(s,e)=>{foreach(var test in e.DiscoveredTestCases)Emit(new{type="discovered",test=Case(test)});};
 events.DiscoveryComplete+=(s,e)=>{Emit(new{type="discoveryFinished",total=e.TotalCount,aborted=e.IsAborted,full=e.FullyDiscoveredSources,partial=e.PartiallyDiscoveredSources,skipped=e.SkippedDiscoveredSources,missing=e.NotDiscoveredSources});Emit(new{type="close"});};
 events.TestRunStart+=(s,e)=>Emit(new{type="runStarted",sources=e.TestRunCriteria.Sources});
 events.TestResult+=(s,e)=>Emit(new{type="result",test=Case(e.Result.TestCase),outcome=e.Result.Outcome.ToString(),displayName=e.Result.DisplayName,error=e.Result.ErrorMessage??"",durationMs=e.Result.Duration.TotalMilliseconds,start=e.Result.StartTime,end=e.Result.EndTime});
 events.TestRunComplete+=(s,e)=>{Emit(new{type="runFinished",canceled=e.IsCanceled,aborted=e.IsAborted,error=e.Error?.ToString()??"",executed=e.TestRunStatistics?.ExecutedTests,stats=e.TestRunStatistics?.Stats.ToDictionary(pair=>pair.Key.ToString(),pair=>pair.Value),elapsedMs=e.ElapsedTimeInRunningTests.TotalMilliseconds});Emit(new{type="close"});};
 events.TestRunMessage+=(s,e)=>Emit(new{type="message",level=e.Level.ToString(),message=e.Message});
 events.DiscoveryMessage+=(s,e)=>Emit(new{type="message",level=e.Level.ToString(),message=e.Message});
 }
}
`;
