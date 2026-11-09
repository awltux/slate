# Changelog

User-visible changes per slice. Internal refactors are not listed.

## Unreleased — slice 1 (in progress)

- A project is now a folder with an append-only commit log: every change is attributable, recoverable and
  conflict-checked against the revision it was based on.
- Slate probes the host toolchain and reports, per stage, which program will actually run and why (for example
  "OpenShot CLI unavailable; assembly will use FFmpeg — hard cuts only").
- Operations are defined once and validated at both ends; `project.create` and `capabilities.get` are the first two.
