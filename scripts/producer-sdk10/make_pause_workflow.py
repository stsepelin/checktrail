"""Generate a separate inert first-party-controls-only Ubuntu26 proposal."""
import argparse
import hashlib
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_workflow import generate as generate_native, CHECKOUT, ENTRY, UPLOAD

def generate(folder, destination):
    # Same exact source manifest; native workflow stays a distinct ungranted
    # local proposal and is never the controls-only remote entry point.
    inert = destination.with_name('ORIGINAL-NATIVE-UNGRANTED.yml')
    data = generate_native(folder, inert)
    pin = data['manifestSHA256']
    lines = ['# FIRST-PARTY CONTROLS ONLY. No original SDK/source/key/export execution.',
             'name: SDK10 owned pause controls', 'on:', '  workflow_dispatch:', '    inputs:',
             '      nonce:', '        description: Exact reviewed fresh controls-only nonce',
             '        required: true', '        type: string', 'permissions:', '  contents: read',
             'concurrency:', '  group: checktrail-sdk10-owned-pause-controls',
             '  cancel-in-progress: false', 'jobs:', '  controls:',
             '    runs-on: ubuntu-26.04', '    timeout-minutes: 12', '    env:',
             '      CHECKTRAIL_NONCE: ${{ inputs.nonce }}',
             '      CHECKTRAIL_MANIFEST_SHA256: ' + pin, '    steps:',
             '      - name: Read exact reviewed first-party source',
             '        uses: actions/checkout@' + CHECKOUT, '        with:',
             '          persist-credentials: false', '          fetch-depth: 1',
             '      - name: Focused first-party synthetic controls without keys or Docker',
             '        shell: bash', '        run: |',
             '          ' + ENTRY + 'test_producer_pause.py',
             '          ' + ENTRY + 'test_producer_adapter.py',
             '          ' + ENTRY + 'test_live_resource.py',
             '          ' + ENTRY + 'test_target_pause_controls.py',
             '      - name: Actual owned inert Docker pause and strict sampler controls',
             '        shell: bash',
             '        run: ' + ENTRY + 'target_pause_controls.py --nonce "$CHECKTRAIL_NONCE" --manifest-sha256 "$CHECKTRAIL_MANIFEST_SHA256"',
             '      - name: Retain finite first-party controls metadata only',
             '        if: always()', '        uses: actions/upload-artifact@' + UPLOAD,
             '        with:', '          name: sdk10-owned-pause-controls-${{ github.run_id }}-1-${{ inputs.nonce }}',
             '          path: ${{ runner.temp }}/ct-sdk10-controls-${{ inputs.nonce }}/RESULT.json',
             '          if-no-files-found: error', '          retention-days: 1',
             '          compression-level: 0', '          overwrite: false']
    raw = ('\n'.join(lines) + '\n').encode(); destination.write_bytes(raw)
    return {'manifestSHA256': pin, 'workflowSHA256': hashlib.sha256(raw).hexdigest(), 'workflowBytes': len(raw),
            'originalNativeWorkflowNotAuthorizedOrDispatched': True,
            'runner': 'ubuntu-26.04', 'controlsOnly': True, 'hostedJobSeconds': 720}

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--folder', type=Path, required=True); p.add_argument('--out', type=Path, required=True); args = p.parse_args()
    print(__import__('json').dumps(generate(args.folder, args.out), sort_keys=True))
