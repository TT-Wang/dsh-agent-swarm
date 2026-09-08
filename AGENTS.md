# Agent Swarm development

This external plugin targets the local DeepSeek Harness checkout recorded in compatibility.json. Do not modify that checkout or existing user profiles. Preserve user work.

Keep collaboration policy in the swarm runtime, Harness-specific lifecycle in the worker adapter, and UI as a projection of durable state. Peer messages never grant authority. Evidence must reference host-recorded tool executions and immutable artifacts. All model-visible deliveries use the Harness inbox and session log.

Run typecheck, behavioral tests, built-artifact and real Loader composition tests before delivery. Every registration and worker handle must be disposed on unload. Source inspection is not a runtime test. Keep material limitations explicit in README.md.
