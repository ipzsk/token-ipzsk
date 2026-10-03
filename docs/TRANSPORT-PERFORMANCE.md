# Streaming transport and DeepSeek performance

The public streaming path is client → Caddy → gateway → lanehub → DeepSeek.
TCP loss/reordering on the public return path caused repeated CUBIC window
reductions to two MSS with roughly 177–234 ms RTT. Generated output accumulated
in the send queue. BBR improved the measured output phase; it did not remove
packet loss or the extra network round trip.

## Production configuration

Load the bundled kernel module before enabling the Docker sysctl:

```sh
sudo modprobe tcp_bbr
sudo install -m 644 ops/tcp-bbr.conf /etc/modules-load.d/ipzsk-bbr.conf
```

Merge `ops/compose.bbr.yaml` into the server-owned Caddy service, or use it as an
explicit Compose override on a new installation. Do not replace production
`compose.yaml`: it also contains lanehub, storage and deployment-specific settings.
For an existing container, apply BBR without interrupting established connections:

```sh
caddy_id=$(sudo docker compose ps -q caddy)
caddy_pid=$(sudo docker inspect -f '{{.State.Pid}}' "$caddy_id")
sudo nsenter -t "$caddy_pid" -n sysctl -w net.ipv4.tcp_congestion_control=bbr
```

The namespace setting affects new connections. The Compose sysctl preserves it
when the container is recreated, while the module file handles host boot.
Changing only the host default is insufficient to verify a running container.

Merge the SSE matcher/encode block from `Caddyfile.example` into the production
API site. It compresses only Chat Completions SSE negotiated with gzip. Keep
`flush_interval -1`, gzip level 1 and `minimum_length 1`. Unsupported clients
and explicit identity requests remain uncompressed. Preserve the inode when
editing a bind-mounted configuration file. Validate before hot reload:

```sh
sudo docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
bash scripts/ops/verify-transport.sh
```

The verifier checks the live admin configuration, runtime namespace algorithm,
boot module, Compose persistence and public health. It emits no credentials and
does not make model calls. Run it after normal deployments as a regression gate.
The normal deployment script deliberately preserves server-owned configuration.

## Verified measurements, 2026-10-04

Same synthetic prompt, `deepseek-flash`, temperature 0, thinking disabled,
768 output tokens, streaming and usage. Keys were injected by secretctl.
Direct and relay upstream accounts may differ. These are small serial samples,
not a concurrency or all-region guarantee.

| Experiment | Output phase |
| --- | --- |
| Cross-check: temporarily restore CUBIC | 51.0 / 67.8 tok/s |
| Restore BBR | 173.3–188.0 tok/s |
| Three interleaved direct calls, after gzip | median 178.3 tok/s |
| Three interleaved relay calls, after gzip | median 176.6 tok/s, 99.0% of direct median |

Identity response body: 213,952 bytes. Gzip response body: 9,656 bytes
(95.5% reduction, excluding TLS/TCP framing). Both parsed 768 content events,
768 usage tokens and DONE. The compression comparison used separate model calls,
so content equality and a fixed generation-speed gain are not claimed.

In the interleaved sample, median TTFT was 519 ms direct versus 975 ms relay;
median total time was 4.816 s versus 5.361 s. A separate cold relay request took
2.297 s to first content. Output-phase parity is not end-to-end parity.

The host is in Hong Kong. Local TCP connect time, excluding DNS, was about
9.5 ms to the official endpoint versus 211 ms to the relay. The server has no
global IPv6 address for a verified alternate entry. Existing lanehub source
already shares an HTTP pool, enables keep-alive and attempts HTTP/2. Further
TTFT work requires measured stage timing and lower-RTT ingress candidates;
do not remove authentication, ledger checks or TLS verification for a benchmark.

Desktop UI revalidation was blocked by macOS ScreenCaptureKit error -3812;
successful API parsing must not be presented as completed desktop UI acceptance.

Before publishing the transport changes, six interleaved calls were repeated
from the production gateway container: official direct TTFT was 631–819 ms and
output 180–187 tok/s; the complete local gateway/ledger/lanehub path had TTFT
294–516 ms and output 179–187 tok/s. All returned 768 content events, usage tokens
and DONE. Different upstream accounts prevent attributing the apparent TTFT
advantage to the gateway, but the sample does not support a large local processing
bottleneck. No additional application optimization was justified by this evidence.

## Rollback

For new connections, change the Caddy namespace algorithm back to `cubic` and
remove/change the Compose sysctl. Remove the dedicated module-load file if boot
loading is no longer desired; do not unload a module used by active sockets.
Remove only the added matcher/encode block to revert gzip, validate and reload.
Keep later unrelated edits; do not overwrite current configuration with an old
backup without reviewing its diff.
