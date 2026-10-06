# Original local Kustomize assembly

The original base Deployment and ConfigMap are rendered through a local overlay
with a name prefix, replica override and native origin annotations. Prepare the
exact local schemas under `tools/kubernetes` as described in
[KUSTOMIZE.md](../../docs/KUSTOMIZE.md), then invoke the shared CLI with operator
trust. This fixture starts no cluster and applies no resource.
