---
title: "Redis hot-key single-shard CPU saturation and ErrLockAcquireTimeout / deadlock runbook"
summary: "Mitigate single-shard Redis 100% CPU or distributed lock timeouts (ErrLockAcquireTimeout) with PTTL -1 leak checks, singleflight coalescing, and TTL jitter; never raise lock wait timeouts."
sources:
  - "harbor-store:pkg/cache/singleflight_cache.go#GetWithCoalesce"
triggers:
  - "ErrLockAcquireTimeout"
  - "GetWithCoalesce"
  - "hotkey"
  - "deadlock"
  - "死锁"
  - "singleflight"
---

## Symptom

Application logs flood with `ErrLockAcquireTimeout` while overall Redis cluster memory is low, one Redis shard sits near 100% CPU, or synchronized cache expiration triggers a cache stampede.

## Triage & Mitigation

1. **Separate leaked locks (deadlock) from hot-key contention**:
   - Inspect `PTTL <key>`: `PTTL == -1` means a legacy code path wrote the lock without atomic `SET key token NX PX <ms>`, creating a permanent deadlock; verify the holder pod is gone, delete the key, and patch atomic lock acquisition.
   - `PTTL > 0` with high QPS indicates hot-key contention.
2. **Coalesce read stampedes**: Route hot reads through `harbor-store:pkg/cache/singleflight_cache.go#GetWithCoalesce` and add `10%-20%` random TTL jitter.
3. **Never raise lock wait timeout**: Raising client lock wait timeout from `200ms` to `5s` exhausts gateway worker goroutines and causes cascading timeouts.
