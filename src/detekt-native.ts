export const detektNativeSource = String.raw`
import dev.detekt.api.*;
import dev.detekt.core.RuleDescriptor;
import dev.detekt.core.RuleDescriptorKt;
import dev.detekt.core.util.ConfigExtensionsKt;
import dev.detekt.core.suppressors.SuppressionsKt;
import dev.detekt.tooling.api.AnalysisMode;
import org.jetbrains.kotlin.psi.*;
import com.intellij.psi.PsiErrorElement;
import com.intellij.psi.util.PsiTreeUtil;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
public final class VerifierDetekt implements FileProcessListener {
  SetupContext context; final List<String> events=new ArrayList<>();
  final Map<String,String> physical = new TreeMap<>();
  final List<KtFile> files=new ArrayList<>();
  public String getId(){return "ChecktrailDetektParticipationV1";}
  public void init(SetupContext value){if(context!=null)throw new IllegalStateException("Duplicate init");context=value;}
  static String q(String s){if(s==null)return "null";StringBuilder b=new StringBuilder("\"");for(char c:s.toCharArray()){if(c=='"'||c=='\\')b.append('\\').append(c);else if(c<32||Character.isSurrogate(c))b.append(String.format("\\u%04x",(int)c));else b.append(c);}return b.append('"').toString();}
  static String sha(byte[] b){try{return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(b));}catch(Exception e){throw new IllegalStateException(e);}}
  static String file(KtFile f){return dev.detekt.psi.KtFilesKt.absolutePath(f).toString();}
  void event(String name,KtFile f){events.add("{\"kind\":"+q(name)+",\"file\":"+q(f==null?null:file(f))+"}");}
  public void onStart(List<? extends KtFile> value){files.addAll(value);event("analysis-started",null);}
  public void onProcess(KtFile f){
    event("file-started",f);
    try { byte[] bytes=Files.readAllBytes(Path.of(file(f))); if(bytes.length>1024*1024)throw new IllegalStateException("Source byte bound"); physical.put(file(f),sha(bytes)); }
    catch(Exception error){throw new IllegalStateException("Physical source could not be read",error);}
  }
  public void onProcessComplete(KtFile f,List<Issue> issues){event("file-finished",f);}
  public Detektion onFinish(List<? extends KtFile> value,Detektion data){
    if(value.size()!=files.size() || files.size()>2000 || !new HashSet<>(value).equals(new HashSet<>(files)))throw new IllegalStateException("Native source inventory disagreement");
    if(data.getIssues().size()>2000)throw new IllegalStateException("Finding bound");
    event("analysis-finished",null);
    List<RuleSetProvider> providers=new ArrayList<>();ServiceLoader.load(RuleSetProvider.class).forEach(providers::add);
    List<RuleDescriptor> descriptors=RuleDescriptorKt.getRules(AnalysisMode.light,providers,context.getConfig(),s->kotlin.Unit.INSTANCE);
    if(!descriptors.stream().map(RuleDescriptor::getRuleInstance).toList().equals(data.getRules()))throw new IllegalStateException("Native rule plan disagreement");
    List<String> rules=new ArrayList<>(),observed=new ArrayList<>(),findings=new ArrayList<>(),notifications=new ArrayList<>();
    if(data.getNotifications().size()>2000)throw new IllegalStateException("Notification bound");
    for(Notification n:data.getNotifications())notifications.add("{\"level\":"+q(n.getLevel().name())+",\"message\":"+q(n.getMessage())+"}");
    for(RuleDescriptor d:descriptors){RuleInstance r=d.getRuleInstance();rules.add("{\"set\":"+q(r.getRuleSetId().getValue())+",\"id\":"+q(r.getId())+",\"active\":"+r.getActive()+",\"severity\":"+q(r.getSeverity().name())+"}");}
    for(KtFile f:files){
      List<String> excluded=new ArrayList<>(),suppressed=new ArrayList<>();
      Collection<KtElement> elements=PsiTreeUtil.collectElementsOfType(f,KtElement.class);
      if(elements.size()>100000)throw new IllegalStateException("PSI node bound");
      for(RuleDescriptor d:descriptors){RuleInstance r=d.getRuleInstance();if(!r.getActive())continue;Config c=d.getConfig();
        if(!ConfigExtensionsKt.shouldAnalyzeFile(c,f,context.getBasePath())||c.getParent()!=null&&!ConfigExtensionsKt.shouldAnalyzeFile(c.getParent(),f,context.getBasePath()))excluded.add(q(r.getRuleSetId()+"/"+r.getId()));
        Set<String> aliases=new HashSet<>(c.valueOrDefault(Config.ALIASES_KEY,List.<String>of()));
        boolean suppression=SuppressionsKt.isSuppressedBy(f,r.getId(),aliases,r.getRuleSetId());
        for(KtElement e:elements)if(e instanceof KtAnnotated&&SuppressionsKt.isSuppressedBy(e,r.getId(),aliases,r.getRuleSetId()))suppression=true;
        if(suppression)suppressed.add(q(r.getRuleSetId()+"/"+r.getId()));
      }
      int errors=PsiTreeUtil.collectElementsOfType(f,PsiErrorElement.class).size();
      String after;
      try { after=sha(Files.readAllBytes(Path.of(file(f)))); } catch(Exception error){throw new IllegalStateException(error);}
      observed.add("{\"physicalBefore\":"+q(physical.get(file(f)))+",\"physicalAfter\":"+q(after)+",\"file\":"+q(file(f))+",\"psiSha256\":"+q(sha(f.getText().getBytes(StandardCharsets.UTF_8)))+",\"syntaxErrors\":"+errors+",\"excluded\":["+String.join(",",excluded)+"],\"suppressed\":["+String.join(",",suppressed)+"]}");
    }
    for(Issue i:data.getIssues()){Issue.Location l=i.getLocation();findings.add("{\"file\":"+q(l.getPath().toString())+",\"line\":"+l.getSource().getLine()+",\"column\":"+l.getSource().getColumn()+",\"set\":"+q(i.getRuleInstance().getRuleSetId().getValue())+",\"id\":"+q(i.getRuleInstance().getId())+",\"severity\":"+q(i.getSeverity().name())+",\"message\":"+q(i.getMessage())+",\"suppressionReasons\":["+String.join(",",i.getSuppressReasons().stream().map(VerifierDetekt::q).toList())+"]}");}
    String out="{\"version\":1,\"events\":["+String.join(",",events)+"],\"rules\":["+String.join(",",rules)+"],\"sources\":["+String.join(",",observed)+"],\"notifications\":["+String.join(",",notifications)+"],\"findings\":["+String.join(",",findings)+"]}";
    try{if(out.getBytes(StandardCharsets.UTF_8).length>4*1024*1024)throw new IllegalStateException("Receipt bound");Files.writeString(Path.of(System.getProperty("checktrail.receipt")),out,StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW);}catch(Exception e){throw new IllegalStateException(e);}
    return data;
  }
}
`;
