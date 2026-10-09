import { fastapiAssemblyRuntimePins } from "./fastapi-assembly-runtime-pins.js";
/** Runs only after operator trust; isolated Python bootstrap excludes project stdlib shadows. */
export const fastapiAssemblyRunner = String.raw`
import asyncio, contextlib, hashlib, importlib, inspect, json, math, os, pathlib, shutil, stat, sys, tempfile
from datetime import datetime, timezone
from importlib.metadata import version, distribution, PackageNotFoundError

PINS = ${JSON.stringify(fastapiAssemblyRuntimePins)}
class Unsupported(ValueError): pass

def canonical(value):
    result = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    if len(result) > 4096: raise Unsupported('Encoded metadata exceeds limit')
    return result

def identity(value):
    if not inspect.isfunction(value) and not inspect.ismethod(value) and not inspect.isclass(value): value = type(value)
    module, name = getattr(value, '__module__', None), getattr(value, '__qualname__', None)
    if not isinstance(module, str) or not isinstance(name, str) or len(module + '.' + name) > 1024:
        raise Unsupported('Unsupported callable identity')
    return module + '.' + name

def data(value, depth=0):
    if depth > 8: raise Unsupported('Metadata nesting exceeds limit')
    if value is None: return ['null']
    if type(value) is bool: return ['boolean', value]
    if type(value) is str:
        if len(value) > 4096: raise Unsupported('Metadata string exceeds limit')
        return ['string', value]
    if type(value) in (int, float):
        if not math.isfinite(value): raise Unsupported('Non-finite metadata')
        return ['number', value]
    if type(value) in (list, tuple):
        if len(value) > 64: raise Unsupported('Metadata list exceeds limit')
        return ['list' if type(value) is list else 'tuple', [data(item, depth+1) for item in value]]
    if type(value) in (set, frozenset):
        if len(value) > 64: raise Unsupported('Metadata set exceeds limit')
        return ['set' if type(value) is set else 'frozenset', sorted([data(item,depth+1) for item in value],key=canonical)]
    if type(value) is dict:
        if len(value) > 64 or any(type(key) is not str for key in value): raise Unsupported('Unsupported metadata object')
        return ['object', [[key, data(value[key], depth+1)] for key in sorted(value)]]
    if callable(value): return ['callable', identity(value)]
    raise Unsupported('Unsupported metadata value')

async def capture(config):
    from fastapi import FastAPI
    from fastapi.routing import APIRoute, APIWebSocketRoute, APIRouter, _IncludedRouter, iter_route_contexts
    from fastapi.dependencies.models import _get_oauth_scopes, _get_computed_scope
    from fastapi.security.base import SecurityBase
    from starlette.applications import Starlette
    from starlette.routing import Route, WebSocketRoute, Mount, Host, Router
    from pydantic import TypeAdapter
    app = getattr(importlib.import_module(config['module']), config['attribute'])
    if type(app) is not FastAPI: raise Unsupported('Configured object is not the selected FastAPI application')

    preflight_count = 0
    def preflight(owner, ancestry=(), depth=0):
        nonlocal preflight_count
        preflight_count += 1
        if preflight_count > 2048: raise Unsupported('Total hierarchy inventory limit')
        if depth > 8 or id(owner) in ancestry: raise Unsupported('Cyclic or excessive route hierarchy')
        if type(owner) not in (FastAPI, Starlette, APIRouter, Router): raise Unsupported('Opaque mounted ASGI target')
        router = owner.router if isinstance(owner, Starlette) else owner
        if getattr(router, '_low_priority_routes', []): raise Unsupported('Low priority routes outside selected inventory')
        if len(router.routes) > 2048: raise Unsupported('Route registration limit')
        preflight_count += len(router.routes)
        if preflight_count > 2048: raise Unsupported('Total hierarchy inventory limit')
        for route in router.routes:
            if type(route) is _IncludedRouter: preflight(route.original_router, ancestry+(id(owner),), depth+1)
            elif type(route) is Mount: preflight(route._base_app, ancestry+(id(owner),), depth+1)
            elif type(route) is Host: preflight(route.app, ancestry+(id(owner),), depth+1)
            elif type(route) not in (APIRoute, APIWebSocketRoute, Route, WebSocketRoute): raise Unsupported('Unsupported route class')

    def dependencies(dependant):
        result=[]
        def walk(node, order, ancestry=()):
            if len(order)>8 or id(node) in ancestry or len(result)>=256: raise Unsupported('Dependency inventory limit')
            call=node.call
            security=None
            if isinstance(call, SecurityBase):
                security={'scheme':call.scheme_name,'autoError':call.auto_error,'model':call.model.model_dump(mode='json',by_alias=True,exclude_none=True)}
            result.append(canonical({'order':order,'call':identity(call),'kind':'function' if inspect.isfunction(call) or inspect.ismethod(call) else 'instance',
                'useCache':node.use_cache,'scope':_get_computed_scope(dependant=node),'ownScopes':node.own_oauth_scopes or [],
                'parentScopes':node.parent_oauth_scopes or [],'effectiveScopes':_get_oauth_scopes(dependant=node),'security':security}))
            for index, child in enumerate(node.dependencies): walk(child,order+[index],ancestry+(id(node),))
        for index,node in enumerate(dependant.dependencies): walk(node,[index])
        return result

    def inventory():
        nonlocal preflight_count
        preflight_count=0
        preflight(app)
        entries={key:[] for key in ('routes','middleware','listeners','bindings')}
        identities=[]; applications=[]; application_routes=0; route_count=0; complete=True
        def add(kind, attrs):
            if len(entries[kind])>=2048: raise Unsupported('Assembly collection limit')
            # Keys bind the entire normalized registration; ordered collections retain multiplicity.
            entries[kind].append({'key':canonical(attrs),'attributes':attrs})
        def lifespan(context, scope, branch='', ancestry=()):
            if len(ancestry)>8 or id(context) in ancestry: raise Unsupported('Lifespan context limit')
            fn=inspect.unwrap(context)
            if identity(fn)=='fastapi.routing._merge_lifespan_context.<locals>.merged_lifespan':
                values=inspect.getclosurevars(fn).nonlocals
                if set(values)!={'original_context','nested_context'}: raise Unsupported('Unsupported merged lifespan closure')
                lifespan(values['original_context'],scope,branch+'0',ancestry+(id(context),))
                lifespan(values['nested_context'],scope,branch+'1',ancestry+(id(context),))
            else:
                add('listeners',{'scope':scope,'position':sum(e['attributes']['scope']==scope for e in entries['listeners']),
                    'kind':'context','callable':identity(context),'branch':branch})
        def walk(owner, scope_value, prefix=()):
            nonlocal application_routes,route_count,complete
            scope=canonical(scope_value)
            router=owner.router if isinstance(owner,Starlette) else owner
            if len(applications)>=256: raise Unsupported('Application inventory limit')
            applications.append(owner)
            identities.append(('owner',scope,id(owner),id(router.lifespan_context)))
            lifespan(router.lifespan_context,scope)
            for kind, handlers in [('startup',getattr(router,'on_startup',[])),('shutdown',getattr(router,'on_shutdown',[]))]:
                for callback in handlers:
                    add('listeners',{'scope':scope,'position':sum(e['attributes']['scope']==scope for e in entries['listeners']),
                        'kind':kind,'callable':identity(callback),'branch':''})
                    identities.append((kind,scope,id(callback)))
            for index,(original,replacement) in enumerate(getattr(owner,'dependency_overrides',{}).items()):
                add('bindings',{'scope':scope,'position':index,'original':identity(original),'replacement':identity(replacement)})
                identities.append(('binding',scope,id(original),id(replacement)))
            for index,middleware in enumerate(getattr(owner,'user_middleware',[])):
                add('middleware',{'scope':scope,'position':index,'kind':'user','name':identity(middleware.cls),
                    'arguments':canonical(data(middleware.args)),'options':canonical(data(middleware.kwargs)),'constructed':False})
                identities.append(('middleware',scope,id(middleware),id(middleware.cls)))
            stack=getattr(owner,'middleware_stack',None)
            if isinstance(owner,Starlette):
                if stack is None:
                    complete=False
                    add('middleware',{'scope':scope,'position':0,'kind':'native-unbuilt','name':identity(owner),'arguments':None,'options':None,'constructed':False})
                else:
                    seen=set();position=0
                    while stack is not router:
                        if id(stack) in seen or position>=256 or not hasattr(stack,'app'): raise Unsupported('Unsupported native middleware chain')
                        seen.add(id(stack))
                        add('middleware',{'scope':scope,'position':position,'kind':'native','name':identity(stack),'arguments':None,'options':None,'constructed':True})
                        stack=stack.app;position+=1
            for index,context in enumerate(iter_route_contexts(router.routes)):
                rc=context._route_context
                route=rc.starlette_route if rc is not None and rc.starlette_route is not None else (rc if rc is not None else context.route)
                ordinal='.'.join(str(i) for i in prefix+(index,))
                original=context.original_route
                identities.append(('route',scope,ordinal,id(original),id(original.endpoint) if hasattr(original,'endpoint') else None))
                if isinstance(route,Mount):
                    walk(route._base_app,scope_value+[{'kind':'mount','path':route.path,'name':route.name}],prefix+(index,))
                    continue
                if isinstance(route,Host):
                    walk(route.app,scope_value+[{'kind':'host','host':route.host,'name':route.name}],prefix+(index,))
                    continue
                is_api=isinstance(original,(APIRoute,APIWebSocketRoute))
                protocol='websocket' if isinstance(original,WebSocketRoute) else 'http'
                methods=['WEBSOCKET'] if protocol=='websocket' else sorted(route.methods)
                if not methods: raise Unsupported('Empty native method registration')
                route_count+=1;application_routes+=int(is_api)
                model=getattr(route,'response_model',None)
                response_class=getattr(route,'response_class',None)
                if response_class is not None and hasattr(response_class,'value'): response_class=response_class.value
                options={name:getattr(route,name,None) for name in ['response_model_by_alias','response_model_exclude_unset','response_model_exclude_defaults','response_model_exclude_none']}
                options['include']=data(getattr(route,'response_model_include',None));options['exclude']=data(getattr(route,'response_model_exclude',None))
                for method in methods:
                    add('routes',{'scope':scope,'ordinal':ordinal,'protocol':protocol,'method':method,'path':route.path,
                        'handler':identity(route.endpoint),'name':route.name,'dependencies':dependencies(route.dependant) if is_api else [],
                        'responseModel':canonical(TypeAdapter(model).json_schema(mode='serialization')) if model is not None else None,
                        'responseClass':identity(response_class) if response_class is not None else None,'responseOptions':canonical(options),
                        'statusCode':getattr(route,'status_code',None),'includeInSchema':bool(getattr(route,'include_in_schema',False)),'application':is_api})
        walk(app,[])
        # Native stacks may be built lazily by requests; stable registration identity excludes those nodes.
        stable={key:[e for e in value if key!='middleware' or e['attributes']['kind']=='user'] for key,value in entries.items()}
        return entries,identities,stable,complete,application_routes,route_count,len(applications)

    async def request(spec,state):
        received=0;frames=[];body=bytearray();status=None;ended=False;accepted=False
        target_host,separator,target_port=spec['host'].partition(':')
        scope={'type':spec['protocol'],'asgi':{'version':'3.0','spec_version':'2.4'},'path':spec['path'],
            'raw_path':spec['path'].encode('utf8'),'root_path':'','query_string':b'',
            'headers':[(b'host',spec['host'].encode('ascii'))]+[(k.lower().encode('ascii'),v.encode('latin1')) for k,v in spec['headers']],
            'scheme':'http' if spec['protocol']=='http' else 'ws','client':('127.0.0.1',1),'server':(target_host,int(target_port) if separator else 80),'state':dict(state)}
        if spec['protocol']=='http': scope.update(method=spec['method'],http_version='1.1')
        else: scope['subprotocols']=[]
        async def receive():
            nonlocal received
            received+=1
            if received>64: raise Unsupported('ASGI receive limit')
            if received==1: return {'type':'http.request','body':spec['body'].encode('utf8'),'more_body':False} if spec['protocol']=='http' else {'type':'websocket.connect'}
            return {'type':'http.disconnect'} if spec['protocol']=='http' else {'type':'websocket.disconnect','code':1000}
        async def send(message):
            nonlocal status,ended,accepted
            if ended or len(frames)>=64: raise Unsupported('ASGI send limit or post-completion frame')
            kind=message.get('type')
            if spec['protocol']=='http':
                if kind=='http.response.start':
                    if status is not None: raise Unsupported('Duplicate HTTP response start')
                    status=message['status']
                elif kind=='http.response.body':
                    if status is None: raise Unsupported('HTTP body before start')
                    body.extend(message.get('body',b''))
                    if len(body)>65536: raise Unsupported('HTTP response body limit')
                    ended=not message.get('more_body',False)
                else: raise Unsupported('Unsupported HTTP response event')
                frames.append(kind)
            else:
                if kind not in ('websocket.accept','websocket.send','websocket.close'): raise Unsupported('Unsupported WebSocket response event')
                if kind=='websocket.accept':
                    if accepted: raise Unsupported('Duplicate WebSocket accept')
                    accepted=True
                if kind=='websocket.send' and not accepted: raise Unsupported('WebSocket send before accept')
                if message.get('bytes') is not None: raise Unsupported('Binary WebSocket response unsupported')
                frames.append(canonical(message));ended=kind=='websocket.close'
        await app(scope,receive,send)
        if not ended: raise Unsupported('ASGI response did not complete')
        return {**{k:v for k,v in spec.items() if k!='expected'},'status':status,
            'responseBody':body.decode('utf8') if spec['protocol']=='http' else None,
            'messages':[] if spec['protocol']=='http' else frames}

    responses=[]
    preflight(app)
    async with app.router.lifespan_context(app) as state:
        if state is not None and type(state) is not dict: raise Unsupported('Unsupported lifespan state')
        initial=inventory()
        for spec in config['requests']:
            responses.append(await request(spec,state or {}))
            current=inventory()
            if initial[1]!=current[1] or initial[2]!=current[2]: raise Unsupported('Assembly registrations changed during controlled requests')
        final=inventory()
    after=inventory()
    if final[1]!=after[1] or final[2]!=after[2]: raise Unsupported('Assembly registrations changed during lifespan shutdown')
    entries,_,_,complete,application_routes,route_count,application_count=final
    return {'version':2,'versions':versions,'applicationRoutes':application_routes,'applicationCount':application_count,
        'routeCount':route_count,'middlewareCount':len(entries['middleware']),'lifespanCount':len(entries['listeners']),'bindingCount':len(entries['bindings']),
        'runtime':{'schemaVersion':1,'format':'runtime-inventory','producer':{'name':'checktrail.fastapi-routes','version':'2.0.0'},
            'assembly':{'name':config['assembly'],'environment':config['environment']},'sourceFingerprint':sys.argv[2],
            'capturedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
            'collections':[{'kind':kind,'complete':complete,'ordered':True,'entries':value} for kind,value in entries.items()]},'requests':responses}

owned=None
try:
    try:
        versions={'python':'.'.join(map(str,sys.version_info[:3])),'fastapi':version('fastapi'),'starlette':version('starlette'),'pydantic':version('pydantic')}
    except PackageNotFoundError:
        json.dump({'unavailable':'fastapi-runtime','reason':'missing-package'},sys.stdout);sys.exit(3)
    if versions!={'python':'3.12.13','fastapi':'0.141.1','starlette':'1.6.0','pydantic':'2.13.5'}:
        json.dump({'unavailable':'fastapi-runtime','reason':'unsupported-version'},sys.stdout);sys.exit(3)
    for pin in PINS:
        package=pin['file'].split('/')[0];file=pathlib.Path(distribution(package).locate_file(pin['file']))
        try:
            matched=stat.S_ISREG(file.lstat().st_mode) and not file.is_symlink()
            content=file.read_bytes() if matched else b''
        except OSError: content=b''
        if len(content)!=pin['bytes'] or hashlib.sha256(content).hexdigest()!=pin['sha256']:
            json.dump({'unavailable':'fastapi-runtime','reason':'runtime-byte-mismatch'},sys.stdout);sys.exit(3)
    # -B alone still reads stale pyc files. A unique empty prefix excludes those caches.
    owned=tempfile.mkdtemp(prefix='checktrail-fastapi-bootstrap-');sys.pycache_prefix=owned;sys.dont_write_bytecode=True
    import fastapi, starlette, pydantic
    config=json.loads(sys.argv[1])
    sys.path.insert(0,sys.argv[3])
    with contextlib.redirect_stdout(sys.stderr): result=asyncio.run(capture(config))
    json.dump(result,sys.stdout,ensure_ascii=False,allow_nan=False)
except Unsupported as error:
    json.dump({'unsupported':'fastapi-assembly','reason':str(error)},sys.stdout);sys.exit(4)
except Exception as error:
    print(type(error).__name__+': '+str(error),file=sys.stderr);sys.exit(2)
finally:
    if owned is not None: shutil.rmtree(owned)
`;
