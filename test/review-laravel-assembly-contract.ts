import type { LaravelAssemblyConfig } from "../src/laravel-assembly-schema.js";
/** Fixed original operator contract authored from development witnesses; not independent accuracy evidence. */
export const profile: LaravelAssemblyConfig = {
  schemaVersion: 2,
  assembly: "original.laravel.assembly",
  environment: "testing",
  clock: "2026-01-01T10:00:00Z",
  models: ["AssemblyItem"],
  expectedCollections: [
    {
      kind: "routes",
      complete: true,
      ordered: true,
      entries: [
        {
          key: '["package.example.test","GET","package"]',
          attributes: {
            domain: "package.example.test",
            method: "GET",
            uri: "package",
            name: "assembly.package",
            handler: "\\AssemblyController@package",
            middleware: [],
            constraintsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            defaultsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
        {
          key: '["package.example.test","HEAD","package"]',
          attributes: {
            domain: "package.example.test",
            method: "HEAD",
            uri: "package",
            name: "assembly.package",
            handler: "\\AssemblyController@package",
            middleware: [],
            constraintsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            defaultsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
        {
          key: '[null,"GET","items"]',
          attributes: {
            domain: null,
            method: "GET",
            uri: "items",
            name: "assembly.items",
            handler: "AssemblyController@items",
            middleware: [],
            constraintsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            defaultsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
        {
          key: '[null,"HEAD","items"]',
          attributes: {
            domain: null,
            method: "HEAD",
            uri: "items",
            name: "assembly.items",
            handler: "AssemblyController@items",
            middleware: [],
            constraintsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            defaultsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
        {
          key: '[null,"GET","single"]',
          attributes: {
            domain: null,
            method: "GET",
            uri: "single",
            name: "assembly.single",
            handler: "AssemblyController@single",
            middleware: [],
            constraintsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            defaultsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
        {
          key: '[null,"HEAD","single"]',
          attributes: {
            domain: null,
            method: "HEAD",
            uri: "single",
            name: "assembly.single",
            handler: "AssemblyController@single",
            middleware: [],
            constraintsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            defaultsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
        {
          key: '[null,"POST","echo"]',
          attributes: {
            domain: null,
            method: "POST",
            uri: "echo",
            name: "assembly.echo",
            handler: "AssemblyController@echoBody",
            middleware: [],
            constraintsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            defaultsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
        {
          key: '[null,"GET","storage\\/{path}"]',
          attributes: {
            domain: null,
            method: "GET",
            uri: "storage/{path}",
            name: "storage.local",
            handler:
              "closure:vendor/laravel/framework/src/Illuminate/Filesystem/FilesystemServiceProvider.php:111:117:3a06ec3b93cc2db904b972e9a3627a218c74817714ab3fabb5740623db7cb213",
            middleware: [],
            constraintsHash:
              "00347d9dd17dbbdeb3ad8dab71678c6521b392c0a7669b41d5fd80a98106f5b6",
            defaultsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
        {
          key: '[null,"HEAD","storage\\/{path}"]',
          attributes: {
            domain: null,
            method: "HEAD",
            uri: "storage/{path}",
            name: "storage.local",
            handler:
              "closure:vendor/laravel/framework/src/Illuminate/Filesystem/FilesystemServiceProvider.php:111:117:3a06ec3b93cc2db904b972e9a3627a218c74817714ab3fabb5740623db7cb213",
            middleware: [],
            constraintsHash:
              "00347d9dd17dbbdeb3ad8dab71678c6521b392c0a7669b41d5fd80a98106f5b6",
            defaultsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
        {
          key: '[null,"PUT","storage\\/{path}"]',
          attributes: {
            domain: null,
            method: "PUT",
            uri: "storage/{path}",
            name: "storage.local.upload",
            handler:
              "closure:vendor/laravel/framework/src/Illuminate/Filesystem/FilesystemServiceProvider.php:119:125:66143ebda977fb51876d2fad406bd68801c85b83043bc0a3386795453f7f3d66",
            middleware: [],
            constraintsHash:
              "00347d9dd17dbbdeb3ad8dab71678c6521b392c0a7669b41d5fd80a98106f5b6",
            defaultsHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
      ],
    },
    {
      kind: "middleware",
      complete: true,
      ordered: true,
      entries: [
        {
          key: "global",
          attributes: {
            type: "global",
            stack: ["AssemblyInitialize", "AssemblyAuthorize"],
          },
        },
        {
          key: "priority",
          attributes: {
            type: "priority",
            stack: [
              "Illuminate\\Foundation\\Http\\Middleware\\HandlePrecognitiveRequests",
              "Illuminate\\Cookie\\Middleware\\EncryptCookies",
              "Illuminate\\Cookie\\Middleware\\AddQueuedCookiesToResponse",
              "Illuminate\\Session\\Middleware\\StartSession",
              "Illuminate\\View\\Middleware\\ShareErrorsFromSession",
              "Illuminate\\Contracts\\Auth\\Middleware\\AuthenticatesRequests",
              "Illuminate\\Routing\\Middleware\\ThrottleRequests",
              "Illuminate\\Routing\\Middleware\\ThrottleRequestsWithRedis",
              "Illuminate\\Contracts\\Session\\Middleware\\AuthenticatesSessions",
              "Illuminate\\Routing\\Middleware\\SubstituteBindings",
              "Illuminate\\Auth\\Middleware\\Authorize",
            ],
          },
        },
        {
          key: "group:web",
          attributes: {
            type: "group",
            name: "web",
            stack: [
              "Illuminate\\Cookie\\Middleware\\EncryptCookies",
              "Illuminate\\Cookie\\Middleware\\AddQueuedCookiesToResponse",
              "Illuminate\\Session\\Middleware\\StartSession",
              "Illuminate\\View\\Middleware\\ShareErrorsFromSession",
              "Illuminate\\Foundation\\Http\\Middleware\\PreventRequestForgery",
              "Illuminate\\Routing\\Middleware\\SubstituteBindings",
            ],
          },
        },
        {
          key: "group:api",
          attributes: {
            type: "group",
            name: "api",
            stack: ["Illuminate\\Routing\\Middleware\\SubstituteBindings"],
          },
        },
        {
          key: "alias:auth",
          attributes: {
            type: "alias",
            name: "auth",
            target: "Illuminate\\Auth\\Middleware\\Authenticate",
          },
        },
        {
          key: "alias:auth.basic",
          attributes: {
            type: "alias",
            name: "auth.basic",
            target: "Illuminate\\Auth\\Middleware\\AuthenticateWithBasicAuth",
          },
        },
        {
          key: "alias:auth.session",
          attributes: {
            type: "alias",
            name: "auth.session",
            target: "Illuminate\\Session\\Middleware\\AuthenticateSession",
          },
        },
        {
          key: "alias:cache.headers",
          attributes: {
            type: "alias",
            name: "cache.headers",
            target: "Illuminate\\Http\\Middleware\\SetCacheHeaders",
          },
        },
        {
          key: "alias:can",
          attributes: {
            type: "alias",
            name: "can",
            target: "Illuminate\\Auth\\Middleware\\Authorize",
          },
        },
        {
          key: "alias:guest",
          attributes: {
            type: "alias",
            name: "guest",
            target: "Illuminate\\Auth\\Middleware\\RedirectIfAuthenticated",
          },
        },
        {
          key: "alias:password.confirm",
          attributes: {
            type: "alias",
            name: "password.confirm",
            target: "Illuminate\\Auth\\Middleware\\RequirePassword",
          },
        },
        {
          key: "alias:precognitive",
          attributes: {
            type: "alias",
            name: "precognitive",
            target:
              "Illuminate\\Foundation\\Http\\Middleware\\HandlePrecognitiveRequests",
          },
        },
        {
          key: "alias:signed",
          attributes: {
            type: "alias",
            name: "signed",
            target: "Illuminate\\Routing\\Middleware\\ValidateSignature",
          },
        },
        {
          key: "alias:throttle",
          attributes: {
            type: "alias",
            name: "throttle",
            target: "Illuminate\\Routing\\Middleware\\ThrottleRequests",
          },
        },
        {
          key: "alias:verified",
          attributes: {
            type: "alias",
            name: "verified",
            target: "Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified",
          },
        },
      ],
    },
    {
      kind: "listeners",
      complete: true,
      ordered: true,
      entries: [
        {
          key: "exact:Illuminate\\Console\\Events\\CommandFinished",
          attributes: {
            type: "exact",
            event: "Illuminate\\Console\\Events\\CommandFinished",
            listener:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/FoundationServiceProvider.php:215:217:51d40dbfd645c813c3d5a925726c288a109135fd879caa2e3323e56c0b3d02e2",
          },
        },
        {
          key: "exact:Illuminate\\Queue\\Events\\JobAttempted",
          attributes: {
            type: "exact",
            event: "Illuminate\\Queue\\Events\\JobAttempted",
            listener:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/FoundationServiceProvider.php:219:225:49c7f6f1ec9d4d3e118963e58fcd381fc40e9db4c323ca1dbb6fda0caf6716ce",
          },
        },
        {
          key: "exact:Illuminate\\Log\\Events\\MessageLogged",
          attributes: {
            type: "exact",
            event: "Illuminate\\Log\\Events\\MessageLogged",
            listener:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/FoundationServiceProvider.php:244:249:40eeb0d5d15ed745689bb6903d0fdbadab886412a871c520d3dcc27cb1285166",
          },
        },
        {
          key: "exact:Illuminate\\Queue\\Events\\JobProcessing",
          attributes: {
            type: "exact",
            event: "Illuminate\\Queue\\Events\\JobProcessing",
            listener:
              "closure:vendor/laravel/framework/src/Illuminate/Log/Context/ContextServiceProvider.php:53:56:5564339c842bc9f1308334b99bafdaab71aedb34a72ec02d90348aaa9d74ebae",
          },
        },
        {
          key: "exact:Illuminate\\Foundation\\Events\\LocaleUpdated",
          attributes: {
            type: "exact",
            event: "Illuminate\\Foundation\\Events\\LocaleUpdated",
            listener:
              "closure:vendor/nesbot/carbon/src/Carbon/Laravel/ServiceProvider.php:66:68:cf56735004e48915c610cdc0c9120b41f88986bb2dc6579939108c0926785ec5",
          },
        },
        {
          key: "exact:assembly.saved",
          attributes: {
            type: "exact",
            event: "assembly.saved",
            listener: "AssemblyListener@handle",
          },
        },
        {
          key: "exact:Illuminate\\Auth\\Events\\Registered",
          attributes: {
            type: "exact",
            event: "Illuminate\\Auth\\Events\\Registered",
            listener:
              "Illuminate\\Auth\\Listeners\\SendEmailVerificationNotification",
          },
        },
        {
          key: "wildcard:assembly.*",
          attributes: {
            type: "wildcard",
            event: "assembly.*",
            listener: "AssemblyListener@handle",
          },
        },
      ],
    },
    {
      kind: "schedules",
      complete: true,
      ordered: true,
      entries: [
        {
          key: "callback:assemblyRefresh",
          attributes: {
            type: "callback",
            target: "assemblyRefresh",
            expression: "0 * * * *",
            repeatSeconds: null,
            user: null,
            environments: ["testing"],
            evenInMaintenanceMode: false,
            evenWhenPaused: false,
            withoutOverlapping: false,
            releaseOnTerminationSignals: true,
            onOneServer: false,
            expiresAt: 1440,
            runInBackground: false,
            description: "assembly-refresh",
            output: "/dev/null",
            shouldAppendOutput: false,
            timezone: "UTC",
            parametersHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            filters: [],
            rejects: [],
            beforeCallbacks: [],
            afterCallbacks: [],
            mutex: "Illuminate\\Console\\Scheduling\\CacheEventMutex",
            mutexNameResolver: null,
            attributesHash:
              "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          },
        },
      ],
    },
    {
      kind: "bindings",
      complete: true,
      ordered: false,
      entries: [
        {
          key: "factory:Illuminate\\Foundation\\Mix",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Mix",
            target: "Illuminate\\Foundation\\Mix",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\PackageManifest",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\PackageManifest",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Application.php:296:298:0682b8240fa3730785b914e5c02897cffc7192f01b44a179ae7139864cee8fb9",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:events",
          attributes: {
            type: "factory",
            abstract: "events",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Events/EventServiceProvider.php:17:25:d877b464d040bb9b6797eae018df3c662b8019861497a1dbc5c5af295b512747",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:log",
          attributes: {
            type: "factory",
            abstract: "log",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Log/LogServiceProvider.php:16:16:db60e141a7e41cf1d804d8388458b78775e622b21164e677f6df97c916ddac25",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Log\\Context\\Repository",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Log\\Context\\Repository",
            target: "Illuminate\\Log\\Context\\Repository",
            shared: true,
            scoped: true,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Log\\ContextLogProcessor",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Log\\ContextLogProcessor",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Log/Context/ContextServiceProvider.php:33:33:43050f8d06c7e81e51fdb9435838a7df903954fc69c7cf44822e5315d78eb82c",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:router",
          attributes: {
            type: "factory",
            abstract: "router",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Routing/RoutingServiceProvider.php:43:45:ee3fa0c9ad7f02b0bfbd08434acfd322d0555553d432acfe705ce17e4535e1dd",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:url",
          attributes: {
            type: "factory",
            abstract: "url",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Routing/RoutingServiceProvider.php:55:68:156f56eb4d934ec0cb1630a73bfdb660bce66cdd60e8c17e8f59bfa6d10611ed",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:redirect",
          attributes: {
            type: "factory",
            abstract: "redirect",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Routing/RoutingServiceProvider.php:114:125:5a511ad15488d9efa870333741afb76ef36452b59f781277a47573e92ef2fb03",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Psr\\Http\\Message\\ServerRequestInterface",
          attributes: {
            type: "factory",
            abstract: "Psr\\Http\\Message\\ServerRequestInterface",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Routing/RoutingServiceProvider.php:137:152:4056be7b7be5cd08800fe431fd46e983ec8e6366a58fb6cbce326b6af63b72c3",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:Psr\\Http\\Message\\ResponseInterface",
          attributes: {
            type: "factory",
            abstract: "Psr\\Http\\Message\\ResponseInterface",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Routing/RoutingServiceProvider.php:164:170:64899b3593160779eed3728f118bd3913a9a9e25f22df3f193e4b4f0ff3866cb",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Routing\\ResponseFactory",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Routing\\ResponseFactory",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Routing/RoutingServiceProvider.php:180:182:de01d1dfc18011acf7851f08c066ae462f3b9a56b4ba5e45242b7c9077305f83",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Routing\\Contracts\\CallableDispatcher",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Routing\\Contracts\\CallableDispatcher",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Routing/RoutingServiceProvider.php:192:194:0b7ae9ad63ec60379da476e0ab5c10b471a37059ddd167cf7261f47d5bc1696d",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Routing\\Contracts\\ControllerDispatcher",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Routing\\Contracts\\ControllerDispatcher",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Routing/RoutingServiceProvider.php:204:206:84ec56c0fbb5fa1aa9c9fbaf7aa3d496ff5318e8118b7baa595dbe95919c14ec",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Http\\Kernel",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Http\\Kernel",
            target: "Illuminate\\Foundation\\Http\\Kernel",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Console\\Kernel",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Console\\Kernel",
            target: "Illuminate\\Foundation\\Console\\Kernel",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Debug\\ExceptionHandler",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Debug\\ExceptionHandler",
            target: "Illuminate\\Foundation\\Exceptions\\Handler",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:env",
          attributes: {
            type: "factory",
            abstract: "env",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Container/Container.php:1857:1857:d5131031950acdfa819550c0cc58fc075cfbec53a8ee9cad4ee9d3bb935a0678",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:auth",
          attributes: {
            type: "factory",
            abstract: "auth",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Auth/AuthServiceProvider.php:37:37:781f898a1aa4c4b329e838afec0c1c0986ed540765b492ebd08f4953020e22c4",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:auth.driver",
          attributes: {
            type: "factory",
            abstract: "auth.driver",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Auth/AuthServiceProvider.php:39:39:214922b980072aa9e9c45a274e79ee4c6d735b6415e63d9c9e0e9490015070e0",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Auth\\Authenticatable",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Auth\\Authenticatable",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Auth/AuthServiceProvider.php:49:49:77cc198c6564aca09b2e0ed41962666054e13f41491cb021a9d27e69aecc17b3",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Auth\\Access\\Gate",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Auth\\Access\\Gate",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Auth/AuthServiceProvider.php:59:61:712ec9f145a5ce7f29426603f0fc82a68ee438dfdcba2e48553952f60b09f80e",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Auth\\Middleware\\RequirePassword",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Auth\\Middleware\\RequirePassword",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Auth/AuthServiceProvider.php:71:77:05c8942d1dc456d9bae8f1039fb40b2f774dc1b94e613cfbc5bdfa2d876db39e",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:cookie",
          attributes: {
            type: "factory",
            abstract: "cookie",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Cookie/CookieServiceProvider.php:16:22:7fa02a8fdc3cdb4b5b5c4d251421524ff93970aa0a2dd7b763589bec17dade93",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:db.factory",
          attributes: {
            type: "factory",
            abstract: "db.factory",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/DatabaseServiceProvider.php:60:62:415b9f77e2047e605edf8ce1efcefc16e3c6a3225d6eee7a62c0a07f2b8ad231",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:db",
          attributes: {
            type: "factory",
            abstract: "db",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/DatabaseServiceProvider.php:67:69:21de8d7da35a7f4da005555800a26f7eeda4f75a8a97f5a05f69b779431bd989",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:db.connection",
          attributes: {
            type: "factory",
            abstract: "db.connection",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/DatabaseServiceProvider.php:71:73:bef2bcda0dd522490f0a105e10e485544bfba955ddd2121987cae2b74557902a",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:db.schema",
          attributes: {
            type: "factory",
            abstract: "db.schema",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/DatabaseServiceProvider.php:75:77:cd361de56ea652d51645fc37183aa9eb91c48ec8c43e0bea2ecea3b7b4274748",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:db.transactions",
          attributes: {
            type: "factory",
            abstract: "db.transactions",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/DatabaseServiceProvider.php:79:81:32acf3a9190032bfa0aa742bf6d10abab2d32d6ee0c5f606e5ff5a1d08a68109",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Database\\ConcurrencyErrorDetector",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Contracts\\Database\\ConcurrencyErrorDetector",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/DatabaseServiceProvider.php:83:85:af0ec5bf8c916944f3d05900e4471dc7b1af2dc9c46f77a9c233296d63d4d24b",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Database\\LostConnectionDetector",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Database\\LostConnectionDetector",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/DatabaseServiceProvider.php:87:89:94db0dc2b5444b2115a4dea833cd30aa4a6025cfb1ff94ccb63558347867fab1",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Queue\\EntityResolver",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Queue\\EntityResolver",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/DatabaseServiceProvider.php:123:125:8637e65d76a6d5fa4ab8f91367618abf3c0dd7fb6fcda63fa3f9ca2588442293",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:encrypter",
          attributes: {
            type: "factory",
            abstract: "encrypter",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Encryption/EncryptionServiceProvider.php:29:37:b38f71355d036928550a9834f9742c59b192511266a772b03117d8eb62889783",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:files",
          attributes: {
            type: "factory",
            abstract: "files",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Filesystem/FilesystemServiceProvider.php:41:43:3506e4aee83ad7e5650e1e4b554655e9513607e7d7631f4e28cd243612bdfc66",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:filesystem",
          attributes: {
            type: "factory",
            abstract: "filesystem",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Filesystem/FilesystemServiceProvider.php:71:73:8a965e0a4bfe87599b658fe7c5203beb9bfac0ca40bda57e113cd29a038f8d51",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:filesystem.disk",
          attributes: {
            type: "factory",
            abstract: "filesystem.disk",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Filesystem/FilesystemServiceProvider.php:55:57:6a35580f073f5f976d0b0911d28cdc166e20a6f5ed619eb4b0cc34bc271966e3",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:filesystem.cloud",
          attributes: {
            type: "factory",
            abstract: "filesystem.cloud",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Filesystem/FilesystemServiceProvider.php:59:61:92783c9ce709ea252c4ab43345f5e26e67d2b8c9d97b963b6df948ce0eff1c8a",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Testing\\ParallelTesting",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Testing\\ParallelTesting",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Testing/ParallelTestingServiceProvider.php:37:39:f81010d21043d70ab34d955fe7581dd070db7e13c200bff9086510df07e1374f",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Console\\Scheduling\\Schedule",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Console\\Scheduling\\Schedule",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/FoundationServiceProvider.php:108:110:a89c43cc18f0a798122b117f5a8138b331f3e1a4de87b7dd5bc332397e72d37a",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Support\\Defer\\DeferredCallbackCollection",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Support\\Defer\\DeferredCallbackCollection",
            target: "Illuminate\\Support\\Defer\\DeferredCallbackCollection",
            shared: true,
            scoped: true,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\MaintenanceModeManager",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\MaintenanceModeManager",
            target: "Illuminate\\Foundation\\MaintenanceModeManager",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Foundation\\MaintenanceMode",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Foundation\\MaintenanceMode",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/FoundationServiceProvider.php:295:296:8e7a28fcc41cdf5e69dd1da1f276eae981e579d75c9a56915b49947aa3793de9",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Http\\Client\\Factory",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Http\\Client\\Factory",
            target: "Illuminate\\Http\\Client\\Factory",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Vite",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Vite",
            target: "Illuminate\\Foundation\\Vite",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Notifications\\ChannelManager",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Notifications\\ChannelManager",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Notifications/NotificationServiceProvider.php:34:34:2f0e6279539a82623387884369033846e70abaf2ea909aadcc2e5c5982616c3e",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:session",
          attributes: {
            type: "factory",
            abstract: "session",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Session/SessionServiceProvider.php:36:38:ed627c83c60db7e8b972ae4c4ca26c9f8215c507de99a8a64c18738c3328c0cb",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:session.store",
          attributes: {
            type: "factory",
            abstract: "session.store",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Session/SessionServiceProvider.php:48:53:3b55d9cbb0c55f756a223407ed49caede0b23b1d340837495711e21dd8fabacd",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Session\\Middleware\\StartSession",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Session\\Middleware\\StartSession",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Session/SessionServiceProvider.php:22:26:e9793e2e2ef521dea8d4246012214aaa81e3f2baba2633c44a106e91bbae0ffe",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:view",
          attributes: {
            type: "factory",
            abstract: "view",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/View/ViewServiceProvider.php:39:61:b6304f1cb2a0eecacdfc4521548ac3226cea3ffdf2296bff6ae523b2ad9e11e2",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:view.finder",
          attributes: {
            type: "factory",
            abstract: "view.finder",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/View/ViewServiceProvider.php:84:86:f00a38e03dc5a649bd75bc75aaf2a9b6bacc9d670e14184e34028ab35215ac41",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:blade.compiler",
          attributes: {
            type: "factory",
            abstract: "blade.compiler",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/View/ViewServiceProvider.php:96:107:81193c838e6e967be37cf3f35dbb5abd5d7d87467e0c1d05bbadee5dfb12621a",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:view.engine.resolver",
          attributes: {
            type: "factory",
            abstract: "view.engine.resolver",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/View/ViewServiceProvider.php:117:128:b3d98be0d4821b66f4ac1ed124788eb98be27ff3828a651cb0bf0e6f6681fa09",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:AssemblyState",
          attributes: {
            type: "factory",
            abstract: "AssemblyState",
            target: "AssemblyState",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:assembly.basic",
          attributes: {
            type: "factory",
            abstract: "assembly.basic",
            target: "AssemblyCatalog",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:assembly.extra",
          attributes: {
            type: "factory",
            abstract: "assembly.extra",
            target: "AssemblyAlternateCatalog",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Broadcasting\\BroadcastManager",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Broadcasting\\BroadcastManager",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Broadcasting/BroadcastServiceProvider.php:19:19:2f76f8efd0bed3f5e360ac4612660e07458d109e6109ea754c8f7950fcd88540",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Broadcasting\\Broadcaster",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Broadcasting\\Broadcaster",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Broadcasting/BroadcastServiceProvider.php:21:23:45a7680e66d50108785a4b08822e37e5bad861467a92e703ddb8f7900dab10f6",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Bus\\Dispatcher",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Bus\\Dispatcher",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Bus/BusServiceProvider.php:23:27:2573861c3dddd355ac9324e278aa0f18fd93453026fdee1080b2f4c7db1242a9",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Bus\\BatchRepository",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Bus\\BatchRepository",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Bus/BusServiceProvider.php:47:53:eb9a86815b82e5f4b061ea3078141cc7cdf06e923d2c5b54f5c9f1549d45af54",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Bus\\DatabaseBatchRepository",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Bus\\DatabaseBatchRepository",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Bus/BusServiceProvider.php:55:61:d87b6e282ee4fdf014e1f00ba1f9acedc3c1ef770ccf9fbcc4a913d79a3539c3",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Bus\\DynamoBatchRepository",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Bus\\DynamoBatchRepository",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Bus/BusServiceProvider.php:63:88:699c248f2c0d8f40c2923612160c7b2fd2ea1fbd180be31f8cacbe9ebdc0d6e5",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:cache",
          attributes: {
            type: "factory",
            abstract: "cache",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Cache/CacheServiceProvider.php:18:20:18addd784b8af8dc4553707d68b869627e3570b45f89e63aaf37c62a280cc846",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:cache.store",
          attributes: {
            type: "factory",
            abstract: "cache.store",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Cache/CacheServiceProvider.php:22:24:bae6c681efc1b70d243b7a7f9ebd6ea6b452832d11a9bbb453467fedb217404a",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:cache.psr6",
          attributes: {
            type: "factory",
            abstract: "cache.psr6",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Cache/CacheServiceProvider.php:26:28:faa6acaaeacb18558310ba6662a0887e69933eee940ec814ae89aa906448be3d",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:memcached.connector",
          attributes: {
            type: "factory",
            abstract: "memcached.connector",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Cache/CacheServiceProvider.php:30:32:cc0ed0d46c87ff2838ed74f7c10c8fc9a363dedc1957f9e1864a45fc5bb8ef8e",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Cache\\RateLimiter",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Cache\\RateLimiter",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Cache/CacheServiceProvider.php:34:38:f288c81d28b1fc1a7a45d038175816998c523546ec3ad3846c1dd2bff3ad8f92",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\AboutCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\AboutCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:304:306:10dfced9a6c52f440ce91b3a5d8f14058c01901c77c6e9cf017eac8654199cc9",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Cache\\Console\\ClearCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Cache\\Console\\ClearCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:316:318:c7aad4296586f3998ba0e7107c77a4845400de9019ef8d90337122fc0b7b1c45",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Cache\\Console\\ForgetCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Cache\\Console\\ForgetCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:328:330:40d580bc6ce5e90553a355ecf16bd8242af3ac0653d59398676c68d1ed07038f",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ClearCompiledCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ClearCompiledCommand",
            target: "Illuminate\\Foundation\\Console\\ClearCompiledCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Auth\\Console\\ClearResetsCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Auth\\Console\\ClearResetsCommand",
            target: "Illuminate\\Auth\\Console\\ClearResetsCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ConfigCacheCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ConfigCacheCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:400:402:353a83ee5e152585507be364d2ef97c089e08b7feb6fad30aeb1f4f401a9cf52",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ConfigClearCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ConfigClearCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:412:414:2ce99f8e1c7e8ac80ee7748c9ac16e5f1ac7840fcb885bd82449a25ec871985e",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ConfigShowCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ConfigShowCommand",
            target: "Illuminate\\Foundation\\Console\\ConfigShowCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\DbCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\DbCommand",
            target: "Illuminate\\Database\\Console\\DbCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\MonitorCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\MonitorCommand",
            target: "Illuminate\\Database\\Console\\MonitorCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\PruneCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\PruneCommand",
            target: "Illuminate\\Database\\Console\\PruneCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\ShowCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\ShowCommand",
            target: "Illuminate\\Database\\Console\\ShowCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\TableCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\TableCommand",
            target: "Illuminate\\Database\\Console\\TableCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\WipeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\WipeCommand",
            target: "Illuminate\\Database\\Console\\WipeCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\DownCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\DownCommand",
            target: "Illuminate\\Foundation\\Console\\DownCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\EnvironmentCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\EnvironmentCommand",
            target: "Illuminate\\Foundation\\Console\\EnvironmentCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\EnvironmentDecryptCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Foundation\\Console\\EnvironmentDecryptCommand",
            target:
              "Illuminate\\Foundation\\Console\\EnvironmentDecryptCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\EnvironmentEncryptCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Foundation\\Console\\EnvironmentEncryptCommand",
            target:
              "Illuminate\\Foundation\\Console\\EnvironmentEncryptCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\EventCacheCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\EventCacheCommand",
            target: "Illuminate\\Foundation\\Console\\EventCacheCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\EventClearCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\EventClearCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:520:522:b7de3eb5deb52deb758d22912afb375ca5c811224e838e11f492bfffec526f00",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\EventListCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\EventListCommand",
            target: "Illuminate\\Foundation\\Console\\EventListCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Concurrency\\Console\\InvokeSerializedClosureCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Concurrency\\Console\\InvokeSerializedClosureCommand",
            target:
              "Illuminate\\Concurrency\\Console\\InvokeSerializedClosureCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\KeyGenerateCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\KeyGenerateCommand",
            target: "Illuminate\\Foundation\\Console\\KeyGenerateCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\OptimizeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\OptimizeCommand",
            target: "Illuminate\\Foundation\\Console\\OptimizeCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\OptimizeClearCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\OptimizeClearCommand",
            target: "Illuminate\\Foundation\\Console\\OptimizeClearCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\PackageDiscoverCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\PackageDiscoverCommand",
            target: "Illuminate\\Foundation\\Console\\PackageDiscoverCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Cache\\Console\\PruneStaleTagsCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Cache\\Console\\PruneStaleTagsCommand",
            target: "Illuminate\\Cache\\Console\\PruneStaleTagsCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\ClearCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\ClearCommand",
            target: "Illuminate\\Queue\\Console\\ClearCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\ListFailedCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\ListFailedCommand",
            target: "Illuminate\\Queue\\Console\\ListFailedCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\FlushFailedCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\FlushFailedCommand",
            target: "Illuminate\\Queue\\Console\\FlushFailedCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\ForgetFailedCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\ForgetFailedCommand",
            target: "Illuminate\\Queue\\Console\\ForgetFailedCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\ListenCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\ListenCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:686:688:f7399d0d726a503d34d9c95e0a097b16ef34e553e92ba5d59a674a2027f8d1e7",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\MonitorCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\MonitorCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:698:700:c6ecbcc333636d65c0e7abdd1831d9adfae36e248736107a04d44875be25bd0b",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\PauseCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\PauseCommand",
            target: "Illuminate\\Queue\\Console\\PauseCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\PruneBatchesCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\PruneBatchesCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:710:712:c1a7ed9bc9e02020fe5bed7f91817c4dd99c8efff9a89f21f2617f098b8ddb71",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\PruneFailedJobsCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\PruneFailedJobsCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:722:724:e9246fbf2a542f3d235779f54c12e2c456b2ef0cdd27c39360b2669374f99366",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\RestartCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\RestartCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:734:736:4cac02a1bee109d67a79de87a57e7b4479c3af09cdc3beba550f850758802b35",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\ResumeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\ResumeCommand",
            target: "Illuminate\\Queue\\Console\\ResumeCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\RetryCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\RetryCommand",
            target: "Illuminate\\Queue\\Console\\RetryCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\RetryBatchCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\RetryBatchCommand",
            target: "Illuminate\\Queue\\Console\\RetryBatchCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\WorkCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\WorkCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:746:748:7f59ace4c6d138bb358ce5ef0ef582bad8a55a71c589e88e6438739a968de909",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ReloadCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ReloadCommand",
            target: "Illuminate\\Foundation\\Console\\ReloadCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\RouteCacheCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\RouteCacheCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:866:868:0ed6f9c93053675c7182d27bc9b2f60b111906db41a3ca1bc088f75c50f8472a",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\RouteClearCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\RouteClearCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:878:880:dfc513d575741b806f20b56cb5a3cb79a6c58c9d97dbf501b1353a0a17121703",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\RouteListCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\RouteListCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:890:892:02a127bfdcb27baff96695f719bcdb399ce35651197c1ec8ef96dea5b49878d0",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\DumpCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\DumpCommand",
            target: "Illuminate\\Database\\Console\\DumpCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Seeds\\SeedCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\Seeds\\SeedCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:902:904:09d3dcfeb990c96290aaf308be0217dacaf4b862c4723850a423f2f9fcba64c9",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Console\\Scheduling\\ScheduleFinishCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleFinishCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleFinishCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Console\\Scheduling\\ScheduleListCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleListCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleListCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Console\\Scheduling\\ScheduleRunCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleRunCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleRunCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Console\\Scheduling\\ScheduleClearCacheCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Console\\Scheduling\\ScheduleClearCacheCommand",
            target:
              "Illuminate\\Console\\Scheduling\\ScheduleClearCacheCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Console\\Scheduling\\ScheduleTestCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleTestCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleTestCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Console\\Scheduling\\ScheduleWorkCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleWorkCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleWorkCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Console\\Scheduling\\ScheduleInterruptCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Console\\Scheduling\\ScheduleInterruptCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleInterruptCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Console\\Scheduling\\SchedulePauseCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Console\\Scheduling\\SchedulePauseCommand",
            target: "Illuminate\\Console\\Scheduling\\SchedulePauseCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Console\\Scheduling\\ScheduleResumeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleResumeCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleResumeCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\ShowModelCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\ShowModelCommand",
            target: "Illuminate\\Database\\Console\\ShowModelCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\StorageLinkCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\StorageLinkCommand",
            target: "Illuminate\\Foundation\\Console\\StorageLinkCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\StorageUnlinkCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\StorageUnlinkCommand",
            target: "Illuminate\\Foundation\\Console\\StorageUnlinkCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\UpCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\UpCommand",
            target: "Illuminate\\Foundation\\Console\\UpCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ViewCacheCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ViewCacheCommand",
            target: "Illuminate\\Foundation\\Console\\ViewCacheCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ViewClearCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ViewClearCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:950:952:dd8f2ec4bec1143a04ce79a9fcfc3465a7f256672866e148ae07d37a5941a93e",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ApiInstallCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ApiInstallCommand",
            target: "Illuminate\\Foundation\\Console\\ApiInstallCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\BroadcastingInstallCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Foundation\\Console\\BroadcastingInstallCommand",
            target:
              "Illuminate\\Foundation\\Console\\BroadcastingInstallCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Cache\\Console\\CacheTableCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Cache\\Console\\CacheTableCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:340:342:2aec2fe14ca8fbef09b53871da5b0c4569ef9b6abd9314313c12737d0c9517c8",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\CastMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\CastMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:352:354:0310a0a9472cb5d1bbce904e436a7c0844600d67abd87bbc27afeaeeb43d9727",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ChannelListCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ChannelListCommand",
            target: "Illuminate\\Foundation\\Console\\ChannelListCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ChannelMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ChannelMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:364:366:8649868efa055ab13f1325d425b1f31df98d9e32a179e5b881919523c7495663",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ClassMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ClassMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:376:378:3b55d38491cf1115778936368290de5aaf06c192fe7bae5a14af39f6c2de722d",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ComponentMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ComponentMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:388:390:f16c8e58e4e6a1f07c1ee89a4cc915dfcecabfcc37072a488eb7e0175a796efd",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ConfigMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ConfigMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:424:426:6506495e53b714532861f89b830da48e441d8321ec39c2b3c7591f175c217fa8",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ConfigPublishCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ConfigPublishCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:436:438:204b57ccedcac1f88bb03f5696d66067642cfbfd4708e413b21c8a6e0384a981",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ConsoleMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ConsoleMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:448:450:311c5a3de23636ca8f9e930d471c0b9d8ebcf774d9a1489ba7d5064c9f245897",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Routing\\Console\\ControllerMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Routing\\Console\\ControllerMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:460:462:2e0d8a2d22a88417730b2a4c507cb9224edb9648e11fc5bb4df30be19eb6d01e",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\DevCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\DevCommand",
            target: "Illuminate\\Foundation\\Console\\DevCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\DevListCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\DevListCommand",
            target: "Illuminate\\Foundation\\Console\\DevListCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\DocsCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\DocsCommand",
            target: "Illuminate\\Foundation\\Console\\DocsCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\EnumMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\EnumMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:472:474:24961cc8594970cde0afa5c5e8f3e81cb7d7003cbaa0c68dec5e0d46640278fe",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\EventGenerateCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\EventGenerateCommand",
            target: "Illuminate\\Foundation\\Console\\EventGenerateCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\EventMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\EventMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:484:486:c554ce8b7d0e1dc182763de54eb6fd2ca2fc92b85c43c2df7d4f465e7e209ae9",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ExceptionMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ExceptionMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:496:498:b958cf31584fdfd8a0b2a35720a5fd0b4778948f14bb8d37eff1230e98576196",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Factories\\FactoryMakeCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Database\\Console\\Factories\\FactoryMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:508:510:36763d43c186ce4931e888ebb6642f8be51644326134b87304c6a31a2d573547",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\InterfaceMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\InterfaceMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:532:534:ccfb3c5cecd350dbe175d4778010cdc34f7e99d2b587f19d7d1b8075f95e80a1",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\JobMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\JobMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:544:546:bb852b284568db6078e00c342ba06c361346c8a5ce13bd682087366eff280f7d",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\JobMiddlewareMakeCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Foundation\\Console\\JobMiddlewareMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:556:558:788b139b96bd5523eeb818992d3c53c0f988bf8ac07363f37fc09e84e9767aed",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\LangPublishCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\LangPublishCommand",
            target: "Illuminate\\Foundation\\Console\\LangPublishCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ListenerMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ListenerMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:568:570:ccdd9f3308c4984231ff5982836062858608a3cc1dc54dc238473c197793ef35",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\MailMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\MailMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:580:582:8d3d99e896e8a2a950505ca0ee27ebfea8b7a6a3232f96dfa332ab6c671e7dcc",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Routing\\Console\\MiddlewareMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Routing\\Console\\MiddlewareMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:592:594:8e6cf01c982e01adf246d96cef3df6c9ffa483102a1e520d006e7488c1184199",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ModelMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ModelMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:604:606:83d7827c932dd19519eb7969f09daed36f104daeccd9df7414642bd6f0be77e6",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\NotificationMakeCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Foundation\\Console\\NotificationMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:616:618:bdb1de01d1eef4617c9f36153d9796890ddec3baedb65b0b14e205ad8593489e",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Notifications\\Console\\NotificationTableCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Notifications\\Console\\NotificationTableCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:628:630:2e68613915414da4559b737d15c7a5692fcdef934b968cced20d75dd3b427f29",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ObserverMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ObserverMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:640:642:c7fe98763f4da1af3f24aa0bda3ee983539f4634e4aff978c537ee8a7984df1b",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\PolicyMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\PolicyMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:652:654:84bf198280cc8ab26f78af9e0efcae54288021bde9346183cfe3f2dd8ee26918",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ProviderMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ProviderMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:664:666:c623c432cc527c9fd3493d8211bee68d1420c56a9e036189c8c3db37977cd57b",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\FailedTableCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\FailedTableCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:758:760:6b0389193ca9791c41f47cf2cbfac7a517c0161f62c4d56578fc950f0f04557f",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\TableCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\TableCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:770:772:66f50a4d05f0c75b6ff9fd3ced14b05b2c07350d5e0ec405150a1340a85356c5",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Queue\\Console\\BatchesTableCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Queue\\Console\\BatchesTableCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:782:784:ff1eeb4769f18de421352191053bbeb04228b129f62fde0116d174f908144f97",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\RequestMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\RequestMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:794:796:73c9954c9343705d6923cfe6789b1c30e0991dd1bfcf3347aaff51a1d6705a15",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ResourceMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ResourceMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:806:808:ee33842559723270af85420f0f62d554c49a29778f7401e8f710cfb2f34ea6ba",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\RuleMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\RuleMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:818:820:040924c728484d30e036406eff103d8c1e9be7335b75cf83b2608b445b336b68",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ScopeMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ScopeMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:830:832:94cb33d8372fcdc0e08b4b4118b52b7456451cb7ea8e2ea48e1163aa90ef5ac6",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Seeds\\SeederMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\Seeds\\SeederMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:842:844:8ff37e2f063e1b7872313257432c68930611a40cb286e7996eeae298060b701f",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Session\\Console\\SessionTableCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Session\\Console\\SessionTableCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:854:856:a087d9e2e03237e085ba0d5e3f34bbcdc5ffe2befe7ace922a7b6ee4da6c6607",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ServeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ServeCommand",
            target: "Illuminate\\Foundation\\Console\\ServeCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\StubPublishCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\StubPublishCommand",
            target: "Illuminate\\Foundation\\Console\\StubPublishCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\TestMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\TestMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:914:916:7d0caf34a2a797b77b8c1564e68c2435d4a7db811ee1020ada793bcd8cc24b79",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\TraitMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\TraitMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:926:928:db3c2d344f3bef296bbe1cf85f37193e43e1eec5f13c5bac585c737e72a37f97",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\VendorPublishCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\VendorPublishCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php:938:940:20d85aac142acda0d3277077249dda24b193814d9d738d2ebc93a421c13193f2",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Foundation\\Console\\ViewMakeCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Foundation\\Console\\ViewMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ViewMakeCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:migration.repository",
          attributes: {
            type: "factory",
            abstract: "migration.repository",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:61:67:597fdad06f206279ee35316277d0c54172812a89b6650863a9368cc3400a1558",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:migrator",
          attributes: {
            type: "factory",
            abstract: "migrator",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:80:84:ccb9aa336a19caab4569ab04dd483c7e3926865377210b496a225cc6985edb1b",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Migrations\\Migrator",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Migrations\\Migrator",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:86:86:46c9fc1c34a7ea21c8fd7fdf46deca8a3d42974a1e1bd7c095b7ede3a04a34f4",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:migration.creator",
          attributes: {
            type: "factory",
            abstract: "migration.creator",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:96:98:8ed3036040181271f6117539d78970b9d4a03a2212c11306a0dbf89a74297b8e",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Migrations\\MigrateCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\MigrateCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:123:125:f32650d904f6dedcaec5589ffc8aa82efa8a252a8702b35942e7164cbde119a9",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Migrations\\FreshCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\Migrations\\FreshCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:135:137:79fc29dc6605cc37a0444dd7bc44f792bdad74e82279341a911b85643aa8ab92",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Migrations\\InstallCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\InstallCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:147:149:8084b487c49f0a90d6c6832b291bf59fe83ee466566622ff88cfb983b7e7e876",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Migrations\\RefreshCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\RefreshCommand",
            target: "Illuminate\\Database\\Console\\Migrations\\RefreshCommand",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Migrations\\ResetCommand",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Database\\Console\\Migrations\\ResetCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:188:190:5df78a2c90802120a82863bc4381a7d9c015e486226e616cd16c3e39e63754b0",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Migrations\\RollbackCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\RollbackCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:200:202:8103b0747fa6d22ac4b1e7ba179dd77de2b19a906206e267c9211fd7db062f20",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Migrations\\StatusCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\StatusCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:212:214:02cfadddc4aeee478ef5a5234243e5358c19c4dc7a58ca2b76006401853c8e60",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Database\\Console\\Migrations\\MigrateMakeCommand",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\MigrateMakeCommand",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Database/MigrationServiceProvider.php:159:168:4036e50f8ceaf683f1d4285a0595965ad30953093c8f07d3c9174c1bd5db7b21",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:composer",
          attributes: {
            type: "factory",
            abstract: "composer",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Foundation/Providers/ComposerServiceProvider.php:18:20:04b7f4d32d9353bb54fc237c583cbc29059c65a5e0eda4f42c7c776b58e3ed0c",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Concurrency\\ConcurrencyManager",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Concurrency\\ConcurrencyManager",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Concurrency/ConcurrencyServiceProvider.php:17:19:513d9d2c83c8f8095cc0dabb57487dad36dfadc29f00023c8b1b37e6127a53d4",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:image",
          attributes: {
            type: "factory",
            abstract: "image",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Image/ImageServiceProvider.php:15:17:541c080292403959c1214d4503050e318586dea68f969e766e5ea1c1a219fb82",
            shared: true,
            scoped: true,
          },
        },
        {
          key: "factory:hash",
          attributes: {
            type: "factory",
            abstract: "hash",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Hashing/HashServiceProvider.php:17:19:cedc11b5b9a7656e900df50880986981baaa4dee9e472509e5c330bb85fa9ddf",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:hash.driver",
          attributes: {
            type: "factory",
            abstract: "hash.driver",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Hashing/HashServiceProvider.php:21:23:2dc34652d1c51fb9f29a2cd6720980b3fd9a0d0080c1f4bf754c0622f0ceb52a",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:mail.manager",
          attributes: {
            type: "factory",
            abstract: "mail.manager",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Mail/MailServiceProvider.php:28:30:fd233c11af6b08fad13e292a002d44f865427c8a8ecf3fbe184f48d30627b653",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:mailer",
          attributes: {
            type: "factory",
            abstract: "mailer",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Mail/MailServiceProvider.php:32:34:eaca0223289cd8cf864160158c3a3348f89e9dbe3c612aa55c75354ae1b0740c",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Mail\\Markdown",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Mail\\Markdown",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Mail/MailServiceProvider.php:50:58:c000ff36359782dc0a032d77ac8f0c489817e239f93f0e28e45d338f1f57f245",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:auth.password",
          attributes: {
            type: "factory",
            abstract: "auth.password",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Auth/Passwords/PasswordResetServiceProvider.php:27:29:a7451044e5b4d348551b454c757439d370e960ed759712b5422c62b564747818",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:auth.password.broker",
          attributes: {
            type: "factory",
            abstract: "auth.password.broker",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Auth/Passwords/PasswordResetServiceProvider.php:31:33:5bcc211778d88d148d6d97dda118ae11f049d33481602d14a719b36c39da1e17",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Pipeline\\Hub",
          attributes: {
            type: "factory",
            abstract: "Illuminate\\Contracts\\Pipeline\\Hub",
            target: "Illuminate\\Pipeline\\Hub",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:pipeline",
          attributes: {
            type: "factory",
            abstract: "pipeline",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Pipeline/PipelineServiceProvider.php:23:23:71318eee566fc051b98b15c79f1f328daf73fbb9d56e75700187e9e9d7b6be46",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:queue",
          attributes: {
            type: "factory",
            abstract: "queue",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Queue/QueueServiceProvider.php:80:87:c5d94cd48b4c89dcb404d19729e667a6649b34d9d8a2414405f35fa59442f6ed",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:queue.connection",
          attributes: {
            type: "factory",
            abstract: "queue.connection",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Queue/QueueServiceProvider.php:97:99:02d79d8e1324fc40d185b2c50ae1b23fd4d1e9894acd4155686940b3bddf7f3d",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:queue.worker",
          attributes: {
            type: "factory",
            abstract: "queue.worker",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Queue/QueueServiceProvider.php:242:277:b9ae0845b58d44b153b2cac18862673e6ca564391ee450249f79026303c46e78",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:queue.listener",
          attributes: {
            type: "factory",
            abstract: "queue.listener",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Queue/QueueServiceProvider.php:287:289:5a7a9c7c53d025d7848cb9d186bcb745191d27a91539361e82656fb2851cd4ff",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:queue.routes",
          attributes: {
            type: "factory",
            abstract: "queue.routes",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Queue/QueueServiceProvider.php:299:301:2883f0b02827124c9231fb392242d9e563e9354c2db00ec6990cd20ca38eee51",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:queue.failer",
          attributes: {
            type: "factory",
            abstract: "queue.failer",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Queue/QueueServiceProvider.php:311:334:15ebac8777b1cbca7393a4f1a40a28fdfedfd06750fbd5c9070108e40e15459c",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:redis",
          attributes: {
            type: "factory",
            abstract: "redis",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Redis/RedisServiceProvider.php:18:22:0ba94551c21d9e80168ccf4b5afca9c8ae5fc26f71bc4828a6a96fc693ac31ba",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:redis.connection",
          attributes: {
            type: "factory",
            abstract: "redis.connection",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Redis/RedisServiceProvider.php:24:26:f5503a366ade2f9fcbaca23df85d48255c08be527768357b67735e1a85d31a98",
            shared: false,
            scoped: false,
          },
        },
        {
          key: "factory:translation.loader",
          attributes: {
            type: "factory",
            abstract: "translation.loader",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Translation/TranslationServiceProvider.php:42:44:0952b4e8995e128c1d8c50c7560325182f337b4cd6353d82525040722a2e791b",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:translator",
          attributes: {
            type: "factory",
            abstract: "translator",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Translation/TranslationServiceProvider.php:19:32:4c258d0f1fba9f6e4686c291f7c0c9531c39d03ab65eab05c6731dd5ba255692",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:validation.presence",
          attributes: {
            type: "factory",
            abstract: "validation.presence",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Validation/ValidationServiceProvider.php:52:54:a493d1c3f7fcc5bba68063246bc65b3670f455ac4c6be57c324a8a2b8d19283f",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:Illuminate\\Contracts\\Validation\\UncompromisedVerifier",
          attributes: {
            type: "factory",
            abstract:
              "Illuminate\\Contracts\\Validation\\UncompromisedVerifier",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Validation/ValidationServiceProvider.php:64:66:876af4c2a6b1f80c0e70dc92f97f88ec3983b6981d363cafa16239784d5b9145",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "factory:validator",
          attributes: {
            type: "factory",
            abstract: "validator",
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Validation/ValidationServiceProvider.php:31:42:19bad22b067a14ac72519d637e40db1368783436e5cc768f7622d33dcf8f5f2a",
            shared: true,
            scoped: false,
          },
        },
        {
          key: "alias:Illuminate\\Foundation\\Application",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Foundation\\Application",
            target: "app",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Container\\Container",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Container\\Container",
            target: "app",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Foundation\\Application",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Foundation\\Application",
            target: "app",
          },
        },
        {
          key: "alias:Psr\\Container\\ContainerInterface",
          attributes: {
            type: "alias",
            abstract: "Psr\\Container\\ContainerInterface",
            target: "app",
          },
        },
        {
          key: "alias:Illuminate\\Auth\\AuthManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Auth\\AuthManager",
            target: "auth",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Auth\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Auth\\Factory",
            target: "auth",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Auth\\Guard",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Auth\\Guard",
            target: "auth.driver",
          },
        },
        {
          key: "alias:Illuminate\\Auth\\Passwords\\PasswordBrokerManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Auth\\Passwords\\PasswordBrokerManager",
            target: "auth.password",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Auth\\PasswordBrokerFactory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Auth\\PasswordBrokerFactory",
            target: "auth.password",
          },
        },
        {
          key: "alias:Illuminate\\Auth\\Passwords\\PasswordBroker",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Auth\\Passwords\\PasswordBroker",
            target: "auth.password.broker",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Auth\\PasswordBroker",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Auth\\PasswordBroker",
            target: "auth.password.broker",
          },
        },
        {
          key: "alias:Illuminate\\View\\Compilers\\BladeCompiler",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\View\\Compilers\\BladeCompiler",
            target: "blade.compiler",
          },
        },
        {
          key: "alias:Illuminate\\Cache\\CacheManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Cache\\CacheManager",
            target: "cache",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Cache\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Cache\\Factory",
            target: "cache",
          },
        },
        {
          key: "alias:Illuminate\\Cache\\Repository",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Cache\\Repository",
            target: "cache.store",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Cache\\Repository",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Cache\\Repository",
            target: "cache.store",
          },
        },
        {
          key: "alias:Psr\\SimpleCache\\CacheInterface",
          attributes: {
            type: "alias",
            abstract: "Psr\\SimpleCache\\CacheInterface",
            target: "cache.store",
          },
        },
        {
          key: "alias:Symfony\\Component\\Cache\\Adapter\\Psr16Adapter",
          attributes: {
            type: "alias",
            abstract: "Symfony\\Component\\Cache\\Adapter\\Psr16Adapter",
            target: "cache.psr6",
          },
        },
        {
          key: "alias:Symfony\\Component\\Cache\\Adapter\\AdapterInterface",
          attributes: {
            type: "alias",
            abstract: "Symfony\\Component\\Cache\\Adapter\\AdapterInterface",
            target: "cache.psr6",
          },
        },
        {
          key: "alias:Psr\\Cache\\CacheItemPoolInterface",
          attributes: {
            type: "alias",
            abstract: "Psr\\Cache\\CacheItemPoolInterface",
            target: "cache.psr6",
          },
        },
        {
          key: "alias:Illuminate\\Config\\Repository",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Config\\Repository",
            target: "config",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Config\\Repository",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Config\\Repository",
            target: "config",
          },
        },
        {
          key: "alias:Illuminate\\Cookie\\CookieJar",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Cookie\\CookieJar",
            target: "cookie",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Cookie\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Cookie\\Factory",
            target: "cookie",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Cookie\\QueueingFactory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Cookie\\QueueingFactory",
            target: "cookie",
          },
        },
        {
          key: "alias:Illuminate\\Database\\DatabaseManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Database\\DatabaseManager",
            target: "db",
          },
        },
        {
          key: "alias:Illuminate\\Database\\ConnectionResolverInterface",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Database\\ConnectionResolverInterface",
            target: "db",
          },
        },
        {
          key: "alias:Illuminate\\Database\\Connection",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Database\\Connection",
            target: "db.connection",
          },
        },
        {
          key: "alias:Illuminate\\Database\\ConnectionInterface",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Database\\ConnectionInterface",
            target: "db.connection",
          },
        },
        {
          key: "alias:Illuminate\\Database\\Schema\\Builder",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Database\\Schema\\Builder",
            target: "db.schema",
          },
        },
        {
          key: "alias:Illuminate\\Encryption\\Encrypter",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Encryption\\Encrypter",
            target: "encrypter",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Encryption\\Encrypter",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Encryption\\Encrypter",
            target: "encrypter",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Encryption\\StringEncrypter",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Encryption\\StringEncrypter",
            target: "encrypter",
          },
        },
        {
          key: "alias:Illuminate\\Events\\Dispatcher",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Events\\Dispatcher",
            target: "events",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Events\\Dispatcher",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Events\\Dispatcher",
            target: "events",
          },
        },
        {
          key: "alias:Illuminate\\Filesystem\\Filesystem",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Filesystem\\Filesystem",
            target: "files",
          },
        },
        {
          key: "alias:Illuminate\\Filesystem\\FilesystemManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Filesystem\\FilesystemManager",
            target: "filesystem",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Filesystem\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Filesystem\\Factory",
            target: "filesystem",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Filesystem\\Filesystem",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Filesystem\\Filesystem",
            target: "filesystem.disk",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Filesystem\\Cloud",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Filesystem\\Cloud",
            target: "filesystem.cloud",
          },
        },
        {
          key: "alias:Illuminate\\Hashing\\HashManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Hashing\\HashManager",
            target: "hash",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Hashing\\Hasher",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Hashing\\Hasher",
            target: "hash.driver",
          },
        },
        {
          key: "alias:Illuminate\\Image\\ImageManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Image\\ImageManager",
            target: "image",
          },
        },
        {
          key: "alias:Illuminate\\Log\\LogManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Log\\LogManager",
            target: "log",
          },
        },
        {
          key: "alias:Psr\\Log\\LoggerInterface",
          attributes: {
            type: "alias",
            abstract: "Psr\\Log\\LoggerInterface",
            target: "log",
          },
        },
        {
          key: "alias:Illuminate\\Mail\\MailManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Mail\\MailManager",
            target: "mail.manager",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Mail\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Mail\\Factory",
            target: "mail.manager",
          },
        },
        {
          key: "alias:Illuminate\\Mail\\Mailer",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Mail\\Mailer",
            target: "mailer",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Mail\\Mailer",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Mail\\Mailer",
            target: "mailer",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Mail\\MailQueue",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Mail\\MailQueue",
            target: "mailer",
          },
        },
        {
          key: "alias:Illuminate\\Queue\\QueueManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Queue\\QueueManager",
            target: "queue",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Queue\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Queue\\Factory",
            target: "queue",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Queue\\Monitor",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Queue\\Monitor",
            target: "queue",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Queue\\Queue",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Queue\\Queue",
            target: "queue.connection",
          },
        },
        {
          key: "alias:Illuminate\\Queue\\Failed\\FailedJobProviderInterface",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Queue\\Failed\\FailedJobProviderInterface",
            target: "queue.failer",
          },
        },
        {
          key: "alias:Illuminate\\Routing\\Redirector",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Routing\\Redirector",
            target: "redirect",
          },
        },
        {
          key: "alias:Illuminate\\Redis\\RedisManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Redis\\RedisManager",
            target: "redis",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Redis\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Redis\\Factory",
            target: "redis",
          },
        },
        {
          key: "alias:Illuminate\\Redis\\Connections\\Connection",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Redis\\Connections\\Connection",
            target: "redis.connection",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Redis\\Connection",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Redis\\Connection",
            target: "redis.connection",
          },
        },
        {
          key: "alias:Illuminate\\Http\\Request",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Http\\Request",
            target: "request",
          },
        },
        {
          key: "alias:Symfony\\Component\\HttpFoundation\\Request",
          attributes: {
            type: "alias",
            abstract: "Symfony\\Component\\HttpFoundation\\Request",
            target: "request",
          },
        },
        {
          key: "alias:Illuminate\\Routing\\Router",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Routing\\Router",
            target: "router",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Routing\\Registrar",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Routing\\Registrar",
            target: "router",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Routing\\BindingRegistrar",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Routing\\BindingRegistrar",
            target: "router",
          },
        },
        {
          key: "alias:Illuminate\\Session\\SessionManager",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Session\\SessionManager",
            target: "session",
          },
        },
        {
          key: "alias:Illuminate\\Session\\Store",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Session\\Store",
            target: "session.store",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Session\\Session",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Session\\Session",
            target: "session.store",
          },
        },
        {
          key: "alias:Illuminate\\Translation\\Translator",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Translation\\Translator",
            target: "translator",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Translation\\Translator",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Translation\\Translator",
            target: "translator",
          },
        },
        {
          key: "alias:Illuminate\\Routing\\UrlGenerator",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Routing\\UrlGenerator",
            target: "url",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Routing\\UrlGenerator",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Routing\\UrlGenerator",
            target: "url",
          },
        },
        {
          key: "alias:Illuminate\\Validation\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Validation\\Factory",
            target: "validator",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Validation\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Validation\\Factory",
            target: "validator",
          },
        },
        {
          key: "alias:Illuminate\\View\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\View\\Factory",
            target: "view",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\View\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\View\\Factory",
            target: "view",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Notifications\\Dispatcher",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Notifications\\Dispatcher",
            target: "Illuminate\\Notifications\\ChannelManager",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Notifications\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Notifications\\Factory",
            target: "Illuminate\\Notifications\\ChannelManager",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Broadcasting\\Factory",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Broadcasting\\Factory",
            target: "Illuminate\\Broadcasting\\BroadcastManager",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Bus\\Dispatcher",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Bus\\Dispatcher",
            target: "Illuminate\\Bus\\Dispatcher",
          },
        },
        {
          key: "alias:Illuminate\\Contracts\\Bus\\QueueingDispatcher",
          attributes: {
            type: "alias",
            abstract: "Illuminate\\Contracts\\Bus\\QueueingDispatcher",
            target: "Illuminate\\Contracts\\Bus\\Dispatcher",
          },
        },
        {
          key: "contextual:AssemblyConsumer:AssemblyCatalog",
          attributes: {
            type: "contextual",
            consumer: "AssemblyConsumer",
            abstract: "AssemblyCatalog",
            target: "AssemblyAlternateCatalog",
          },
        },
        {
          key: "instance:path",
          attributes: {
            type: "instance",
            abstract: "path",
            target: "project:app",
          },
        },
        {
          key: "instance:path.base",
          attributes: {
            type: "instance",
            abstract: "path.base",
            target: "project:.",
          },
        },
        {
          key: "instance:path.config",
          attributes: {
            type: "instance",
            abstract: "path.config",
            target: "project:config",
          },
        },
        {
          key: "instance:path.database",
          attributes: {
            type: "instance",
            abstract: "path.database",
            target: "project:database",
          },
        },
        {
          key: "instance:path.public",
          attributes: {
            type: "instance",
            abstract: "path.public",
            target: "project:public",
          },
        },
        {
          key: "instance:path.resources",
          attributes: {
            type: "instance",
            abstract: "path.resources",
            target: "project:resources",
          },
        },
        {
          key: "instance:path.storage",
          attributes: {
            type: "instance",
            abstract: "path.storage",
            target: "project:storage",
          },
        },
        {
          key: "instance:path.bootstrap",
          attributes: {
            type: "instance",
            abstract: "path.bootstrap",
            target: "project:bootstrap",
          },
        },
        {
          key: "instance:path.lang",
          attributes: {
            type: "instance",
            abstract: "path.lang",
            target: "project:lang",
          },
        },
        {
          key: "instance:app",
          attributes: {
            type: "instance",
            abstract: "app",
            target: "Illuminate\\Foundation\\Application",
          },
        },
        {
          key: "instance:Illuminate\\Container\\Container",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Container\\Container",
            target: "Illuminate\\Foundation\\Application",
          },
        },
        {
          key: "instance:events",
          attributes: {
            type: "instance",
            abstract: "events",
            target: "Illuminate\\Events\\Dispatcher",
          },
        },
        {
          key: "instance:router",
          attributes: {
            type: "instance",
            abstract: "router",
            target: "Illuminate\\Routing\\Router",
          },
        },
        {
          key: "instance:Illuminate\\Contracts\\Http\\Kernel",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Contracts\\Http\\Kernel",
            target: "Illuminate\\Foundation\\Http\\Kernel",
          },
        },
        {
          key: "instance:Illuminate\\Contracts\\Console\\Kernel",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Contracts\\Console\\Kernel",
            target: "Illuminate\\Foundation\\Console\\Kernel",
          },
        },
        {
          key: "instance:config_loaded_from_cache",
          attributes: {
            type: "instance",
            abstract: "config_loaded_from_cache",
            target:
              "scalar:fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa",
          },
        },
        {
          key: "instance:config",
          attributes: {
            type: "instance",
            abstract: "config",
            target: "Illuminate\\Config\\Repository",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\PackageManifest",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\PackageManifest",
            target: "Illuminate\\Foundation\\PackageManifest",
          },
        },
        {
          key: "instance:request",
          attributes: {
            type: "instance",
            abstract: "request",
            target: "Illuminate\\Http\\Request",
          },
        },
        {
          key: "instance:Illuminate\\Testing\\LoggedExceptionCollection",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Testing\\LoggedExceptionCollection",
            target: "Illuminate\\Testing\\LoggedExceptionCollection",
          },
        },
        {
          key: "instance:db.factory",
          attributes: {
            type: "instance",
            abstract: "db.factory",
            target: "Illuminate\\Database\\Connectors\\ConnectionFactory",
          },
        },
        {
          key: "instance:db",
          attributes: {
            type: "instance",
            abstract: "db",
            target: "Illuminate\\Database\\DatabaseManager",
          },
        },
        {
          key: "instance:files",
          attributes: {
            type: "instance",
            abstract: "files",
            target: "Illuminate\\Filesystem\\Filesystem",
          },
        },
        {
          key: "instance:routes.cached",
          attributes: {
            type: "instance",
            abstract: "routes.cached",
            target:
              "scalar:fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa",
          },
        },
        {
          key: "instance:Illuminate\\Testing\\ParallelTesting",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Testing\\ParallelTesting",
            target: "Illuminate\\Testing\\ParallelTesting",
          },
        },
        {
          key: "instance:date",
          attributes: {
            type: "instance",
            abstract: "date",
            target: "Illuminate\\Support\\DateFactory",
          },
        },
        {
          key: "instance:db.transactions",
          attributes: {
            type: "instance",
            abstract: "db.transactions",
            target: "Illuminate\\Database\\DatabaseTransactionsManager",
          },
        },
        {
          key: "instance:events.cached",
          attributes: {
            type: "instance",
            abstract: "events.cached",
            target:
              "scalar:fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa",
          },
        },
        {
          key: "instance:composer",
          attributes: {
            type: "instance",
            abstract: "composer",
            target: "Illuminate\\Support\\Composer",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\AboutCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\AboutCommand",
            target: "Illuminate\\Foundation\\Console\\AboutCommand",
          },
        },
        {
          key: "instance:cache",
          attributes: {
            type: "instance",
            abstract: "cache",
            target: "Illuminate\\Cache\\CacheManager",
          },
        },
        {
          key: "instance:Illuminate\\Cache\\Console\\ClearCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Cache\\Console\\ClearCommand",
            target: "Illuminate\\Cache\\Console\\ClearCommand",
          },
        },
        {
          key: "instance:Illuminate\\Cache\\Console\\ForgetCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Cache\\Console\\ForgetCommand",
            target: "Illuminate\\Cache\\Console\\ForgetCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ClearCompiledCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ClearCompiledCommand",
            target: "Illuminate\\Foundation\\Console\\ClearCompiledCommand",
          },
        },
        {
          key: "instance:Illuminate\\Auth\\Console\\ClearResetsCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Auth\\Console\\ClearResetsCommand",
            target: "Illuminate\\Auth\\Console\\ClearResetsCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ConfigCacheCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ConfigCacheCommand",
            target: "Illuminate\\Foundation\\Console\\ConfigCacheCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ConfigClearCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ConfigClearCommand",
            target: "Illuminate\\Foundation\\Console\\ConfigClearCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ConfigShowCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ConfigShowCommand",
            target: "Illuminate\\Foundation\\Console\\ConfigShowCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\DbCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\DbCommand",
            target: "Illuminate\\Database\\Console\\DbCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\MonitorCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\MonitorCommand",
            target: "Illuminate\\Database\\Console\\MonitorCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\PruneCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\PruneCommand",
            target: "Illuminate\\Database\\Console\\PruneCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\ShowCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\ShowCommand",
            target: "Illuminate\\Database\\Console\\ShowCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\TableCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\TableCommand",
            target: "Illuminate\\Database\\Console\\TableCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\WipeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\WipeCommand",
            target: "Illuminate\\Database\\Console\\WipeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\DownCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\DownCommand",
            target: "Illuminate\\Foundation\\Console\\DownCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\EnvironmentCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\EnvironmentCommand",
            target: "Illuminate\\Foundation\\Console\\EnvironmentCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\EnvironmentDecryptCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Foundation\\Console\\EnvironmentDecryptCommand",
            target:
              "Illuminate\\Foundation\\Console\\EnvironmentDecryptCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\EnvironmentEncryptCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Foundation\\Console\\EnvironmentEncryptCommand",
            target:
              "Illuminate\\Foundation\\Console\\EnvironmentEncryptCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\EventCacheCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\EventCacheCommand",
            target: "Illuminate\\Foundation\\Console\\EventCacheCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\EventClearCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\EventClearCommand",
            target: "Illuminate\\Foundation\\Console\\EventClearCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\EventListCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\EventListCommand",
            target: "Illuminate\\Foundation\\Console\\EventListCommand",
          },
        },
        {
          key: "instance:Illuminate\\Concurrency\\Console\\InvokeSerializedClosureCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Concurrency\\Console\\InvokeSerializedClosureCommand",
            target:
              "Illuminate\\Concurrency\\Console\\InvokeSerializedClosureCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\KeyGenerateCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\KeyGenerateCommand",
            target: "Illuminate\\Foundation\\Console\\KeyGenerateCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\OptimizeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\OptimizeCommand",
            target: "Illuminate\\Foundation\\Console\\OptimizeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\OptimizeClearCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\OptimizeClearCommand",
            target: "Illuminate\\Foundation\\Console\\OptimizeClearCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\PackageDiscoverCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\PackageDiscoverCommand",
            target: "Illuminate\\Foundation\\Console\\PackageDiscoverCommand",
          },
        },
        {
          key: "instance:Illuminate\\Cache\\Console\\PruneStaleTagsCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Cache\\Console\\PruneStaleTagsCommand",
            target: "Illuminate\\Cache\\Console\\PruneStaleTagsCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\ClearCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\ClearCommand",
            target: "Illuminate\\Queue\\Console\\ClearCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\ListFailedCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\ListFailedCommand",
            target: "Illuminate\\Queue\\Console\\ListFailedCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\FlushFailedCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\FlushFailedCommand",
            target: "Illuminate\\Queue\\Console\\FlushFailedCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\ForgetFailedCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\ForgetFailedCommand",
            target: "Illuminate\\Queue\\Console\\ForgetFailedCommand",
          },
        },
        {
          key: "instance:queue.listener",
          attributes: {
            type: "instance",
            abstract: "queue.listener",
            target: "Illuminate\\Queue\\Listener",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\ListenCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\ListenCommand",
            target: "Illuminate\\Queue\\Console\\ListenCommand",
          },
        },
        {
          key: "instance:queue",
          attributes: {
            type: "instance",
            abstract: "queue",
            target: "Illuminate\\Queue\\QueueManager",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\MonitorCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\MonitorCommand",
            target: "Illuminate\\Queue\\Console\\MonitorCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\PauseCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\PauseCommand",
            target: "Illuminate\\Queue\\Console\\PauseCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\PruneBatchesCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\PruneBatchesCommand",
            target: "Illuminate\\Queue\\Console\\PruneBatchesCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\PruneFailedJobsCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\PruneFailedJobsCommand",
            target: "Illuminate\\Queue\\Console\\PruneFailedJobsCommand",
          },
        },
        {
          key: "instance:cache.store",
          attributes: {
            type: "instance",
            abstract: "cache.store",
            target: "Illuminate\\Cache\\Repository",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\RestartCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\RestartCommand",
            target: "Illuminate\\Queue\\Console\\RestartCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\ResumeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\ResumeCommand",
            target: "Illuminate\\Queue\\Console\\ResumeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\RetryCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\RetryCommand",
            target: "Illuminate\\Queue\\Console\\RetryCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\RetryBatchCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\RetryBatchCommand",
            target: "Illuminate\\Queue\\Console\\RetryBatchCommand",
          },
        },
        {
          key: "instance:Illuminate\\Contracts\\Debug\\ExceptionHandler",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Contracts\\Debug\\ExceptionHandler",
            target: "Illuminate\\Foundation\\Exceptions\\Handler",
          },
        },
        {
          key: "instance:queue.worker",
          attributes: {
            type: "instance",
            abstract: "queue.worker",
            target: "Illuminate\\Queue\\Worker",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\WorkCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\WorkCommand",
            target: "Illuminate\\Queue\\Console\\WorkCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ReloadCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ReloadCommand",
            target: "Illuminate\\Foundation\\Console\\ReloadCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\RouteCacheCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\RouteCacheCommand",
            target: "Illuminate\\Foundation\\Console\\RouteCacheCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\RouteClearCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\RouteClearCommand",
            target: "Illuminate\\Foundation\\Console\\RouteClearCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\RouteListCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\RouteListCommand",
            target: "Illuminate\\Foundation\\Console\\RouteListCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\DumpCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\DumpCommand",
            target: "Illuminate\\Database\\Console\\DumpCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Seeds\\SeedCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\Seeds\\SeedCommand",
            target: "Illuminate\\Database\\Console\\Seeds\\SeedCommand",
          },
        },
        {
          key: "instance:Illuminate\\Console\\Scheduling\\ScheduleFinishCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleFinishCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleFinishCommand",
          },
        },
        {
          key: "instance:Illuminate\\Console\\Scheduling\\ScheduleListCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleListCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleListCommand",
          },
        },
        {
          key: "instance:Illuminate\\Console\\Scheduling\\ScheduleRunCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleRunCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleRunCommand",
          },
        },
        {
          key: "instance:Illuminate\\Console\\Scheduling\\ScheduleClearCacheCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Console\\Scheduling\\ScheduleClearCacheCommand",
            target:
              "Illuminate\\Console\\Scheduling\\ScheduleClearCacheCommand",
          },
        },
        {
          key: "instance:Illuminate\\Console\\Scheduling\\ScheduleTestCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleTestCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleTestCommand",
          },
        },
        {
          key: "instance:Illuminate\\Console\\Scheduling\\ScheduleWorkCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleWorkCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleWorkCommand",
          },
        },
        {
          key: "instance:Illuminate\\Console\\Scheduling\\ScheduleInterruptCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Console\\Scheduling\\ScheduleInterruptCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleInterruptCommand",
          },
        },
        {
          key: "instance:Illuminate\\Console\\Scheduling\\SchedulePauseCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Console\\Scheduling\\SchedulePauseCommand",
            target: "Illuminate\\Console\\Scheduling\\SchedulePauseCommand",
          },
        },
        {
          key: "instance:Illuminate\\Console\\Scheduling\\ScheduleResumeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Console\\Scheduling\\ScheduleResumeCommand",
            target: "Illuminate\\Console\\Scheduling\\ScheduleResumeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\ShowModelCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\ShowModelCommand",
            target: "Illuminate\\Database\\Console\\ShowModelCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\StorageLinkCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\StorageLinkCommand",
            target: "Illuminate\\Foundation\\Console\\StorageLinkCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\StorageUnlinkCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\StorageUnlinkCommand",
            target: "Illuminate\\Foundation\\Console\\StorageUnlinkCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\UpCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\UpCommand",
            target: "Illuminate\\Foundation\\Console\\UpCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ViewCacheCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ViewCacheCommand",
            target: "Illuminate\\Foundation\\Console\\ViewCacheCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ViewClearCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ViewClearCommand",
            target: "Illuminate\\Foundation\\Console\\ViewClearCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ApiInstallCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ApiInstallCommand",
            target: "Illuminate\\Foundation\\Console\\ApiInstallCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\BroadcastingInstallCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Foundation\\Console\\BroadcastingInstallCommand",
            target:
              "Illuminate\\Foundation\\Console\\BroadcastingInstallCommand",
          },
        },
        {
          key: "instance:Illuminate\\Cache\\Console\\CacheTableCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Cache\\Console\\CacheTableCommand",
            target: "Illuminate\\Cache\\Console\\CacheTableCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\CastMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\CastMakeCommand",
            target: "Illuminate\\Foundation\\Console\\CastMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ChannelListCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ChannelListCommand",
            target: "Illuminate\\Foundation\\Console\\ChannelListCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ChannelMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ChannelMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ChannelMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ClassMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ClassMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ClassMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ComponentMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ComponentMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ComponentMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ConfigMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ConfigMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ConfigMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ConfigPublishCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ConfigPublishCommand",
            target: "Illuminate\\Foundation\\Console\\ConfigPublishCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ConsoleMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ConsoleMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ConsoleMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Routing\\Console\\ControllerMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Routing\\Console\\ControllerMakeCommand",
            target: "Illuminate\\Routing\\Console\\ControllerMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\DevCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\DevCommand",
            target: "Illuminate\\Foundation\\Console\\DevCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\DevListCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\DevListCommand",
            target: "Illuminate\\Foundation\\Console\\DevListCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\DocsCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\DocsCommand",
            target: "Illuminate\\Foundation\\Console\\DocsCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\EnumMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\EnumMakeCommand",
            target: "Illuminate\\Foundation\\Console\\EnumMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\EventGenerateCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\EventGenerateCommand",
            target: "Illuminate\\Foundation\\Console\\EventGenerateCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\EventMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\EventMakeCommand",
            target: "Illuminate\\Foundation\\Console\\EventMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ExceptionMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ExceptionMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ExceptionMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Factories\\FactoryMakeCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Database\\Console\\Factories\\FactoryMakeCommand",
            target:
              "Illuminate\\Database\\Console\\Factories\\FactoryMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\InterfaceMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\InterfaceMakeCommand",
            target: "Illuminate\\Foundation\\Console\\InterfaceMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\JobMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\JobMakeCommand",
            target: "Illuminate\\Foundation\\Console\\JobMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\JobMiddlewareMakeCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Foundation\\Console\\JobMiddlewareMakeCommand",
            target: "Illuminate\\Foundation\\Console\\JobMiddlewareMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\LangPublishCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\LangPublishCommand",
            target: "Illuminate\\Foundation\\Console\\LangPublishCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ListenerMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ListenerMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ListenerMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\MailMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\MailMakeCommand",
            target: "Illuminate\\Foundation\\Console\\MailMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Routing\\Console\\MiddlewareMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Routing\\Console\\MiddlewareMakeCommand",
            target: "Illuminate\\Routing\\Console\\MiddlewareMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ModelMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ModelMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ModelMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\NotificationMakeCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Foundation\\Console\\NotificationMakeCommand",
            target: "Illuminate\\Foundation\\Console\\NotificationMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Notifications\\Console\\NotificationTableCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Notifications\\Console\\NotificationTableCommand",
            target:
              "Illuminate\\Notifications\\Console\\NotificationTableCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ObserverMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ObserverMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ObserverMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\PolicyMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\PolicyMakeCommand",
            target: "Illuminate\\Foundation\\Console\\PolicyMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ProviderMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ProviderMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ProviderMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\FailedTableCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\FailedTableCommand",
            target: "Illuminate\\Queue\\Console\\FailedTableCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\TableCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\TableCommand",
            target: "Illuminate\\Queue\\Console\\TableCommand",
          },
        },
        {
          key: "instance:Illuminate\\Queue\\Console\\BatchesTableCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Queue\\Console\\BatchesTableCommand",
            target: "Illuminate\\Queue\\Console\\BatchesTableCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\RequestMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\RequestMakeCommand",
            target: "Illuminate\\Foundation\\Console\\RequestMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ResourceMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ResourceMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ResourceMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\RuleMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\RuleMakeCommand",
            target: "Illuminate\\Foundation\\Console\\RuleMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ScopeMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ScopeMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ScopeMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Seeds\\SeederMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\Seeds\\SeederMakeCommand",
            target: "Illuminate\\Database\\Console\\Seeds\\SeederMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Session\\Console\\SessionTableCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Session\\Console\\SessionTableCommand",
            target: "Illuminate\\Session\\Console\\SessionTableCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ServeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ServeCommand",
            target: "Illuminate\\Foundation\\Console\\ServeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\StubPublishCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\StubPublishCommand",
            target: "Illuminate\\Foundation\\Console\\StubPublishCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\TestMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\TestMakeCommand",
            target: "Illuminate\\Foundation\\Console\\TestMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\TraitMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\TraitMakeCommand",
            target: "Illuminate\\Foundation\\Console\\TraitMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\VendorPublishCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\VendorPublishCommand",
            target: "Illuminate\\Foundation\\Console\\VendorPublishCommand",
          },
        },
        {
          key: "instance:Illuminate\\Foundation\\Console\\ViewMakeCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Foundation\\Console\\ViewMakeCommand",
            target: "Illuminate\\Foundation\\Console\\ViewMakeCommand",
          },
        },
        {
          key: "instance:migration.repository",
          attributes: {
            type: "instance",
            abstract: "migration.repository",
            target:
              "Illuminate\\Database\\Migrations\\DatabaseMigrationRepository",
          },
        },
        {
          key: "instance:migrator",
          attributes: {
            type: "instance",
            abstract: "migrator",
            target: "Illuminate\\Database\\Migrations\\Migrator",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Migrations\\MigrateCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\MigrateCommand",
            target: "Illuminate\\Database\\Console\\Migrations\\MigrateCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Migrations\\FreshCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\Migrations\\FreshCommand",
            target: "Illuminate\\Database\\Console\\Migrations\\FreshCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Migrations\\InstallCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\InstallCommand",
            target: "Illuminate\\Database\\Console\\Migrations\\InstallCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Migrations\\RefreshCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\RefreshCommand",
            target: "Illuminate\\Database\\Console\\Migrations\\RefreshCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Migrations\\ResetCommand",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Database\\Console\\Migrations\\ResetCommand",
            target: "Illuminate\\Database\\Console\\Migrations\\ResetCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Migrations\\RollbackCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\RollbackCommand",
            target:
              "Illuminate\\Database\\Console\\Migrations\\RollbackCommand",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Migrations\\StatusCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\StatusCommand",
            target: "Illuminate\\Database\\Console\\Migrations\\StatusCommand",
          },
        },
        {
          key: "instance:migration.creator",
          attributes: {
            type: "instance",
            abstract: "migration.creator",
            target: "Illuminate\\Database\\Migrations\\MigrationCreator",
          },
        },
        {
          key: "instance:Illuminate\\Database\\Console\\Migrations\\MigrateMakeCommand",
          attributes: {
            type: "instance",
            abstract:
              "Illuminate\\Database\\Console\\Migrations\\MigrateMakeCommand",
            target:
              "Illuminate\\Database\\Console\\Migrations\\MigrateMakeCommand",
          },
        },
        {
          key: "instance:Illuminate\\Console\\Scheduling\\Schedule",
          attributes: {
            type: "instance",
            abstract: "Illuminate\\Console\\Scheduling\\Schedule",
            target: "Illuminate\\Console\\Scheduling\\Schedule",
          },
        },
        {
          key: "tag:assembly.catalogs",
          attributes: {
            type: "tag",
            name: "assembly.catalogs",
            abstracts: ["assembly.basic", "assembly.extra"],
          },
        },
        {
          key: "extender:url:0",
          attributes: {
            type: "extender",
            abstract: "url",
            position: 0,
            target:
              "closure:vendor/laravel/framework/src/Illuminate/Routing/RoutingServiceProvider.php:70:92:83ce6688a9c648514ee6f9a42e663e2013dc5a784bb8670fcfe23035640d87b5",
          },
        },
        {
          key: "extender:assembly.basic:0",
          attributes: {
            type: "extender",
            abstract: "assembly.basic",
            position: 0,
            target:
              "closure:assembly.php:42:42:4886ef3a1877196dcca701dbe3365fb43bcbd10b28eb70ea6fe9ef0b6499542d",
          },
        },
        {
          key: "method:AssemblyJob@handle",
          attributes: {
            type: "method",
            method: "AssemblyJob@handle",
            target:
              "closure:assembly.php:44:44:61d3b0b686b95547853e7572dcd0baec3d201b66c9618a9f2d2e5f0cf6c17003",
          },
        },
        {
          key: "model-defaults:AssemblyItem",
          attributes: {
            type: "model-defaults",
            requestedClass: "AssemblyItem",
            class: "AssemblyItem",
            table: "items",
            connection: null,
            keyName: "id",
            keyType: "int",
            incrementing: true,
            timestamps: false,
            perPage: 15,
            eagerLoadsHash:
              "d8064f0ed8d4a80b24755b50d203829622529800bd5f7ee1917b5f77493aa805",
            eagerCountsHash:
              "377a0f672f66d9c1f778275404da357c06dc59f7c06c3f31d82b864cd366bdb8",
            castsHash:
              "dd3bcc06fd1067db1ab3ddee41d9ada7f847f21863530196da138f99c7497b07",
            defaultsHash:
              "377a0f672f66d9c1f778275404da357c06dc59f7c06c3f31d82b864cd366bdb8",
            appends: ["display"],
            fillable: [],
            guarded: [],
            globalScopes: [],
            lazyLoadingPrevented: true,
            lazyLoadingHandler: null,
          },
        },
      ],
    },
  ],
  requests: [
    {
      path: "/items",
      method: "GET",
      host: "root.example.test",
      port: 8080,
      headers: [
        {
          name: "Accept",
          value: "application/json",
        },
        {
          name: "X-Original",
          value: "original",
        },
      ],
      body: null,
      expected: {
        status: 200,
        body: '{"rows":[{"id":1,"parent_id":1,"score":7,"display":"first:7","parent":{"id":1,"owner_id":1,"owner":{"id":1,"label":"first"}}},{"id":2,"parent_id":2,"score":9,"display":"second:9","parent":{"id":2,"owner_id":2,"owner":{"id":2,"label":"second"}}}],"armed":[true,true],"existing":[[true,false],[true,false]],"notifications":4,"scheduled":1,"selected":1,"tags":["basic+extended","alternate"],"contextual":"alternate","method":"bound:basic+extended","terminatedBefore":0}',
        exceptionClass: null,
      },
    },
    {
      path: "/single",
      method: "GET",
      host: "root.example.test",
      port: 8080,
      headers: [
        {
          name: "Accept",
          value: "application/json",
        },
        {
          name: "X-Original",
          value: "original",
        },
      ],
      body: null,
      expected: {
        status: 200,
        body: '{"rows":[{"id":1,"parent_id":1,"score":7,"display":"first:7","parent":{"id":1,"owner_id":1,"owner":{"id":1,"label":"first"}}}],"armed":[false]}',
        exceptionClass: null,
      },
    },
    {
      path: "/package",
      method: "GET",
      host: "package.example.test",
      port: 8080,
      headers: [
        {
          name: "Accept",
          value: "application/json",
        },
        {
          name: "X-Original",
          value: "original",
        },
      ],
      body: null,
      expected: {
        status: 200,
        body: '{"route":"assembly.package","method":"GET","host":"package.example.test","port":8080}',
        exceptionClass: null,
      },
    },
    {
      path: "/package",
      method: "GET",
      host: "root.example.test",
      port: 8080,
      headers: [
        {
          name: "Accept",
          value: "application/json",
        },
        {
          name: "X-Original",
          value: "original",
        },
      ],
      body: null,
      expected: {
        status: 404,
        body: '{\n    "message": "The route package could not be found."\n}',
        exceptionClass:
          "Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException",
      },
    },
    {
      path: "/echo",
      method: "POST",
      host: "root.example.test",
      port: 8080,
      headers: [
        {
          name: "Accept",
          value: "application/json",
        },
        {
          name: "X-Original",
          value: "original",
        },
      ],
      body: "original Unicode: λ",
      expected: {
        status: 200,
        body: '{"body":"original Unicode: \\u03bb","header":"original","terminatedBefore":4}',
        exceptionClass: null,
      },
    },
  ],
};
