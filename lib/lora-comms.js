const LoRaComms = require('bindings')('lora_comms').LoRaComms;

LoRaComms.start('./packet_forwarder_shared/lora_pkt_fwd', function (err)
{
    console.log(err);
});
