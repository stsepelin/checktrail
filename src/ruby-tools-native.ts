import {
  rubyExtensionsManifestNativeSource,
  rubyExtensionsTestNativeSource,
  rubyExtensionsHooksNativeSource,
} from "./ruby-extensions-native.js";
// Original observers for the pinned MRI, RuboCop, RSpec and Minitest profiles.
export const rubyToolsNativeSource = String.raw`
require "rubygems"
require "json"
require "digest"
require "stringio"
request = JSON.parse(File.binread(ARGV.fetch(0)))
output = ARGV.fetch(1)
mode = ARGV.fetch(2)
root = File.realpath(Dir.pwd)
pins = request.fetch("inputs").to_h { |p| [p.fetch("path"), p.fetch("sha256")] }
compiled = {}
RubyVM.keep_script_lines = true
SCRIPT_LINES__ = {}
trace = TracePoint.new(:script_compiled) do |event|
  iseq = event.instruction_sequence
  file = File.expand_path(iseq.absolute_path || iseq.path, root)
  next unless file.start_with?(root + File::SEPARATOR)
  relative = file.delete_prefix(root + File::SEPARATOR)
  lines = event.eval_script ? [event.eval_script] : SCRIPT_LINES__[iseq.path]
  raise "Compiled Ruby source has no native lines" unless lines
  hash = Digest::SHA256.hexdigest(lines.join.b)
  raise "Compiled Ruby source differs" unless pins[relative] == hash
  allowed_manifests = request.fetch("config")["schemaVersion"] == 2 ? request.fetch("config").fetch("extensions").fetch("manifests") : ["Gemfile"]
  raise "Dynamic project Ruby is unsupported" if event.eval_script && !allowed_manifests.include?(relative)
  row = {file: relative, sha256: hash}
  raise "Compiled Ruby source changed" if compiled[relative] && compiled[relative] != row
  compiled[relative] = row
end
trace.enable
gem "bundler", "=4.0.20"
require "bundler/setup"
trace.disable if mode == "rubocop"
config = request.fetch("config")
${rubyExtensionsManifestNativeSource}
${rubyExtensionsTestNativeSource}
rows = []
started = []
results = []
summary = nil
identity = ->(id, display, file, line) { {id: id, name: display, file: File.expand_path(file,root).delete_prefix(root + File::SEPARATOR), line: line} }
text = StringIO.new
status = nil
if mode == "rubocop"
  require "rubocop"
  status = RuboCop::CLI.new.run(["--only",config.fetch("cops").join(","),"--format","json","--cache","false","--config",ARGV.fetch(3),"Gemfile",*config.fetch("sources")])
elsif mode == "rspec"
  require "rspec/core"
  RSpec::Core::Runner.disable_autorun!
${rubyExtensionsHooksNativeSource}
  formatter = Class.new do
    def initialize(_output); end
  end
  formatter.define_method(:start) do |notification|
    rows.concat(RSpec.world.example_groups.flat_map(&:descendants).flat_map(&:examples).map { |ex| identity.call(ex.id, ex.full_description, *ex.instance_variable_get(:@example_block).source_location) })
    if config["schemaVersion"] == 2
      extension_cases.concat(RSpec.world.example_groups.flat_map(&:descendants).flat_map(&:examples).map { |ex| extension_case.call(ex) })
    end
    raise "RSpec native discovery and selected count differ" unless notification.count == rows.length
  end
  formatter.define_method(:example_started) { |n| started << n.example.id }
  [:example_passed, :example_failed, :example_pending].each do |event|
    formatter.define_method(event) do |n|
      ex = n.example
      error = ex.execution_result.exception
      results << identity.call(ex.id, ex.full_description, *ex.instance_variable_get(:@example_block).source_location).merge(outcome: ex.execution_result.status.to_s, assertions: nil, error: error ? error.message.to_s[0,16384] : "")
    end
  end
  formatter.define_method(:dump_summary) do |n|
    summary = {total: n.example_count, failed: n.failure_count, skipped: n.pending_count, assertions: nil, outsideErrors: RSpec.world.non_example_failure ? 1 : 0}
  end
  RSpec::Core::Formatters.register(formatter, :start, :example_started, :example_passed, :example_failed, :example_pending, :dump_summary)
  RSpec.configuration.add_formatter(formatter)
  config.fetch("rspec").fetch("support").each { |file| require File.expand_path(file,root) }
  trace.disable
  options = RSpec::Core::ConfigurationOptions.new(["--options",ARGV.fetch(3),"--order","defined",*config.fetch("rspec").fetch("files")])
  trace.enable
  status = RSpec::Core::Runner.new(options).run($stderr,text)
elsif mode == "minitest"
  require "minitest/test"
  Minitest.class_variable_set(:@@installed_at_exit,true)
  config.fetch("minitest").fetch("support").each { |file| require File.expand_path(file,root) }
  config.fetch("minitest").fetch("files").each { |file| require File.expand_path(file,root) }
  Minitest.seed = 1741
  rows.concat(Minitest::Runnable.runnables.flat_map { |klass| klass.runnable_methods.map { |method| file,line = klass.instance_method(method).source_location; identity.call(klass.name + "#" + method,method,file,line) } })
  if config["schemaVersion"] == 2
    extension_cases.concat(Minitest::Runnable.runnables.flat_map { |klass| klass.runnable_methods.map { |method|
      native_method = klass.instance_method(method)
      receiver_location = Object.const_source_location(klass.name)
      raise "Minitest receiver class location is missing" unless receiver_location
      {id: klass.name + "#" + method, receiverFile: extension_location.call(*receiver_location).fetch(:file), receiver: klass.name,
       declaring: native_method.owner.name, method: method, source: extension_location.call(*native_method.source_location),
       ancestors: klass.ancestors.map(&:name).compact, shared: []}
    } })
  end
  raise "Minitest project plugins are unsupported" unless Minitest.extensions.empty?
  reporter = Class.new(Minitest::AbstractReporter) do
    define_method(:prerecord) { |klass,method| started << klass.name + "#" + method }
    define_method(:record) do |result|
      file,line = result.source_location
      outcome = result.skipped? ? "pending" : result.passed? ? "passed" : "failed"
      results << identity.call(result.klass + "#" + result.name,result.name,file,line).merge(outcome: outcome,assertions: result.assertions,error: result.failure ? result.failure.message.to_s[0,16384] : "")
    end
    define_method(:report) do
      native = Minitest.reporter
      raise "Minitest reporter lifecycle changed" if native
    end
  end.new
  Minitest.extensions << "checktrail_local"
  native_summary = nil
  Minitest.define_singleton_method(:plugin_checktrail_local_init) do |options|
    native_summary = Minitest.reporter.reporters.grep(Minitest::SummaryReporter).fetch(0)
    Minitest.reporter << reporter
  end
  ok = Minitest.run(["--seed","1741","--quiet"], &nil)
  status = ok ? 0 : 1
  summary = {total: native_summary.count,failed: native_summary.failures + native_summary.errors + native_summary.warnings,skipped: native_summary.skips,assertions: native_summary.assertions,outsideErrors: 0}
  Minitest.class_variable_get(:@@after_run).reverse_each(&:call)
else
  raise "Unsupported native mode"
end
trace.disable
if mode != "rubocop"
  File.write(output,JSON.generate({rows: rows,started: started,results: results,summary: summary}))
end
raise "Native Ruby message bound" if text.string.bytesize > 65536
metadata = {messages: text.string, ruby: RUBY_VERSION, engine: RUBY_ENGINE, platform: RUBY_PLATFORM, patchlevel: RUBY_PATCHLEVEL, bundler: Bundler::VERSION, specs: Bundler.load.specs.map { |spec| {name: spec.name,version: spec.version.to_s,path: File.realpath(spec.full_gem_path)} }, loaded: Gem.loaded_specs.values.map { |spec| {name: spec.name,version: spec.version.to_s,path: File.realpath(spec.full_gem_path)} }, compiled: compiled.values, toolVersion: mode == "rubocop" ? RuboCop::Version::STRING : mode == "rspec" ? RSpec::Core::Version::STRING : Minitest::VERSION, toolFile: mode == "rubocop" ? RuboCop::CLI.instance_method(:run).source_location.fetch(0) : mode == "rspec" ? RSpec::Core::Runner.method(:run).source_location.fetch(0) : Minitest.method(:run).source_location.fetch(0)}
metadata[:extensions] = {manifest: extension_manifest.call, cases: extension_cases, registeredHooks: extension_registered_hooks, hooks: extension_hooks} if config["schemaVersion"] == 2
metadata[:toolFileSha256] = Digest::SHA256.file(metadata.fetch(:toolFile)).hexdigest
File.write(output + ".metadata",JSON.generate(metadata))
exit(status)
`;

// Restore observes the same evaluated-path bytes before the tools are installed.
export const rubyExtensionsRestoreNativeSource =
  rubyToolsNativeSource.slice(
    0,
    rubyToolsNativeSource.indexOf('gem "bundler", "=4.0.20"'),
  ) +
  String.raw`
gem "bundler", "=4.0.20"
trace.disable
require "bundler"
require "bundler/cli"
${rubyExtensionsManifestNativeSource}
manifest_observer = Module.new do
  define_method(:eval_gemfile) do |*arguments|
    trace.enabled? ? super(*arguments) : trace.enable { super(*arguments) }
  end
end
Bundler::Dsl.prepend(manifest_observer)
Bundler::CLI.start(["install", "--local"])
trace.disable
File.write(output,JSON.generate({manifest: extension_manifest.call, compiled: compiled.values}))
`;
