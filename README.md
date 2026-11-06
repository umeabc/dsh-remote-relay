# DSH Remote Relay

> English summary: a zero-knowledge TCP rendezvous for [DSH Remote](https://github.com/umeabc/dsh-remote-android).
> A desktop companion registers a room, a phone joins it, and the relay forwards opaque framed
> streams between them. Payloads are encrypted end to end with a key the relay never receives.

手机远程访问电脑上 DeepSeek Harness 时用的**零知识中转服务器**。桌面端主动连出登记一个房间，手机加入同一个房间，
中转只按帧头转发，不持有房间密钥，也读不到内容。电脑不需要公网 IP 或端口映射。

```
Phone ──TCP+AEAD──▶ Relay ◀──TCP+AEAD── Desktop companion ──▶ 127.0.0.1:8319 (DSH)
```

## 快速开始

要求：Node.js ≥ 20，一个公网可达的 TCP 端口（示例 9443）。不需要域名、证书或反向代理。

```bash
node relay.js --port 9443 --host 0.0.0.0
```

systemd：

```bash
sudo cp dsh-remote-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-remote-relay
```

然后在 DSH 桌面端的 **设置 → 手机访问 → 中转服务器** 里填 `你的服务器地址:9443`。
手机 App 扫描桌面端生成的二维码即可连接。

## 协议

```
握手   4 字节大端长度 + UTF-8 JSON
帧     1 字节 channel | 4 字节 stream | 1 字节 type | 2 字节 length | payload
```

- 握手：`{"v":1,"role":"host","room":"<hex>"}` 或 `{"v":1,"role":"client","room":"<hex>","salt":"<base64>"}`。
- 回执：`{"ok":true}` / `{"ok":true,"channel":N}` / `{"ok":false,"error":"host-offline"}`。
- 桌面端登记成功时回执额外带 `publicHost`（中转观察到的来源地址）。桌面端用它作为直连候选对外播报 ——
  手机经中转拿到房间信息后可以直接连到这台桌面，中转退出数据通路。
- 帧类型：`0 HELLO`（中转→桌面，携带手机 salt）、`1 OPEN`、`2 DATA`、`3 FIN`、`4 RST`、`5 PING`、`6 CHANNEL_CLOSED`。
- 手机发帧时 channel 填 0，中转改写成分配到的 channel；桌面按 channel 区分不同手机。
- `DATA` 的 payload 是 AES-128-GCM 密文（含 16 字节 tag）。密钥 = HKDF-SHA256(房间密钥, salt, `dshm/c2h` / `dshm/h2c`)；
  nonce = 4 字节 0 + 8 字节计数器；AAD = 帧头的第 1–7 字节（不含 channel，因为中转会改写它）。
- `PING` 由手机每 20 秒发一次，桌面回显；中转只转发，用于快速发现死连接。

## 安全模型

- 房间 ID 是 128 位随机数，房间密钥由桌面端生成，**从不发给中转**。
- 中转能看到连接时间、房间 ID、流数量与数据量，看不到明文。
- 任何拿到房间 ID 的人都能占用一个 client 槽位（每个房间最多 16 个），但没有密钥无法通过 GCM 校验，
  桌面端会直接 RST；影响仅限于占用槽位。
- 中转无账号体系、不落盘；重启后房间需要重连。

## 运维

```bash
systemctl status dsh-remote-relay
journalctl -u dsh-remote-relay -f     # 看 host/client 上下线
systemctl restart dsh-remote-relay
```

升级：覆盖 `relay.js` 后 restart。改端口：改 unit 里的 `--port`，并在云厂商安全组放行对应 TCP 端口。

资源占用很低（约 50 MB RSS），单进程；`server.maxConnections` 限制并发连接数。

## 配套

- 手机端：[dsh-remote-android](https://github.com/umeabc/dsh-remote-android)
- 桌面端：[dsh-remote-plugin](https://github.com/umeabc/dsh-remote-plugin)（把隧道流转发到本机 DSH 的回环端口，并生成配对二维码）

## 部署说明

具体的服务器地址、系统版本与运维细节不写进本仓库（公开仓库不放生产环境信息）。
部署时只需记：`node relay.js --port <端口> --host 0.0.0.0`，系统组放行同一端口即可。

## 与 DSH 版本的关系

中转**不感知** DSH 版本：它只读 8 字节帧头、按 channel 转发，房间密钥从不经过它。所以桌面端升级
（0.2.x 任意版本）都不需要动这里 —— 只需要确认插件侧 `FRAME` 常量、握手
`{"v":1,"role","room","salt"}` 与 HKDF 标签（`dshm/c2h`、`dshm/h2c`）没变，那是本仓库与
dsh-remote-plugin、dsh-remote-android 之间的契约。

升级桌面端后建议跑一遍：`node ../dsh-remote-plugin/test/relay-e2e.mjs`。

## License

MIT
