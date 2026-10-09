import { djangoAssemblyRuntimePins } from "./django-assembly-runtime-pins.js";
/** Executed only with operator trust, after isolated runtime/version/source-byte preflight. */
export const djangoAssemblyRunner = String.raw`
import contextlib, functools, hashlib, importlib, inspect, io, json, math, os, pathlib, shutil, stat, sys, tempfile, weakref
from datetime import datetime, timezone
from importlib.metadata import version, distribution, PackageNotFoundError
PINS = ${JSON.stringify(djangoAssemblyRuntimePins)}
class Unsupported(ValueError): pass

def canonical(value):
    result=json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
    if len(result)>4096: raise Unsupported('Encoded metadata exceeds limit')
    return result

def identity(value):
    # Only native asgiref adapters are unwrapped; arbitrary project wrappers stay visible.
    from asgiref.sync import AsyncToSync, SyncToAsync
    if type(value) is AsyncToSync: value=value.awaitable
    if type(value) is SyncToAsync: value=value.func
    if not (inspect.isfunction(value) or inspect.ismethod(value) or inspect.isclass(value)):
        raise Unsupported('Opaque callable identity')
    module,name=getattr(value,'__module__',None),getattr(value,'__qualname__',None)
    if type(module) is not str or type(name) is not str or len(module+'.'+name)>1024:
        raise Unsupported('Unsupported callable identity')
    return module+'.'+name

def metadata(value,depth=0):
    if depth>8: raise Unsupported('Metadata nesting exceeds limit')
    if value is None: return ['null']
    if type(value) is bool: return ['boolean',value]
    if type(value) is str and len(value)<=4096: return ['string',value]
    if type(value) in (int,float) and math.isfinite(value): return ['number',value]
    if type(value) in (list,tuple) and len(value)<=64: return ['list' if type(value) is list else 'tuple',[metadata(v,depth+1) for v in value]]
    if type(value) is dict and len(value)<=64 and all(type(k) is str for k in value): return ['object',[[k,metadata(value[k],depth+1)]for k in sorted(value)]]
    raise Unsupported('Unsupported metadata value')

def capture(config):
    from django.dispatch.dispatcher import Signal, _make_id
    from django.core.exceptions import MiddlewareNotUsed
    # Observe base native registrations before model-signal imports or project setup.
    original={name:getattr(Signal,name)for name in ('connect','disconnect','send','send_robust','asend','asend_robust')}
    signal_helpers={name:getattr(Signal,name)for name in ('_live_receivers','_clear_dead_receivers','has_listeners')}
    from django.apps import apps
    from django.core.handlers import base
    from django.core.handlers.wsgi import WSGIHandler
    from django.urls import get_resolver
    native_resolver=get_resolver;native_apps=apps.get_app_configs;native_import=base.import_string;native_loader=WSGIHandler.load_middleware
    records=weakref.WeakKeyDictionary(); generations=weakref.WeakKeyDictionary(); faults=weakref.WeakKeyDictionary()
    selected={}; events=[]; operations=0
    def registration(self,receiver,sender,weak,uid):
        nonlocal operations
        operations+=1
        if operations>4096: faults[self]='Signal operation limit';return
        try:
            if uid and type(uid) not in (str,int,bool): raise Unsupported('Opaque dispatch UID')
            if sender is not None and not (inspect.isclass(sender) or inspect.isfunction(sender)): raise Unsupported('Opaque signal sender')
            key=(uid,_make_id(sender)) if uid else (_make_id(receiver),_make_id(sender))
            with self.lock:
                self._clear_dead_receivers()
                row=next((r for r in self.receivers if r[0]==key),None)
                if row is None: return
                actual=row[1]() if isinstance(row[1],weakref.ReferenceType) else row[1]
                if actual is None or _make_id(actual)!=_make_id(receiver): return
                item={'receiver':identity(actual),'receiverId':_make_id(actual),'sender':None if sender is None else identity(sender),
                    'dispatchUid':canonical(metadata(uid)) if uid else None,'weak':isinstance(row[1],weakref.ReferenceType),'async':row[3]}
                previous=records.setdefault(self,{}).get(key)
                # Native duplicate UID attempts must retain the first receiver/weak mode.
                if previous is None or previous['receiverId']!=item['receiverId']:
                    records[self][key]=item;generations[self]=generations.get(self,0)+1
        except Unsupported as error: faults[self]=str(error)
    @functools.wraps(original['connect'])
    def connect(self,receiver,sender=None,weak=True,dispatch_uid=None):
        with self.lock:
            self._clear_dead_receivers()
            before=tuple(r[0]for r in self.receivers)
        result=original['connect'](self,receiver,sender=sender,weak=weak,dispatch_uid=dispatch_uid)
        with self.lock:
            after=tuple(r[0]for r in self.receivers)
        if before!=after: generations[self]=generations.get(self,0)+1
        registration(self,receiver,sender,weak,dispatch_uid)
        return result
    @functools.wraps(original['disconnect'])
    def disconnect(self,receiver=None,sender=None,dispatch_uid=None):
        nonlocal operations
        result=original['disconnect'](self,receiver=receiver,sender=sender,dispatch_uid=dispatch_uid)
        operations+=1
        if operations>4096: faults[self]='Signal operation limit'
        if result:
            generations[self]=generations.get(self,0)+1
            if not dispatch_uid or type(dispatch_uid) in (str,int,bool):
                key=(dispatch_uid,_make_id(sender)) if dispatch_uid else (_make_id(receiver),_make_id(sender))
                records.get(self,{}).pop(key,None)
        return result
    def event(self,method,sender,result):
        if id(self) not in selected: return
        if len(events)>=2048: raise Unsupported('Signal dispatch event limit')
        if sender is not None and not (inspect.isclass(sender) or inspect.isfunction(sender)): raise Unsupported('Opaque dispatch sender')
        events.append({'signal':selected[id(self)],'method':method,'sender':None if sender is None else identity(sender),
            'receivers':[identity(receiver)for receiver,_ in result],'errors':[isinstance(value,Exception)for _,value in result]})
    wrappers={'connect':connect,'disconnect':disconnect}
    for method in ('send','send_robust'):
        def make(method):
            @functools.wraps(original[method])
            def dispatch(self,sender,**named):
                result=original[method](self,sender,**named);event(self,method,sender,result);return result
            return dispatch
        wrappers[method]=make(method)
    for method in ('asend','asend_robust'):
        def make_async(method):
            @functools.wraps(original[method])
            async def dispatch(self,sender,**named):
                result=await original[method](self,sender,**named);event(self,method,sender,result);return result
            return dispatch
        wrappers[method]=make_async(method)
    for name,fn in wrappers.items(): setattr(Signal,name,fn)
    try:
        import django
        from django.db.models.signals import ModelSignal
        model_connect=ModelSignal.connect;model_disconnect=ModelSignal.disconnect
        django.setup()
        from django.apps import apps
        from django.conf import settings
        from django.core.handlers import base
        from django.core.handlers.wsgi import WSGIHandler
        from django.urls import get_resolver
        from django.urls.resolvers import URLPattern,URLResolver,RoutePattern,RegexPattern
        from django.urls.converters import IntConverter,StringConverter,UUIDConverter,SlugConverter,PathConverter
        converters=(IntConverter,StringConverter,UUIDConverter,SlugConverter,PathConverter)
        if base.import_string is not native_import or WSGIHandler.load_middleware is not native_loader or apps.get_app_configs.__func__ is not native_apps.__func__: raise Unsupported('Native assembly entry point changed')
        signals=[]
        for spec in config['signals']:
            signal=getattr(importlib.import_module(spec['module']),spec['attribute'])
            if type(signal) not in (Signal,ModelSignal) or id(signal) in selected: raise Unsupported('Unsupported or aliased selected signal')
            label=spec['module']+'.'+spec['attribute'];selected[id(signal)]=label;signals.append((label,signal))
        constructed=[];constructed_ids=[];factories={}
        declarations=list(settings.MIDDLEWARE)
        if len(declarations)>256: raise Unsupported('Middleware registration limit')
        def imported(name):
            factory=native_import(name);factories[name]=factory
            @functools.wraps(factory)
            def build(*args,**kwargs):
                index=len(declarations)-1-len(constructed)
                if index<0 or name!=declarations[index]: raise Unsupported('Middleware constructor order changed')
                row={'phase':'registration','position':index,'declared':name,'callable':identity(factory),'constructed':False}
                constructed.append(row)
                try: instance=factory(*args,**kwargs)
                except MiddlewareNotUsed: constructed_ids.append((index,id(factory),None));raise
                row['constructed']=True;constructed_ids.append((index,id(factory),id(instance)));return instance
            return build
        base.import_string=imported
        try: handler=WSGIHandler()
        finally: base.import_string=native_import
        if len(constructed)!=len(declarations): raise Unsupported('Incomplete middleware construction')
        def observers_intact():
            if any(getattr(Signal,k) is not v for k,v in {**wrappers,**signal_helpers}.items()) or ModelSignal.connect is not model_connect or ModelSignal.disconnect is not model_disconnect:
                raise Unsupported('Native signal observer changed')
            for _,signal in signals:
                if any(k in vars(signal)for k in {**wrappers,**signal_helpers}): raise Unsupported('Selected signal instance bypasses native observer')
        def inventory():
            observers_intact()
            entries={kind:[]for kind in ('routes','middleware','listeners','bindings')}; identities=[];visited=0;resolver_nodes=0
            def add(kind,attrs):
                if len(entries[kind])>=2048: raise Unsupported('Assembly collection limit')
                entries[kind].append({'key':canonical(attrs),'attributes':attrs})
            if not (apps.apps_ready and apps.models_ready and apps.ready): raise Unsupported('Incomplete native app registry')
            actual=list(native_apps())
            if len(actual)>256 or len(actual)!=len(settings.INSTALLED_APPS): raise Unsupported('App registry registration limit or count mismatch')
            for index,app in enumerate(actual):
                add('bindings',{'position':index,'declared':settings.INSTALLED_APPS[index],'name':app.name,'label':app.label,'config':identity(type(app)),
                    'ready':identity(app.ready),'defaultAutoField':app.default_auto_field,'models':app.models_module is not None})
                identities.append(('app',index,id(app),id(type(app)),_make_id(app.ready),id(app.models_module)))
            def walk(routes,patterns,namespaces,defaults,ancestry=(),prefix=()):
                nonlocal visited,resolver_nodes
                if len(prefix)>8 or id(routes) in ancestry: raise Unsupported('Cyclic or excessive URL resolver hierarchy')
                for index,route in enumerate(routes):
                    visited+=1
                    if visited>2048: raise Unsupported('Total URL hierarchy inventory limit')
                    if type(route) not in (URLPattern,URLResolver) or type(route.pattern) not in (RoutePattern,RegexPattern): raise Unsupported('Unsupported native URL pattern')
                    pattern=route.pattern
                    if type(pattern) is RoutePattern and type(pattern._route) is not str: raise Unsupported('Translated URL pattern outside selected profile')
                    if any(type(c) not in converters for c in pattern.converters.values()): raise Unsupported('Custom URL converter outside selected profile')
                    fragment=canonical([type(pattern).__name__,pattern.regex.pattern,pattern.regex.flags,pattern._is_endpoint])
                    chain=patterns+[fragment];values={**defaults,**(route.default_kwargs if type(route) is URLResolver else route.default_args)}
                    order=prefix+(index,);identities.append(('route',order,id(route),id(pattern)))
                    if type(route) is URLResolver:
                        resolver_nodes+=1
                        walk(route.url_patterns,chain,namespaces+([route.namespace]if route.namespace else []),values,ancestry+(id(routes),),order)
                    else:
                        callback=route.callback;target=getattr(callback,'view_class',callback)
                        identities.append(('callback',order,id(callback),id(target)))
                        add('routes',{'ordinal':'.'.join(map(str,order)),'patterns':chain,'namespaces':namespaces,'handler':identity(target),'name':route.name,
                            'defaultsHash':hashlib.sha256(canonical(metadata(values)).encode()).hexdigest()})
            walk(native_resolver().url_patterns,[],[],{})
            for row in sorted(constructed,key=lambda row:row['position']): add('middleware',row.copy())
            if list(settings.MIDDLEWARE)!=declarations: raise Unsupported('Middleware declarations changed')
            if base.import_string is not native_import or WSGIHandler.load_middleware is not native_loader: raise Unsupported('Native middleware assembly entry point changed')
            if any(native_import(name) is not factory for name,factory in factories.items()): raise Unsupported('Middleware factory identity changed')
            identities.extend(constructed_ids)
            for phase,field in [('view','_view_middleware'),('template','_template_response_middleware'),('exception','_exception_middleware')]:
                for index,hook in enumerate(getattr(handler,field)):
                    add('middleware',{'phase':phase,'position':index,'declared':None,'callable':identity(hook),'constructed':True})
                    target=hook.awaitable if type(hook).__name__=='AsyncToSync' else hook.func if type(hook).__name__=='SyncToAsync' else hook
                    identities.append((phase,index,_make_id(target)))
            identities.append(('chain',id(handler._middleware_chain)))
            for label,signal in signals:
                if signal in faults: raise Unsupported(faults[signal])
                with signal.lock:
                    signal._clear_dead_receivers()
                    active=list(signal.receivers)
                for index,(key,reference,sender_reference,async_) in enumerate(active):
                    receiver=reference()if isinstance(reference,weakref.ReferenceType)else reference
                    if receiver is None: raise Unsupported('Unreconciled dead signal receiver')
                    record=records.get(signal,{}).get(key)
                    if record is None or record['receiverId']!=_make_id(receiver): raise Unsupported('Unobserved selected signal registration')
                    attrs={k:v for k,v in record.items()if k!='receiverId'}
                    attrs.update({'signal':label,'position':index})
                    add('listeners',attrs)
                    identities.append(('receiver',label,index,key,_make_id(receiver),id(sender_reference)))
                identities.append(('signal',label,id(signal),generations.get(signal,0),signal.use_caching))
            return entries,identities,visited,resolver_nodes
        def request(spec):
            header_keys=set();environ={}
            for name,value in spec['headers']:
                key=name.upper().replace('-','_')
                if key in header_keys or key in ('HOST','CONTENT_LENGTH','CONTENT_TYPE'):
                    raise Unsupported('Colliding or reserved WSGI request header')
                header_keys.add(key);environ['HTTP_'+key]=value
            hostname,separator,port=spec['host'].partition(':')
            if separator and not 1<=int(port)<=65535: raise Unsupported('WSGI server port outside range')
            body=spec['body'].encode('utf8')
            if len(body)>32768: raise Unsupported('Request byte limit')
            environ.update({'REQUEST_METHOD':spec['method'],'PATH_INFO':spec['path'].encode('utf8').decode('latin1'),'SCRIPT_NAME':'','QUERY_STRING':'',
                'SERVER_NAME':hostname,'SERVER_PORT':port if separator else '80','HTTP_HOST':spec['host'],'SERVER_PROTOCOL':'HTTP/1.1','CONTENT_LENGTH':str(len(body)),
                'wsgi.version':(1,0),'wsgi.url_scheme':'http','wsgi.input':io.BytesIO(body),'wsgi.errors':io.StringIO(),'wsgi.multithread':False,'wsgi.multiprocess':False,'wsgi.run_once':False})
            statuses=[]
            def start_response(status,headers,exc_info=None):
                if statuses or exc_info is not None: raise Unsupported('Unsupported repeated WSGI response start')
                if type(status) is not str or len(status)<5 or not status[:3].isdigit() or status[3]!=' ': raise Unsupported('Malformed native WSGI status')
                code=int(status[:3])
                if not 100<=code<=599: raise Unsupported('Native WSGI status outside range')
                statuses.append(code)
            start=len(events);response=handler(environ,start_response);output=b'';chunks=0
            try:
                for part in response:
                    chunks+=1
                    if type(part) is not bytes or chunks>64 or len(output)+len(part)>65536: raise Unsupported('WSGI response byte or chunk limit')
                    output+=part
            finally: response.close()
            if len(statuses)!=1: raise Unsupported('Native WSGI response did not start')
            return {**{k:v for k,v in spec.items()if k!='expected'},'status':statuses[0],'responseBody':output.decode('utf8'),'events':events[start:]}
        initial=inventory();responses=[]
        for spec in config['requests']:
            responses.append(request(spec));current=inventory()
            if initial!=current: raise Unsupported('Assembly registrations changed during controlled requests')
        entries,_,visited,resolver_nodes=initial
        return {'version':2,'versions':versions,'visitedNodes':visited,'resolverNodes':resolver_nodes,'counts':[len(v)for v in entries.values()],
            'runtime':{'schemaVersion':1,'format':'runtime-inventory','producer':{'name':'checktrail.django-routes','version':'2.0.0'},
                'assembly':{'name':config['assembly'],'environment':config['environment']},'sourceFingerprint':sys.argv[2],
                'capturedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
                'collections':[{'kind':kind,'complete':True,'ordered':True,'entries':rows}for kind,rows in entries.items()]},'requests':responses}
    finally:
        for name,fn in original.items(): setattr(Signal,name,fn)

owned=None
try:
    try: versions={'python':'.'.join(map(str,sys.version_info[:3])),'django':version('Django'),'asgiref':version('asgiref')}
    except PackageNotFoundError:
        json.dump({'unavailable':'django-runtime','reason':'missing-package'},sys.stdout);sys.exit(3)
    if versions!={'python':'3.12.13','django':'6.1.1','asgiref':'3.12.1'}:
        json.dump({'unavailable':'django-runtime','reason':'unsupported-version'},sys.stdout);sys.exit(3)
    for pin in PINS:
        package=pin['file'].split('/')[0];file=pathlib.Path(distribution(package).locate_file(pin['file']))
        try:
            matched=stat.S_ISREG(file.lstat().st_mode)and not file.is_symlink();content=file.read_bytes()if matched else b''
        except OSError: content=b''
        if len(content)!=pin['bytes']or hashlib.sha256(content).hexdigest()!=pin['sha256']:
            json.dump({'unavailable':'django-runtime','reason':'runtime-byte-mismatch'},sys.stdout);sys.exit(3)
    owned=tempfile.mkdtemp(prefix='checktrail-django-bootstrap-');sys.pycache_prefix=owned;sys.dont_write_bytecode=True
    import django, asgiref.sync
    config=json.loads(sys.argv[1]);sys.path.insert(0,sys.argv[3]);os.environ['DJANGO_SETTINGS_MODULE']=config['settings']
    with contextlib.redirect_stdout(sys.stderr): result=capture(config)
    json.dump(result,sys.stdout,ensure_ascii=False,allow_nan=False)
except Unsupported as error:
    json.dump({'unsupported':'django-assembly','reason':str(error)},sys.stdout);sys.exit(4)
except Exception as error:
    print(type(error).__name__+': '+str(error),file=sys.stderr);sys.exit(2)
finally:
    if owned is not None: shutil.rmtree(owned)
`;
