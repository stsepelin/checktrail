// Original collectors compiled against the pinned Maven and JUnit APIs at execution.
export const mavenNativeSource = String.raw`
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.lang.reflect.*;
import org.apache.maven.eventspy.EventSpy;
import org.apache.maven.execution.*;
import org.apache.maven.plugin.*;
import javax.tools.*;
import com.sun.source.tree.*;
import com.sun.source.util.*;

public class VerifierMavenObserver implements EventSpy, MojoExecutionListener {
  static long bytes;
  static String json(Object value) {
    if (value == null) return "null";
    if (value instanceof Boolean || value instanceof Number) return value.toString();
    if (value instanceof Map<?, ?> map) {
      List<String> entries=new ArrayList<>();
      for(var entry:map.entrySet()) entries.add(json(entry.getKey().toString())+":"+json(entry.getValue()));
      return "{"+String.join(",",entries)+"}";
    }
    if (value instanceof Collection<?> list) return "["+String.join(",",list.stream().map(VerifierMavenObserver::json).toList())+"]";
    if (value.getClass().isArray()) {List<Object> list=new ArrayList<>();for(int i=0;i<Array.getLength(value);i++)list.add(Array.get(value,i));return json(list);}
    if (!(value instanceof String || value instanceof java.io.File)) throw new IllegalStateException("Unsupported native field type");
    StringBuilder out=new StringBuilder("\"");
    for(char c:value.toString().toCharArray()) {
      if(c=='"'||c=='\\')out.append('\\').append(c);
      else if(c<32||Character.isSurrogate(c))out.append(String.format("\\u%04x",(int)c));
      else out.append(c);
    }
    return out.append('"').toString();
  }
  static synchronized void emit(Map<String,Object> event) {
    try {
      String text=json(event)+"\n"; bytes+=text.getBytes(StandardCharsets.UTF_8).length;
      if(bytes>2*1024*1024)throw new IllegalStateException("Maven event limit");
      Files.writeString(Path.of(System.getProperty("checktrail.maven.events")),text,StandardCharsets.UTF_8,StandardOpenOption.CREATE,StandardOpenOption.APPEND);
    } catch(Exception failure){throw new IllegalStateException("Maven event collection failed",failure);}
  }
  static Map<String,Object> event(String type) {Map<String,Object> result=new LinkedHashMap<>();result.put("type",type);return result;}
  public void init(Context context){var value=event("init");value.put("processId",ProcessHandle.current().pid());value.put("home",System.getProperty("maven.home"));emit(value);}
  public void onEvent(Object input) {
    if(!(input instanceof ExecutionEvent e))return;
    Map<String,Object> value=event(e.getType().name());
    value.put("module",e.getProject()==null?null:e.getProject().getBasedir().getAbsolutePath());
    if(e.getMojoExecution()!=null){var execution=e.getMojoExecution();value.put("plugin",execution.getGroupId()+":"+execution.getArtifactId()+":"+execution.getVersion());value.put("goal",execution.getGoal());value.put("execution",execution.getExecutionId());}
    if(e.getException()!=null){List<String> causes=new ArrayList<>();Set<Throwable> seen=new HashSet<>();for(Throwable cause=e.getException();cause!=null&&seen.add(cause)&&causes.size()<16;cause=cause.getCause())causes.add(cause.getClass().getName());value.put("causes",causes);}

    if(e.getType()==ExecutionEvent.Type.SessionStarted) value.put("reactor",e.getSession().getProjects().stream().map(p->Map.of("path",p.getBasedir().getAbsolutePath(),"packaging",p.getPackaging())).toList());
    if(e.getType()==ExecutionEvent.Type.SessionEnded)value.put("exceptions",e.getSession().getResult().getExceptions().stream().map(t->t.getClass().getName()).toList());
    emit(value);
  }
  public void close(){emit(event("close"));}
  static Object field(Object target,String name) throws Exception {
    for(Class<?> type=target.getClass();type!=null;type=type.getSuperclass()) {
      try {Field field=type.getDeclaredField(name);field.setAccessible(true);return field.get(target);}
      catch(NoSuchFieldException ignored){}
    }
    throw new IllegalStateException("Pinned native field missing: "+name);
  }
  static void mojo(MojoExecutionEvent e,String type) {
    Map<String,Object> value=event(type);var execution=e.getExecution();
    value.put("module",e.getProject().getBasedir().getAbsolutePath());
    value.put("plugin",execution.getGroupId()+":"+execution.getArtifactId()+":"+execution.getVersion());
    value.put("goal",execution.getGoal());value.put("execution",execution.getExecutionId());
    value.put("class",e.getMojo().getClass().getName());
    value.put("cause",e.getCause()==null?null:e.getCause().getClass().getName());
    Map<String,Object> fields=new LinkedHashMap<>();
    try {
      String artifact=execution.getArtifactId();
      String[] names=artifact.equals("maven-compiler-plugin")
        ? (execution.getGoal().equals("compile")
          ? new String[]{"compileSourceRoots","outputDirectory","encoding","compilerId","executable","compilerArgs","compilerArgument","compilerArguments","fork","skipMain","includes","excludes","failOnError","proc"}
          : new String[]{"compileSourceRoots","outputDirectory","encoding","compilerId","executable","compilerArgs","compilerArgument","compilerArguments","fork","skip","testIncludes","testExcludes","failOnError","proc"})
        : artifact.equals("maven-surefire-plugin")
          ? new String[]{"skip","skipExec","skipTests","test","includes","excludes","groups","excludedGroups","includeJUnit5Engines","excludeJUnit5Engines","rerunFailingTestsCount","skipAfterFailureCount","forkCount","reuseForks","testFailureIgnore","disableXmlReport","reportsDirectory","testClassesDirectory","classesDirectory","properties","systemPropertiesFile","suiteXmlFiles","dependenciesToScan","additionalClasspathElements","additionalClasspathDependencies","classpathDependencyExcludes","argLine","jvm","workingDirectory"}
          : new String[]{};
      for(String name:names)fields.put(name,field(e.getMojo(),name));
      value.put("fields",fields);
      if(artifact.equals("maven-compiler-plugin")||artifact.equals("maven-surefire-plugin"))value.put("classPath",execution.getGoal().equals("compile")?e.getProject().getCompileClasspathElements():e.getProject().getTestClasspathElements());
      if(type.equals("afterMojo")&&artifact.equals("maven-compiler-plugin")&&execution.getGoal().equals("testCompile")) {
        Path inputs=e.getProject().getBasedir().toPath().resolve("target/maven-status/maven-compiler-plugin/testCompile/default-testCompile/inputFiles.lst");
        List<Map<String,Object>> declarations=new ArrayList<>();
        if(Files.exists(inputs)) {
          List<String> files=Files.readAllLines(inputs,StandardCharsets.UTF_8);if(files.size()>2048)throw new IllegalStateException("Source declaration bound");
          JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();
          try(StandardJavaFileManager manager=compiler.getStandardFileManager(null,Locale.ROOT,StandardCharsets.UTF_8)) {
            JavacTask task=(JavacTask)compiler.getTask(new java.io.StringWriter(),manager,null,List.of("-proc:none","-encoding","UTF-8"),null,manager.getJavaFileObjectsFromStrings(files));
            for(CompilationUnitTree unit:task.parse()) {
              String prefix=unit.getPackageName()==null?"":unit.getPackageName().toString()+".";
              String file=Path.of(unit.getSourceFile().toUri()).toAbsolutePath().normalize().toString();
              for(Tree tree:unit.getTypeDecls())if(tree instanceof ClassTree declaration)declarations.add(Map.of("className",prefix+declaration.getSimpleName(),"file",file));
            }
          }
        }
        value.put("declarations",declarations);
      }

    } catch(Exception failure){value.put("collectionError",failure.getClass().getName());}
    emit(value);
  }
  public void beforeMojoExecution(MojoExecutionEvent event){mojo(event,"beforeMojo");}
  public void afterMojoExecutionSuccess(MojoExecutionEvent event){mojo(event,"afterMojo");}
  public void afterExecutionFailure(MojoExecutionEvent event){mojo(event,"failedMojo");}
}
`;
export const mavenJUnitSource = String.raw`
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.lang.reflect.Array;
import org.junit.platform.launcher.*;
import org.junit.platform.engine.*;
import org.junit.platform.engine.support.descriptor.*;

public class VerifierMavenTests implements TestExecutionListener {
  long bytes;
  static String json(Object value) {
    if(value==null)return "null";
    if(value instanceof Boolean || value instanceof Number)return value.toString();
    if(value instanceof Map<?,?> map){List<String> entries=new ArrayList<>();for(var entry:map.entrySet())entries.add(json(entry.getKey().toString())+":"+json(entry.getValue()));return "{"+String.join(",",entries)+"}";}
    if(value instanceof Collection<?> list)return "["+String.join(",",list.stream().map(VerifierMavenTests::json).toList())+"]";
    StringBuilder out=new StringBuilder("\"");for(char c:value.toString().toCharArray()){if(c=='"'||c=='\\')out.append('\\').append(c);else if(c<32||Character.isSurrogate(c))out.append(String.format("\\u%04x",(int)c));else out.append(c);}return out.append('"').toString();
  }
  synchronized void emit(Map<String,Object> value) {
    try{value.put("module",System.getProperty("user.dir"));String text=json(value)+"\n";bytes+=text.getBytes(StandardCharsets.UTF_8).length;if(bytes>2*1024*1024)throw new IllegalStateException("JUnit event limit");Files.writeString(Path.of(System.getProperty("checktrail.junit.events")),text,StandardCharsets.UTF_8,StandardOpenOption.CREATE,StandardOpenOption.APPEND);}
    catch(Exception failure){throw new IllegalStateException("JUnit collection failed",failure);}
  }
  Map<String,Object> node(String type,TestIdentifier id) {
    Map<String,Object> value=new LinkedHashMap<>();value.put("type",type);value.put("id",id.getUniqueId());value.put("parent",id.getParentId().orElse(null));value.put("test",id.isTest());
    String name=null;
    if(id.getSource().orElse(null) instanceof ClassSource source)name=source.getClassName();
    if(id.getSource().orElse(null) instanceof MethodSource source)name=source.getClassName();
    value.put("className",name);
    String output=null;
    if(name!=null)try {Class<?> typeClass=Class.forName(name,false,Thread.currentThread().getContextClassLoader());output=Path.of(typeClass.getProtectionDomain().getCodeSource().getLocation().toURI()).toAbsolutePath().normalize().toString();}
      catch(Exception failure){throw new IllegalStateException("Test class origin unavailable",failure);}
    value.put("output",output);
    String sourceFile=null;
    if(name!=null)try {var model=java.lang.classfile.ClassFile.of().parse(Files.readAllBytes(Path.of(output,name.replace('.','/')+".class")));sourceFile=model.findAttribute(java.lang.classfile.Attributes.sourceFile()).orElseThrow().sourceFile().stringValue();}
      catch(Exception failure){throw new IllegalStateException("Native test source provenance unavailable",failure);}
    value.put("sourceFile",sourceFile);return value;
  }
  public void testPlanExecutionStarted(TestPlan plan){
    try {var start=new LinkedHashMap<String,Object>();start.put("type","planStarted");start.put("launcher",Path.of(TestPlan.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toString());start.put("engine",Path.of(Class.forName("org.junit.jupiter.engine.JupiterTestEngine",false,Thread.currentThread().getContextClassLoader()).getProtectionDomain().getCodeSource().getLocation().toURI()).toString());emit(start);}catch(Exception failure){throw new IllegalStateException("Native JUnit origin unavailable",failure);}
for(var root:plan.getRoots()){emit(node("discovered",root));for(var id:plan.getDescendants(root))emit(node("discovered",id));}}
  public void dynamicTestRegistered(TestIdentifier id){emit(node("dynamic",id));}
  public void executionStarted(TestIdentifier id){emit(node("started",id));}
  public void executionSkipped(TestIdentifier id,String reason){var value=node("skipped",id);value.put("reason",reason);emit(value);}
  public void executionFinished(TestIdentifier id,TestExecutionResult result){var value=node("finished",id);value.put("status",result.getStatus().name());value.put("failure",result.getThrowable().map(t->t.getClass().getName()).orElse(null));emit(value);}
  public void testPlanExecutionFinished(TestPlan plan){emit(new LinkedHashMap<>(Map.of("type","planFinished")));}
}
`;
