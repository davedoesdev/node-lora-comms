#!/bin/bash
set -e
set -x
VER_LGS=shared-v0.0.2
VER_PFS=shared-v1.2.1
if [ ! -d lora_gateway_shared-$VER_LGS ]; then
    wget -O - https://github.com/davedoesdev/lora_gateway_shared/archive/$VER_LGS.tar.gz | tar -zx
fi
ln -sfn lora_gateway_shared-$VER_LGS lora_gateway_shared
make -C lora_gateway_shared
if [ ! -d packet_forwarder_shared-$VER_PFS ]; then
    wget -O - https://github.com/davedoesdev/packet_forwarder_shared/archive/$VER_PFS.tar.gz | tar -zx
fi
ln -sfn packet_forwarder_shared-$VER_PFS packet_forwarder_shared
make -C packet_forwarder_shared
node-gyp rebuild
