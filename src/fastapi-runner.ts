export const fastapiRunner = String.raw`
import asyncio, contextlib, importlib, json, sys
from datetime import datetime, timezone
from importlib.metadata import version, PackageNotFoundError

def identity(value):
    module = getattr(value, '__module__', None)
    name = getattr(value, '__qualname__', None)
    if not isinstance(module, str) or not isinstance(name, str):
        raise ValueError('Unsupported callable identity')
    return module + '.' + name

async def capture(config):
    from fastapi import FastAPI
    from fastapi.routing import APIRoute, APIWebSocketRoute
    from starlette.routing import Route, WebSocketRoute
    app = getattr(importlib.import_module(config['module']), config['attribute'])
    if not isinstance(app, FastAPI):
        raise ValueError('Configured object is not a FastAPI application')
    async with app.router.lifespan_context(app):
        entries = []
        indices = []
        supported = 0
        application = 0
        for index, route in enumerate(app.routes):
            if type(route) not in (APIRoute, APIWebSocketRoute, Route, WebSocketRoute):
                continue
            methods = sorted(route.methods) if isinstance(route, Route) else ['WEBSOCKET']
            protocol = 'http' if isinstance(route, Route) else 'websocket'
            if not methods:
                continue
            dependencies = []
            if isinstance(route, (APIRoute, APIWebSocketRoute)):
                application += 1
                pending = list(route.dependant.dependencies)
                visited = 0
                while pending:
                    dependency = pending.pop(0)
                    visited += 1
                    if visited > 1000:
                        raise ValueError('Dependency inventory exceeds limit')
                    dependencies.append(identity(dependency.call))
                    pending[0:0] = dependency.dependencies
            for method in methods:
                indices.append(index)
                key = 'HTTP ' + method + ' ' + route.path if protocol == 'http' else 'WEBSOCKET ' + route.path
                entries.append({'key': key, 'attributes': {
                    'protocol': protocol, 'method': method, 'path': route.path, 'handler': identity(route.endpoint),
                    'name': route.name, 'dependencies': dependencies,
                    'includeInSchema': bool(getattr(route, 'include_in_schema', False))
                }})
            supported += 1
            if len(entries) > 20000:
                raise ValueError('Route inventory exceeds limit')
        return entries, indices, len(app.routes), supported, application

try:
    try:
        versions = {'fastapi': version('fastapi'), 'starlette': version('starlette')}
    except PackageNotFoundError:
        json.dump({'unavailable': 'fastapi-runtime', 'reason': 'missing-package'}, sys.stdout)
        sys.exit(3)
    if versions != {'fastapi': '0.141.1', 'starlette': '1.6.0'}:
        json.dump({'unavailable': 'fastapi-runtime', 'reason': 'unsupported-version'}, sys.stdout)
        sys.exit(3)
    config = json.loads(sys.argv[1])
    with contextlib.redirect_stdout(sys.stderr):
        entries, indices, total, supported, application = asyncio.run(capture(config))
    json.dump({
        'version': 1, 'versions': versions, 'totalRoutes': total, 'supportedRoutes': supported,
        'applicationRoutes': application,
        'entryRouteIndices': indices,
        'runtime': {
            'schemaVersion': 1, 'format': 'runtime-inventory',
            'producer': {'name': 'checktrail.fastapi-routes', 'version': '1.0.0'},
            'assembly': {'name': config['assembly'], 'environment': config['environment']},
            'sourceFingerprint': sys.argv[2], 'capturedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'collections': [{'kind': 'routes', 'complete': supported == total, 'ordered': True, 'entries': entries}]
        }
    }, sys.stdout)
except Exception as error:
    print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
    sys.exit(2)
`;
