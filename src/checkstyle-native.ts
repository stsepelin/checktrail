export const checkstyleNativeSource = String.raw`
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import com.puppycrawl.tools.checkstyle.*;
import com.puppycrawl.tools.checkstyle.api.*;

class VerifierCheckstyle implements AuditListener {
  final List<String> events = new ArrayList<>();
  final List<String> diagnostics = new ArrayList<>();
  final List<String> exceptions = new ArrayList<>();
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
  void event(String kind, AuditEvent event) {
    if (events.size() >= 40002) throw new IllegalStateException("Audit event limit");
    events.add("{\"kind\":"+quote(kind)+",\"file\":"+quote(event.getFileName())+"}");
  }
  public void auditStarted(AuditEvent event) { event("audit-started", event); }
  public void auditFinished(AuditEvent event) { event("audit-finished", event); }
  public void fileStarted(AuditEvent event) { event("file-started", event); }
  public void fileFinished(AuditEvent event) { event("file-finished", event); }
  public void addError(AuditEvent event) {
    if (diagnostics.size() >= 2000) throw new IllegalStateException("Diagnostic limit");
    diagnostics.add("{\"file\":"+quote(event.getFileName())+",\"line\":"+event.getLine()+",\"column\":"+event.getColumn()+",\"severity\":"+quote(event.getSeverityLevel().getName())+",\"source\":"+quote(event.getSourceName())+",\"moduleId\":"+quote(event.getModuleId())+",\"message\":"+quote(event.getMessage())+"}");
  }
  public void addException(AuditEvent event, Throwable error) {
    if (exceptions.size() >= 2000) throw new IllegalStateException("Exception limit");
    exceptions.add("{\"file\":"+quote(event.getFileName())+",\"type\":"+quote(error.getClass().getName())+"}");
  }
  static String configuration(Configuration config) throws Exception {
    List<String> properties = new ArrayList<>();
    for (String name : config.getPropertyNames()) properties.add("{\"name\":"+quote(name)+",\"value\":"+quote(config.getProperty(name))+"}");
    List<String> children = new ArrayList<>();
    for (Configuration child : config.getChildren()) children.add(configuration(child));
    return "{\"name\":"+quote(config.getName())+",\"properties\":["+String.join(",",properties)+"],\"children\":["+String.join(",",children)+"]}";
  }
  static final List<String> rules = new ArrayList<>();
  static void validateModules(Configuration configuration, ModuleFactory factory, boolean root) throws Exception {
    for (Configuration child : configuration.getChildren()) {
      Object instance = factory.createModule(child.getName());
      String name = instance.getClass().getName();
      if (!name.startsWith("com.puppycrawl.tools.checkstyle.checks.") && instance.getClass() != TreeWalker.class)
        throw new IllegalStateException("Only pinned built-in checks are supported");
      if (instance.getClass() == TreeWalker.class) {
        if (!root) throw new IllegalStateException("Invalid TreeWalker assembly");
        validateModules(child, factory, false);
      } else {
        if (instance instanceof AbstractCheck && !root) {
          if (name.equals("com.puppycrawl.tools.checkstyle.checks.SuppressWarningsHolder")) throw new IllegalStateException("Suppression holders are not active rules");
          AbstractCheck check = (AbstractCheck)instance;
          check.configure(child);
          if (check.getDefaultTokens().length == 0 && check.getRequiredTokens().length == 0 && check.getTokenNames().isEmpty()) throw new IllegalStateException("No registered check tokens");
        } else if (instance instanceof AbstractFileSetCheck && root) {
          AbstractFileSetCheck check = (AbstractFileSetCheck)instance;
          check.configure(child);
          String[] extensions = check.getFileExtensions();
          if (extensions != null && extensions.length != 0 && Arrays.stream(extensions).noneMatch(value -> value.equals(".java") || value.equals("java"))) throw new IllegalStateException("Inactive Java check");
        } else throw new IllegalStateException("Filters and unsupported check types cannot establish validation");
        rules.add("{\"name\":"+quote(child.getName())+",\"type\":"+quote(name)+",\"moduleId\":"+quote(Arrays.asList(child.getPropertyNames()).contains("id") ? child.getProperty("id") : null)+"}");
      }
    }
  }
  public static void main(String[] args) throws Exception {
    List<String> inputs = Files.readAllLines(Path.of(args[0]), StandardCharsets.UTF_8);
    Configuration config = ConfigurationLoader.loadConfiguration(inputs.get(0), new PropertiesExpander(new Properties()), ConfigurationLoader.IgnoredModulesOptions.EXECUTE);
    List<File> files = new ArrayList<>();
    for (int i=1;i<inputs.size();i++) files.add(new File(new String(Base64.getDecoder().decode(inputs.get(i)), StandardCharsets.UTF_8)));
    ModuleFactory factory = new PackageObjectFactory(PackageNamesLoader.getPackageNames(Checker.class.getClassLoader()), Checker.class.getClassLoader());
    validateModules(config, factory, true);
    if (rules.isEmpty()) throw new IllegalStateException("No active configured rules");
    Checker checker = new Checker();
    VerifierCheckstyle listener = new VerifierCheckstyle();
    int errors;
    try {
      checker.setModuleClassLoader(Checker.class.getClassLoader());
      checker.addListener(listener);
      checker.configure(config);
      errors = checker.process(files);
    } finally { checker.destroy(); }
    System.out.print("{\"version\":1,\"runtime\":"+quote(Runtime.version().toString())+",\"vendor\":"+quote(System.getProperty("java.vendor"))+",\"checkstyle\":"+quote(Checker.class.getPackage().getImplementationVersion())+",\"configuration\":"+configuration(config)+",\"rules\":["+String.join(",",rules)+"],\"nativeErrors\":"+errors+",\"events\":["+String.join(",",listener.events)+"],\"diagnostics\":["+String.join(",",listener.diagnostics)+"],\"exceptions\":["+String.join(",",listener.exceptions)+"]}");
  }
}
`;
