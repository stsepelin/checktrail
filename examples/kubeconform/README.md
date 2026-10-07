# Original Kubernetes schema example

This original Deployment and ConfigMap are validation data; they are never applied.
The image domain is fictional. See [the bounded profile](../../docs/KUBECONFORM.md).

Before planning, prepare the pinned kubeconform binary and copy the preparer's
verified schemas directory into `tools/kubernetes` in this example. Missing or
changed schema files leave the check unavailable. The native acceptance harness
makes that copy in its own fresh fixture; it does not modify this public example.

Run the shared CLI with explicit operator trust:

```sh
checktrail run --root examples/kubeconform --trust-project
```

Changing `spec.replicas` to a string produces a physical schema finding. Zero is
a valid near miss. This checks the pinned schema, without proving cluster admission,
workload reachability, image availability or deployment behavior.
