"""One truthful fresh-image ownership contract for SDK and inert controls.

Deleting the last tag may delete its image and digest references. Consequently
both selected inputs must start absent; no preexisting input may be adopted.
Only the original pinned canonical reference and one exact owned alias are in
scope. Cleanup never forces: it untags the owned alias by name, then removes
the content by its immutable ID, and on a shared daemon leaves the image in
place, without cleanup credit, whenever Docker would need force. It is
credited only when Docker's responses name exactly the owned references and
the admitted image. It is not a claim to reclaim daemon bytes.
"""
import hashlib
import re
import time
from common import Refusal, encoded, freeze, need, read_json, hash_file, deadline_receipt


def selection(c):
    ctx = c.ctx
    need(type(ctx.get('run')) is int and ctx['run'] > 0 and type(ctx.get('nonce')) is str and re.fullmatch('[a-z0-9-]{8,40}', ctx['nonce']) is not None, 'exact owned image run/nonce')
    suffix = str(ctx['run']) + '-' + ctx['nonce']
    aliases = ['checktrail-sdk10-owned:' + suffix, 'checktrail-sdk10-controls-owned:' + suffix]
    alias = c.state['imageAlias']; p = c.profile['image']; canonical = p['reference']
    need(alias in aliases and re.fullmatch('[0-9a-f]{64}', p['manifestSHA256']) is not None and canonical == 'mcr.microsoft.com/dotnet-buildtools/prereqs@sha256:' + p['manifestSHA256'], 'exact selected original image and finite owned alias family')
    need(type(p['diffIDs']) is list and len(p['diffIDs']) == 4 and all(type(x) is str and re.fullmatch('[0-9a-f]{64}', x) for x in p['diffIDs']), 'four selected image raw layer identities')
    return alias, canonical


def baseline(c):
    path = c.root / 'control' / 'IMAGE-CONTENT-BASELINE.json'
    row = read_json(path, 65536)
    need(type(row) is dict and row.get('schemaVersion') == 1 and row.get('context') == c.ctx and type(row.get('fullImageIDs')) is list and len(row['fullImageIDs']) <= 512 and row['fullImageIDs'] == sorted(set(row['fullImageIDs'])) and all(type(x) is str and re.fullmatch('sha256:[0-9a-f]{64}', x) for x in row['fullImageIDs']), 'same complete typed image content baseline')
    command = row.get('command') or {}
    need(command.get('exitCode') == 0 and command.get('reason') is None and command.get('ownedChildStarted') is True and command.get('ownedChildReaped') is True, 'baseline command complete, never inferred from an empty failed read')
    return row, hash_file(path)[1]


def reserve_image_inputs(c):
    alias, canonical = selection(c)
    marker = c.root / 'control' / 'IMAGE-INPUT-OWNERSHIP.json'
    need(not marker.exists(), 'one fresh original image ownership reservation')
    need(c.inspect('image', alias) is None, 'owned image alias initially absent')
    need(c.inspect('image', canonical) is None, 'selected canonical image initially absent; preexisting inputs are never adopted')
    row, path = c.cmd(['docker', 'image', 'ls', '--all', '--quiet', '--no-trunc'], seconds=30, check=False, cap=65536)
    need(row.get('exitCode') == 0 and row.get('reason') is None and row.get('ownedChildStarted') is True and row.get('ownedChildReaped') is True and path.stat().st_size <= 65536, 'bounded exact complete pre-pull image-ID baseline command')
    raw = path.read_bytes(); need(len(raw) <= 65536, 'bounded pre-pull image-ID baseline body')
    ids = raw.decode('ascii').splitlines()
    need(len(ids) <= 512 and all(re.fullmatch('sha256:[0-9a-f]{64}', x) for x in ids), 'finite full image IDs, never abbreviated or foreign baseline rows')
    freeze(c.root / 'control' / 'IMAGE-CONTENT-BASELINE.json', encoded({'schemaVersion': 1, 'context': c.ctx, 'fullImageIDs': sorted(set(ids)), 'command': row}))
    _, pin = baseline(c)
    # Durable reservation precedes the first original pull, including ambiguity.
    freeze(marker, encoded({'schemaVersion': 1, 'context': c.ctx, 'alias': alias, 'canonical': canonical, 'bothExactInputsPositivelyAbsentBeforeFirstPull': True, 'manifestSHA256': c.profile['image']['manifestSHA256'], 'baselineSHA256': pin}))
    c.state['ownedImageInputsReserved'] = True; c.save()


def admit_pulled_image(c):
    alias, canonical = selection(c); old, pin = baseline(c)
    image = c.inspect('image', canonical)
    runtime = image.get('Id') if type(image) is dict else None
    valid = type(runtime) is str and re.fullmatch('sha256:[0-9a-f]{64}', runtime) is not None
    previous = runtime in old['fullImageIDs'] if valid else None
    selected = valid and image.get('Architecture') == 'amd64' and image.get('Os') == 'linux' and type(image.get('RootFS')) is dict and image['RootFS'].get('Layers') == ['sha256:' + x for x in c.profile['image']['diffIDs']]
    refs_match = False; reference_observation = None
    if selected:
        try:reference_observation = references(image, alias, canonical, False); refs_match = True
        except Exception:pass
    admitted = bool(selected and refs_match and previous is False)
    freeze(c.root / 'control' / 'IMAGE-PULL-ADMISSION.json', encoded({'context': c.ctx, 'canonical': canonical, 'actualRuntimeImageID': runtime if valid else None, 'baselineSHA256': pin, 'selectedPhysicalMetadataMatches': bool(selected), 'onlySelectedFreshReferenceObserved': bool(refs_match), 'recognizedReferenceObservation': reference_observation, 'selectedRuntimeContentWasInPrePullBaseline': previous, 'ownedNewSelectedContent': admitted, 'nativeOrBuildCredit': False, 'newCanonicalRefSideEffectResolved': False}))
    need(valid, 'selected pulled image has a typed exact runtime identity')
    need(previous is False, 'selected pulled image content must be genuinely new; preexisting foreign-tagged or dangling content cannot be adopted')
    need(bool(selected and refs_match), 'selected pulled image physical metadata and exact reference forms must match')
    return image


def reference_sets(alias, canonical):
    # Exact finite display names, not prefixes or namespace wildcards. Moby's
    # containerd backend includes digest names in RepoTags and synthesizes the
    # local alias repository's pinned-manifest digest in RepoDigests.
    derived = alias.rsplit(':', 1)[0] + '@' + canonical.rsplit('@', 1)[1]
    return derived


def references(obj, alias, canonical, alias_present):
    need(type(obj) is dict and type(obj.get('Id')) is str and re.fullmatch('sha256:[0-9a-f]{64}', obj['Id']) is not None, 'actual runtime image identity')
    tags = obj.get('RepoTags'); digests = obj.get('RepoDigests'); derived = reference_sets(alias, canonical)
    need(type(tags) is list and len(tags) <= 2 and all(type(x) is str for x in tags) and len(tags) == len(set(tags)), 'typed unique finite current image tags')
    need(type(digests) is list and len(digests) <= 2 and all(type(x) is str for x in digests) and len(digests) == len(set(digests)), 'typed unique finite current image digests')
    permitted_tags = [{alias}, {alias, canonical}] if alias_present else [set(), {canonical}]
    permitted_digests = [{canonical}, {canonical, derived}] if alias_present else [{canonical}]
    need(set(tags) in permitted_tags, 'no foreign image tags may enter cleanup')
    need(set(digests) in permitted_digests, 'only exact newly owned selected digest forms may enter cleanup')
    return {'repoTagCount': len(tags), 'repoDigestCount': len(digests), 'canonicalInRepoTags': canonical in tags, 'derivedAliasDigestObserved': derived in digests}


def layer_ids(diff_ids):
    """The selected layers as Docker may name them when deleting: diff IDs and chain IDs."""
    names = ['sha256:' + x for x in diff_ids]; chains = [names[0]]
    for name in names[1:]: chains.append('sha256:' + hashlib.sha256((chains[-1] + ' ' + name).encode()).hexdigest())
    return set(names) | set(chains)


def removal_lines(command, path):
    """The Untagged and Deleted names of one complete `docker image rm` response."""
    need(type(command) is dict and command.get('exitCode') == 0 and command.get('reason') is None and path is not None, 'complete image removal response')
    raw = path.read_bytes(); need(len(raw) <= 65536, 'bounded image removal response')
    untagged = []; deleted = []
    for line in raw.decode('utf8').splitlines():
        match = re.fullmatch(r'(Untagged|Deleted): (\S+)', line); need(match is not None, 'recognized image removal response line')
        (untagged if match.group(1) == 'Untagged' else deleted).append(match.group(2))
    need(len(untagged) == len(set(untagged)) and len(deleted) == len(set(deleted)), 'each removed name reported once')
    return untagged, deleted


def removal_response(command, path, image_id, refs, layers):
    """What a complete removal by ID says it removed, refused unless it is only this image.

    Every line must be an Untagged line for one of the owned references or a
    Deleted line for the admitted image or one of its layers, and the admitted
    image itself must be among the deleted.
    """
    untagged, deleted = removal_lines(command, path)
    need(set(untagged) <= refs, 'image removal untagged only the owned references')
    need(set(deleted) <= {image_id} | layers, 'image removal deleted only the admitted image and its layers')
    need(image_id in deleted, 'image removal response establishes the admitted image was deleted')
    return {'untagged': untagged, 'deleted': deleted}


def repositories(obj):
    """The repository names an inspected image is referenced from."""
    names = list(obj.get('RepoTags') or []) + list(obj.get('RepoDigests') or [])
    return sorted({x.split('@', 1)[0] if '@' in x else x.rsplit(':', 1)[0] for x in names if type(x) is str})


def cleanup_image_inputs(c, deadline):
    alias, canonical = selection(c)
    began = time.monotonic(); need(began < deadline, 'owned image cleanup original deadline')
    ownership = c.root / 'control' / 'IMAGE-INPUT-OWNERSHIP.json'
    need(ownership.is_file() and not ownership.is_symlink(), 'physical owned image reservation required')
    observed = read_json(ownership, 65536); old, baseline_pin = baseline(c)
    need(observed == {'schemaVersion': 1, 'context': c.ctx, 'alias': alias, 'canonical': canonical, 'bothExactInputsPositivelyAbsentBeforeFirstPull': True, 'manifestSHA256': c.profile['image']['manifestSHA256'], 'baselineSHA256': baseline_pin}, 'same original fresh image ownership binding')
    start = c.root / 'control' / 'IMAGE-INPUT-CLEANUP-START.json'
    result = c.root / 'control' / 'IMAGE-INPUT-CLEANUP-RESULT.json'
    need(not start.exists() and not result.exists(), 'one image inputs cleanup; never repeat an ambiguous delete')
    freeze(start, encoded({'context': c.ctx, 'alias': alias, 'canonical': canonical, 'baselineSHA256': baseline_pin, 'eachExactReferenceAtMostOnce': True}))
    operations = []; state = {'alias': None, 'canonical': None}; inspection_errors = {}; failure = None

    def inspect_both():
        values = {}; errors = {}
        for role, name in [('alias', alias), ('canonical', canonical)]:
            try: values[role] = c.inspect('image', name)
            except BaseException as error: errors[role] = type(error).__name__
        # None means positively absent only when that exact inspection completed.
        state.update(values); inspection_errors.clear(); inspection_errors.update(errors)
        need(not errors, 'both exact owned image reference inspections must complete')
        return values

    def validate(values):
        a = values['alias']; current = values['canonical']
        if a is None and current is None:return
        need(current is not None, 'uncertain remaining alias cannot grant a canonical-only delete')
        need(current['Id'] not in old['fullImageIDs'], 'never delete image content that existed before the pull under any refs')
        admission = c.root / 'control' / 'IMAGE-PULL-ADMISSION.json'
        if admission.exists():
            admitted = read_json(admission, 65536)
            need(admitted.get('context') == c.ctx and admitted.get('baselineSHA256') == baseline_pin and admitted.get('actualRuntimeImageID') == current['Id'] and admitted.get('ownedNewSelectedContent') is True, 'refused or changed source image admission cannot grant cleanup')
        for obj in [current] + ([a] if a is not None else []):
            references(obj, alias, canonical, a is not None)
            need(obj['Id'] == current['Id'] and obj['Architecture'] == 'amd64' and obj['Os'] == 'linux' and obj['RootFS']['Layers'] == ['sha256:' + x for x in c.profile['image']['diffIDs']], 'same newly owned selected image content before cleanup')

    def present_ids():
        # inspect() falls back to a reference filter, which never matches an ID; list complete IDs instead.
        row, path = c.cmd(['docker', 'image', 'ls', '--all', '--quiet', '--no-trunc'], seconds=30, check=False, cap=65536)
        need(row.get('exitCode') == 0 and row.get('reason') is None and row.get('ownedChildStarted') is True and row.get('ownedChildReaped') is True and path.stat().st_size <= 65536, 'bounded complete image-ID listing')
        ids = path.read_bytes().decode('ascii').splitlines(); need(all(re.fullmatch('sha256:[0-9a-f]{64}', x) for x in ids), 'full image IDs in the listing')
        return set(ids)

    def admitted_id():
        admission = c.root / 'control' / 'IMAGE-PULL-ADMISSION.json'
        if not admission.exists():return None
        admitted = read_json(admission, 65536)
        if not(admitted.get('context') == c.ctx and admitted.get('baselineSHA256') == baseline_pin and admitted.get('ownedNewSelectedContent') is True):return None
        return admitted.get('actualRuntimeImageID')

    def untag_alias(image_id):
        """Untag the owned alias by name; the canonical digest reference keeps the content."""
        marker = c.root / 'control' / 'IMAGE-UNTAG-ALIAS-REQUEST.json'
        outcome = c.root / 'control' / 'IMAGE-UNTAG-ALIAS-RESULT.json'
        need(not marker.exists() and not outcome.exists(), 'the owned alias untag is at most once')
        need(time.monotonic() < deadline, 'same owned image deadline before alias untag')
        now = c.inspect('image', alias)
        need(type(now) is dict and now.get('Id') == image_id, 'owned alias names the admitted image immediately before its untag')
        freeze(marker, encoded({'context': c.ctx, 'kind': 'alias-untag', 'deleteTarget': alias, 'admittedImageID': image_id, 'baselineSHA256': baseline_pin}))
        # Docker has no conditional untag: another client could still move this
        # alias between the inspection above and the command below. The name is
        # unique to this run and owned by it, so only misuse rebinds it, and a
        # Deleted line in the response then shows content was removed through
        # it; that is recorded and no credit is given.
        command = None; path = None; command_error = None
        try:command, path = c.docker(['image', 'rm', '--no-prune', alias], seconds=min(30, max(.001, deadline - time.monotonic())), check=False)
        except BaseException as error:command_error = type(error).__name__
        untagged = None; deleted = None; response_error = None
        try:untagged, deleted = removal_lines(command, path)
        except BaseException as error:response_error = str(error) if isinstance(error, Refusal) else type(error).__name__
        inspection_error = None
        try:inspect_both()
        except BaseException as error:inspection_error = type(error).__name__
        layers = layer_ids(c.profile['image']['diffIDs']); foreign = sorted(set(deleted or []) - {image_id} - layers)
        row = {'kind': 'alias-untag', 'deleteTarget': alias, 'removeCommand': command, 'operatorCommandErrorType': command_error, 'untagged': untagged, 'deleted': deleted, 'removalResponseError': response_error, 'aliasReboundToOtherContent': bool(foreign), 'admittedImageDeletedThroughAlias': image_id in (deleted or []), 'inspectionErrorType': inspection_error, 'inspectionErrors': dict(inspection_errors), 'positiveOwnedAliasAbsenceObserved': 'alias' not in inspection_errors and state['alias'] is None}
        freeze(outcome, encoded(row)); operations.append(row)
        need(inspection_error is None, 'owned alias untag effects remain unassessed after unavailable inspection')
        need(untagged is not None, 'alias untag response must be complete: ' + str(response_error))
        need(not foreign, 'alias untag deleted content: the alias was rebound to other content')
        need(not deleted, 'alias untag deleted the admitted image while its canonical reference was expected to hold it')
        need(set(untagged) <= {alias, reference_sets(alias, canonical)} and alias in untagged, 'alias untag removed only the owned alias forms')
        need(state['alias'] is None, 'alias still present or uncertain after its untag')

    def remove_content(image_id, expected_names, refs):
        """Remove the admitted content by ID without force; leave it in place if Docker refuses."""
        marker = c.root / 'control' / 'IMAGE-DELETE-REQUEST.json'
        outcome = c.root / 'control' / 'IMAGE-DELETE-RESULT.json'
        need(not marker.exists() and not outcome.exists(), 'the owned image delete is at most once')
        need(time.monotonic() < deadline, 'same owned image deadline before exact image delete')
        before = c.inspect('image', image_id)
        if not(type(before) is dict and before.get('Id') == image_id and type(before.get('RepoTags')) is list and type(before.get('RepoDigests')) is list and sorted(before['RepoTags']) + sorted(before['RepoDigests']) in expected_names):
            # Another reference appeared: no delete is issued and the image stays.
            operations.append({'kind': 'content-delete', 'deleteTarget': image_id, 'removeCommand': None, 'preflightRefused': True, 'observedReferences': sorted((before or {}).get('RepoTags') or []) + sorted((before or {}).get('RepoDigests') or []) if type(before) is dict else None, 'leftInPlace': type(before) is dict, 'removedImageEstablished': False, 'positiveOwnedImageAbsenceObserved': False})
            raise Refusal('admitted image holds exactly the owned remaining references immediately before its removal')
        freeze(marker, encoded({'context': c.ctx, 'kind': 'content-delete', 'deleteTarget': image_id, 'alias': alias, 'canonical': canonical, 'baselineSHA256': baseline_pin}))
        command = None; path = None; command_error = None
        try:command, path = c.docker(['image', 'rm', '--no-prune', image_id], seconds=min(30, max(.001, deadline - time.monotonic())), check=False)
        except BaseException as error:command_error = type(error).__name__
        refused = type(command) is dict and command.get('reason') is None and type(command.get('exitCode')) is int and command['exitCode'] != 0
        response = None; response_error = None
        if not refused:
            try:response = removal_response(command, path, image_id, refs, layer_ids(c.profile['image']['diffIDs']))
            except BaseException as error:response_error = str(error) if isinstance(error, Refusal) else type(error).__name__
        inspection_error = None; image_absent = None; after = None
        try:
            inspect_both(); image_absent = image_id not in present_ids()
            if refused and not image_absent:after = c.inspect('image', image_id)
        except BaseException as error:inspection_error = type(error).__name__
        # Without force Docker refuses, for example, an image referenced from
        # several repositories or used by a container; it then stays in place.
        # The daemon's reason is not retained, so only the exit and the
        # references seen afterwards are recorded, not an inferred cause.
        left = refused and image_absent is False
        row = {'kind': 'content-delete', 'deleteTarget': image_id, 'removeCommand': command, 'operatorCommandErrorType': command_error, 'removalResponse': response, 'removalResponseError': response_error, 'removedImageEstablished': response is not None, 'positiveOwnedImageAbsenceObserved': image_absent is True,
               'preflightRefused': False, 'leftInPlace': left, 'refusalExitCode': command['exitCode'] if refused else None, 'refusalReason': 'removal by ID without force refused; the daemon reason is not retained' if refused else None, 'repositoriesAfterRefusal': repositories(after) if type(after) is dict else None,
               'inspectionErrorType': inspection_error, 'inspectionErrors': dict(inspection_errors), 'positiveOwnedAliasAbsenceObserved': 'alias' not in inspection_errors and state['alias'] is None, 'positiveOwnedCanonicalAbsenceObserved': 'canonical' not in inspection_errors and state['canonical'] is None}
        freeze(outcome, encoded(row)); operations.append(row)
        need(inspection_error is None, 'owned image delete effects remain unassessed after unavailable inspection')
        need(time.monotonic() < deadline, 'same owned image deadline after delete effects persistence')
        need(not left, 'owned image left in place: Docker refused its removal without force')
        need(response is not None, 'image removal response must establish that only the admitted image was deleted: ' + str(response_error))
        need(image_absent is True, 'admitted image positively absent by its ID')

    try:
        current = inspect_both(); validate(current)
        # validate() admits a remaining alias only beside the same canonical image.
        if current['canonical'] is not None:
            image_id = current['canonical']['Id']
            if current['alias'] is not None:untag_alias(image_id)
            # Left: the canonical digest reference, which some backends also list as a tag.
            remove_content(image_id, [[canonical], [canonical, canonical]], {canonical})
        elif admitted_id() is not None and admitted_id() in present_ids():
            # Both names are gone but the admitted new content remains under no name.
            image_id = admitted_id(); obj = c.inspect('image', image_id)
            need(image_id not in old['fullImageIDs'] and type(obj) is dict and obj.get('Id') == image_id and obj.get('RepoTags') == [] and obj.get('RepoDigests') == [] and obj.get('RootFS', {}).get('Layers') == ['sha256:' + x for x in c.profile['image']['diffIDs']], 'unnamed remaining content is exactly the admitted new image')
            remove_content(image_id, [[]], set())
        need(not inspection_errors and state['alias'] is None and state['canonical'] is None, 'both exact newly owned image inputs finally absent within original deadline')
    except BaseException as error:failure = error
    row = {'context': c.ctx, 'deleteAttempted': bool(operations) or any((c.root / 'control' / x).exists() for x in ['IMAGE-UNTAG-ALIAS-REQUEST.json', 'IMAGE-DELETE-REQUEST.json']), 'operations': operations, 'inspectionErrors': dict(inspection_errors), 'positiveOwnedAliasAbsenceObserved': 'alias' not in inspection_errors and state['alias'] is None, 'positiveOwnedCanonicalAbsenceObserved': 'canonical' not in inspection_errors and state['canonical'] is None, 'removedImageEstablished': any(x['kind'] == 'content-delete' for x in operations) and all(x['removedImageEstablished'] for x in operations if x['kind'] == 'content-delete'), 'leftInPlace': any(x.get('leftInPlace') for x in operations), 'aliasReboundToOtherContent': any(x.get('aliasReboundToOtherContent') for x in operations), 'positiveOwnedAbsenceObserved': failure is None and not inspection_errors and state['alias'] is None and state['canonical'] is None and all(x['removedImageEstablished'] and x['positiveOwnedImageAbsenceObserved'] for x in operations if x['kind'] == 'content-delete'), 'cleanupErrorType': type(failure).__name__ if failure is not None else None, 'daemonLayersOrBytesReclaimedAssessed': False}
    row = deadline_receipt(result, row, deadline, {'positiveOwnedAbsenceObserved': False, 'cleanupBudgetExhausted': True}, began)
    if failure is not None:raise failure
    need(not row['completionBudgetExhausted'], 'owned image cleanup final persistence deadline')
    return row
