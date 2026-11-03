# Custom Quota Sources (Proposal A) Evidence

## Visual Workflow

See `flow.mmd` for the architecture diagram comparing single-machine reads before vs. custom quota sources after.

## Live Two-Machine Verification

See `two-machine-proof.txt` for verbatim logs of all 6 test cases from the A.10 live proof plan across Machine A (publisher) and Machine B (consumer):

1. **Case 1 (Fresh)**: Fresh remote lane `source:machine-a:default` imported, windows match producer, pace and runway re-derived at consumer clock, `imported` attention row rendered.
2. **Case 2 (No B-side query for A's account)**: Local credentials on Machine B hidden; imported lane remains fresh and populated with zero vendor calls from Machine B.
3. **Case 3 (Stale)**: Reading past `maxAge` classified as stale with `source_reading_too_old`, omitted from `quota[]`, attention row updated, exit 0.
4. **Case 4 (Unreachable)**: Publisher server down; lane becomes unavailable with `source_unreachable` within the 3s timeout (1.097s actual), exit 0.
5. **Case 5 (Wrong account)**: Pinned `subscription` mismatch causes lane to fail closed with `source_account_mismatch`, no windows published.
6. **Case 6 (Backward compatibility)**: With no `sources` declared, output against snapshot fixture is byte-identical to stock binary.
