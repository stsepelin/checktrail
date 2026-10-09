// Selected Java source is compiled against fresh Kotlin output, without processors
// or implicit source lookup. Physical class origins supplement native task events.
export const kotlinJavaObserverSource = String.raw`import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.tools.*;
import javax.lang.model.element.*;
import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.lang.classfile.*;
public final class VerifierKotlinJava {
 static String q(String value){if(value==null)return "null";StringBuilder b=new StringBuilder("\"");for(char c:value.toCharArray()){if(c=='"'||c=='\\')b.append('\\').append(c);else if(c<32||Character.isSurrogate(c))b.append(String.format("\\u%04x",(int)c));else b.append(c);}return b.append('"').toString();}
 static String list(Collection<String> values){return "["+String.join(",",values.stream().sorted().map(VerifierKotlinJava::q).toList())+"]";}
 static String hash(byte[] bytes)throws Exception{return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));}
 static Path decode(String value){return Path.of(new String(Base64.getDecoder().decode(value),StandardCharsets.UTF_8)).toAbsolutePath().normalize();}
 static final class Source {
  final Path file;final byte[] bytes;int parsed=0,unknownAnnotations=0;
  final Set<String> declared=new TreeSet<>(),analyzed=new TreeSet<>(),annotations=new TreeSet<>();
  Source(Path value)throws Exception{file=value;if(!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS)||Files.isSymbolicLink(file)||Files.size(file)>1024*1024)throw new IOException("Selected Java source bound");bytes=Files.readAllBytes(file);}
 }
 public static void main(String[] args)throws Exception {
  if(args.length!=1)throw new IOException("Selected Java request");
  List<String> input=Files.readAllLines(Path.of(args[0]),StandardCharsets.UTF_8);int cursor=0;
  int release=Integer.parseInt(input.get(cursor++));if(!Set.of(17,21,25).contains(release))throw new IOException("Selected Java release");
  String warning=input.get(cursor++);if(!Set.of("true","false").contains(warning))throw new IOException("Selected Java warning policy");boolean strict=warning.equals("true");
  Path output=decode(input.get(cursor++));if(Files.isSymbolicLink(output)||!Files.isDirectory(output))throw new IOException("Selected Java output directory");
  int count=Integer.parseInt(input.get(cursor++));if(count<1||count>130)throw new IOException("Selected Java classpath bound");List<Path> classpath=new ArrayList<>();
  for(int i=0;i<count;i++)classpath.add(decode(input.get(cursor++)));
  int sourceCount=Integer.parseInt(input.get(cursor++));if(sourceCount<1||sourceCount>1000||input.size()!=cursor+sourceCount)throw new IOException("Selected Java input count");
  Map<String,Source> sources=new TreeMap<>();long total=0;
  for(int i=0;i<sourceCount;i++){Source source=new Source(decode(input.get(cursor++)));total+=source.bytes.length;if(total>32*1024*1024||sources.put(source.file.toString(),source)!=null)throw new IOException("Selected Java source inventory");}
  JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();if(compiler==null)throw new IOException("Full JDK required");
  List<Diagnostic<? extends JavaFileObject>> diagnostics=new ArrayList<>();DiagnosticListener<JavaFileObject> listener=d->{if(diagnostics.size()>=2000)throw new IllegalStateException("Selected Java diagnostic bound");diagnostics.add(d);};
  boolean success;int[] finished={0};StringWriter extra=new StringWriter();
  try(StandardJavaFileManager manager=compiler.getStandardFileManager(listener,Locale.ROOT,StandardCharsets.UTF_8)){
   manager.setLocationFromPaths(StandardLocation.CLASS_PATH,classpath);manager.setLocationFromPaths(StandardLocation.SOURCE_PATH,List.of());manager.setLocationFromPaths(StandardLocation.ANNOTATION_PROCESSOR_PATH,List.of());manager.setLocationFromPaths(StandardLocation.CLASS_OUTPUT,List.of(output));
   List<String> options=new ArrayList<>(List.of("--release",Integer.toString(release),"-encoding","UTF-8","-proc:none","-implicit:none","-Xlint:all","-Xmaxerrs","2000","-Xmaxwarns","2000"));if(strict)options.add("-Werror");
   JavacTask task=(JavacTask)compiler.getTask(extra,manager,listener,options,null,manager.getJavaFileObjectsFromPaths(sources.values().stream().map(s->s.file).toList()));Trees trees=Trees.instance(task);
   task.addTaskListener(new TaskListener(){public void finished(TaskEvent event){
    if(event.getKind()==TaskEvent.Kind.COMPILATION)finished[0]++;
    if(event.getSourceFile()==null)return;String file=Path.of(event.getSourceFile().toUri()).toAbsolutePath().normalize().toString();Source source=sources.get(file);if(source==null)throw new IllegalStateException("Undeclared Java compiler input");
    if(event.getKind()==TaskEvent.Kind.PARSE){if(++source.parsed>1)throw new IllegalStateException("Repeated selected Java parse");CompilationUnitTree unit=event.getCompilationUnit();String prefix=unit.getPackageName()==null?"":unit.getPackageName().toString()+".";for(Tree tree:unit.getTypeDecls())if(tree instanceof ClassTree type)source.declared.add(prefix+type.getSimpleName());}
    if(event.getKind()==TaskEvent.Kind.ANALYZE&&event.getTypeElement()!=null){source.analyzed.add(event.getTypeElement().getQualifiedName().toString());CompilationUnitTree unit=event.getCompilationUnit();new TreeScanner<Void,Void>(){public Void visitAnnotation(AnnotationTree annotation,Void ignored){Element element=trees.getElement(TreePath.getPath(unit,annotation.getAnnotationType()));if(element instanceof TypeElement type)source.annotations.add(type.getQualifiedName().toString());else source.unknownAnnotations++;return super.visitAnnotation(annotation,ignored);}}.scan(unit,null);}
   }});success=task.call();
  }
  List<String> observed=new ArrayList<>(),messages=new ArrayList<>(),classes=new ArrayList<>();
  for(Source source:sources.values()){
   byte[] after=Files.readAllBytes(source.file);if(!Arrays.equals(source.bytes,after))throw new IOException("Selected Java source changed during compilation");
   observed.add("{\"file\":"+q(source.file.toString())+",\"sha256\":"+q(hash(source.bytes))+",\"bytes\":"+source.bytes.length+",\"parsed\":"+source.parsed+",\"declared\":"+list(source.declared)+",\"analyzed\":"+list(source.analyzed)+",\"annotations\":"+list(source.annotations)+",\"unknownAnnotations\":"+source.unknownAnnotations+"}");
  }
  for(var diagnostic:diagnostics)messages.add("{\"kind\":"+q(diagnostic.getKind().name())+",\"code\":"+q(diagnostic.getCode())+",\"message\":"+q(diagnostic.getMessage(Locale.ROOT))+",\"file\":"+q(diagnostic.getSource()==null?null:Path.of(diagnostic.getSource().toUri()).toAbsolutePath().normalize().toString())+",\"line\":"+diagnostic.getLineNumber()+",\"column\":"+diagnostic.getColumnNumber()+"}");
  long classBytes=0;int paths=0;
  try(var walk=Files.walk(output)){var iterator=walk.iterator();while(iterator.hasNext()){
   Path file=iterator.next();if(++paths>10000||Files.isSymbolicLink(file))throw new IOException("Selected Java output inventory");if(Files.isDirectory(file))continue;
   if(!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS)||!file.toString().endsWith(".class")||Files.size(file)>1024*1024||classes.size()>=4000)throw new IOException("Selected Java class file bound");byte[] bytes=Files.readAllBytes(file);classBytes+=bytes.length;if(classBytes>64*1024*1024)throw new IOException("Selected Java total output bound");var model=ClassFile.of().parse(bytes);String name=model.thisClass().asInternalName().replace('/','.');String origin=model.findAttribute(Attributes.sourceFile()).orElseThrow().sourceFile().stringValue();
   classes.add("{\"file\":"+q(output.relativize(file).toString())+",\"className\":"+q(name)+",\"sourceFile\":"+q(origin)+",\"classMajor\":"+model.majorVersion()+",\"sha256\":"+q(hash(bytes))+",\"bytes\":"+bytes.length+"}");
  }}
  String result="{\"schemaVersion\":1,\"runtime\":"+q(Runtime.version().toString())+",\"vendor\":"+q(System.getProperty("java.vendor"))+",\"success\":"+success+",\"finished\":"+finished[0]+",\"extra\":"+q(extra.toString())+",\"sources\":["+String.join(",",observed)+"],\"diagnostics\":["+String.join(",",messages)+"],\"classes\":["+String.join(",",classes)+"]}";
  if(result.getBytes(StandardCharsets.UTF_8).length>2*1024*1024)throw new IOException("Selected Java evidence bound");System.out.println(result);
 }
}`;
