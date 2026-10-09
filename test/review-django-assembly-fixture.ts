import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";
import type { z } from "zod";
import type { djangoConfigSchema } from "../src/django.js";
import { validate } from "../src/engine.js";
import { fixture } from "./helpers.js";
export const available =
  spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import sys;from importlib.metadata import version;assert sys.version_info[:3]==(3,12,13);assert [version(n)for n in ['Django','asgiref']]==['6.1.1','3.12.1']",
    ],
    { timeout: 10000 },
  ).status === 0;
export const source: Record<string, string> = {
  "catalog/__init__.py": "",
  "catalog/apps.py":
    "from django.apps import AppConfig\nclass CatalogConfig(AppConfig):\n    default=True\n    name='catalog'\n    def ready(self):\n        from project_signals import changed,notice,setup\n        setup.append('catalog.ready')\n        changed.connect(notice,weak=False,dispatch_uid='catalog.notice')\n        from django.urls import path\n        import urls,views\n        urls.urlpatterns.append(path('ready/',views.ready,name='ready'))\n",
  "extras/__init__.py": "",
  "extras/apps.py":
    "from django.apps import AppConfig\nclass ExtrasConfig(AppConfig):\n    name='extras'\n    verbose_name='Original extras'\n    def ready(self):\n        from project_signals import changed,notice,setup\n        setup.append('extras.ready')\n        changed.connect(notice,weak=False,dispatch_uid='catalog.notice')\n",
  "middleware.py":
    "from django.http import JsonResponse\nfrom django.core.exceptions import MiddlewareNotUsed\nclass Initialize:\n    def __init__(self,get_response):self.get_response=get_response\n    def __call__(self,request):\n        request.initialized=True\n        request.rows=[{'id':1},{'id':2}]\n        return self.get_response(request)\nclass Authorize:\n    def __init__(self,get_response):self.get_response=get_response\n    def __call__(self,request):\n        if not getattr(request,'initialized',False):return JsonResponse({'detail':'initialization required'},status=403)\n        return self.get_response(request)\nclass FirstHooks:\n    def __init__(self,get_response):self.get_response=get_response\n    def __call__(self,request):return self.get_response(request)\n    def process_view(self,request,view,args,kwargs):request.view_steps=['first'];return None\n    def process_template_response(self,request,response):response.context_data['trace']+='+first';return response\n    def process_exception(self,request,error):\n        if isinstance(error,ValueError):return JsonResponse({'handled':'native'},status=409)\nclass SecondHooks:\n    def __init__(self,get_response):self.get_response=get_response\n    def __call__(self,request):return self.get_response(request)\n    def process_view(self,request,view,args,kwargs):request.view_steps.append('second');return None\n    def process_template_response(self,request,response):response.context_data['trace']='second';return response\n    def process_exception(self,request,error):return None\nclass Unused:\n    def __init__(self,get_response):raise MiddlewareNotUsed('Original native omitted middleware')\n",
  "project_signals.py":
    "from django.dispatch import Signal\nchanged=Signal(use_caching=True)\nsetup=[]\nnotifications=[]\nclass OriginalSender:pass\ndef notice(sender,**kwargs):notifications.append(kwargs['row'])\n",
  "settings.py":
    "SECRET_KEY='original-synthetic-only'\nROOT_URLCONF='urls'\nINSTALLED_APPS=['catalog','extras.apps.ExtrasConfig']\nMIDDLEWARE=['middleware.Initialize','middleware.Authorize','middleware.FirstHooks','middleware.SecondHooks','middleware.Unused']\nALLOWED_HOSTS=['root.example.test']\nUSE_I18N=False\nTEMPLATES=[{'BACKEND':'django.template.backends.django.DjangoTemplates','OPTIONS':{'loaders':[('django.template.loaders.locmem.Loader',{'original.html':'{{ message }} {{ trace }}'})]}}]\n",
  "urls.py":
    "from django.urls import path,include,re_path\nimport views\nleaf=[path('items/<int:item_id>/',views.items,{'mode':'leaf'},name='items')]\nurlpatterns=[path('web/',include((leaf,'catalog'),namespace='web'),{'locale':'web','mode':'outer'}),path('mobile/',include((leaf,'catalog'),namespace='mobile'),{'locale':'mobile','mode':'outer'}),path('render/',views.render,name='render'),path('failure/',views.failure,name='failure')]\n",
  "views.py":
    "from django.http import JsonResponse\nfrom django.template.response import TemplateResponse\nfrom project_signals import changed,OriginalSender,notifications,setup\ndef items(request,item_id,locale,mode):\n    before=len(notifications)\n    for row in request.rows:changed.send(sender=OriginalSender,row=row['id'])\n    return JsonResponse({'items':request.rows,'notifications':len(notifications)-before,'route':request.resolver_match.view_name,'itemId':item_id,'locale':locale,'mode':mode,'view':request.view_steps})\ndef ready(request):return JsonResponse({'setup':setup})\ndef render(request):return TemplateResponse(request,'original.html',{'message':'native','trace':''})\ndef failure(request):raise ValueError('Original reached exception')\n",
};
/** Fixed synthetic operator contract for the direct native witness. */
export const profile: Extract<
  z.infer<typeof djangoConfigSchema>,
  { schemaVersion: 2 }
> = {
  schemaVersion: 2,
  settings: "settings",
  assembly: "original.django.assembly",
  environment: "test",
  signals: [
    {
      module: "project_signals",
      attribute: "changed",
    },
  ],
  expectedRoutes: [
    {
      ordinal: "0.0",
      patterns: [
        '["RoutePattern","^web/",32,false]',
        '["RoutePattern","^items/(?P<item_id>[0-9]+)/\\\\Z",32,true]',
      ],
      namespaces: ["web"],
      handler: "views.items",
      name: "items",
      defaultsHash:
        "40be9b04ccf086c514f2b2e7ab451788fd2b4ed97124f22805d9a0e4965c667d",
    },
    {
      ordinal: "1.0",
      patterns: [
        '["RoutePattern","^mobile/",32,false]',
        '["RoutePattern","^items/(?P<item_id>[0-9]+)/\\\\Z",32,true]',
      ],
      namespaces: ["mobile"],
      handler: "views.items",
      name: "items",
      defaultsHash:
        "1dddcae8fc36c0150c4a8a98daa92e75379e598df24e08d25ba9c9b50c304332",
    },
    {
      ordinal: "2",
      patterns: ['["RoutePattern","^render/\\\\Z",32,true]'],
      namespaces: [],
      handler: "views.render",
      name: "render",
      defaultsHash:
        "51d865c4d0211f7540b0b6bbd76c09de62cf66b70ec13707b1c783257bc4d927",
    },
    {
      ordinal: "3",
      patterns: ['["RoutePattern","^failure/\\\\Z",32,true]'],
      namespaces: [],
      handler: "views.failure",
      name: "failure",
      defaultsHash:
        "51d865c4d0211f7540b0b6bbd76c09de62cf66b70ec13707b1c783257bc4d927",
    },
    {
      ordinal: "4",
      patterns: ['["RoutePattern","^ready/\\\\Z",32,true]'],
      namespaces: [],
      handler: "views.ready",
      name: "ready",
      defaultsHash:
        "51d865c4d0211f7540b0b6bbd76c09de62cf66b70ec13707b1c783257bc4d927",
    },
  ],
  expectedMiddleware: [
    {
      phase: "registration",
      position: 0,
      declared: "middleware.Initialize",
      callable: "middleware.Initialize",
      constructed: true,
    },
    {
      phase: "registration",
      position: 1,
      declared: "middleware.Authorize",
      callable: "middleware.Authorize",
      constructed: true,
    },
    {
      phase: "registration",
      position: 2,
      declared: "middleware.FirstHooks",
      callable: "middleware.FirstHooks",
      constructed: true,
    },
    {
      phase: "registration",
      position: 3,
      declared: "middleware.SecondHooks",
      callable: "middleware.SecondHooks",
      constructed: true,
    },
    {
      phase: "registration",
      position: 4,
      declared: "middleware.Unused",
      callable: "middleware.Unused",
      constructed: false,
    },
    {
      phase: "view",
      position: 0,
      declared: null,
      callable: "middleware.FirstHooks.process_view",
      constructed: true,
    },
    {
      phase: "view",
      position: 1,
      declared: null,
      callable: "middleware.SecondHooks.process_view",
      constructed: true,
    },
    {
      phase: "template",
      position: 0,
      declared: null,
      callable: "middleware.SecondHooks.process_template_response",
      constructed: true,
    },
    {
      phase: "template",
      position: 1,
      declared: null,
      callable: "middleware.FirstHooks.process_template_response",
      constructed: true,
    },
    {
      phase: "exception",
      position: 0,
      declared: null,
      callable: "middleware.SecondHooks.process_exception",
      constructed: true,
    },
    {
      phase: "exception",
      position: 1,
      declared: null,
      callable: "middleware.FirstHooks.process_exception",
      constructed: true,
    },
  ],
  expectedSignals: [
    {
      signal: "project_signals.changed",
      position: 0,
      receiver: "project_signals.notice",
      sender: null,
      dispatchUid: '["string","catalog.notice"]',
      weak: false,
      async: false,
    },
  ],
  expectedApps: [
    {
      position: 0,
      declared: "catalog",
      name: "catalog",
      label: "catalog",
      config: "catalog.apps.CatalogConfig",
      ready: "catalog.apps.CatalogConfig.ready",
      defaultAutoField: "django.db.models.BigAutoField",
      models: false,
    },
    {
      position: 1,
      declared: "extras.apps.ExtrasConfig",
      name: "extras",
      label: "extras",
      config: "extras.apps.ExtrasConfig",
      ready: "extras.apps.ExtrasConfig.ready",
      defaultAutoField: "django.db.models.BigAutoField",
      models: false,
    },
  ],
  requests: [
    {
      path: "/web/items/7/",
      host: "root.example.test",
      method: "GET",
      headers: [],
      body: "",
      expected: {
        status: 200,
        body: '{"items": [{"id": 1}, {"id": 2}], "notifications": 2, "route": "web:items", "itemId": 7, "locale": "web", "mode": "leaf", "view": ["first", "second"]}',
        events: [
          {
            signal: "project_signals.changed",
            method: "send",
            sender: "project_signals.OriginalSender",
            receivers: ["project_signals.notice"],
            errors: [false],
          },
          {
            signal: "project_signals.changed",
            method: "send",
            sender: "project_signals.OriginalSender",
            receivers: ["project_signals.notice"],
            errors: [false],
          },
        ],
      },
    },
    {
      path: "/mobile/items/8/",
      host: "root.example.test",
      method: "GET",
      headers: [],
      body: "",
      expected: {
        status: 200,
        body: '{"items": [{"id": 1}, {"id": 2}], "notifications": 2, "route": "mobile:items", "itemId": 8, "locale": "mobile", "mode": "leaf", "view": ["first", "second"]}',
        events: [
          {
            signal: "project_signals.changed",
            method: "send",
            sender: "project_signals.OriginalSender",
            receivers: ["project_signals.notice"],
            errors: [false],
          },
          {
            signal: "project_signals.changed",
            method: "send",
            sender: "project_signals.OriginalSender",
            receivers: ["project_signals.notice"],
            errors: [false],
          },
        ],
      },
    },
    {
      path: "/ready/",
      host: "root.example.test",
      method: "GET",
      headers: [],
      body: "",
      expected: {
        status: 200,
        body: '{"setup": ["catalog.ready", "extras.ready"]}',
        events: [],
      },
    },
    {
      path: "/render/",
      host: "root.example.test",
      method: "GET",
      headers: [],
      body: "",
      expected: {
        status: 200,
        body: "native second+first",
        events: [],
      },
    },
    {
      path: "/failure/",
      host: "root.example.test",
      method: "GET",
      headers: [],
      body: "",
      expected: {
        status: 409,
        body: '{"handled": "native"}',
        events: [],
      },
    },
  ],
};
export async function project(
  t: TestContext,
  program = source,
  configuration: unknown = profile,
) {
  return fixture(t, {
    "pyproject.toml": "",
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["python.django-routes"] }],
    }),
    "checktrail.django.json": JSON.stringify(configuration),
    ...program,
  });
}
export async function run(
  t: TestContext,
  program = source,
  configuration: unknown = profile,
) {
  return validate(await project(t, program, configuration), { trusted: true });
}
