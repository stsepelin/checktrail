import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { rubyToolsFixture } from "./ruby-tools-fixture.js";
import { rubyToolsConfigV2Schema } from "../src/ruby-tools.js";
export async function rubyExtensionsFixture(
  t: TestContext,
  checks = [
    "ruby.rubocop-extensions",
    "ruby.rspec-extensions",
    "ruby.minitest-extensions",
  ],
) {
  const { root, config: legacy } = await rubyToolsFixture(t, checks);
  const hooks = `RSpec.shared_examples "original shared quantity" do
  before(:context) { @original_context = 17 }
  before(:example) { @original_before = 23 }
  around(:example) { |example| example.run }
  after(:example) { raise "missing before hook" unless @original_before == 23 }
  after(:context) { raise "missing context hook" unless @original_context == 17 }
  it("increments positive quantity") { raise "positive defect" unless OriginalQuantity.next_quantity(2) == 3 }
  it("preserves negative boundary") { raise "boundary defect" unless OriginalQuantity.next_quantity(-1) == 0 }
end
`;
  const files: Record<string, string> = {
    Gemfile: `source "https://rubygems.org"
ruby "4.0.7"
group :validation do
  platforms :ruby do
    eval_gemfile File.join("gemfiles", "tools.rb")
  end
end
install_if -> { RUBY_ENGINE == "ruby" } do
  gem "json", "2.18.0"
end
gem "prism", "1.8.1"
`,
    "gemfiles/tools.rb": `gem "rubocop", "1.91.0"
gem "rspec-core", "3.13.6"
gem "minitest", "6.0.6"
`,
    "spec/shared_quantity.rb": hooks,
    "spec/quantity_spec.rb": `require_relative "../lib/quantity"
RSpec.describe "first original receiver" do
  include_examples "original shared quantity"
end
`,
    "spec/second_spec.rb": `require_relative "../lib/quantity"
RSpec.describe "second original receiver" do
  include_examples "original shared quantity"
end
`,
    "test/inherited_base.rb": `require "minitest/test"
require_relative "../lib/quantity"
class OriginalInheritedQuantityBase < Minitest::Test
  def self.runnable_methods
    self == OriginalInheritedQuantityBase ? [] : super
  end
  def test_inherited_positive
    assert_equal 3, OriginalQuantity.next_quantity(2)
  end
  def test_inherited_boundary
    assert_equal 0, OriginalQuantity.next_quantity(-1)
  end
end
`,
    "test/quantity_test.rb": `require_relative "inherited_base"
class OriginalQuantityTest < OriginalInheritedQuantityBase
  def test_local_adjacent_value
    assert_equal 6, OriginalQuantity.next_quantity(5)
  end
end
`,
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  const config = rubyToolsConfigV2Schema.parse({
    ...legacy,
    schemaVersion: 2,
    sources: [
      "lib/quantity.rb",
      "gemfiles/tools.rb",
      "spec/shared_quantity.rb",
      "spec/quantity_spec.rb",
      "spec/second_spec.rb",
      "test/inherited_base.rb",
      "test/quantity_test.rb",
    ],
    rspec: {
      files: ["spec/quantity_spec.rb", "spec/second_spec.rb"],
      support: ["spec/shared_quantity.rb"],
    },
    minitest: {
      files: ["test/quantity_test.rb"],
      support: ["test/inherited_base.rb"],
    },
    extensions: {
      profile: "declared-manifests-shared-and-inherited-v1",
      manifests: ["Gemfile", "gemfiles/tools.rb"],
      dependencies: [
        ...[
          ["rubocop", "1.91.0"],
          ["rspec-core", "3.13.6"],
          ["minitest", "6.0.6"],
        ].map(([name, version]) => ({
          name,
          version,
          groups: ["validation"],
          platforms: ["ruby"],
          included: true,
          platformMatches: true,
        })),
        {
          name: "json",
          version: "2.18.0",
          groups: ["default"],
          platforms: [],
          included: true,
          platformMatches: true,
        },
        {
          name: "prism",
          version: "1.8.1",
          groups: ["default"],
          platforms: [],
          included: true,
          platformMatches: true,
        },
      ],
      rspecHooks: hooks.split("\n").flatMap((line, i) => {
        const m = /^ {2}(before|after|around)\(:(context|example)\)/.exec(line);
        return m
          ? [
              {
                kind: m[1],
                scope: m[2],
                file: "spec/shared_quantity.rb",
                line: i + 1,
                registrations: 2,
                invocations: m[2] === "context" ? 2 : 4,
              },
            ]
          : [];
      }),
    },
  });
  await writeFile(
    path.join(root, "checktrail.ruby-tools.json"),
    JSON.stringify(config),
  );
  return { root, config };
}
export async function breakRubyQuantity(root: string) {
  const file = path.join(root, "lib/quantity.rb"),
    original = await readFile(file, "utf8");
  const broken = original.replace("value + 1", "value + 2");
  if (broken === original) throw Error("Missing original producer anchor");
  await writeFile(file, broken);
  return { file, original };
}
