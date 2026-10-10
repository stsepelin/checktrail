export const scalaNativeSource = `import dotty.tools.dotc.{Driver, Compiler, Run, CompilationUnit}
import dotty.tools.dotc.core.Contexts.Context
import dotty.tools.dotc.core.Phases.Phase
import dotty.tools.dotc.ast.tpd
import dotty.tools.dotc.reporting.{Reporter, Diagnostic}
import dotty.tools.dotc.interfaces.{CompilerCallback, SourceFile, AbstractFile}
import java.nio.file.{Path, Files, LinkOption}
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import java.util.HexFormat
import scala.collection.mutable

object VerifierScala:
  def hash(b: Array[Byte]): String = HexFormat.of.formatHex(MessageDigest.getInstance("SHA-256").digest(b))
  def q(s: String): String =
    if s == null then "null"
    else
      val b = new StringBuilder("\\"")
      s.foreach { c =>
        if c == '"' || c == '\\\\' then b.append('\\\\').append(c)
        else if c < 32 || Character.isSurrogate(c) then b.append("\\\\u%04x".format(c.toInt))
        else b.append(c)
      }
      b.append('"').toString
  def arr(values: Iterable[String]): String = values.mkString("[", ",", "]")
  class Source(val file: String):
    var sha256: String = null
    var bytes = -1
    var frontend = 0
    var complete = 0
    var featureVisits = 0
    var compiled = 0
    var nodes = 0
    var types = 0
    var declarations = 0
    var unknownAnnotations = 0
    var inline = false
    var staging = false
    var macros = false
    var suspended = false
    val annotations = mutable.ArrayBuffer.empty[String]
    def json: String = s"{\\"file\\":\${q(file)},\\"sha256\\":\${q(sha256)},\\"bytes\\":$bytes,\\"frontend\\":$frontend,\\"featureVisits\\":$featureVisits,\\"complete\\":$complete,\\"compiled\\":$compiled,\\"nodes\\":$nodes,\\"types\\":$types,\\"declarations\\":$declarations,\\"unknownAnnotations\\":$unknownAnnotations,\\"inline\\":$inline,\\"staging\\":$staging,\\"macro\\":$macros,\\"suspended\\":$suspended,\\"annotations\\":\${arr(annotations.map(q))}}"
  val sources = mutable.LinkedHashMap.empty[String, Source]
  val messages = mutable.ArrayBuffer.empty[String]
  val bindings = mutable.ArrayBuffer.empty[(String, String, String)]
  var registrations = 0
  var unknownSources = 0
  var nodes = 0
  var types = 0
  var declarations = 0
  var finishCalls = 0
  var frontendStages = 0
  var featureStages = 0
  var completeStages = 0
  var diagnosticBytes = 0
  var phases = List.empty[String]
  def selected(file: String): Option[Source] =
    val found = sources.get(file)
    if found.isEmpty then unknownSources += 1
    found
  class Observation(stage: String) extends Phase:
    def phaseName = "checktrail-original-" + stage
    override def runOn(units: List[CompilationUnit])(using Context): List[CompilationUnit] =
      if stage == "frontend" then frontendStages += 1
      else if stage == "features" then featureStages += 1
      else completeStages += 1
      super.runOn(units)
    def run(using ctx: Context): Unit =
      val unit = ctx.compilationUnit
      selected(unit.source.path).foreach { source =>
        val b = new String(unit.source.content).getBytes(UTF_8)
        if b.length > 1024 * 1024 then throw new IllegalStateException("Native source budget")
        if stage == "frontend" then
          source.frontend += 1
          source.sha256 = hash(b)
          source.bytes = b.length
          source.suspended = unit.suspended
          val seen = mutable.HashSet.empty[dotty.tools.dotc.core.Symbols.Symbol]
          val seenTypes = new java.util.IdentityHashMap[dotty.tools.dotc.core.Types.Type, java.lang.Boolean]
          def annotation(symbol: dotty.tools.dotc.core.Symbols.Symbol)(using Context): Unit =
            if !symbol.exists then source.unknownAnnotations += 1
            else
              if source.annotations.size >= 200000 then throw new IllegalStateException("Native annotation budget")
              source.annotations += symbol.fullName.toString
          val traverser = new tpd.TreeTraverser:
            def traverse(tree: tpd.Tree)(using Context): Unit =
              nodes += 1
              source.nodes += 1
              if nodes > 200000 then throw new IllegalStateException("Native tree budget")
              if tree.hasType then tree.tpe.foreachPart { part =>
                if seenTypes.put(part, java.lang.Boolean.TRUE) == null then
                  types += 1
                  source.types += 1
                  if types > 200000 then throw new IllegalStateException("Native type budget")
                  part match
                    case annotated: dotty.tools.dotc.core.Types.AnnotatedType => annotation(annotated.annot.symbol)
                    case _ => ()
              }
              if tree.symbol.exists && tree.symbol.is(dotty.tools.dotc.core.Flags.Inline) then source.inline = true
              tree match
                case _: tpd.Quote => source.staging = true
                case _: tpd.Splice => source.macros = true
                case member: tpd.MemberDef =>
                  declarations += 1
                  source.declarations += 1
                  val sym = member.symbol
                  if sym.exists && !seen.contains(sym) then
                    seen.add(sym)
                    sym.annotations.foreach(a => annotation(a.symbol))
                case annotated: tpd.Annotated => annotation(annotated.annot.tpe.typeSymbol)
                case _ => ()
              traverseChildren(tree)
          traverser.traverse(unit.tpdTree)
        else
          if source.sha256 != hash(b) || source.bytes != b.length then throw new IllegalStateException("Native source drift")
          source.suspended = source.suspended || unit.suspended
          if stage == "features" then
            source.featureVisits += 1
            source.inline = source.inline || unit.needsInlining
            source.staging = source.staging || unit.needsStaging
            source.macros = source.macros || unit.hasMacroAnnotations
          else source.complete += 1
      }
  class OriginalCompiler extends Compiler:
    override def frontendPhases = super.frontendPhases.flatMap(group =>
      if group.exists(_.phaseName == "typer") then List(group, List(new Observation("frontend")))
      else if group.exists(_.phaseName == "posttyper") then List(group, List(new Observation("features")))
      else List(group))
    override def backendPhases = super.backendPhases ::: List(List(new Observation("complete")))
  class OriginalDriver extends Driver:
    override def newCompiler(using Context): Compiler =
      registrations += 1
      val compiler = new OriginalCompiler
      phases = compiler.phases.flatten.map(_.phaseName)
      compiler
    override def finish(compiler: Compiler, run: Run)(using Context): Unit =
      super.finish(compiler, run)
      finishCalls += 1
  def main(a: Array[String]): Unit =
    val version = dotty.tools.dotc.config.Properties.versionNumberString
    if a.length == 1 && a(0) == "--version" then
      println("Scala compiler " + version)
      return
    if a.length < 5 || a.length > 2004 then throw new IllegalStateException("Fixed compiler input bound")
    a.drop(4).foreach { f =>
      if sources.contains(f) then throw new IllegalStateException("Duplicate source")
      sources(f) = new Source(f)
    }
    val reporter = new Reporter:
      override def truncationOK = false
      def doReport(d: Diagnostic)(using Context): Unit =
        diagnosticBytes += d.message.getBytes(UTF_8).length
        if messages.size >= 2000 || diagnosticBytes > 1024 * 1024 then throw new IllegalStateException("Native diagnostic budget")
        val pos = d.position
        val p = if pos.isPresent then pos.get else null
        messages += s"{\\"level\\":\${d.level},\\"id\\":\${q(d.msg.errorId.toString)},\\"message\\":\${q(d.message)},\\"file\\":\${q(if p == null then null else p.source.path)},\\"line\\":\${if p == null then -1 else p.line},\\"column\\":\${if p == null then -1 else p.column},\\"start\\":\${if p == null then -1 else p.start},\\"end\\":\${if p == null then -1 else p.end},\\"lineContent\\":\${q(if p == null then null else p.lineContent)}}"
    val callback = new CompilerCallback:
      override def onSourceCompiled(source: SourceFile): Unit = selected(source.path).foreach(_.compiled += 1)
      override def onClassGenerated(source: SourceFile, target: AbstractFile, name: String): Unit =
        if bindings.size >= 4000 then throw new IllegalStateException("Native class count budget")
        selected(source.path)
        bindings += ((source.path, target.path, name))
    val args = Array("-encoding", "UTF-8", "-classpath", a(1), "-source", "3.9", "-deprecation", "-feature", "-unchecked", "-color:never", "-release:" + a(2), "-d", a(0)) ++ (if a(3) == "true" then Array("-Werror") else Array.empty[String]) ++ a.drop(4)
    val result = new OriginalDriver().process(args, reporter, callback)
    val directory = Path.of(a(0)).toAbsolutePath.normalize
    val outputs = mutable.ArrayBuffer.empty[String]
    val outputSources = mutable.Map.empty[String, (String, String)]
    bindings.foreach { case (source, target, name) =>
      val file = Path.of(target).toAbsolutePath.normalize
      if !file.startsWith(directory) || outputSources.contains(file.toString) then throw new IllegalStateException("Native class binding")
      outputSources(file.toString) = (source, name)
    }
    var outputBytes = 0L
    var outputNodes = 0
    var classCount = 0
    val stream = Files.walk(directory)
    try
      val iter = stream.iterator
      while iter.hasNext do
        val f = iter.next
        outputNodes += 1
        if outputNodes > 10000 || Files.isSymbolicLink(f) then throw new IllegalStateException("Native output inventory")
        if Files.isRegularFile(f, LinkOption.NOFOLLOW_LINKS) then
          if outputs.size >= 4001 then throw new IllegalStateException("Native output count")
          val name = directory.relativize(f).toString
          val binding = outputSources.get(f.toString).orElse(if name.endsWith(".tasty") then outputSources.get(f.toString.stripSuffix(".tasty") + ".class") else None)
          if binding.isEmpty then throw new IllegalStateException("Unbound native output")
          val (source, binaryName) = binding.get
          val input = Files.newInputStream(f, LinkOption.NOFOLLOW_LINKS)
          val bytes = try input.readNBytes(32 * 1024 * 1024 + 1) finally input.close()
          outputBytes += bytes.length
          if bytes.length > 32 * 1024 * 1024 || outputBytes > 64 * 1024 * 1024 || Files.size(f) != bytes.length then throw new IllegalStateException("Native output bytes")
          val major = if name.endsWith(".class") then
            classCount += 1
            if bytes.length < 8 || bytes.take(4).toSeq != Seq(0xca.toByte,0xfe.toByte,0xba.toByte,0xbe.toByte) then throw new IllegalStateException("Native class header")
            (((bytes(6) & 255) << 8) + (bytes(7) & 255)).toString
          else "null"
          outputs += s"{\\"file\\":\${q(name)},\\"source\\":\${q(source)},\\"binaryName\\":\${q(binaryName)},\\"sha256\\":\${q(hash(bytes))},\\"bytes\\":\${bytes.length},\\"classMajor\\":$major}"
        else if !Files.isDirectory(f, LinkOption.NOFOLLOW_LINKS) then throw new IllegalStateException("Native output kind")
    finally stream.close()
    if classCount != bindings.size then throw new IllegalStateException("Missing native class output")
    val data = s"{\\"version\\":1,\\"scala\\":\${q(version)},\\"runtime\\":\${q(System.getProperty("java.runtime.version"))},\\"vendor\\":\${q(System.getProperty("java.vendor"))},\\"registrations\\":$registrations,\\"finishCalls\\":$finishCalls,\\"frontendStages\\":$frontendStages,\\"featureStages\\":$featureStages,\\"completeStages\\":$completeStages,\\"unknownSources\\":$unknownSources,\\"nodes\\":$nodes,\\"types\\":$types,\\"declarations\\":$declarations,\\"phases\\":\${arr(phases.map(q))},\\"errors\\":\${result.errorCount},\\"warnings\\":\${result.warningCount},\\"unreported\\":\${arr(result.unreportedWarnings.map((k,v) => s"{\\"category\\":\${q(k)},\\"count\\":$v}"))},\\"sources\\":\${arr(sources.values.map(_.json))},\\"messages\\":\${arr(messages)},\\"outputs\\":\${arr(outputs)}}"
    if data.getBytes(UTF_8).length > 4 * 1024 * 1024 then throw new IllegalStateException("Native receipt byte budget")
    println(data)
`;
