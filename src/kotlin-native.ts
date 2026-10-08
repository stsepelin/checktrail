export const kotlinNativeSource = String.raw`import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.jetbrains.kotlin.cli.jvm.K2JVMCompiler;
import org.jetbrains.kotlin.cli.common.arguments.K2JVMCompilerArguments;
import org.jetbrains.kotlin.cli.common.messages.*;
import org.jetbrains.kotlin.config.Services;
public final class VerifierKotlin {
 public static final Map<String,Source> sources=new TreeMap<>();
 public static final List<String> irFiles=new ArrayList<>();
 public static int firNodes=0,irModules=0,registrations=0,unknownSources=0;
 static final class Source {
  final String file; String nativeHash; int bytes=-1,fileCallbacks=0,declarations=0,expressions=0,types=0,unknownAnnotations=0;
  final List<String> annotations=new ArrayList<>();
  Source(String value){file=value;}
 }
 static String q(String s){if(s==null)return "null";StringBuilder b=new StringBuilder("\"");for(char c:s.toCharArray()){if(c=='"'||c=='\\')b.append('\\').append(c);else if(c<32||Character.isSurrogate(c))b.append(String.format("\\u%04x",(int)c));else b.append(c);}return b.append('"').toString();}
 static String sha(byte[] b){try{return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(b));}catch(Exception e){throw new IllegalStateException(e);}}
 static synchronized void observe(org.jetbrains.kotlin.KtSourceFile file,org.jetbrains.kotlin.fir.FirAnnotationContainer element,org.jetbrains.kotlin.fir.FirSession session,String kind){
  if(++firNodes>200000)throw new IllegalStateException("Native frontend node budget");
  Source source=file==null?null:sources.get(file.getPath());
  if(source==null){unknownSources++;return;}
  if(kind.equals("declaration"))source.declarations++;
  else if(kind.equals("expression"))source.expressions++;
  else if(kind.equals("type"))source.types++;
  else throw new IllegalStateException("Unknown frontend checker kind");
  if(element instanceof org.jetbrains.kotlin.fir.declarations.FirFile){
   source.fileCallbacks++;
   try(var input=file.getContentsAsStream()){
    byte[] bytes=input.readNBytes(1024*1024+1);if(bytes.length>1024*1024)throw new IllegalStateException("Native source budget");source.nativeHash=sha(bytes);source.bytes=bytes.length;
   }catch(Exception e){throw new IllegalStateException(e);}
  }
  for(var annotation:element.getAnnotations()){
   var id=org.jetbrains.kotlin.fir.declarations.FirAnnotationUtilsKt.toAnnotationClassIdSafe(annotation,session);
   if(id==null)source.unknownAnnotations++;
   else {if(source.annotations.size()>=200000)throw new IllegalStateException("Native annotation budget");source.annotations.add(id.asSingleFqName().asString());}
  }
 }
 static synchronized void observeIr(org.jetbrains.kotlin.ir.declarations.IrModuleFragment module){
  if(++irModules>1)throw new IllegalStateException("Repeated native IR module");
  for(var file:module.getFiles()){if(irFiles.size()>=2000)throw new IllegalStateException("Native IR file budget");irFiles.add(file.getFileEntry().getName());}
 }
 public static void main(String[] a)throws Exception {
  String version=org.jetbrains.kotlin.config.KotlinCompilerVersion.VERSION;
  if(a.length==1&&a[0].equals("--version")){System.out.println("Kotlin compiler "+version);return;}
  if(a.length<5||a.length>2004)throw new IllegalStateException("Missing fixed compilation inputs");
  List<String> requested=Arrays.asList(Arrays.copyOfRange(a,4,a.length));
  for(String file:requested){if(sources.put(file,new Source(file))!=null)throw new IllegalStateException("Duplicate selected Kotlin source");}
  List<String> messages=new ArrayList<>(),outputs=new ArrayList<>();
  List<OutputMessageUtil.Output> bindings=new ArrayList<>();
  MessageCollector collector=new MessageCollector(){ boolean errors=false;int messageBytes=0;
   public void clear(){throw new IllegalStateException("Native message collector was cleared");}
   public boolean hasErrors(){return errors;}
   public void report(CompilerMessageSeverity severity,String message,CompilerMessageSourceLocation l){
    messageBytes+=message.getBytes(StandardCharsets.UTF_8).length;
    if(messages.size()>=2000||messageBytes>1024*1024)throw new IllegalStateException("Native diagnostic budget");
    if(severity.isError())errors=true;
    messages.add("{\"severity\":"+q(severity.name())+",\"message\":"+q(message)+",\"file\":"+q(l==null?null:l.getPath())+",\"line\":"+(l==null?-1:l.getLine())+",\"column\":"+(l==null?-1:l.getColumn())+",\"lineContent\":"+q(l==null?null:l.getLineContent())+"}");
    if(severity==CompilerMessageSeverity.OUTPUT){
     OutputMessageUtil.Output o=OutputMessageUtil.parseOutputMessage(message);
     if(o==null||o.outputFile==null||bindings.size()>=4001)throw new IllegalStateException("Invalid native output binding");
     bindings.add(o);
    }
   }
  };
  K2JVMCompiler compiler=new K2JVMCompiler();K2JVMCompilerArguments args=compiler.createArguments();
  args.setFreeArgs(requested);args.setDestination(a[0]);args.setClasspath(a[1]);args.setNoStdlib(true);args.setNoReflect(true);args.setDisableDefaultScriptingPlugin(true);args.setDisableStandardScript(true);args.setJdkHome(System.getProperty("java.home"));args.setJvmTarget(System.getProperty("checktrail.kotlin.target"));args.setLanguageVersion("2.4");args.setApiVersion("2.4");args.setReportOutputFiles(true);args.setReportAllWarnings(true);args.setRenderInternalDiagnosticNames(true);args.setAllWarningsAsErrors(a[3].equals("true"));args.setPluginClasspaths(new String[]{a[2]});args.setBackendThreads("1");
  var code=compiler.exec(collector,Services.EMPTY,args);
  Set<String> outputNames=new HashSet<>();long outputBytes=0;
  Path directory=Path.of(a[0]).toAbsolutePath().normalize();
  for(OutputMessageUtil.Output binding:bindings){
   Path target=binding.outputFile.toPath().toAbsolutePath().normalize();
   if(!target.startsWith(directory)||!target.toRealPath().equals(target)||!outputNames.add(target.toString()))throw new IllegalStateException("Native output path or duplicate binding");
   byte[] bytes;try(var input=Files.newInputStream(target,LinkOption.NOFOLLOW_LINKS)){bytes=input.readNBytes(32*1024*1024+1);}
   outputBytes+=bytes.length;if(bytes.length>32*1024*1024||outputBytes>64*1024*1024)throw new IllegalStateException("Native output byte budget");
   if(!Files.isRegularFile(target,LinkOption.NOFOLLOW_LINKS)||Files.size(target)!=bytes.length)throw new IllegalStateException("Native output changed");
   Integer classMajor=null;
   if(target.toString().endsWith(".class")){
    if(bytes.length<8||(bytes[0]&255)!=202||(bytes[1]&255)!=254||(bytes[2]&255)!=186||(bytes[3]&255)!=190)throw new IllegalStateException("Invalid native class header");
    classMajor=((bytes[6]&255)<<8)+(bytes[7]&255);
   }
   outputs.add("{\"classMajor\":"+classMajor+",\"file\":"+q(directory.relativize(target).toString())+",\"sha256\":"+q(sha(bytes))+",\"bytes\":"+bytes.length+",\"sources\":["+String.join(",",binding.sourceFiles.stream().map(f->q(f.toString())).toList())+"]}");
  }
  Set<String> physicalOutputs=new HashSet<>();
  if(Files.exists(directory))try(var stream=Files.walk(directory)){
   var iterator=stream.iterator();int paths=0;
   while(iterator.hasNext()){
    Path target=iterator.next();if(++paths>10000||Files.isSymbolicLink(target))throw new IllegalStateException("Native output inventory bound");
    if(Files.isRegularFile(target,LinkOption.NOFOLLOW_LINKS))physicalOutputs.add(target.toString());
    else if(!Files.isDirectory(target,LinkOption.NOFOLLOW_LINKS))throw new IllegalStateException("Unexpected native output kind");
   }
  }
  if(!physicalOutputs.equals(outputNames))throw new IllegalStateException("Native output inventory disagrees with bindings");
  List<String> observed=new ArrayList<>();
  for(Source s:sources.values())observed.add("{\"file\":"+q(s.file)+",\"sha256\":"+q(s.nativeHash)+",\"bytes\":"+s.bytes+",\"fileCallbacks\":"+s.fileCallbacks+",\"declarations\":"+s.declarations+",\"expressions\":"+s.expressions+",\"types\":"+s.types+",\"unknownAnnotations\":"+s.unknownAnnotations+",\"annotations\":["+String.join(",",s.annotations.stream().map(VerifierKotlin::q).toList())+"]}");
  String result="{\"version\":1,\"kotlin\":"+q(version)+",\"runtime\":"+q(System.getProperty("java.runtime.version"))+",\"vendor\":"+q(System.getProperty("java.vendor"))+",\"jdkHome\":"+q(System.getProperty("java.home"))+",\"exit\":"+q(code.name())+",\"hasErrors\":"+collector.hasErrors()+",\"registrations\":"+registrations+",\"firNodes\":"+firNodes+",\"unknownSources\":"+unknownSources+",\"irModules\":"+irModules+",\"irFiles\":["+String.join(",",irFiles.stream().map(VerifierKotlin::q).toList())+"],\"sources\":["+String.join(",",observed)+"],\"messages\":["+String.join(",",messages)+"],\"outputs\":["+String.join(",",outputs)+"]}";
  if(result.getBytes(StandardCharsets.UTF_8).length>4*1024*1024)throw new IllegalStateException("Native receipt budget");
  System.out.println(result);
 }
}
`;
export const kotlinRegistrarSource = String.raw`import java.nio.file.*;
import java.util.*;
import org.jetbrains.kotlin.compiler.plugin.CompilerPluginRegistrar;
import org.jetbrains.kotlin.config.CompilerConfiguration;
import org.jetbrains.kotlin.fir.extensions.*;
import org.jetbrains.kotlin.fir.analysis.extensions.FirAdditionalCheckersExtension;
import org.jetbrains.kotlin.fir.analysis.checkers.MppCheckerKind;
import org.jetbrains.kotlin.fir.analysis.checkers.context.CheckerContext;
import org.jetbrains.kotlin.fir.analysis.checkers.declaration.*;
import org.jetbrains.kotlin.fir.analysis.checkers.expression.*;
import org.jetbrains.kotlin.fir.analysis.checkers.type.*;
import org.jetbrains.kotlin.fir.types.FirTypeRef;
import org.jetbrains.kotlin.fir.declarations.*;
import org.jetbrains.kotlin.fir.expressions.*;
import org.jetbrains.kotlin.diagnostics.DiagnosticReporter;
public final class VerifierKotlinRegistrar extends CompilerPluginRegistrar {
 public String getPluginId(){return "checktrail-original-participation";}
 public boolean getSupportsK2(){return true;}
 static void record(CheckerContext context,org.jetbrains.kotlin.fir.FirAnnotationContainer element,org.jetbrains.kotlin.fir.FirSession session,String kind){
  org.jetbrains.kotlin.KtSourceFile file=element instanceof FirFile?((FirFile)element).getSourceFile():context.getContainingFile();
  VerifierKotlin.observe(file,element,session,kind);
 }
 public void registerExtensions(ExtensionStorage storage,CompilerConfiguration config){
  if(++VerifierKotlin.registrations!=1)throw new IllegalStateException("Repeated original plugin registration");
  storage.registerExtension(org.jetbrains.kotlin.backend.common.extensions.IrGenerationExtension.Companion,(module,context)->VerifierKotlin.observeIr(module));
  storage.registerExtension(FirExtensionRegistrarAdapter.Companion,new FirExtensionRegistrar(){
   protected void configurePlugin(ExtensionRegistrarContext context){
    context.plusAdditionalCheckersExtension((kotlin.jvm.functions.Function1<org.jetbrains.kotlin.fir.FirSession,FirAdditionalCheckersExtension>)session->new FirAdditionalCheckersExtension(session){
     public DeclarationCheckers getDeclarationCheckers(){return new DeclarationCheckers(){
      public Set<FirDeclarationChecker<FirDeclaration>> getBasicDeclarationCheckers(){return Set.of(new FirDeclarationChecker<FirDeclaration>(MppCheckerKind.Common){
       public void check(CheckerContext context,DiagnosticReporter reporter,FirDeclaration declaration){record(context,declaration,session,"declaration");}
      });}
     };}
     public TypeCheckers getTypeCheckers(){return new TypeCheckers(){
      public Set<FirTypeChecker<FirTypeRef>> getTypeRefCheckers(){return Set.of(new FirTypeChecker<FirTypeRef>(MppCheckerKind.Common){
       public void check(CheckerContext context,DiagnosticReporter reporter,FirTypeRef type){record(context,type,session,"type");}
      });}
     };}
     public ExpressionCheckers getExpressionCheckers(){return new ExpressionCheckers(){
      public Set<FirExpressionChecker<FirStatement>> getBasicExpressionCheckers(){return Set.of(new FirExpressionChecker<FirStatement>(MppCheckerKind.Common){
       public void check(CheckerContext context,DiagnosticReporter reporter,FirStatement expression){record(context,expression,session,"expression");}
      });}
     };}
    });
   }
  });
 }
}
`;
