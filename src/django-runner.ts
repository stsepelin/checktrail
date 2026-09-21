export const djangoRunner = String.raw`
import contextlib, hashlib, json, sys
from datetime import datetime, timezone
from importlib.metadata import version, PackageNotFoundError

def identity(value):
    module = getattr(value, '__module__', None)
    name = getattr(value, '__qualname__', None)
    if not isinstance(module, str) or not isinstance(name, str):
        raise ValueError('Unsupported callable identity')
    return module + '.' + name

def capture():
    import django
    django.setup()
    from django.urls import get_resolver
    from django.urls.resolvers import URLPattern, URLResolver, RoutePattern, RegexPattern
    from django.urls.converters import IntConverter, StringConverter, UUIDConverter, SlugConverter, PathConverter
    supported_converters = (IntConverter, StringConverter, UUIDConverter, SlugConverter, PathConverter)
    entries = []
    visited = 0
    unsupported = 0
    def walk(routes, patterns, namespaces, defaults, depth):
        nonlocal visited, unsupported
        if depth > 32:
            raise ValueError('URL resolver depth limit exceeded')
        for route in routes:
            visited += 1
            if visited > 20000:
                raise ValueError('URL inventory entry limit exceeded')
            if type(route) not in (URLPattern, URLResolver) or type(route.pattern) not in (RoutePattern, RegexPattern):
                unsupported += 1
                continue
            pattern = route.pattern
            if type(pattern) is RoutePattern and type(pattern._route) is not str:
                unsupported += 1
                continue
            if any(type(converter) not in supported_converters for converter in pattern.converters.values()):
                unsupported += 1
                continue
            signature = json.dumps([type(pattern).__name__, pattern.regex.pattern, pattern.regex.flags, pattern._is_endpoint], separators=(',', ':'), ensure_ascii=False)
            fragments = patterns + [signature]
            values = {**defaults, **(route.default_kwargs if type(route) is URLResolver else route.default_args)}
            if type(route) is URLResolver:
                walk(route.url_patterns, fragments, namespaces + ([route.namespace] if route.namespace else []), values, depth + 1)
            else:
                values_json = json.dumps(values, sort_keys=True, separators=(',', ':'), allow_nan=False)
                handler = getattr(route.callback, 'view_class', route.callback)
                entries.append({
                    'key': json.dumps(fragments, separators=(',', ':'), ensure_ascii=False),
                    'attributes': {'patterns': fragments, 'namespaces': namespaces, 'handler': identity(handler),
                        'name': route.name, 'defaultsHash': hashlib.sha256(values_json.encode()).hexdigest()}
                })
    walk(get_resolver().url_patterns, [], [], {}, 0)
    return entries, visited, unsupported

try:
    try:
        installed = version('Django')
    except PackageNotFoundError:
        json.dump({'unavailable': 'django-runtime', 'reason': 'missing-package'}, sys.stdout)
        sys.exit(3)
    if installed != '6.1.1':
        json.dump({'unavailable': 'django-runtime', 'reason': 'unsupported-version'}, sys.stdout)
        sys.exit(3)
    config = json.loads(sys.argv[1])
    with contextlib.redirect_stdout(sys.stderr):
        entries, visited, unsupported = capture()
    json.dump({
        'version': 1, 'djangoVersion': installed, 'visitedNodes': visited, 'unsupportedNodes': unsupported,
        'runtime': {'schemaVersion': 1, 'format': 'runtime-inventory',
            'producer': {'name': 'checktrail.django-routes', 'version': '1.0.0'},
            'assembly': {'name': config['assembly'], 'environment': config['environment']},
            'sourceFingerprint': sys.argv[2], 'capturedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'collections': [{'kind': 'routes', 'complete': unsupported == 0, 'ordered': True, 'entries': entries}]}
    }, sys.stdout)
except Exception as error:
    print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
    sys.exit(2)
`;
