# Changelog

## Unreleased

* Refine run threads to foreground LASO's actual readable output, with lifecycle activity, duplicate/raw message data, and technical metadata progressively disclosed.
* Keep polling updates from replacing unchanged thread content; preserve focused disclosures and add shareable/history-aware run routes that restore after refresh.
* Simplify the task composer, remove duplicated recent-run cards, improve human-readable states and transient confirmations, and prevent horizontal overflow during responsive viewport changes.
* Quietly handle clients disconnecting while a response is being written; preserve the server-side API allowlist and authentication boundary.

## 0.1.0

* Initial lightweight operator UI for LASO health, workers, pipeline runs, durable approvals/worker requests, and read-only schedules.
* Add a bounded standard-library HTTP adapter, localhost-first deployment configuration, optional Basic authentication, systemd example, and Linux/reverse-proxy documentation.
