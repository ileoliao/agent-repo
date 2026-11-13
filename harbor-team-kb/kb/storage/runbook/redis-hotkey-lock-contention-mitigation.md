---
title: "Redis 热 Key 打满单分片与分布式锁超时（ErrLockAcquireTimeout / 死锁）处置手册"
summary: "排查 Redis 单分片 CPU 100% 或分布式锁竞争/死锁超时时，通过单飞合并（singleflight）、随机过期抖动与热 Key 本地短缓存止血，禁止无脑调长锁等待时间。"
sources:
  - "harbor-store:pkg/cache/singleflight_cache.go#GetWithCoalesce"
triggers:
  - "ErrLockAcquireTimeout"
  - "GetWithCoalesce"
  - "hotkey"
  - "死锁"
  - "热Key"
  - "singleflight"
---

## 症状识别

应用大量报错 `ErrLockAcquireTimeout`，同时 Redis 集群整体内存不高，但**单个分片节点 CPU 逼近 100%**，其它分片空闲；或缓存同一时刻集体失效引发击穿。

## 排查与止血步骤

1. **区分锁泄漏（死锁）与热点争用**：
   - 检查问题 Key 的 `PTTL`：若 `PTTL == -1`（未设置过期时间），说明旧版本写路径遗漏了原子 `SET key token NX PX <ms>`，导致永久死锁；需核对持锁实例是否已下线后定向清理并修复原子加锁。
   - 若 `PTTL > 0` 且每秒访问量极高，属于热点争用。
2. **读热点止血**：确认读路径已走 `harbor-store:pkg/cache/singleflight_cache.go#GetWithCoalesce`，将进程内并发回源合并为单次请求，并为缓存 TTL 增加 `10%~20%` 随机抖动。
3. **禁止事项**：严禁直接把客户端锁等待超时从 `200ms` 调大到 `5s`，否则会迅速耗尽网关工作协程池引发级联雪崩。
