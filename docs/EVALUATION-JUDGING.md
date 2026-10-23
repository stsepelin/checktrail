# Independent external-review judging

This operator component connects [sealed external review captures](EVALUATION-CAPTURES.md)
to anonymous source-bound judging assignments and retained physical responses.
It uses no Checktrail review workflow in the baseline arm, invokes no model and
opens no held-out material on its own. The original development fixtures are
synthetic. The full independent-evaluation profile and Gate A remain open.

All arms can return the exported strict `independent-review-output-v1` format:
schema version 1 and a `claims` array. Each claim contains an opaque claim ID,
family, statement, exact source citations and a nullable reviewer-declared
probability. This common output format does not require Checktrail assistance.
Free prose, malformed output, foreign citations and unfinished review states
remain invalid/incomplete. No automatic extraction invents a clean review or a
claim inventory. A valid empty claim array is an abstaining completed review;
its correctness still requires independent labels and later scoring.

`prepareReviewEvaluationJudging` requires an exact sealed capture digest and one
source packet per selected case. `independent-review-source-packet-v1` contains
schema version 1 and unique canonical relative file paths with original content.
Its encoded bytes must match the cohort's `contentSha256`. This binds the supplied
context packet, not the complete source archive, license grant or exposure
history. The separate source-archive commitment remains unverified. Packets cannot
supply answer-label fields, but the custodian still controls what source text
contains. Nothing here authenticates that custodian or proves context completeness.

The immutable private judging book assigns unpredictable anonymous IDs to every
selected case/repetition/role, including absent and invalid reviews. It retains
source packets privately and binds the protocol, physical capture archive and
judging procedure digest. Every target packet and disclosure bound is checked
before the book is exclusively created. Existing books are never replaced.

`reviewEvaluationJudgmentPacket` requires an explicit operator source-disclosure
grant. It returns one source packet and its exact submitted claims, with reviewer
probabilities removed. It includes no structured role/configuration identity,
peer review, prior judgment, answer inventory or host session. Claim/source text
is untrusted and can itself disclose identifying information; structural omission
does not prove semantic anonymity or fresh host isolation. The operator must
provide a fresh judge context under the frozen external procedure.

Responses use `independent-review-judgment-v1`: schema version 1, the exact packet
digest, a session identity, terminal status and one disposition per exact claim ID.
Resolved dispositions require current source quotations. Missing, duplicate,
foreign, malformed, refused, cancelled, unavailable and unfinished responses
remain accounted for. Reusing a declared session across any supplied responses,
or with any reached review attempt, invalidates every affected planned response.
Unique declared strings still do not prove independent execution or judge authority.

`sealReviewEvaluationJudgments` collects bounded physical response files by digest
from the same private blob store, including foreign/duplicate submissions. It
then exclusively writes one sealed judgment archive. Replay checks the book,
capture archive and retained response bytes; it does not reopen incoming blobs,
resume a reviewer or execute a judge. Changed digests, duplicate/unused/omitted
physical inventories and inconsistent missing inventories fail replay. File
privacy, link, read-stability and atomic-publication checks use the same private
POSIX storage boundary as capture sealing.

Reports retain planned/accepted/missing/rejected slots, foreign/duplicate supplied
records, all review-output states, and resolved/unresolved/unavailable claim
judgments. The categories reconcile to their complete denominators. Complete
judgment intake can include an explicit unresolved disposition; `judgmentsResolved`
stays false. Missing physical review attempts prevent complete evidence even if
every judge response is otherwise admissible. Collector authenticity, actual
all-attempt completeness, source-archive verification, host independence, judge
authority and quality remain unverified. No report closes Gate A.

Limits are 256 cases, 1,536 planned judgments/submissions, 32 claims per review,
16 citations per claim, 4 MiB per source/complete disclosed packet, 16 MiB of
source packets, 1 MiB per response, 16 MiB of unique response bytes and 32 MiB per
encoded private book/archive. Combined limits may reject individually valid
records. The setup CLI separately reads at most 4 MiB of valid UTF-8 JSON:

```sh
node scripts/evaluation-judgments.mjs prepare PROJECT STORE CAPTURE_SHA256 < private-source-packets.json
node scripts/evaluation-judgments.mjs packet PROJECT STORE BOOK_SHA256 ANONYMOUS_ID --allow-source
node scripts/evaluation-judgments.mjs seal PROJECT STORE BOOK_SHA256 < private-submissions.json
node scripts/evaluation-judgments.mjs inspect PROJECT STORE JUDGMENTS_SHA256
```

Source input is an array of `{caseId, base64}`; each base64 payload is the exact
encoded source packet. Submissions are `{blindId, responseSha256}` records; null
response digests explicitly retain unrun slots. The packet command is deliberate
source disclosure. Seal/inspect return aggregate accounting only: exit 0 means
complete resolved intake, 2 means incomplete/unresolved intake, and 1 means
invalid or unavailable input/artifacts. Error text never echoes private input.
The CLI does not change the installed MCP catalogue or grant project execution.

The required source and fresh offline installed controls cover original three-role
collections, strict current quotations, session reuse, missing/foreign/duplicate
states, malformed/plain-text reviews, complete abstention, disclosure admission,
physical replay and CLI privacy. Common-defect matching, paired scoring from these
archives, final runtime bindings, the actual private protocol/cohort freeze and
full independent-evaluation acceptance remain separate required work. No actual
review trial has been run.
