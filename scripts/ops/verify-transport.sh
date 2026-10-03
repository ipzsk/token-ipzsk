#!/usr/bin/env bash
set -euo pipefail
cd "${REMOTE_DIR:-/home/ubuntu/api-gateway}"
sudo docker compose config --quiet
caddy_id=$(sudo docker compose ps -q caddy)
[ -n "$caddy_id" ]
caddy_pid=$(sudo docker inspect -f '{{.State.Pid}}' "$caddy_id")
[ "$(sudo nsenter -t "$caddy_pid" -n sysctl -n net.ipv4.tcp_congestion_control)" = bbr ]
sudo grep -Fxq tcp_bbr /etc/modules-load.d/ipzsk-bbr.conf
sudo docker compose config --format json | sudo docker compose exec -T gateway node -e '
let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{
  const config=JSON.parse(input);
  if(config.services.caddy.sysctls?.["net.ipv4.tcp_congestion_control"]!=="bbr")process.exit(1);
  console.log("BBR runtime, boot module and Compose persistence: OK");
});'
sudo docker exec "$caddy_id" wget -qO- http://127.0.0.1:2019/config/ | sudo docker compose exec -T gateway node -e '
let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{
  const found=[];const paths=[];
  function walk(v){if(!v||typeof v!=="object")return;
    if(v.handler==="encode")found.push(v);
    if(Array.isArray(v.path))paths.push(...v.path);
    Object.values(v).forEach(walk);
  }walk(JSON.parse(input));
  const stream=found.some(v=>v.encodings?.gzip?.level===1&&v.minimum_length===1&&v.match?.headers?.["Content-Type"]?.includes("text/event-stream*"));
  if(!stream||!paths.includes("/v1/chat/completions"))process.exit(1);
  console.log("Live Caddy SSE gzip level 1: OK");
});'
curl --fail --silent --show-error --max-time 15 https://api.ipzsk.com/healthz
printf '\nDeployed revision: '
git rev-parse HEAD
