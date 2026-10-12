#!/bin/sh
# Limits what the Pricebook container may connect to, so that even if the app were taken
# over it could not be used as a stepping stone into the rest of the network.
#   allowed : replies to connections made to it, the Ollama price tag reader, the internet
#   blocked : every private address (the LAN, other VLANs, Tailscale) and this host itself
# Run as root. Safe to run repeatedly. Run it at boot (a systemd oneshot unit after docker.service works well).
NET=${PRICEBOOK_SUBNET:-172.27.20.0/29}          # the subnet set for the stack in compose.yaml
OLLAMA_HOST=${OLLAMA_HOST:-}                       # leave empty if you do not use the price tag reader
OLLAMA_PORT=${OLLAMA_PORT:-11434}
add() { chain=$1; shift; iptables -C "$chain" "$@" 2>/dev/null || iptables -I "$chain" "$@"; }

# Container -> other hosts (forwarded traffic). Inserted in reverse so the final order is:
# established, Ollama, then the private-range drops.
for range in 169.254.0.0/16 100.64.0.0/10 192.168.0.0/16 172.16.0.0/12 10.0.0.0/8; do
  add DOCKER-USER -s "$NET" -d "$range" -j DROP
done
[ -n "$OLLAMA_HOST" ] && add DOCKER-USER -s "$NET" -d "$OLLAMA_HOST" -p tcp --dport "$OLLAMA_PORT" -j ACCEPT
add DOCKER-USER -s "$NET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Container -> this host's own services (Caddy, AdGuard, SSH...). Replies to the reverse proxy still flow.
add INPUT -s "$NET" -j DROP
add INPUT -s "$NET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
