"""Finite data-only contract for regenerated original GCC12 SDK state.

These51 known generated files remain visible as before/after metadata, require
separately authenticated generator/package/input and physical regeneration
witnesses, and never grant SDK/native/GateA credit from this JSON comparison.
Every other compiler/header/library/font/config/script byte remains compared.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re

spec=importlib.util.spec_from_file_location('sdk_material',Path(__file__).with_name('gcc-sdk-material.py'))
material=importlib.util.module_from_spec(spec);spec.loader.exec_module(material)
require=material.require
POLICY='gcc12-original-sdk-generated-state-v1'
MEMBER_LIMIT=64*1024**2
AGGREGATE_LIMIT=128*1024**2
# Exact selected producer paths. No directory/pattern waiver is accepted.
KNOWN_MODES = {'/var/cache/fontconfig/188ac73a183f12857f63bb60a4a6d603-le64.cache-8': 420,
 '/var/cache/fontconfig/32b6488e5b8292a2e95c79d947e009e8-le64.cache-8': 420,
 '/var/cache/fontconfig/3830d5c3ddfd5cd38a049b759396e72e-le64.cache-8': 420,
 '/var/cache/fontconfig/467c019e582ee353435ea5c21d137ef6-le64.cache-8': 420,
 '/var/cache/fontconfig/4c599c202bc5c08e2d34565a40eac3b2-le64.cache-8': 420,
 '/var/cache/fontconfig/573ec803664ed168555e0e8b6d0f0c7f-le64.cache-8': 420,
 '/var/cache/fontconfig/57e423e26b20ab21d0f2f29c145174c3-le64.cache-8': 420,
 '/var/cache/fontconfig/6333f38776742d18e214673cd2c24e34-le64.cache-8': 420,
 '/var/cache/fontconfig/6cc790b63b123a6a96ee260fcdad32a9-le64.cache-8': 420,
 '/var/cache/fontconfig/707971e003b4ae6c8121c3a920e507f5-le64.cache-8': 420,
 '/var/cache/fontconfig/7ef2298fde41cc6eeb7af42e48b7d293-le64.cache-8': 420,
 '/var/cache/fontconfig/95530828ff6c81d309f8258d8d02a23e-le64.cache-8': 420,
 '/var/cache/fontconfig/a4e60e8d1e10d2fdff3fe3037a1845fb-le64.cache-8': 420,
 '/var/cache/fontconfig/c855463f699352c367813e37f3f70ea7-le64.cache-8': 420,
 '/var/cache/fontconfig/d3e5c4ee2ceb1fc347f91d4cefc53bc0-le64.cache-8': 420,
 '/var/cache/fontconfig/d589a48862398ed80a3d6066f4f56f4c-le64.cache-8': 420,
 '/var/cache/fontconfig/d82eb4fd963d448e2fcb7d7b793b5df3-le64.cache-8': 420,
 '/var/cache/fontconfig/e0aa53bcfa504e64f87823c16bc01eb6-le64.cache-8': 420,
 '/var/cache/fontconfig/e13b20fdb08344e0e664864cc2ede53d-le64.cache-8': 420,
 '/var/cache/fontconfig/e52a45a1c8c8fe895fc0fc8c4e6999b8-le64.cache-8': 420,
 '/var/cache/fontconfig/f1f2465696798768e9653f19e17ccdc8-le64.cache-8': 420,
 '/var/cache/fontconfig/fe547fea3a41b43a38975d292a2b19c7-le64.cache-8': 420,
 '/var/cache/ldconfig/aux-cache': 384,
 '/var/lib/texmf/ls-R': 420,
 '/var/lib/texmf/web2c/luahbtex/luahbtex.fmt': 420,
 '/var/lib/texmf/web2c/luahbtex/luahbtex.log': 420,
 '/var/lib/texmf/web2c/luahbtex/lualatex.fmt': 420,
 '/var/lib/texmf/web2c/luahbtex/lualatex.log': 420,
 '/var/lib/texmf/web2c/luatex/dvilualatex.fmt': 420,
 '/var/lib/texmf/web2c/luatex/dvilualatex.log': 420,
 '/var/lib/texmf/web2c/luatex/dviluatex.fmt': 420,
 '/var/lib/texmf/web2c/luatex/dviluatex.log': 420,
 '/var/lib/texmf/web2c/luatex/luatex.fmt': 420,
 '/var/lib/texmf/web2c/luatex/luatex.log': 420,
 '/var/lib/texmf/web2c/metafont/mf.base': 420,
 '/var/lib/texmf/web2c/metafont/mf.log': 420,
 '/var/lib/texmf/web2c/pdftex/etex.fmt': 420,
 '/var/lib/texmf/web2c/pdftex/etex.log': 420,
 '/var/lib/texmf/web2c/pdftex/latex.fmt': 420,
 '/var/lib/texmf/web2c/pdftex/latex.log': 420,
 '/var/lib/texmf/web2c/pdftex/mptopdf.fmt': 420,
 '/var/lib/texmf/web2c/pdftex/mptopdf.log': 420,
 '/var/lib/texmf/web2c/pdftex/pdfetex.fmt': 420,
 '/var/lib/texmf/web2c/pdftex/pdfetex.log': 420,
 '/var/lib/texmf/web2c/pdftex/pdflatex.fmt': 420,
 '/var/lib/texmf/web2c/pdftex/pdflatex.log': 420,
 '/var/lib/texmf/web2c/pdftex/pdftex.fmt': 420,
 '/var/lib/texmf/web2c/pdftex/pdftex.log': 420,
 '/var/lib/texmf/web2c/tex/tex.fmt': 420,
 '/var/lib/texmf/web2c/tex/tex.log': 420,
 '/var/lib/texmf/web2c/updmap.log': 420}


def typed_pair(path,a,b):
    if path not in KNOWN_MODES or a is None or b is None:return False
    for row in [a,b]:
        if set(row)!={'path','kind','uid','gid','mode','mtimeNs','bytes','sha256'}:return False
        if row['path']!=path or row['kind']!='file':return False
        if not all(type(row[key]) is int for key in ['uid','gid','mode','mtimeNs','bytes']):return False
        if (row['uid'],row['gid'],row['mode'])!=(0,0,KNOWN_MODES[path]) or not 0<row['bytes']<=MEMBER_LIMIT:return False
        if not isinstance(row['sha256'],str) or re.fullmatch('[a-f0-9]{64}',row['sha256']) is None:return False
    return True


def compare_software(expected,observed,expected_packages,observed_packages):
    ordinary=material.compare(expected,observed,expected_packages,observed_packages)
    before,after=material.inventory(expected),material.inventory(observed)
    union=before.keys()|after.keys();categories={key:[] for key in ordinary['categories']};categories['generatedState']=[]
    for category,rows in ordinary['categories'].items():
        for row in rows:
            path=row if isinstance(row,str) else row['path']
            if path not in KNOWN_MODES:categories[category].append(row)
    missing=[];old_bytes=0;new_bytes=0
    for path in sorted(KNOWN_MODES):
        a,b=before.get(path),after.get(path)
        if path not in union:missing.append(path);continue
        if typed_pair(path,a,b):
            old_bytes+=a['bytes'];new_bytes+=b['bytes']
            categories['generatedState'].append({'path':path,'expected':a,'observed':b,'physicalRegenerationWitnessRequired':True})
        else:categories['unresolvedMaterial'].append({'path':path,'expected':a,'observed':b})
    complete=not missing and len(categories['generatedState'])==len(KNOWN_MODES)
    within=old_bytes<=AGGREGATE_LIMIT and new_bytes<=AGGREGATE_LIMIT
    counts={name:len(rows) for name,rows in categories.items()}
    require(sum(counts.values())==len(union),'Software/generated metadata categories do not reconcile')
    return {**ordinary,'state':'data-only-software-and-generated-state-comparison','policy':POLICY,
            'categories':categories,'counts':counts,'completeGeneratedInventory':complete,'missingGeneratedPaths':missing,
            'generatedBytes':{'expected':old_bytes,'observed':new_bytes,'aggregateLimit':AGGREGATE_LIMIT},
            'materialProjectionMatches':ordinary['installedPackageInventoryMatches'] and complete and within and not categories['unresolvedMaterial'],
            'actualPhysicalGeneratorWitnessAssessed':False,'requiredGeneratorWitnessesComplete':False,
            'historicalGeneratedBodyIdentityClaimed':False,'externalSdkReconstructionQualified':False,'gateAComplete':False}


def software_projection(inventory,package_inventory_sha256):
    rows=material.inventory(inventory)
    require(isinstance(package_inventory_sha256,str) and re.fullmatch('[a-f0-9]{64}',package_inventory_sha256),
            'Bound original package identity required for software projection')
    ordinary=[row for path,row in sorted(rows.items()) if path not in KNOWN_MODES and
              path not in material.INCIDENTAL_EXACT and not material.under(path,'/var/log')]
    body={'schemaVersion':1,'policy':POLICY,'packageInventorySha256':package_inventory_sha256,'ordinarySoftwareRows':ordinary}
    return {'rows':len(ordinary),'sha256':hashlib.sha256(json.dumps(body,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
            'wholeRootIdentityClaimed':False,'physicalGeneratorWitnessAssessed':False}
