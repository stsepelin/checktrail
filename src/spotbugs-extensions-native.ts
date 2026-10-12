import { spotbugsNativeSource } from "./spotbugs-native.js";
function replace(source: string, anchor: string, value: string) {
  if (source.split(anchor).length !== 2)
    throw Error("SpotBugs extension observer anchor is not unique");
  return source.replace(anchor, value);
}
let native = replace(
  spotbugsNativeSource,
  "class VerifierSpotbugs {",
  "class VerifierSpotbugs {\n  static class SelectedFactories extends DetectorFactoryCollection { SelectedFactories(Collection<Plugin> plugins) { super(plugins); } }",
);
native = replace(
  native,
  "project.addFile(Path.of(args[1]).resolve(name.replace('.', '/') + \".class\").toString());",
  'project.addFile(item.get("output").getAsString());',
);
native = replace(
  native,
  "DetectorFactoryCollection factories = new DetectorFactoryCollection(core);",
  String.raw`List<Plugin> plugins = new ArrayList<>();
    Set<String> identities = new HashSet<>(Set.of(core.getPluginId()));
    for (JsonElement value : input.getAsJsonArray("plugins")) {
      Plugin plugin = Plugin.loadCustomPlugin(new File(value.getAsString()), project);
      if (!identities.add(plugin.getPluginId()) || plugin.isCorePlugin()) throw new IOException("Duplicate plugin identity");
      plugin.setGloballyEnabled(true); plugins.add(plugin);
    }
    DetectorFactoryCollection factories = new SelectedFactories(plugins);
    DetectorFactoryCollection.resetInstance(factories);
    Map<String, Plugin> providers = new TreeMap<>();
    List<Plugin> allPlugins = new ArrayList<>(); allPlugins.add(core); allPlugins.addAll(plugins);
    JsonArray patterns = new JsonArray();
    for (Plugin plugin : allPlugins) for (BugPattern pattern : plugin.getBugPatterns().stream().sorted(Comparator.comparing(BugPattern::getType)).toList()) {
      if (providers.put(pattern.getType(), plugin) != null) throw new IOException("Ambiguous rule provider");
      JsonObject item = new JsonObject(); item.addProperty("plugin", plugin.getPluginId()); item.addProperty("type", pattern.getType());
      item.addProperty("abbreviation", pattern.getAbbrev()); item.addProperty("category", pattern.getCategory()); patterns.add(item);
    }`,
);
native = replace(
  native,
  'item.addProperty("message", bug.getMessageWithoutPrefix()); bugs.add(item);',
  String.raw`Plugin provider = providers.get(bug.getType());
      if (provider == null || bug.getBugPattern() == null || !provider.getBugPatterns().contains(bug.getBugPattern())) throw new IOException("Unbound native rule");
      item.addProperty("provider", provider.getPluginId()); item.addProperty("abbreviation", bug.getBugPattern().getAbbrev()); item.addProperty("category", bug.getBugPattern().getCategory());
      item.addProperty("message", bug.getMessageWithoutPrefix()); bugs.add(item);`,
);
native = replace(
  native,
  'result.addProperty("messages", messages.toString());',
  String.raw`JsonArray provenance = new JsonArray(); Set<String> factoryNames = new HashSet<>();
    for (DetectorFactory factory : factories.getFactories()) {
      if (!factoryNames.add(factory.getFullName())) throw new IOException("Ambiguous detector class");
      JsonObject item = new JsonObject(); item.addProperty("detector", factory.getFullName()); item.addProperty("plugin", factory.getPlugin().getPluginId());
      item.addProperty("enabled", preferences.isDetectorEnabled(factory)); item.addProperty("defaultEnabled", factory.isDefaultEnabled());
      Class<?> implementation = factory.getPlugin().getClassLoader().loadClass(factory.getFullName());
      item.addProperty("origin", implementation.getProtectionDomain().getCodeSource().getLocation().toString());
      provenance.add(item);
    }
    result.add("provenance", provenance); result.add("patterns", patterns); result.addProperty("corePlugin", core.getPluginId());
    result.addProperty("messages", messages.toString());`,
);
export const spotbugsExtensionsNativeSource = native;
