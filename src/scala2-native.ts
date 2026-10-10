export const scala2NativeSource = `import scala.tools.nsc.{Global, Settings, SubComponent, Phase}
import scala.tools.nsc.reporters.StoreReporter
import java.nio.file.{Files, Path, LinkOption}
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import java.util.HexFormat
import scala.collection.mutable
import scala.tools.asm.{ClassReader, ClassVisitor, Opcodes}

object VerifierScala2 {
  def hash(b: Array[Byte]): String = HexFormat.of.formatHex(MessageDigest.getInstance("SHA-256").digest(b))
  def q(s: String): String = {
    if (s == null) return "null"
    val b = new StringBuilder("\\"")
    s.foreach { c =>
      if (c == '"' || c == '\\\\') b.append('\\\\').append(c)
      else if (c < 32 || Character.isSurrogate(c)) b.append("\\\\u%04x".format(c.toInt))
      else b.append(c)
    }
    b.append('"').toString
  }
  def arr(v: Iterable[String]): String = v.mkString("[", ",", "]")
  class Source(val file: String) {
    var frontend = 0
    var complete = 0
    var sha256: String = null
    var bytes = -1
    var nodes = 0
    var types = 0
    var declarations = 0
    var unknownAnnotations = 0
    val annotations = mutable.ArrayBuffer.empty[String]
    val primaryNames = mutable.ArrayBuffer.empty[String]
    def json: String = s"{\\"file\\":\${q(file)},\\"sha256\\":\${q(sha256)},\\"bytes\\":$bytes,\\"frontend\\":$frontend,\\"complete\\":$complete,\\"nodes\\":$nodes,\\"types\\":$types,\\"declarations\\":$declarations,\\"unknownAnnotations\\":$unknownAnnotations,\\"annotations\\":\${arr(annotations.map(q))},\\"primaryNames\\":\${arr(primaryNames.map(q))}}"
  }
  val sources = mutable.LinkedHashMap.empty[String, Source]
  var unknownSources = 0
  var nodes = 0
  var types = 0
  var declarations = 0
  class OriginalCompiler(settings: Settings, reporter: StoreReporter) extends Global(settings, reporter) { compiler =>
    import compiler._
    class Observation(stage: String) extends SubComponent {
      val global: compiler.type = compiler
      val phaseName = "checktrail-original-" + stage
      val runsAfter = List(if (stage == "frontend") "typer" else "jvm")
      override val runsBefore = List(if (stage == "frontend") "patmat" else "terminal")
      val runsRightAfter = None
      def newPhase(previous: Phase): Phase = new StdPhase(previous) {
        def apply(unit: CompilationUnit): Unit = {
          sources.get(unit.source.path) match {
            case None => unknownSources += 1
            case Some(source) =>
              val b = new String(unit.source.content).getBytes(UTF_8)
              if (b.length > 1024 * 1024) throw new IllegalStateException("Native source budget")
              if (stage == "complete") {
                source.complete += 1
                if (source.sha256 != hash(b) || source.bytes != b.length) throw new IllegalStateException("Native source drift")
              } else {
                source.frontend += 1
                source.sha256 = hash(b)
                source.bytes = b.length
                val seen = mutable.HashSet.empty[Symbol]
                val seenTypes = new java.util.IdentityHashMap[Type, java.lang.Boolean]
                def annotation(symbol: Symbol): Unit = {
                  if (symbol == null || symbol == NoSymbol) source.unknownAnnotations += 1
                  else {
                    if (source.annotations.size >= 200000) throw new IllegalStateException("Native annotation budget")
                    source.annotations += symbol.fullName
                  }
                }
                val traverser = new Traverser {
                  override def traverse(tree: Tree): Unit = {
                    nodes += 1; source.nodes += 1
                    if (nodes > 200000) throw new IllegalStateException("Native tree budget")
                    if (tree.tpe != null) tree.tpe.foreach { part =>
                      if (seenTypes.put(part, java.lang.Boolean.TRUE) == null) {
                        types += 1; source.types += 1
                        if (types > 200000) throw new IllegalStateException("Native type budget")
                        part.annotations.foreach(a => annotation(a.atp.typeSymbol))
                      }
                    }
                    tree match {
                      case member: MemberDef =>
                        declarations += 1; source.declarations += 1
                        val sym = member.symbol
                        if (sym != NoSymbol && !seen(sym)) {
                          seen += sym
                          sym.annotations.foreach(a => annotation(a.atp.typeSymbol))
                          if (sym.owner.isPackageClass && (member.isInstanceOf[ClassDef] || member.isInstanceOf[ModuleDef])) source.primaryNames += sym.fullName
                        }
                      case annotated: Annotated => annotation(annotated.annot.tpe.typeSymbol)
                      case _ => ()
                    }
                    super.traverse(tree)
                  }
                }
                traverser.traverse(unit.body)
              }
          }
        }
      }
    }
    override protected def computeInternalPhases(): Unit = {
      super.computeInternalPhases()
      addToPhasesSet(new Observation("frontend"), "Original typed source observation")
      addToPhasesSet(new Observation("complete"), "Original backend source observation")
    }
  }
  def main(a: Array[String]): Unit = {
    val version = scala.util.Properties.versionNumberString
    if (a.toList == List("--version")) { println("Scala compiler " + version); return }
    if (a.length < 5 || a.length > 2004) throw new IllegalStateException("Fixed compiler input bound")
    a.drop(4).foreach { f =>
      if (sources.contains(f)) throw new IllegalStateException("Duplicate source")
      sources(f) = new Source(f)
    }
    val settings = new Settings(e => throw new IllegalStateException("Fixed compiler option: " + e))
    val args = List("-encoding", "UTF-8", "-classpath", a(1), "-release:" + a(2), "-deprecation", "-feature", "-unchecked", "-d", a(0)) ++ (if (a(3) == "true") List("-Werror") else Nil)
    val parsed = settings.processArguments(args, true)
    if (!parsed._1 || parsed._2.nonEmpty) throw new IllegalStateException("Compiler option binding")
    val reporter = new StoreReporter(settings)
    val compiler = new OriginalCompiler(settings, reporter)
    val run = new compiler.Run
    val phases = compiler.phaseDescriptors.map(_.phaseName)
    run.compile(a.drop(4).toList)
    val messages = reporter.infos.toList.map { d =>
      val p = d.pos
      s"{\\"level\\":\${d.severity.id},\\"message\\":\${q(d.msg)},\\"file\\":\${q(if (p.isDefined) p.source.path else null)},\\"line\\":\${if (p.isDefined) p.line - 1 else -1},\\"column\\":\${if (p.isDefined) p.column - 1 else -1},\\"lineContent\\":\${q(if (p.isDefined) p.lineContent else null)}}"
    }
    if (messages.size > 2000 || messages.mkString.getBytes(UTF_8).length > 1024 * 1024) throw new IllegalStateException("Native diagnostics budget")
    val directory = Path.of(a(0)).toAbsolutePath.normalize
    val outputs = mutable.ArrayBuffer.empty[String]
    var outputBytes = 0L
    var outputNodes = 0
    val stream = Files.walk(directory)
    try {
      val iter = stream.iterator
      while (iter.hasNext) {
        val file = iter.next()
        outputNodes += 1
        if (outputNodes > 10000 || Files.isSymbolicLink(file)) throw new IllegalStateException("Native output inventory")
        if (Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
          if (outputs.size >= 4001 || !file.toString.endsWith(".class")) throw new IllegalStateException("Native output kind/count")
          val input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)
          val bytes = try input.readNBytes(32 * 1024 * 1024 + 1) finally input.close()
          outputBytes += bytes.length
          if (bytes.length > 32 * 1024 * 1024 || outputBytes > 64 * 1024 * 1024 || Files.size(file) != bytes.length) throw new IllegalStateException("Native output byte bound")
          val reader = new ClassReader(bytes)
          val binaryName = reader.getClassName.replace('/', '.')
          var sourceFile: String = null
          reader.accept(new ClassVisitor(Opcodes.ASM9) { override def visitSource(source: String, debug: String): Unit = { sourceFile = source } }, ClassReader.SKIP_CODE | ClassReader.SKIP_FRAMES)
          val matching = sources.values.filter(s => Path.of(s.file).getFileName.toString == sourceFile && s.primaryNames.exists(p => binaryName == p || binaryName.startsWith(p + "$"))).toList
          if (matching.size != 1) throw new IllegalStateException("Native class origin binding")
          val major = ((bytes(6) & 255) << 8) + (bytes(7) & 255)
          outputs += s"{\\"file\\":\${q(directory.relativize(file).toString)},\\"source\\":\${q(matching.head.file)},\\"sourceFile\\":\${q(sourceFile)},\\"binaryName\\":\${q(binaryName)},\\"sha256\\":\${q(hash(bytes))},\\"bytes\\":\${bytes.length},\\"classMajor\\":$major}"
        } else if (!Files.isDirectory(file, LinkOption.NOFOLLOW_LINKS)) throw new IllegalStateException("Native output special entry")
      }
    } finally stream.close()
    val data = s"{\\"version\\":1,\\"scala\\":\${q(version)},\\"runtime\\":\${q(System.getProperty("java.runtime.version"))},\\"vendor\\":\${q(System.getProperty("java.vendor"))},\\"unknownSources\\":$unknownSources,\\"nodes\\":$nodes,\\"types\\":$types,\\"declarations\\":$declarations,\\"phases\\":\${arr(phases.map(q))},\\"errors\\":\${reporter.errorCount},\\"warnings\\":\${reporter.warningCount},\\"sources\\":\${arr(sources.values.map(_.json))},\\"messages\\":\${arr(messages)},\\"outputs\\":\${arr(outputs)}}"
    if (data.getBytes(UTF_8).length > 4 * 1024 * 1024) throw new IllegalStateException("Native receipt budget")
    println(data)
  }
}
`;
