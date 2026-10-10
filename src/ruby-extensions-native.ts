// Original native witnesses for the selected, operator-trusted Ruby extension.
export const rubyExtensionsManifestNativeSource = String.raw`
extension_manifest = -> {
  definition = Bundler.definition
  sources = definition.sources
  raise "Non-public Ruby source is unsupported" unless sources.path_sources.empty? && sources.git_sources.empty? && sources.plugin_sources.empty? && !sources.global_path_source
  {
    sources: sources.rubygems_sources.flat_map { |source| source.remotes.map(&:to_s) }.sort,
    manifests: definition.gemfiles.map { |file|
      absolute = File.realpath(file)
      raise "Manifest escaped declared workspace" unless absolute.start_with?(root + File::SEPARATOR)
      relative = absolute.delete_prefix(root + File::SEPARATOR)
      raise "Undeclared evaluated manifest" unless request.fetch("config").fetch("extensions").fetch("manifests").include?(relative)
      {file: relative, sha256: Digest::SHA256.file(absolute).hexdigest}
    },
    dependencies: definition.dependencies.map { |dependency|
      remote = (dependency.source || sources.default_source).remotes.map(&:to_s).join(",")
      {name: dependency.name, requirement: dependency.requirement.to_s, groups: dependency.groups.map(&:to_s).sort,
       platforms: dependency.platforms.map(&:to_s).sort, included: !!dependency.should_include?, platformMatches: !!dependency.current_platform?, source: remote}
    }
  }
}
`;
export const rubyExtensionsTestNativeSource = String.raw`
extension_cases = []
extension_hooks = []
extension_registered_hooks = []
extension_location = ->(file,line) {
  absolute = File.expand_path(file,root)
  raise "Ruby callback escaped workspace" unless absolute.start_with?(root + File::SEPARATOR)
  relative = absolute.delete_prefix(root + File::SEPARATOR)
  raise "Ruby callback has no compiled source" unless compiled.key?(relative)
  {file: relative, line: line}
}
extension_group_id = ->(group) {
  metadata = group.metadata
  source = extension_location.call(metadata.fetch(:absolute_file_path),metadata.fetch(:line_number))
  "group:" + source.fetch(:file) + "[" + metadata.fetch(:scoped_id).to_s + "]"
}
extension_case = ->(example) {
  location = extension_location.call(*example.instance_variable_get(:@example_block).source_location)
  groups = []
  group = example.example_group
  while group != RSpec::Core::ExampleGroup
    groups << group
    group = group.superclass
  end
  receiver_files = groups.map { |g| g.metadata[:absolute_file_path] }.compact.map { |f| File.expand_path(f,root).delete_prefix(root + File::SEPARATOR) }
  receiver = receiver_files.find { |f| config.fetch("rspec").fetch("files").include?(f) }
  raise "Shared example has no selected receiver" unless receiver
  frames = example.metadata.fetch(:shared_group_inclusion_backtrace,[]).map { |frame|
    match = /\A(.+):([0-9]+)(?::in .+)?\z/.match(frame.inclusion_location)
    raise "Shared inclusion location is unavailable" unless match
    {name: frame.shared_group_name.to_s, inclusion: extension_location.call(match[1],Integer(match[2]))}
  }
  {id: example.id, receiverFile: receiver, receiver: extension_group_id.call(example.example_group), declaring: extension_group_id.call(example.example_group),
   method: example.full_description, source: location, ancestors: groups.map { |g| extension_group_id.call(g) }, shared: frames}
}
`;

export const rubyExtensionsHooksNativeSource = String.raw`
if config["schemaVersion"] == 2
  hook_registration = Module.new do
    define_method(:register) do |prepend_or_append, position, *arguments, &callback|
      file,line = callback.source_location
      absolute = File.expand_path(file,root)
      if absolute.start_with?(root + File::SEPARATOR)
        scope,_options = scope_and_options_from(*arguments)
        raise "Unsupported project hook scope" unless [:example,:context].include?(scope) && !(scope == :context && position == :around)
        extension_registered_hooks << {kind: position.to_s, scope: scope.to_s, source: extension_location.call(file,line)}
      end
      super(prepend_or_append,position,*arguments,&callback)
    end
  end
  RSpec::Core::Hooks::HookCollections.prepend(hook_registration)
  [[RSpec::Core::Hooks::BeforeHook,:run,"before"], [RSpec::Core::Hooks::AfterHook,:run,"after"],
   [RSpec::Core::Hooks::AfterContextHook,:run,"after"], [RSpec::Core::Hooks::AroundHook,:execute_with,"around"]].each do |klass,method,kind|
    observer = Module.new do
      define_method(method) do |example,*arguments|
        file,line = block.source_location
        absolute = File.expand_path(file,root)
        next super(example,*arguments) unless absolute.start_with?(root + File::SEPARATOR)
        id = example.is_a?(RSpec::Core::Example) ? example.id : extension_group_id.call(example.class)
        event = {caseId: id, kind: kind, source: extension_location.call(file,line), entered: true, returned: false}
        extension_hooks << event
        value = super(example,*arguments)
        event[:returned] = true
        value
      end
    end
    klass.prepend(observer)
  end
end
`;
