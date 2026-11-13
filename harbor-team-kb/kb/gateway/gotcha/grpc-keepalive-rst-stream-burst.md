---
title: "gRPC 长连接每 5 分钟周期性 503 / RST_STREAM (INTERNAL_ERROR) 排查"
summary: "当上游 Envoy MaxConnectionIdle 小于客户端 gRPC Keepalive.Time 时，空闲连接关闭与新请求并发竞争会导致周期性 RST_STREAM 与 503 毛刺。"
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

## 现象

`harbor-gateway` 调用后端 gRPC 服务时，每隔约 5 分钟出现短暂的 `503 Service Unavailable` 或 `stream terminated by RST_STREAM with error code: INTERNAL_ERROR` 毛刺，但后端服务 CPU、内存与延迟均平稳。

## 根因

HTTP/2 多路复用下，若上游 Envoy / 服务端设置了 `MaxConnectionIdle: 300s`，而客户端 `NewUpstreamDialer` 配置的 `Keepalive.Time` 大于或等于 `300s`（或未开启空闲连接淘汰），服务端发送 `GOAWAY` 关闭连接的瞬间，在途请求会撞上半关闭连接并被重置为 `RST_STREAM`。

## 修复准则

1. 客户端 `Keepalive.Time` 必须显式小于上游 `MaxConnectionIdle`（推荐上游 `300s`、客户端 `Keepalive.Time: 60s`）。
2. 在 `harbor-gateway:pkg/upstream/grpc_dialer.go#NewUpstreamDialer` 中仅对幂等只读方法开启单次 `UNAVAILABLE` 重试。
