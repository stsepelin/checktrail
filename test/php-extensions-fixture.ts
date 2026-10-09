import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { phpExtensionRuntime } from "../src/php-extension-pins.js";
import { phpExtensionsConfigSchema } from "../src/php-extensions.js";
import type { CheckResult } from "../src/types.js";
const vendor = fileURLToPath(
  new URL("../../.checktrail/php-review-tools/vendor", import.meta.url),
);
const available = await access(path.join(vendor, "autoload.php")).then(
  () =>
    process.platform === "linux" &&
    process.arch === "arm64" &&
    spawnSync("php", ["-r", "echo PHP_VERSION;"], {
      encoding: "utf8",
      timeout: 10000,
    }).stdout === "8.5.6",
  () => false,
);
export const phpExtensionsSkip = available
  ? false
  : "Selected native Linux ARM64 PHP 8.5.6 extension runtime unavailable";
export const phpCacheNames = [
  "APP_PACKAGES_CACHE",
  "APP_SERVICES_CACHE",
  "APP_CONFIG_CACHE",
  "APP_ROUTES_CACHE",
];
export const phpModel = `<?php
namespace Original;
use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Casts\\Attribute;
class Item extends Model
{
    protected $table = 'original_items';
    protected $with = ['owner.team'];
    protected $withCount = ['notes'];
    protected $casts = ['enabled' => 'boolean'];
    protected $attributes = ['label' => 'base', 'enabled' => 0];
    protected $appends = ['display_name'];
    protected $fillable = ['first', 'last'];
    protected $guarded = ['secret'];
    protected $perPage = 17;
    public $timestamps = false;
    /** @return \\Illuminate\\Database\\Eloquent\\Relations\\BelongsTo<Item, $this> */
    public function owner(): \\Illuminate\\Database\\Eloquent\\Relations\\BelongsTo
    {
        return $this->belongsTo(self::class, 'owner_id');
    }
    /** @return \\Illuminate\\Database\\Eloquent\\Relations\\BelongsTo<Item, $this> */
    public function team(): \\Illuminate\\Database\\Eloquent\\Relations\\BelongsTo
    {
        return $this->belongsTo(self::class, 'team_id');
    }
    /** @return \\Illuminate\\Database\\Eloquent\\Relations\\HasMany<Item, $this> */
    public function notes(): \\Illuminate\\Database\\Eloquent\\Relations\\HasMany
    {
        return $this->hasMany(self::class, 'item_id');
    }
    /** @return Attribute<string, never> */
    protected function displayName(): Attribute
    {
        return Attribute::make(get: fn (mixed $value, array $attributes): string => $attributes['first'] . ' ' . $attributes['last']);
    }
}
`;
export const phpProxy = `<?php
namespace Original;
class GeneratedProxy extends Item
{
    protected $keyType = 'string';
    public $incrementing = false;
    public function value(): int
    {
        return 42;
    }
}
`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const phpAtomic = async (file: string, value: string) => {
  await writeFile(file + ".replacement", value);
  await rename(file + ".replacement", file);
};
export async function phpOriginal(
  t: TestContext,
  options: { fixed?: boolean; checks?: string[]; excludedProxy?: boolean } = {},
) {
  const proxyPath = options.excludedProxy
    ? ".checktrail/generated/Proxy.php"
    : "generated/Proxy.php";
  const model = options.fixed
    ? phpModel
    : phpModel.replace(
        "$attributes['first'] . ' ' . $attributes['last']",
        "$attributes['first']",
      );
  const proxy = options.fixed
    ? phpProxy
    : phpProxy.replace("return 42;", 'return "invalid";');
  const config = phpExtensionsConfigSchema.parse({
    schemaVersion: 1,
    nativeExtensions: phpExtensionRuntime.extensions.map((e) => e.name),
    classes: [
      {
        class: "Original\\Item",
        path: "Item.php",
        sha256: hash(model),
        generated: false,
      },
      {
        class: "Original\\GeneratedProxy",
        path: proxyPath,
        sha256: hash(proxy),
        generated: true,
      },
    ],
    models: [
      {
        class: "Original\\Item",
        expectedClass: "Original\\GeneratedProxy",
        defaults: {
          table: "original_items",
          connection: null,
          keyName: "id",
          keyType: "string",
          incrementing: false,
          timestamps: false,
          perPage: 17,
          eagerLoads: ["owner.team"],
          eagerCounts: ["notes"],
          casts: { enabled: "boolean" },
          attributes: {
            label: { type: "string", value: "base" },
            enabled: { type: "int", value: 0 },
          },
          appends: ["display_name"],
          fillable: ["first", "last"],
          guarded: ["secret"],
        },
        probes: [
          {
            attribute: "display_name",
            attributes: { first: "Nova", last: "Vale" },
            expected: { type: "string", value: "Nova Vale" },
          },
          {
            attribute: "display_name",
            attributes: { first: "Nova", last: "North" },
            expected: { type: "string", value: "Nova North" },
          },
        ],
      },
    ],
  });
  const root = await fixture(t, {
    "composer.json": "{}",
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: ".",
          checks: options.checks ?? [
            "php.phpstan",
            "php.php-cs-fixer",
            "php.extensions",
          ],
          environment: phpCacheNames,
        },
      ],
    }),
    "checktrail.php.json": JSON.stringify(config),
    "Item.php": model,
    [proxyPath]: proxy,
    "phpstan.neon":
      "includes:\n    - vendor/larastan/larastan/extension.neon\nparameters:\n    level: 5\n    disableMigrationScan: true\n    disableSchemaScan: true\n    enableMigrationCache: false\n",
    ".php-cs-fixer.php":
      "<?php return (new PhpCsFixer\\Config())->setRules(['single_quote' => true])->setFinder(PhpCsFixer\\Finder::create()->in(__DIR__));\n",
    "bootstrap/app.php":
      "<?php return Illuminate\\Foundation\\Application::configure(basePath: dirname(__DIR__))->withBindings([Original\\Item::class => Original\\GeneratedProxy::class])->withExceptions()->create();\n",
    "bootstrap/providers.php": "<?php return [];\n",
    ".checktrail/keep": "original-public-cache-marker",
  });
  await cp(vendor, path.join(root, "vendor"), { recursive: true });
  const environment = Object.fromEntries(
    phpCacheNames.map((name) => [
      name,
      path.join(root, ".checktrail", name.toLowerCase() + ".php"),
    ]),
  );
  return {
    root,
    config,
    proxyPath,
    environment,
    options: { trusted: true, environment },
  };
}
export async function phpReceipt(check: CheckResult) {
  assert.equal(check.processes.length, 1);
  const native = JSON.parse(check.processes[0]!.stdout) as {
    complete: boolean;
    inputsStable: boolean;
    classes: unknown[];
    models: Array<{
      class: string;
      defaults: unknown;
      probes: Array<{ value: unknown }>;
    }>;
    runtime: unknown;
    manifest: unknown;
  };
  assert.equal(native.inputsStable, true);
  return native;
}
export async function phpRebind(
  root: string,
  config: Awaited<ReturnType<typeof phpOriginal>>["config"],
) {
  for (const entry of config.classes)
    entry.sha256 = hash(await readFile(path.join(root, entry.path), "utf8"));
  await phpAtomic(
    path.join(root, "checktrail.php.json"),
    JSON.stringify(config),
  );
}
