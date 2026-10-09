// Exact selected native inputs for the original Linux ARM64 PHP extension profile.
export const phpExtensionRuntime = {
  php: "8.5.6",
  architecture: "aarch64",
  extensions: [
    {
      name: "Core",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "PDO",
      version: "8.5.6",
      dependencies: {
        spl: "Required",
      },
    },
    {
      name: "Phar",
      version: "8.5.6",
      dependencies: {
        apc: "Optional",
        bz2: "Optional",
        openssl: "Optional",
        zlib: "Optional",
        standard: "Optional",
        hash: "Required",
        spl: "Required",
      },
    },
    {
      name: "Reflection",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "SPL",
      version: "8.5.6",
      dependencies: {
        json: "Required",
      },
    },
    {
      name: "SimpleXML",
      version: "8.5.6",
      dependencies: {
        libxml: "Required",
        spl: "Required",
      },
    },
    {
      name: "Zend OPcache",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "bz2",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "ctype",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "curl",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "date",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "dom",
      version: "20031129",
      dependencies: {
        libxml: "Required",
        lexbor: "Required",
        domxml: "Conflicts",
      },
    },
    {
      name: "fileinfo",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "filter",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "hash",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "iconv",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "json",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "lexbor",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "libxml",
      version: "8.5.6",
      dependencies: {
        standard: "Required",
      },
    },
    {
      name: "mbstring",
      version: "8.5.6",
      dependencies: {
        pcre: "Required",
      },
    },
    {
      name: "mysqlnd",
      version: "mysqlnd 8.5.6",
      dependencies: {
        standard: "Required",
      },
    },
    {
      name: "openssl",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "pcre",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "pdo_sqlite",
      version: "8.5.6",
      dependencies: {
        pdo: "Required",
      },
    },
    {
      name: "posix",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "random",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "readline",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "session",
      version: "8.5.6",
      dependencies: {
        spl: "Optional",
      },
    },
    {
      name: "sodium",
      version: "8.5.6",
      dependencies: {
        standard: "Required",
      },
    },
    {
      name: "sqlite3",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "standard",
      version: "8.5.6",
      dependencies: {
        uri: "Required",
        session: "Optional",
      },
    },
    {
      name: "tokenizer",
      version: "8.5.6",
      dependencies: {},
    },
    {
      name: "uri",
      version: "8.5.6",
      dependencies: {
        lexbor: "Required",
      },
    },
    {
      name: "xml",
      version: "8.5.6",
      dependencies: {
        libxml: "Required",
      },
    },
    {
      name: "xmlreader",
      version: "8.5.6",
      dependencies: {
        dom: "Required",
        libxml: "Required",
      },
    },
    {
      name: "xmlwriter",
      version: "8.5.6",
      dependencies: {
        libxml: "Required",
      },
    },
    {
      name: "zip",
      version: "1.22.8",
      dependencies: {
        pcre: "Required",
      },
    },
    {
      name: "zlib",
      version: "8.5.6",
      dependencies: {},
    },
  ],
  artifacts: [
    {
      kind: "interpreter",
      name: "php",
      bytes: 24333520,
      sha256:
        "a8d6f8593d8398c104ba4d7c74b23a71764ac3bfa9eb4b0dc51a9dac10bc5234",
    },
    {
      kind: "extension",
      name: "bz2.so",
      bytes: 67416,
      sha256:
        "837beada0463d38a59ddab88765aade312e972392d253d960ca754f45404104e",
    },
    {
      kind: "extension",
      name: "sodium.so",
      bytes: 132952,
      sha256:
        "a813168d5522317c4ee6ed10382d73f03a4ac54c54c8c6f98e329fa0ab3b27d8",
    },
    {
      kind: "extension",
      name: "zip.so",
      bytes: 132952,
      sha256:
        "d778113f853b83ccd259411a83390ec3fe6c1ed551012a199a3233cfa273875c",
    },
  ],
} as const;
export const phpExtensionToolPins = [
  {
    package: "phpstan/phpstan",
    version: "2.2.14",
    path: "phpstan/phpstan/phpstan.phar",
    bytes: 28934862,
    sha256: "a7d45c01d3bd5aceb2cb9e596a67e50ff9f12b8757a373b93c0761deb8cd77e1",
  },
  {
    package: "larastan/larastan",
    version: "v3.12.3",
    path: "larastan/larastan/extension.neon",
    bytes: 27238,
    sha256: "09cb1cb333744083c57e469ece986d9da549c768bf7eda518309a46caa83a779",
  },
  {
    package: "larastan/larastan",
    version: "v3.12.3",
    path: "larastan/larastan/bootstrap.php",
    bytes: 1608,
    sha256: "5a3eacbf63b3e41659adfee92facededf8e020a932800f93c9a8b0e67f235805",
  },
  {
    package: "friendsofphp/php-cs-fixer",
    version: "v3.95.27",
    path: "friendsofphp/php-cs-fixer/src/Console/Application.php",
    bytes: 9186,
    sha256: "f95db7ae945c51d9bd629e6fcf8bade5bfc2e735212e0caa1027a9e66d027c9e",
  },
  {
    package: "friendsofphp/php-cs-fixer",
    version: "v3.95.27",
    path: "friendsofphp/php-cs-fixer/src/Console/ConfigurationResolver.php",
    bytes: 35154,
    sha256: "467ae28993b5f9e6c310eabdfce01ffed50f0b503736162b602f18714488c99b",
  },
  {
    package: "friendsofphp/php-cs-fixer",
    version: "v3.95.27",
    path: "friendsofphp/php-cs-fixer/src/Runner/Runner.php",
    bytes: 30185,
    sha256: "948e47406aa06004275e72d8df39d07c542582ac85bad8b620458def8fc49e09",
  },
  {
    package: "laravel/framework",
    version: "v13.32.0",
    path: "laravel/framework/src/Illuminate/Database/Eloquent/Model.php",
    bytes: 82120,
    sha256: "8186c638799dc3441a42e996a6af5ebe138eb67f6e7d0f88bfec98e498f6345b",
  },
  {
    package: "laravel/framework",
    version: "v13.32.0",
    path: "laravel/framework/src/Illuminate/Database/Eloquent/Concerns/HasAttributes.php",
    bytes: 76138,
    sha256: "1cabf1764355b8a8a6ac7c26c11d6826252e035c51cf77d678f0e16a1c4f06b5",
  },
  {
    package: "laravel/framework",
    version: "v13.32.0",
    path: "laravel/framework/src/Illuminate/Database/Eloquent/Casts/Attribute.php",
    bytes: 1954,
    sha256: "2047f8c2c5c82f7d4af0e395ee53b633203b5bda490bec4474361ab811d54916",
  },
  {
    package: "laravel/framework",
    version: "v13.32.0",
    path: "laravel/framework/src/Illuminate/Foundation/Application.php",
    bytes: 47493,
    sha256: "dd6262f3b087af2ae102a791c32a0c4a2b5be60c915c2219cf2bdc76a8791f47",
  },
  {
    package: "laravel/framework",
    version: "v13.32.0",
    path: "laravel/framework/src/Illuminate/Foundation/Configuration/ApplicationBuilder.php",
    bytes: 16158,
    sha256: "efa47f6eeb906833631fe643024036380e9b2c24b1c5ff4e7f3c4733da761830",
  },
  {
    package: "laravel/framework",
    version: "v13.32.0",
    path: "laravel/framework/src/Illuminate/Foundation/Http/Kernel.php",
    bytes: 18610,
    sha256: "f807ec6b1851030c4e5d4c3d83dc9021d8ac6b399d49f1300a068ea2f3c208ad",
  },
  {
    package: "laravel/framework",
    version: "v13.32.0",
    path: "laravel/framework/src/Illuminate/Foundation/Console/Kernel.php",
    bytes: 17982,
    sha256: "ab889be0927d22f4222521cc7b695a0857ffa1a931f8f498075137da169e36d5",
  },
  {
    package: "laravel/framework",
    version: "v13.32.0",
    path: "laravel/framework/src/Illuminate/Container/Container.php",
    bytes: 53736,
    sha256: "8bbfbc5955205f817106077355a493952e685bc376653236a7188f20ff634ea8",
  },
  {
    package: "laravel/framework",
    version: "v13.32.0",
    path: "laravel/framework/src/Illuminate/Support/Str.php",
    bytes: 70870,
    sha256: "48e98fa91fd7ee8a2162f6843c63a74b9136d648188b85f4c29398e182262613",
  },
] as const;
