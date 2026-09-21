# CLA signatures

This branch is the signature store for [CLA Assistant](https://github.com/contributor-assistant/github-action).
It is **not** part of the project's source and shares no history with `main`.

`signatures/version1/cla.json` is appended to automatically when a contributor
comments the signing phrase on a pull request. Do not edit it by hand.

Why this branch exists at all: the action stores signatures in the repository it
runs in, on a branch named by its `branch:` input. Without the branch the check
fails with `Branch cla-signatures not found` before it ever looks at who signed
— which is what happened on this repository's first pull request.

Do not set `remote-organization-name` or `remote-repository-name` in the
workflow. Either one switches the action onto a path requiring a
`PERSONAL_ACCESS_TOKEN`, and `pnpm cla:verify` fails the build if they reappear.
