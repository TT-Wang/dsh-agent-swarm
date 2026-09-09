# D8 load harness and the single-writer boundary

`npm run test:load` runs `scripts/load/run.mjs`. It builds a temporary SQLite
store, creates N synthetic workers with one implementation task each, installs a
hierarchical limit set, fires N concurrent `swarm_claim` calls, and prints the
measured admission envelope. It then repeats at a larger N and asserts the
per-worker observation cost stays bounded. No model or workspace is touched; the
execution adapter is inert, so the measurement isolates admission control, the
store and the scheduler.

```sh
npm run build            # the harness imports lib/, not src/
npm run test:load        # N = 16 and N = 32
node scripts/load/run.mjs --workers 64   # any N >= 16
```

## Reading the envelope

| Field | Meaning |
| --- | --- |
| `admitted` / `refused` | Durable admission rows for this run. Every worker gets exactly one decision. |
| `maxConcurrentLeases` | Peak running leases sampled every millisecond; with the default shape this equals the task-class cap. |
| `queueHighWater` | Peak count of durable pending tasks waiting for a slot. Work waits in the `tasks` table, never in an in-memory queue. |
| `admission p50/p95` | Decision latency recorded on the durable row itself (from candidate evaluation to committed decision). |
| `refusal p50/p95` | Same measurement for refused candidates. |
| `claim p50/p95` | End-to-end `swarm_claim` latency, which includes the single-writer commit (fsync) batch. |
| `limitHit` | The exact rule that bound: `reason@level(key)=limit`, for example `queue_full@taskClass(implementation)=8`. |
| `observation max/median` | Bytes of the focused per-worker `swarm_observe` view (`taskId`). The assertion is that this does not grow with N. |

The harness asserts, and fails the command otherwise:

- every one of the N workers has a decision, and every admitted lease came from an
  explicit claim (the scheduler cannot have assigned it behind the measurement);
- the task-class cap binds (`maxConcurrentLeases` equals the cap, refusals exist);
- the queue high-water mark observed the waiting workers;
- the exact limit hit is recorded;
- the focused per-worker observation stays under 64 KiB and within 1.25x (or
  +2 KiB) between N = 16 and the largest N.

The focused `taskId` view is the per-worker cost: a worker reads its current task,
its dependencies and its own run window. The compact mission board is the
owner/UI projection and is not part of the per-worker observation budget.

## Admission model

Every admission decision is a durable row in the `admissions` table with one
reason code:

- `admitted` — every level had a free slot.
- `queue_full` — a hierarchical limit had no free slot; the row names the level
  (`scope`, `taskClass`, `agent`), the key, the limit and the in-use count.
- `budget_exceeded` — the mission's token, step or duration budget is exhausted.
- `lease_conflict` — the member already owns a running lease.
- `writer_busy` — the store classified a `SQLITE_BUSY` that survived bounded
  retries; the decision is recorded once the writer is free again.

Limits are hierarchical and per scope: a candidate must have a free slot at the
scope, task-class and agent levels, and the strictest matching rule wins. `*`
matches every key at its level. Defaults are one lease per agent and at most
`maxWorkers` concurrent leases per scope and task class; an owner can replace a
level's default with `setAdmissionLimit` and tighten individual keys. Repeated
refusals for the same candidate and reason merge into one row (`count` grows,
the row does not), so a mission refused on every tick keeps a bounded ledger.
There is no in-memory wait queue: refused work stays a durable `pending` task and
the next scheduler tick re-evaluates it.

## Single-host, single-writer boundary

**Single-host, single-writer.** Admission, lease and budget accounting is durable
but scoped to one host and one writer process at a time: every mutation
serializes through a single SQLite writer connection. A competing writer is
classified as `writer_busy` and retried with bounded backoff; progress is not
guaranteed under sustained contention. Two writers against one store file, or one
store shared across hosts, are unsupported. Multi-host horizontal scaling requires
external coordination and is out of scope for this release.

How that boundary is enforced and measured:

- The store holds an exclusive `${statePath}.lock`; a second live runtime on the
  same state file is refused (`tests/scalability-concurrent-writer.test.mjs`).
- WAL gives readers-don't-block-writers but permits one writer at a time, and WAL
  requires every process on the same host. SQLite `SQLITE_BUSY` (errcode 5) and
  `SQLITE_LOCKED` (errcode 6) are classified by `isSqliteBusy`, retried by
  `withWriterRetry` with bounded backoff, and, if retries are exhausted, raised as
  `WriterBusyError` with `reason === 'writer_busy'` — never silently dropped.
- The concurrent-writer test runs eight real child processes against one file
  while a parent holds the write lock; every child commits every row (no lost
  update) and at least one child classifies a retry.
- WAL policy: `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000ms`,
  `wal_autocheckpoint=1000` pages, `journal_size_limit=64 MiB`, and a best-effort
  `wal_checkpoint(TRUNCATE)` on clean close. Long-running read transactions can
  still grow the WAL between checkpoints, and a crash leaves WAL recovery to the
  next open.

This harness measures a single node. It does not imply horizontal scale-out.
