---
title: "Periodic gRPC 503 / RST_STREAM (INTERNAL_ERROR) bursts every 5 minutes"
summary: "When upstream Envoy MaxConnectionIdle is shorter than client gRPC Keepalive.Time, idle GOAWAY teardowns race in-flight RPCs and cause 5-minute 503 / RST_STREAM spikes."
sources:
  - "harbor-gateway:pkg/upstream/grpc_dialer.go#NewUpstreamDialer"
triggers:
  - "RST_STREAM"
  - "INTERNAL_ERROR"
  - "MaxConnectionIdle"
  - "NewUpstreamDialer"
  - "503"
  - "gRPC keepalive"
---

## Symptom

`harbor-gateway` calls to upstream gRPC services show brief spikes of `503 Service Unavailable` or `stream terminated by RST_STREAM with error code: INTERNAL_ERROR` roughly every 5 minutes while backend CPU, memory, and latency remain flat.

## Root Cause

Over multiplexed HTTP/2 connections, when upstream Envoy sets `MaxConnectionIdle: 300s` while `NewUpstreamDialer` configures client `Keepalive.Time >= 300s` (or leaves idle eviction disabled), server-initiated `GOAWAY` frames race newly dispatched RPC streams on half-closed connections and reset them with `RST_STREAM`.

## Remediation

1. Configure client `Keepalive.Time` strictly below upstream `MaxConnectionIdle` (recommended: upstream `300s`, client `Keepalive.Time: 60s`).
2. Enable a single retry on `UNAVAILABLE` only for idempotent read RPCs in `harbor-gateway:pkg/upstream/grpc_dialer.go#NewUpstreamDialer`.
