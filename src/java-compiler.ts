export const javaCompilerSource = String.raw`
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import javax.tools.*;
import com.sun.source.tree.*;
import com.sun.source.util.*;

class VerifierCompiler {
  static String quote(String value) {
    if (value == null) return "null";
    StringBuilder out = new StringBuilder("\"");
    for (char c : value.toCharArray()) {
      if (c == '"' || c == '\\') out.append('\\').append(c);
      else if (c < 32 || Character.isSurrogate(c)) out.append(String.format("\\u%04x", (int)c));
      else out.append(c);
    }
    return out.append('"').toString();
  }
  static String strings(Collection<String> values) {
    return "[" + String.join(",", values.stream().map(VerifierCompiler::quote).toList()) + "]";
  }
  public static void main(String[] args) throws Exception {
    List<String> input = Files.readAllLines(Path.of(args[0]), StandardCharsets.UTF_8);
    int release = Integer.parseInt(input.get(0));
    boolean strict = Boolean.parseBoolean(input.get(1));
    int count = Integer.parseInt(input.get(2));
    List<Path> jars = new ArrayList<>();
    for (int i = 0; i < count; i++) {
      Path jar = Path.of(new String(Base64.getDecoder().decode(input.get(3 + i)), StandardCharsets.UTF_8));
      try (JarFile archive = new JarFile(jar.toFile())) {
        if (archive.getManifest() != null && archive.getManifest().getMainAttributes().getValue(Attributes.Name.CLASS_PATH) != null)
          throw new IOException("Implicit JAR classpath is unsupported");
        if (archive.stream().anyMatch(entry -> entry.getName().endsWith(".java")))
          throw new IOException("Source-bearing JARs are unsupported");
      }
      jars.add(jar);
    }
    List<Path> sources = new ArrayList<>();
    for (int i = 3 + count; i < input.size(); i++)
      sources.add(Path.of(new String(Base64.getDecoder().decode(input.get(i)), StandardCharsets.UTF_8)));
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) throw new IOException("Full JDK required");
    List<Diagnostic<? extends JavaFileObject>> diagnostics = new ArrayList<>();
    DiagnosticListener<JavaFileObject> listener = diagnostic -> {
      if (diagnostics.size() >= 2000) throw new IllegalStateException("Diagnostic limit exceeded");
      diagnostics.add(diagnostic);
    };
    try (StandardJavaFileManager standard = compiler.getStandardFileManager(listener, Locale.ROOT, StandardCharsets.UTF_8)) {
      standard.setLocationFromPaths(StandardLocation.CLASS_PATH, jars);
      standard.setLocationFromPaths(StandardLocation.SOURCE_PATH, List.of());
      standard.setLocationFromPaths(StandardLocation.ANNOTATION_PROCESSOR_PATH, List.of());
      long[] bytes = {0};
      JavaFileManager manager = new ForwardingJavaFileManager<StandardJavaFileManager>(standard) {
        @Override public JavaFileObject getJavaFileForOutput(Location location, String name, JavaFileObject.Kind kind, FileObject sibling) throws IOException {
          if (location != StandardLocation.CLASS_OUTPUT || kind != JavaFileObject.Kind.CLASS)
            throw new IOException("Unexpected compiler output");
          return new SimpleJavaFileObject(URI.create("memory:///" + name.replace('.', '/') + kind.extension), kind) {
            @Override public OutputStream openOutputStream() {
              return new OutputStream() {
                public void write(int value) throws IOException {
                  if (++bytes[0] > 32 * 1024 * 1024) throw new IOException("Output limit exceeded");
                }
                public void write(byte[] value, int offset, int length) throws IOException {
                  bytes[0] += length;
                  if (bytes[0] > 32 * 1024 * 1024) throw new IOException("Output limit exceeded");
                }
              };
            }
          };
        }
      };
      List<String> options = new ArrayList<>(List.of("--release", Integer.toString(release), "-encoding", "UTF-8", "-proc:none", "-implicit:none", "-Xlint:all", "-Xmaxerrs", "2000", "-Xmaxwarns", "2000"));
      if (strict) options.add("-Werror");
      StringWriter extra = new StringWriter();
      JavacTask task = (JavacTask)compiler.getTask(extra, manager, listener, options, null, standard.getJavaFileObjectsFromPaths(sources));
      Map<String, Integer> parsed = new TreeMap<>();
      Map<String, Set<String>> declared = new TreeMap<>();
      Map<String, Set<String>> analyzed = new TreeMap<>();
      int[] finished = {0};
      task.addTaskListener(new TaskListener() {
        @Override public void finished(TaskEvent event) {
          if (event.getKind() == TaskEvent.Kind.COMPILATION) finished[0]++;
          if (event.getSourceFile() == null) return;
          String file = Path.of(event.getSourceFile().toUri()).toAbsolutePath().normalize().toString();
          if (event.getKind() == TaskEvent.Kind.PARSE) {
            parsed.merge(file, 1, Integer::sum);
            Set<String> types = declared.computeIfAbsent(file, key -> new TreeSet<>());
            CompilationUnitTree unit = event.getCompilationUnit();
            String prefix = unit.getPackageName() == null ? "" : unit.getPackageName().toString() + ".";
            for (Tree tree : unit.getTypeDecls()) if (tree instanceof ClassTree type)
              types.add(prefix + type.getSimpleName());
          }
          if (event.getKind() == TaskEvent.Kind.ANALYZE && event.getTypeElement() != null)
            analyzed.computeIfAbsent(file, key -> new TreeSet<>()).add(event.getTypeElement().getQualifiedName().toString());
        }
      });
      boolean success = task.call();
      List<String> observations = new ArrayList<>();
      for (String file : parsed.keySet()) observations.add("{\"file\":" + quote(file) + ",\"parsed\":" + parsed.get(file) + ",\"declared\":" + strings(declared.getOrDefault(file, Set.of())) + ",\"analyzed\":" + strings(analyzed.getOrDefault(file, Set.of())) + "}");
      List<String> messages = new ArrayList<>();
      for (Diagnostic<? extends JavaFileObject> item : diagnostics) messages.add("{\"kind\":" + quote(item.getKind().name()) + ",\"code\":" + quote(item.getCode()) + ",\"message\":" + quote(item.getMessage(Locale.ROOT)) + ",\"file\":" + quote(item.getSource() == null ? null : Path.of(item.getSource().toUri()).toAbsolutePath().normalize().toString()) + ",\"line\":" + item.getLineNumber() + "}");
      System.out.print("{\"version\":1,\"runtime\":" + quote(Runtime.version().toString()) + ",\"vendor\":" + quote(System.getProperty("java.vendor")) + ",\"success\":" + success + ",\"finished\":" + finished[0] + ",\"extra\":" + quote(extra.toString()) + ",\"sources\":[" + String.join(",", observations) + "],\"diagnostics\":[" + String.join(",", messages) + "]}");
    }
  }
}
`;
