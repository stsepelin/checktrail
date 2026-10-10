import { mavenJUnitSource } from "./maven-native.js";
export const gradleJUnitSource = mavenJUnitSource
  .replaceAll("VerifierMavenTests", "VerifierGradleTests")
  .replace(
    'value.put("id",id.getUniqueId());',
    'value.put("id",id.getUniqueId());value.put("displayName",id.getDisplayName());',
  );
export const gradleJvmArguments = [
  "--add-opens=java.base/java.lang=ALL-UNNAMED",
  "--add-opens=java.base/java.lang.invoke=ALL-UNNAMED",
  "--add-opens=java.base/java.util=ALL-UNNAMED",
  "--add-opens=java.prefs/java.util.prefs=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED",
  "--add-exports=jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED",
  "--add-opens=java.base/java.nio.charset=ALL-UNNAMED",
  "--add-opens=java.base/java.net=ALL-UNNAMED",
  "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
  "--add-opens=java.base/java.util.concurrent.atomic=ALL-UNNAMED",
  "--add-opens=java.xml/javax.xml.namespace=ALL-UNNAMED",
  "--add-opens=java.base/java.time=ALL-UNNAMED",
  "--sun-misc-unsafe-memory-access=allow",
  "--enable-native-access=ALL-UNNAMED",
  "-XX:MaxMetaspaceSize=384m",
  "-XX:+HeapDumpOnOutOfMemoryError",
  "-Xms256m",
  "-Xmx512m",
  "-Dfile.encoding=UTF-8",
  "-Duser.country=US",
  "-Duser.language=en",
  "-Duser.variant",
];
export const gradleNativeSource = String.raw`import groovy.json.JsonOutput
import org.gradle.api.tasks.compile.JavaCompile
import org.gradle.api.tasks.testing.Test
import org.gradle.api.tasks.bundling.Jar
import org.gradle.api.tasks.Copy

def eventFile = new File(System.getProperty('checktrail.gradle.events'))
def emit = { Map data -> synchronized(eventFile) { eventFile.append(JsonOutput.toJson(data)+'\n','UTF-8') } }
def failures = { Throwable failure -> def names=[]; while(failure!=null && names.size()<32 && !names.contains(failure.class.name)){ names.add(failure.class.name); failure=failure.cause };names }
def files = { collection -> collection.files.collect { it.canonicalPath }.sort() }
def snapshot = { task ->
 def result=[path:task.path,project:task.project.projectDir.canonicalPath,className:task.class.name,actions:task.actions.collect{it.class.name},enabled:task.enabled,onlyIf:task.onlyIf.class.name]
 if(task instanceof JavaCompile){result.putAll([role:'compile',source:files(task.source),classpath:files(task.classpath),destination:task.destinationDirectory.get().asFile.canonicalPath,release:task.options.release.orNull,encoding:task.options.encoding,fork:task.options.fork,compilerArgs:task.options.compilerArgs,annotationProcessors:files(task.options.annotationProcessorPath),java:task.javaCompiler.get().metadata.installationPath.asFile.canonicalPath,javaLanguage:task.javaCompiler.get().metadata.languageVersion.asInt()])}
 else if(task instanceof Test){result.putAll([role:'test',classpath:files(task.classpath),testClasses:files(task.testClassesDirs),workingDirectory:task.workingDir.canonicalPath,includes:task.includes.toList().sort(),excludes:task.excludes.toList().sort(),includePatterns:task.filter.includePatterns.toList().sort(),excludePatterns:task.filter.excludePatterns.toList().sort(),scanForTestClasses:task.scanForTestClasses,ignoreFailures:task.ignoreFailures,failFast:task.failFast,failOnNoMatchingTests:task.filter.failOnNoMatchingTests,maxParallelForks:task.maxParallelForks,forkEvery:task.forkEvery,optionsClass:task.options.class.name,includeTags:task.options.includeTags.toList().sort(),excludeTags:task.options.excludeTags.toList().sort(),includeEngines:task.options.includeEngines.toList().sort(),excludeEngines:task.options.excludeEngines.toList().sort(),systemProperties:task.systemProperties,jvmArgs:task.jvmArgs,java:task.javaLauncher.get().metadata.installationPath.asFile.canonicalPath,javaLanguage:task.javaLauncher.get().metadata.languageVersion.asInt(),xml:task.reports.junitXml.outputLocation.get().asFile.canonicalPath,xmlRequired:task.reports.junitXml.required.get(),mergeReruns:task.reports.junitXml.mergeReruns.get()])}
 else if(task instanceof Jar){result.putAll([role:'jar',output:task.archiveFile.get().asFile.canonicalPath])}
 else if(task instanceof Copy){result.putAll([role:'resources',source:files(task.source),destination:task.destinationDir.canonicalPath])}
 else result.role='lifecycle'
 result
}
def init=[type:'init',processId:ProcessHandle.current().pid(),version:gradle.gradleVersion,runtime:System.getProperty('java.runtime.version'),home:gradle.gradleHomeDir.canonicalPath,userHome:gradle.gradleUserHomeDir.canonicalPath,offline:gradle.startParameter.offline,tasks:gradle.startParameter.taskNames,excludedTasks:gradle.startParameter.excludedTaskNames.toList().sort(),parallel:gradle.startParameter.parallelProjectExecutionEnabled,maxWorkers:gradle.startParameter.maxWorkerCount]
if(System.getProperty('checktrail.wrapper')=='1') {
 def ancestors=[ProcessHandle.current().pid()];def parent=ProcessHandle.current().parent().orElse(null)
 while(parent!=null && ancestors.size()<16){ancestors.add(parent.pid());parent=parent.parent().orElse(null)}
 init.wrapperAncestors=ancestors
}
emit(init)
gradle.projectsEvaluated {
 emit([type:'projects',projects:gradle.rootProject.allprojects.collect{p->[path:p.path,directory:p.projectDir.canonicalPath,build:p.buildFile.canonicalPath,tests:p.tasks.withType(Test).collect{it.path}.sort(),sourceSets:p.extensions.findByName('sourceSets')?.collect{s->[name:s.name,java:files(s.allJava),javaRoots:s.java.srcDirs.collect{it.canonicalPath}.sort(),resources:files(s.resources)]}]}])
 gradle.rootProject.allprojects.each { p -> p.tasks.withType(Test).configureEach {task->
  task.classpath += p.files(System.getProperty('checktrail.observer'))
  task.systemProperty('checktrail.junit.events',System.getProperty('checktrail.junit.events'))
  task.beforeSuite{d->emit([type:'suiteStarted',task:task.path,id:d.id.toString(),parent:d.parent?.id?.toString(),className:d.className,name:d.name,displayName:d.displayName])}
  task.beforeTest{d->emit([type:'testStarted',task:task.path,id:d.id.toString(),parent:d.parent?.id?.toString(),className:d.className,name:d.name,displayName:d.displayName])}
  task.afterTest{d,r->emit([type:'testFinished',task:task.path,id:d.id.toString(),parent:d.parent?.id?.toString(),className:d.className,name:d.name,displayName:d.displayName,status:r.resultType.toString(),tests:r.testCount,passed:r.successfulTestCount,failed:r.failedTestCount,skipped:r.skippedTestCount,failures:r.exceptions.collect{it.class.name}])}
  task.afterSuite{d,r->emit([type:'suiteFinished',task:task.path,id:d.id.toString(),parent:d.parent?.id?.toString(),className:d.className,name:d.name,displayName:d.displayName,status:r.resultType.toString(),tests:r.testCount,passed:r.successfulTestCount,failed:r.failedTestCount,skipped:r.skippedTestCount])}
 }}
}
gradle.taskGraph.whenReady { graph -> emit([type:'graph',tasks:graph.allTasks.collect{snapshot(it)}]) }
gradle.taskGraph.beforeTask {task->emit([type:'taskStarted',task:snapshot(task)])}
gradle.taskGraph.afterTask {task,state->emit([type:'taskFinished',task:task.path,snapshot:snapshot(task),skipped:state.skipped,skipMessage:state.skipMessage,noSource:state.noSource,upToDate:state.upToDate,didWork:state.didWork,failures:failures(state.failure)])}
gradle.buildFinished {result->emit([type:'close',failures:failures(result.failure)])}
`;
export const gradleDeclarationSource = String.raw`import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.tools.*;
import com.sun.source.util.JavacTask;
import com.sun.source.tree.ClassTree;
public class VerifierGradleSources {
 public static void main(String[] args) throws Exception {
  var compiler=ToolProvider.getSystemJavaCompiler();
  if(compiler==null)throw new IllegalStateException("Native compiler unavailable");
  var diagnostics=new DiagnosticCollector<JavaFileObject>();
  try(var manager=compiler.getStandardFileManager(diagnostics,null,StandardCharsets.UTF_8)){
   var task=(JavacTask)compiler.getTask(null,manager,diagnostics,List.of("-proc:none","-encoding","UTF-8"),null,manager.getJavaFileObjects(args));
   var declarations=new ArrayList<Map<String,Object>>();
   for(var unit:task.parse())for(var tree:unit.getTypeDecls())if(tree instanceof ClassTree type){
    String name=(unit.getPackageName()==null?"":unit.getPackageName().toString()+".")+type.getSimpleName();
    declarations.add(Map.of("file",Path.of(unit.getSourceFile().toUri()).toRealPath().toString(),"className",name));
   }
   if(diagnostics.getDiagnostics().stream().anyMatch(d->d.getKind()==Diagnostic.Kind.ERROR))throw new IllegalStateException("Native parse incomplete");
   System.out.println(VerifierGradleTests.json(declarations));
  }
 }
}
`;
