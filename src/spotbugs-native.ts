export const spotbugsNativeSource = String.raw`
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import com.google.gson.*;
import edu.umd.cs.findbugs.*;
import edu.umd.cs.findbugs.classfile.*;
import edu.umd.cs.findbugs.config.*;

class VerifierSpotbugs {
  static class Progress implements FindBugsProgress, IClassObserver {
    int[] predicted;
    JsonArray passes = new JsonArray();
    JsonArray effective = new JsonArray();
    JsonObject current;
    JsonArray classes;
    String pending;
    int finished;
    Set<String> selected;
    Set<String> oversized = new TreeSet<>();
    Progress(Set<String> names) { selected = names; }
    public void reportNumberOfArchives(int count) {}
    public void startArchive(String name) {}
    public void finishArchive() {}
    public void predictPassCount(int[] counts) { if (predicted != null) throw new IllegalStateException("Duplicate pass prediction"); predicted = counts.clone();
      {
        edu.umd.cs.findbugs.plan.ExecutionPlan plan = Global.getAnalysisCache().getDatabase(edu.umd.cs.findbugs.plan.ExecutionPlan.class);
        for (Iterator<edu.umd.cs.findbugs.plan.AnalysisPass> iterator = plan.passIterator(); iterator.hasNext();) {
          edu.umd.cs.findbugs.plan.AnalysisPass pass = iterator.next();
          if (!pass.getUnpositionedMembers().isEmpty()) throw new IllegalStateException("Unpositioned detector");
          List<String> active = new ArrayList<>();
          pass.iterator().forEachRemaining(factory -> active.add(factory.getFullName()));
          Collections.sort(active); effective.add(new Gson().toJsonTree(active));
        }
      }
    }
    public void startAnalysis(int count) {
      if (current != null) throw new IllegalStateException("Interleaved passes");
      current = new JsonObject(); current.addProperty("expected", count);
      classes = new JsonArray(); finished = 0;
    }
    public void observeClass(ClassDescriptor value) {
      if (current == null || pending != null) throw new IllegalStateException("Unbound class observation");
      pending = value.getDottedClassName();
      if (selected.contains(pending) && edu.umd.cs.findbugs.ba.AnalysisContext.currentAnalysisContext().isTooBig(value)) oversized.add(pending);
    }
    public void finishClass() {
      if (pending == null) throw new IllegalStateException("Missing class observation");
      classes.add(pending); pending = null; finished++;
    }
    public void finishPerClassAnalysis() {
      if (current == null || pending != null) throw new IllegalStateException("Incomplete pass");
      current.add("classes", classes); current.addProperty("finished", finished);
      passes.add(current); current = null;
    }
  }
  static class Reporter extends BugCollectionBugReporter {
    JsonArray skipped = new JsonArray();
    Reporter(Project project, PrintWriter writer) { super(project, writer); }
    @Override public void reportSkippedAnalysis(MethodDescriptor method) {
      skipped.add(method.toString()); super.reportSkippedAnalysis(method);
    }
  }
  public static void main(String[] args) throws Exception {
    JsonObject input = JsonParser.parseString(Files.readString(Path.of(args[0]), StandardCharsets.UTF_8)).getAsJsonObject();
    JsonArray compiled = input.getAsJsonArray("classes");
    Map<String, JsonObject> sources = new TreeMap<>();
    Project project = new Project();
    for (JsonElement element : compiled) {
      JsonObject item = element.getAsJsonObject();
      String name = item.get("name").getAsString();
      if (sources.put(name, item) != null) throw new IOException("Duplicate class");
      project.addFile(Path.of(args[1]).resolve(name.replace('.', '/') + ".class").toString());
    }
    for (int i = 2; i < args.length; i++) project.addAuxClasspathEntry(args[i]);
    StringWriter messages = new StringWriter();
    Reporter reporter = new Reporter(project, new PrintWriter(messages));
    reporter.setPriorityThreshold(3); reporter.setRankThreshold(20);
    reporter.setApplySuppressions(false);
    Plugin core = DetectorFactoryCollection.instance().getCorePlugin();
    int originalFactories = core.getDetectorFactories().size();
    core.getDetectorFactories().removeIf(factory -> factory.getFullName().equals("edu.umd.cs.findbugs.detect.NoteSuppressedWarnings"));
    if (core.getDetectorFactories().size() != originalFactories - 1) throw new IOException("Unexpected suppression collector assembly");
    DetectorFactoryCollection factories = new DetectorFactoryCollection(core);
    UserPreferences preferences = UserPreferences.createDefaultUserPreferences();
    preferences.setEffort(UserPreferences.EFFORT_MAX); preferences.setUserDetectorThreshold(3);
    preferences.setMergeSimilarWarnings(false);
    List<String> detectors = new ArrayList<>();
    for (DetectorFactory factory : factories.getFactories()) if (preferences.isDetectorEnabled(factory) && factory.isEnabledForCurrentJRE()) detectors.add(factory.getFullName());
    Collections.sort(detectors);
    Progress progress = new Progress(sources.keySet());
    int errors, missing;
    try (FindBugs2 engine = new FindBugs2()) {
      engine.setProject(project); engine.setDetectorFactoryCollection(factories);
      engine.setUserPreferences(preferences); engine.setAnalysisFeatureSettings(preferences.getAnalysisFeatureSettings());
      engine.setBugReporter(reporter); engine.setApplySuppression(false);
      engine.setMergeSimilarWarnings(false); engine.setRankThreshold(20);
      engine.setScanNestedArchives(false); engine.setNoClassOk(false);
      engine.setBugReporterDecorators(Set.of(), Set.of());
      engine.setProgressCallback(progress); engine.addClassObserver(progress);
      engine.execute();
      errors = engine.getErrorCount(); missing = engine.getMissingClassCount();
    }
    SortedBugCollection collection = (SortedBugCollection) reporter.getBugCollection();
    JsonArray stats = new JsonArray();
    for (PackageStats pkg : collection.getProjectStats().getPackageStats()) for (PackageStats.ClassStats item : pkg.getClassStats()) {
      JsonObject stat = new JsonObject(); stat.addProperty("name", item.getName()); stat.addProperty("source", item.getSourceFile()); stats.add(stat);
    }
    JsonArray bugs = new JsonArray();
    for (BugInstance bug : collection) {
      if (bugs.size() >= 2000) throw new IOException("Diagnostic bound exceeded");
      SourceLineAnnotation location = bug.getPrimarySourceLineAnnotation();
      JsonObject item = new JsonObject();
      item.addProperty("type", bug.getType()); item.addProperty("priority", bug.getPriority()); item.addProperty("rank", bug.getBugRank());
      item.addProperty("className", location.getClassName()); item.addProperty("source", location.getSourceFile());
      item.addProperty("line", location.getStartLine()); item.addProperty("endLine", location.getEndLine());
      item.addProperty("message", bug.getMessageWithoutPrefix()); bugs.add(item);
    }
    JsonArray errorMessages = new JsonArray();
    for (AnalysisError error : collection.getErrors()) errorMessages.add(error.getMessage());
    JsonArray missingClasses = new JsonArray();
    collection.missingClassIterator().forEachRemaining(missingClasses::add);
    JsonObject result = new JsonObject();
    result.addProperty("version", 1); result.addProperty("runtime", Runtime.version().toString());
    result.addProperty("vendor", System.getProperty("java.vendor")); result.addProperty("spotbugs", Version.VERSION_STRING);
    result.addProperty("completed", progress.current == null && progress.pending == null);
    result.add("detectors", new Gson().toJsonTree(detectors)); result.add("predicted", new Gson().toJsonTree(progress.predicted));
    result.add("passes", progress.passes); result.add("effective", progress.effective); result.add("stats", stats); result.add("bugs", bugs);
    result.addProperty("errors", errors); result.addProperty("missing", missing);
    result.add("errorMessages", errorMessages); result.add("missingClasses", missingClasses); result.add("skipped", reporter.skipped); result.add("oversized", new Gson().toJsonTree(progress.oversized));
    result.addProperty("messages", messages.toString());
    System.out.print(new Gson().toJson(result));
  }
}
`;
