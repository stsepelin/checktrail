import { detektNativeSource } from "./detekt-native.js";
const typed = String.raw`
  final List<String> typedSources = new ArrayList<>();
  void typed(KtFile f) {
    org.jetbrains.kotlin.analysis.api.AnalyzeKt.analyze(f, session -> {
      if (!(session.getUseSiteModule() instanceof org.jetbrains.kotlin.analysis.api.projectStructure.KaSourceModule source))
        throw new IllegalStateException("Expected native source module");
      List<String> roots = new ArrayList<>(), sdk = new ArrayList<>(), diagnostics = new ArrayList<>(), symbols = new ArrayList<>();
      Set<String> annotations = new TreeSet<>(); int unknownAnnotations = 0;
      for (var m:source.getDirectRegularDependencies()) {
        if (!(m instanceof org.jetbrains.kotlin.analysis.api.projectStructure.KaLibraryModule library))
          throw new IllegalStateException("Unexpected native module dependency");
        for (var root:library.getBinaryRoots()) {
          if (library.isSdk()) sdk.add(q(root.toString())); else roots.add(q(root.toString()));
          if (roots.size()+sdk.size()>256) throw new IllegalStateException("Native module root bound");
        }
      }
      for(var d:session.collectDiagnostics(f,org.jetbrains.kotlin.analysis.api.components.KaDiagnosticCheckerFilter.EXTENDED_AND_COMMON_CHECKERS)) {
        if(diagnostics.size()>=2000)throw new IllegalStateException("Native type diagnostic bound");
        if(d.getPsi().getContainingFile()!=f)throw new IllegalStateException("Foreign native type diagnostic");
        var range=d.getPsi().getTextRange(); int offset=range.getStartOffset(); var document=f.getViewProvider().getDocument();
        if(document==null||offset<0||offset>document.getTextLength())throw new IllegalStateException("Native diagnostic position");
        int line=document.getLineNumber(offset); int column=offset-document.getLineStartOffset(line);
        diagnostics.add("{\"code\":"+q(d.getFactoryName())+",\"severity\":"+q(d.getSeverity().name())+",\"message\":"+q(d.getDefaultMessage())+",\"line\":"+(line+1)+",\"column\":"+(column+1)+"}");
      }
      for(var declaration:f.getDeclarations()) {
        if(symbols.size()>=2000)throw new IllegalStateException("Native declaration bound");
        var symbol=session.getSymbol(declaration);
        symbols.add(q(symbol.getOrigin().name()));
      }
      List<org.jetbrains.kotlin.analysis.api.annotations.KaAnnotation> observed = new ArrayList<>(session.getSymbol(f).getAnnotations());
      for(var declaration:PsiTreeUtil.collectElementsOfType(f,KtDeclaration.class))
        if(!declaration.getAnnotationEntries().isEmpty()) observed.addAll(session.getSymbol(declaration).getAnnotations());
      if(observed.size()>2000)throw new IllegalStateException("Native annotation bound");
      for(var annotation:observed) {
        if(annotation.getClassId()==null)unknownAnnotations++;
        else annotations.add(annotation.getClassId().asSingleFqName().asString());
      }
      typedSources.add("{\"file\":"+q(file(f))+",\"visits\":1,\"languageVersion\":"+q(source.getLanguageVersionSettings().getLanguageVersion().getVersionString())+",\"apiVersion\":"+q(source.getLanguageVersionSettings().getApiVersion().getVersionString())+",\"roots\":["+String.join(",",roots)+"],\"sdk\":["+String.join(",",sdk)+"],\"declarations\":"+f.getDeclarations().size()+",\"symbols\":["+String.join(",",symbols)+"],\"annotations\":["+String.join(",",annotations.stream().map(VerifierDetekt::q).toList())+"],\"unknownAnnotations\":"+unknownAnnotations+",\"diagnostics\":["+String.join(",",diagnostics)+"]}");
      return kotlin.Unit.INSTANCE;
    });
  }
`;
const rule = String.raw`for(RuleDescriptor d:descriptors){RuleInstance r=d.getRuleInstance();Rule instance=d.getRuleProvider().invoke(d.getConfig());Class<?> type=instance.getClass();String origin=type.getProtectionDomain().getCodeSource().getLocation().toString();rules.add("{\"set\":"+q(r.getRuleSetId().getValue())+",\"id\":"+q(r.getId())+",\"active\":"+r.getActive()+",\"severity\":"+q(r.getSeverity().name())+",\"className\":"+q(type.getName())+",\"requiresAnalysisApi\":"+(instance instanceof RequiresAnalysisApi)+",\"origin\":"+q(origin)+"}");}`;
const originalRule = String.raw`for(RuleDescriptor d:descriptors){RuleInstance r=d.getRuleInstance();rules.add("{\"set\":"+q(r.getRuleSetId().getValue())+",\"id\":"+q(r.getId())+",\"active\":"+r.getActive()+",\"severity\":"+q(r.getSeverity().name())+"}");}`;
function replaceNative(source: string, before: string, after: string) {
  if (source.split(before).length !== 2)
    throw Error("Full detekt native observer anchor changed");
  return source.replace(before, after);
}
export const detektExtensionsNativeSource = [
  ["SetupContext context;", typed + "\nSetupContext context;"],
  ["AnalysisMode.light", "AnalysisMode.full"],
  ["for(KtFile f:files){", "for(KtFile f:files){typed(f);"],
  [originalRule, rule],
  [
    "try{if(out.getBytes",
    String.raw`out=out.substring(0,out.length()-1)+",\"typed\":["+String.join(",",typedSources)+"]}";try{if(out.getBytes`,
  ],
].reduce(
  (source, [before, after]) => replaceNative(source, before!, after!),
  detektNativeSource,
);
