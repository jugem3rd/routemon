#!/bin/sh
# 負荷試験用の自己署名証明書(EC)を作る。使い捨てで、本番のServerでは使わない。
#   sh scripts/loadtest/gen-cert.sh /tmp/loadtest-cert
set -eu
dir="${1:-/tmp/loadtest-cert}"
mkdir -p "$dir"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" -days 7 -subj "/CN=loadtest" >/dev/null 2>&1
echo "$dir/cert.pem $dir/key.pem"
